import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelsAboveNormal,
  cashDiscrepancyAlert,
  DEFAULT_GUARD_SETTINGS,
  discountTooLarge,
  GUARD_ALERT_KINDS,
  isTelegramStartCode,
  normalizeGuardSettings,
  pushRuleAllows,
  refundReasons,
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

test('«Сторож»: every guard alert kind is a push kind, on by default and marked', () => {
  for (const kind of GUARD_ALERT_KINDS) {
    assert.equal(pushKindOfAlert(kind), kind);
    const info = PUSH_KINDS.find((k) => k.kind === kind);
    assert.ok(info, kind);
    assert.equal(info.guard, true);
    assert.equal(info.defaultOn, true);
    assert.equal(pushRuleAllows([], kind, 'club-1'), true);
  }
  assert.equal(PUSH_KINDS.filter((k) => k.guard).length, GUARD_ALERT_KINDS.length);
});

test('«Сторож»: settings are normalised, bad values fall back', () => {
  assert.deepEqual(normalizeGuardSettings(undefined), DEFAULT_GUARD_SETTINGS);
  assert.deepEqual(normalizeGuardSettings('junk'), DEFAULT_GUARD_SETTINGS);
  const s = normalizeGuardSettings({ refund: { minAmount: 1000_00, minPercent: 0, lateMinutes: 1.5 }, cancels: { enabled: false }, reopen: { minutes: 61 } });
  assert.equal(s.refund.minAmount, 1000_00);
  assert.equal(s.refund.minPercent, DEFAULT_GUARD_SETTINGS.refund.minPercent);
  assert.equal(s.refund.lateMinutes, DEFAULT_GUARD_SETTINGS.refund.lateMinutes);
  assert.equal(s.cancels.enabled, false);
  assert.equal(s.reopen.minutes, DEFAULT_GUARD_SETTINGS.reopen.minutes);
  // Defaults: 5 000 ₸ / 30 % / 30 min; 3 and 10 %; 1 000 ₸; 15 min; 30 % and 3; 2 min.
  assert.deepEqual(DEFAULT_GUARD_SETTINGS, {
    refund: { enabled: true, minAmount: 500_000, minPercent: 30, lateMinutes: 30 },
    cancels: { enabled: true, minCount: 3, minPercent: 10 },
    cash: { enabled: true, minDifference: 100_000 },
    manualMode: { enabled: true, minutes: 15 },
    discounts: { enabled: true, maxPercent: 30, perShift: 3 },
    reopen: { enabled: true, minutes: 2 },
  });
});

test('«Сторож»: refund, cancellation, cash and discount rules — trigger and stay quiet below the threshold', () => {
  const r = DEFAULT_GUARD_SETTINGS.refund;
  const at = 1_000_000_000;
  assert.deepEqual(refundReasons(r, { amount: 1000_00, paid: 10000_00, paidAt: at, at }), []);
  assert.deepEqual(refundReasons(r, { amount: 3000_00, paid: 10000_00, paidAt: at, at }), ['share']);
  assert.deepEqual(refundReasons(r, { amount: 5000_00, paid: 50000_00, paidAt: at, at }), ['amount']);
  assert.deepEqual(refundReasons(r, { amount: 100_00, paid: 10000_00, paidAt: at, at: at + 30 * 60_000 }), []);
  assert.deepEqual(refundReasons(r, { amount: 100_00, paid: 10000_00, paidAt: at, at: at + 31 * 60_000 }), ['late']);
  assert.deepEqual(refundReasons({ ...r, enabled: false }, { amount: 9000_00, paid: 9000_00, paidAt: at, at }), []);

  const c = DEFAULT_GUARD_SETTINGS.cancels;
  assert.equal(cancelsAboveNormal(c, { cancelled: 2, created: 2 }), false);
  assert.equal(cancelsAboveNormal(c, { cancelled: 3, created: 3 }), true);
  assert.equal(cancelsAboveNormal(c, { cancelled: 3, created: 31 }), false);
  assert.equal(cancelsAboveNormal(c, { cancelled: 3, created: 30 }), true);
  assert.equal(cancelsAboveNormal(c, { cancelled: 3, created: 0 }), true, 'cancelling other people’s orders');
  assert.equal(cancelsAboveNormal({ ...c, enabled: false }, { cancelled: 9, created: 9 }), false);

  const m = DEFAULT_GUARD_SETTINGS.cash;
  assert.equal(cashDiscrepancyAlert(m, -999_00), false);
  assert.equal(cashDiscrepancyAlert(m, -1000_00), true);
  assert.equal(cashDiscrepancyAlert(m, 1500_00), true);
  assert.equal(cashDiscrepancyAlert(m, null), false);
  assert.equal(cashDiscrepancyAlert({ enabled: true, minDifference: 0 }, 0), false, 'no difference, no alert');

  const d = DEFAULT_GUARD_SETTINGS.discounts;
  assert.equal(discountTooLarge(d, { amount: 290_00, subtotal: 1000_00 }), false);
  assert.equal(discountTooLarge(d, { amount: 300_00, subtotal: 1000_00 }), true);
  assert.equal(discountTooLarge(d, { amount: 300_00, subtotal: 0 }), false);
});
