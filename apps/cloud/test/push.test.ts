import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudLoginResponse, CreateOwnerKeyResponse, DeviceView, PushSettingsView, TestPushResponse } from '@bills/domain';
import { parseLoginQr } from '@bills/domain';
import type { PushMessage, PushSender } from '../src/push.ts';
import { LEGACY_DEVICE_ERROR, pushSenderFromEnv, runWatchdogs } from '../src/push.ts';
import type { TestCloud } from './helpers.ts';
import { clubIdOf, cloud, event, HOUR, HUB1, HUB2, login, MONDAY_NOON, sendEvents } from './helpers.ts';

// ---------------------------------------------------------------------------
// The dispatcher (queue, dedupe, rules, watchdogs) is tested with a sender that
// records every message; how a device platform maps to ntfy / Web Push is
// RoutingSender's job (webpush.test.ts), the wire format is in ntfy.test.ts.
// ---------------------------------------------------------------------------

function recordingSender(options: { dead?: Set<string> } = {}) {
  const sent: PushMessage[] = [];
  const sender: PushSender = {
    enabled: true,
    async send(message) {
      if (options.dead?.has(message.token)) return { ok: false, error: 'gone', unregistered: true };
      sent.push(message);
      return { ok: true };
    },
  };
  return { sender, sent };
}

async function appLogin(c: TestCloud): Promise<string> {
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-ts-app': '1' },
    payload: { email: 'owner@demo.kz', password: 'demo1234' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['set-cookie'], undefined, 'the app gets no cookie');
  const body = res.json() as CloudLoginResponse;
  assert.ok(body.token);
  return body.token;
}

async function bearer<T>(c: TestCloud, token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await c.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() as T };
}

async function registerPhone(c: TestCloud, token: string, deviceToken = 'phone-1'): Promise<DeviceView> {
  const res = await bearer<DeviceView>(c, token, 'POST', '/api/owner/devices', { token: deviceToken, platform: 'android', name: 'Pixel 8' });
  assert.equal(res.status, 200);
  return res.body;
}

const lightAlert = (id: number, alertId: string, at = MONDAY_NOON, kind = 'LIGHT_WITHOUT_GAME') =>
  event(id, at, 'alert.raised', alertId, { kind, tableId: 'table-2', message: 'Стол 2: свет горит, а игры нет' }, { actor: 'system' });

async function queueStatuses(c: TestCloud): Promise<string[]> {
  const rows = await c.db.all<{ kind: string; status: string }>('SELECT kind, status FROM push_queue ORDER BY created_at, kind');
  return rows.map((r) => `${r.kind}:${r.status}`);
}

// ---------------------------------------------------------------------------

test('an alert from the HUB reaches the phone once', async (t) => {
  const push = recordingSender();
  const c = await cloud(t, { sender: push.sender });
  const token = await appLogin(c);
  await registerPhone(c, token);
  const clubId = await clubIdOf(c, HUB1.id);

  const batch = [lightAlert(1, 'alert-1')];
  await sendEvents(c, HUB1, batch);
  await c.push.flush();
  assert.equal(push.sent.length, 1);
  const m = push.sent[0]!;
  assert.equal(m.token, 'phone-1');
  assert.equal(m.platform, 'android');
  assert.equal(m.title, 'Клуб «Демо»: Свет горит без игры');
  assert.equal(m.body, 'Стол 2: свет горит, а игры нет');
  assert.deepEqual(m.data, { kind: 'LIGHT_WITHOUT_GAME', clubId, alertId: 'alert-1' });

  // The HUB resends the same batch after a lost response: no second push.
  await sendEvents(c, HUB1, batch);
  await c.push.flush();
  assert.equal(push.sent.length, 1);

  // Power alerts come the same way.
  await sendEvents(c, HUB1, [
    lightAlert(2, 'alert-2', MONDAY_NOON, 'POWER_ON_BATTERY'),
    lightAlert(3, 'alert-3', MONDAY_NOON, 'POWER_CRITICAL'),
  ]);
  await c.push.flush();
  assert.deepEqual(
    push.sent.map((s) => s.data.kind),
    ['LIGHT_WITHOUT_GAME', 'POWER_ON_BATTERY', 'POWER_CRITICAL'],
  );
  assert.deepEqual(await queueStatuses(c), ['LIGHT_WITHOUT_GAME:SENT', 'POWER_CRITICAL:SENT', 'POWER_ON_BATTERY:SENT']);
});

test('rules: per kind for all clubs, a club rule overrides, quiet kinds are off by default', async (t) => {
  const push = recordingSender();
  const c = await cloud(t, { sender: push.sender });
  const token = await appLogin(c);
  await registerPhone(c, token);
  const club1 = await clubIdOf(c, HUB1.id);

  const settings = await bearer<PushSettingsView>(c, token, 'GET', '/api/owner/push');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.pushEnabled, true);
  assert.deepEqual(settings.body.rules, []);
  assert.equal(settings.body.devices.length, 1);
  assert.ok(settings.body.kinds.some((k) => k.kind === 'HUB_OFFLINE' && k.defaultOn));

  const put = await bearer<PushSettingsView>(c, token, 'PUT', '/api/owner/push/rules', {
    rules: [
      { kind: 'LIGHT_WITHOUT_GAME', clubId: club1, enabled: false },
      { kind: 'UPS_UNREACHABLE', clubId: null, enabled: true },
    ],
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.rules.length, 2);

  await sendEvents(c, HUB1, [lightAlert(1, 'a1'), lightAlert(2, 'a2', MONDAY_NOON, 'UPS_UNREACHABLE'), lightAlert(3, 'a3', MONDAY_NOON, 'PREPAID_NOT_STARTED')]);
  await sendEvents(c, HUB2, [lightAlert(1, 'b1')]);
  await c.push.flush();
  // Club 1 light: off by the club rule; UPS: on by the all-clubs rule; prepaid: off by default; club 2 light: default on.
  assert.deepEqual(push.sent.map((s) => `${s.data.alertId}`).sort(), ['a2', 'b1']);
  const statuses = await c.db.all<{ alert_id: string; status: string }>('SELECT alert_id, status FROM push_queue ORDER BY alert_id');
  assert.deepEqual(statuses.map((r) => `${r.alert_id}:${r.status}`), ['a1:SKIPPED', 'a2:SENT', 'a3:SKIPPED', 'b1:SENT']);

  const bad = await bearer(c, token, 'PUT', '/api/owner/push/rules', { rules: [{ kind: 'NOPE', clubId: null, enabled: true }] });
  assert.equal(bad.status, 400);
  const foreign = await bearer(c, token, 'PUT', '/api/owner/push/rules', { rules: [{ kind: 'OTHER', clubId: 'not-mine', enabled: true }] });
  assert.equal(foreign.status, 404);
});

test('without a push channel pushes are off: queued, marked DISABLED and logged', async (t) => {
  const c = await cloud(t);
  const token = await appLogin(c);
  await registerPhone(c, token);
  await sendEvents(c, HUB1, [lightAlert(1, 'alert-1')]);
  await c.push.flush();
  assert.deepEqual(await queueStatuses(c), ['LIGHT_WITHOUT_GAME:DISABLED']);
  assert.ok(c.pushLog.some((l) => l.includes('Push выключен') && l.includes('Свет горит без игры')));

  const settings = await bearer<PushSettingsView>(c, token, 'GET', '/api/owner/push');
  assert.equal(settings.body.pushEnabled, false);
  const testPush = await bearer<TestPushResponse>(c, token, 'POST', '/api/owner/push/test');
  assert.deepEqual(testPush.body, { pushEnabled: false, sent: 0, failed: 0 });
});

test('an alert that reaches the cloud hours late (HUB catching up) is not pushed', async (t) => {
  const push = recordingSender();
  const c = await cloud(t, { sender: push.sender, maxAgeMs: 2 * HOUR });
  const token = await appLogin(c);
  await registerPhone(c, token);
  await sendEvents(c, HUB1, [lightAlert(1, 'old', MONDAY_NOON - 3 * HOUR), lightAlert(2, 'fresh', MONDAY_NOON - 10 * 60_000)]);
  await c.push.flush();
  assert.deepEqual(push.sent.map((s) => s.data.alertId), ['fresh']);
  const rows = await c.db.all<{ alert_id: string; status: string }>('SELECT alert_id, status FROM push_queue ORDER BY alert_id');
  assert.deepEqual(rows.map((r) => `${r.alert_id}:${r.status}`), ['fresh:SENT', 'old:STALE']);
});

test('a token the push service no longer knows removes the device', async (t) => {
  const push = recordingSender({ dead: new Set(['phone-dead']) });
  const c = await cloud(t, { sender: push.sender });
  const token = await appLogin(c);
  await registerPhone(c, token, 'phone-dead');
  await registerPhone(c, token, 'phone-alive');
  await sendEvents(c, HUB1, [lightAlert(1, 'alert-1')]);
  await c.push.flush();
  assert.deepEqual(push.sent.map((s) => s.token), ['phone-alive']);
  const devices = await bearer<PushSettingsView>(c, token, 'GET', '/api/owner/push');
  assert.equal(devices.body.devices.length, 1);
  const row = await c.db.all<{ delivered: number; failed: number }>('SELECT delivered, failed FROM push_queue');
  assert.deepEqual(row.map((r) => [Number(r.delivered), Number(r.failed)]), [[1, 1]]);
});

test('HUB offline: one push per episode, "back online" when heard again, then re-armed', async (t) => {
  const push = recordingSender();
  const c = await cloud(t, { sender: push.sender });
  const token = await appLogin(c);
  await registerPhone(c, token);
  const opts = { hubOfflineMs: 10 * 60_000, shiftOpenMs: 20 * HOUR };

  await sendEvents(c, HUB1, [event(1, MONDAY_NOON, 'session.open_requested', 'g1', { tableId: 't1', tariffId: 'x' })]);
  // HUB2 was never heard from: no alarm about a HUB that is not installed yet.
  c.clock.advance(5 * 60_000);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 0);
  c.clock.advance(6 * 60_000);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 1);
  c.clock.advance(30 * 60_000);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 0, 'once per episode');
  await c.push.flush();
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0]!.data.kind, 'HUB_OFFLINE');
  assert.equal(push.sent[0]!.title, 'Клуб «Демо»: HUB клуба пропал со связи');
  assert.match(push.sent[0]!.body, /не выходит на связь 11 мин/);

  await sendEvents(c, HUB1, [event(2, c.clock.now(), 'session.started', 'g1', { tableId: 't1', startedAt: c.clock.now() })]);
  await c.push.flush();
  assert.equal(push.sent.length, 2);
  assert.equal(push.sent[1]!.title, 'Клуб «Демо»: HUB снова на связи');

  c.clock.advance(11 * 60_000);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 1, 're-armed after the HUB came back');
});

test('a cash shift left open too long gets one SHIFT_NOT_CLOSED push', async (t) => {
  const push = recordingSender();
  const c = await cloud(t, { sender: push.sender });
  const token = await appLogin(c);
  await registerPhone(c, token);
  const opts = { hubOfflineMs: 1000 * HOUR, shiftOpenMs: 20 * HOUR };

  await sendEvents(c, HUB1, [event(1, MONDAY_NOON, 'shift.opened', 'shift-1', { number: 7, openingFloat: 0 }, { actor: 'Айгуль' })]);
  c.clock.advance(19 * HOUR);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 0);
  c.clock.advance(2 * HOUR);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 1);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 0);
  await c.push.flush();
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0]!.data.kind, 'SHIFT_NOT_CLOSED');
  assert.match(push.sent[0]!.body, /Смена №7 открыта 21 ч \(открыл: Айгуль\)/);
});

test('owner key: issued in the cabinet as a QR, signs the phone in, revocable', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);

  const created = await c.app.inject({
    method: 'POST',
    url: '/api/owner/keys',
    headers: { cookie, host: 'cloud.ts.kz', 'x-forwarded-proto': 'https' },
    payload: { label: 'Телефон Айдара' },
  });
  assert.equal(created.statusCode, 200);
  const issued = created.json() as CreateOwnerKeyResponse;
  assert.match(issued.key, /^OWNER-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(issued.view.prefix, issued.key.split('-').slice(0, 2).join('-'));
  const qr = parseLoginQr(issued.qr);
  assert.deepEqual(qr, { key: issued.key, cloudUrl: 'https://cloud.ts.kz' });

  // The phone: key → bearer token, no cookie.
  const res = await c.app.inject({ method: 'POST', url: '/api/auth/key', headers: { 'x-ts-app': '1' }, payload: { key: issued.key.toLowerCase() } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as CloudLoginResponse;
  assert.equal(body.email, 'owner@demo.kz');
  assert.ok(body.token);
  const me = await bearer<{ email: string }>(c, body.token, 'GET', '/api/auth/me');
  assert.equal(me.body.email, 'owner@demo.kz');

  // The browser: the same key → HttpOnly cookie, no token in the body.
  const web = await c.app.inject({ method: 'POST', url: '/api/auth/key', payload: { key: issued.key } });
  assert.equal(web.statusCode, 200);
  assert.equal((web.json() as CloudLoginResponse).token, undefined);
  assert.match(String(web.headers['set-cookie']), /bills_owner=.*HttpOnly/);

  const keys = await bearer<Array<{ id: string; lastUsedAt: number | null; label: string }>>(c, body.token, 'GET', '/api/owner/keys');
  assert.equal(keys.body.length, 1);
  assert.equal(keys.body[0]!.label, 'Телефон Айдара');
  assert.equal(keys.body[0]!.lastUsedAt, MONDAY_NOON);

  const wrong = await c.app.inject({ method: 'POST', url: '/api/auth/key', payload: { key: 'OWNER-AAAA-BBBB-CCCC-DDDD' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal((wrong.json() as { error: { code: string } }).error.code, 'INVALID_KEY');
  const hubKey = await c.app.inject({ method: 'POST', url: '/api/auth/key', payload: { key: HUB1.key } });
  assert.equal(hubKey.statusCode, 401);

  assert.equal((await bearer(c, body.token, 'DELETE', `/api/owner/keys/${keys.body[0]!.id}`)).status, 200);
  const again = await c.app.inject({ method: 'POST', url: '/api/auth/key', payload: { key: issued.key } });
  assert.equal(again.statusCode, 401);
  assert.equal((await bearer(c, body.token, 'DELETE', `/api/owner/keys/${keys.body[0]!.id}`)).status, 404);

  // Logging the app out ends that bearer session only.
  const out = await c.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${body.token}`, 'x-ts-app': '1' } });
  assert.equal(out.statusCode, 200);
  assert.equal((await bearer(c, body.token, 'GET', '/api/auth/me')).status, 401);
});

test('devices: register refreshes the same token, delete only your own, test push goes straight out', async (t) => {
  const push = recordingSender();
  const c = await cloud(t, { sender: push.sender });
  const token = await appLogin(c);
  const first = await registerPhone(c, token);
  const again = await registerPhone(c, token);
  assert.equal(first.id, again.id);
  assert.equal(again.name, 'Pixel 8');

  const testPush = await bearer<TestPushResponse>(c, token, 'POST', '/api/owner/push/test');
  assert.deepEqual(testPush.body, { pushEnabled: true, sent: 1, failed: 0 });
  assert.equal(push.sent[0]!.title, 'TS: проверка уведомлений');

  const badPlatform = await bearer(c, token, 'POST', '/api/owner/devices', { token: 'x', platform: 'symbian' });
  assert.equal(badPlatform.status, 400);
  assert.equal((await bearer(c, token, 'DELETE', '/api/owner/devices/nope')).status, 404);
  assert.equal((await bearer(c, token, 'DELETE', `/api/owner/devices/${first.id}`)).status, 200);
  const anonymous = await c.app.inject({ method: 'POST', url: '/api/owner/devices', payload: { token: 'x', platform: 'android' } });
  assert.equal(anonymous.statusCode, 401);
});

test('CORS: the app WebView origins are answered, others are not', async (t) => {
  const c = await cloud(t);
  const pre = await c.app.inject({
    method: 'OPTIONS',
    url: '/api/auth/key',
    headers: { origin: 'https://localhost', 'access-control-request-method': 'POST' },
  });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://localhost');
  assert.match(String(pre.headers['access-control-allow-headers']), /authorization/);
  assert.equal(pre.headers['access-control-allow-credentials'], undefined);

  const ios = await c.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'capacitor://localhost' } });
  assert.equal(ios.headers['access-control-allow-origin'], 'capacitor://localhost');
  const evil = await c.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});

test('a phone registered for the removed FCM push stays listed with an explanation', async (t) => {
  // Production routing (pushSenderFromEnv): android/ios/web tokens have no channel any more.
  const c = await cloud(t, { sender: pushSenderFromEnv({ CLOUD_FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}' }) });
  const token = await appLogin(c);
  await registerPhone(c, token, 'old-fcm-token');
  await sendEvents(c, HUB1, [lightAlert(1, 'alert-1')]);
  await c.push.flush();
  const row = await c.db.all<{ status: string; delivered: number; failed: number }>('SELECT status, delivered, failed FROM push_queue');
  assert.deepEqual(row.map((r) => [r.status, Number(r.delivered), Number(r.failed)]), [['SENT', 0, 1]]);
  const settings = await bearer<PushSettingsView>(c, token, 'GET', '/api/owner/push');
  assert.equal(settings.body.devices.length, 1, 'kept, so the owner sees why and removes it');
  assert.equal(settings.body.devices[0]!.lastError, LEGACY_DEVICE_ERROR);
});
