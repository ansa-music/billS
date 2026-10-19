import type { FastifyInstance } from 'fastify';
import type { SyncEvent, SyncEventPayload, SyncEventsResponse } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import type { SqlDriver } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPostgresDriver } from '../src/db/postgres.ts';
import { openSqlite } from '../src/db/sqlite.ts';
import { buildApp } from '../src/http/app.ts';
import { DEMO_HUBS, DEMO_OWNER, seedDemo } from '../src/seed.ts';
import { createPglitePool } from './pglite.ts';

/** Monday 2026-10-12, 12:00 in Almaty (UTC+5). */
export const MONDAY_NOON = Date.UTC(2026, 9, 12, 7, 0);
export const HOUR = 60 * 60 * 1000;

export const HUB1 = DEMO_HUBS[0];
export const HUB2 = DEMO_HUBS[1];

export interface TestCloud {
  db: SqlDriver;
  clock: ManualClock;
  app: FastifyInstance;
  close(): Promise<void>;
}

export type TestDbKind = 'sqlite' | 'pglite';

/** The engine tests run on: in-memory SQLite by default, PGlite with `CLOUD_TEST_DB=pglite`. */
export const TEST_DB: TestDbKind = process.env.CLOUD_TEST_DB === 'pglite' ? 'pglite' : 'sqlite';

/** An empty in-memory database of the given kind. */
export async function openTestDb(kind: TestDbKind = TEST_DB): Promise<SqlDriver> {
  if (kind === 'pglite') return createPostgresDriver(await createPglitePool());
  return openSqlite(':memory:');
}

/** A cloud on an in-memory database (see `TEST_DB`) with the demo seed. */
export async function createTestCloud(kind: TestDbKind = TEST_DB): Promise<TestCloud> {
  const clock = new ManualClock(MONDAY_NOON);
  const db = await openTestDb(kind);
  await migrate(db, clock.now());
  await seedDemo(db, clock.now());
  const app = buildApp({ db, clock });
  await app.ready();
  return {
    db,
    clock,
    app,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export function cloud(t: { after: (fn: () => Promise<void>) => void }): Promise<TestCloud> {
  const p = createTestCloud();
  t.after(async () => (await p).close());
  return p;
}

/** Logs the demo owner in and returns the cookie header to send back. */
export async function login(c: TestCloud, email = DEMO_OWNER.email, password = DEMO_OWNER.password): Promise<string> {
  const res = await c.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new Error('no set-cookie');
  return raw.split(';')[0] ?? '';
}

export async function ownerGet<T>(c: TestCloud, cookie: string, url: string): Promise<{ status: number; body: T }> {
  const res = await c.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

export async function ownerPut<T>(
  c: TestCloud,
  cookie: string,
  url: string,
  payload: unknown,
): Promise<{ status: number; body: T }> {
  const res = await c.app.inject({ method: 'PUT', url, headers: { cookie }, payload: payload as object });
  return { status: res.statusCode, body: res.json() as T };
}

export async function hubPost<T = SyncEventsResponse>(
  c: TestCloud,
  key: string,
  url: string,
  payload: unknown,
): Promise<{ status: number; body: T }> {
  const res = await c.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}` },
    payload: payload as object,
  });
  return { status: res.statusCode, body: res.json() as T };
}

export async function hubGet<T>(c: TestCloud, key: string, url: string): Promise<{ status: number; body: T }> {
  const res = await c.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
  return { status: res.statusCode, body: res.json() as T };
}

export function event(
  id: number,
  at: number,
  topic: string,
  entityId: string,
  data: Record<string, unknown> = {},
  extra: Partial<SyncEventPayload> = {},
): SyncEvent {
  const entityType = topic.startsWith('session.') ? 'session' : topic.startsWith('alert.') ? 'alert' : 'table';
  return { id, at, topic, payload: { actor: 'Кассир', action: topic, entityType, entityId, data, ...extra } };
}

/** A whole game: open → lamp on → stop, three events from `firstId`. */
export function gameEvents(firstId: number, sessionId: string, tableId: string, startedAt: number, stoppedAt: number, amount: number): SyncEvent[] {
  const playedSeconds = Math.floor((stoppedAt - startedAt) / 1000);
  return [
    event(firstId, startedAt - 1000, 'session.open_requested', sessionId, { tableId, tariffId: 'tariff-x' }),
    event(firstId + 1, startedAt, 'session.started', sessionId, { tableId, startedAt }, { actor: 'system' }),
    event(firstId + 2, stoppedAt, 'session.stopped', sessionId, {
      tableId,
      startedAt,
      stoppedAt,
      playedSeconds,
      billedSeconds: playedSeconds,
      amount,
      segments: [],
    }),
  ];
}

export async function sendEvents(c: TestCloud, hub: { id: string; key: string }, events: SyncEvent[], settingsVersion = 0) {
  return hubPost(c, hub.key, '/sync/events', { hubId: hub.id, settingsVersion, events });
}

export async function clubIdOf(c: TestCloud, hubId: string): Promise<string> {
  const rows = await c.db.all<{ club_id: string }>('SELECT club_id FROM hubs WHERE id = ?', [hubId]);
  const row = rows[0];
  if (!row) throw new Error(`no hub ${hubId}`);
  return row.club_id;
}

export async function tableIdOf(c: TestCloud, hubId: string, name: string): Promise<string> {
  const clubId = await clubIdOf(c, hubId);
  const rows = await c.db.all<{ tables_json: string }>('SELECT tables_json FROM club_settings WHERE club_id = ?', [clubId]);
  const tables = JSON.parse(rows[0]?.tables_json ?? '[]') as Array<{ id: string; name: string }>;
  const t = tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name}`);
  return t.id;
}
