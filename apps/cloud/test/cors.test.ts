import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PUBLIC_ORIGINS } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { openSqlite } from '../src/db/sqlite.ts';
import { buildApp, OWNER_TOKEN_HEADER } from '../src/http/app.ts';
import { seedDemo } from '../src/seed.ts';

async function publicCloud(t: { after(fn: () => Promise<void>): void }) {
  const clock = new ManualClock(Date.UTC(2026, 9, 12, 7, 0));
  const db = openSqlite(':memory:');
  await migrate(db, clock.now());
  await seedDemo(db, clock.now());
  const app = buildApp({ db, clock, corsOrigins: DEFAULT_PUBLIC_ORIGINS });
  await app.ready();
  t.after(async () => {
    await app.close();
    await db.close();
  });
  return app;
}

test('cabinet on Firebase Hosting: preflight, login token, Bearer instead of cookie', async (t) => {
  const app = await publicCloud(t);
  const origin = 'https://ts-app.web.app';

  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/owner/overview',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.match(String(preflight.headers['access-control-allow-headers']), /authorization/);
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: 'owner@demo.kz', password: 'demo1234' },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.headers['access-control-allow-origin'], origin);
  assert.equal(login.headers['access-control-expose-headers'], OWNER_TOKEN_HEADER);
  const token = String(login.headers[OWNER_TOKEN_HEADER]);
  assert.match(token, /^[0-9a-f]{64}$/);

  const overview = await app.inject({ method: 'GET', url: '/api/owner/overview', headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal(overview.statusCode, 200);

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal(logout.statusCode, 200);
  const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.statusCode, 401);
});

test('other origins get no CORS headers', async (t) => {
  const app = await publicCloud(t);
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('config: DATABASE_URL, PORT, CORS and TLS defaults', () => {
  const c = loadConfig({ DATABASE_URL: 'postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres', PORT: '10000' });
  assert.equal(c.databaseUrl?.startsWith('postgresql://'), true);
  assert.equal(c.port, 10000);
  assert.equal(c.databaseSsl, true);
  assert.equal(c.demoSeed, false);
  assert.deepEqual(c.corsOrigins, DEFAULT_PUBLIC_ORIGINS);
  assert.equal(loadConfig({ CLOUD_DATABASE_URL: 'postgres://u:p@localhost:5432/bills' }).databaseSsl, false);
  assert.deepEqual(loadConfig({ CLOUD_CORS_ORIGINS: '' }).corsOrigins, []);
  assert.equal(loadConfig({}).databaseSsl, false);
});

test('health with ?db=1 reads the database (keep-alive for a free Supabase)', async (t) => {
  const app = await publicCloud(t);
  const res = await app.inject({ method: 'GET', url: '/api/health?db=1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().companies, 1);
});
