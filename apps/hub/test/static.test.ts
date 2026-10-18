import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ManualClock } from '../src/clock.ts';
import type { Db } from '../src/db.ts';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import { FAST_LAMPS, MONDAY_NOON } from './helpers.ts';

const INDEX_HTML = '<!doctype html><div id="root">hall</div>';
const APP_JS = 'console.log("hall")';

interface StaticHub {
  db: Db;
  hub: Hub;
  app: FastifyInstance;
}

/** The Harness does not take staticDir, so the app is assembled by hand here. */
async function startHub(t: { after: (fn: () => Promise<void>) => void }, staticDir?: string): Promise<StaticHub> {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  seedDemo(db, clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  const app = buildApp(hub, { staticDir });
  await app.ready();
  t.after(async () => {
    await app.close();
    hub.close();
    db.close();
  });
  return { db, hub, app };
}

/** A fake Vite build: index.html plus one hashed asset. */
function fakeDist(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'bills-web-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), APP_JS);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('serves the built hall screen on / with index.html uncached', async (t) => {
  const { app } = await startHub(t, fakeDist(t));

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/html/);
  assert.equal(res.body, INDEX_HTML);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('serves hashed assets with a long immutable cache', async (t) => {
  const { app } = await startHub(t, fakeDist(t));

  const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.equal(res.body, APP_JS);
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('unknown non-API routes fall back to index.html (SPA)', async (t) => {
  const { app } = await startHub(t, fakeDist(t));

  const res = await app.inject({ method: 'GET', url: '/some/deep/route' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/html/);
  assert.equal(res.body, INDEX_HTML);
  assert.equal(res.headers['cache-control'], 'no-cache');

  const head = await app.inject({ method: 'HEAD', url: '/some/deep/route' });
  assert.equal(head.statusCode, 200);
});

test('unknown API routes answer with the JSON 404, not index.html', async (t) => {
  const { app } = await startHub(t, fakeDist(t));

  const res = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(res.statusCode, 404);
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.equal(res.json().error.code, 'NOT_FOUND');

  const posted = await app.inject({ method: 'POST', url: '/nope', payload: {} });
  assert.equal(posted.statusCode, 404);
  assert.equal(posted.json().error.code, 'NOT_FOUND');
});

test('the API is not shadowed by the static wildcard', async (t) => {
  const { app } = await startHub(t, fakeDist(t));

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  const state = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(state.statusCode, 200);
  assert.ok(Array.isArray(state.json().tables));
});

test('without a staticDir the HUB only serves the API', async (t) => {
  const { app } = await startHub(t);

  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 404);
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
});

test('a missing dist folder is skipped but keeps the JSON 404 format', async (t) => {
  const { app } = await startHub(t, join(tmpdir(), 'bills-no-such-dist-' + process.pid));

  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 404);
  assert.equal(root.json().error.code, 'NOT_FOUND');
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
});
