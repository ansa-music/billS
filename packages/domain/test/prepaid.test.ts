import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPrepaidMinutes,
  BillingError,
  isPrepaidEnding,
  PREPAID_WARNING_MS,
  prepaidDeadline,
  prepaidPrice,
  prepaidRemainingMs,
} from '../src/index.ts';
import type { TariffConfig } from '../src/index.ts';

const TZ = 'Asia/Almaty';
/** Local Almaty wall time → epoch ms. October 2026: 12th is Monday. */
const almaty = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 5, minute);
const MIN = 60_000;

const tariff: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2000_00,
  windows: [{ label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3000_00 }],
  stepMinutes: 1,
  minimumMinutes: 30,
  freeMinutes: 3,
  roundingMinor: 10_00,
};

const code = (c: string) => (e: unknown) => e instanceof BillingError && e.code === c;

test('prepaid time is a whole number of minutes within limits', () => {
  for (const ok of [5, 60, 720]) assertPrepaidMinutes(ok);
  for (const bad of [0, 4, 721, 30.5, Number.NaN]) assert.throws(() => assertPrepaidMinutes(bad), code('INVALID_PREPAID_MINUTES'));
});

test('the deadline counts from the lamp-confirmed start', () => {
  const start = almaty(12, 12, 0) + 2_000;
  assert.equal(prepaidDeadline(start, 90), start + 90 * MIN);
  assert.equal(prepaidRemainingMs(start + 89 * MIN, prepaidDeadline(start, 90)), MIN);
  assert.equal(prepaidRemainingMs(start + 120 * MIN, prepaidDeadline(start, 90)), 0);
});

test('the warning window is the last five minutes before the deadline', () => {
  const deadline = almaty(12, 13);
  assert.equal(PREPAID_WARNING_MS, 5 * MIN);
  assert.ok(!isPrepaidEnding(deadline - 5 * MIN - 1, deadline));
  assert.ok(isPrepaidEnding(deadline - 5 * MIN, deadline));
  assert.ok(isPrepaidEnding(deadline - 1, deadline));
  assert.ok(!isPrepaidEnding(deadline, deadline));
});

test('the prepaid price follows the tariff: windows, minimum and rounding', () => {
  assert.equal(prepaidPrice(almaty(12, 12), 60, tariff, TZ), 2000_00);
  // Minimum 30 minutes applies to a shorter prepaid game too.
  assert.equal(prepaidPrice(almaty(12, 12), 15, tariff, TZ), 1000_00);
  // 17:30–18:30 crosses into the evening rate.
  assert.equal(prepaidPrice(almaty(12, 17, 30), 60, tariff, TZ), 1000_00 + 1500_00);
  assert.throws(() => prepaidPrice(almaty(12, 12), 3, tariff, TZ), code('INVALID_PREPAID_MINUTES'));
});
