import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all } from '../src/db.ts';
import type { LampDriver } from '../src/lamps/driver.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { managerMatcher } from '../src/manual-mode.ts';
import { auditActions, Harness, MONDAY_NOON, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

function commands(hub: Awaited<ReturnType<Harness['start']>>, table: string) {
  return all<{ action: string; status: string; times: number | null }>(
    hub.db,
    'SELECT action, status, times FROM lamp_commands WHERE table_id = ? ORDER BY created_at, rowid',
    table,
  ).map((c) => `${c.action}${c.times ? `x${c.times}` : ''}:${c.status}`);
}

test('blink flashes the lamp through the queue and leaves the relay as it was', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const table = tableId(hub, 'Стол 1');
  const opened = await post(hub, `/api/tables/${table}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  const res = await post(hub, `/api/tables/${table}/blink`, { times: 2 });
  assert.equal(res.status, 202);
  assert.equal((res.body as unknown as { times: number }).times, 2);
  await waitFor(() => commands(hub, table).includes('BLINKx2:ACKED'), 3000);
  assert.equal(hub.driver.blinkCount('relay-1'), 1);
  assert.ok(hub.driver.isOn('relay-1'), 'back on after the blink');
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'ON', 'blink does not touch the desired/reported state');
  assert.ok(auditActions(hub).includes('lamp.blink_requested') && auditActions(hub).includes('lamp.blink'));
  assert.equal(sessionStatus(hub, opened.body.id), 'ACTIVE');

  assert.equal((await post(hub, `/api/tables/${table}/blink`, { times: 11 })).status, 400);
  assert.equal((await post(hub, `/api/tables/nope/blink`)).status, 404);
});

test('blink waits behind a pending ON and is dropped by a newer OFF', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 120 }));
  const table = tableId(hub, 'Стол 2');

  const opened = await post(hub, `/api/tables/${table}/open`);
  await post(hub, `/api/tables/${table}/blink`);
  assert.deepEqual(commands(hub, table).slice(-2), ['ON:PENDING', 'BLINKx3:PENDING'], 'blink does not supersede ON');
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  await waitFor(() => commands(hub, table).at(-1) === 'BLINKx3:ACKED', 5000);

  await post(hub, `/api/tables/${table}/blink`);
  await post(hub, `/api/tables/${table}/blink`); // replaces the first pending blink
  await post(hub, `/api/sessions/${opened.body.id}/stop`);
  await waitFor(() => commands(hub, table).at(-1) === 'OFF:ACKED', 5000);
  const tail = commands(hub, table).slice(-3);
  assert.deepEqual(tail, ['BLINKx3:SUPERSEDED', 'BLINKx3:SUPERSEDED', 'OFF:ACKED']);
  assert.ok(!hub.driver.isOn('relay-2'));
});

test('a controller without a blink command is flashed by toggling the relay', async (t) => {
  const h = harness(t);
  const sim = new SimulatorLampDriver({ latencyMs: 5 });
  const plain: LampDriver = { setLamp: (c, on, s) => sim.setLamp(c, on, s), readState: (c, s) => sim.readState(c, s) };
  const hub = await h.start(plain as SimulatorLampDriver);
  const table = tableId(hub, 'Стол 3');
  const opened = await post(hub, `/api/tables/${table}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const before = sim.calls.length;
  await post(hub, `/api/tables/${table}/blink`, { times: 2 });
  await waitFor(() => commands(hub, table).at(-1) === 'BLINKx2:ACKED', 5000);
  assert.deepEqual(
    sim.calls.slice(before).map((c) => c.on),
    [false, true, false, true],
    'off/on twice, ending on',
  );
  assert.ok(sim.isOn('relay-3'));
});

test('a failed blink is audited without an alert and the lamp is resynced', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const table = tableId(hub, 'Стол 1');
  const opened = await post(hub, `/api/tables/${table}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  hub.driver.offline = true;
  await post(hub, `/api/tables/${table}/blink`);
  await waitFor(() => commands(hub, table).at(-1) === 'BLINKx3:FAILED', 5000);
  assert.ok(auditActions(hub).includes('lamp.blink_failed'));
  assert.equal(hub.hub.state().alerts.length, 0);
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'UNKNOWN');
  hub.driver.offline = false;
  assert.equal(hub.hub.lamps.reconcile(), 1);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'ON');
});

test('manual mode: games start at the button press, are marked, and lamp failures stay quiet', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { isManager: managerMatcher(['Управляющий Болат']) });
  hub.driver.offline = true;

  assert.equal((await post(hub, '/api/lamps/manual', { enabled: true })).status, 422, 'a reason is required');
  const on = await post(hub, '/api/lamps/manual', { enabled: true, reason: 'Контроллер не отвечает' });
  assert.equal(on.status, 200);
  const mode = hub.hub.state().manualMode;
  assert.deepEqual(mode, { enabled: true, reason: 'Контроллер не отвечает', since: MONDAY_NOON, by: 'Кассир Айгерим' });

  h.clock.advance(1000);
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(opened.status, 201);
  assert.equal(opened.body.status, 'ACTIVE');
  assert.equal(opened.body.startedAt, MONDAY_NOON + 1000);
  assert.equal(opened.body.manual, true);
  const started = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'session.started'")[0];
  assert.equal(JSON.parse(started?.data ?? '{}').manual, true);

  // The ON command is still tried; it fails, but in manual mode that is no alert.
  await waitFor(() => all(hub.db, "SELECT id FROM lamp_commands WHERE status = 'FAILED'").length === 1, 3000);
  assert.equal(hub.hub.state().alerts.length, 0);
  assert.ok(auditActions(hub).includes('lamp.failed'));
  assert.equal(sessionStatus(hub, opened.body.id), 'ACTIVE', 'the game is not failed by the lamp');

  h.clock.advance(60 * 60 * 1000);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.body.billedSeconds, 3600);
  assert.equal(stopped.body.manual, true);

  // Only a manager may leave manual mode.
  const refused = await post(hub, '/api/lamps/manual', { enabled: false });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, 'MANAGER_REQUIRED');
  hub.driver.offline = false;
  const off = await post(hub, '/api/lamps/manual', { enabled: false }, undefined, 'управляющий болат');
  assert.equal(off.status, 200);
  assert.equal(hub.hub.state().manualMode.enabled, false);
  assert.deepEqual(
    auditActions(hub).filter((a) => a.startsWith('hub.manual')),
    ['hub.manual_mode_on', 'hub.manual_mode_off'],
  );
  // Back to normal: the lamp left unknown is resynced, and new games wait for the lamp again.
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');
  const normal = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  assert.equal(normal.body.status, 'OPENING');
  assert.equal(normal.body.manual, false);
});

test('manual mode survives a HUB restart', async (t) => {
  const h = harness(t);
  let hub = await h.start();
  await post(hub, '/api/lamps/manual', { enabled: true, reason: 'Ремонт щитка' });
  await h.crash();
  hub = await h.start();
  assert.equal(hub.hub.state().manualMode.enabled, true);
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 5')}/open`);
  assert.equal(opened.body.status, 'ACTIVE');
});

test('the simulator exposes sensors and blinks to the dev panel', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/dev/lamps',
    payload: { light: { channel: 'relay-2', on: true }, poll: true },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().lights, { 'relay-2': true });
  assert.equal(tableState(hub, 'Стол 2').lamp.currentOn, true);
  const cleared = await hub.app.inject({ method: 'POST', url: '/api/dev/lamps', payload: { light: { channel: 'relay-2', on: null } } });
  assert.deepEqual(cleared.json().lights, {});
});

test('manual mode: resume and transfer do not wait for the lamp', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const table1 = tableId(hub, 'Стол 1');
  const table2 = tableId(hub, 'Стол 2');
  await post(hub, '/api/lamps/manual', { enabled: true, reason: 'Контроллер не отвечает' });
  hub.driver.offline = true;

  const opened = await post(hub, `/api/tables/${table1}/open`);
  assert.equal(opened.body.status, 'ACTIVE');
  h.clock.advance(10 * 60_000);
  const paused = await post(hub, `/api/sessions/${opened.body.id}/pause`);
  assert.equal(paused.body.status, 'PAUSED');
  h.clock.advance(5 * 60_000);

  // «Продолжить»: the lamp is switched by hand, so time runs again at once.
  const resumed = await post(hub, `/api/sessions/${opened.body.id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'ACTIVE');
  assert.equal(resumed.body.pausedSeconds, 300);
  assert.ok(auditActions(hub).includes('session.resumed'));

  // Transfer: no unpaid gap, the game keeps running on the new table.
  h.clock.advance(10 * 60_000);
  const moved = await post(hub, `/api/sessions/${opened.body.id}/transfer`, { toTableId: table2 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.status, 'ACTIVE');
  assert.equal(moved.body.tableId, table2);
  assert.equal(moved.body.pauses.length, 1, 'only the staff pause, no transfer pause');

  h.clock.advance(10 * 60_000);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.body.playedSeconds, 30 * 60);
  assert.equal(stopped.body.pausedSeconds, 300);
  assert.equal(hub.hub.state().alerts.length, 0, 'lamp failures stay quiet in manual mode');
});
