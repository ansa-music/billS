import type {
  ClubDetails,
  ClubSummary,
  CloudAlertView,
  CloudSessionView,
  CloudShiftView,
  DayStats,
  HourLoad,
  HubStatus,
  OwnerOverview,
  OwnerView,
  PaymentTotals,
  PeriodStats,
  PowerOutageView,
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
const DAY_MS = 24 * 60 * 60 * 1000;
/** Shifts closed within this window show on the overview. */
const RECENT_SHIFTS_MS = 7 * DAY_MS;
/** Club page: shifts and outages of the last 30 days. */
const CLUB_HISTORY_MS = 30 * DAY_MS;
/** Statuses whose amount was billed (counts for table load). */
const BILLED: readonly SessionStatus[] = ['AWAITING_PAYMENT', 'CLOSED'];
/** Games on the floor right now. */
const LIVE_STATUSES = "('OPENING', 'ACTIVE', 'PAUSED')";

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const opt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const zeroTotals = (): PaymentTotals => ({ cash: 0, card: 0, qr: 0, total: 0 });

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

interface StatsSums {
  billed: unknown;
  games: unknown;
  played: unknown;
  paid_total: unknown;
  paid_cash: unknown;
  paid_card: unknown;
  paid_qr: unknown;
  refunded: unknown;
  checks_paid: unknown;
  discounts: unknown;
  cancelled_games: unknown;
}

const STATS_SUMS = `COALESCE(SUM(revenue), 0) AS billed, COALESCE(SUM(games), 0) AS games,
            COALESCE(SUM(played_seconds), 0) AS played, COALESCE(SUM(paid_total), 0) AS paid_total,
            COALESCE(SUM(paid_cash), 0) AS paid_cash, COALESCE(SUM(paid_card), 0) AS paid_card,
            COALESCE(SUM(paid_qr), 0) AS paid_qr, COALESCE(SUM(refunded), 0) AS refunded,
            COALESCE(SUM(checks_paid), 0) AS checks_paid, COALESCE(SUM(discounts), 0) AS discounts,
            COALESCE(SUM(cancelled_games), 0) AS cancelled_games`;

/**
 * revenue = paid − refunded (what the till took, by the day of the payment);
 * billed = the `revenue` column of daily_stats (accrued on «Стоп», voids taken out).
 */
function toPeriodStats(r: StatsSums | undefined): PeriodStats {
  const paid: PaymentTotals = { cash: n(r?.paid_cash), card: n(r?.paid_card), qr: n(r?.paid_qr), total: n(r?.paid_total) };
  const refunded = n(r?.refunded);
  const checksPaid = n(r?.checks_paid);
  const revenue = paid.total - refunded;
  return {
    revenue,
    billed: n(r?.billed),
    games: n(r?.games),
    playedSeconds: n(r?.played),
    paid,
    refunded,
    checksPaid,
    discounts: n(r?.discounts),
    averageCheck: checksPaid > 0 ? Math.round(revenue / checksPaid) : 0,
    cancelledGames: n(r?.cancelled_games),
  };
}

export async function periodStats(db: SqlDriver, clubId: string, fromDay: string, toDay: string): Promise<PeriodStats> {
  const rows = await db.all<StatsSums>(
    `SELECT ${STATS_SUMS} FROM daily_stats WHERE club_id = ? AND day >= ? AND day <= ?`,
    [clubId, fromDay, toDay],
  );
  return toPeriodStats(rows[0]);
}

function addTotals(a: PaymentTotals, b: PaymentTotals): PaymentTotals {
  return { cash: a.cash + b.cash, card: a.card + b.card, qr: a.qr + b.qr, total: a.total + b.total };
}

function sumStats(parts: PeriodStats[]): PeriodStats {
  const acc = parts.reduce(
    (acc, p) => ({
      revenue: acc.revenue + p.revenue,
      billed: acc.billed + p.billed,
      games: acc.games + p.games,
      playedSeconds: acc.playedSeconds + p.playedSeconds,
      paid: addTotals(acc.paid, p.paid),
      refunded: acc.refunded + p.refunded,
      checksPaid: acc.checksPaid + p.checksPaid,
      discounts: acc.discounts + p.discounts,
      averageCheck: 0,
      cancelledGames: acc.cancelledGames + p.cancelledGames,
    }),
    toPeriodStats(undefined),
  );
  acc.averageCheck = acc.checksPaid > 0 ? Math.round(acc.revenue / acc.checksPaid) : 0;
  return acc;
}

// ---------------------------------------------------------------------------
// Shifts and outages
// ---------------------------------------------------------------------------

interface ShiftRow {
  id: string;
  club_id: string;
  number: number;
  status: 'OPEN' | 'CLOSED';
  opened_at: number;
  opened_by: string;
  opening_float: number;
  closed_at: number | null;
  closed_by: string | null;
  expected_cash: number | null;
  counted_cash: number | null;
  difference: number | null;
  note: string | null;
  net_total: number | null;
  net_cash: number | null;
  net_card: number | null;
  net_qr: number | null;
}

interface ShiftMoney {
  sales: PaymentTotals;
  refunds: PaymentTotals;
  paymentsCount: number;
  refundsCount: number;
  checksPaid: number;
  deposits: number;
  withdrawals: number;
}

function newShiftMoney(): ShiftMoney {
  return { sales: zeroTotals(), refunds: zeroTotals(), paymentsCount: 0, refundsCount: 0, checksPaid: 0, deposits: 0, withdrawals: 0 };
}

function addMethod(t: PaymentTotals, method: string, amount: number): void {
  if (method === 'CASH') t.cash += amount;
  else if (method === 'CARD') t.card += amount;
  else if (method === 'QR') t.qr += amount;
  t.total += amount;
}

/** Sales, refunds, cash movements and paid checks of each shift, from the projection tables. */
async function shiftMoney(db: SqlDriver, shiftIds: string[]): Promise<Map<string, ShiftMoney>> {
  const out = new Map<string, ShiftMoney>();
  if (shiftIds.length === 0) return out;
  const money = (id: string): ShiftMoney => {
    let m = out.get(id);
    if (!m) {
      m = newShiftMoney();
      out.set(id, m);
    }
    return m;
  };
  const marks = shiftIds.map(() => '?').join(', ');
  const payments = await db.all<{ shift_id: string; kind: string; method: string; amount: unknown; cnt: unknown }>(
    `SELECT shift_id, kind, method, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS cnt
     FROM payments WHERE shift_id IN (${marks}) GROUP BY shift_id, kind, method`,
    shiftIds,
  );
  for (const p of payments) {
    const m = money(p.shift_id);
    if (p.kind === 'REFUND') {
      addMethod(m.refunds, p.method, n(p.amount));
      m.refundsCount += n(p.cnt);
    } else {
      addMethod(m.sales, p.method, n(p.amount));
    }
  }
  const operations = await db.all<{ shift_id: string; ops: unknown }>(
    `SELECT shift_id, COUNT(DISTINCT operation_id) AS ops FROM payments
     WHERE kind = 'PAYMENT' AND shift_id IN (${marks}) GROUP BY shift_id`,
    shiftIds,
  );
  for (const o of operations) money(o.shift_id).paymentsCount = n(o.ops);
  const checks = await db.all<{ shift_id: string; c: unknown }>(
    `SELECT shift_id, COUNT(*) AS c FROM checks WHERE status = 'PAID' AND shift_id IN (${marks}) GROUP BY shift_id`,
    shiftIds,
  );
  for (const c of checks) money(c.shift_id).checksPaid = n(c.c);
  const movements = await db.all<{ shift_id: string; kind: string; amount: unknown }>(
    `SELECT shift_id, kind, COALESCE(SUM(amount), 0) AS amount FROM cash_movements
     WHERE shift_id IN (${marks}) GROUP BY shift_id, kind`,
    shiftIds,
  );
  for (const mv of movements) {
    const m = money(mv.shift_id);
    if (mv.kind === 'DEPOSIT') m.deposits += n(mv.amount);
    else m.withdrawals += n(mv.amount);
  }
  return out;
}

function shiftView(s: ShiftRow, clubName: string, m: ShiftMoney): CloudShiftView {
  const closed = s.status === 'CLOSED';
  // Once closed, the HUB's Z report is the truth; while open (or if the Z figures never came), sales − refunds.
  const net: PaymentTotals =
    closed && s.net_total !== null
      ? { cash: n(s.net_cash), card: n(s.net_card), qr: n(s.net_qr), total: n(s.net_total) }
      : {
          cash: m.sales.cash - m.refunds.cash,
          card: m.sales.card - m.refunds.card,
          qr: m.sales.qr - m.refunds.qr,
          total: m.sales.total - m.refunds.total,
        };
  return {
    id: s.id,
    clubId: s.club_id,
    clubName,
    number: n(s.number),
    status: s.status,
    openedAt: Number(s.opened_at),
    openedBy: s.opened_by,
    closedAt: opt(s.closed_at),
    closedBy: s.closed_by,
    openingFloat: n(s.opening_float),
    sales: m.sales,
    refunds: m.refunds,
    net,
    deposits: m.deposits,
    withdrawals: m.withdrawals,
    expectedCash: closed ? opt(s.expected_cash) : null,
    countedCash: closed ? opt(s.counted_cash) : null,
    difference: closed ? opt(s.difference) : null,
    note: closed ? s.note : null,
    checksPaid: m.checksPaid,
    paymentsCount: m.paymentsCount,
    refundsCount: m.refundsCount,
  };
}

/** Builds the views for shift rows, resolving club names through `clubName`. */
async function shiftViews(db: SqlDriver, rows: ShiftRow[], clubName: (clubId: string) => string): Promise<CloudShiftView[]> {
  const money = await shiftMoney(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => shiftView(r, clubName(r.club_id), money.get(r.id) ?? newShiftMoney()));
}

async function oneShift(db: SqlDriver, club: ClubRow, where: string, params: unknown[]): Promise<CloudShiftView | null> {
  const rows = await db.all<ShiftRow>(`SELECT * FROM shifts WHERE club_id = ? AND ${where} LIMIT 1`, [club.id, ...params]);
  const views = await shiftViews(db, rows, () => club.name);
  return views[0] ?? null;
}

/** Shifts of a club in the last 30 days: the open one first, then by close time, newest first. */
export async function clubShifts(db: SqlDriver, club: ClubRow, now: number): Promise<CloudShiftView[]> {
  const rows = await db.all<ShiftRow>(
    `SELECT * FROM shifts WHERE club_id = ? AND (status = 'OPEN' OR closed_at >= ?)
     ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END, COALESCE(closed_at, opened_at) DESC, opened_at DESC`,
    [club.id, now - CLUB_HISTORY_MS],
  );
  return shiftViews(db, rows, () => club.name);
}

/** Shifts closed in the last 7 days across every club of the company, newest first. */
export async function recentShifts(db: SqlDriver, companyId: string, now: number): Promise<CloudShiftView[]> {
  const rows = await db.all<ShiftRow & { club_name: string }>(
    `SELECT s.*, c.name AS club_name FROM shifts s JOIN clubs c ON c.id = s.club_id
     WHERE c.company_id = ? AND s.status = 'CLOSED' AND s.closed_at >= ?
     ORDER BY s.closed_at DESC`,
    [companyId, now - RECENT_SHIFTS_MS],
  );
  const names = new Map(rows.map((r) => [r.club_id, r.club_name]));
  return shiftViews(db, rows, (clubId) => names.get(clubId) ?? '');
}

interface OutageRow {
  id: string;
  club_id: string;
  started_at: number;
  ended_at: number | null;
  critical: number;
  paused_games: number;
}

export async function clubOutages(db: SqlDriver, club: ClubRow, now: number): Promise<PowerOutageView[]> {
  const rows = await db.all<OutageRow>(
    'SELECT * FROM power_outages WHERE club_id = ? AND started_at >= ? ORDER BY started_at DESC',
    [club.id, now - CLUB_HISTORY_MS],
  );
  return rows.map((r) => ({
    id: r.id,
    clubId: r.club_id,
    startedAt: Number(r.started_at),
    endedAt: opt(r.ended_at),
    critical: n(r.critical) === 1,
    pausedGames: n(r.paused_games),
  }));
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
  const [todayStats, week, month, openAlerts, liveGames, hub, openShift, lastClosedShift] = await Promise.all([
    periodStats(db, club.id, today, today),
    periodStats(db, club.id, addDays(today, -6), today),
    periodStats(db, club.id, monthStart(today), today),
    count(db, 'SELECT COUNT(*) AS c FROM alerts WHERE club_id = ? AND resolved_at IS NULL', [club.id]),
    count(db, `SELECT COUNT(*) AS c FROM sessions WHERE club_id = ? AND status IN ${LIVE_STATUSES}`, [club.id]),
    hubStatus(db, club.id, s.version, now),
    oneShift(db, club, "status = 'OPEN' ORDER BY opened_at DESC", []),
    oneShift(db, club, "status = 'CLOSED' ORDER BY closed_at DESC", []),
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
    openShift,
    lastClosedShift,
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
  stopped_by: string | null;
  requested_at: number;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
  billed_seconds: number | null;
  paused_seconds: number | null;
  amount: number | null;
  failure_reason: string | null;
  check_id: string | null;
  check_number: number | null;
  paid_at: number | null;
  cancel_reason: string | null;
  cancel_approved_by: string | null;
  prepaid_minutes: number | null;
  pause_started_at: number | null;
  pause_reason: string | null;
}

/** sessions joined with the check number; `where` and `order` are appended as given. */
const SESSION_SELECT = 'SELECT s.*, c.number AS check_number FROM sessions s LEFT JOIN checks c ON c.id = s.check_id';

function sessionView(s: SessionRow, tables: Map<string, string>): CloudSessionView {
  const paused = s.status === 'PAUSED';
  return {
    id: s.id,
    clubId: s.club_id,
    tableId: s.table_id,
    tableName: tables.get(s.table_id) ?? null,
    status: s.status,
    tariffName: s.tariff_name,
    openedBy: s.opened_by,
    stoppedBy: s.stopped_by,
    requestedAt: Number(s.requested_at),
    startedAt: opt(s.started_at),
    stoppedAt: opt(s.stopped_at),
    billedSeconds: opt(s.billed_seconds),
    pausedSeconds: opt(s.paused_seconds),
    amount: opt(s.amount),
    checkId: s.check_id,
    checkNumber: opt(s.check_number),
    paidAt: opt(s.paid_at),
    cancelReason: s.cancel_reason ?? s.failure_reason,
    cancelApprovedBy: s.cancel_approved_by,
    prepaidMinutes: opt(s.prepaid_minutes),
    pausedAt: paused ? opt(s.pause_started_at) : null,
    pauseReason: paused ? s.pause_reason : null,
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
    `${SESSION_SELECT} WHERE s.club_id = ? AND s.requested_at >= ? AND s.requested_at < ? ORDER BY s.requested_at DESC`,
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

/**
 * Per table over the period. `revenue` here is what the table was billed on «Стоп»
 * (the load of the table), not what was paid: payments belong to checks, not tables.
 */
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
    recentShifts: await recentShifts(db, owner.company.id, now),
  };
}

interface DayRow extends StatsSums {
  day: string;
  alerts: unknown;
}

export async function clubDetails(db: SqlDriver, now: number, club: ClubRow): Promise<ClubDetails> {
  const settings = await loadSettings(db, club);
  const tables = tableNames(settings);
  const today = localDay(now, club.timezone);
  const tz = club.timezone;

  const summary = await clubSummary(db, now, club, settings);

  // Last 30 local days, zeros for days without games.
  const firstDay = addDays(today, -29);
  const dayRows = await db.all<DayRow>(
    `SELECT day, ${STATS_SUMS}, COALESCE(SUM(alerts), 0) AS alerts
     FROM daily_stats WHERE club_id = ? AND day >= ? AND day <= ? GROUP BY day`,
    [club.id, firstDay, today],
  );
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const days: DayStats[] = [];
  for (let d = firstDay; d <= today; d = addDays(d, 1)) {
    const r = byDay.get(d);
    const p = toPeriodStats(r);
    days.push({
      day: d,
      revenue: p.revenue,
      billed: p.billed,
      games: p.games,
      playedSeconds: p.playedSeconds,
      paid: p.paid,
      refunded: p.refunded,
      checksPaid: p.checksPaid,
      discounts: p.discounts,
      alerts: n(r?.alerts),
      cancelledGames: p.cancelledGames,
    });
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
    `${SESSION_SELECT} WHERE s.club_id = ? ORDER BY s.requested_at DESC LIMIT ${RECENT_SESSIONS}`,
    [club.id],
  );

  return {
    club: summary,
    days,
    hours,
    tables: tableRows,
    alerts: [...openAlerts, ...resolvedAlerts].map((a) => alertView(a, club.name, tables)),
    recentSessions: recent.map((s) => sessionView(s, tables)),
    shifts: await clubShifts(db, club, now),
    outages: await clubOutages(db, club, now),
    settings: toClubSettings(settings),
  };
}
