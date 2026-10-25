import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avgCheckRule,
  buildInsights,
  cashRule,
  formatInsightDuration,
  gameLengthRule,
  historyDays,
  peakHoursRule,
  prepaidRule,
  prepTrendRule,
  revenueDayRule,
  slowHourRule,
  slowItemsRule,
  tableIdleRule,
  topSellerRule,
  voidsRule,
} from '../src/index.ts';
import type { InsightsInput } from '../src/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ALMATY = 5 * HOUR;

/** An Almaty wall-clock time as a UTC instant. */
function almaty(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - ALMATY;
}

/** Monday 2026-10-26, 12:00 in Almaty. */
const NOW = almaty(2026, 10, 26, 12);
/** Local midnight `n` days before today, plus `h` hours. */
const dayAt = (n: number, h: number, min = 0) => almaty(2026, 10, 26 - n, h, min);

function input(over: Partial<InsightsInput> = {}): InsightsInput {
  return {
    now: NOW,
    timezone: 'Asia/Almaty',
    currency: 'KZT',
    business: 'cafe',
    visits: [],
    products: [],
    sales: [],
    checks: [],
    payments: [],
    prep: [],
    games: [],
    tables: [],
    shifts: [],
    voids: [],
    ...over,
  };
}

/** Every day of the last `days` (yesterday back), `perHour` visits each hour from `from` to `to`. */
function steadyVisits(days: number, from: number, to: number, perHour: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= days; n++) for (let h = from; h < to; h++) for (let i = 0; i < perHour; i++) out.push(dayAt(n, h, i * 7));
  return out;
}

test('durations read like people say them', () => {
  assert.equal(formatInsightDuration(40_000), '40 с');
  assert.equal(formatInsightDuration(6 * MIN + 10_000), '6 мин 10 с');
  assert.equal(formatInsightDuration(25 * MIN), '25 мин');
  assert.equal(formatInsightDuration(95 * MIN), '1 ч 35 мин');
});

test('history days: from the first sale inside 28 days', () => {
  assert.equal(historyDays(input()), 0);
  assert.equal(historyDays(input({ visits: [NOW - 3 * DAY] })), 3);
  assert.equal(historyDays(input({ checks: [{ at: NOW - 90 * DAY, amount: 1 }, { at: NOW - 40 * DAY, amount: 1 }] })), 0);
  assert.equal(historyDays(input({ payments: [{ at: NOW - 27 * DAY, amount: 1 }] })), 27);
});

// ── Busy hours ────────────────────────────────────────────────────────────────

test('peak hours: Saturday evening rush → a second barista', () => {
  const visits = steadyVisits(28, 10, 20, 3);
  // Saturdays: 17.10, 10.10, 03.10, 24.10 — 12 more orders an hour from 18 to 21.
  for (const d of [2, 9, 16, 23]) for (let h = 18; h < 21; h++) for (let i = 0; i < 12; i++) visits.push(dayAt(d, h, i * 4));
  const c = peakHoursRule(input({ visits }));
  assert.ok(c);
  assert.equal(c.card.id, 'peak-hours');
  assert.equal(c.card.severity, 'tip');
  assert.match(c.card.title, /^По субботам 18–21 заказов в [\d,]+ раза больше — поставьте второго бариста$/);
  assert.equal(c.card.detail, 'В эти часы в среднем 14 заказов в час, в обычный час — 3,4. Посчитано за 4 недели.');
});

test('peak hours: a flat week or too little history says nothing', () => {
  assert.equal(peakHoursRule(input({ visits: steadyVisits(28, 10, 20, 3) })), null);
  const short = steadyVisits(5, 10, 20, 3);
  for (let h = 18; h < 21; h++) for (let i = 0; i < 12; i++) short.push(dayAt(2, h, i * 4));
  assert.equal(peakHoursRule(input({ visits: short })), null, 'five days are not a week');
  assert.equal(peakHoursRule(input({ visits: [dayAt(10, 12), dayAt(2, 19), dayAt(2, 19)] })), null, 'a handful of orders');
});

test('peak hours in a billiard club speak about games and an administrator', () => {
  const visits = steadyVisits(28, 14, 24, 1);
  for (const d of [3, 10, 17, 24]) for (let h = 19; h < 22; h++) for (let i = 0; i < 3; i++) visits.push(dayAt(d, h, 10 + i * 10));
  const c = peakHoursRule(input({ business: 'billiards', visits }));
  assert.ok(c);
  assert.match(c.card.title, /^По пятницам 19–22 игр в .* — поставьте второго администратора$/);
});

// ── Menu ──────────────────────────────────────────────────────────────────────

const products = ['Капучино', 'Латте', 'Американо', 'Круассан', 'Раф', 'Матча'].map((name, i) => ({
  id: `p${i}`,
  name,
  createdAt: NOW - 60 * DAY,
  onMenu: true,
}));

function sell(productId: string, name: string, units: number, price = 1000_00) {
  return Array.from({ length: units }, (_, i) => ({ productId, name, at: NOW - ((i % 27) + 1) * DAY, qty: 1, amount: price }));
}

const menuSales = [
  ...sell('p0', 'Капучино', 60, 1500_00),
  ...sell('p1', 'Латте', 40),
  ...sell('p2', 'Американо', 30),
  ...sell('p3', 'Круассан', 20),
  ...sell('p4', 'Раф', 3),
];

test('slow items: Раф sold 3 times, Матча never → remove or promote', () => {
  const c = slowItemsRule(input({ products, sales: menuSales }));
  assert.ok(c);
  assert.equal(c.card.title, '«Матча» не заказали ни разу за 4 недели — уберите или сделайте акцию');
  assert.match(c.card.detail, /Ещё редко берут: Раф — 3\./);
  assert.deepEqual(c.card.action, { label: 'Открыть меню', route: '/bar' });

  const withMatcha = [...menuSales, ...sell('p5', 'Матча', 25)];
  const c2 = slowItemsRule(input({ products, sales: withMatcha }));
  assert.ok(c2);
  assert.equal(c2.card.title, '«Раф» продали 3 раза за 4 недели — уберите или сделайте акцию');
});

test('slow items: new products and small menus are left alone', () => {
  const fresh = products.map((p) => ({ ...p, createdAt: NOW - 5 * DAY }));
  assert.equal(slowItemsRule(input({ products: fresh, sales: menuSales })), null, 'nothing has two weeks on the menu');
  assert.equal(slowItemsRule(input({ products, sales: menuSales.slice(0, 60) })), null, 'under 100 units sold');
  assert.equal(slowItemsRule(input({ products: products.slice(0, 4), sales: menuSales })), null, 'four products');
});

test('top seller: Капучино brings the biggest share of menu money', () => {
  const c = topSellerRule(input({ products, sales: menuSales }));
  assert.ok(c);
  assert.equal(c.card.severity, 'good');
  // 60 × 1500 = 90 000 of 90 000 + 93 000 = 183 000 → 49%.
  assert.equal(c.card.title, '«Капучино» — 49% выручки меню');
  assert.match(c.card.detail, /60 шт\./);
  assert.equal(topSellerRule(input({ products, sales: menuSales.slice(0, 40) })), null, 'under 50 units');
  const even = [...sell('p0', 'Капучино', 20), ...sell('p1', 'Латте', 20), ...sell('p2', 'Американо', 20), ...sell('p3', 'Круассан', 20), ...sell('p4', 'Раф', 20)];
  assert.equal(topSellerRule(input({ products, sales: even })), null, '20% each: nothing stands out');
});

// ── Money ─────────────────────────────────────────────────────────────────────

function checks(fromDay: number, toDay: number, n: number, amount: number) {
  return Array.from({ length: n }, (_, i) => ({ at: NOW - fromDay * DAY + ((fromDay - toDay) * DAY * (i + 0.5)) / n, amount }));
}

test('average check fell by 20% week over week → warn with numbers', () => {
  const c = avgCheckRule(input({ checks: [...checks(7, 0, 25, 2000_00), ...checks(14, 7, 25, 2500_00)] }));
  assert.ok(c);
  assert.equal(c.card.severity, 'warn');
  assert.equal(c.card.title, 'Средний чек упал на 20%');
  assert.match(c.card.detail, /2\s000\s₸ за последние 7 дней против 2\s500\s₸ неделей раньше \(25 чеков и 25 чеков\)/);
  const up = avgCheckRule(input({ checks: [...checks(7, 0, 25, 2500_00), ...checks(14, 7, 25, 2000_00)] }));
  assert.equal(up?.card.severity, 'good');
  assert.equal(up?.card.title, 'Средний чек вырос на 25%');
});

test('average check: too few checks or a small change stay silent', () => {
  assert.equal(avgCheckRule(input({ checks: [...checks(7, 0, 10, 2000_00), ...checks(14, 7, 25, 2500_00)] })), null);
  assert.equal(avgCheckRule(input({ checks: [...checks(7, 0, 25, 2400_00), ...checks(14, 7, 25, 2500_00)] })), null);
});

test('revenue: yesterday 50% below the usual Sunday', () => {
  const pay = (n: number, amount: number) => ({ at: dayAt(n, 15), amount });
  const c = revenueDayRule(input({ payments: [pay(1, 50_000_00), pay(8, 100_000_00), pay(15, 90_000_00), pay(22, 110_000_00)] }));
  assert.ok(c);
  assert.equal(c.card.severity, 'warn');
  assert.equal(c.card.title, 'Вчера выручка на 50% ниже, чем обычно по воскресеньям');
  assert.match(c.card.detail, /50\s000\s₸ против 100\s000\s₸/);
  const good = revenueDayRule(input({ payments: [pay(1, 150_000_00), pay(8, 100_000_00), pay(15, 100_000_00)] }));
  assert.equal(good?.card.severity, 'good');
});

test('revenue: one past Sunday, a normal day or a day off say nothing', () => {
  const pay = (n: number, amount: number) => ({ at: dayAt(n, 15), amount });
  assert.equal(revenueDayRule(input({ payments: [pay(1, 50_000_00), pay(8, 100_000_00)] })), null);
  assert.equal(revenueDayRule(input({ payments: [pay(1, 95_000_00), pay(8, 100_000_00), pay(15, 100_000_00)] })), null);
  assert.equal(revenueDayRule(input({ payments: [pay(8, 100_000_00), pay(15, 100_000_00)] })), null);
});

test('cash: two short shifts → warn; one small difference → nothing', () => {
  const c = cashRule(
    input({
      shifts: [
        { number: 41, closedAt: dayAt(2, 23), difference: -2000_00 },
        { number: 40, closedAt: dayAt(3, 23), difference: 0 },
        { number: 38, closedAt: dayAt(5, 23), difference: -500_00 },
      ],
    }),
  );
  assert.ok(c);
  assert.equal(c.card.severity, 'warn');
  assert.equal(c.card.title, 'Недостача в кассе: 2 смены из 3 за 4 недели');
  assert.match(c.card.detail, /№41 \(24\.10\) −2\s000\s₸, №38 \(21\.10\) −500\s₸\. Всего −2\s500\s₸/);
  assert.equal(cashRule(input({ shifts: [{ number: 41, closedAt: dayAt(2, 23), difference: -150_00 }] })), null);
  assert.equal(cashRule(input({ shifts: [{ number: 41, closedAt: dayAt(2, 23), difference: -50_00 }, { number: 42, closedAt: dayAt(1, 23), difference: 30_00 }] })), null, 'coins');
  const surplus = cashRule(input({ shifts: [{ number: 41, closedAt: dayAt(2, 23), difference: 1500_00 }] }));
  assert.match(surplus?.card.title ?? '', /^Излишки в кассе/);
  const mixed = cashRule(
    input({
      shifts: [
        { number: 41, closedAt: dayAt(2, 23), difference: -1500_00 },
        { number: 42, closedAt: dayAt(1, 23), difference: 300_00 },
      ],
    }),
  );
  assert.equal(mixed?.card.title, 'Расхождения в кассе: 2 смены из 2 за 4 недели');
});

test('cancellations: share far above normal → careful warn', () => {
  const v = (fromDay: number, toDay: number, n: number, cancelled: number) =>
    Array.from({ length: n }, (_, i) => ({ at: NOW - fromDay * DAY + ((fromDay - toDay) * DAY * (i + 0.5)) / n, cancelled: i < cancelled }));
  const c = voidsRule(input({ voids: [...v(7, 0, 50, 6), ...v(28, 7, 150, 3)] }));
  assert.ok(c);
  assert.equal(c.card.title, 'Отмен стало больше: 6 из 50 заказов за неделю');
  assert.match(c.card.detail, /Это 12%, обычно — 2%/);
  assert.match(c.card.detail, /ошибки при вводе/);
  assert.equal(voidsRule(input({ voids: [...v(7, 0, 50, 6), ...v(28, 7, 150, 18)] })), null, 'always that many');
  assert.equal(voidsRule(input({ voids: [...v(7, 0, 20, 6)] })), null, 'too few orders');
});

// ── Cafe: barista speed ───────────────────────────────────────────────────────

function prepRows(fromDay: number, toDay: number, n: number, ms: number) {
  return Array.from({ length: n }, (_, i) => {
    const at = NOW - fromDay * DAY + ((fromDay - toDay) * DAY * (i + 0.5)) / n;
    return { at, readyAt: at + ms };
  });
}

test('prep time grew from 4 to 6 minutes → warn; billiards never', () => {
  const prep = [...prepRows(7, 0, 35, 6 * MIN), ...prepRows(14, 7, 35, 4 * MIN)];
  const c = prepTrendRule(input({ prep }));
  assert.ok(c);
  assert.equal(c.card.severity, 'warn');
  assert.equal(c.card.title, 'Заказы стали готовить дольше: 6 мин вместо 4 мин');
  assert.equal(prepTrendRule(input({ business: 'billiards', prep })), null);
  assert.equal(prepTrendRule(input({ prep: [...prepRows(7, 0, 10, 6 * MIN), ...prepRows(14, 7, 35, 4 * MIN)] })), null);
  // Forgotten orders (ready after an hour) do not count.
  assert.equal(prepTrendRule(input({ prep: [...prepRows(7, 0, 35, 2 * HOUR), ...prepRows(14, 7, 35, 4 * MIN)] })), null);
});

test('slowest hour: the 8 o’clock rush waits 8 minutes against 3', () => {
  const prep: Array<InsightsInput['prep'][number]> = [];
  for (let n = 1; n <= 28; n++) {
    for (let i = 0; i < 3; i++) {
      const at = dayAt(n, 8, i * 15);
      prep.push({ at, readyAt: at + 8 * MIN });
    }
    for (let h = 12; h < 17; h++) {
      for (let i = 0; i < 3; i++) {
        const at = dayAt(n, h, i * 15);
        prep.push({ at, readyAt: at + 3 * MIN });
      }
    }
  }
  const c = slowHourRule(input({ prep }));
  assert.ok(c);
  assert.equal(c.card.title, 'Дольше всего ждут с 8 до 9 часов: 8 мин вместо 3 мин');
  assert.match(c.card.detail, /в среднем 2,9 заказа в день/);
  assert.equal(slowHourRule(input({ prep: prep.slice(0, 40) })), null, 'under 50 orders');
});

// ── Billiards ─────────────────────────────────────────────────────────────────

const tables = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, name: `Стол ${n}` }));

function game(tableId: string, startedAt: number, minutes: number, prepaid = false) {
  return { tableId, startedAt, stoppedAt: startedAt + minutes * MIN, prepaid };
}

test('table idle: three tables stand empty in the mornings → morning tariff', () => {
  const games: Array<InsightsInput['games'][number]> = [];
  for (let n = 1; n <= 28; n++) {
    for (const t of tables) games.push(game(t.id, dayAt(n, 18), 240));
    games.push(game('t1', dayAt(n, 9), 120));
  }
  const c = tableIdleRule(input({ business: 'billiards', tables, games }));
  assert.ok(c);
  assert.equal(c.card.title, 'Стол 2, Стол 3, Стол 4 пустуют по утрам — включите утренний тариф');
  assert.match(c.card.detail, /^С 06 до 12 они заняты 0% времени, а вечером столы заняты 67,3%/);
  assert.deepEqual(c.card.action, { label: 'Тарифы', route: '/settings?tab=tariffs' });
  assert.equal(tableIdleRule(input({ business: 'cafe', tables, games })), null);
  assert.equal(tableIdleRule(input({ business: 'billiards', tables, games: games.slice(0, 20) })), null, 'under 30 games');
});

test('table idle: a closed morning (no games at all) is not «idle»', () => {
  const games: Array<InsightsInput['games'][number]> = [];
  for (let n = 1; n <= 28; n++) for (const t of tables) games.push(game(t.id, dayAt(n, 18), 240));
  assert.equal(tableIdleRule(input({ business: 'billiards', tables, games })), null);
});

test('prepaid: long games, few paid upfront → offer «на 2 часа»', () => {
  const games = Array.from({ length: 30 }, (_, i) => game(tables[i % 4]!.id, dayAt((i % 20) + 1, 19), 90, i < 2));
  const c = prepaidRule(input({ business: 'billiards', tables, games }));
  assert.ok(c);
  assert.equal(c.card.title, 'Предлагайте игру «на 2 часа» с оплатой сразу: так платят только за 7% игр');
  assert.match(c.card.detail, /Средняя игра — 1 ч 30 мин/);
  const paid = games.map((g, i) => ({ ...g, prepaid: i < 10 }));
  assert.equal(prepaidRule(input({ business: 'billiards', tables, games: paid })), null);
  const short = games.map((g) => ({ ...g, stoppedAt: g.startedAt + 30 * MIN }));
  assert.equal(prepaidRule(input({ business: 'billiards', tables, games: short })), null);
});

test('game length: games got a third shorter → tip', () => {
  const cur = Array.from({ length: 20 }, (_, i) => game('t1', NOW - (i * 6 + 3) * HOUR, 60));
  const prev = Array.from({ length: 20 }, (_, i) => game('t2', NOW - 7 * DAY - (i * 6 + 3) * HOUR, 90));
  const c = gameLengthRule(input({ business: 'billiards', tables, games: [...cur, ...prev] }));
  assert.ok(c);
  assert.equal(c.card.title, 'Игры стали короче: в среднем 1 ч вместо 1 ч 30 мин');
  assert.equal(gameLengthRule(input({ business: 'billiards', tables, games: [...cur.slice(0, 10), ...prev] })), null);
});

// ── All together ──────────────────────────────────────────────────────────────

test('buildInsights: warnings first, at most five, nothing on an empty venue', () => {
  assert.deepEqual(buildInsights(input()), []);
  const visits = steadyVisits(28, 10, 20, 3);
  for (const d of [2, 9, 16, 23]) for (let h = 18; h < 21; h++) for (let i = 0; i < 12; i++) visits.push(dayAt(d, h, i * 4));
  const v = (fromDay: number, toDay: number, n: number, cancelled: number) =>
    Array.from({ length: n }, (_, i) => ({ at: NOW - fromDay * DAY + ((fromDay - toDay) * DAY * (i + 0.5)) / n, cancelled: i < cancelled }));
  const cards = buildInsights(
    input({
      visits,
      products,
      sales: menuSales,
      checks: [...checks(7, 0, 25, 2000_00), ...checks(14, 7, 25, 2500_00)],
      prep: [...prepRows(7, 0, 35, 6 * MIN), ...prepRows(14, 7, 35, 4 * MIN)],
      shifts: [
        { number: 41, closedAt: dayAt(2, 23), difference: -2000_00 },
        { number: 38, closedAt: dayAt(5, 23), difference: -500_00 },
      ],
      voids: [...v(7, 0, 50, 6), ...v(28, 7, 150, 3)],
    }),
  );
  assert.equal(cards.length, 5);
  const order = { warn: 0, tip: 1, good: 2 } as const;
  for (let i = 1; i < cards.length; i++) assert.ok(order[cards[i - 1]!.severity] <= order[cards[i]!.severity], 'sorted by severity');
  assert.equal(cards[0]!.severity, 'warn');
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'one card per rule');
});
