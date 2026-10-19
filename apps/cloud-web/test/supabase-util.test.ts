import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_NTFY_SERVER,
  authErrorFromHash,
  base64UrlToBytes,
  describeAuthError,
  edgeUrl,
  isIos,
  isVapidPublicKey,
  magicLinkRedirect,
  mapRpcError,
  normalizeNtfyServer,
  ntfyLinks,
  ntfyTopicName,
  ntfyTopicUrl,
} from '../src/supabase-util.ts';

test('mapRpcError: network failure and gateways are offline', () => {
  for (const status of [0, 502, 503, 504]) {
    const m = mapRpcError({ message: 'TypeError: Failed to fetch' }, status);
    assert.equal(m.code, 'OFFLINE');
    assert.equal(m.offline, true);
    assert.equal(m.unauthorized, false);
  }
});

test('mapRpcError: P0002 is 404 CLUB_NOT_FOUND', () => {
  const m = mapRpcError({ code: 'P0002', message: 'CLUB_NOT_FOUND' }, 404);
  assert.deepEqual([m.status, m.code, m.offline], [404, 'CLUB_NOT_FOUND', false]);
  assert.equal(mapRpcError({ code: 'P0002', message: 'no rows' }, 400).code, 'CLUB_NOT_FOUND');
});

test('mapRpcError: expired JWT and 401 are unauthorized', () => {
  assert.equal(mapRpcError({ code: 'PGRST303', message: 'JWT expired' }, 401).unauthorized, true);
  assert.equal(mapRpcError({ code: 'PGRST301', message: 'bad jwt' }, 400).status, 401);
  assert.equal(mapRpcError({ code: '42501', message: 'permission denied' }, 403).code, 'FORBIDDEN');
});

test('mapRpcError: a raised domain code is kept, anything else is HTTP_ERROR', () => {
  const coded = mapRpcError({ code: 'P0001', message: 'INVALID_RULES' }, 400);
  assert.deepEqual([coded.status, coded.code], [400, 'INVALID_RULES']);
  const other = mapRpcError({ code: 'XX000', message: 'boom' }, 500);
  assert.deepEqual([other.status, other.code, other.message], [500, 'HTTP_ERROR', 'boom']);
});

test('describeAuthError', () => {
  assert.equal(describeAuthError({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' }).message, 'Неверный e-mail или пароль');
  assert.equal(describeAuthError({ status: 0, name: 'AuthRetryableFetchError', message: 'Failed to fetch' }).offline, true);
  assert.equal(describeAuthError({ status: 429, code: 'over_email_send_rate_limit' }).code, 'RATE_LIMIT');
  assert.equal(describeAuthError({ status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' }).code, 'NOT_OWNER');
});

test('edgeUrl builds the owner function path', () => {
  assert.equal(
    edgeUrl('https://abc.supabase.co/', '/owner/clubs/c%201/tariffs'),
    'https://abc.supabase.co/functions/v1/owner/owner/clubs/c%201/tariffs',
  );
  assert.equal(edgeUrl('https://abc.supabase.co', 'owner/push/test'), 'https://abc.supabase.co/functions/v1/owner/owner/push/test');
});

test('magicLinkRedirect keeps the base path and drops query and hash', () => {
  assert.equal(magicLinkRedirect('/billS/cabinet/', 'https://x.github.io/billS/cabinet/?a=1#/phone'), 'https://x.github.io/billS/cabinet/');
  assert.equal(magicLinkRedirect('/', 'https://ts.pages.dev/#/clubs/1'), 'https://ts.pages.dev/');
  assert.equal(magicLinkRedirect('./', 'https://x.github.io/billS/cabinet/index.html#/'), 'https://x.github.io/billS/cabinet/');
});

test('authErrorFromHash', () => {
  assert.equal(authErrorFromHash('#/clubs/1'), null);
  assert.equal(authErrorFromHash('#access_token=abc&type=magiclink'), null);
  assert.match(authErrorFromHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid') ?? '', /устарела/);
  assert.match(authErrorFromHash('#error=server_error&error_description=Database+error') ?? '', /Database error/);
});

test('ntfyTopicName: ts- + 24 base32 chars', () => {
  const bytes = new Uint8Array(24).map((_, i) => i * 11);
  const name = ntfyTopicName(bytes);
  assert.match(name, /^ts-[a-z2-7]{24}$/);
  assert.throws(() => ntfyTopicName(new Uint8Array(10)));
});

test('normalizeNtfyServer', () => {
  assert.equal(normalizeNtfyServer(''), DEFAULT_NTFY_SERVER);
  assert.equal(normalizeNtfyServer('ntfy.example.kz/'), 'https://ntfy.example.kz');
  assert.equal(normalizeNtfyServer('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
  assert.equal(normalizeNtfyServer('ftp://x'), null);
});

test('ntfyLinks: https and ntfy:// deep link', () => {
  const url = ntfyTopicUrl('https://ntfy.sh', 'ts-abcdefghijklmnopqrstuvwx');
  const l = ntfyLinks(url);
  assert.ok(l);
  assert.equal(l.https, 'https://ntfy.sh/ts-abcdefghijklmnopqrstuvwx');
  assert.equal(l.deepLink, 'ntfy://ntfy.sh/ts-abcdefghijklmnopqrstuvwx');
  assert.equal(l.server, 'https://ntfy.sh');
  const plain = ntfyLinks('http://10.0.0.5:8080/ts-x');
  assert.equal(plain?.deepLink, 'ntfy://10.0.0.5:8080/ts-x?secure=false');
  assert.equal(ntfyLinks('https://ntfy.sh/'), null);
  assert.equal(ntfyLinks('not a url'), null);
});

test('VAPID key decoding', () => {
  const raw = new Uint8Array(65);
  raw[0] = 4;
  for (let i = 1; i < 65; i++) raw[i] = i;
  const b64url = Buffer.from(raw).toString('base64url');
  assert.deepEqual([...base64UrlToBytes(b64url)], [...raw]);
  assert.equal(isVapidPublicKey(b64url), true);
  assert.equal(isVapidPublicKey('abc'), false);
  assert.equal(isVapidPublicKey(undefined), false);
});

test('isIos', () => {
  assert.equal(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5), true);
  assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), true);
  assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), false);
  assert.equal(isIos('Mozilla/5.0 (Linux; Android 14)', 5), false);
});
