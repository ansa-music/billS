/**
 * The cloud cash desk builds a café in small steps (apps/cloud-hub importer.ts): create and import may answer
 * 202 «importing», and the platform's client drives `continue` until the café is ready.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudHub } from '../../apps/cloud/src/cloud-hub.ts';
import { fakeHub, HUB_TOKEN, HUB_URL } from './cloud-hub-fake.ts';

const config = { url: HUB_URL, token: HUB_TOKEN };

test('a new café built in steps: continue until ready, the director key from the ready answer', async () => {
  const hub = fakeHub();
  hub.stepped(3);
  const created = await cloudHub(config, hub.fetch).createCafe({ venue: 'Кофейня', managerName: 'Айгерим' });
  assert.match(created.managerKey, /^\d{6}$/);
  assert.equal(hub.cafes.get(created.code)?.managerKey, created.managerKey);
  assert.equal(hub.count('POST', /\/import\/continue$/), 3);
});

test('a move built in steps: the code from the first answer, continue until ready, the Idempotency-Key once', async () => {
  const hub = fakeHub();
  hub.stepped(4);
  const moved = await cloudHub(config, hub.fetch).importCafe('U1FMaXRl', { idempotencyKey: 'ts-trial-1-2' });
  assert.equal(hub.cafes.get(moved.code)?.origin, 'import');
  assert.equal(hub.count('POST', /\/import\/continue$/), 4);
  const first = hub.calls.find((c) => c.path === '/admin/cafes/import')!;
  assert.equal(first.headers['idempotency-key'], 'ts-trial-1-2');
});

test('a move that fails on the way is the Worker’s refusal, in its words', async () => {
  const hub = fakeHub();
  hub.stepped(2);
  hub.failNext(/POST \/admin\/cafes\/[^/]+\/import\/continue/, { status: 422, body: { error: { code: 'IMPORT_FAILED', message: 'Переезд не удался: Это не копия кофейни TS.' } } });
  await assert.rejects(cloudHub(config, hub.fetch).importCafe('U1FMaXRl'), (e: Error & { status?: number }) => e.status === 424 && /не копия кофейни TS/.test(e.message));
});

test('a Worker that answers at once (no steps) still works', async () => {
  const hub = fakeHub();
  const moved = await cloudHub(config, hub.fetch).importCafe('U1FMaXRl');
  assert.ok(moved.code);
  assert.equal(hub.count('POST', /\/import\/continue$/), 0);
});
