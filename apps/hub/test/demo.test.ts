import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoInfo, HubState } from '@bills/domain';
import { DEMO_KEYS, zonedParts } from '@bills/domain';
import { loadConfig } from '../src/config.ts';
import { nextDemoReset, wipeDemoDatabase } from '../src/demo.ts';
import { buildApp } from '../src/http/app.ts';
import { Harness, MONDAY_NOON } from './helpers.ts';

const ORIGIN = 'https://ts-demo.pages.dev';

async function demoHub(t: { after(fn: () => Promise<void>): void }) {
  const h = new Harness();
  const { hub } = await h.start();
  const app = buildApp(hub, { corsOrigins: ['https://*.pages.dev'], demo: { resetAt: () => MONDAY_NOON + 1000 } });
  await app.ready();
  t.after(async () => {
    await app.close();
    await h.dispose();
  });
  return { h, hub, app };
}

test('demo keys: each role signs in with its simple key; issuing twice adds nothing', async (t) => {
  const { hub, app } = await demoHub(t);
  const issued = hub.auth.issueFixedKeys(DEMO_KEYS);
  assert.deepEqual(issued.map((k) => k.role).sort(), ['cashier', 'manager', 'owner', 'waiter']);
  assert.deepEqual(hub.auth.issueFixedKeys(DEMO_KEYS), []);
  for (const k of DEMO_KEYS) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: k.key.toLowerCase() } });
    assert.equal(res.statusCode, 200, k.key);
    assert.equal(res.json().staff.role, k.role);
  }
});

test('GET /api/demo is public on a demo HUB and absent otherwise', async (t) => {
  const { app } = await demoHub(t);
  const res = await app.inject({ method: 'GET', url: '/api/demo' });
  assert.equal(res.statusCode, 200);
  const info = res.json() as DemoInfo;
  assert.equal(info.demo, true);
  assert.equal(info.resetAt, MONDAY_NOON + 1000);
  assert.equal(info.keys[0]?.key, 'OWNER-2222-2222-2222-2222');

  const h = new Harness();
  const plain = await h.start();
  t.after(() => h.dispose());
  assert.equal((await plain.app.inject({ method: 'GET', url: '/api/demo' })).statusCode, 404);
});

test('CORS: preflight without a token, Bearer from the Pages origin, other origins ignored', async (t) => {
  const { hub, app } = await demoHub(t);
  hub.auth.issueFixedKeys(DEMO_KEYS);

  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/tables/x/open',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
  assert.match(String(preflight.headers['access-control-allow-headers']), /idempotency-key/);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN },
    payload: { key: DEMO_KEYS[0]!.key },
  });
  assert.equal(login.headers['access-control-allow-origin'], ORIGIN);
  const state = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { origin: ORIGIN, authorization: `Bearer ${login.json().token}` },
  });
  assert.equal(state.statusCode, 200);
  assert.ok((state.json() as HubState).tables.length > 0);

  const foreign = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
});

test('SSE stream carries the CORS header (hijacked reply)', async (t) => {
  const { app } = await demoHub(t);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const ctrl = new AbortController();
  const res = await fetch(`${address}/api/events`, { headers: { origin: ORIGIN }, signal: ctrl.signal });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  ctrl.abort();
});

test('nextDemoReset: next 04:00 club time', () => {
  // Monday 12:00 Almaty → Tuesday 04:00 Almaty = 23:00 UTC Monday.
  const at = nextDemoReset(MONDAY_NOON, 'Asia/Almaty', 4);
  assert.equal(at, Date.UTC(2026, 9, 12, 23, 0));
  assert.equal(zonedParts(at, 'Asia/Almaty').minuteOfDay, 240);
  // Exactly at 04:00 → the next day.
  assert.equal(nextDemoReset(at, 'Asia/Almaty', 4), at + 24 * 3600_000);
});

test('wipeDemoDatabase removes the database, WAL files and bootstrap keys', () => {
  const h = new Harness();
  const files = ['', '-wal', '-shm'].map((s) => h.dbPath + s).concat(join(h.dir, 'first-run-keys.txt'));
  for (const f of files) writeFileSync(f, 'x');
  wipeDemoDatabase(h.dbPath);
  for (const f of files) assert.equal(existsSync(f), false, f);
});

test('config: HUB_DEMO, HUB_CORS_ORIGINS, PORT', () => {
  const c = loadConfig({ HUB_DEMO: '1', HUB_CORS_ORIGINS: 'https://*.pages.dev, https://*.github.io', PORT: '10000', HUB_DEMO_RESET_AT: '123' });
  assert.equal(c.demo, true);
  assert.equal(c.port, 10000);
  assert.equal(c.demoResetAt, 123);
  assert.deepEqual(c.corsOrigins, ['https://*.pages.dev', 'https://*.github.io']);
  const d = loadConfig({});
  assert.equal(d.demo, false);
  assert.deepEqual(d.corsOrigins, []);
  assert.equal(d.port, 4310);
});
