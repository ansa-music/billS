import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrialStats } from '../src/trial.ts';
import { cleanTrialStats, TRIAL_ENDED_MESSAGE, TRIAL_EXPIRED_MESSAGE, trialStatus, trialTerms, validateTrialStats } from '../src/trial.ts';

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
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 10 }, 5), { status: 'active', endsAt: 10 });
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 10 }, 10), { status: 'expired', endsAt: 10, message: TRIAL_EXPIRED_MESSAGE });
  assert.deepEqual(trialTerms({ status: 'ended', endsAt: 3 }, 5), { status: 'ended', endsAt: 3, message: TRIAL_ENDED_MESSAGE });
  assert.equal(TRIAL_ENDED_MESSAGE, 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.');
});
