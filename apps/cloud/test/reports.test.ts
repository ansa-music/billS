import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClubDetails, CloudSessionView, OwnerOverview, PeriodStats } from '@bills/domain';
import { addDays, dayStart, localDay, nextHourStart } from '../src/localtime.ts';
import { clubIdOf, cloud, gameEvents, HOUR, HUB1, HUB2, login, MONDAY_NOON, ownerGet, sendEvents, tableIdOf } from './helpers.ts';

const DAY = 24 * HOUR;

/** Stats of games stopped but not paid yet: only `billed` moves, revenue (payments) stays 0. */
function billedOnly(billed: number, games: number, playedSeconds: number): PeriodStats {
  return {
    revenue: 0,
    billed,
    games,
    playedSeconds,
    paid: { cash: 0, card: 0, qr: 0, total: 0 },
    refunded: 0,
    checksPaid: 0,
    discounts: 0,
    averageCheck: 0,
    cancelledGames: 0,
  };
}

test('local time helpers (Asia/Almaty, UTC+5)', () => {
  assert.equal(localDay(MONDAY_NOON, 'Asia/Almaty'), '2026-10-12');
  assert.equal(localDay(Date.UTC(2026, 9, 11, 20, 0), 'Asia/Almaty'), '2026-10-12'); // 01:00 local
  assert.equal(dayStart('2026-10-12', 'Asia/Almaty'), Date.UTC(2026, 9, 11, 19, 0));
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(nextHourStart(MONDAY_NOON + 15 * 60_000 + 7_500, 'Asia/Almaty'), MONDAY_NOON + HOUR);
  assert.equal(nextHourStart(MONDAY_NOON, 'Asia/Almaty'), MONDAY_NOON + HOUR);
});

test('a stopped game puts its billed amount into daily_stats and the overview for today', async (t) => {
  const c = await cloud(t);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 1');
  const clubId = await clubIdOf(c, HUB1.id);
  const cookie = await login(c);

  // Yesterday's game (counted in week/month only).
  await sendEvents(c, HUB1, gameEvents(1, 'old', tableId, MONDAY_NOON - DAY, MONDAY_NOON - DAY + HOUR, 1500_00));
  // Today's game.
  await sendEvents(c, HUB1, gameEvents(4, 'today', tableId, MONDAY_NOON - 2 * HOUR, MONDAY_NOON - HOUR, 2000_00));
  // Last month's game (outside month, inside nothing).
  await sendEvents(c, HUB1, gameEvents(7, 'lastmonth', tableId, MONDAY_NOON - 20 * DAY, MONDAY_NOON - 20 * DAY + HOUR, 9000_00));

  const stats = await c.db.all<{ day: string; revenue: number; games: number; played_seconds: number }>(
    'SELECT day, revenue, games, played_seconds FROM daily_stats WHERE club_id = ? ORDER BY day',
    [clubId],
  );
  assert.deepEqual(stats, [
    { day: '2026-09-22', revenue: 9000_00, games: 1, played_seconds: 3600 },
    { day: '2026-10-11', revenue: 1500_00, games: 1, played_seconds: 3600 },
    { day: '2026-10-12', revenue: 2000_00, games: 1, played_seconds: 3600 },
  ]);

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.serverNow, MONDAY_NOON);
  const club = ov.body.clubs.find((x) => x.id === clubId)!;
  assert.deepEqual(club.today, billedOnly(2000_00, 1, 3600));
  assert.deepEqual(club.week, billedOnly(3500_00, 2, 7200));
  assert.deepEqual(club.month, billedOnly(3500_00, 2, 7200));
  assert.equal(club.liveGames, 0);
  assert.equal(club.tablesCount, 6);
  assert.equal(club.hub?.id, HUB1.id);
  assert.equal(club.hub?.online, true);
  assert.equal(club.hub?.lastOutboxId, 9);
  assert.equal(club.hub?.pendingSettings, false);

  // The other club saw nothing: offline HUB, zeros.
  const other = ov.body.clubs.find((x) => x.id !== clubId)!;
  assert.deepEqual(other.today, billedOnly(0, 0, 0));
  assert.equal(other.hub?.online, false);
  assert.equal(other.hub?.lastSeenAt, null);

  // HUB goes quiet: offline after the window.
  c.clock.advance(10 * 60_000);
  const later = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(later.body.clubs.find((x) => x.id === clubId)?.hub?.online, false);
});

test('two clubs of one company: totals add up, each club keeps its own numbers', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const club1 = await clubIdOf(c, HUB1.id);
  const club2 = await clubIdOf(c, HUB2.id);
  const table1 = await tableIdOf(c, HUB1.id, 'Стол 1');
  const table2 = await tableIdOf(c, HUB2.id, 'Стол 3');

  await sendEvents(c, HUB1, gameEvents(1, 'a', table1, MONDAY_NOON - 3 * HOUR, MONDAY_NOON - 2 * HOUR, 2000_00));
  await sendEvents(c, HUB2, gameEvents(1, 'b', table2, MONDAY_NOON - 3 * HOUR, MONDAY_NOON - HOUR, 4000_00));
  await sendEvents(c, HUB2, gameEvents(4, 'c', table2, MONDAY_NOON - 1 * HOUR, MONDAY_NOON - HOUR / 2, 1000_00));

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.body.clubs.length, 2);
  const s1 = ov.body.clubs.find((x) => x.id === club1)!;
  const s2 = ov.body.clubs.find((x) => x.id === club2)!;
  assert.deepEqual(s1.today, billedOnly(2000_00, 1, 3600));
  assert.deepEqual(s2.today, billedOnly(5000_00, 2, 7200 + 1800));
  assert.deepEqual(ov.body.totals.today, billedOnly(7000_00, 3, 3600 + 7200 + 1800));
  assert.deepEqual(ov.body.totals.week, ov.body.totals.today);
  assert.deepEqual(ov.body.totals.month, ov.body.totals.today);

  // Club pages are isolated: each shows only its own games; a club id of another company is 404.
  const d1 = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${club1}`);
  assert.equal(d1.body.recentSessions.length, 1);
  assert.equal(d1.body.recentSessions[0]?.tableName, 'Стол 1');
  const d2 = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${club2}`);
  assert.equal(d2.body.recentSessions.length, 2);
  const missing = await ownerGet<{ error: { code: string } }>(c, cookie, '/api/owner/clubs/not-a-club');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'CLUB_NOT_FOUND');

  const sessions = await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${club2}/sessions?day=2026-10-12`);
  assert.equal(sessions.status, 200);
  assert.deepEqual(sessions.body.map((s) => s.id), ['c', 'b']);
  const empty = await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${club2}/sessions?day=2026-10-11`);
  assert.deepEqual(empty.body, []);
  const badDay = await ownerGet<{ error: { code: string } }>(c, cookie, `/api/owner/clubs/${club2}/sessions?day=yesterday`);
  assert.equal(badDay.status, 400);
});

test('load by hour: a game 12:00–14:30 Almaty fills hours 12, 13 and 14', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 4');
  const stoppedAt = MONDAY_NOON + 2.5 * HOUR;
  c.clock.set(stoppedAt + HOUR);

  await sendEvents(c, HUB1, gameEvents(1, 'g', tableId, MONDAY_NOON, stoppedAt, 5000_00));
  // A live game started at 16:00 and still running at "now" 16:30 adds 1800 s to hour 16.
  await sendEvents(c, HUB1, [
    ...gameEvents(4, 'live', tableId, stoppedAt + HOUR / 2, stoppedAt + HOUR, 0).slice(0, 2),
  ]);

  const d = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.hours.length, 24);
  const by = Object.fromEntries(d.body.hours.map((h) => [h.hour, h.busySeconds]));
  assert.equal(by[12], 3600);
  assert.equal(by[13], 3600);
  assert.equal(by[14], 1800);
  assert.equal(by[15], 1800);
  assert.equal(by[11], 0);
  assert.equal(by[16], 0);
  assert.equal(d.body.hours[12]?.games, 1);
  assert.equal(d.body.club.liveGames, 1);

  const table = d.body.tables.find((x) => x.id === tableId)!;
  assert.equal(table.name, 'Стол 4');
  assert.equal(table.kind, 'russian');
  assert.equal(table.revenue, 5000_00);
  assert.equal(table.games, 1);
  assert.equal(table.playedSeconds, 9000);
  assert.deepEqual(table.byHour.slice(12, 16), [3600, 3600, 1800, 1800]);
  assert.equal(d.body.tables.length, 6);
  assert.equal(d.body.days.length, 30);
  assert.equal(d.body.days.at(-1)?.day, '2026-10-12');
  assert.equal(d.body.days.at(-1)?.billed, 5000_00);
  assert.equal(d.body.days.at(-1)?.revenue, 0);
  assert.equal(d.body.days[0]?.day, '2026-09-13');
  assert.equal(d.body.settings.tariffs.length, 2);
});
