import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleNotify } from '../../apps/cloud/src/edge/notify.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import { RoutingSender } from '../../apps/cloud/src/push.ts';
import { DEMO_HUBS } from '../../apps/cloud/src/seed.ts';
import { edgeTest, linkOwner, NOTIFY_SECRET, recordingSender, userJwt } from './edge-helpers.ts';

const MIN = 60_000;

test('notify: secret required; watchdog pushes HUB_OFFLINE once, then "back online" after a sync', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  await e.call(handleOwner, 'POST', '/owner/devices', {
    headers: { authorization: `Bearer ${userJwt(uid)}` },
    body: { platform: 'ntfy', token: 'https://ntfy.sh/ts-abcdefghijklmnopqrstuvwx' },
  });
  const hub = DEMO_HUBS[0];
  await e.call(handleSync, 'POST', '/sync/events', { headers: { authorization: `Bearer ${hub.key}` }, body: { hubId: hub.id, settingsVersion: 0, events: [] } });
  // Only HUB 1 has been heard; HUB 2 never synced, so it is not "offline".

  assert.equal((await e.call(handleNotify, 'POST', '/notify')).status, 401);
  assert.equal((await e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': 'wrong' } })).status, 401);

  e.clock.now += 11 * MIN;
  const run = await e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': NOTIFY_SECRET } });
  assert.equal(run.status, 200);
  assert.equal(run.body.queued, 1);
  assert.equal(run.body.delivered, 1);
  assert.equal(e.sent[0]!.data.kind, 'HUB_OFFLINE');
  assert.match(e.sent[0]!.body, /не выходит на связь 11 мин/);

  e.clock.now += 5 * MIN;
  const quiet = await e.call(handleNotify, 'POST', '/functions/v1/notify', { headers: { 'x-ts-cron': NOTIFY_SECRET } });
  assert.equal(quiet.body.queued, 0);
  assert.equal(e.sent.length, 1);

  await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: { authorization: `Bearer ${hub.key}` } });
  assert.equal(e.sent.length, 2, 'flushed by the sync call itself');
  assert.equal(e.sent[1]!.title, 'Клуб «Демо»: HUB снова на связи');
});

test('notify: without NOTIFY_SECRET it refuses to run; push_configured=0 without VAPID', async (t) => {
  const sent: never[] = [];
  const e = await edgeTest(t, { sender: new RoutingSender({ ntfy: recordingSender('ntfy', sent) }) });
  const ok = await e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': NOTIFY_SECRET } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await e.s.db.all('SELECT key, value FROM ts_runtime'), [{ key: 'push_configured', value: '0' }]);

  e.ctx.notifySecret = null;
  const res = await e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': '' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'NOTIFY_NOT_CONFIGURED');
});
