import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastStock, purchaseList, runsOutToday } from '../src/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ALMATY = 5 * HOUR;

function almaty(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - ALMATY;
}

/** Monday 2026-10-26, 12:00 in Almaty. */
const NOW = almaty(2026, 10, 26, 12);

/** Two croissants an hour from 08:00 to 20:00, every day of the last `days`. */
function steady(productId: string, days: number, perHour = 2, from = 8, to = 20) {
  const out: Array<{ productId: string; at: number; qty: number }> = [];
  // Exactly `days` × 24 hours back from now: today's morning makes up for the cut first day.
  for (let n = 0; n <= days; n++) {
    for (let h = from; h < to; h++) {
      const at = almaty(2026, 10, 26 - n, h, 20);
      if (at > NOW - days * DAY && at <= NOW) out.push({ productId, at, qty: perHour });
    }
  }
  return out;
}

const base = { now: NOW, timezone: 'Asia/Almaty', historyDays: 14 };

test('runs out today: 10 left at noon, 2 an hour → about 17:00', () => {
  const [item] = forecastStock({ ...base, products: [{ id: 'c', name: 'Круассан', stock: 10 }], sales: steady('c', 14) });
  assert.ok(item);
  assert.equal(item.runsOutAt, almaty(2026, 10, 26, 17));
  assert.equal(item.daysLeft, null);
  assert.equal(item.perDay, 24);
  // 24 a day × 7 − 10 = 158.
  assert.equal(item.buyForWeek, 158);
});

test('lasts past today: 100 left → enough for 4 days, buy 68 for a week', () => {
  const [item] = forecastStock({ ...base, products: [{ id: 'c', name: 'Круассан', stock: 100 }], sales: steady('c', 14) });
  assert.ok(item);
  assert.equal(item.runsOutAt, null);
  assert.equal(item.daysLeft, 4);
  assert.equal(item.buyForWeek, 68);
});

test('plenty in stock: nothing to buy', () => {
  const [item] = forecastStock({ ...base, products: [{ id: 'c', name: 'Круассан', stock: 500 }], sales: steady('c', 14) });
  assert.equal(item?.buyForWeek, 0);
  assert.equal(item?.daysLeft, 20);
});

test('a new venue divides by the days it has, not by 14', () => {
  const [item] = forecastStock({ ...base, historyDays: 5, products: [{ id: 'c', name: 'Круассан', stock: 100 }], sales: steady('c', 5) });
  assert.equal(item?.perDay, 24);
  assert.equal(item?.daysLeft, 4);
});

test('too little history, or nothing sold: no forecast', () => {
  const [a] = forecastStock({ ...base, historyDays: 2, products: [{ id: 'c', name: 'Круассан', stock: 10 }], sales: steady('c', 2) });
  assert.deepEqual(a, { productId: 'c', name: 'Круассан', stock: 10, runsOutAt: null, daysLeft: null, buyForWeek: 0, perDay: null });
  const [b] = forecastStock({ ...base, products: [{ id: 'm', name: 'Маффин', stock: 7 }], sales: [] });
  assert.equal(b?.runsOutAt, null);
  assert.equal(b?.daysLeft, null);
  assert.equal(b?.buyForWeek, 0);
});

test('out of stock: 0 days left, buy a full week', () => {
  const [item] = forecastStock({ ...base, products: [{ id: 'c', name: 'Круассан', stock: 0 }], sales: steady('c', 14) });
  assert.equal(item?.daysLeft, 0);
  assert.equal(item?.runsOutAt, null);
  assert.equal(item?.buyForWeek, 168);
});

test('sales older than 14 days and other products are ignored', () => {
  const old = steady('c', 30).filter((s) => s.at <= NOW - 14 * DAY);
  const [item] = forecastStock({ ...base, products: [{ id: 'c', name: 'Круассан', stock: 10 }], sales: [...old, ...steady('x', 14)] });
  assert.equal(item?.perDay, null);
});

test('the working day ends at 06:00: a night sale after midnight still counts as today', () => {
  // 22:00, 3 left, one sold every hour around the clock.
  const now = almaty(2026, 10, 26, 22);
  const rate = new Array<number>(24).fill(1);
  assert.equal(runsOutToday(now, 'Asia/Almaty', 3, rate), almaty(2026, 10, 27, 1));
  // 10 left: the day ends at 06:00 with 8 sold — lasts.
  assert.equal(runsOutToday(now, 'Asia/Almaty', 10, rate), null);
});

test('soonest first; purchase list biggest first', () => {
  const items = forecastStock({
    ...base,
    products: [
      { id: 'a', name: 'Сэндвич', stock: 100 },
      { id: 'b', name: 'Круассан', stock: 10 },
      { id: 'c', name: 'Маффин', stock: 0 },
      { id: 'd', name: 'Печенье', stock: 50 },
    ],
    sales: [...steady('a', 14, 1), ...steady('b', 14), ...steady('c', 14, 1), ...steady('d', 14, 1, 8, 9)],
  });
  assert.deepEqual(
    items.map((i) => i.name),
    ['Маффин', 'Круассан', 'Сэндвич', 'Печенье'],
  );
  assert.deepEqual(
    purchaseList(items).map((i) => [i.name, i.buyForWeek]),
    [
      ['Круассан', 158],
      ['Маффин', 84],
    ],
  );
});
