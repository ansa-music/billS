import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { all, run } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, MONDAY_NOON, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function openActive(hub: TestHub, table = 'Стол 1'): Promise<string> {
  const opened = await post(hub, `/api/tables/${tableId(hub, table)}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  return opened.body.id;
}

function viewOf(hub: TestHub, id: string) {
  const s = hub.hub.state();
  return [...s.tables.map((t) => t.session), ...s.unpaid].find((x) => x?.id === id) ?? null;
}

function setTariff(hub: TestHub, patch: Record<string, unknown>): void {
  for (const t of all<{ id: string; config: string }>(hub.db, 'SELECT id, config FROM tariffs')) {
    run(hub.db, 'UPDATE tariffs SET config = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(t.config), ...patch }), t.id);
  }
}

test('pause: time and money stop, the lamp goes off; resume: the lamp comes back and play goes on', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const id = await openActive(hub);

  h.clock.advance(30 * MIN);
  const paused = await post(hub, `/api/sessions/${id}/pause`);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'PAUSED');
  assert.equal(paused.body.pausedAt, MONDAY_NOON + 30 * MIN);
  assert.equal(paused.body.resumeRequestedAt, null);
  assert.equal(paused.body.amount, 1000_00);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');
  assert.ok(!hub.driver.isOn('relay-1'));

  // The table is still taken while paused.
  assert.equal((await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`)).status, 409);

  h.clock.advance(20 * MIN);
  const frozen = viewOf(hub, id);
  assert.equal(frozen?.status, 'PAUSED');
  assert.equal(frozen?.amount, 1000_00);
  assert.equal(frozen?.playedSeconds, 30 * 60);
  assert.equal(frozen?.pausedSeconds, 20 * 60);

  const resumed = await post(hub, `/api/sessions/${id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'PAUSED');
  assert.equal(resumed.body.resumeRequestedAt, MONDAY_NOON + 50 * MIN);
  await waitFor(() => sessionStatus(hub, id) === 'ACTIVE' && viewOf(hub, id)?.status === 'ACTIVE');
  assert.ok(hub.driver.isOn('relay-1'));
  assert.deepEqual(viewOf(hub, id)?.pauses, [{ from: MONDAY_NOON + 30 * MIN, to: MONDAY_NOON + 50 * MIN, reason: 'pause' }]);

  h.clock.advance(30 * MIN);
  const stopped = await post(hub, `/api/sessions/${id}/stop`);
  assert.equal(stopped.body.status, 'AWAITING_PAYMENT');
  assert.equal(stopped.body.playedSeconds, 3600);
  assert.equal(stopped.body.pausedSeconds, 1200);
  assert.equal(stopped.body.billedSeconds, 3600);
  assert.equal(stopped.body.amount, 2000_00);
  assert.equal(stopped.body.stoppedAt, MONDAY_NOON + 80 * MIN);

  const actions = auditActions(hub).filter((a) => a.startsWith('session.'));
  assert.deepEqual(actions, [
    'session.open_requested',
    'session.started',
    'session.paused',
    'session.resume_requested',
    'session.resumed',
    'session.stopped',
  ]);
  assert.equal(all(hub.db, 'SELECT id FROM audit_log').length, all(hub.db, 'SELECT id FROM outbox').length);
});

test('time resumes only when the lamp confirms, not when «Продолжить» is pressed', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 50 }));
  const id = await openActive(hub);
  h.clock.advance(10 * MIN);
  await post(hub, `/api/sessions/${id}/pause`);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');

  h.clock.advance(5 * MIN);
  await post(hub, `/api/sessions/${id}/resume`);
  h.clock.advance(3000); // the controller answers three seconds later
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
  const pause = all<{ resumed_at: number; resume_requested_at: number }>(
    hub.db,
    'SELECT resumed_at, resume_requested_at FROM session_pauses WHERE session_id = ?',
    id,
  )[0];
  assert.equal(pause?.resume_requested_at, MONDAY_NOON + 15 * MIN);
  assert.equal(pause?.resumed_at, MONDAY_NOON + 15 * MIN + 3000);
  assert.equal(viewOf(hub, id)?.playedSeconds, 10 * 60);
});

test('a tariff boundary inside a pause changes the rate for the rest of the game', async (t) => {
  const h = harness(t);
  h.clock.set(MONDAY_NOON + 5 * HOUR + 30 * MIN); // 17:30, evening rate from 18:00
  const hub = await h.start();
  const id = await openActive(hub);
  h.clock.advance(15 * MIN); // 17:45
  await post(hub, `/api/sessions/${id}/pause`);
  h.clock.advance(30 * MIN); // 18:15
  await post(hub, `/api/sessions/${id}/resume`);
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
  h.clock.advance(30 * MIN); // 18:45
  const stopped = await post(hub, `/api/sessions/${id}/stop`);
  assert.equal(stopped.body.playedSeconds, 45 * 60);
  assert.equal(stopped.body.amount, 500_00 + 1500_00);
});

test('pause limits: count, total time, and the excess of a long pause is billed', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  setTariff(hub, { maxPauses: 2, maxPauseMinutes: 10 });
  const id = await openActive(hub);

  h.clock.advance(10 * MIN);
  await post(hub, `/api/sessions/${id}/pause`);
  assert.equal((await post(hub, `/api/sessions/${id}/pause`)).body.error?.code, 'SESSION_ALREADY_PAUSED');
  // 15 minutes paused with a 10-minute budget: the last 5 are billed as play.
  h.clock.advance(15 * MIN);
  assert.equal(viewOf(hub, id)?.pausedSeconds, 10 * 60);
  assert.equal(viewOf(hub, id)?.playedSeconds, 15 * 60);
  await post(hub, `/api/sessions/${id}/resume`);
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');

  const refused = await post(hub, `/api/sessions/${id}/pause`);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error?.code, 'PAUSE_LIMIT');
  assert.match((refused.body as unknown as { error: { message: string } }).error.message, /не больше 10 мин/);

  const other = await openActive(hub, 'Стол 2');
  h.clock.advance(MIN);
  await post(hub, `/api/sessions/${other}/pause`);
  h.clock.advance(MIN);
  await post(hub, `/api/sessions/${other}/resume`);
  await waitFor(() => viewOf(hub, other)?.status === 'ACTIVE');
  await post(hub, `/api/sessions/${other}/pause`);
  h.clock.advance(MIN);
  await post(hub, `/api/sessions/${other}/resume`);
  await waitFor(() => viewOf(hub, other)?.status === 'ACTIVE');
  const third = await post(hub, `/api/sessions/${other}/pause`);
  assert.equal(third.status, 422);
  assert.match((third.body as unknown as { error: { message: string } }).error.message, /не больше 2/);
});

test('with pauseLamp = blink the lamp blinks while paused and is steady again after resume', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  setTariff(hub, { pauseLamp: 'blink' });
  const id = await openActive(hub);
  await post(hub, `/api/sessions/${id}/pause`);
  await waitFor(() => hub.driver.isBlinking('relay-1'));
  assert.ok(hub.driver.isOn('relay-1'));
  assert.equal(tableState(hub, 'Стол 1').lamp.blink, true);
  assert.equal(viewOf(hub, id)?.status, 'PAUSED'); // the blink ON did not resume the game

  await post(hub, `/api/sessions/${id}/resume`);
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
  await waitFor(() => !hub.driver.isBlinking('relay-1'));
  assert.equal(tableState(hub, 'Стол 1').lamp.blink, false);
});

test('if the lamp does not confirm on resume, the game stays paused and staff are told', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const id = await openActive(hub);
  await post(hub, `/api/sessions/${id}/pause`);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');

  hub.driver.offline = true;
  await post(hub, `/api/sessions/${id}/resume`);
  await waitFor(() => auditActions(hub).includes('session.resume_failed'));
  const view = viewOf(hub, id);
  assert.equal(view?.status, 'PAUSED');
  assert.equal(view?.resumeRequestedAt, null);
  assert.match(hub.hub.state().alerts[0]?.message ?? '', /остаётся на паузе/);

  hub.driver.offline = false;
  await waitFor(() => all(hub.db, "SELECT id FROM lamp_commands WHERE status = 'PENDING'").length === 0);
  await post(hub, `/api/sessions/${id}/resume`);
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
});

test('pause and resume are idempotent and refuse the wrong status', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const id = await openActive(hub);
  assert.equal((await post(hub, `/api/sessions/${id}/resume`)).body.error?.code, 'SESSION_NOT_PAUSED');

  const key = randomUUID();
  const first = await post(hub, `/api/sessions/${id}/pause`, {}, key);
  const again = await post(hub, `/api/sessions/${id}/pause`, {}, key);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(all(hub.db, 'SELECT id FROM session_pauses').length, 1);

  const r1 = await post(hub, `/api/sessions/${id}/resume`);
  const r2 = await post(hub, `/api/sessions/${id}/resume`); // second press while the lamp switches on
  assert.equal(r2.status, 200);
  assert.equal(r2.body.resumeRequestedAt, r1.body.resumeRequestedAt);
  assert.equal(all(hub.db, "SELECT id FROM lamp_commands WHERE action = 'ON' AND session_id = ?", id).length, 2);
});

test('stop while paused fixes the bill at the moment of the pause', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const id = await openActive(hub);
  h.clock.advance(40 * MIN);
  await post(hub, `/api/sessions/${id}/pause`);
  h.clock.advance(10 * MIN);
  const stopped = await post(hub, `/api/sessions/${id}/stop`);
  assert.equal(stopped.body.status, 'AWAITING_PAYMENT');
  assert.equal(stopped.body.playedSeconds, 40 * 60);
  assert.equal(stopped.body.pausedSeconds, 10 * 60);
  assert.equal(stopped.body.amount, Math.round((40 * 2000_00) / 60 / 10_00) * 10_00);
  assert.equal(all(hub.db, 'SELECT id FROM session_pauses WHERE resumed_at IS NULL').length, 0);
  assert.equal(tableState(hub, 'Стол 1').session, null);
});

test('after a HUB restart a paused game stays paused with its lamp off, and a resume in flight completes', async (t) => {
  const h = harness(t);
  let hub = await h.start();
  const id = await openActive(hub);
  h.clock.advance(10 * MIN);
  await post(hub, `/api/sessions/${id}/pause`);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');

  await h.crash();
  h.clock.advance(5 * MIN);
  const lit = new SimulatorLampDriver({ latencyMs: 5 });
  await lit.setLamp('relay-1', true, new AbortController().signal); // someone switched it on meanwhile
  hub = await h.start(lit);
  await waitFor(() => !lit.isOn('relay-1')); // recover() re-sent OFF for the paused table
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'OFF');
  assert.equal(viewOf(hub, id)?.status, 'PAUSED');
  assert.equal(viewOf(hub, id)?.amount, 1000_00); // 10 min played, 30-minute minimum

  // Resume requested, HUB dies before the lamp answers.
  const dead = new SimulatorLampDriver({ latencyMs: 5 });
  dead.offline = true;
  await h.crash();
  hub = await h.start(dead);
  await post(hub, `/api/sessions/${id}/resume`);
  await h.crash();
  h.clock.advance(MIN);
  hub = await h.start();
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
  assert.ok(hub.driver.isOn('relay-1'));
  assert.equal(viewOf(hub, id)?.pauses[0]?.to, h.clock.now());
});

test('transfer: the game moves to a free table, the gap between lamps is not billed, the tariff stays', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 30 }));
  const id = await openActive(hub);
  h.clock.advance(30 * MIN);
  const table2 = tableId(hub, 'Стол 2');
  const moved = await post(hub, `/api/sessions/${id}/transfer`, { toTableId: table2 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.tableId, table2);
  assert.equal(moved.body.status, 'PAUSED');
  assert.equal(moved.body.resumeRequestedAt, MONDAY_NOON + 30 * MIN);
  assert.equal(moved.body.pauses[0]?.reason, 'transfer');

  assert.equal(tableState(hub, 'Стол 1').session, null);
  assert.equal(tableState(hub, 'Стол 2').session?.id, id);
  assert.equal(tableState(hub, 'Стол 1').lamp.desired, 'OFF');
  assert.equal(tableState(hub, 'Стол 2').lamp.desired, 'ON');

  h.clock.advance(2000);
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
  await waitFor(() => !hub.driver.isOn('relay-1') && hub.driver.isOn('relay-2'));
  assert.equal(viewOf(hub, id)?.pauses[0]?.to, MONDAY_NOON + 30 * MIN + 2000);

  // Reprice the tariff: the moved game keeps its snapshot.
  setTariff(hub, { basePricePerHour: 9999_00 });
  h.clock.advance(30 * MIN);
  const stopped = await post(hub, `/api/sessions/${id}/stop`);
  assert.equal(stopped.body.playedSeconds, 3600);
  assert.equal(stopped.body.pausedSeconds, 2);
  assert.equal(stopped.body.amount, 2000_00);
  assert.ok(auditActions(hub).includes('session.transferred'));
  assert.equal(
    all<{ from_table_id: string; to_table_id: string }>(hub.db, 'SELECT from_table_id, to_table_id FROM session_pauses')[0]
      ?.to_table_id,
    table2,
  );
  await waitFor(() => tableState(hub, 'Стол 2').lamp.reported === 'OFF');
});

test('transfer refuses a busy or the same table, and a game that has not started', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const id = await openActive(hub);
  const other = await openActive(hub, 'Стол 2');
  assert.equal((await post(hub, `/api/sessions/${id}/transfer`, { toTableId: tableId(hub, 'Стол 2') })).status, 409);
  assert.equal((await post(hub, `/api/sessions/${id}/transfer`, { toTableId: tableId(hub, 'Стол 1') })).status, 422);
  assert.equal((await post(hub, `/api/sessions/${id}/transfer`, { toTableId: 'nope' })).status, 404);
  assert.equal((await post(hub, `/api/sessions/${id}/transfer`, {})).status, 400);
  await post(hub, `/api/sessions/${other}/stop`);
  assert.equal((await post(hub, `/api/sessions/${other}/transfer`, { toTableId: tableId(hub, 'Стол 3') })).status, 409);

  hub.driver.latencyMs = 200;
  const opening = await post(hub, `/api/tables/${tableId(hub, 'Стол 4')}/open`);
  const res = await post(hub, `/api/sessions/${opening.body.id}/transfer`, { toTableId: tableId(hub, 'Стол 5') });
  assert.equal(res.body.error?.code, 'SESSION_NOT_STARTED');
  assert.equal(tableState(hub, 'Стол 4').session?.id, opening.body.id);
});

test('a paused game can be moved too; «Продолжить» then lights the new table', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const id = await openActive(hub);
  h.clock.advance(10 * MIN);
  await post(hub, `/api/sessions/${id}/pause`);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');

  const table3 = tableId(hub, 'Стол 3');
  const moved = await post(hub, `/api/sessions/${id}/transfer`, { toTableId: table3 });
  assert.equal(moved.body.status, 'PAUSED');
  assert.equal(moved.body.tableId, table3);
  assert.equal(moved.body.resumeRequestedAt, null);
  assert.equal(all(hub.db, 'SELECT id FROM session_pauses').length, 1);

  await post(hub, `/api/sessions/${id}/resume`);
  await waitFor(() => viewOf(hub, id)?.status === 'ACTIVE');
  assert.ok(hub.driver.isOn('relay-3') && !hub.driver.isOn('relay-1'));
  assert.equal(tableState(hub, 'Стол 3').session?.id, id);
});
