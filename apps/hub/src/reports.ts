import type { OwnerSummary, RevenuePoint, TableStat } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';

export interface ReportServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

const HOUR_MS = 60 * 60 * 1000;
const DAYS_IN_CHART = 14;

/** Statuses of games whose bill is final: they make up the revenue. */
const STOPPED = "('AWAITING_PAYMENT', 'CLOSED')";

// ── Local calendar without libraries ──────────────────────────────────────────

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    partFormatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in the zone. */
function wallClock(epochMs: number, timeZone: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const out = { y: 0, m: 0, d: 0, h: 0, min: 0, s: 0 };
  for (const p of partsFormatter(timeZone).formatToParts(new Date(epochMs))) {
    const v = Number(p.value);
    if (p.type === 'year') out.y = v;
    else if (p.type === 'month') out.m = v;
    else if (p.type === 'day') out.d = v;
    else if (p.type === 'hour') out.h = v;
    else if (p.type === 'minute') out.min = v;
    else if (p.type === 'second') out.s = v;
  }
  return out;
}

/** Zone offset (local − UTC) in ms at the given instant. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const w = wallClock(epochMs, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  // formatToParts drops milliseconds: compare on whole seconds.
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD into calendar fields; null when malformed or not a real date. */
export function parseLocalDate(value: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatLocalDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Calendar arithmetic on YYYY-MM-DD, independent of any zone. */
export function addDays(date: string, days: number): string {
  const p = parseLocalDate(date);
  if (!p) throw new Error(`Bad date ${date}`);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return formatLocalDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
function isoWeekday(date: string): number {
  const p = parseLocalDate(date);
  if (!p) throw new Error(`Bad date ${date}`);
  const js = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Local date YYYY-MM-DD of an instant in the zone. */
export function localDateOf(epochMs: number, timeZone: string): string {
  const w = wallClock(epochMs, timeZone);
  return formatLocalDate(w.y, w.m, w.d);
}

/**
 * UTC instant of local midnight on the given date in the IANA zone. Starts from
 * the same wall-clock read as UTC and corrects by the zone offset; a second
 * pass catches a DST change between the guess and the answer. When midnight
 * falls into a DST gap the instant right after the gap is returned.
 */
export function localMidnightUtc(date: string, timeZone: string): number {
  const p = parseLocalDate(date);
  if (!p) throw new Error(`Bad date ${date}`);
  const wall = Date.UTC(p.y, p.m - 1, p.d);
  let guess = wall - zoneOffsetMs(wall, timeZone);
  for (let i = 0; i < 2; i++) {
    const next = wall - zoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

interface Period {
  start: number;
  /** Exclusive. */
  end: number;
}

function dayPeriod(date: string, timeZone: string): Period {
  return { start: localMidnightUtc(date, timeZone), end: localMidnightUtc(addDays(date, 1), timeZone) };
}

function weekPeriod(date: string, timeZone: string): Period {
  const monday = addDays(date, 1 - isoWeekday(date));
  return { start: localMidnightUtc(monday, timeZone), end: localMidnightUtc(addDays(monday, 7), timeZone) };
}

function monthPeriod(date: string, timeZone: string): Period {
  const p = parseLocalDate(date)!;
  const first = formatLocalDate(p.y, p.m, 1);
  const nextFirst = p.m === 12 ? formatLocalDate(p.y + 1, 1, 1) : formatLocalDate(p.y, p.m + 1, 1);
  return { start: localMidnightUtc(first, timeZone), end: localMidnightUtc(nextFirst, timeZone) };
}

// ── Service ───────────────────────────────────────────────────────────────────

interface ClubRow {
  id: string;
  timezone: string;
  currency: string;
}

interface GameRow {
  table_id: string;
  started_at: number | null;
  stopped_at: number | null;
  status: string;
  amount: number | null;
}

/** Read-only owner summary over the club's games, bar orders and alerts: see api.ts (OwnerSummary). */
export class ReportService {
  readonly deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this.deps = deps;
  }

  /** @param dateParam local club date YYYY-MM-DD; default today in the club zone. */
  summary(dateParam?: string): OwnerSummary {
    const { db, clock } = this.deps;
    const now = clock.now();
    const club = one<ClubRow>(db, 'SELECT id, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
    if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
    const tz = club.timezone;

    let date: string;
    if (dateParam === undefined || dateParam === '') {
      date = localDateOf(now, tz);
    } else {
      if (!parseLocalDate(dateParam)) throw new HubError(400, 'BAD_DATE', 'Дата должна быть в формате ГГГГ-ММ-ДД');
      date = dateParam;
    }

    const today = dayPeriod(date, tz);
    const week = weekPeriod(date, tz);
    const month = monthPeriod(date, tz);

    const todayStat = this.#periodRevenue(club.id, today);
    const weekStat = this.#periodRevenue(club.id, week);
    const monthStat = this.#periodRevenue(club.id, month);

    const live = one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM table_sessions WHERE club_id = ? AND status IN ('OPENING', 'ACTIVE')",
      club.id,
    );
    const unpaid = one<{ n: number; amount: number | null; orders: number | null }>(
      db,
      `SELECT COUNT(*) AS n, SUM(s.amount) AS amount,
              (SELECT SUM(o.total) FROM bar_orders o JOIN table_sessions u ON u.id = o.session_id
                WHERE o.club_id = s.club_id AND o.status = 'OPEN' AND u.status = 'AWAITING_PAYMENT') AS orders
       FROM table_sessions s WHERE s.club_id = ? AND s.status = 'AWAITING_PAYMENT'`,
      club.id,
    );
    const alerts = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL');

    return {
      generatedAt: now,
      date,
      timezone: tz,
      currency: club.currency,
      revenue: { today: todayStat.amount, week: weekStat.amount, month: monthStat.amount },
      games: { today: todayStat.games, week: weekStat.games, month: monthStat.games },
      avgCheck: todayStat.games > 0 ? Math.round(todayStat.amount / todayStat.games) : 0,
      occupancyByHour: this.#occupancyByHour(club.id, today, now),
      revenueByDay: this.#revenueByDay(club.id, date, tz),
      topTables: this.#topTables(club.id, month),
      openAlerts: alerts?.n ?? 0,
      liveGames: live?.n ?? 0,
      unpaidGames: unpaid?.n ?? 0,
      unpaidAmount: (unpaid?.amount ?? 0) + (unpaid?.orders ?? 0),
    };
  }

  /** Time revenue of stopped games plus open bar orders created in the period. */
  #periodRevenue(club: string, p: Period): { amount: number; games: number } {
    const { db } = this.deps;
    const games = one<{ n: number; amount: number | null }>(
      db,
      `SELECT COUNT(*) AS n, SUM(amount) AS amount FROM table_sessions
       WHERE club_id = ? AND status IN ${STOPPED} AND stopped_at >= ? AND stopped_at < ?`,
      club,
      p.start,
      p.end,
    );
    const orders = one<{ total: number | null }>(
      db,
      `SELECT SUM(total) AS total FROM bar_orders
       WHERE club_id = ? AND status = 'OPEN' AND created_at >= ? AND created_at < ?`,
      club,
      p.start,
      p.end,
    );
    return { amount: (games?.amount ?? 0) + (orders?.total ?? 0), games: games?.n ?? 0 };
  }

  #occupancyByHour(club: string, day: Period, now: number): number[] {
    const { db } = this.deps;
    const tables = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM billiard_tables WHERE club_id = ? AND is_active = 1', club);
    const tableCount = tables?.n ?? 0;
    const hours = new Array<number>(24).fill(0);
    if (tableCount === 0) return hours;

    const rows = all<GameRow>(
      db,
      `SELECT s.table_id, s.started_at, s.stopped_at, s.status, s.amount
       FROM table_sessions s JOIN billiard_tables t ON t.id = s.table_id
       WHERE s.club_id = ? AND t.is_active = 1 AND s.started_at IS NOT NULL
         AND s.status NOT IN ('CANCELLED', 'FAILED')
         AND s.started_at < ? AND (s.stopped_at IS NULL OR s.stopped_at > ?)`,
      club,
      day.end,
      day.start,
    );
    const busy = new Array<number>(24).fill(0); // ms of table time per hour
    for (const r of rows) {
      const from = r.started_at!;
      const to = r.stopped_at ?? Math.max(now, from);
      for (let h = 0; h < 24; h++) {
        const hs = day.start + h * HOUR_MS;
        const he = Math.min(hs + HOUR_MS, day.end);
        if (he <= hs) break;
        const overlap = Math.min(to, he) - Math.max(from, hs);
        if (overlap > 0) busy[h]! += overlap;
      }
    }
    for (let h = 0; h < 24; h++) {
      const share = busy[h]! / (HOUR_MS * tableCount);
      hours[h] = Math.round(Math.min(1, Math.max(0, share)) * 1000) / 1000;
    }
    return hours;
  }

  #revenueByDay(club: string, date: string, tz: string): RevenuePoint[] {
    const { db } = this.deps;
    const dates: string[] = [];
    for (let i = DAYS_IN_CHART - 1; i >= 0; i--) dates.push(addDays(date, -i));
    const bounds = dates.map((d) => localMidnightUtc(d, tz));
    bounds.push(localMidnightUtc(addDays(date, 1), tz));
    const points: RevenuePoint[] = dates.map((d) => ({ date: d, amount: 0, games: 0 }));
    const bucketOf = (at: number): number => {
      let i = 0;
      while (i + 1 < bounds.length && at >= bounds[i + 1]!) i++;
      return i;
    };
    const rangeStart = bounds[0]!;
    const rangeEnd = bounds[bounds.length - 1]!;
    for (const r of all<{ stopped_at: number; amount: number | null }>(
      db,
      `SELECT stopped_at, amount FROM table_sessions
       WHERE club_id = ? AND status IN ${STOPPED} AND stopped_at >= ? AND stopped_at < ?`,
      club,
      rangeStart,
      rangeEnd,
    )) {
      const p = points[bucketOf(r.stopped_at)]!;
      p.amount += r.amount ?? 0;
      p.games += 1;
    }
    for (const o of all<{ created_at: number; total: number }>(
      db,
      `SELECT created_at, total FROM bar_orders
       WHERE club_id = ? AND status = 'OPEN' AND created_at >= ? AND created_at < ?`,
      club,
      rangeStart,
      rangeEnd,
    )) {
      points[bucketOf(o.created_at)]!.amount += o.total;
    }
    return points;
  }

  /** Time revenue per active table this month (bar orders excluded), best first. */
  #topTables(club: string, month: Period): TableStat[] {
    const { db } = this.deps;
    return all<{ id: string; name: string; revenue: number | null; games: number; seconds: number | null }>(
      db,
      `SELECT t.id, t.name, SUM(s.amount) AS revenue, COUNT(s.id) AS games, SUM(s.billed_seconds) AS seconds
       FROM billiard_tables t
       LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status IN ${STOPPED}
         AND s.stopped_at >= ? AND s.stopped_at < ?
       WHERE t.club_id = ? AND t.is_active = 1
       GROUP BY t.id
       ORDER BY revenue DESC, games DESC, t.sort_order, t.name
       LIMIT 10`,
      month.start,
      month.end,
      club,
    ).map((r) => ({ tableId: r.id, name: r.name, revenue: r.revenue ?? 0, games: r.games, seconds: r.seconds ?? 0 }));
  }
}
