import type { DiscountKind, PaymentMethod } from './billing.ts';
import type { Minor } from './money.ts';
import type { CashMovementKind, ShiftTotals } from './shift.ts';

import type { SessionStatus } from './session.ts';
import type { TariffConfig } from './tariff.ts';

/** HTTP contract between the HUB and the screens. */

export type TableKind = 'pool' | 'russian' | 'snooker';
export type LampDesired = 'ON' | 'OFF';
export type LampReported = 'ON' | 'OFF' | 'UNKNOWN';

export interface SessionView {
  id: string;
  tableId: string;
  status: SessionStatus;
  tariffId: string;
  tariffName: string;
  tariff: TariffConfig;
  timezone: string;
  requestedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  playedSeconds: number | null;
  billedSeconds: number | null;
  /** Final for stopped games; for a running game — the amount if stopped at `serverNow`. */
  amount: number | null;
  failureReason: string | null;
  openedBy: string;
  stoppedBy: string | null;
}

export interface TableView {
  id: string;
  name: string;
  kind: TableKind;
  defaultTariffId: string;
  lamp: { desired: LampDesired; reported: LampReported };
  session: SessionView | null;
}

export interface AlertView {
  id: string;
  at: number;
  kind: string;
  tableId: string | null;
  message: string;
}

export interface HubState {
  serverNow: number;
  club: { id: string; name: string; timezone: string; currency: string };
  tariffs: Array<{ id: string; name: string; config: TariffConfig }>;
  tables: TableView[];
  unpaid: SessionView[];
  alerts: AlertView[];
}

export interface ApiError {
  error: { code: string; message: string };
}

// ═════════════════════════════════════════════════════════════════════════════
// Stage 2: checks, payments, cash shift. Kept together at the end of the file;
// the fields added to SessionView and HubState use interface merging.
// ═════════════════════════════════════════════════════════════════════════════

export interface SessionView {
  /** The guest check this game is on, if any. */
  checkId: string | null;
  /** Set when an unpaid game was voided with a manager's approval. */
  cancelReason: string | null;
  cancelApprovedBy: string | null;
}

export interface HubState {
  /** Checks being paid (status OPEN). `unpaid` lists stopped games, with or without a check. */
  checks: CheckView[];
  /** The open cash shift, or null. Payments are accepted only while it is open. */
  shift: ShiftView | null;
}

/** OPEN — being paid (maybe partly); PAID — settled; VOID — emptied before any payment. */
export type CheckStatus = 'OPEN' | 'PAID' | 'VOID';

export interface CheckItemView {
  id: string;
  /** ORDER is reserved for bar orders (stage 4). */
  kind: 'GAME' | 'ORDER';
  /** "Стол 1" for a game. */
  title: string;
  amount: Minor;
  sessionId: string | null;
  tableId: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  playedSeconds: number | null;
}

export interface CheckPaymentView {
  id: string;
  /** Parts of one mixed payment share it. */
  operationId: string;
  kind: 'PAYMENT' | 'REFUND';
  method: PaymentMethod;
  /** Applied to the check (refund: paid back). Always positive. */
  amount: Minor;
  /** Cash payment: what the guest handed over and the change given back. */
  tendered: Minor | null;
  change: Minor | null;
  /** Refund only. */
  reason: string | null;
  approvedBy: string | null;
  shiftId: string;
  at: number;
  actor: string;
}

export interface CheckDiscountView {
  kind: DiscountKind;
  /** PERCENT: whole percent; AMOUNT: minor units. */
  value: number;
  reason: string;
  by: string;
}

export interface CheckView {
  id: string;
  /** Sequential per club, for people: "Счёт №12". */
  number: number;
  status: CheckStatus;
  items: CheckItemView[];
  discount: CheckDiscountView | null;
  subtotal: Minor;
  /** Discount in minor units. */
  discountAmount: Minor;
  total: Minor;
  /** Payments, gross. */
  paid: Minor;
  refunded: Minor;
  /** Still owed; 0 unless OPEN. */
  due: Minor;
  payments: CheckPaymentView[];
  createdAt: number;
  createdBy: string;
  closedAt: number | null;
  /** HUB time of the last change: a screen holding two copies keeps the newer one. */
  updatedAt: number;
}

export type ShiftStatus = 'OPEN' | 'CLOSED';

export interface ShiftView {
  id: string;
  /** Sequential per club. */
  number: number;
  status: ShiftStatus;
  openedAt: number;
  openedBy: string;
  openingFloat: Minor;
  /** What should be in the drawer now (open) or at close. */
  expectedCash: Minor;
  closedAt: number | null;
  closedBy: string | null;
  countedCash: Minor | null;
  /** counted − expected; negative is a shortage. */
  difference: Minor | null;
}

export interface CashMovementView {
  id: string;
  kind: CashMovementKind;
  amount: Minor;
  reason: string;
  at: number;
  actor: string;
}

/** X — interim, the shift stays open. Z — final, fixed when the shift closes. */
export interface ShiftReport extends ShiftTotals {
  kind: 'X' | 'Z';
  shiftId: string;
  shiftNumber: number;
  generatedAt: number;
  openedAt: number;
  openedBy: string;
  closedAt: number | null;
  closedBy: string | null;
  countedCash: Minor | null;
  difference: Minor | null;
  /** The cashier's note at close (Z only). */
  note: string | null;
  /** Checks fully paid during the shift. */
  checksPaid: number;
  /** Payment operations (a mixed payment counts once). */
  paymentsCount: number;
  refundsCount: number;
  /** Discounts on checks paid during the shift. */
  discounts: Minor;
  /** Unpaid games voided with approval during the shift. */
  cancelledGames: number;
  movements: CashMovementView[];
}

/** POST /api/checks */
export interface CreateCheckRequest {
  sessionIds: string[];
}

/** POST /api/checks/:checkId/items */
export interface AddCheckItemRequest {
  sessionId: string;
}

/** POST /api/checks/:checkId/discount — `discount: null` removes it. */
export interface SetDiscountRequest {
  discount: { kind: DiscountKind; value: number; reason: string } | null;
}

/** POST /api/checks/:checkId/pay — `amount` is what the guest hands over by that method. */
export interface PayRequest {
  parts: Array<{ method: PaymentMethod; amount: Minor }>;
}

export interface PayResponse {
  check: CheckView;
  /** Applied to the check by this payment. */
  applied: Minor;
  /** Cash to give back. */
  change: Minor;
  /** Still owed; > 0 after a partial payment. */
  remaining: Minor;
}

/** POST /api/checks/:checkId/refund */
export interface RefundRequest {
  method: PaymentMethod;
  amount: Minor;
  reason: string;
  /** Manager who approved it (until PIN login, stage 3). */
  approvedBy: string;
}

/** POST /api/sessions/:sessionId/cancel — voids an unpaid (or running) game. */
export interface CancelSessionRequest {
  reason: string;
  approvedBy: string;
}

/** POST /api/shifts/open */
export interface OpenShiftRequest {
  openingFloat: Minor;
}

/** POST /api/shifts/:shiftId/cash */
export interface CashMovementRequest {
  kind: CashMovementKind;
  amount: Minor;
  reason: string;
}

/** POST /api/shifts/:shiftId/close */
export interface CloseShiftRequest {
  countedCash: Minor;
  note?: string;
}

export interface CloseShiftResponse {
  shift: ShiftView;
  report: ShiftReport;
}

// ═════════════════════════════════════════════════════════════════════════════
// Prepaid games: opened for N minutes, stopped by the HUB at the deadline.
// ═════════════════════════════════════════════════════════════════════════════

export interface PrepaidView {
  minutes: number;
  /** When the HUB stops the game: lamp-confirmed start + minutes. Null until the lamp confirms. */
  until: number | null;
  /** Paid upfront (open-prepaid): the amount taken and its check. Null for a timed game paid after. */
  amount: Minor | null;
  checkId: string | null;
  /** When the 5-minute warning blink was requested. */
  warnedAt: number | null;
}

export interface SessionView {
  /** Set for a game opened for N minutes. */
  prepaid: PrepaidView | null;
}

/** POST /api/tables/:tableId/open — `prepaidMinutes` makes a timed game, paid after it stops. */
export interface OpenTableRequest {
  tariffId?: string;
  prepaidMinutes?: number;
}

/** POST /api/tables/:tableId/open-prepaid — open for N minutes and take the whole payment at once. */
export interface OpenPrepaidRequest {
  tariffId?: string;
  minutes: number;
  /** The price the cashier showed the guest (prepaidPrice); the HUB refuses if it no longer matches. */
  amount: Minor;
  /** HUB time the price was computed for; honoured up to PREPAID_QUOTE_TTL_MS ago, else "now". */
  quotedAt?: number;
  /** What the guest hands over, as for /pay. Must cover the whole amount. */
  parts: Array<{ method: PaymentMethod; amount: Minor }>;
}

export interface OpenPrepaidResponse {
  session: SessionView;
  /** Already PAID. */
  check: CheckView;
  applied: Minor;
  change: Minor;
}
