import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { auditActions, Harness, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

const MINUTE = 60_000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function settled(hub: Awaited<ReturnType<Harness['start']>>): Promise<void> {
  await waitFor(() => all(hub.db, "SELECT id FROM lamp_commands WHERE status = 'PENDING'").length === 0);
}

test('light switched on by hand without a game raises an alert after a minute', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await settled(hub);

  hub.driver.setLight('relay-2', true); // bypassing the relay: current flows, relay is off
  await hub.hub.monitor.poll();
  assert.equal(tableState(hub, 'Стол 2').lamp.currentOn, true);
  assert.equal(hub.hub.state().alerts.length, 0, 'first sight is not an alert yet');

  h.clock.advance(30_000);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 0);

  h.clock.advance(31_000);
  await hub.hub.monitor.poll();
  const alerts = hub.hub.state().alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.kind, 'LIGHT_WITHOUT_GAME');
  assert.match(alerts[0]?.message ?? '', /Стол 2: свет горит без игры/);
  assert.ok(auditActions(hub).includes('lamp.light_without_game'));

  // Polls keep going: no duplicate alerts or audit spam.
  h.clock.advance(MINUTE);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 1);
  assert.equal(auditActions(hub).filter((a) => a === 'lamp.light_without_game').length, 1);

  // Light goes off: the anomaly is forgotten, a new one starts from zero.
  hub.driver.setLight('relay-2', null);
  await hub.hub.monitor.poll();
  hub.driver.setLight('relay-2', true);
  await hub.hub.monitor.poll();
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 1, 'folded into the open alert of the same kind');
});

test('a running game whose lamp draws no current raises an alert after a minute', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  await settled(hub);

  await hub.hub.monitor.poll();
  assert.equal(tableState(hub, 'Стол 1').lamp.currentOn, true, 'sensor follows the relay');

  hub.driver.setLight('relay-1', false); // the bulb died
  await hub.hub.monitor.poll();
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  const alerts = hub.hub.state().alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.kind, 'LAMP_DARK_DURING_GAME');
  assert.match(alerts[0]?.message ?? '', /Стол 1: идёт игра, а лампа не горит/);
  assert.equal(tableState(hub, 'Стол 1').lamp.currentOn, false);
  assert.equal(sessionStatus(hub, opened.body.id), 'ACTIVE', 'the game goes on; staff decide');
});

test('a relay that disagrees with the HUB is told again, and nothing is judged while a command is pending', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await settled(hub);

  // Somebody flipped relay 3 while no command was in flight (e.g. a controller glitch).
  await hub.driver.setLamp('relay-3', true, new AbortController().signal);
  await hub.hub.monitor.poll();
  assert.ok(auditActions(hub).includes('lamp.mismatch'));
  await waitFor(() => !hub.driver.isOn('relay-3'));
  await settled(hub);
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 0, 'fixed by the resend, so no alert');

  // Opening a game: ON is pending for a while, the lamp is dark — not an anomaly.
  hub.driver.latencyMs = 150;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 4')}/open`);
  await hub.hub.monitor.poll();
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 0);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
});

test('an unreachable controller is not an anomaly; a reported state heals UNKNOWN lamps', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.offline = true;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');
  await settled(hub);
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'UNKNOWN');

  const offline = await hub.hub.monitor.poll();
  assert.equal(offline.unreachable, 6);
  assert.equal(tableState(hub, 'Стол 1').lamp.polledAt, null);

  hub.driver.offline = false;
  const online = await hub.hub.monitor.poll();
  assert.equal(online.polled, 6);
  assert.equal(tableState(hub, 'Стол 1').lamp.reported, 'OFF', 'relay is off, desired is OFF: trusted');
  assert.equal(tableState(hub, 'Стол 1').lamp.polledAt, h.clock.now());
});

test('the monitor stays silent in manual mode and when the driver cannot read state', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await settled(hub);
  await post(hub, '/api/lamps/manual', { enabled: true, reason: 'Контроллер сгорел' });

  hub.driver.setLight('relay-2', true);
  await hub.hub.monitor.poll();
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 0);

  class Blind extends SimulatorLampDriver {
    override readState = undefined as never;
  }
  await h.crash();
  const blind = await h.start(new Blind({ latencyMs: 5 }));
  assert.equal(blind.hub.monitor.supported, false);
  assert.deepEqual(await blind.hub.monitor.poll(), { polled: 0, unreachable: 0 });
});

test('a paused game with its lamp off is not a dark lamp', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  await post(hub, `/api/sessions/${opened.body.id}/pause`);
  await waitFor(() => !hub.driver.isOn('relay-1'));
  await settled(hub);

  await hub.hub.monitor.poll();
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts.length, 0);

  // Resumed: the lamp is on again and judged as usual.
  await post(hub, `/api/sessions/${opened.body.id}/resume`);
  await waitFor(() => hub.hub.state().tables.find((x) => x.name === 'Стол 1')?.session?.status === 'ACTIVE');
  await settled(hub);
  hub.driver.setLight('relay-1', false);
  await hub.hub.monitor.poll();
  h.clock.advance(MINUTE + 1);
  await hub.hub.monitor.poll();
  assert.equal(hub.hub.state().alerts[0]?.kind, 'LAMP_DARK_DURING_GAME');
});
