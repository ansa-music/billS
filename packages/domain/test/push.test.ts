import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTelegramStartCode,
  loginQrText,
  normalizeBotUsername,
  normalizeCloudUrl,
  parseLoginQr,
  pushKindOfAlert,
  PUSH_KINDS,
  telegramStartLink,
} from '../src/index.ts';

test('login QR: round trip, bare key, junk', () => {
  const qr = loginQrText('https://cloud.ts.kz', 'OWNER-7K3Q-M2PX-9HWD-4RTB');
  assert.equal(qr, 'ts://login?cloud=https%3A%2F%2Fcloud.ts.kz&key=OWNER-7K3Q-M2PX-9HWD-4RTB');
  assert.deepEqual(parseLoginQr(qr), { key: 'OWNER-7K3Q-M2PX-9HWD-4RTB', cloudUrl: 'https://cloud.ts.kz' });
  assert.deepEqual(parseLoginQr(' owner-7k3q-m2px-9hwd-4rtb '), { key: 'owner-7k3q-m2px-9hwd-4rtb', cloudUrl: null });
  assert.equal(parseLoginQr('ts://login?cloud=x'), null);
  assert.equal(parseLoginQr('https://example.com'), null);
  assert.equal(parseLoginQr(''), null);
});

test('cloud address is normalised', () => {
  assert.equal(normalizeCloudUrl('cloud.ts.kz/'), 'https://cloud.ts.kz');
  assert.equal(normalizeCloudUrl('http://192.168.1.10:4320'), 'http://192.168.1.10:4320');
  assert.equal(normalizeCloudUrl('https://ts.kz/cloud/'), 'https://ts.kz/cloud');
  assert.equal(normalizeCloudUrl('ftp://x'), null);
  assert.equal(normalizeCloudUrl('  '), null);
});

test('HUB alert kinds map to push kinds', () => {
  assert.equal(pushKindOfAlert('LIGHT_WITHOUT_GAME'), 'LIGHT_WITHOUT_GAME');
  assert.equal(pushKindOfAlert('LAMP_OFF_FAILED'), 'LAMP_FAILED');
  assert.equal(pushKindOfAlert('SOMETHING_NEW'), 'OTHER');
  assert.equal(new Set(PUSH_KINDS.map((k) => k.kind)).size, PUSH_KINDS.length);
});

test('Telegram: bot username, start code and deep link', () => {
  assert.equal(normalizeBotUsername('@TS_alerts_bot'), 'TS_alerts_bot');
  assert.equal(normalizeBotUsername(' https://t.me/TS_alerts_bot '), 'TS_alerts_bot');
  assert.equal(normalizeBotUsername('ts'), null);
  assert.equal(normalizeBotUsername('1bot'), null);
  assert.equal(normalizeBotUsername(undefined), null);
  assert.ok(isTelegramStartCode('aB3_-x'));
  assert.ok(!isTelegramStartCode(''));
  assert.ok(!isTelegramStartCode('a b'));
  assert.ok(!isTelegramStartCode('x'.repeat(65)));
  assert.equal(telegramStartLink('TS_alerts_bot', 'Ab_9-z'), 'https://t.me/TS_alerts_bot?start=Ab_9-z');
});
