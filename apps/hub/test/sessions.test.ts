import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { all, run } from '../src/db.ts';
import type { ChangeEvent } from '../src/events.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import {
  auditActions,
  Harness,
  MONDAY_NOON,
  post,
  sessionStatus,
  tableId,
  tableState,
  waitFor,
} from './helpers.ts';

const HOUR = 60 * 60 * 1000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

test('time starts when the lamp confirms, not when the button is pressed', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 50 }));

  const res = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'OPENING');
  assert.equal(res.body.startedAt, null);

  h.clock.advance(2000); // the controller answers two seconds later
  await waitFor(() => sessionStatus(hub, res.body.id) === 'ACTIVE');

  const table = tableState(hub, 'Стол 1');
  assert.equal(table.session?.startedAt, MONDAY_NOON + 2000);
  assert.equal(table.lamp.reported, 'ON');
  assert.ok(hub.driver.isOn('relay-1'));
});

test('stop fixes the bill, frees the table and switches the lamp off', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  h.clock.advance(HOUR);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'AWAITING_PAYMENT');
  assert.equal(stopped.body.billedSeconds, 3600);
  assert.equal(stopped.body.amount, 2000_00);
  assert.equal(stopped.body.stoppedAt, MONDAY_NOON + HOUR);

  const state = hub.hub.state();
  assert.equal(state.tables.find((x) => x.name === 'Стол 1')?.session, null);
  assert.deepEqual(state.unpaid.map((s) => s.id), [opened.body.id]);

  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');
  assert.ok(!hub.driver.isOn('relay-1'));

  const again = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(again.status, 409);
});

test('the running amount is shown while the game goes on', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(45 * 60 * 1000);
  assert.equal(tableState(hub, 'Стол 1').session?.amount, 1500_00);
});

test('only one live game per table, even under concurrent requests', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const url = `/api/tables/${tableId(hub, 'Стол 2')}/open`;

  const [a, b] = await Promise.all([post(hub, url), post(hub, url)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((a.status === 409 ? a : b).body.error?.code, 'TABLE_BUSY');

  const count = all<{ n: number }>(
    hub.db,
    'SELECT COUNT(*) AS n FROM table_sessions WHERE table_id = ?',
    tableId(hub, 'Стол 2'),
  )[0]?.n;
  assert.equal(count, 1);
});

test('the database refuses a second live game even if code is bypassed', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const table = tableId(hub, 'Стол 3');
  const opened = await post(hub, `/api/tables/${table}/open`);
  assert.equal(opened.status, 201);
  const row = all<Record<string, string | number>>(hub.db, 'SELECT * FROM table_sessions WHERE id = ?', opened.body.id)[0]!;
  assert.throws(
    () =>
      run(
        hub.db,
        `INSERT INTO table_sessions (id, club_id, table_id, tariff_id, tariff_name, tariff_snapshot, timezone, status, requested_at, opened_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPENING', ?, ?, ?)`,
        randomUUID(),
        row.club_id!,
        table,
        row.tariff_id!,
        row.tariff_name!,
        row.tariff_snapshot!,
        row.timezone!,
        MONDAY_NOON,
        'test',
        MONDAY_NOON,
      ),
    /UNIQUE/,
  );
});

test('a repeated request with the same key changes nothing', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const url = `/api/tables/${tableId(hub, 'Стол 1')}/open`;
  const key = randomUUID();

  const first = await post(hub, url, {}, key);
  const second = await post(hub, url, {}, key);
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(all(hub.db, 'SELECT id FROM table_sessions').length, 1);

  const reused = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`, {}, key);
  assert.equal(reused.status, 422);

  await waitFor(() => sessionStatus(hub, first.body.id) === 'ACTIVE');
  const stopKey = randomUUID();
  const stop1 = await post(hub, `/api/sessions/${first.body.id}/stop`, {}, stopKey);
  const stop2 = await post(hub, `/api/sessions/${first.body.id}/stop`, {}, stopKey);
  assert.equal(stop2.status, 200);
  assert.deepEqual(stop2.body, stop1.body);
});

test('commands without an idempotency key are rejected', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await hub.app.inject({ method: 'POST', url: `/api/tables/${tableId(hub, 'Стол 1')}/open`, payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('if the lamp never confirms, the game does not start and the table stays free', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.offline = true;

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');

  const state = hub.hub.state();
  assert.equal(state.tables.find((x) => x.name === 'Стол 1')?.session, null);
  assert.equal(state.alerts.length, 1);
  assert.equal(state.alerts[0]?.kind, 'LAMP_ON_FAILED');
  assert.match(state.alerts[0]?.message ?? '', /игра не начата/);
  const cmd = all<{ attempts: number; status: string }>(
    hub.db,
    "SELECT attempts, status FROM lamp_commands WHERE session_id = ? AND action = 'ON'",
    opened.body.id,
  )[0];
  assert.deepEqual({ ...cmd }, { attempts: 3, status: 'FAILED' });
  assert.ok(auditActions(hub).includes('session.failed'));

  // The controller is back: the table can be opened again.
  hub.driver.offline = false;
  const retry = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(retry.status, 201);
  await waitFor(() => sessionStatus(hub, retry.body.id) === 'ACTIVE');
});

test('a lost confirmation is retried', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.injectFaults('drop-ack');

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE', 3000);
  const cmd = all<{ attempts: number }>(
    hub.db,
    "SELECT attempts FROM lamp_commands WHERE session_id = ? AND action = 'ON'",
    opened.body.id,
  )[0];
  assert.equal(cmd?.attempts, 2);
  assert.equal(hub.hub.state().alerts.length, 0);
});

test('stop before the lamp confirms cancels the game and the lamp ends up off', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 80 }));

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.body.status, 'CANCELLED');
  assert.equal(stopped.body.amount, 0);

  await waitFor(
    () =>
      all(hub.db, "SELECT id FROM lamp_commands WHERE session_id = ? AND action = 'OFF' AND status = 'ACKED'", opened.body.id)
        .length === 1,
    3000,
  );
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'OFF');
  assert.ok(!hub.driver.isOn('relay-1'));
  assert.equal(sessionStatus(hub, opened.body.id), 'CANCELLED');
  assert.deepEqual(
    all<{ action: string; status: string }>(hub.db, 'SELECT action, status FROM lamp_commands ORDER BY rowid').map(
      (c) => `${c.action}:${c.status}`,
    ).slice(-2),
    ['ON:SUPERSEDED', 'OFF:ACKED'],
  );
});

test('after a HUB restart a running game keeps counting and its lamp is restored', async (t) => {
  const h = harness(t);
  let hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  await h.crash();
  h.clock.advance(20 * 60 * 1000); // HUB was down for 20 minutes
  hub = await h.start(); // fresh controller: every lamp is off after its reboot

  await waitFor(() => hub.driver.isOn('relay-1'));
  const session = tableState(hub, 'Стол 1').session;
  assert.equal(session?.status, 'ACTIVE');
  assert.equal(session?.startedAt, MONDAY_NOON);

  h.clock.advance(40 * 60 * 1000);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.body.billedSeconds, 3600);
  assert.equal(stopped.body.amount, 2000_00);
  assert.ok(auditActions(hub).includes('hub.recovered'));
});

test('a game whose lamp command was cut off by a restart starts after the restart', async (t) => {
  const h = harness(t);
  const dead = new SimulatorLampDriver({ latencyMs: 5 });
  dead.offline = true;
  let hub = await h.start(dead);
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 4')}/open`);
  await h.crash();

  h.clock.advance(30_000);
  hub = await h.start();
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  assert.equal(tableState(hub, 'Стол 4').session?.startedAt, MONDAY_NOON + 30_000);
  assert.ok(hub.driver.isOn('relay-4'));
});

test('a lamp left on without a game is switched off after a restart', async (t) => {
  const h = harness(t);
  await h.start();
  await h.crash();
  const driver = new SimulatorLampDriver({ latencyMs: 5 });
  await driver.setLamp('relay-2', true, new AbortController().signal); // switched on while the HUB was down
  const restarted = await h.start(driver);
  await waitFor(() => tableState(restarted, 'Стол 2').lamp.reported === 'OFF');
  assert.ok(!driver.isOn('relay-2'));
});

test('lamps left unknown by a dead controller are resynced when it comes back', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.offline = true;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');
  await waitFor(() => all(hub.db, "SELECT id FROM lamp_commands WHERE status = 'PENDING'").length === 0);
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'UNKNOWN');

  hub.driver.offline = false;
  assert.equal(hub.hub.lamps.reconcile(), 1);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');
  assert.equal(hub.hub.lamps.reconcile(), 0);
});

test('the tariff is fixed at open: later price changes do not reprice the game', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  const config = JSON.parse(all<{ config: string }>(hub.db, 'SELECT config FROM tariffs WHERE id = ?', opened.body.tariffId)[0]!.config);
  run(hub.db, 'UPDATE tariffs SET config = ? WHERE id = ?', JSON.stringify({ ...config, basePricePerHour: 9999_00 }), opened.body.tariffId);

  h.clock.advance(HOUR);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.body.amount, 2000_00);
});

test('every action is audited with its actor and queued for the cloud', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const events: ChangeEvent[] = [];
  hub.hub.events.on('changed', (e) => events.push(e));

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(HOUR);
  await post(hub, `/api/sessions/${opened.body.id}/stop`);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');

  const session = auditActions(hub).filter((a) => a.startsWith('session.'));
  assert.deepEqual(session, ['session.open_requested', 'session.started', 'session.stopped']);
  const actor = all<{ actor: string }>(hub.db, "SELECT actor FROM audit_log WHERE action = 'session.open_requested'")[0];
  assert.equal(actor?.actor, 'Кассир Айгерим');

  const audit = all(hub.db, 'SELECT id FROM audit_log').length;
  const outbox = all(hub.db, 'SELECT id FROM outbox').length;
  assert.equal(outbox, audit);
  assert.ok(events.some((e) => e.kind === 'session') && events.some((e) => e.kind === 'lamp'));
});

test('alerts can be resolved', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.offline = true;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');
  // The safety OFF command fails too; its alert is folded into the open one.
  await waitFor(() => all(hub.db, "SELECT id FROM lamp_commands WHERE status = 'PENDING'").length === 0);
  assert.equal(hub.hub.state().alerts.length, 1);
  const alert = hub.hub.state().alerts[0]!;

  const res = await post(hub, `/api/alerts/${alert.id}/resolve`);
  assert.equal(res.status, 200);
  assert.equal(hub.hub.state().alerts.length, 0);
  assert.equal((await post(hub, `/api/alerts/${alert.id}/resolve`)).status, 404);
});
