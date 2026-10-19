import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRevenue } from '../src/index.ts';

const game = (amount: number) => ({ kind: 'GAME' as const, amount });
const bar = (amount: number) => ({ kind: 'ORDER' as const, amount });

test('without a discount time and bar are the sums of their lines', () => {
  assert.deepEqual(splitRevenue([game(2000_00), bar(600_00), bar(600_00)], 0), { time: 2000_00, bar: 1200_00 });
  assert.deepEqual(splitRevenue([], 0), { time: 0, bar: 0 });
  assert.deepEqual(splitRevenue([bar(300_00)], 0), { time: 0, bar: 300_00 });
});

test('a check discount is spread over time and bar in proportion', () => {
  // 10% of 3200 ₸ = 320 ₸: 200 ₸ off the time, 120 ₸ off the bar.
  assert.deepEqual(splitRevenue([game(2000_00), bar(1200_00)], 320_00), { time: 1800_00, bar: 1080_00 });
});

test('the two parts always add up to the check total, whatever the rounding', () => {
  const cases: Array<[number[], number[], number]> = [
    [[1000_00], [333_33], 111_11],
    [[1_00], [2_00], 1_00],
    [[0], [500_00], 500_00],
    [[700_00], [0], 70_00],
    [[1234_56, 10_00], [99_99, 1_01], 345_67],
  ];
  for (const [games, orders, discount] of cases) {
    const lines = [...games.map(game), ...orders.map(bar)];
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const r = splitRevenue(lines, discount);
    assert.equal(r.time + r.bar, subtotal - discount);
    assert.ok(Number.isInteger(r.time) && Number.isInteger(r.bar));
    assert.ok(r.time >= 0 && r.bar >= 0);
  }
});

test('a full discount leaves nothing in either part', () => {
  assert.deepEqual(splitRevenue([game(1000_00), bar(500_00)], 1500_00), { time: 0, bar: 0 });
});
