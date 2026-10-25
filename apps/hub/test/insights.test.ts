import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { InsightsView } from '@bills/domain';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, one, run } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import type { TestHub } from './helpers.ts';
import { Harness, MONDAY_NOON } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** Monday 12.10.2026 12:00 Almaty minus `n` days, at local hour `h`. */
const dayAt = (n: number, h: number, min = 0) => MONDAY_NOON - n * DAY + (h - 12) * HOUR + min * MIN;

async function getInsights(t: TestHub, token?: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: '/api/insights',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.json() as InsightsView & { error?: { code: string } } };
}

function clubId(t: TestHub): string {
  return one<{ id: string }>(t.db, 'SELECT id FROM clubs LIMIT 1')!.id;
}

function insertGame(t: TestHub, tableName: string, startedAt: number, minutes: number): void {
  const table = one<{ id: string; club_id: string; tariff_id: string; tariff_name: string; config: string }>(
    t.db,
    `SELECT t.id, t.club_id, tr.id AS tariff_id, tr.name AS tariff_name, tr.config
     FROM billiard_tables t JOIN tariffs tr ON tr.id = t.default_tariff_id WHERE t.name = ?`,
    tableName,
  );
  if (!table) throw new Error(`No table ${tableName}`);
  const stoppedAt = startedAt + minutes * MIN;
  run(
    t.db,
    `INSERT INTO table_sessions
       (id, club_id, table_id, tariff_id, tariff_name, tariff_snapshot, timezone, status, requested_at,
        started_at, stopped_at, played_seconds, billed_seconds, amount, opened_by, stopped_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Asia/Almaty', 'CLOSED', ?, ?, ?, ?, ?, 100000, 'test', 'test', ?)`,
    randomUUID(),
    table.club_id,
    table.id,
    table.tariff_id,
    table.tariff_name,
    table.config,
    startedAt - 1000,
    startedAt,
    stoppedAt,
    minutes * 60,
    minutes * 60,
    stoppedAt,
  );
}

function insertShift(t: TestHub, number: number, closedAt: number, difference: number): void {
  run(
    t.db,
    `INSERT INTO cash_shifts
       (id, club_id, number, status, opening_float, opened_at, opened_by, closed_at, closed_by, counted_cash, expected_cash, difference)
     VALUES (?, ?, ?, 'CLOSED', 0, ?, 'test', ?, 'test', ?, 50000000, ?)`,
    randomUUID(),
    clubId(t),
    number,
    closedAt - 12 * HOUR,
    closedAt,
    50_000_000 + difference,
    difference,
  );
}

let counter = 0;
/** A handed-over counter order of a coffee shop: one line, ready after `prepMs`. */
function insertCounterOrder(t: TestHub, productId: string, at: number, qty: number, prepMs: number): void {
  const id = randomUUID();
  counter = (counter % 999) + 1;
  run(
    t.db,
    `INSERT INTO bar_orders
       (id, club_id, session_id, table_id, status, total, created_at, created_by, updated_at,
        counter_number, service, stage, ready_at, issued_at, business_day)
     VALUES (?, ?, NULL, NULL, 'CLOSED', ?, ?, 'test', ?, ?, 'HERE', 'ISSUED', ?, ?, '2026-10-01')`,
    id,
    clubId(t),
    qty * 500_00,
    at,
    at,
    counter,
    at + prepMs,
    at + prepMs,
  );
  run(
    t.db,
    `INSERT INTO bar_order_items (id, order_id, product_id, title, price, qty, amount, created_at)
     VALUES (?, ?, ?, 'Круассан', 50000, ?, ?, ?)`,
    randomUUID(),
    id,
    productId,
    qty,
    qty * 500_00,
    at,
  );
}

test('a new club: no cards, no stock forecast, nothing breaks', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await getInsights(hub);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.cards, []);
  assert.deepEqual(res.body.stock, []);
  assert.equal(res.body.historyDays, 0);
  assert.equal(res.body.generatedAt, MONDAY_NOON);
});

test('billiards: idle mornings and cash shortages turn into cards; cached for a minute', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const tables = all<{ name: string }>(hub.db, 'SELECT name FROM billiard_tables WHERE is_active = 1 ORDER BY sort_order');
  for (let n = 1; n <= 27; n++) {
    for (const tb of tables) insertGame(hub, tb.name, dayAt(n, 18), 240);
    insertGame(hub, tables[0]!.name, dayAt(n, 9), 120);
  }
  insertShift(hub, 7, dayAt(2, 23), -2000_00);
  insertShift(hub, 8, dayAt(1, 23), -700_00);

  const res = await getInsights(hub);
  assert.equal(res.status, 200);
  assert.ok(res.body.historyDays >= 26);
  const ids = res.body.cards.map((c) => c.id);
  assert.ok(ids.includes('table-idle'), `cards: ${ids.join(', ')}`);
  assert.ok(ids.includes('cash'), `cards: ${ids.join(', ')}`);
  assert.equal(res.body.cards[0]!.severity, 'warn', 'warnings first');
  const idle = res.body.cards.find((c) => c.id === 'table-idle')!;
  assert.match(idle.title, /пустуют по утрам — включите утренний тариф/);
  assert.equal(idle.action?.route, '/settings?tab=tariffs');
  const cash = res.body.cards.find((c) => c.id === 'cash')!;
  assert.equal(cash.title, 'Недостача в кассе: 2 смены из 2 за 4 недели');
  assert.ok(res.body.cards.length <= 5);

  // Within a minute the HUB answers from its cache, after it — from the data.
  insertShift(hub, 9, dayAt(0, 11), -900_00);
  assert.equal((await getInsights(hub)).body.cards.find((c) => c.id === 'cash')!.title, cash.title);
  h.clock.advance(61_000);
  assert.equal(
    (await getInsights(hub)).body.cards.find((c) => c.id === 'cash')!.title,
    'Недостача в кассе: 3 смены из 3 за 4 недели',
  );
});

test('coffee shop: the stock forecast says when croissants run out and what to buy', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  run(hub.db, `UPDATE clubs SET settings = ?`, JSON.stringify({ business: { type: 'cafe' } }));
  const product = one<{ id: string }>(hub.db, 'SELECT id FROM products ORDER BY sort_order, name LIMIT 1')!;
  run(hub.db, 'UPDATE products SET stock = 10, name = ?, created_at = ? WHERE id = ?', 'Круассан', MONDAY_NOON - 60 * DAY, product.id);
  // 14 days back from now: two an hour, 08:00–20:00; today's morning makes up for the cut first day.
  for (let n = 0; n <= 14; n++) {
    for (let hr = 8; hr < 20; hr++) {
      const at = dayAt(n, hr, 20);
      if (at <= MONDAY_NOON - 14 * DAY || at > MONDAY_NOON) continue;
      // This week the barista is slower: 6 minutes instead of 4.
      insertCounterOrder(hub, product.id, at, 2, n <= 6 ? 6 * MIN : 4 * MIN);
    }
  }

  const res = await getInsights(hub);
  assert.equal(res.status, 200);
  const item = res.body.stock.find((s) => s.productId === product.id);
  assert.ok(item, 'tracked product is forecast');
  assert.equal(item.name, 'Круассан');
  assert.equal(item.stock, 10);
  assert.equal(item.perDay, 24);
  // History starts at the first order (13,99 days ago), so a few seconds earlier than 17:00.
  assert.ok(item.runsOutAt !== null && Math.abs(item.runsOutAt - dayAt(0, 17)) < 5 * MIN, 'about 17:00 today');
  // 24 a day × 7 − 10 in stock, rounded up.
  assert.ok(item.buyForWeek >= 158 && item.buyForWeek <= 159, String(item.buyForWeek));
  assert.ok(res.body.stock.every((s) => s.stock !== null));
  assert.ok(res.body.cards.some((c) => c.id === 'prep-trend' && c.severity === 'warn'), JSON.stringify(res.body.cards));
});

test('insights are for senior staff: a cashier gets 403, the manager and the administrator see them', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
  const tokenOf = async (name: string) => {
    const staff = hub.hub.staff.list().find((s) => s.name === name)!;
    const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
    return (res.json() as { token: string }).token;
  };
  assert.equal((await getInsights(hub)).status, 401);
  const cashier = await getInsights(hub, await tokenOf('Айгерим Кассир'));
  assert.equal(cashier.status, 403);
  assert.equal(cashier.body.error?.code, 'FORBIDDEN');
  assert.equal((await getInsights(hub, await tokenOf('Марат Управляющий'))).status, 200);
  assert.equal((await getInsights(hub, await tokenOf('Асель Администратор'))).status, 200);
});
