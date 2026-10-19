import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ManualClock } from '../src/clock.ts';
import { migrate } from '../src/db/migrate.ts';
import { openSqlite } from '../src/db/sqlite.ts';
import { buildApp } from '../src/http/app.ts';
import { seedDemo } from '../src/seed.ts';
import { HUB1, MONDAY_NOON } from './helpers.ts';

const INDEX_HTML = '<!doctype html><div id="root">cabinet</div>';
const APP_JS = 'console.log("cabinet")';
const MANIFEST = '{"name":"TS","start_url":"/","display":"standalone"}';

async function startCloud(t: { after: (fn: () => Promise<void>) => void }, staticDir?: string): Promise<FastifyInstance> {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openSqlite(':memory:');
  await migrate(db, clock.now());
  await seedDemo(db, clock.now());
  const app = buildApp({ db, clock, ...(staticDir !== undefined ? { staticDir } : {}) });
  await app.ready();
  t.after(async () => {
    await app.close();
    await db.close();
  });
  return app;
}

/** A fake Vite build of apps/cloud-web. */
function fakeDist(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'bills-cloud-web-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), APP_JS);
  writeFileSync(join(dir, 'manifest.webmanifest'), MANIFEST);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('serves the cabinet on / with index.html uncached', async (t) => {
  const app = await startCloud(t, fakeDist(t));
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/html/);
  assert.equal(res.body, INDEX_HTML);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('hashed assets are cached for a year, the manifest has its own type', async (t) => {
  const app = await startCloud(t, fakeDist(t));

  const js = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  assert.equal(js.body, APP_JS);
  assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');

  const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.headers['content-type'], 'application/manifest+json; charset=utf-8');
  assert.equal(manifest.headers['cache-control'], 'no-cache');
});

test('unknown cabinet routes fall back to index.html for GET and HEAD', async (t) => {
  const app = await startCloud(t, fakeDist(t));
  const res = await app.inject({ method: 'GET', url: '/clubs/123' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, INDEX_HTML);
  assert.equal(res.headers['cache-control'], 'no-cache');
  const head = await app.inject({ method: 'HEAD', url: '/clubs/123' });
  assert.equal(head.statusCode, 200);
});

test('unknown /api and /sync URLs and other methods keep the JSON 404', async (t) => {
  const app = await startCloud(t, fakeDist(t));
  for (const [method, url] of [
    ['GET', '/api/nope'],
    ['GET', '/api'],
    ['GET', '/sync/nope'],
    ['GET', '/sync/events'],
    ['POST', '/nope'],
  ] as const) {
    const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.match(String(res.headers['content-type']), /application\/json/, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: { code: 'NOT_FOUND', message: 'Такого адреса нет' } }, `${method} ${url}`);
  }
});

test('the API and HUB sync are not shadowed by the cabinet', async (t) => {
  const app = await startCloud(t, fakeDist(t));
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(me.statusCode, 401);

  const sync = await app.inject({
    method: 'POST',
    url: '/sync/events',
    headers: { authorization: `Bearer ${HUB1.key}` },
    payload: { hubId: HUB1.id, settingsVersion: 0, events: [] },
  });
  assert.equal(sync.statusCode, 200);
});

test('without a built cabinet nothing is served and the API still works', async (t) => {
  const missing = join(tmpdir(), `bills-cloud-web-missing-${process.pid}-${Date.now()}`);
  for (const app of [await startCloud(t, missing), await startCloud(t)]) {
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 404);
    assert.equal(root.json().error.code, 'NOT_FOUND');
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
  }
});
