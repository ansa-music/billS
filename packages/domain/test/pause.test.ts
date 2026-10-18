import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCharge,
  calculateChargeWithPauses,
  canTransition,
  isLive,
  pauseLimits,
  pauseRefusal,
  pauseUsage,
  unpaidSpans,
  validateTariff,
} from '../src/index.ts';
import type { PauseSpan, TariffConfig } from '../src/index.ts';

const TZ = 'Asia/Almaty'; // UTC+5, no DST
const MIN = 60_000;

/** Local Almaty wall time → epoch ms. October 2026: 12th is Monday. */
const almaty = (day: number, hour: number, minute = 0, second = 0) =>
  Date.UTC(2026, 9, day, hour - 5, minute, second);

const tariff: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2000_00,
  windows: [{ label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3000_00 }],
  stepMinutes: 1,
  minimumMinutes: 0,
  freeMinutes: 0,
  roundingMinor: 1,
};

test('a pause is not billed: one hour of play with 20 minutes paused costs one hour', () => {
  const start = almaty(12, 12);
  const r = calculateChargeWithPauses(
    start,
    start + 80 * MIN,
    [{ from: start + 30 * MIN, to: start + 50 * MIN }],
    tariff,
    TZ,
  );
  assert.equal(r.playedSeconds, 3600);
  assert.equal(r.pausedSeconds, 1200);
  assert.equal(r.billedSeconds, 3600);
  assert.equal(r.amount, 2000_00);
  assert.deepEqual(
    r.segments.map((s) => [s.from, s.to]),
    [
      [start, start + 30 * MIN],
      [start + 50 * MIN, start + 80 * MIN],
    ],
  );
});

test('without pauses the result equals calculateCharge', () => {
  const start = almaty(12, 17, 30);
  const end = almaty(12, 18, 30);
  const plain = calculateCharge(start, end, tariff, TZ);
  const withPauses = calculateChargeWithPauses(start, end, [], tariff, TZ);
  assert.deepEqual({ ...withPauses, pausedSeconds: undefined }, { ...plain, pausedSeconds: undefined });
  assert.equal(withPauses.pausedSeconds, 0);
});

test('a tariff boundary inside a pause changes the rate for what follows', () => {
  // 17:00–17:30 base, paused 17:30–18:30 across 18:00, then 18:30–19:00 at the evening rate.
  const r = calculateChargeWithPauses(
    almaty(12, 17),
    almaty(12, 19),
    [{ from: almaty(12, 17, 30), to: almaty(12, 18, 30) }],
    tariff,
    TZ,
  );
  assert.equal(r.playedSeconds, 3600);
  assert.equal(r.amount, 1000_00 + 1500_00);
  assert.deepEqual(
    r.segments.map((s) => s.label),
    ['Базовый', 'Вечер'],
  );
});

test('free minutes, minimum and step apply to the total played time, not to each stretch', () => {
  const t = { ...tariff, freeMinutes: 3, minimumMinutes: 30, stepMinutes: 5 };
  const start = almaty(12, 12);
  // Two stretches of 2 minutes each: 4 minutes played — past the free minutes, billed the 30-minute minimum.
  const short = calculateChargeWithPauses(
    start,
    start + 14 * MIN,
    [{ from: start + 2 * MIN, to: start + 12 * MIN }],
    t,
    TZ,
  );
  assert.equal(short.playedSeconds, 240);
  assert.equal(short.billedSeconds, 1800);
  assert.equal(short.amount, 1000_00);

  // 2 + 1 minutes = 3 minutes: exactly the free limit — billed (same rule as calculateCharge).
  assert.equal(
    calculateChargeWithPauses(start, start + 13 * MIN, [{ from: start + 2 * MIN, to: start + 12 * MIN }], t, TZ)
      .billedSeconds,
    1800,
  );
  // 1 + 1 minute = 2 minutes: within the free minutes — nothing to pay.
  assert.equal(
    calculateChargeWithPauses(start, start + 12 * MIN, [{ from: start + MIN, to: start + 11 * MIN }], t, TZ).amount,
    0,
  );

  // 31 + 2 minutes = 33 played → 35 billed by the 5-minute step, as one game.
  const stepped = calculateChargeWithPauses(
    start,
    start + 43 * MIN,
    [{ from: start + 31 * MIN, to: start + 41 * MIN }],
    { ...tariff, stepMinutes: 5 },
    TZ,
  );
  assert.equal(stepped.billedSeconds, 35 * 60);
});

test('rounded-up minutes are priced at the rate in force after the end', () => {
  // 17:00–17:30 played, paused 17:30–17:58:30, played 17:58:30–17:59:30: 31 min. Step 5 min → 35 min billed;
  // the extra 4 min run from 17:59:30 across 18:00: 30 s base + 210 s evening.
  const r = calculateChargeWithPauses(
    almaty(12, 17),
    almaty(12, 17, 59, 30),
    [{ from: almaty(12, 17, 30), to: almaty(12, 17, 58, 30) }],
    { ...tariff, stepMinutes: 5 },
    TZ,
  );
  assert.equal(r.playedSeconds, 31 * 60);
  assert.equal(r.billedSeconds, 35 * 60);
  assert.equal(r.amount, Math.round((1890 * 2000_00 + 210 * 3000_00) / 3600));
  assert.deepEqual(
    r.segments.map((s) => [s.label, (s.to - s.from) / 1000]),
    [
      ['Базовый', 1800],
      ['Базовый', 90],
      ['Вечер', 210],
    ],
  );
});

test('an open pause runs until the end: the amount does not grow while paused', () => {
  const start = almaty(12, 12);
  const pauses: PauseSpan[] = [{ from: start + 30 * MIN, to: null, reason: 'pause' }];
  const at40 = calculateChargeWithPauses(start, start + 40 * MIN, unpaidSpans(pauses, tariff, start + 40 * MIN), tariff, TZ);
  const at50 = calculateChargeWithPauses(start, start + 50 * MIN, unpaidSpans(pauses, tariff, start + 50 * MIN), tariff, TZ);
  assert.equal(at40.amount, 1000_00);
  assert.equal(at50.amount, 1000_00);
  assert.equal(at50.pausedSeconds, 20 * 60);
});

test('broken pause lists are rejected', () => {
  const start = almaty(12, 12);
  const end = start + 60 * MIN;
  assert.throws(() => calculateChargeWithPauses(start, end, [{ from: start - MIN, to: start + MIN }], tariff, TZ));
  assert.throws(() => calculateChargeWithPauses(start, end, [{ from: start + 50 * MIN, to: end + MIN }], tariff, TZ));
  assert.throws(() =>
    calculateChargeWithPauses(
      start,
      end,
      [
        { from: start + 10 * MIN, to: start + 30 * MIN },
        { from: start + 20 * MIN, to: start + 40 * MIN },
      ],
      tariff,
      TZ,
    ),
  );
  assert.throws(() => calculateChargeWithPauses(start, end, [{ from: start + 30 * MIN, to: start + 20 * MIN }], tariff, TZ));
});

test('pause limits default to 3 pauses / 30 minutes / lamp off', () => {
  assert.deepEqual(pauseLimits(tariff), { maxPauses: 3, maxPauseMinutes: 30, lamp: 'off' });
  assert.deepEqual(pauseLimits({ ...tariff, maxPauses: 1, maxPauseMinutes: 10, pauseLamp: 'blink' }), {
    maxPauses: 1,
    maxPauseMinutes: 10,
    lamp: 'blink',
  });
  assert.deepEqual(validateTariff({ ...tariff, maxPauses: -1, maxPauseMinutes: 1.5, pauseLamp: 'x' as 'off' }), [
    'maxPauses must be a non-negative integer',
    'maxPauseMinutes must be a non-negative integer',
    "pauseLamp must be 'off' or 'blink'",
  ]);
});

test('pauseRefusal enforces the count and the total time; transfers do not count', () => {
  const start = almaty(12, 12);
  const three: PauseSpan[] = [0, 1, 2].map((i) => ({
    from: start + i * 10 * MIN,
    to: start + i * 10 * MIN + MIN,
    reason: 'pause',
  }));
  assert.equal(pauseRefusal(three.slice(0, 2), tariff, start + 60 * MIN), null);
  assert.match(pauseRefusal(three, tariff, start + 60 * MIN) ?? '', /не больше 3/);
  assert.equal(
    pauseRefusal([...three, { from: start, to: start + MIN, reason: 'transfer' }], { ...tariff, maxPauses: 4 }, start + 60 * MIN),
    null,
  );
  const long: PauseSpan[] = [{ from: start, to: start + 30 * MIN, reason: 'pause' }];
  assert.match(pauseRefusal(long, tariff, start + 60 * MIN) ?? '', /не больше 30 мин/);
  assert.deepEqual(pauseUsage([...three, { from: start + 50 * MIN, to: null, reason: 'transfer' }], start + 60 * MIN), {
    count: 3,
    seconds: 180,
  });
});

test('unpaidSpans caps staff pauses at the tariff budget and never caps transfers', () => {
  const start = almaty(12, 12);
  const t = { ...tariff, maxPauseMinutes: 10 };
  const pauses: PauseSpan[] = [
    { from: start + 5 * MIN, to: start + 12 * MIN, reason: 'pause' }, // 7 min
    { from: start + 20 * MIN, to: start + 21 * MIN, reason: 'transfer' }, // 1 min, free
    { from: start + 30 * MIN, to: null, reason: 'pause' }, // open: only 3 min of budget left
  ];
  const end = start + 60 * MIN;
  assert.deepEqual(unpaidSpans(pauses, t, end), [
    { from: start + 5 * MIN, to: start + 12 * MIN },
    { from: start + 20 * MIN, to: start + 21 * MIN },
    { from: start + 30 * MIN, to: start + 33 * MIN },
  ]);
  // The game went on being billed from 12:33: 60 − 7 − 1 − 3 = 49 minutes.
  const r = calculateChargeWithPauses(start, end, unpaidSpans(pauses, t, end), t, TZ);
  assert.equal(r.playedSeconds, 49 * 60);
  assert.equal(r.pausedSeconds, 11 * 60);
  // A pause ending after `end` is cut at `end`.
  assert.deepEqual(unpaidSpans([{ from: start, to: end + MIN, reason: 'transfer' }], t, end), [{ from: start, to: end }]);
});

test('PAUSED is a live status between ACTIVE and ACTIVE or stop', () => {
  assert.ok(canTransition('ACTIVE', 'PAUSED'));
  assert.ok(canTransition('PAUSED', 'ACTIVE'));
  assert.ok(canTransition('PAUSED', 'AWAITING_PAYMENT'));
  assert.ok(!canTransition('OPENING', 'PAUSED'));
  assert.ok(!canTransition('PAUSED', 'CANCELLED'));
  assert.ok(isLive('PAUSED'));
});

test('a power-loss pause is never billed and does not spend the staff pause budget', () => {
  const limited: TariffConfig = { ...tariff, maxPauses: 1, maxPauseMinutes: 10 };
  const start = Date.UTC(2026, 9, 12, 7, 0);
  const pauses = [
    { from: start + 20 * MIN, to: start + 50 * MIN, reason: 'power' as const },
    { from: start + 60 * MIN, to: start + 65 * MIN, reason: 'pause' as const },
  ];
  assert.deepEqual(unpaidSpans(pauses, limited, start + 90 * MIN), [
    { from: start + 20 * MIN, to: start + 50 * MIN },
    { from: start + 60 * MIN, to: start + 65 * MIN },
  ]);
  assert.deepEqual(pauseUsage(pauses, start + 90 * MIN), { count: 1, seconds: 5 * 60 });
  assert.equal(pauseRefusal(pauses, limited, start + 90 * MIN), 'Лимит пауз исчерпан: по тарифу не больше 1 за игру');
});
