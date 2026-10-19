import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_ACCESS_VERSION, DEMO_HUBS, seedDemo } from '../../apps/cloud/src/seed.ts';
import { createSupabaseDb } from './harness.ts';

const ROOT = new URL('../../', import.meta.url);
const CORE = new URL('supabase/functions/_shared/core.js', ROOT);

test('bundle: scripts/bundle-edge.mjs builds core.js that Deno can load (node:* imports only)', async (t) => {
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/bundle-edge.mjs', ROOT))], { stdio: 'pipe' });
  const code = readFileSync(CORE, 'utf8');
  const specifiers = [...code.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) assert.match(s, /^node:/, `bare import ${s}`);
  assert.doesNotMatch(code, /\brequire\(/);
  assert.doesNotMatch(code, /import\.meta/);

  // Smoke: the bundle's handlers answer a HUB sync over the Supabase-shaped database.
  const core = (await import(`${CORE.href}?t=${Date.now()}`)) as typeof import('../../apps/cloud/src/edge/index.ts');
  const s = await createSupabaseDb();
  t.after(() => s.close());
  const db = core.createPostgresDriver(s.pool);
  await seedDemo(db, Date.now());
  const ctx = core.edgeContext(db, { NOTIFY_SECRET: 'x'.repeat(20) }, { log: () => {} });
  const hub = DEMO_HUBS[0];
  const res = await core.handleSync(
    new Request('http://edge.local/sync/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${hub.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hubId: hub.id, settingsVersion: 0, events: [] }),
    }),
    ctx,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lastAcceptedId: null, inserted: 0, settingsVersion: 0, accessVersion: DEMO_ACCESS_VERSION });
  const notify = await core.handleNotify(new Request('http://edge.local/notify', { method: 'POST', headers: { 'x-ts-cron': 'x'.repeat(20) } }), ctx);
  assert.equal(notify.status, 200);
  assert.equal((await core.handleOwner(new Request('http://edge.local/owner/push'), ctx)).status, 401);
});
