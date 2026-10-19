import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoInfo, HubState, LicenseResponse } from '@bills/domain';
import { DEMO_KEYS, DEMO_LOGIN_THROTTLE, ROLES, zonedParts } from '@bills/domain';
import { DEMO_LICENSE_KEYS, installDemoLicense } from '../src/demo-license.ts';
import { loadConfig } from '../src/config.ts';
import { nextDemoReset, wipeDemoDatabase } from '../src/demo.ts';
import { buildApp } from '../src/http/app.ts';
import { Harness, MONDAY_NOON } from './helpers.ts';

const ORIGIN = 'https://ts-demo.pages.dev';

async function demoHub(t: { after(fn: () => Promise<void>): void }, license = false) {
  const h = new Harness();
  const { hub } = await h.start(undefined, {
    demo: true,
    ...(license ? { license: { mode: 'enforce' as const, publicKeys: DEMO_LICENSE_KEYS } } : {}),
  });
  const app = buildApp(hub, { corsOrigins: ['https://*.pages.dev'], demo: { resetAt: () => MONDAY_NOON + 1000 } });
  await app.ready();
  t.after(async () => {
    await app.close();
    await h.dispose();
  });
  return { h, hub, app };
}

test('demo keys: each demo person signs in with a four-digit key and has their roles; issuing twice adds nothing', async (t) => {
  const { hub, app } = await demoHub(t);
  const issued = hub.auth.issueFixedKeys(DEMO_KEYS);
  assert.deepEqual(issued.map((k) => k.key), DEMO_KEYS.map((k) => k.key));
  assert.deepEqual(hub.auth.issueFixedKeys(DEMO_KEYS), []);
  for (const k of DEMO_KEYS) {
    const typed = ` ${k.key.slice(0, 2)} ${k.key.slice(2)} `;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: typed } });
    assert.equal(res.statusCode, 200, k.key);
    assert.deepEqual(res.json().staff.roles, [...k.roles].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b)), k.key);
  }
  // Seeded people are reused by role, missing ones created: one waiter+cashier, one owner of the platform.
  const staff = hub.staff.list();
  assert.equal(staff.filter((s) => s.roles.join() === 'cashier,waiter').length, 1);
  assert.equal(staff.find((s) => s.roles.includes('owner'))?.name, 'Владелец TS');
  assert.equal(staff.find((s) => s.roles.includes('manager'))?.name, 'Марат Управляющий');
});

test('a real HUB refuses the four-digit demo keys, even when their rows are in its database', async (t) => {
  const h = new Harness();
  t.after(() => h.dispose());
  const { hub, app } = await h.start(undefined, { secure: true });
  assert.equal(hub.auth.issueFixedKeys(DEMO_KEYS).length, DEMO_KEYS.length);
  for (const k of DEMO_KEYS) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: k.key, device: k.key } });
    assert.equal(res.statusCode, 401, k.key);
    assert.equal(res.json().error.code, 'KEY_INVALID');
  }
  const attempts = hub.auth.attempts();
  assert.ok(attempts.every((a) => a.result === 'wrong_key' && a.prefix === null && a.kind === null));
});

test('demo: a softer login throttle, never a branch pause', async (t) => {
  const { hub, app } = await demoHub(t);
  hub.auth.issueFixedKeys(DEMO_KEYS);
  const tryKey = (key: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'зал' } });
  for (let i = 0; i < DEMO_LOGIN_THROTTLE.freeFailures - 1; i++) assert.equal((await tryKey('9876')).statusCode, 401, String(i));
  const locked = await tryKey('9876');
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error.retryAfterMs, DEMO_LOGIN_THROTTLE.baseLockMs);
  assert.equal((await tryKey('1111')).statusCode, 429);
});

test('demo: the HUB signs itself a 7-day trial license so the manager sees one', async (t) => {
  const { hub, app } = await demoHub(t, true);
  assert.equal(await installDemoLicense(hub.license, MONDAY_NOON), true);
  hub.auth.issueFixedKeys(DEMO_KEYS);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: '1111' } });
  const token = login.json().token as string;
  const res = await app.inject({ method: 'GET', url: '/api/license', headers: { authorization: `Bearer ${token}` } });
  const body = res.json() as LicenseResponse;
  assert.equal(body.enforced, true);
  assert.equal(body.status.state, 'active');
  assert.equal(body.status.plan, 'trial');
  assert.equal(body.status.daysLeft, 7);
  assert.equal(body.status.maxClubs, 2);
  assert.deepEqual(body.status.modules, { bar: true, cloud: true, hardware: true });
  const state = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } });
  assert.equal((state.json() as HubState).license?.state, 'active');
});

test('GET /api/demo is public on a demo HUB and absent otherwise', async (t) => {
  const { app } = await demoHub(t);
  const res = await app.inject({ method: 'GET', url: '/api/demo' });
  assert.equal(res.statusCode, 200);
  const info = res.json() as DemoInfo;
  assert.equal(info.demo, true);
  assert.equal(info.resetAt, MONDAY_NOON + 1000);
  assert.equal(info.keys[0]?.key, '0000');

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
