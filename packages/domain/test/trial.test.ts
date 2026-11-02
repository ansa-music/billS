import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrialStats, TrialSummary } from '../src/trial.ts';
import {
  cleanTrialStats,
  cleanTrialSummary,
  formatTransferCode,
  normalizeTransferCode,
  PAID_ENDED_MESSAGE,
  TRIAL_ENDED_MESSAGE,
  TRIAL_EXPIRED_MESSAGE,
  trialStatus,
  trialTerms,
  validateTrialStats,
  validateTrialSummary,
} from '../src/trial.ts';

const STATS: TrialStats = {
  ordersTotal: 12,
  ordersToday: 3,
  revenueTotal: 45_600,
  revenueToday: 9_800.5,
  productsCount: 18,
  staffCount: 2,
  shiftOpen: true,
  lastOrderAt: 1_760_270_400_000,
  days: [
    { day: '2026-10-28', orders: 9, revenue: 35_800 },
    { day: '2026-10-29', orders: 3, revenue: 9_800.5 },
  ],
  appVersion: '1.4.0',
};

test('validateTrialStats: a full report is fine, with or without appVersion and lastOrderAt', () => {
  assert.deepEqual(validateTrialStats(STATS), []);
  const { appVersion: _v, ...noVersion } = STATS;
  assert.deepEqual(validateTrialStats({ ...noVersion, lastOrderAt: null, days: [] }), []);
});

test('validateTrialStats: names every broken field', () => {
  assert.deepEqual(validateTrialStats(null), ['stats: нужен объект']);
  assert.deepEqual(validateTrialStats([]), ['stats: нужен объект']);
  const problems = validateTrialStats({
    ...STATS,
    ordersTotal: -1,
    ordersToday: 1.5,
    revenueTotal: Number.NaN,
    revenueToday: '10',
    productsCount: undefined,
    shiftOpen: 1,
    lastOrderAt: 'вчера',
    appVersion: 'x'.repeat(41),
  });
  for (const field of ['ordersTotal', 'ordersToday', 'revenueTotal', 'revenueToday', 'productsCount', 'shiftOpen', 'lastOrderAt', 'appVersion']) {
    assert.ok(problems.some((p) => p.startsWith(`stats.${field}`)), field);
  }
  assert.ok(!problems.some((p) => p.startsWith('stats.staffCount')));
  const days = validateTrialStats({ ...STATS, days: [{ day: '29.10.2026', orders: 1, revenue: 1 }, { day: '2026-10-29', orders: -2, revenue: Infinity }, 5] });
  assert.deepEqual(days, [
    'stats.days[0].day: дата YYYY-MM-DD',
    'stats.days[1].orders: целое число ≥ 0',
    'stats.days[1].revenue: число',
    'stats.days[2]: нужен объект',
  ]);
  assert.deepEqual(validateTrialStats({ ...STATS, days: 'all' }), ['stats.days: нужен список']);
  assert.equal(validateTrialStats({ ...STATS, days: Array.from({ length: 401 }, () => STATS.days[0]) }).length, 1);
});

test('cleanTrialStats drops unknown fields', () => {
  const dirty = { ...STATS, secret: 'x', days: [{ ...STATS.days[0]!, extra: 1 }] } as unknown as TrialStats;
  const clean = cleanTrialStats(dirty);
  assert.equal('secret' in clean, false);
  assert.deepEqual(clean.days, [STATS.days[0]]);
  assert.deepEqual(cleanTrialStats(STATS), STATS);
});

test('trialStatus: active until endsAt, then expired; ended stays ended', () => {
  const endsAt = 1_000_000;
  assert.equal(trialStatus({ status: 'active', endsAt }, endsAt - 1), 'active');
  assert.equal(trialStatus({ status: 'active', endsAt }, endsAt), 'expired');
  assert.equal(trialStatus({ status: 'active', endsAt }, endsAt + 1), 'expired');
  assert.equal(trialStatus({ status: 'ended', endsAt }, endsAt - 1), 'ended');
  assert.equal(trialStatus({ status: 'ended', endsAt }, endsAt + 1), 'ended');
});

test('trialTerms: a message only when the trial is over', () => {
  const plain = { plan: 'trial', paidUntil: null, snapshotAt: null } as const;
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 10 }, 5), { status: 'active', endsAt: 10, ...plain });
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 10 }, 10), { status: 'expired', endsAt: 10, message: TRIAL_EXPIRED_MESSAGE, ...plain });
  assert.deepEqual(trialTerms({ status: 'ended', endsAt: 3 }, 5), { status: 'ended', endsAt: 3, message: TRIAL_ENDED_MESSAGE, ...plain });
  assert.equal(TRIAL_ENDED_MESSAGE, 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.');
});

test('trialTerms: a paid plan carries paidUntil and the paid words when it is over', () => {
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 100, plan: 'paid', paidUntil: 100, snapshotAt: 7 }, 50), {
    status: 'active',
    endsAt: 100,
    plan: 'paid',
    paidUntil: 100,
    snapshotAt: 7,
  });
  assert.equal(trialTerms({ status: 'active', endsAt: 100, plan: 'paid', paidUntil: 100 }, 100).message, PAID_ENDED_MESSAGE);
  assert.equal(trialTerms({ status: 'ended', endsAt: 100, plan: 'paid', paidUntil: null }, 50).message, PAID_ENDED_MESSAGE);
  // A trial row never shows a paid date.
  assert.equal(trialTerms({ status: 'active', endsAt: 100, plan: 'trial', paidUntil: 90 }, 50).paidUntil, null);
});

test('transfer codes: typed loosely, shown grouped; letters that look alike are not in the alphabet', () => {
  assert.equal(normalizeTransferCode('7k3m-q9tx'), '7K3MQ9TX');
  assert.equal(normalizeTransferCode(' 7K3M Q9TX '), '7K3MQ9TX');
  assert.equal(normalizeTransferCode('7K3M—Q9TX'), '7K3MQ9TX');
  assert.equal(normalizeTransferCode('7K3MQ9T'), null);
  assert.equal(normalizeTransferCode('7K3MQ9T0'), null, 'zero is not used');
  assert.equal(normalizeTransferCode('IIIIOOOO'), null);
  assert.equal(formatTransferCode('7K3MQ9TX'), '7K3M-Q9TX');
});

const SUMMARY: TrialSummary = {
  at: 1,
  currency: 'KZT',
  timezone: 'Asia/Almaty',
  date: '2026-10-29',
  revenueToday: 100,
  revenue7: 700,
  revenue30: 3000,
  checksToday: 2,
  avgCheckToday: 50,
  topToday: [{ name: 'Латте', qty: 2, revenue: 100 }],
  methodsToday: { cash: 0, card: 100, qr: 0 },
  shiftOpen: false,
  lastActivityAt: null,
  days: [{ day: '2026-10-29', revenue: 100 }],
};

test('validateTrialSummary / cleanTrialSummary', () => {
  assert.deepEqual(validateTrialSummary(SUMMARY), []);
  assert.deepEqual(validateTrialSummary(null), ['summary: нужен объект']);
  const bad = validateTrialSummary({ ...SUMMARY, checksToday: -1, date: 'x', topToday: 'no', methodsToday: { cash: 1 } });
  assert.equal(bad.length, 4, bad.join('; '));
  assert.ok(validateTrialSummary({ ...SUMMARY, topToday: new Array(6).fill(SUMMARY.topToday[0]) }).length > 0);
  assert.deepEqual(cleanTrialSummary({ ...SUMMARY, extra: 1, topToday: [{ name: 'Латте', qty: 2, revenue: 100, x: 1 }] } as unknown as TrialSummary), SUMMARY);
});
