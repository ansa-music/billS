import type {
  ClubDetails,
  ClubSummary,
  CloudAlertView,
  CloudSessionView,
  DayStats,
  HourLoad,
  HubStatus,
  OwnerOverview,
  OwnerView,
  PeriodStats,
  SessionStatus,
  TableKind,
  TableStats,
} from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { addDays, dayStart, localDay, monthStart, sliceByHour } from './localtime.ts';
import type { ClubRow, StoredSettings } from './settings.ts';
import { loadSettings, tableNames, toClubSettings } from './settings.ts';

/** A HUB is "online" when it has synced within this window (sync interval is ~10 s). */
export const ONLINE_WINDOW_MS = 3 * 60_000;
const RECENT_SESSIONS = 20;
const RECENT_RESOLVED_ALERTS = 20;
const OVERVIEW_ALERTS = 100;
/** Statuses whose amount counts as revenue. */
const BILLED: readonly SessionStatus[] = ['AWAITING_PAYMENT', 'CLOSED'];

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export async function periodStats(db: SqlDriver, clubId: string, fromDay: string, toDay: string): Promise<PeriodStats> {
  const rows = await db.all<{ revenue: unknown; games: unknown; played: unknown }>(
    `SELECT COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(games), 0) AS games,
            COALESCE(SUM(played_seconds), 0) AS played
     FROM daily_stats WHERE club_id = ? AND day >= ? AND day <= ?`,
    [clubId, fromDay, toDay],
  );
  const r = rows[0];
  return { revenue: n(r?.revenue), games: n(r?.games), playedSeconds: n(r?.played) };
}

function sumStats(parts: PeriodStats[]): PeriodStats {
  return parts.reduce(
    (acc, p) => ({
      revenue: acc.revenue + p.revenue,
      games: acc.games + p.games,
      playedSeconds: acc.playedSeconds + p.playedSeconds,
    }),
    { revenue: 0, games: 0, playedSeconds: 0 },
  );
}

// ---------------------------------------------------------------------------
// Club summary
// ---------------------------------------------------------------------------

interface HubRowLite {
  id: string;
  name: string;
  last_seen_at: number | null;
  last_outbox_id: number | null;
  settings_version: number;
}

export async function hubStatus(db: SqlDriver, clubId: string, settingsVersion: number, now: number): Promise<HubStatus | null> {
  const rows = await db.all<HubRowLite>(
    'SELECT id, name, last_seen_at, last_outbox_id, settings_version FROM hubs WHERE club_id = ? ORDER BY created_at LIMIT 1',
    [clubId],
  );
  const h = rows[0];
  if (!h) return null;
  const lastSeenAt = h.last_seen_at === null ? null : Number(h.last_seen_at);
  return {
    id: h.id,
    name: h.name,
    lastSeenAt,
    online: lastSeenAt !== null && now - lastSeenAt < ONLINE_WINDOW_MS,
    lastOutboxId: h.last_outbox_id === null ? null : Number(h.last_outbox_id),
    settingsVersion: Number(h.settings_version),
    pendingSettings: settingsVersion > Number(h.settings_version),
  };
}

async function count(db: SqlDriver, sql: string, params: unknown[]): Promise<number> {
  const rows = await db.all<{ c: unknown }>(sql, params);
  return n(rows[0]?.c);
}

export async function clubSummary(
  db: SqlDriver,
  now: number,
  club: ClubRow,
  settings?: StoredSettings,
): Promise<ClubSummary> {
  const s = settings ?? (await loadSettings(db, club));
  const today = localDay(now, club.timezone);
  const [todayStats, week, month, openAlerts, liveGames, hub] = await Promise.all([
    periodStats(db, club.id, today, today),
    periodStats(db, club.id, addDays(today, -6), today),
    periodStats(db, club.id, monthStart(today), today),
    count(db, 'SELECT COUNT(*) AS c FROM alerts WHERE club_id = ? AND resolved_at IS NULL', [club.id]),
    count(db, "SELECT COUNT(*) AS c FROM sessions WHERE club_id = ? AND status IN ('OPENING', 'ACTIVE')", [club.id]),
    hubStatus(db, club.id, s.version, now),
  ]);
  return {
    id: club.id,
    name: club.name,
    timezone: club.timezone,
    currency: club.currency,
    today: todayStats,
    week,
    month,
    openAlerts,
    liveGames,
    tablesCount: s.tables.filter((t) => t.isActive).length,
    hub,
  };
}

// ---------------------------------------------------------------------------
// Alerts and sessions views
// ---------------------------------------------------------------------------

interface AlertRow {
  id: string;
  club_id: string;
  at: number;
  kind: string;
  table_id: string | null;
  session_id: string | null;
  message: string;
  resolved_at: number | null;
  resolved_by: string | null;
}

function alertView(a: AlertRow, clubName: string, tables: Map<string, string>): CloudAlertView {
  return {
    id: a.id,
    clubId: a.club_id,
    clubName,
    at: Number(a.at),
    kind: a.kind,
    tableId: a.table_id,
    tableName: a.table_id ? (tables.get(a.table_id) ?? null) : null,
    message: a.message,
    resolvedAt: a.resolved_at === null ? null : Number(a.resolved_at),
  };
}

interface SessionRow {
  id: string;
  club_id: string;
  table_id: string;
  status: SessionStatus;
  tariff_id: string | null;
  tariff_name: string | null;
  opened_by: string;
  requested_at: number;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
  billed_seconds: number | null;
  amount: number | null;
}

const opt = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function sessionView(s: SessionRow, tables: Map<string, string>): CloudSessionView {
  return {
    id: s.id,
    clubId: s.club_id,
    tableId: s.table_id,
    tableName: tables.get(s.table_id) ?? null,
    status: s.status,
    tariffName: s.tariff_name,
    openedBy: s.opened_by,
    requestedAt: Number(s.requested_at),
    startedAt: opt(s.started_at),
    stoppedAt: opt(s.stopped_at),
    billedSeconds: opt(s.billed_seconds),
    amount: opt(s.amount),
  };
}

/** Games requested on a local calendar day, newest first. */
export async function clubSessions(
  db: SqlDriver,
  club: ClubRow,
  day: string,
  settings?: StoredSettings,
): Promise<CloudSessionView[]> {
  const s = settings ?? (await loadSettings(db, club));
  const from = dayStart(day, club.timezone);
  const to = dayStart(addDays(day, 1), club.timezone);
  const rows = await db.all<SessionRow>(
    'SELECT * FROM sessions WHERE club_id = ? AND requested_at >= ? AND requested_at < ? ORDER BY requested_at DESC',
    [club.id, from, to],
  );
  const tables = tableNames(s);
  return rows.map((r) => sessionView(r, tables));
}

// ---------------------------------------------------------------------------
// Load by hour and by table (computed from sessions on read)
// ---------------------------------------------------------------------------

interface LoadRow {
  table_id: string;
  status: SessionStatus;
  started_at: number | null;
  stopped_at: number | null;
  amount: number | null;
  played_seconds: number | null;
}

/** Sessions that overlap [fromMs, toMs) or were billed inside it. */
async function loadRows(db: SqlDriver, clubId: string, fromMs: number, toMs: number): Promise<LoadRow[]> {
  return db.all<LoadRow>(
    `SELECT table_id, status, started_at, stopped_at, amount, played_seconds
     FROM sessions
     WHERE club_id = ? AND started_at IS NOT NULL AND started_at < ?
       AND (stopped_at IS NULL OR stopped_at > ?)`,
    [clubId, toMs, fromMs],
  );
}

interface HourAcc {
  busyMs: number[];
  games: number[];
}

function newHourAcc(): HourAcc {
  return { busyMs: new Array<number>(24).fill(0), games: new Array<number>(24).fill(0) };
}

/** Adds one game's busy time to the accumulator, clipped to [fromMs, toMs). Live games run until now. */
function accumulate(acc: HourAcc, row: LoadRow, timezone: string, fromMs: number, toMs: number, now: number): void {
  const started = Number(row.started_at);
  const from = Math.max(started, fromMs);
  const to = Math.min(row.stopped_at === null ? now : Number(row.stopped_at), toMs);
  if (to <= from) return;
  const touched = new Set<number>();
  sliceByHour(from, to, timezone, (hour, ms) => {
    acc.busyMs[hour] = (acc.busyMs[hour] ?? 0) + ms;
    touched.add(hour);
  });
  for (const h of touched) acc.games[h] = (acc.games[h] ?? 0) + 1;
}

const busySeconds = (acc: HourAcc): number[] => acc.busyMs.map((ms) => Math.round(ms / 1000));

export async function hourLoad(
  db: SqlDriver,
  club: ClubRow,
  now: number,
  fromMs: number,
  toMs: number,
): Promise<HourLoad[]> {
  const acc = newHourAcc();
  for (const row of await loadRows(db, club.id, fromMs, toMs)) accumulate(acc, row, club.timezone, fromMs, toMs, now);
  const seconds = busySeconds(acc);
  return seconds.map((s, hour) => ({ hour, busySeconds: s, games: acc.games[hour] ?? 0 }));
}

export async function tableStats(
  db: SqlDriver,
  club: ClubRow,
  settings: StoredSettings,
  now: number,
  fromMs: number,
  toMs: number,
): Promise<TableStats[]> {
  const byTable = new Map<string, { acc: HourAcc; revenue: number; games: number; playedSeconds: number }>();
  const entry = (tableId: string) => {
    let e = byTable.get(tableId);
    if (!e) {
      e = { acc: newHourAcc(), revenue: 0, games: 0, playedSeconds: 0 };
      byTable.set(tableId, e);
    }
    return e;
  };
  for (const row of await loadRows(db, club.id, fromMs, toMs)) {
    const e = entry(row.table_id);
    accumulate(e.acc, row, club.timezone, fromMs, toMs, now);
    const stopped = opt(row.stopped_at);
    if (stopped !== null && stopped >= fromMs && stopped < toMs && BILLED.includes(row.status)) {
      e.revenue += n(row.amount);
      e.games += 1;
      e.playedSeconds += n(row.played_seconds);
    }
  }
  const known = new Set<string>();
  const out: TableStats[] = settings.tables
    .filter((t) => t.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => {
      known.add(t.id);
      const e = byTable.get(t.id);
      return {
        id: t.id,
        name: t.name,
        kind: t.kind,
        revenue: e?.revenue ?? 0,
        games: e?.games ?? 0,
        playedSeconds: e?.playedSeconds ?? 0,
        byHour: e ? busySeconds(e.acc) : new Array<number>(24).fill(0),
      };
    });
  // Tables the HUB no longer reports but that still have games in the period.
  for (const [tableId, e] of byTable) {
    if (known.has(tableId)) continue;
    const kind: TableKind = 'pool';
    out.push({
      id: tableId,
      name: settings.tables.find((t) => t.id === tableId)?.name ?? tableId,
      kind,
      revenue: e.revenue,
      games: e.games,
      playedSeconds: e.playedSeconds,
      byHour: busySeconds(e.acc),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Owner screens
// ---------------------------------------------------------------------------

export async function companyClubs(db: SqlDriver, companyId: string): Promise<ClubRow[]> {
  return db.all<ClubRow>('SELECT * FROM clubs WHERE company_id = ? ORDER BY created_at, name', [companyId]);
}

export async function clubOfCompany(db: SqlDriver, companyId: string, clubId: string): Promise<ClubRow | null> {
  const rows = await db.all<ClubRow>('SELECT * FROM clubs WHERE id = ? AND company_id = ?', [clubId, companyId]);
  return rows[0] ?? null;
}

export async function overview(db: SqlDriver, now: number, owner: OwnerView): Promise<OwnerOverview> {
  const clubs = await companyClubs(db, owner.company.id);
  const settingsByClub = new Map<string, StoredSettings>();
  const summaries: ClubSummary[] = [];
  for (const club of clubs) {
    const settings = await loadSettings(db, club);
    settingsByClub.set(club.id, settings);
    summaries.push(await clubSummary(db, now, club, settings));
  }
  const alertRows = await db.all<AlertRow & { club_name: string }>(
    `SELECT a.*, c.name AS club_name FROM alerts a JOIN clubs c ON c.id = a.club_id
     WHERE c.company_id = ? AND a.resolved_at IS NULL ORDER BY a.at DESC LIMIT ${OVERVIEW_ALERTS}`,
    [owner.company.id],
  );
  const tablesOf = (clubId: string) => {
    const s = settingsByClub.get(clubId);
    return s ? tableNames(s) : new Map<string, string>();
  };
  return {
    serverNow: now,
    company: owner.company,
    clubs: summaries,
    totals: {
      today: sumStats(summaries.map((c) => c.today)),
      week: sumStats(summaries.map((c) => c.week)),
      month: sumStats(summaries.map((c) => c.month)),
    },
    alerts: alertRows.map((a) => alertView(a, a.club_name, tablesOf(a.club_id))),
  };
}

export async function clubDetails(db: SqlDriver, now: number, club: ClubRow): Promise<ClubDetails> {
  const settings = await loadSettings(db, club);
  const tables = tableNames(settings);
  const today = localDay(now, club.timezone);
  const tz = club.timezone;

  const summary = await clubSummary(db, now, club, settings);

  // Last 30 local days, zeros for days without games.
  const firstDay = addDays(today, -29);
  const dayRows = await db.all<{ day: string; revenue: unknown; games: unknown; played_seconds: unknown; alerts: unknown }>(
    'SELECT day, revenue, games, played_seconds, alerts FROM daily_stats WHERE club_id = ? AND day >= ? AND day <= ?',
    [club.id, firstDay, today],
  );
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const days: DayStats[] = [];
  for (let d = firstDay; d <= today; d = addDays(d, 1)) {
    const r = byDay.get(d);
    days.push({ day: d, revenue: n(r?.revenue), games: n(r?.games), playedSeconds: n(r?.played_seconds), alerts: n(r?.alerts) });
  }

  const tomorrowStart = dayStart(addDays(today, 1), tz);
  const hours = await hourLoad(db, club, now, dayStart(addDays(today, -6), tz), tomorrowStart);
  const tableRows = await tableStats(db, club, settings, now, dayStart(firstDay, tz), tomorrowStart);

  const openAlerts = await db.all<AlertRow>(
    'SELECT * FROM alerts WHERE club_id = ? AND resolved_at IS NULL ORDER BY at DESC',
    [club.id],
  );
  const resolvedAlerts = await db.all<AlertRow>(
    `SELECT * FROM alerts WHERE club_id = ? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ${RECENT_RESOLVED_ALERTS}`,
    [club.id],
  );
  const recent = await db.all<SessionRow>(
    `SELECT * FROM sessions WHERE club_id = ? ORDER BY requested_at DESC LIMIT ${RECENT_SESSIONS}`,
    [club.id],
  );

  return {
    club: summary,
    days,
    hours,
    tables: tableRows,
    alerts: [...openAlerts, ...resolvedAlerts].map((a) => alertView(a, club.name, tables)),
    recentSessions: recent.map((s) => sessionView(s, tables)),
    settings: toClubSettings(settings),
  };
}
