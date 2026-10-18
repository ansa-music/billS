import type {
  AlertView,
  CashMovementView,
  CheckItemView,
  CheckPaymentView,
  CheckStatus,
  CheckView,
  DiscountKind,
  HubState,
  PaymentMethod,
  SessionStatus,
  SessionView,
  ShiftLedger,
  ShiftStatus,
  ShiftView,
  TableView,
  TariffConfig,
} from '@bills/domain';
import { calculateCharge, checkTotals, minorPerMajor, shiftTotals } from '@bills/domain';
import type { Db, Param } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import { getManualMode } from './settings.ts';

export type { AlertView, CheckView, HubState, SessionView, ShiftView, TableView };

export interface SessionRow {
  id: string;
  club_id: string;
  table_id: string;
  tariff_id: string;
  tariff_name: string;
  tariff_snapshot: string;
  timezone: string;
  status: SessionStatus;
  requested_at: number;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
  billed_seconds: number | null;
  amount: number | null;
  failure_reason: string | null;
  opened_by: string;
  stopped_by: string | null;
  manual: number;
  cancel_reason: string | null;
  cancel_approved_by: string | null;
  /** Joined from check_items. */
  check_id: string | null;
}

/** Sessions with the check they are billed on. */
export const SESSION_SELECT =
  'SELECT s.*, ci.check_id AS check_id FROM table_sessions s LEFT JOIN check_items ci ON ci.session_id = s.id';

export function toSessionView(row: SessionRow, now: number): SessionView {
  const tariff = JSON.parse(row.tariff_snapshot) as TariffConfig;
  let amount = row.amount;
  if (row.status === 'ACTIVE' && row.started_at !== null) {
    amount = calculateCharge(row.started_at, Math.max(now, row.started_at), tariff, row.timezone).amount;
  }
  return {
    id: row.id,
    tableId: row.table_id,
    status: row.status,
    tariffId: row.tariff_id,
    tariffName: row.tariff_name,
    tariff,
    timezone: row.timezone,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    playedSeconds: row.played_seconds,
    billedSeconds: row.billed_seconds,
    amount,
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
  const row = one<SessionRow>(db, `${SESSION_SELECT} WHERE s.id = ?`, id);
  if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
  return toSessionView(row, now);
}

export function buildState(db: Db, now: number): HubState {
  const club = one<HubState['club']>(db, 'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

  const tariffs = all<{ id: string; name: string; config: string }>(
    db,
    'SELECT id, name, config FROM tariffs WHERE club_id = ? AND is_active = 1 ORDER BY name',
    club.id,
  ).map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) as TariffConfig }));

  const live = new Map(
    all<SessionRow>(db, `${SESSION_SELECT} WHERE s.club_id = ? AND s.status IN ('OPENING', 'ACTIVE')`, club.id).map(
      (r) => [r.table_id, toSessionView(r, now)],
    ),
  );

  const tables = all<{
    id: string;
    name: string;
    kind: TableView['kind'];
    default_tariff_id: string;
    desired: 'ON' | 'OFF' | null;
    reported: 'ON' | 'OFF' | 'UNKNOWN' | null;
    current_on: number | null;
    polled_at: number | null;
  }>(
    db,
    `SELECT t.id, t.name, t.kind, t.default_tariff_id, l.desired, l.reported, l.current_on, l.polled_at
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
      currentOn: t.current_on === null ? null : t.current_on === 1,
      polledAt: t.polled_at,
    },
    session: live.get(t.id) ?? null,
  }));

  const unpaid = all<SessionRow>(
    db,
    `${SESSION_SELECT} WHERE s.club_id = ? AND s.status = 'AWAITING_PAYMENT' ORDER BY s.stopped_at`,
    club.id,
  ).map((r) => toSessionView(r, now));

  const alerts = all<AlertView>(
    db,
    `SELECT id, at, kind, table_id AS tableId, message FROM alerts
     WHERE resolved_at IS NULL ORDER BY at DESC LIMIT 20`,
  );

  const checks = loadChecksWhere(db, "c.club_id = ? AND c.status = 'OPEN' ORDER BY c.number", club.id);
  const open = openShiftRow(db, club.id);
  const shift = open ? toShiftView(db, open) : null;

  return { serverNow: now, club, tariffs, tables, unpaid, checks, shift, alerts, manualMode: getManualMode(db) };
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
