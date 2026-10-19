import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { CloudLoginResponse, CreateOwnerKeyResponse, DeviceView, PushSettingsView, TestPushResponse } from '@bills/domain';
import { parseLoginQr } from '@bills/domain';
import type { FetchLike, ServiceAccount } from '../src/push.ts';
import { FcmSender, loadServiceAccount, runWatchdogs } from '../src/push.ts';
import type { TestCloud } from './helpers.ts';
import { clubIdOf, cloud, event, HOUR, HUB1, HUB2, login, MONDAY_NOON, sendEvents } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fake FCM: the real FcmSender talks to an in-process fetch that checks the
// signed JWT like Google's token endpoint and records every message.
// ---------------------------------------------------------------------------

interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  android: { priority: string; notification: { channel_id: string } };
}

function fakeFcm(options: { dead?: Set<string> } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account: ServiceAccount = {
    project_id: 'ts-test',
    client_email: 'push@ts-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth.test/token',
  };
  const sent: FcmMessage[] = [];
  let tokenRequests = 0;
  const fetch: FetchLike = async (url, init) => {
    if (url === 'https://oauth.test/token') {
      tokenRequests++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, c, sig] = (form.get('assertion') ?? '').split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig ?? '', 'base64url'));
      assert.ok(ok, 'JWT signature');
      const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString()) as Record<string, unknown>;
      assert.equal(claims.iss, account.client_email);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      assert.equal(claims.aud, account.token_uri);
      return { status: 200, text: async () => JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }) };
    }
    assert.equal(url, 'https://fcm.test/v1/projects/ts-test/messages:send');
    assert.equal(init.headers.authorization, 'Bearer ya29.fake');
    const { message } = JSON.parse(init.body) as { message: FcmMessage };
    if (options.dead?.has(message.token)) {
      return {
        status: 404,
        text: async () => JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
      };
    }
    sent.push(message);
    return { status: 200, text: async () => '{"name":"projects/ts-test/messages/1"}' };
  };
  const sender = new FcmSender(account, { fetch, endpoint: 'https://fcm.test' });
  return { sender, sent, account, tokenRequests: () => tokenRequests };
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

async function registerPhone(c: TestCloud, token: string, fcmToken = 'fcm-phone-1'): Promise<DeviceView> {
  const res = await bearer<DeviceView>(c, token, 'POST', '/api/owner/devices', { token: fcmToken, platform: 'android', name: 'Pixel 8' });
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

test('an alert from the HUB reaches the phone once, through FCM HTTP v1', async (t) => {
  const fcm = fakeFcm();
  const c = await cloud(t, { sender: fcm.sender });
  const token = await appLogin(c);
  await registerPhone(c, token);
  const clubId = await clubIdOf(c, HUB1.id);

  const batch = [lightAlert(1, 'alert-1')];
  await sendEvents(c, HUB1, batch);
  await c.push.flush();
  assert.equal(fcm.sent.length, 1);
  const m = fcm.sent[0]!;
  assert.equal(m.token, 'fcm-phone-1');
  assert.equal(m.notification.title, 'Клуб «Демо»: Свет горит без игры');
  assert.equal(m.notification.body, 'Стол 2: свет горит, а игры нет');
  assert.deepEqual(m.data, { kind: 'LIGHT_WITHOUT_GAME', clubId, alertId: 'alert-1' });
  assert.equal(m.android.priority, 'HIGH');
  assert.equal(m.android.notification.channel_id, 'alerts');

  // The HUB resends the same batch after a lost response: no second push.
  await sendEvents(c, HUB1, batch);
  await c.push.flush();
  assert.equal(fcm.sent.length, 1);

  // Power alerts come the same way; the OAuth token is reused.
  await sendEvents(c, HUB1, [
    lightAlert(2, 'alert-2', MONDAY_NOON, 'POWER_ON_BATTERY'),
    lightAlert(3, 'alert-3', MONDAY_NOON, 'POWER_CRITICAL'),
  ]);
  await c.push.flush();
  assert.deepEqual(
    fcm.sent.map((s) => s.data.kind),
    ['LIGHT_WITHOUT_GAME', 'POWER_ON_BATTERY', 'POWER_CRITICAL'],
  );
  assert.equal(fcm.tokenRequests(), 1);
  assert.deepEqual(await queueStatuses(c), ['LIGHT_WITHOUT_GAME:SENT', 'POWER_CRITICAL:SENT', 'POWER_ON_BATTERY:SENT']);
});

test('rules: per kind for all clubs, a club rule overrides, quiet kinds are off by default', async (t) => {
  const fcm = fakeFcm();
  const c = await cloud(t, { sender: fcm.sender });
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
  assert.deepEqual(fcm.sent.map((s) => `${s.data.alertId}`).sort(), ['a2', 'b1']);
  const statuses = await c.db.all<{ alert_id: string; status: string }>('SELECT alert_id, status FROM push_queue ORDER BY alert_id');
  assert.deepEqual(statuses.map((r) => `${r.alert_id}:${r.status}`), ['a1:SKIPPED', 'a2:SENT', 'a3:SKIPPED', 'b1:SENT']);

  const bad = await bearer(c, token, 'PUT', '/api/owner/push/rules', { rules: [{ kind: 'NOPE', clubId: null, enabled: true }] });
  assert.equal(bad.status, 400);
  const foreign = await bearer(c, token, 'PUT', '/api/owner/push/rules', { rules: [{ kind: 'OTHER', clubId: 'not-mine', enabled: true }] });
  assert.equal(foreign.status, 404);
});

test('without an FCM key pushes are off: queued, marked DISABLED and logged', async (t) => {
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
  const fcm = fakeFcm();
  const c = await cloud(t, { sender: fcm.sender, maxAgeMs: 2 * HOUR });
  const token = await appLogin(c);
  await registerPhone(c, token);
  await sendEvents(c, HUB1, [lightAlert(1, 'old', MONDAY_NOON - 3 * HOUR), lightAlert(2, 'fresh', MONDAY_NOON - 10 * 60_000)]);
  await c.push.flush();
  assert.deepEqual(fcm.sent.map((s) => s.data.alertId), ['fresh']);
  const rows = await c.db.all<{ alert_id: string; status: string }>('SELECT alert_id, status FROM push_queue ORDER BY alert_id');
  assert.deepEqual(rows.map((r) => `${r.alert_id}:${r.status}`), ['fresh:SENT', 'old:STALE']);
});

test('a token FCM no longer knows removes the device; other errors are kept on it', async (t) => {
  const fcm = fakeFcm({ dead: new Set(['fcm-dead']) });
  const c = await cloud(t, { sender: fcm.sender });
  const token = await appLogin(c);
  await registerPhone(c, token, 'fcm-dead');
  await registerPhone(c, token, 'fcm-alive');
  await sendEvents(c, HUB1, [lightAlert(1, 'alert-1')]);
  await c.push.flush();
  assert.deepEqual(fcm.sent.map((s) => s.token), ['fcm-alive']);
  const devices = await bearer<PushSettingsView>(c, token, 'GET', '/api/owner/push');
  assert.equal(devices.body.devices.length, 1);
  const row = await c.db.all<{ delivered: number; failed: number }>('SELECT delivered, failed FROM push_queue');
  assert.deepEqual(row.map((r) => [Number(r.delivered), Number(r.failed)]), [[1, 1]]);
});

test('HUB offline: one push per episode, "back online" when heard again, then re-armed', async (t) => {
  const fcm = fakeFcm();
  const c = await cloud(t, { sender: fcm.sender });
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
  assert.equal(fcm.sent.length, 1);
  assert.equal(fcm.sent[0]!.data.kind, 'HUB_OFFLINE');
  assert.equal(fcm.sent[0]!.notification.title, 'Клуб «Демо»: HUB клуба пропал со связи');
  assert.match(fcm.sent[0]!.notification.body, /не выходит на связь 11 мин/);

  await sendEvents(c, HUB1, [event(2, c.clock.now(), 'session.started', 'g1', { tableId: 't1', startedAt: c.clock.now() })]);
  await c.push.flush();
  assert.equal(fcm.sent.length, 2);
  assert.equal(fcm.sent[1]!.notification.title, 'Клуб «Демо»: HUB снова на связи');

  c.clock.advance(11 * 60_000);
  assert.equal(await runWatchdogs(c.db, c.clock.now(), opts), 1, 're-armed after the HUB came back');
});

test('a cash shift left open too long gets one SHIFT_NOT_CLOSED push', async (t) => {
  const fcm = fakeFcm();
  const c = await cloud(t, { sender: fcm.sender });
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
  assert.equal(fcm.sent.length, 1);
  assert.equal(fcm.sent[0]!.data.kind, 'SHIFT_NOT_CLOSED');
  assert.match(fcm.sent[0]!.notification.body, /Смена №7 открыта 21 ч \(открыл: Айгуль\)/);
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
  const fcm = fakeFcm();
  const c = await cloud(t, { sender: fcm.sender });
  const token = await appLogin(c);
  const first = await registerPhone(c, token);
  const again = await registerPhone(c, token);
  assert.equal(first.id, again.id);
  assert.equal(again.name, 'Pixel 8');

  const testPush = await bearer<TestPushResponse>(c, token, 'POST', '/api/owner/push/test');
  assert.deepEqual(testPush.body, { pushEnabled: true, sent: 1, failed: 0 });
  assert.equal(fcm.sent[0]!.notification.title, 'TS: проверка уведомлений');

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

test('service account key from env: inline JSON, file, none, incomplete', () => {
  assert.equal(loadServiceAccount({}), null);
  const json = JSON.stringify({ project_id: 'p', client_email: 'e@x', private_key: 'k', extra: 1 });
  assert.deepEqual(loadServiceAccount({ CLOUD_FCM_SERVICE_ACCOUNT_JSON: json }), { project_id: 'p', client_email: 'e@x', private_key: 'k' });
  assert.throws(() => loadServiceAccount({ CLOUD_FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}' }), /client_email/);
});
