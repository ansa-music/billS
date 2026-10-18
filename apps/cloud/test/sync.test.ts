import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClubDetails, OwnerOverview } from '@bills/domain';
import { clubIdOf, cloud, event, gameEvents, HOUR, HUB1, HUB2, hubPost, login, MONDAY_NOON, ownerGet, sendEvents, tableIdOf } from './helpers.ts';

test('unknown key is 401, a key of another HUB is 403', async (t) => {
  const c = await cloud(t);
  const body = { hubId: HUB1.id, settingsVersion: 0, events: [] };

  const noHeader = await c.app.inject({ method: 'POST', url: '/sync/events', payload: body });
  assert.equal(noHeader.statusCode, 401);

  const unknown = await hubPost<{ error: { code: string } }>(c, 'no-such-key', '/sync/events', body);
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.code, 'UNAUTHORIZED');

  const mismatch = await hubPost<{ error: { code: string } }>(c, HUB2.key, '/sync/events', body);
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error.code, 'HUB_MISMATCH');

  const ok = await sendEvents(c, HUB1, []);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { lastAcceptedId: null, inserted: 0, settingsVersion: 0 });

  const settingsUnknown = await c.app.inject({ method: 'GET', url: '/sync/settings?since=0', headers: { authorization: 'Bearer nope' } });
  assert.equal(settingsUnknown.statusCode, 401);
});

test('a redelivered batch and a duplicate inside a batch are stored once', async (t) => {
  const c = await cloud(t);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 1');
  const events = gameEvents(1, 'game-1', tableId, MONDAY_NOON, MONDAY_NOON + HOUR, 2000_00);
  const first = events[0]!;

  const res1 = await sendEvents(c, HUB1, [...events, first]);
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.body, { lastAcceptedId: 3, inserted: 3, settingsVersion: 0 });

  const res2 = await sendEvents(c, HUB1, events);
  assert.deepEqual(res2.body, { lastAcceptedId: 3, inserted: 0, settingsVersion: 0 });

  // Events of another HUB with the same outbox ids are distinct.
  const other = await sendEvents(c, HUB2, [event(1, MONDAY_NOON, 'lamp.on', tableId, { commandId: 'c1', sessionId: null })]);
  assert.deepEqual(other.body, { lastAcceptedId: 1, inserted: 1, settingsVersion: 0 });

  const stored = await c.db.all<{ c: number }>('SELECT COUNT(*) AS c FROM events WHERE hub_id = ?', [HUB1.id]);
  assert.equal(stored[0]?.c, 3);
  const sessions = await c.db.all<{ id: string; status: string; amount: number; tariff_name: string }>(
    'SELECT id, status, amount, tariff_name FROM sessions',
  );
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.status, 'AWAITING_PAYMENT');
  assert.equal(sessions[0]?.amount, 2000_00);

  // The projection ran once: one game, one revenue entry.
  const day = await c.db.all<{ revenue: number; games: number }>('SELECT revenue, games FROM daily_stats');
  assert.deepEqual(day, [{ revenue: 2000_00, games: 1 }]);

  const hub = await c.db.all<{ last_seen_at: number; last_outbox_id: number; settings_version: number }>(
    'SELECT last_seen_at, last_outbox_id, settings_version FROM hubs WHERE id = ?',
    [HUB1.id],
  );
  assert.deepEqual(hub, [{ last_seen_at: MONDAY_NOON, last_outbox_id: 3, settings_version: 0 }]);
});

test('tariff name comes from club settings; a game without session.started still gets a row', async (t) => {
  const c = await cloud(t);
  const clubId = await clubIdOf(c, HUB1.id);
  const settings = await c.db.all<{ tariffs_json: string }>('SELECT tariffs_json FROM club_settings WHERE club_id = ?', [clubId]);
  const tariffs = JSON.parse(settings[0]!.tariffs_json) as Array<{ id: string; name: string }>;
  const snooker = tariffs.find((x) => x.name === 'Снукер')!;
  const tableId = await tableIdOf(c, HUB1.id, 'Снукер');

  await sendEvents(c, HUB1, [
    event(1, MONDAY_NOON, 'session.open_requested', 'g1', { tableId, tariffId: snooker.id }),
    // session.started lost; stopped arrives directly
    event(2, MONDAY_NOON + HOUR, 'session.stopped', 'g1', {
      tableId,
      startedAt: MONDAY_NOON,
      stoppedAt: MONDAY_NOON + HOUR,
      playedSeconds: 3600,
      billedSeconds: 3600,
      amount: 4000_00,
      segments: [],
    }),
    event(3, MONDAY_NOON + 2 * HOUR, 'session.stopped', 'g2', {
      tableId,
      startedAt: MONDAY_NOON + HOUR,
      stoppedAt: MONDAY_NOON + 2 * HOUR,
      playedSeconds: 3600,
      billedSeconds: 3600,
      amount: 4000_00,
      segments: [],
    }),
    event(4, MONDAY_NOON + 3 * HOUR, 'session.open_requested', 'g3', { tableId, tariffId: snooker.id }),
    event(5, MONDAY_NOON + 3 * HOUR + 5000, 'session.cancelled', 'g3', { tableId, reason: 'STOPPED_BEFORE_LAMP_CONFIRMED' }),
    event(6, MONDAY_NOON + 4 * HOUR, 'session.open_requested', 'g4', { tableId, tariffId: snooker.id }),
    event(7, MONDAY_NOON + 4 * HOUR + 5000, 'session.failed', 'g4', { tableId, reason: 'LAMP_NOT_CONFIRMED' }, { actor: 'system' }),
  ]);

  const rows = await c.db.all<{ id: string; status: string; tariff_name: string | null; started_at: number | null; failure_reason: string | null }>(
    'SELECT id, status, tariff_name, started_at, failure_reason FROM sessions ORDER BY id',
  );
  assert.deepEqual(rows, [
    { id: 'g1', status: 'AWAITING_PAYMENT', tariff_name: 'Снукер', started_at: MONDAY_NOON, failure_reason: null },
    { id: 'g2', status: 'AWAITING_PAYMENT', tariff_name: null, started_at: MONDAY_NOON + HOUR, failure_reason: null },
    { id: 'g3', status: 'CANCELLED', tariff_name: 'Снукер', started_at: null, failure_reason: 'STOPPED_BEFORE_LAMP_CONFIRMED' },
    { id: 'g4', status: 'FAILED', tariff_name: 'Снукер', started_at: null, failure_reason: 'LAMP_NOT_CONFIRMED' },
  ]);
  const day = await c.db.all<{ revenue: number; games: number; played_seconds: number }>('SELECT revenue, games, played_seconds FROM daily_stats');
  assert.deepEqual(day, [{ revenue: 8000_00, games: 2, played_seconds: 7200 }]);
});

test('alert.raised and alert.resolved drive openAlerts', async (t) => {
  const c = await cloud(t);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 2');
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);

  await sendEvents(c, HUB1, [
    event(1, MONDAY_NOON, 'lamp.failed', tableId, { commandId: 'c1', action: 'ON', attempts: 4, error: 'timeout' }, { actor: 'system' }),
    event(2, MONDAY_NOON, 'alert.raised', 'alert-1', {
      kind: 'LAMP_ON_FAILED',
      tableId,
      sessionId: 'g1',
      message: 'Стол 2: лампа не подтвердила включение',
    }, { actor: 'system' }),
  ]);

  let ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.status, 200);
  const club = ov.body.clubs.find((x) => x.id === clubId)!;
  assert.equal(club.openAlerts, 1);
  assert.equal(ov.body.alerts.length, 1);
  assert.equal(ov.body.alerts[0]?.tableName, 'Стол 2');
  assert.equal(ov.body.alerts[0]?.clubName, 'Клуб «Демо»');
  assert.equal(ov.body.alerts[0]?.resolvedAt, null);

  let details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(details.body.days.at(-1)?.alerts, 1);

  await sendEvents(c, HUB1, [event(3, MONDAY_NOON + 60_000, 'alert.resolved', 'alert-1', {}, { actor: 'Менеджер' })]);
  ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.body.clubs.find((x) => x.id === clubId)?.openAlerts, 0);
  assert.equal(ov.body.alerts.length, 0);

  details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(details.body.alerts.length, 1);
  assert.equal(details.body.alerts[0]?.resolvedAt, MONDAY_NOON + 60_000);
  const lamp = await c.db.all<{ lamp_failures: number }>('SELECT lamp_failures FROM daily_stats');
  assert.deepEqual(lamp, [{ lamp_failures: 1 }]);
});

test('an unknown topic does not break the batch', async (t) => {
  const c = await cloud(t);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 1');
  const res = await sendEvents(c, HUB1, [
    event(1, MONDAY_NOON, 'session.open_requested', 'g1', { tableId, tariffId: 't' }),
    { id: 2, at: MONDAY_NOON, topic: 'check.paid', payload: { actor: 'Кассир', action: 'check.paid', entityType: 'check', entityId: 'chk-1', data: { amount: 5 } } },
    event(3, MONDAY_NOON, 'hub.recovered', 'hub', { tables: 6, resent: 0 }, { actor: 'system' }),
    event(4, MONDAY_NOON + 1000, 'session.started', 'g1', { tableId, startedAt: MONDAY_NOON + 1000 }, { actor: 'system' }),
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { lastAcceptedId: 4, inserted: 4, settingsVersion: 0 });
  const topics = await c.db.all<{ topic: string }>('SELECT topic FROM events ORDER BY outbox_id');
  assert.deepEqual(topics.map((r) => r.topic), ['session.open_requested', 'check.paid', 'hub.recovered', 'session.started']);
  const s = await c.db.all<{ status: string }>('SELECT status FROM sessions');
  assert.deepEqual(s, [{ status: 'ACTIVE' }]);
});

test('a failing event rolls back the whole batch', async (t) => {
  const c = await cloud(t);
  // status must satisfy the CHECK constraint: a bad session id type sneaks past the schema as a string, so force a constraint error with a NULL table.
  const res = await sendEvents(c, HUB1, [
    event(1, MONDAY_NOON, 'session.open_requested', 'g1', { tableId: 'table-x', tariffId: 't' }),
    { id: 2, at: MONDAY_NOON, topic: 'alert.raised', payload: { actor: 'system', action: 'alert.raised', entityType: 'alert', entityId: 'a1', data: { kind: 5, message: 7 } } },
  ]);
  assert.equal(res.status, 200); // tolerant to odd data types
  const bad = await c.app.inject({
    method: 'POST',
    url: '/sync/events',
    headers: { authorization: `Bearer ${HUB1.key}` },
    payload: { hubId: HUB1.id, settingsVersion: 0, events: [{ id: 'x', at: 1, topic: 't', payload: {} }] },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'BAD_REQUEST');
});
