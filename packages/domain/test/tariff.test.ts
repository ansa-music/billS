import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCharge,
  billableSeconds,
  priceAt,
  validateTariff,
  formatMoney,
  canTransition,
  isLive,
} from '../src/index.ts';
import type { TariffConfig } from '../src/index.ts';

const TZ = 'Asia/Almaty'; // UTC+5, no DST

/** Local Almaty wall time → epoch ms. October 2026: 12th is Monday, 16th Friday, 17th Saturday. */
const almaty = (day: number, hour: number, minute = 0, second = 0) =>
  Date.UTC(2026, 9, day, hour - 5, minute, second);

const tariff: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2000_00,
  windows: [
    { label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3000_00 },
    { label: 'Выходные', days: [6, 7], from: '00:00', to: '24:00', pricePerHour: 3500_00 },
  ],
  stepMinutes: 1,
  minimumMinutes: 0,
  freeMinutes: 0,
  roundingMinor: 1,
};

test('one hour at the base rate', () => {
  const r = calculateCharge(almaty(12, 12), almaty(12, 13), tariff, TZ);
  assert.equal(r.playedSeconds, 3600);
  assert.equal(r.billedSeconds, 3600);
  assert.equal(r.amount, 2000_00);
  assert.deepEqual(r.segments.map((s) => s.label), ['Базовый']);
});

test('played time is rounded up to the step', () => {
  const start = almaty(12, 12);
  const end = almaty(12, 13, 1, 1); // 61 min 1 s
  assert.equal(calculateCharge(start, end, tariff, TZ).billedSeconds, 62 * 60);
  assert.equal(calculateCharge(start, end, tariff, TZ).amount, 2066_67);
  const byFive = calculateCharge(start, end, { ...tariff, stepMinutes: 5 }, TZ);
  assert.equal(byFive.billedSeconds, 65 * 60);
  assert.equal(byFive.amount, 2166_67);
});

test('final amount is rounded to the configured step', () => {
  const r = calculateCharge(almaty(12, 12), almaty(12, 13, 1, 1), { ...tariff, roundingMinor: 10_00 }, TZ);
  assert.equal(r.amount, 2070_00);
});

test('minimum billed time', () => {
  const r = calculateCharge(almaty(12, 12), almaty(12, 12, 10), { ...tariff, minimumMinutes: 30 }, TZ);
  assert.equal(r.billedSeconds, 1800);
  assert.equal(r.amount, 1000_00);
});

test('games shorter than free minutes cost nothing', () => {
  const t = { ...tariff, freeMinutes: 3 };
  assert.equal(calculateCharge(almaty(12, 12), almaty(12, 12, 2, 59), t, TZ).amount, 0);
  assert.equal(calculateCharge(almaty(12, 12), almaty(12, 12, 3), t, TZ).billedSeconds, 180);
});

test('zero-length game is free; end before start is an error', () => {
  assert.equal(calculateCharge(almaty(12, 12), almaty(12, 12), tariff, TZ).amount, 0);
  assert.throws(() => calculateCharge(almaty(12, 13), almaty(12, 12), tariff, TZ));
});

test('game across a tariff boundary is split', () => {
  const r = calculateCharge(almaty(12, 17, 30), almaty(12, 18, 30), tariff, TZ);
  assert.equal(r.amount, 1000_00 + 1500_00);
  assert.deepEqual(
    r.segments.map((s) => [s.label, s.to - s.from]),
    [['Базовый', 30 * 60_000], ['Вечер', 30 * 60_000]],
  );
});

test('a window crossing midnight belongs to the day it starts on', () => {
  // Fri 23:00 → Sat 03:00: Friday evening runs until 02:00 Saturday, then weekend rate.
  const r = calculateCharge(almaty(16, 23), almaty(17, 3), tariff, TZ);
  assert.deepEqual(r.segments.map((s) => s.label), ['Вечер', 'Выходные']);
  assert.equal(r.amount, 3 * 3000_00 + 3500_00);
});

test('rounded-up minutes are priced at the rate in force then', () => {
  // 90 s played, billed 5 min: 17:58:30–18:03:30 → 90 s base + 210 s evening.
  const r = calculateCharge(almaty(12, 17, 58, 30), almaty(12, 18, 0), { ...tariff, stepMinutes: 5 }, TZ);
  assert.equal(r.billedSeconds, 300);
  assert.equal(r.amount, 50_00 + 175_00);
});

test('segments follow real time across a DST change', () => {
  // Berlin, 2026-03-29: 02:00 CET jumps to 03:00 CEST. 01:30 → 03:30 local is one real hour.
  const t: TariffConfig = {
    ...tariff,
    windows: [{ label: 'Ночь', days: [7], from: '03:00', to: '04:00', pricePerHour: 3600_00 }],
  };
  const start = Date.UTC(2026, 2, 29, 0, 30);
  const end = Date.UTC(2026, 2, 29, 1, 30);
  const r = calculateCharge(start, end, t, 'Europe/Berlin');
  assert.equal(r.billedSeconds, 3600);
  assert.deepEqual(r.segments.map((s) => [s.label, s.to - s.from]), [['Базовый', 30 * 60_000], ['Ночь', 30 * 60_000]]);
  assert.equal(r.amount, 1000_00 + 1800_00);
});

test('priceAt returns the rate in force', () => {
  assert.deepEqual(priceAt(almaty(12, 12), tariff, TZ), { label: 'Базовый', pricePerHour: 2000_00 });
  assert.deepEqual(priceAt(almaty(17, 1), tariff, TZ), { label: 'Вечер', pricePerHour: 3000_00 });
  assert.deepEqual(priceAt(almaty(17, 2), tariff, TZ), { label: 'Выходные', pricePerHour: 3500_00 });
});

test('billableSeconds ignores non-positive time', () => {
  assert.equal(billableSeconds(0, { ...tariff, minimumMinutes: 30 }), 0);
});

test('validateTariff reports broken configs', () => {
  assert.deepEqual(validateTariff(tariff, TZ), []);
  const broken = validateTariff(
    {
      ...tariff,
      currency: 'tenge',
      stepMinutes: 0,
      windows: [{ label: 'x', days: [8 as 1], from: '25:00', to: '10:61', pricePerHour: -1 }],
    },
    'Mars/Base',
  );
  assert.equal(broken.length, 7);
});

test('formatMoney shows whole amounts without decimals', () => {
  const norm = (s: string) => s.replace(/[\s  ]/g, ' ');
  assert.equal(norm(formatMoney(2500_00, 'KZT')), '2 500 ₸');
  assert.equal(norm(formatMoney(2066_67, 'KZT')), '2 066,67 ₸');
});

test('session status transitions', () => {
  assert.ok(canTransition('OPENING', 'ACTIVE'));
  assert.ok(canTransition('ACTIVE', 'AWAITING_PAYMENT'));
  assert.ok(!canTransition('ACTIVE', 'CANCELLED'));
  assert.ok(!canTransition('CLOSED', 'ACTIVE'));
  assert.ok(isLive('OPENING') && isLive('ACTIVE') && !isLive('AWAITING_PAYMENT'));
});
