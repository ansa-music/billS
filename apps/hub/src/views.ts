import type {
  AlertView,
  CashMovementView,
  CheckItemView,
  CheckPaymentView,
  CheckStatus,
  CheckView,
  DiscountKind,
  HubState,
  PauseReason,
  PauseSpan,
  PaymentMethod,
  SessionStatus,
  SessionView,
  ShiftLedger,
  ShiftStatus,
  ShiftView,
  TableView,
  TariffConfig,
} from '@bills/domain';
import { calculateChargeWithPauses, checkTotals, minorPerMajor, shiftTotals, unpaidSpans } from '@bills/domain';
import type { Db, Param } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import { getManualMode } from './settings.ts';

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
  manual: number;
  cancel_reason: string | null;
  cancel_approved_by: string | null;
  /** Joined from check_items. */
  check_id: string | null;
  /** The open pause, if any (joined from session_pauses). */
  pause_id: string | null;
  pause_reason: PauseReason | null;
  pause_started_at: number | null;
  resume_requested_at: number | null;
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
 * A game with the check it is billed on and its open pause. Append `WHERE s.…` conditions.
 * Exported under both names the HUB modules use.
 */
export const SESSION_SQL = `
  SELECT s.*, ci.check_id AS check_id,
         p.id AS pause_id, p.reason AS pause_reason, p.paused_at AS pause_started_at, p.resume_requested_at
  FROM table_sessions s
  LEFT JOIN check_items ci ON ci.session_id = s.id
  LEFT JOIN session_pauses p ON p.session_id = s.id AND p.resumed_at IS NULL`;
export const SESSION_SELECT = SESSION_SQL;

export function effectiveStatus(row: Pick<SessionRow, 'status' | 'pause_id'>): SessionStatus {
  return row.status === 'ACTIVE' && row.pause_id !== null ? 'PAUSED' : row.status;
}

export function loadSessionRow(db: Db, id: string): SessionRow | undefined {
  return one<SessionRow>(db, `${SESSION_SQL} WHERE s.id = ?`, id);
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

export function toSessionView(row: SessionRow, pauses: PauseSpan[], now: number): SessionView {
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
    failureReason: row.failure_reason,
    openedBy: row.opened_by,
    stoppedBy: row.stopped_by,
    manual: row.manual === 1,
    checkId: row.check_id ?? null,
    cancelReason: row.cancel_reason ?? null,
    cancelApprovedBy: row.cancel_approved_by ?? null,
  };
}

export function loadSession(db: Db, id: string, now: number): SessionView {
  const row = loadSessionRow(db, id);
  if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
  return toSessionView(row, loadPauseSpans(db, id), now);
}

import type { PowerView } from '@bills/domain';

export function buildState(db: Db, now: number, power: PowerView): HubState {
  const club = one<HubState['club']>(db, 'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

  const tariffs = all<{ id: string; name: string; config: string }>(
    db,
    'SELECT id, name, config FROM tariffs WHERE club_id = ? AND is_active = 1 ORDER BY name',
    club.id,
  ).map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) as TariffConfig }));

  const pauses = loadPauseSpansFor(db, club.id, ['OPENING', 'ACTIVE', 'AWAITING_PAYMENT']);
  const view = (r: SessionRow) => toSessionView(r, pauses.get(r.id) ?? [], now);

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
      currentOn: t.current_on === null ? null : t.current_on === 1,
      polledAt: t.polled_at,
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

  return { serverNow: now, club, tariffs, tables, unpaid, checks, shift, alerts, manualMode: getManualMode(db), power };
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
    items: items.map(
      (i): CheckItemView => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        amount: i.amount,
        sessionId: i.session_id,
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
    `SELECT ci.*, s.table_id, s.started_at, s.stopped_at, s.played_seconds
     FROM check_items ci LEFT JOIN table_sessions s ON s.id = ci.session_id
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
