import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { DEMO_HUBS } from '../../apps/cloud/src/seed.ts';
import { clubIdOf, edgeTest, linkOwner, MONDAY_NOON, otherCompany, userJwt } from './edge-helpers.ts';

const TARIFF = {
  name: 'Новый',
  config: {
    currency: 'KZT',
    basePricePerHour: 1500_00,
    windows: [],
    stepMinutes: 1,
    minimumMinutes: 30,
    freeMinutes: 0,
    roundingMinor: 10_00,
  },
};

test('owner: JWT user edits tariffs of own clubs only', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const other = await otherCompany(e.s);
  const mine = await clubIdOf(e.s, DEMO_HUBS[0].id);
  const h = { authorization: `Bearer ${userJwt(uid)}` };

  const ok = await e.call(handleOwner, 'PUT', `/owner/clubs/${mine}/tariffs`, { headers: h, body: { tariffs: [TARIFF] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.version, 1);
  assert.deepEqual(
    ok.body.settings.tariffs.map((x: { name: string; isActive: boolean }) => [x.name, x.isActive]),
    [
      ['Новый', true],
      ['Стандарт', false],
      ['Снукер', false],
    ],
  );
  // The cabinet's base is /functions/v1/owner and it adds /owner/...: both forms work.
  const doubled = await e.call(handleOwner, 'PUT', `/functions/v1/owner/owner/clubs/${mine}/tariffs`, { headers: h, body: { tariffs: [TARIFF] } });
  assert.equal(doubled.status, 200);
  assert.equal(doubled.body.settings.version, 2);

  const foreign = await e.call(handleOwner, 'PUT', `/owner/clubs/${other.clubId}/tariffs`, { headers: h, body: { tariffs: [TARIFF] } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'CLUB_NOT_FOUND');

  const invalid = await e.call(handleOwner, 'PUT', `/owner/clubs/${mine}/tariffs`, {
    headers: h,
    body: { tariffs: [{ ...TARIFF, config: { ...TARIFF.config, stepMinutes: 0 } }] },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'TARIFF_INVALID');

  // The other company's owner signs in and does not see our club either.
  const otherUid = await linkOwner(e.s, other.email);
  const cross = await e.call(handleOwner, 'PUT', `/owner/clubs/${mine}/tariffs`, {
    headers: { authorization: `Bearer ${userJwt(otherUid)}` },
    body: { tariffs: [TARIFF] },
  });
  assert.equal(cross.status, 404);
});

test('owner: who may call — no token, anon key, expired, unlinked user', async (t) => {
  const e = await edgeTest(t);
  await linkOwner(e.s);
  const club = await clubIdOf(e.s, DEMO_HUBS[0].id);
  const put = (headers: Record<string, string>) => e.call(handleOwner, 'PUT', `/owner/clubs/${club}/tariffs`, { headers, body: { tariffs: [TARIFF] } });

  assert.equal((await put({})).status, 401);
  assert.equal((await put({ authorization: 'Bearer not-a-jwt' })).status, 401);
  const anon = userJwt('00000000-0000-0000-0000-000000000000', { role: 'anon' });
  assert.equal((await put({ authorization: `Bearer ${anon}` })).status, 401);
  const expired = userJwt(crypto.randomUUID(), { exp: Math.floor(MONDAY_NOON / 1000) - 1 });
  assert.equal((await put({ authorization: `Bearer ${expired}` })).status, 401);

  const stranger = await e.s.createAuthUser('stranger@example.com');
  const res = await put({ authorization: `Bearer ${userJwt(stranger)}` });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_OWNER');

  // A JWT for a user id that is not in auth.users at all.
  assert.equal((await put({ authorization: `Bearer ${userJwt(crypto.randomUUID())}` })).status, 403);
});

test('owner: with SUPABASE_JWT_SECRET an HS256 signature is checked', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const secret = 'super-secret-jwt-token-with-at-least-32-characters';
  e.ctx.jwtSecret = secret;
  const unsigned = userJwt(uid);
  const [h, p] = unsigned.split('.') as [string, string];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`))).toString('base64url');

  assert.equal((await e.call(handleOwner, 'GET', '/owner/push', { headers: { authorization: `Bearer ${unsigned}` } })).status, 401);
  const ok = await e.call(handleOwner, 'GET', '/owner/push', { headers: { authorization: `Bearer ${h}.${p}.${sig}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.channels, ['webpush', 'ntfy']);
});

test('owner: devices (webpush, ntfy) register idempotently, delete, test push, CORS', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const h = { authorization: `Bearer ${userJwt(uid)}` };
  const sub = JSON.stringify({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys: { p256dh: 'BP', auth: 'au' } });

  const first = await e.call(handleOwner, 'POST', '/owner/devices', { headers: h, body: { platform: 'webpush', token: sub, name: 'Firefox' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.platform, 'webpush');
  assert.equal(first.body.name, 'Firefox');
  const second = await e.call(handleOwner, 'POST', '/owner/devices', { headers: h, body: { platform: 'webpush', token: sub } });
  assert.equal(second.body.id, first.body.id);

  const ntfy = await e.call(handleOwner, 'POST', '/owner/owner/devices', {
    headers: h,
    body: { platform: 'ntfy', token: 'https://ntfy.sh/ts-ABCDEFGHIJKLMNOPQRSTUVWX' },
  });
  assert.equal(ntfy.status, 200);
  assert.equal(ntfy.body.name, 'Телефон (ntfy)');

  for (const body of [
    { platform: 'webpush', token: '{"endpoint":"http://x/"}' },
    { platform: 'ntfy', token: 'https://ntfy.sh/short' },
    { platform: 'symbian', token: 'x' },
  ]) {
    const bad = await e.call(handleOwner, 'POST', '/owner/devices', { headers: h, body });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }

  const test1 = await e.call(handleOwner, 'POST', '/owner/push/test', { headers: h });
  assert.deepEqual(test1.body, { pushEnabled: true, sent: 2, failed: 0 });
  assert.deepEqual(e.sent.map((m) => m.channel).sort(), ['ntfy', 'webpush']);
  assert.ok(e.sent.every((m) => m.title === 'TS: проверка уведомлений'));

  const del = await e.call(handleOwner, 'DELETE', `/owner/devices/${first.body.id}`, { headers: h });
  assert.deepEqual(del.body, { ok: true });
  assert.equal((await e.call(handleOwner, 'DELETE', `/owner/devices/${first.body.id}`, { headers: h })).status, 404);

  const settings = await e.call(handleOwner, 'GET', '/owner/push', { headers: h });
  assert.deepEqual(settings.body.devices.map((d: { platform: string }) => d.platform), ['ntfy']);

  const rules = await e.call(handleOwner, 'PUT', '/owner/push/rules', { headers: h, body: { rules: [{ kind: 'OTHER', clubId: null, enabled: true }] } });
  assert.equal(rules.status, 200);
  assert.deepEqual(rules.body.rules, [{ kind: 'OTHER', clubId: null, enabled: true }]);

  const pre = await e.call(handleOwner, 'OPTIONS', '/owner/devices', { headers: { origin: 'https://ts.pages.dev' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /apikey/);
  assert.equal(settings.headers.get('access-control-allow-origin'), '*');

  assert.deepEqual(await e.s.db.all('SELECT key, value FROM ts_runtime'), [{ key: 'push_configured', value: '1' }]);
});
