import type {
  AlertView,
  CashMovementView,
  CheckItemView,
  CheckPaymentView,
  CheckStatus,
  CheckView,
  ClubSettings,
  DiscountKind,
  HubState,
  LicenseStatus,
  OrderItemView,
  OrderView,
  PauseReason,
  PauseSpan,
  PaymentMethod,
  PowerView,
  SessionStatus,
  SessionView,
  ShiftLedger,
  ShiftStatus,
  ShiftView,
  SyncStatus,
  TableView,
  TariffConfig,
} from '@bills/domain';
import {
  calculateChargeWithPauses,
  checkTotals,
  minorPerMajor,
  normalizeClubSettings,
  prepaidDeadline,
  shiftTotals,
  unpaidSpans,
} from '@bills/domain';
import type { Db, Param } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import { getManualMode } from './manual-mode.ts';

export type { AlertView, CheckView, HubState, SessionView, ShiftView, TableView };

/** Status as stored: PAUSED is ACTIVE plus an open pause (see migration 007). */
export type StoredSessionStatus = Exclude<SessionStatus, 'PAUSED'>;

export interface SessionRow {
  id: string;
  club_id: string;
  table_id: string;
  tariff_id: string;
  tariff_name: string;
  tariff_snapshot: string;
  timezone: string;
  status: StoredSessionStatus;
  requested_at: number;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
  billed_seconds: number | null;
  amount: number | null;
  paused_seconds: number | null;
  failure_reason: string | null;
  opened_by: string;
  stopped_by: string | null;
  cancel_reason: string | null;
  cancel_approved_by: string | null;
  /** Opened in manual mode (1): billing started at the button press. */
  manual: number;
  /** Joined from check_items. */
  check_id: string | null;
  /** The open pause, if any (joined from session_pauses). */
  pause_id: string | null;
  pause_reason: PauseReason | null;
  pause_started_at: number | null;
  resume_requested_at: number | null;
  /** Joined from prepaid_games. */
  prepaid_minutes: number | null;
  prepaid_deadline_at: number | null;
  prepaid_amount: number | null;
  prepaid_check_id: string | null;
  prepaid_warned_at: number | null;
}

/** The club this HUB serves. */
export function clubId(db: Db): string {
  const club = one<{ id: string }>(db, 'SELECT id FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
  return club.id;
}

/** Sum of open bar orders on a game, minor units. */
export function ordersTotalOf(db: Db, sessionId: string): number {
  return (
    one<{ total: number | null }>(
      db,
      "SELECT SUM(total) AS total FROM bar_orders WHERE session_id = ? AND status = 'OPEN'",
      sessionId,
    )?.total ?? 0
  );
}

export interface PauseRow {
  id: string;
  session_id: string;
  reason: PauseReason;
  paused_at: number;
  resume_requested_at: number | null;
  resumed_at: number | null;
  paused_by: string;
  resumed_by: string | null;
  from_table_id: string | null;
  to_table_id: string | null;
}

/**
 * A game with the check it is billed on, its open pause and its prepaid time. Append `WHERE s.…` conditions.
 * Exported under both names the HUB modules use.
 */
export const SESSION_SQL = `
  SELECT s.*, ci.check_id AS check_id,
         p.id AS pause_id, p.reason AS pause_reason, p.paused_at AS pause_started_at, p.resume_requested_at,
         pg.minutes AS prepaid_minutes, pg.deadline_at AS prepaid_deadline_at, pg.amount AS prepaid_amount,
         pg.check_id AS prepaid_check_id, pg.warned_at AS prepaid_warned_at
  FROM table_sessions s
  LEFT JOIN check_items ci ON ci.session_id = s.id
  LEFT JOIN session_pauses p ON p.session_id = s.id AND p.resumed_at IS NULL
  LEFT JOIN prepaid_games pg ON pg.session_id = s.id`;
export const SESSION_SELECT = SESSION_SQL;

export function effectiveStatus(row: Pick<SessionRow, 'status' | 'pause_id'>): SessionStatus {
  return row.status === 'ACTIVE' && row.pause_id !== null ? 'PAUSED' : row.status;
}

export function loadSessionRow(db: Db, id: string): SessionRow | undefined {
  return one<SessionRow>(db, `${SESSION_SQL} WHERE s.id = ?`, id);
}

/** Pauses of the given games (any status), keyed by game id. */
export function loadPauseSpansByIds(db: Db, sessionIds: string[]): Map<string, PauseSpan[]> {
  const map = new Map<string, PauseSpan[]>();
  if (sessionIds.length === 0) return map;
  const rows = all<PauseRow>(
    db,
    `SELECT * FROM session_pauses WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY paused_at, rowid`,
    JSON.stringify(sessionIds),
  );
  for (const r of rows) {
    let list = map.get(r.session_id);
    if (!list) {
      list = [];
      map.set(r.session_id, list);
    }
    list.push(toPauseSpan(r));
  }
  return map;
}

export function toPauseSpan(p: PauseRow): PauseSpan {
  return { from: p.paused_at, to: p.resumed_at, reason: p.reason };
}

export function loadPauseSpans(db: Db, sessionId: string): PauseSpan[] {
  return all<PauseRow>(db, 'SELECT * FROM session_pauses WHERE session_id = ? ORDER BY paused_at, rowid', sessionId).map(
    toPauseSpan,
  );
}

/** Pauses of many games at once, keyed by game id. */
export function loadPauseSpansFor(db: Db, clubId: string, statuses: readonly StoredSessionStatus[]): Map<string, PauseSpan[]> {
  const marks = statuses.map(() => '?').join(', ');
  const rows = all<PauseRow>(
    db,
    `SELECT p.* FROM session_pauses p
     JOIN table_sessions s ON s.id = p.session_id
     WHERE s.club_id = ? AND s.status IN (${marks})
     ORDER BY p.paused_at, p.rowid`,
    clubId,
    ...statuses,
  );
  const map = new Map<string, PauseSpan[]>();
  for (const r of rows) {
    let list = map.get(r.session_id);
    if (!list) {
      list = [];
      map.set(r.session_id, list);
    }
    list.push(toPauseSpan(r));
  }
  return map;
}

/** `ordersTotal` — open bar orders on the game (stage 4), shown next to the time charge. */
export function toSessionView(row: SessionRow, pauses: PauseSpan[], now: number, ordersTotal = 0): SessionView {
  const tariff = JSON.parse(row.tariff_snapshot) as TariffConfig;
  const status = effectiveStatus(row);
  let { amount, played_seconds: playedSeconds, billed_seconds: billedSeconds, paused_seconds: pausedSeconds } = row;
  if ((status === 'ACTIVE' || status === 'PAUSED') && row.started_at !== null) {
    const end = Math.max(now, row.started_at);
    const charge = calculateChargeWithPauses(row.started_at, end, unpaidSpans(pauses, tariff, end), tariff, row.timezone);
    amount = charge.amount;
    playedSeconds = charge.playedSeconds;
    billedSeconds = charge.billedSeconds;
    pausedSeconds = charge.pausedSeconds;
  }
  return {
    id: row.id,
    tableId: row.table_id,
    status,
    tariffId: row.tariff_id,
    tariffName: row.tariff_name,
    tariff,
    timezone: row.timezone,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    playedSeconds,
    billedSeconds,
    amount,
    pausedSeconds,
    pauses,
    pausedAt: status === 'PAUSED' ? row.pause_started_at : null,
    resumeRequestedAt: status === 'PAUSED' ? row.resume_requested_at : null,
    ordersTotal,
    failureReason: row.failure_reason,
    openedBy: row.opened_by,
    stoppedBy: row.stopped_by,
    manual: row.manual === 1,
    checkId: row.check_id ?? null,
    cancelReason: row.cancel_reason ?? null,
    cancelApprovedBy: row.cancel_approved_by ?? null,
    prepaid:
      row.prepaid_minutes == null
        ? null
        : {
            minutes: row.prepaid_minutes,
            until:
              row.prepaid_deadline_at ??
              (row.started_at === null ? null : prepaidDeadline(row.started_at, row.prepaid_minutes)),
            amount: row.prepaid_amount,
            checkId: row.prepaid_check_id,
            warnedAt: row.prepaid_warned_at,
          },
  };
}

export function loadSession(db: Db, id: string, now: number): SessionView {
  const row = loadSessionRow(db, id);
  if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
  return toSessionView(row, loadPauseSpans(db, id), now, ordersTotalOf(db, id));
}

export function loadSettings(db: Db, club: string): ClubSettings {
  const row = one<{ settings: string }>(db, 'SELECT settings FROM clubs WHERE id = ?', club);
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row?.settings ?? '{}');
  } catch {
    // A damaged JSON must not take the hall screen down: fall back to defaults.
  }
  return normalizeClubSettings(parsed);
}

export interface OrderRow {
  id: string;
  club_id: string;
  session_id: string;
  table_id: string;
  status: OrderView['status'];
  note: string | null;
  total: number;
  created_at: number;
  created_by: string;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  check_id: string | null;
  closed_at: number | null;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  title: string;
  price: number;
  qty: number;
  amount: number;
}

export function toOrderViews(db: Db, rows: OrderRow[]): OrderView[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = new Map<string, OrderItemView[]>();
  for (const it of all<OrderItemRow>(
    db,
    `SELECT id, order_id, product_id, title, price, qty, amount FROM bar_order_items
     WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`,
    ...ids,
  )) {
    let list = items.get(it.order_id);
    if (!list) items.set(it.order_id, (list = []));
    list.push({ id: it.id, productId: it.product_id, title: it.title, price: it.price, qty: it.qty, amount: it.amount });
  }
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    tableId: r.table_id,
    status: r.status,
    note: r.note,
    items: items.get(r.id) ?? [],
    total: r.total,
    createdAt: r.created_at,
    createdBy: r.created_by,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancelReason: r.cancel_reason,
    checkId: r.check_id ?? null,
    closedAt: r.closed_at ?? null,
  }));
}

export function loadOrder(db: Db, id: string): OrderView {
  const row = one<OrderRow>(db, 'SELECT * FROM bar_orders WHERE id = ?', id);
  if (!row) throw new HubError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
  return toOrderViews(db, [row])[0]!;
}

/**
 * Open bar orders on games that are live or waiting for payment, plus open orders on
 * no check whose game is over (paid on a check of their own); totals per game.
 */
function openOrders(db: Db, club: string): { orders: OrderView[]; bySession: Map<string, number> } {
  const orders = toOrderViews(
    db,
    all<OrderRow>(
      db,
      `SELECT o.* FROM bar_orders o JOIN table_sessions s ON s.id = o.session_id
       WHERE o.club_id = ? AND o.status = 'OPEN'
         AND (s.status IN ('OPENING', 'ACTIVE', 'AWAITING_PAYMENT') OR o.check_id IS NULL)
       ORDER BY o.created_at`,
      club,
    ),
  );
  const bySession = new Map<string, number>();
  for (const o of orders) bySession.set(o.sessionId, (bySession.get(o.sessionId) ?? 0) + o.total);
  return { orders, bySession };
}

/** `power` comes from the power monitor and `sync` from the sync worker (or `syncStatus(db, false)` without a cloud). */
export function buildState(db: Db, now: number, power: PowerView, sync: SyncStatus, license: LicenseStatus | null = null): HubState {
  const club = one<HubState['club']>(db, 'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

  const settings = loadSettings(db, club.id);

  const tariffs = all<{ id: string; name: string; config: string }>(
    db,
    'SELECT id, name, config FROM tariffs WHERE club_id = ? AND is_active = 1 ORDER BY name',
    club.id,
  ).map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) as TariffConfig }));

  const pauses = loadPauseSpansFor(db, club.id, ['OPENING', 'ACTIVE', 'AWAITING_PAYMENT']);
  const { orders, bySession: ordersBySession } = openOrders(db, club.id);
  const view = (r: SessionRow) => toSessionView(r, pauses.get(r.id) ?? [], now, ordersBySession.get(r.id) ?? 0);

  const live = new Map(
    all<SessionRow>(db, `${SESSION_SQL} WHERE s.club_id = ? AND s.status IN ('OPENING', 'ACTIVE')`, club.id).map((r) => [
      r.table_id,
      view(r),
    ]),
  );

  const tables = all<{
    id: string;
    name: string;
    kind: TableView['kind'];
    default_tariff_id: string;
    desired: 'ON' | 'OFF' | null;
    reported: 'ON' | 'OFF' | 'UNKNOWN' | null;
    blink: number | null;
    current_on: number | null;
    polled_at: number | null;
  }>(
    db,
    `SELECT t.id, t.name, t.kind, t.default_tariff_id, l.desired, l.reported, l.blink, l.current_on, l.polled_at
     FROM billiard_tables t LEFT JOIN lamp_states l ON l.table_id = t.id
     WHERE t.club_id = ? AND t.is_active = 1
     ORDER BY t.sort_order, t.name`,
    club.id,
  ).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    defaultTariffId: t.default_tariff_id,
    lamp: {
      desired: t.desired ?? 'OFF',
      reported: t.reported ?? 'UNKNOWN',
      blink: (t.desired ?? 'OFF') === 'ON' && t.blink === 1,
      currentOn: t.current_on === null || t.current_on === undefined ? null : t.current_on === 1,
      polledAt: t.polled_at ?? null,
    },
    session: live.get(t.id) ?? null,
  }));

  const unpaid = all<SessionRow>(
    db,
    `${SESSION_SQL} WHERE s.club_id = ? AND s.status = 'AWAITING_PAYMENT' ORDER BY s.stopped_at`,
    club.id,
  ).map(view);

  const alerts = all<AlertView>(
    db,
    `SELECT id, at, kind, table_id AS tableId, message FROM alerts
     WHERE resolved_at IS NULL ORDER BY at DESC LIMIT 20`,
  );

  const checks = loadChecksWhere(db, "c.club_id = ? AND c.status = 'OPEN' ORDER BY c.number", club.id);
  const open = openShiftRow(db, club.id);
  const shift = open ? toShiftView(db, open) : null;

  return {
    serverNow: now,
    club,
    settings,
    tariffs,
    tables,
    unpaid,
    orders,
    checks,
    shift,
    alerts,
    manualMode: getManualMode(db),
    power,
    sync,
    license,
  };
}

// ── Checks ───────────────────────────────────────────────────────────────────

interface CheckRow {
  id: string;
  club_id: string;
  number: number;
  status: CheckStatus;
  discount_kind: DiscountKind | null;
  discount_value: number | null;
  discount_reason: string | null;
  discount_by: string | null;
  created_at: number;
  created_by: string;
  closed_at: number | null;
  updated_at: number;
  currency: string;
}

interface CheckItemRow {
  id: string;
  check_id: string;
  kind: 'GAME' | 'ORDER';
  session_id: string | null;
  title: string;
  amount: number;
  order_id: string | null;
  qty: number | null;
  unit_price: number | null;
  /** The game of the line: its own for GAME, the order's game for ORDER. */
  line_session_id: string | null;
  table_id: string | null;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
}

export interface PaymentRow {
  id: string;
  check_id: string;
  shift_id: string;
  operation_id: string;
  kind: 'PAYMENT' | 'REFUND';
  method: PaymentMethod;
  amount: number;
  tendered: number | null;
  change: number | null;
  reason: string | null;
  approved_by: string | null;
  at: number;
  actor: string;
}

function toPaymentView(p: PaymentRow): CheckPaymentView {
  return {
    id: p.id,
    operationId: p.operation_id,
    kind: p.kind,
    method: p.method,
    amount: p.amount,
    tendered: p.tendered,
    change: p.change,
    reason: p.reason,
    approvedBy: p.approved_by,
    shiftId: p.shift_id,
    at: p.at,
    actor: p.actor,
  };
}

/** Percent discounts are rounded to whole currency units (1 ₸), not to tiyn. */
export function discountStep(currency: string): number {
  return minorPerMajor(currency);
}

/** Each game followed by the bar lines ordered at it; bar lines of games not on the check last. */
function groupLines(items: CheckItemRow[]): CheckItemRow[] {
  const games = items.filter((i) => i.kind === 'GAME');
  const onGame = new Set(games.map((g) => g.line_session_id));
  const out: CheckItemRow[] = [];
  for (const g of games) {
    out.push(g, ...items.filter((i) => i.kind === 'ORDER' && i.line_session_id === g.line_session_id));
  }
  out.push(...items.filter((i) => i.kind === 'ORDER' && !onGame.has(i.line_session_id)));
  return out;
}

function toCheckView(row: CheckRow, items: CheckItemRow[], payments: PaymentRow[]): CheckView {
  const discount =
    row.discount_kind !== null && row.discount_value !== null
      ? { kind: row.discount_kind, value: row.discount_value }
      : null;
  const totals = checkTotals(
    items.map((i) => i.amount),
    discount,
    payments,
    discountStep(row.currency),
  );
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    items: groupLines(items).map(
      (i): CheckItemView => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        amount: i.amount,
        orderId: i.order_id ?? null,
        qty: i.qty ?? null,
        unitPrice: i.unit_price ?? null,
        sessionId: i.line_session_id,
        tableId: i.table_id,
        startedAt: i.started_at,
        stoppedAt: i.stopped_at,
        playedSeconds: i.played_seconds,
      }),
    ),
    discount: discount && { ...discount, reason: row.discount_reason ?? '', by: row.discount_by ?? '' },
    subtotal: totals.subtotal,
    discountAmount: totals.discount,
    total: totals.total,
    paid: totals.paid,
    refunded: totals.refunded,
    due: row.status === 'OPEN' ? totals.due : 0,
    payments: payments.map(toPaymentView),
    createdAt: row.created_at,
    createdBy: row.created_by,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  };
}

/** Loads checks matching a condition over `checks c` (may end with ORDER BY). */
export function loadChecksWhere(db: Db, where: string, ...params: Param[]): CheckView[] {
  const rows = all<CheckRow>(
    db,
    `SELECT c.*, cl.currency FROM checks c JOIN clubs cl ON cl.id = c.club_id WHERE ${where}`,
    ...params,
  );
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const items = all<CheckItemRow>(
    db,
    `SELECT ci.*, COALESCE(ci.session_id, o.session_id) AS line_session_id,
            COALESCE(s.table_id, o.table_id) AS table_id, s.started_at, s.stopped_at, s.played_seconds
     FROM check_items ci
     LEFT JOIN table_sessions s ON s.id = ci.session_id
     LEFT JOIN bar_orders o ON o.id = ci.order_id
     WHERE ci.check_id IN (SELECT value FROM json_each(?)) ORDER BY ci.created_at, ci.rowid`,
    ids,
  );
  const payments = all<PaymentRow>(
    db,
    'SELECT * FROM payments WHERE check_id IN (SELECT value FROM json_each(?)) ORDER BY at, rowid',
    ids,
  );
  return rows.map((r) =>
    toCheckView(
      r,
      items.filter((i) => i.check_id === r.id),
      payments.filter((p) => p.check_id === r.id),
    ),
  );
}

export function loadCheck(db: Db, id: string): CheckView {
  const check = loadChecksWhere(db, 'c.id = ?', id)[0];
  if (!check) throw new HubError(404, 'CHECK_NOT_FOUND', 'Счёт не найден');
  return check;
}

// ── Cash shifts ──────────────────────────────────────────────────────────────

export interface ShiftRow {
  id: string;
  club_id: string;
  number: number;
  status: ShiftStatus;
  opening_float: number;
  opened_at: number;
  opened_by: string;
  closed_at: number | null;
  closed_by: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  close_note: string | null;
  z_report: string | null;
}

export function openShiftRow(db: Db, clubId: string): ShiftRow | undefined {
  return one<ShiftRow>(db, "SELECT * FROM cash_shifts WHERE club_id = ? AND status = 'OPEN'", clubId);
}

export function cashMovements(db: Db, shiftId: string): CashMovementView[] {
  return all<CashMovementView>(
    db,
    'SELECT id, kind, amount, reason, at, actor FROM cash_movements WHERE shift_id = ? ORDER BY at, rowid',
    shiftId,
  ).map((m) => ({ ...m }));
}

export function shiftLedger(db: Db, row: ShiftRow): ShiftLedger {
  return {
    openingFloat: row.opening_float,
    entries: all<Pick<PaymentRow, 'kind' | 'method' | 'amount'>>(
      db,
      'SELECT kind, method, amount FROM payments WHERE shift_id = ?',
      row.id,
    ),
    movements: cashMovements(db, row.id),
  };
}

export function toShiftView(db: Db, row: ShiftRow): ShiftView {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    openingFloat: row.opening_float,
    expectedCash: row.expected_cash ?? shiftTotals(shiftLedger(db, row)).expectedCash,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    countedCash: row.counted_cash,
    difference: row.difference,
  };
}
