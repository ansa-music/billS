import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PushKind } from '@bills/domain';
import type { PushFetch } from '../src/push.ts';
import {
  b64urlDecode,
  b64urlEncode,
  concatBytes,
  encryptWebPush,
  hkdf,
  LEGACY_DEVICE_ERROR,
  p256Jwk,
  pushSenderFromEnv,
  RoutingSender,
  vapidJwt,
  WebPushSender,
} from '../src/push.ts';

// RFC 8291, Appendix A: the worked example.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const subtle = globalThis.crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** The user agent's side of RFC 8291: what a browser does with the push body. */
async function decryptWebPush(body: Uint8Array<ArrayBuffer>, uaPublic: Uint8Array<ArrayBuffer>, uaPrivate: Uint8Array<ArrayBuffer>, auth: Uint8Array<ArrayBuffer>) {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const ua = await subtle.importKey('jwk', p256Jwk(uaPublic, uaPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const as = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: as }, ua, 256));
  const ikm = await hkdf(auth, ecdh, concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  assert.equal(padded[padded.length - 1], 2, 'last record delimiter');
  return new TextDecoder().decode(padded.subarray(0, padded.length - 1));
}

test('RFC 8291 test vector: same bytes as the RFC', async () => {
  const out = await encryptWebPush(
    utf8(RFC.plaintext),
    { p256dh: b64urlDecode(RFC.uaPublic), auth: b64urlDecode(RFC.auth) },
    { salt: b64urlDecode(RFC.salt), serverKeys: { publicKey: b64urlDecode(RFC.asPublic), privateKey: b64urlDecode(RFC.asPrivate) } },
  );
  assert.equal(b64urlEncode(out), RFC.message);
  const back = await decryptWebPush(out, b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.uaPrivate), b64urlDecode(RFC.auth));
  assert.equal(back, RFC.plaintext);
});

async function browserSubscription() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const priv = b64urlDecode(jwk.d!);
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return { pub, priv, auth, endpoint: 'https://push.example.net/wpush/v2/abc123' };
}

async function vapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d!, verifyKey: pair.publicKey };
}

test('round trip: random keys, the browser side decrypts what the sender sends', async () => {
  const sub = await browserSubscription();
  const body = await encryptWebPush(utf8('{"title":"Клуб"}'), { p256dh: sub.pub, auth: sub.auth });
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(body[20], 65);
  assert.equal(await decryptWebPush(body, sub.pub, sub.priv, sub.auth), '{"title":"Клуб"}');
});

test('VAPID JWT is ES256 and verifies with the public key', async () => {
  const keys = await vapidKeys();
  const jwt = await vapidJwt({ ...keys, subject: 'mailto:ops@example.com' }, 'https://push.example.net', 1_800_000_000);
  const [h, c, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h))), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(c))), {
    aud: 'https://push.example.net',
    exp: 1_800_000_000,
    sub: 'mailto:ops@example.com',
  });
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.verifyKey, b64urlDecode(s), utf8(`${h}.${c}`));
  assert.ok(ok);
});

test('WebPushSender: headers, encrypted payload with a deep link, 410 → unregistered', async () => {
  const keys = await vapidKeys();
  const sub = await browserSubscription();
  const token = JSON.stringify({ endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: b64urlEncode(sub.pub), auth: b64urlEncode(sub.auth) } });
  const calls: Array<{ url: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> }> = [];
  let status = 201;
  const fetch: PushFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body as Uint8Array<ArrayBuffer> });
    return { status, text: async () => 'gone' };
  };
  const sender = new WebPushSender(
    { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:ops@example.com' },
    { fetch, now: () => 1_700_000_000_000, cabinetUrl: 'https://ts.example.pages.dev/' },
  );
  const message = { token, platform: 'webpush' as const, title: 'Клуб «Демо»: Свет', body: 'Стол 1', data: { kind: 'LIGHT_WITHOUT_GAME' as PushKind, clubId: 'club-1', alertId: 'a1' } };
  assert.deepEqual(await sender.send(message), { ok: true });
  const call = calls[0]!;
  assert.equal(call.url, sub.endpoint);
  assert.equal(call.headers['content-encoding'], 'aes128gcm');
  assert.equal(call.headers.ttl, '86400');
  assert.match(call.headers.authorization!, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(call.headers.authorization!.split(' ')[1]!.slice(2).split('.')[1]!)));
  assert.equal(claims.aud, 'https://push.example.net');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);
  const payload = JSON.parse(await decryptWebPush(call.body, sub.pub, sub.priv, sub.auth));
  assert.deepEqual(payload, {
    title: 'Клуб «Демо»: Свет',
    body: 'Стол 1',
    data: { kind: 'LIGHT_WITHOUT_GAME', clubId: 'club-1', alertId: 'a1', url: 'https://ts.example.pages.dev/#/clubs/club-1' },
  });

  status = 410;
  const gone = await sender.send(message);
  assert.equal(gone.ok, false);
  assert.equal(!gone.ok && gone.unregistered, true);
  status = 404;
  const notFound = await sender.send(message);
  assert.equal(!notFound.ok && notFound.unregistered, true);
  status = 500;
  const flaky = await sender.send(message);
  assert.equal(!flaky.ok && flaky.unregistered, false);

  const broken = await sender.send({ ...message, token: '{"endpoint":"http://insecure"}' });
  assert.equal(!broken.ok && broken.unregistered, true);
  assert.equal(calls.length, 4);
});

test('WebPushSender rejects bad VAPID keys up front', () => {
  assert.throws(() => new WebPushSender({ publicKey: 'abc', privateKey: 'def', subject: 'mailto:x@y.z' }), /VAPID_PUBLIC_KEY/);
});

test('RoutingSender: platform picks the channel, a missing channel and old FCM phones are skipped', async () => {
  const seen: string[] = [];
  const fake = (name: string) => ({
    enabled: true,
    async send() {
      seen.push(name);
      return { ok: true as const };
    },
  });
  const log: string[] = [];
  const router = new RoutingSender({ webpush: fake('webpush'), ntfy: fake('ntfy') }, (m) => log.push(m));
  assert.equal(router.enabled, true);
  assert.deepEqual(router.channels, ['webpush', 'ntfy']);
  const base = { token: 't', title: 'T', body: 'B', data: { kind: 'OTHER' as PushKind, clubId: 'c' } };
  assert.deepEqual(await router.send({ ...base, platform: 'webpush' }), { ok: true });
  assert.deepEqual(await router.send({ ...base, platform: 'ntfy' }), { ok: true });
  // Rows from the FCM days ('android', 'ios', 'web') stay in the database: kept, explained, not sent.
  for (const platform of ['android', 'ios', 'web'] as const) {
    assert.deepEqual(await router.send({ ...base, platform }), { ok: false, error: LEGACY_DEVICE_ERROR, unregistered: false });
  }
  assert.deepEqual(seen, ['webpush', 'ntfy']);
  assert.equal(log.length, 3);
  const noNtfy = new RoutingSender({ webpush: fake('webpush') });
  const skipped = await noNtfy.send({ ...base, platform: 'ntfy' });
  assert.equal(!skipped.ok && skipped.error.startsWith('PUSH_DISABLED'), true);
  assert.equal(new RoutingSender({}).enabled, false);
});

test('pushSenderFromEnv: ntfy unless NTFY_DISABLED=1, Web Push with VAPID keys, FCM settings ignored', async () => {
  const keys = await vapidKeys();
  assert.deepEqual(pushSenderFromEnv({}).channels, ['ntfy']);
  assert.deepEqual(pushSenderFromEnv({ CLOUD_FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}' }).channels, ['ntfy']);
  const both = pushSenderFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, TS_CABINET_URL: 'https://ts.example.pages.dev' });
  assert.deepEqual(both.channels, ['webpush', 'ntfy']);
  const log: string[] = [];
  const off = pushSenderFromEnv({ NTFY_DISABLED: '1', VAPID_PUBLIC_KEY: 'bad', VAPID_PRIVATE_KEY: 'bad' }, (m) => log.push(m));
  assert.equal(off.enabled, false);
  assert.match(log.join('\n'), /Web Push выключен/);
});
