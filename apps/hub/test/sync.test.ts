import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClubSnapshot, SyncEventsRequest, SyncSnapshotRequest, TariffConfig } from '@bills/domain';
import { all, one, run } from '../src/db.ts';
import { localSnapshot, settingsHash } from '../src/sync.ts';
import type { SyncWorker } from '../src/sync.ts';
import { auditActions, Harness, post, sessionStatus, tableId, waitFor } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const INTERVAL = 10_000;

interface CloudRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

/** A cloud that remembers what the HUB sent and answers with configurable settings. */
class FakeCloud {
  requests: CloudRequest[] = [];
  /** Non-null: every request fails with this status. */
  failWith: number | null = null;
  settingsVersion = 0;
  settings: ClubSnapshot | null = null;
  lastAcceptedId: number | null = null;
  url = '';
  #server: Server | undefined;

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.#server?.close(() => r()));
  }

  of(method: string, path: string): CloudRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(path));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body: unknown = text ? JSON.parse(text) : null;
    const path = req.url ?? '/';
    this.requests.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (this.failWith !== null) return send(this.failWith, { error: { code: 'BOOM', message: 'Облако упало' } });
    if (req.method === 'POST' && path === '/sync/snapshot') {
      const snap = body as SyncSnapshotRequest;
      if (snap.settingsVersion >= this.settingsVersion) {
        return send(200, { accepted: true, settingsVersion: this.settingsVersion });
      }
      return send(409, { accepted: false, settingsVersion: this.settingsVersion });
    }
    if (req.method === 'POST' && path === '/sync/events') {
      const events = (body as SyncEventsRequest).events;
      const last = events.at(-1)?.id;
      if (last !== undefined) this.lastAcceptedId = Math.max(this.lastAcceptedId ?? 0, last);
      return send(200, { lastAcceptedId: this.lastAcceptedId, inserted: events.length, settingsVersion: this.settingsVersion });
    }
    if (req.method === 'GET' && path.startsWith('/sync/settings')) {
      const since = Number(new URL(path, this.url).searchParams.get('since') ?? 0);
      if (!this.settings || since >= this.settings.version) return send(200, { changed: false, version: this.settingsVersion });
      return send(200, { changed: true, ...this.settings });
    }
    send(404, { error: { code: 'NOT_FOUND', message: path } });
  }
}

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function cloudOf(t: { after: (fn: () => Promise<void>) => void }): Promise<FakeCloud> {
  const cloud = await new FakeCloud().start();
  t.after(() => cloud.close());
  return cloud;
}

/** A HUB wired to the fake cloud; timers are stopped so tests drive `tick()` by hand. */
async function startSynced(h: Harness, cloud: FakeCloud, manual = true): Promise<{ hub: TestHub; sync: SyncWorker }> {
  const hub = await h.start(undefined, {
    sync: { url: cloud.url, apiKey: 'test-key', hubId: 'hub-test', intervalMs: INTERVAL, kickDelayMs: 10 },
  });
  const sync = hub.hub.sync!;
  if (manual) sync.stop();
  // Lamp recovery at start answers asynchronously and writes to the outbox; let it finish first.
  await waitFor(() => one<{ n: number }>(hub.db, "SELECT COUNT(*) AS n FROM lamp_commands WHERE status = 'PENDING'")!.n === 0);
  return { hub, sync };
}

async function playOneGame(hub: TestHub): Promise<void> {
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
}

function undelivered(hub: TestHub): number {
  return one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL')!.n;
}

test('events are delivered in a batch with the API key and marked delivered', async (t) => {
  const h = harness(t);
  const cloud = await cloudOf(t);
  const { hub, sync } = await startSynced(h, cloud);
  await playOneGame(hub);
  const queued = undelivered(hub);
  assert.ok(queued >= 2);
  assert.equal(hub.hub.state().sync.pending, queued);

  h.clock.advance(1000);
  await sync.tick();

  const [batch] = cloud.of('POST', '/sync/events');
  assert.ok(batch);
  assert.equal(batch.auth, 'Bearer test-key');
  const body = batch.body as SyncEventsRequest;
  assert.equal(body.hubId, 'hub-test');
  assert.equal(body.settingsVersion, 0);
  assert.equal(body.events.length, queued);
  assert.ok(body.events.some((e) => e.topic === 'session.open_requested' && e.payload.action === 'session.open_requested'));
  assert.deepEqual(
    body.events.map((e) => e.id),
    [...body.events.map((e) => e.id)].sort((a, b) => a - b),
  );

  assert.equal(undelivered(hub), 0);
  assert.equal(all(hub.db, 'SELECT id FROM outbox WHERE delivered_at = ?', h.clock.now()).length, queued);
  const status = hub.hub.state().sync;
  assert.equal(status.enabled, true);
  assert.equal(status.pending, 0);
  assert.equal(status.lastSentAt, h.clock.now());
  assert.equal(status.lastError, null);
  assert.equal(sync.nextAttemptAt, h.clock.now());
});

test('a cloud error keeps the outbox, records the error and backs off exponentially', async (t) => {
  const h = harness(t);
  const cloud = await cloudOf(t);
  const { hub, sync } = await startSynced(h, cloud);
  await playOneGame(hub);
  const queued = undelivered(hub);

  cloud.failWith = 500;
  await sync.tick();
  assert.equal(undelivered(hub), queued);
  let status = hub.hub.state().sync;
  assert.match(status.lastError ?? '', /HTTP 500/);
  assert.equal(status.lastErrorAt, h.clock.now());
  assert.equal(status.lastSentAt, null);
  assert.equal(status.pending, queued);
  assert.equal(sync.nextAttemptAt, h.clock.now() + 2 * INTERVAL);

  h.clock.advance(2 * INTERVAL);
  await sync.tick();
  assert.equal(sync.nextAttemptAt, h.clock.now() + 4 * INTERVAL);
  assert.equal(sync.failures, 2);

  // The cloud is back: the pause is gone and the queue drains.
  cloud.failWith = null;
  h.clock.advance(4 * INTERVAL);
  await sync.tick();
  status = hub.hub.state().sync;
  assert.equal(status.lastError, null);
  assert.equal(status.lastErrorAt, null);
  assert.equal(status.lastSentAt, h.clock.now());
  assert.equal(status.pending, 0);
  assert.equal(sync.nextAttemptAt, h.clock.now());
  assert.equal(sync.failures, 0);
});

test('newer settings in the cloud are pulled and applied in one go', async (t) => {
  const h = harness(t);
  const cloud = await cloudOf(t);
  const { hub, sync } = await startSynced(h, cloud);
  await playOneGame(hub);

  const local = localSnapshot(hub.db);
  const standard = local.tariffs.find((x) => x.name === 'Стандарт')!;
  const night: TariffConfig = { ...standard.config, basePricePerHour: 1500_00, windows: [] };
  cloud.settingsVersion = 3;
  cloud.settings = {
    version: 3,
    club: { ...local.club, name: 'Клуб «Демо» (облако)' },
    tariffs: [
      { ...standard, config: { ...standard.config, basePricePerHour: 2500_00 } },
      ...local.tariffs.filter((x) => x.id !== standard.id),
      { id: 'tariff-night', name: 'Ночной', config: night, isActive: true },
    ],
    tables: local.tables,
    staff: [],
  };

  await sync.tick();

  assert.deepEqual(
    cloud.requests.map((r) => `${r.method} ${r.path}`),
    // The applied version is reported back in the same pass, not a tick later.
    ['POST /sync/snapshot', 'POST /sync/events', 'GET /sync/settings?since=0', 'POST /sync/snapshot'],
  );
  assert.equal((cloud.of('POST', '/sync/snapshot').at(-1)!.body as SyncSnapshotRequest).settingsVersion, 3);
  assert.ok(auditActions(hub).includes('cloud.settings_applied'));
  const applied = one<{ data: string; actor: string }>(hub.db, "SELECT data, actor FROM audit_log WHERE action = 'cloud.settings_applied'")!;
  assert.equal(applied.actor, 'cloud');
  assert.deepEqual(JSON.parse(applied.data), { version: 3, tariffs: 3, tables: local.tables.length });

  const tariffs = hub.hub.state().tariffs;
  assert.equal(tariffs.find((x) => x.name === 'Стандарт')?.config.basePricePerHour, 2500_00);
  assert.equal(tariffs.find((x) => x.name === 'Ночной')?.config.basePricePerHour, 1500_00);
  assert.equal(hub.hub.state().club.name, 'Клуб «Демо» (облако)');
  assert.equal(one<{ v: number }>(hub.db, 'SELECT settings_version AS v FROM sync_state')!.v, 3);
  assert.equal(hub.hub.state().sync.settingsVersion, 3);
  assert.equal(hub.hub.state().sync.lastError, null);

  // The next tick: no new snapshot (nothing changed), events carry the new version.
  h.clock.advance(INTERVAL);
  await sync.tick();
  assert.equal(cloud.of('POST', '/sync/snapshot').length, 2);
  assert.equal((cloud.of('POST', '/sync/events').at(-1)!.body as SyncEventsRequest).settingsVersion, 3);
  assert.equal(undelivered(hub), 0);

  // A broken package is rejected as a whole.
  cloud.settingsVersion = 4;
  cloud.settings = {
    ...cloud.settings,
    version: 4,
    tariffs: [
      { id: 'tariff-bad', name: 'Сломанный', config: { ...night, stepMinutes: 0 }, isActive: true },
      { id: 'tariff-ok', name: 'Новый', config: night, isActive: true },
    ],
  };
  h.clock.advance(INTERVAL);
  await sync.tick();
  assert.match(hub.hub.state().sync.lastError ?? '', /Сломанный/);
  assert.equal(hub.hub.state().sync.settingsVersion, 3);
  assert.equal(all(hub.db, "SELECT id FROM tariffs WHERE id IN ('tariff-bad', 'tariff-ok')").length, 0);
  assert.equal(auditActions(hub).filter((a) => a === 'cloud.settings_applied').length, 1);
});

test('without CLOUD_URL sync is disabled but the queue is still counted', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await playOneGame(hub);
  assert.equal(hub.hub.sync, undefined);
  const status = hub.hub.state().sync;
  assert.equal(status.enabled, false);
  assert.equal(status.pending, undelivered(hub));
  assert.ok(status.pending >= 2);
  assert.equal(status.lastSentAt, null);
  assert.equal(status.lastError, null);
  assert.equal(status.settingsVersion, 0);
});

test('the settings snapshot is sent once, and again only after settings change', async (t) => {
  const h = harness(t);
  const cloud = await cloudOf(t);
  const { hub, sync } = await startSynced(h, cloud);

  await sync.tick();
  assert.equal(cloud.of('POST', '/sync/snapshot').length, 1);
  const first = cloud.of('POST', '/sync/snapshot')[0]!.body as SyncSnapshotRequest;
  assert.equal(first.hubId, 'hub-test');
  assert.equal(first.tables.length, 6);
  assert.deepEqual(first.tariffs.map((x) => x.name), ['Снукер', 'Стандарт']);
  assert.equal(one<{ h: string }>(hub.db, 'SELECT settings_hash AS h FROM sync_state')!.h, settingsHash(localSnapshot(hub.db)));

  h.clock.advance(INTERVAL);
  await sync.tick();
  assert.equal(cloud.of('POST', '/sync/snapshot').length, 1);
  assert.equal(cloud.of('POST', '/sync/events').length, 2); // heartbeats

  // An empty heartbeat is not repeated within the interval.
  h.clock.advance(INTERVAL / 2);
  await sync.tick();
  assert.equal(cloud.of('POST', '/sync/events').length, 2);

  run(hub.db, "UPDATE tariffs SET name = 'Стандарт+' WHERE name = 'Стандарт'");
  h.clock.advance(INTERVAL);
  await sync.tick();
  assert.equal(cloud.of('POST', '/sync/snapshot').length, 2);
  assert.ok((cloud.of('POST', '/sync/snapshot')[1]!.body as SyncSnapshotRequest).tariffs.some((x) => x.name === 'Стандарт+'));
});

test('a local change kicks the worker so events arrive without waiting for the interval', async (t) => {
  const h = harness(t);
  const cloud = await cloudOf(t);
  const { hub } = await startSynced(h, cloud, false);
  await waitFor(() => cloud.of('POST', '/sync/snapshot').length === 1);

  await playOneGame(hub);
  await waitFor(() =>
    cloud
      .of('POST', '/sync/events')
      .some((r) => (r.body as SyncEventsRequest).events.some((e) => e.topic === 'session.started')),
  );
  await waitFor(() => undelivered(hub) === 0);
});
