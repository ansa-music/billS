import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '@bills/domain';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { DEMO_ACCESS_VERSION, DEMO_HUBS } from '../../apps/cloud/src/seed.ts';
import { createTestCloud } from '../../apps/cloud/test/helpers.ts';
import { clubIdOf, edgeTest, HOUR, linkOwner, MONDAY_NOON, userJwt } from './edge-helpers.ts';

const [HUB1, HUB2] = DEMO_HUBS;
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

function ev(id: number, at: number, topic: string, entityId: string, data: Record<string, unknown> = {}, actor = 'Кассир'): SyncEvent {
  const entityType = topic.startsWith('session.') ? 'session' : topic.startsWith('alert.') ? 'alert' : 'table';
  return { id, at, topic, payload: { actor, action: topic, entityType, entityId, data } };
}

function game(first: number, sessionId: string, tableId: string, startedAt: number, stoppedAt: number, amount: number): SyncEvent[] {
  const playedSeconds = Math.floor((stoppedAt - startedAt) / 1000);
  return [
    ev(first, startedAt - 1000, 'session.open_requested', sessionId, { tableId, tariffId: 'tariff-x' }),
    ev(first + 1, startedAt, 'session.started', sessionId, { tableId, startedAt }, 'system'),
    ev(first + 2, stoppedAt, 'session.stopped', sessionId, {
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

test('sync: auth errors, events, duplicates — same answers as the Fastify cloud', async (t) => {
  const e = await edgeTest(t);
  const fastify = await createTestCloud();
  t.after(() => fastify.close());

  /** The same request to both; returns the edge answer after checking they agree. */
  const both = async (method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown) => {
    const edge = await e.call(handleSync, method, url, { headers, ...(body === undefined ? {} : { body }) });
    const ref = await fastify.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
    assert.equal(edge.status, ref.statusCode, `${method} ${url}: status`);
    if (edge.status < 400) assert.deepEqual(edge.body, ref.json(), `${method} ${url}: body`);
    else assert.equal(edge.body.error.code, (ref.json() as { error: { code: string } }).error.code, `${method} ${url}: error code`);
    assert.match(edge.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
    return edge;
  };

  const empty = { hubId: HUB1.id, settingsVersion: 0, events: [] };
  await both('POST', '/sync/events', {}, empty);
  await both('POST', '/sync/events', auth('no-such-key'), empty);
  const mismatch = await both('POST', '/sync/events', auth(HUB2.key), empty);
  assert.equal(mismatch.body.error.code, 'HUB_MISMATCH');
  const ok = await both('POST', '/sync/events', auth(HUB1.key), empty);
  assert.deepEqual(ok.body, { lastAcceptedId: null, inserted: 0, settingsVersion: 0, accessVersion: DEMO_ACCESS_VERSION });

  // Invalid bodies are 400 BAD_REQUEST, validated before auth (like Fastify's schema).
  await both('POST', '/sync/events', auth(HUB1.key), { hubId: HUB1.id, events: [] });
  await both('POST', '/sync/events', auth(HUB1.key), { hubId: HUB1.id, settingsVersion: 0, events: [{ id: 0, at: 1, topic: 'x', payload: {} }] });
  const broken = await e.call(handleSync, 'POST', '/sync/events', { headers: auth(HUB1.key), raw: '{nope' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error.code, 'BAD_REQUEST');

  const events = game(1, 'game-1', 'table-1', MONDAY_NOON, MONDAY_NOON + HOUR, 2000_00);
  const first = await both('POST', '/sync/events', auth(HUB1.key), { hubId: HUB1.id, settingsVersion: 0, events: [...events, events[0]] });
  assert.deepEqual(first.body, { lastAcceptedId: 3, inserted: 3, settingsVersion: 0, accessVersion: DEMO_ACCESS_VERSION });
  const again = await both('POST', '/sync/events', auth(HUB1.key), { hubId: HUB1.id, settingsVersion: 0, events });
  assert.deepEqual(again.body, { lastAcceptedId: 3, inserted: 0, settingsVersion: 0, accessVersion: DEMO_ACCESS_VERSION });
  // Coercion like Fastify's Ajv: a numeric string is accepted as an integer, extra top-level fields are dropped.
  await both('POST', '/sync/events', auth(HUB2.key), { hubId: HUB2.id, settingsVersion: '0', extra: true, events: [ev(1, MONDAY_NOON, 'lamp.on', 't', {})] });

  const sessions = await e.s.db.all<{ status: string; amount: number }>('SELECT status, amount FROM sessions');
  assert.deepEqual(sessions, [{ status: 'AWAITING_PAYMENT', amount: 2000_00 }]);

  await both('GET', '/sync/settings?since=abc', auth(HUB1.key));
  await both('GET', `/sync/settings?since=0&hubId=${HUB2.id}`, auth(HUB1.key));
  await both('GET', '/sync/settings?since=0', auth('nope'));
  await both('GET', '/sync/settings?since=0', auth(HUB1.key)); // version 0 everywhere → unchanged
  await both('GET', '/sync/nothing', auth(HUB1.key));
});

test('sync: also reachable with the /functions/v1 prefix', async (t) => {
  const e = await edgeTest(t);
  const res = await e.call(handleSync, 'POST', '/functions/v1/sync/events', {
    headers: auth(HUB1.key),
    body: { hubId: HUB1.id, settingsVersion: 0, events: [] },
  });
  assert.equal(res.status, 200);
  assert.equal((await e.call(handleSync, 'GET', '/functions/v1/sync/settings?since=0', { headers: auth(HUB1.key) })).status, 200);
});

test('sync: snapshot 409 after an owner edit, settings pull, then the HUB catches up', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const clubId = await clubIdOf(e.s, HUB1.id);
  const current = JSON.parse(
    (await e.s.db.all<{ tariffs_json: string }>('SELECT tariffs_json FROM club_settings WHERE club_id = ?', [clubId]))[0]!.tariffs_json,
  );
  const edit = await e.call(handleOwner, 'PUT', `/owner/clubs/${clubId}/tariffs`, {
    headers: { authorization: `Bearer ${userJwt(uid)}` },
    body: { tariffs: current },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.settings.version, 1);

  const snapshot = { hubId: HUB1.id, settingsVersion: 0, club: { name: 'Клуб «Демо»', timezone: 'Asia/Almaty', currency: 'KZT' }, tariffs: [], tables: [] };
  const stale = await e.call(handleSync, 'POST', '/sync/snapshot', { headers: auth(HUB1.key), body: snapshot });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { accepted: false, settingsVersion: 1 });

  const events = await e.call(handleSync, 'POST', '/sync/events', { headers: auth(HUB1.key), body: { hubId: HUB1.id, settingsVersion: 0, events: [] } });
  assert.equal(events.body.settingsVersion, 1);

  const pulled = await e.call(handleSync, 'GET', `/sync/settings?since=0&hubId=${HUB1.id}`, { headers: auth(HUB1.key) });
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.changed, true);
  assert.equal(pulled.body.version, 1);
  assert.equal(pulled.body.tariffs.length, current.length);
  assert.deepEqual((await e.call(handleSync, 'GET', '/sync/settings?since=1', { headers: auth(HUB1.key) })).body, { changed: false, version: 1 });

  const caughtUp = await e.call(handleSync, 'POST', '/sync/snapshot', {
    headers: auth(HUB1.key),
    body: { ...snapshot, settingsVersion: 1, tariffs: pulled.body.tariffs, tables: pulled.body.tables },
  });
  assert.equal(caughtUp.status, 200);
  assert.deepEqual(caughtUp.body, { accepted: true, settingsVersion: 1 });
});

test('sync: an alert is pushed before the answer, routed by device platform', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const owner = { authorization: `Bearer ${userJwt(uid)}` };
  const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPk', auth: 'x' } });
  assert.equal((await e.call(handleOwner, 'POST', '/owner/devices', { headers: owner, body: { platform: 'webpush', token: sub, name: 'Chrome' } })).status, 200);
  const topic = 'https://ntfy.sh/ts-abcdefghijklmnopqrstuvwx';
  assert.equal((await e.call(handleOwner, 'POST', '/owner/devices', { headers: owner, body: { platform: 'ntfy', token: topic } })).status, 200);

  const alert = ev(1, MONDAY_NOON, 'alert.raised', 'alert-1', { kind: 'LIGHT_WITHOUT_GAME', tableId: 't2', message: 'Стол 2: свет горит, а игры нет' }, 'system');
  const res = await e.call(handleSync, 'POST', '/sync/events', { headers: auth(HUB1.key), body: { hubId: HUB1.id, settingsVersion: 0, events: [alert] } });
  assert.equal(res.status, 200);
  const clubId = await clubIdOf(e.s, HUB1.id);
  assert.deepEqual(
    e.sent.map((m) => [m.channel, m.platform, m.token, m.title, m.data]),
    [
      ['webpush', 'webpush', sub, 'Клуб «Демо»: Свет горит без игры', { kind: 'LIGHT_WITHOUT_GAME', clubId, alertId: 'alert-1' }],
      ['ntfy', 'ntfy', topic, 'Клуб «Демо»: Свет горит без игры', { kind: 'LIGHT_WITHOUT_GAME', clubId, alertId: 'alert-1' }],
    ],
  );
  const queue = await e.s.db.all<{ status: string; delivered: number }>('SELECT status, delivered FROM push_queue');
  assert.deepEqual(queue, [{ status: 'SENT', delivered: 2 }]);
  // Web Push is configured in this context (recording sender named webpush): reported for the RPC.
  assert.deepEqual(await e.s.db.all('SELECT key, value FROM ts_runtime'), [{ key: 'push_configured', value: '1' }]);
});
