/**
 * End-to-end: real HUBs (apps/hub) talking to a real cloud over HTTP.
 * Two HUBs of two clubs of one company share one cloud; the first HUB starts
 * while the cloud is down and catches up without duplicates once it is up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { ClubDetails, OwnerOverview, UpdateTariffsRequest, UpdateTariffsResponse } from '@bills/domain';
import { all, run } from '../../hub/src/db.ts';
import { auditActions, Harness, post, sessionStatus, tableId, waitFor } from '../../hub/test/helpers.ts';
import type { TestHub } from '../../hub/test/helpers.ts';
import { clubIdOf, createTestCloud, HOUR, HUB1, HUB2, login, ownerGet, ownerPut } from './helpers.ts';
import type { TestCloud } from './helpers.ts';

/**
 * Holds a port for a cloud that is "down": every connection is reset at once.
 * Freeing the port early and listening on it later would let any other process
 * (parallel test runs, outgoing connections) take it in between.
 */
async function holdPort(): Promise<{ port: number; release(): Promise<void> }> {
  const srv = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const address = srv.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, release: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

/** Waits until no lamp command is in flight: a lamp ack writes `lamp.*` to the outbox asynchronously. */
async function lampsSettled(t: TestHub): Promise<void> {
  await waitFor(() => (all<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM lamp_commands WHERE status = 'PENDING'")[0]?.n ?? 1) === 0);
}

/** A HUB whose sync worker is driven by hand (`tick()`), not by timers. */
async function startHub(h: Harness, url: string, hub: { id: string; key: string }): Promise<TestHub> {
  const t = await h.start(undefined, { sync: { url, apiKey: hub.key, hubId: hub.id, intervalMs: 1000, kickDelayMs: 1 } });
  t.hub.sync!.stop();
  // Lamp recovery at start answers asynchronously and writes to the outbox; let it finish first.
  await lampsSettled(t);
  return t;
}

function sync(t: TestHub) {
  return t.hub.sync!;
}

/**
 * Opens a table, waits for the lamp, stops after `playMs` and waits for the lamp to go off.
 * Without the last wait the `lamp.off` ack could land in the outbox in the middle of a
 * sync tick (after its outbox read) and leave one row undelivered. Returns the session id.
 */
async function playGame(t: TestHub, h: Harness, table: string, playMs: number): Promise<string> {
  const opened = await post(t, `/api/tables/${tableId(t, table)}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(t, opened.body.id) === 'ACTIVE');
  h.clock.advance(playMs);
  const stopped = await post(t, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.status, 200);
  await lampsSettled(t);
  return opened.body.id;
}

function undelivered(t: TestHub): number {
  return all<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL')[0]?.n ?? 0;
}

async function cloudSessions(c: TestCloud, hubId: string): Promise<Array<{ id: string; status: string; amount: number | null }>> {
  const clubId = await clubIdOf(c, hubId);
  return c.db.all('SELECT id, status, amount FROM sessions WHERE club_id = ? ORDER BY requested_at', [clubId]);
}

test('HUB offline → events pile up → cloud comes up → everything arrives once; two HUBs add up', async (t) => {
  const down = await holdPort();
  const port = down.port;
  const url = `http://127.0.0.1:${port}`;

  const h1 = new Harness();
  const h2 = new Harness();
  let c: TestCloud | undefined;
  t.after(async () => {
    await h1.dispose();
    await h2.dispose();
    await c?.close();
    await down.release();
  });

  // --- Club 1 works while the cloud is unreachable -------------------------
  const hub1 = await startHub(h1, url, HUB1);
  const game1 = await playGame(hub1, h1, 'Стол 1', HOUR); // 2000 ₸ at the base rate
  await waitFor(() => all<{ s: string }>(hub1.db, "SELECT reported AS s FROM lamp_states").every((r) => r.s === 'OFF'));

  await sync(hub1).tick();
  let status = hub1.hub.state().sync;
  assert.equal(status.enabled, true);
  assert.ok(status.pending > 0, 'outbox keeps the events while the cloud is down');
  assert.ok(status.lastError, 'the error is reported');
  assert.equal(status.lastSentAt, null);
  assert.ok(sync(hub1).nextAttemptAt > h1.clock.now(), 'backs off after the failure');
  const piled = undelivered(hub1);

  // Also a second game while still offline.
  const game1b = await playGame(hub1, h1, 'Стол 2', 30 * 60 * 1000); // minimum 30 min → 1000 ₸
  assert.ok(undelivered(hub1) > piled);

  // --- The cloud comes up ---------------------------------------------------
  c = await createTestCloud();
  await down.release();
  await c.app.listen({ host: '127.0.0.1', port });

  await sync(hub1).tick();
  status = hub1.hub.state().sync;
  assert.equal(status.pending, 0, 'everything delivered');
  assert.equal(status.lastError, null);
  assert.equal(status.lastSentAt, h1.clock.now());
  assert.equal(undelivered(hub1), 0);

  let rows = await cloudSessions(c, HUB1.id);
  assert.deepEqual(
    rows.map((r) => [r.id, r.status, r.amount]),
    [
      [game1, 'AWAITING_PAYMENT', 2000_00],
      [game1b, 'AWAITING_PAYMENT', 1000_00],
    ],
  );

  // --- Delivered-but-not-marked (HUB crashed after the cloud answered): resend is harmless
  run(hub1.db, 'UPDATE outbox SET delivered_at = NULL');
  await sync(hub1).tick();
  assert.equal(undelivered(hub1), 0);
  rows = await cloudSessions(c, HUB1.id);
  assert.equal(rows.length, 2, 'no duplicate sessions after a resend');
  const eventCount = (await c.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE hub_id = ?', [HUB1.id]))[0]?.n;
  const outboxCount = all<{ n: number }>(hub1.db, 'SELECT COUNT(*) AS n FROM outbox')[0]?.n;
  assert.equal(eventCount, outboxCount, 'one cloud event per outbox row');

  // --- Club 2 joins the same cloud -------------------------------------------
  const hub2 = await startHub(h2, url, HUB2);
  const game2 = await playGame(hub2, h2, 'Стол 1', 2 * HOUR); // 4000 ₸
  await sync(hub2).tick();
  assert.equal(undelivered(hub2), 0);
  rows = await cloudSessions(c, HUB2.id);
  assert.deepEqual(rows.map((r) => [r.id, r.amount]), [[game2, 4000_00]]);

  // --- The owner sees both clubs and the sum --------------------------------
  const cookie = await login(c);
  const overview = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(overview.status, 200);
  const byHub = new Map<string, OwnerOverview['clubs'][number]>();
  for (const club of overview.body.clubs) byHub.set(club.hub?.id ?? '', club);
  // Games are stopped but not paid: billed moves, revenue (payments) stays 0.
  assert.equal(byHub.get(HUB1.id)?.today.billed, 3000_00);
  assert.equal(byHub.get(HUB1.id)?.today.revenue, 0);
  assert.equal(byHub.get(HUB1.id)?.today.games, 2);
  assert.equal(byHub.get(HUB2.id)?.today.billed, 4000_00);
  assert.equal(overview.body.totals.today.billed, 7000_00);
  assert.equal(overview.body.totals.today.revenue, 0);
  assert.equal(overview.body.totals.today.games, 3);
  assert.equal(byHub.get(HUB1.id)?.hub?.online, true);
  assert.equal(byHub.get(HUB1.id)?.hub?.pendingSettings, false);

  // The HUB snapshot reached the cloud: table names are the HUB's, not the demo seed's.
  const club1 = await clubIdOf(c, HUB1.id);
  const details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${club1}`);
  assert.equal(details.status, 200);
  assert.deepEqual(
    details.body.settings.tables.map((x) => x.id).sort(),
    hub1.hub.state().tables.map((x) => x.id).sort(),
  );
  assert.equal(details.body.recentSessions.find((s) => s.id === game1)?.tableName, 'Стол 1');
  // game1 12:00–13:00, game1b 13:00–13:30 local time
  assert.equal(details.body.hours.find((hr) => hr.hour === 12)?.busySeconds, 3600);
  assert.equal(details.body.hours.find((hr) => hr.hour === 13)?.busySeconds, 1800);

  // --- Tariffs edited in the cloud reach the HUB ----------------------------
  const standard = details.body.settings.tariffs.find((x) => x.name === 'Стандарт')!;
  const body: UpdateTariffsRequest = {
    tariffs: details.body.settings.tariffs.map((x) =>
      x.id === standard.id ? { ...x, config: { ...x.config, basePricePerHour: 2500_00 } } : x,
    ),
  };
  const put = await ownerPut<UpdateTariffsResponse>(c, cookie, `/api/owner/clubs/${club1}/tariffs`, body);
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.version, 1);

  let pending = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(pending.body.clubs.find((x) => x.hub?.id === HUB1.id)?.hub?.pendingSettings, true);

  h1.clock.advance(2000);
  await sync(hub1).tick();
  const state1 = hub1.hub.state();
  assert.equal(state1.sync.settingsVersion, 1);
  assert.equal(state1.tariffs.find((x) => x.name === 'Стандарт')?.config.basePricePerHour, 2500_00);
  assert.ok(auditActions(hub1).includes('cloud.settings_applied'));

  // HUB 2 is untouched by club 1's tariffs.
  h2.clock.advance(2000);
  await sync(hub2).tick();
  assert.equal(hub2.hub.state().tariffs.find((x) => x.name === 'Стандарт')?.config.basePricePerHour, 2000_00);
  assert.equal(hub2.hub.state().sync.settingsVersion, 0);

  pending = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(pending.body.clubs.find((x) => x.hub?.id === HUB1.id)?.hub?.pendingSettings, false);

  // A game opened after the change is priced by the new tariff and reaches the cloud.
  const game3 = await playGame(hub1, h1, 'Стол 3', HOUR);
  await sync(hub1).tick();
  rows = await cloudSessions(c, HUB1.id);
  assert.equal(rows.find((r) => r.id === game3)?.amount, 2500_00);
});

test('a HUB with a wrong key never delivers and reports it', async (t) => {
  const c = await createTestCloud();
  await c.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (c.app.server.address() as { port: number }).port;
  const h = new Harness();
  t.after(async () => {
    await h.dispose();
    await c.close();
  });

  const hub = await startHub(h, `http://127.0.0.1:${port}`, { id: HUB1.id, key: 'wrong-key' });
  await playGame(hub, h, 'Стол 1', HOUR);
  await sync(hub).tick();
  const status = hub.hub.state().sync;
  assert.ok(status.pending > 0);
  assert.match(status.lastError ?? '', /401/);
  assert.equal((await cloudSessions(c, HUB1.id)).length, 0);
});
