import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { OwnerSummary } from '@bills/domain';
import { all, one, run } from '../src/db.ts';
import { addDays, localDateOf, localMidnightUtc, parseLocalDate } from '../src/reports.ts';
import type { TestHub } from './helpers.ts';
import { Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const ALMATY = 5 * HOUR;

/** An Almaty wall-clock time as a UTC instant. */
function almaty(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - ALMATY;
}

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

interface GameFixture {
  table: string;
  startedAt: number;
  stoppedAt: number;
  amount: number;
  status?: 'AWAITING_PAYMENT' | 'CLOSED' | 'ACTIVE';
}

/** Inserts a finished game straight into the database, as if it was played earlier. */
function insertGame(t: TestHub, g: GameFixture): string {
  const table = one<{ id: string; club_id: string; tariff_id: string; tariff_name: string; config: string }>(
    t.db,
    `SELECT t.id, t.club_id, tr.id AS tariff_id, tr.name AS tariff_name, tr.config
     FROM billiard_tables t JOIN tariffs tr ON tr.id = t.default_tariff_id WHERE t.name = ?`,
    g.table,
  );
  if (!table) throw new Error(`No table ${g.table}`);
  const id = randomUUID();
  const seconds = Math.round((g.stoppedAt - g.startedAt) / 1000);
  run(
    t.db,
    `INSERT INTO table_sessions
       (id, club_id, table_id, tariff_id, tariff_name, tariff_snapshot, timezone, status, requested_at,
        started_at, stopped_at, played_seconds, billed_seconds, amount, opened_by, stopped_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Asia/Almaty', ?, ?, ?, ?, ?, ?, ?, 'test', 'test', ?)`,
    id,
    table.club_id,
    table.id,
    table.tariff_id,
    table.tariff_name,
    table.config,
    g.status ?? 'CLOSED',
    g.startedAt - 1000,
    g.startedAt,
    g.stoppedAt,
    seconds,
    seconds,
    g.amount,
    g.stoppedAt,
  );
  return id;
}

function insertOrder(t: TestHub, sessionId: string, total: number, createdAt: number): void {
  const s = one<{ club_id: string; table_id: string }>(
    t.db,
    'SELECT club_id, table_id FROM table_sessions WHERE id = ?',
    sessionId,
  );
  if (!s) throw new Error('No session');
  run(
    t.db,
    `INSERT INTO bar_orders (id, club_id, session_id, table_id, status, note, total, created_at, created_by, updated_at)
     VALUES (?, ?, ?, ?, 'OPEN', NULL, ?, ?, 'test', ?)`,
    randomUUID(),
    s.club_id,
    sessionId,
    s.table_id,
    total,
    createdAt,
    createdAt,
  );
}

async function summary(t: TestHub, date?: string): Promise<{ status: number; body: OwnerSummary & { error?: { code: string } } }> {
  const res = await t.app.inject({ method: 'GET', url: date ? `/api/reports/summary?date=${date}` : '/api/reports/summary' });
  return { status: res.statusCode, body: res.json() };
}

test('local midnight: a fixed-offset zone and a DST zone', () => {
  assert.equal(localMidnightUtc('2026-10-12', 'Asia/Almaty'), Date.UTC(2026, 9, 11, 19, 0));
  assert.equal(localMidnightUtc('2026-01-01', 'Asia/Almaty'), Date.UTC(2025, 11, 31, 19, 0));
  // Berlin: CET (+1) in winter, CEST (+2) in summer.
  assert.equal(localMidnightUtc('2026-01-15', 'Europe/Berlin'), Date.UTC(2026, 0, 14, 23, 0));
  assert.equal(localMidnightUtc('2026-07-01', 'Europe/Berlin'), Date.UTC(2026, 5, 30, 22, 0));
  // Days on which the clocks change (2026-03-29 forward, 2026-10-25 back): midnight is still before the change.
  assert.equal(localMidnightUtc('2026-03-29', 'Europe/Berlin'), Date.UTC(2026, 2, 28, 23, 0));
  assert.equal(localMidnightUtc('2026-03-30', 'Europe/Berlin'), Date.UTC(2026, 2, 29, 22, 0));
  assert.equal(localMidnightUtc('2026-10-25', 'Europe/Berlin'), Date.UTC(2026, 9, 24, 22, 0));
  assert.equal(localMidnightUtc('2026-10-26', 'Europe/Berlin'), Date.UTC(2026, 9, 25, 23, 0));
  // UTC itself.
  assert.equal(localMidnightUtc('2026-10-12', 'UTC'), Date.UTC(2026, 9, 12));

  assert.equal(localDateOf(MONDAY_NOON, 'Asia/Almaty'), '2026-10-12');
  assert.equal(localDateOf(Date.UTC(2026, 9, 11, 20, 30), 'Asia/Almaty'), '2026-10-12');
  assert.equal(localDateOf(Date.UTC(2026, 9, 11, 18, 30), 'Asia/Almaty'), '2026-10-11');
  assert.equal(addDays('2026-10-12', -13), '2026-09-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(parseLocalDate('2026-02-30'), null);
  assert.equal(parseLocalDate('2026-1-5'), null);
  assert.deepEqual(parseLocalDate('2026-02-28'), { y: 2026, m: 2, d: 28 });
});

test('a game stopped today counts in today, week and month', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  insertGame(hub, { table: 'Стол 1', startedAt: almaty(2026, 10, 12, 10), stoppedAt: almaty(2026, 10, 12, 11), amount: 2000_00 });

  const { status, body } = await summary(hub, '2026-10-12');
  assert.equal(status, 200);
  assert.equal(body.date, '2026-10-12');
  assert.equal(body.timezone, 'Asia/Almaty');
  assert.equal(body.currency, 'KZT');
  assert.equal(body.generatedAt, MONDAY_NOON);
  assert.deepEqual(body.revenue, { today: 2000_00, week: 2000_00, month: 2000_00 });
  assert.deepEqual(body.games, { today: 1, week: 1, month: 1 });
  assert.equal(body.avgCheck, 2000_00);

  assert.equal(body.revenueByDay.length, 14);
  assert.equal(body.revenueByDay[0]?.date, '2026-09-29');
  assert.deepEqual(body.revenueByDay.at(-1), { date: '2026-10-12', amount: 2000_00, games: 1 });
  assert.equal(body.revenueByDay.slice(0, 13).every((p) => p.amount === 0 && p.games === 0), true);

  assert.equal(body.topTables.length, 6);
  assert.deepEqual(body.topTables[0], { tableId: tableId(hub, 'Стол 1'), name: 'Стол 1', revenue: 2000_00, games: 1, seconds: 3600 });
  assert.equal(body.topTables[1]?.revenue, 0);
  assert.equal(body.openAlerts, 0);
  assert.equal(body.liveGames, 0);
  assert.equal(body.unpaidGames, 0);
  assert.equal(body.unpaidAmount, 0);
});

test('day boundaries follow the club zone, not UTC', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  // Sunday 23:30 local: yesterday, and the previous week.
  insertGame(hub, { table: 'Стол 1', startedAt: almaty(2026, 10, 11, 22, 30), stoppedAt: almaty(2026, 10, 11, 23, 30), amount: 3000_00 });
  // Monday 01:30 local = Sunday 20:30 UTC: today, even though the UTC date is yesterday.
  insertGame(hub, { table: 'Стол 2', startedAt: almaty(2026, 10, 12, 0, 30), stoppedAt: almaty(2026, 10, 12, 1, 30), amount: 1000_00 });

  const today = (await summary(hub, '2026-10-12')).body;
  assert.deepEqual(today.revenue, { today: 1000_00, week: 1000_00, month: 4000_00 });
  assert.deepEqual(today.games, { today: 1, week: 1, month: 2 });
  assert.equal(today.revenueByDay.at(-1)?.amount, 1000_00);
  assert.equal(today.revenueByDay.at(-2)?.amount, 3000_00);

  const yesterday = (await summary(hub, '2026-10-11')).body;
  assert.deepEqual(yesterday.revenue, { today: 3000_00, week: 3000_00, month: 4000_00 });
  assert.deepEqual(yesterday.games, { today: 1, week: 1, month: 2 });
  assert.equal(yesterday.revenueByDay.at(-1)?.date, '2026-10-11');
  assert.equal(yesterday.revenueByDay.at(-1)?.amount, 3000_00);
  // The Monday game is in the future for that date: not in its 14 days.
  assert.equal(yesterday.revenueByDay.reduce((s, p) => s + p.amount, 0), 3000_00);
});

test('a game last month counts in neither week nor month', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  insertGame(hub, { table: 'Стол 1', startedAt: almaty(2026, 9, 15, 10), stoppedAt: almaty(2026, 9, 15, 12), amount: 4000_00 });

  const { body } = await summary(hub, '2026-10-12');
  assert.deepEqual(body.revenue, { today: 0, week: 0, month: 0 });
  assert.deepEqual(body.games, { today: 0, week: 0, month: 0 });
  assert.equal(body.avgCheck, 0);
  assert.equal(body.revenueByDay.every((p) => p.amount === 0), true);
  assert.equal(body.topTables.every((x) => x.revenue === 0 && x.games === 0), true);

  const september = (await summary(hub, '2026-09-30')).body;
  assert.equal(september.revenue.month, 4000_00);
  assert.equal(september.revenue.week, 0); // 15.09 is two weeks before 30.09
  assert.equal(september.revenueByDay.find((p) => p.date === '2026-09-15')?.games, undefined);
});

test('occupancy by hour: one table of six, 12:00–13:30', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  insertGame(hub, { table: 'Стол 1', startedAt: almaty(2026, 10, 12, 12), stoppedAt: almaty(2026, 10, 12, 13, 30), amount: 3000_00 });

  const { body } = await summary(hub, '2026-10-12');
  assert.equal(body.occupancyByHour.length, 24);
  assert.equal(body.occupancyByHour[11], 0);
  assert.equal(body.occupancyByHour[12], 0.167);
  assert.equal(body.occupancyByHour[13], 0.083);
  assert.equal(body.occupancyByHour[14], 0);
  assert.equal(body.occupancyByHour.every((v) => v >= 0 && v <= 1), true);
});

test('a running game counts as live and occupies the table up to now', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 3')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(30 * MINUTE);

  const { body } = await summary(hub);
  assert.equal(body.liveGames, 1);
  assert.equal(body.generatedAt, MONDAY_NOON + 30 * MINUTE);
  assert.equal(body.occupancyByHour[12], 0.083);
  assert.equal(body.revenue.today, 0); // not stopped: no revenue yet
});

test('bar orders add to revenue and to the unpaid amount', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = insertGame(hub, {
    table: 'Стол 4',
    startedAt: almaty(2026, 10, 12, 9),
    stoppedAt: almaty(2026, 10, 12, 10),
    amount: 1000_00,
    status: 'AWAITING_PAYMENT',
  });
  insertOrder(hub, game, 600_00, almaty(2026, 10, 12, 9, 20));
  // An order from last week does not land in this week.
  const old = insertGame(hub, { table: 'Стол 5', startedAt: almaty(2026, 10, 5, 9), stoppedAt: almaty(2026, 10, 5, 10), amount: 500_00 });
  insertOrder(hub, old, 200_00, almaty(2026, 10, 5, 9, 30));

  const { body } = await summary(hub, '2026-10-12');
  assert.deepEqual(body.revenue, { today: 1600_00, week: 1600_00, month: 2300_00 });
  assert.deepEqual(body.games, { today: 1, week: 1, month: 2 });
  assert.equal(body.avgCheck, 1600_00);
  assert.equal(body.revenueByDay.at(-1)?.amount, 1600_00);
  assert.equal(body.revenueByDay.find((p) => p.date === '2026-10-05')?.amount, 700_00);
  assert.equal(body.unpaidGames, 1);
  assert.equal(body.unpaidAmount, 1600_00);
  // Top tables count time only.
  assert.equal(body.topTables.find((x) => x.name === 'Стол 4')?.revenue, 1000_00);
});

test('bar orders of a game still running wait with its time; they count once it stops', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const done = insertGame(hub, {
    table: 'Стол 1',
    startedAt: almaty(2026, 10, 12, 9),
    stoppedAt: almaty(2026, 10, 12, 10),
    amount: 1500_00,
  });
  insertOrder(hub, done, 1200_00, almaty(2026, 10, 12, 9, 30));
  const live = insertGame(hub, {
    table: 'Стол 4',
    startedAt: almaty(2026, 10, 12, 11),
    stoppedAt: almaty(2026, 10, 12, 11, 30),
    amount: 0,
    status: 'ACTIVE',
  });
  run(hub.db, 'UPDATE table_sessions SET stopped_at = NULL WHERE id = ?', live);
  insertOrder(hub, live, 900_00, almaty(2026, 10, 12, 11, 10));

  let { body } = await summary(hub, '2026-10-12');
  assert.equal(body.revenue.today, 2700_00);
  assert.equal(body.revenueByDay.at(-1)?.amount, 2700_00);
  assert.equal(body.avgCheck, 2700_00);

  run(hub.db, "UPDATE table_sessions SET status = 'AWAITING_PAYMENT', stopped_at = ?, amount = 1500_00 WHERE id = ?", almaty(2026, 10, 12, 12), live);
  ({ body } = await summary(hub, '2026-10-12'));
  assert.equal(body.revenue.today, 2700_00 + 1500_00 + 900_00);
});

test('default date is today in the club zone; a malformed date is rejected', async (t) => {
  const h = harness(t);
  const hub = await h.start();

  assert.equal((await summary(hub)).body.date, '2026-10-12');
  // 01:30 local on Tuesday is still Monday in UTC.
  h.clock.set(almaty(2026, 10, 13, 1, 30));
  assert.equal((await summary(hub)).body.date, '2026-10-13');

  for (const bad of ['2026-13-01', '2026-02-30', '12.10.2026', 'today', '2026-1-5']) {
    const res = await summary(hub, bad);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error?.code, 'BAD_DATE', bad);
  }
});

test('open alerts are counted', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.offline = true;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');
  await waitFor(() => all(hub.db, "SELECT id FROM lamp_commands WHERE status = 'PENDING'").length === 0);

  const before = (await summary(hub)).body;
  assert.equal(before.openAlerts, hub.hub.state().alerts.length);
  assert.ok(before.openAlerts >= 1);
  assert.equal(before.liveGames, 0);
  // A failed game never occupied the table.
  assert.equal(before.occupancyByHour[12], 0);

  for (const a of hub.hub.state().alerts) await post(hub, `/api/alerts/${a.id}/resolve`);
  assert.equal((await summary(hub)).body.openAlerts, 0);
});
