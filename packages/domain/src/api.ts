import type { DiscountKind, PaymentMethod } from './billing.ts';
import type { ProductOptionGroup } from './cafe.ts';
import type { SyncStatus } from './cloud.ts';
import type { Minor } from './money.ts';
import type { PauseSpan } from './pause.ts';
import type { KeyKind } from './auth.ts';
import type { LicenseStatus } from './license.ts';
import type { Role } from './permissions.ts';
import type { CashMovementKind, ShiftTotals } from './shift.ts';
import type { SessionStatus } from './session.ts';
import type { ClubSettings, ClubSettingsPatch } from './settings.ts';
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
  /** Seconds of play: pauses excluded. Final for stopped games; for a live game — as of `serverNow`. */
  playedSeconds: number | null;
  billedSeconds: number | null;
  /** Final for stopped games; for a running game — the amount if stopped at `serverNow`. */
  amount: number | null;
  /** Unpaid pause time in seconds (staff pauses within the tariff budget + transfers). */
  pausedSeconds: number | null;
  /** All pauses of the game, oldest first; the last one is open while the game is PAUSED. */
  pauses: PauseSpan[];
  /** When the current pause started (PAUSED only). */
  pausedAt: number | null;
  /** «Продолжить» pressed (or a transfer requested): the lamp is being switched on; time resumes when it confirms. */
  resumeRequestedAt: number | null;
  /** Bar orders on this game (stage 4), minor units. Not included in `amount`. */
  ordersTotal: Minor;
  failureReason: string | null;
  openedBy: string;
  stoppedBy: string | null;
  /** Opened in manual mode: billing started at the button press, the lamp was switched by hand. */
  manual: boolean;
}

export interface TableView {
  id: string;
  name: string;
  kind: TableKind;
  defaultTariffId: string;
  lamp: {
    desired: LampDesired;
    reported: LampReported;
    /** The lamp was asked to blink steadily (paused game with `pauseLamp: 'blink'`). */
    blink: boolean;
    /** From the last poll of the current sensor; null — no sensor or never polled. */
    currentOn: boolean | null;
    polledAt: number | null;
  };
  session: SessionView | null;
}

export interface AlertView {
  id: string;
  at: number;
  kind: string;
  tableId: string | null;
  message: string;
  /** «Сторож»: who did it — only for managers on the HUB, never in push texts. */
  staff?: string | null;
}

/** Emergency mode: lamps are switched by hand, games start at the button press. */
export interface ManualModeView {
  enabled: boolean;
  reason: string | null;
  since: number | null;
  by: string | null;
}

/** The club's UPS as the HUB sees it (HUB_UPS). Lamps are not on the UPS: on battery the hall is dark. */
export interface PowerView {
  /** HUB_UPS is set. When false the rest is empty. */
  configured: boolean;
  source: 'nut' | 'apcupsd' | 'simulator' | null;
  label: string | null;
  /** The last reading succeeded recently. */
  reachable: boolean;
  onBattery: boolean;
  chargePercent: number | null;
  runtimeSeconds: number | null;
  status: string | null;
  model: string | null;
  checkedAt: number | null;
  onBatterySince: number | null;
  /** Charge fell below the critical level during this outage. */
  critical: boolean;
  /** Games paused automatically by this outage (0 when the setting is off). */
  autoPausedSessions: number;
  settings: { autoPauseOnPowerLoss: boolean };
}

export interface HubState {
  serverNow: number;
  club: { id: string; name: string; timezone: string; currency: string };
  /** Hall screen look and house rules. */
  settings: ClubSettings;
  tariffs: Array<{ id: string; name: string; config: TariffConfig }>;
  tables: TableView[];
  unpaid: SessionView[];
  /**
   * Open bar orders: on live and unpaid games, plus orders on no check whose game is
   * already over (e.g. a prepaid game) — those are paid on a check of their own.
   */
  orders: OrderView[];
  alerts: AlertView[];
  manualMode: ManualModeView;
  power: PowerView;
  /** Cloud sync status (stage 6); enabled=false when the club runs without a cloud. */
  sync: SyncStatus;
  /** License of this branch (banner, read-only mode); null when licenses are not enforced. */
  license: LicenseStatus | null;
}

export interface TransferRequest {
  toTableId: string;
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
  /** GAME — time on a table; ORDER — one line of a bar order. */
  kind: 'GAME' | 'ORDER';
  /** "Стол 1" for a game, the product name for an order line. */
  title: string;
  amount: Minor;
  /** ORDER lines: the order, quantity and price per unit (amount = qty × unitPrice). */
  orderId: string | null;
  qty: number | null;
  unitPrice: Minor | null;
  /** The game of the line — for an ORDER line, the game the order was made at. Lines follow their game. */
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
  /**
   * Checks paid during the shift split by what was sold: time on tables and the bar.
   * A check discount is spread over both in proportion; time + bar = their totals.
   */
  revenue: { time: Minor; bar: Minor };
  movements: CashMovementView[];
}

/** POST /api/checks */
export interface CreateCheckRequest {
  /** Stopped games; their open bar orders join the check as ORDER lines. */
  sessionIds: string[];
  /** Open bar orders to bill without their game (paid separately, e.g. after a prepaid game). */
  orderIds?: string[];
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

// ── Club settings: club, tables, tariffs (stage 3/6 groundwork) ─────────────

export interface TableAdminView {
  id: string;
  name: string;
  kind: TableKind;
  lampChannel: string;
  defaultTariffId: string;
  sortOrder: number;
  isActive: boolean;
  /** A live game is on it: it cannot be switched off right now. */
  busy: boolean;
}

export interface TariffAdminView {
  id: string;
  name: string;
  config: TariffConfig;
  isActive: boolean;
  /** Tables that use it by default. */
  tableCount: number;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/club — everything the settings page edits, inactive rows included. */
export interface ClubAdminView {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  timezone: string;
  currency: string;
  settings: ClubSettings;
  tables: TableAdminView[];
  tariffs: TariffAdminView[];
}

/** POST /api/club — any subset. */
export interface UpdateClubRequest {
  name?: string;
  timezone?: string;
  currency?: string;
  settings?: ClubSettingsPatch;
}

/** POST /api/tables (201 → TableAdminView). */
export interface CreateTableRequest {
  name: string;
  kind: TableKind;
  lampChannel: string;
  defaultTariffId: string;
}

/** POST /api/tables/:tableId/update (→ TableAdminView). */
export interface UpdateTableRequest {
  name?: string;
  kind?: TableKind;
  lampChannel?: string;
  defaultTariffId?: string;
  isActive?: boolean;
}

/** POST /api/tables/reorder — ids in the new order (→ { tables: TableAdminView[] }). */
export interface ReorderTablesRequest {
  tableIds: string[];
}

/** POST /api/tariffs (201 → TariffAdminView). */
export interface CreateTariffRequest {
  name: string;
  config: TariffConfig;
}

/** POST /api/tariffs/:tariffId/update (→ TariffAdminView). Running games keep their snapshot. */
export interface UpdateTariffRequest {
  name?: string;
  config?: TariffConfig;
  isActive?: boolean;
}

// ── Bar and menu (stage 4) ──────────────────────────────────────────────────

export interface CategoryView {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ProductView {
  id: string;
  categoryId: string;
  name: string;
  /** Minor units. */
  price: Minor;
  isActive: boolean;
  /** null = stock is not tracked. */
  stock: number | null;
  sortOrder: number;
  /** Option groups (size, milk, syrup — cafe.ts); empty for a plain product. */
  options: ProductOptionGroup[];
}

/** GET /api/bar/catalog — inactive rows included (the admin page shows them). */
export interface CatalogView {
  categories: CategoryView[];
  products: ProductView[];
}

export interface CreateCategoryRequest {
  name: string;
}

export interface UpdateCategoryRequest {
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface CreateProductRequest {
  categoryId: string;
  name: string;
  price: Minor;
  /** null or omitted = not tracked. */
  stock?: number | null;
  /** Checked by validateOptionGroups (422 OPTIONS_INVALID); omitted = none. */
  options?: ProductOptionGroup[];
}

export interface UpdateProductRequest {
  categoryId?: string;
  name?: string;
  price?: Minor;
  stock?: number | null;
  sortOrder?: number;
  isActive?: boolean;
  /** Replaces all groups; [] removes them. Orders already taken keep their snapshot. */
  options?: ProductOptionGroup[];
}

/** OPEN — not paid yet (maybe already on a check); CLOSED — its check is paid; CANCELLED — with a reason. */
export type OrderStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';

export interface OrderItemView {
  id: string;
  productId: string;
  /** Name and price are snapshots: later catalog edits do not reprice the order. */
  title: string;
  price: Minor;
  qty: number;
  /** price × qty. */
  amount: Minor;
  /** Chosen options as names (snapshot, also part of `title`); [] for a plain product. */
  optionNames: string[];
}

export interface OrderView {
  id: string;
  sessionId: string;
  tableId: string;
  status: OrderStatus;
  note: string | null;
  items: OrderItemView[];
  total: Minor;
  createdAt: number;
  createdBy: string;
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  /** The guest check it is billed on; null until a check takes it. */
  checkId: string | null;
  /** When its check was paid. */
  closedAt: number | null;
}

/** POST /api/sessions/:sessionId/orders (201 → OrderView). The game must be ACTIVE or AWAITING_PAYMENT. */
export interface CreateOrderRequest {
  /** `options` — chosen choice ids as for counter lines (priceLine); a product may repeat with other options. */
  items: Array<{ productId: string; qty: number; options?: string[] }>;
  note?: string;
}

/** POST /api/orders/:orderId/cancel (→ OrderView). Needs a reason; stock comes back. */
export interface CancelOrderRequest {
  reason: string;
}

// ── Access keys and sessions (stage 3) ──────────────────────────────────────

/** Who is signed in on this screen. */
export interface AuthStaff {
  id: string;
  name: string;
  /** The highest of `roles` (primaryRole): shown first, names the key prefix. */
  role: Role;
  /** Everything the person holds; rights are the union (`can(roles, action)`). */
  roles: Role[];
  clubId: string;
  clubName: string;
}

/** POST /api/auth/login — no token needed. 401 KEY_INVALID for anything that does not work. */
export interface LoginRequest {
  key: string;
  /** Free text for the sessions list: "планшет у бара", browser name… */
  device?: string;
}

export interface LoginResponse {
  /** Send as "Authorization: Bearer <token>". */
  token: string;
  staff: AuthStaff;
  expiresAt: number;
}

/**
 * GET /api/auth/roster (public): who may sign in on this tablet — active people of the branch
 * with a working six-digit key, for the «Кто на смене?» tiles. Names and roles only, never a key;
 * empty when the club switched the list off (`display.showRoster = false`).
 */
export interface RosterPerson {
  id: string;
  name: string;
  roles: Role[];
}

export interface RosterResponse {
  people: RosterPerson[];
}

/** GET /api/auth/me */
export interface MeResponse {
  staff: AuthStaff;
  expiresAt: number;
  /** License of this branch; null when the HUB does not enforce licenses (tests, demo). */
  license: LicenseStatus | null;
}

/**
 * 429 LOGIN_LOCKED on POST /api/auth/login: too many wrong keys from this
 * device (or the whole branch for short keys). `error.retryAfterMs` says how long.
 */
export interface LoginLockedError {
  error: { code: 'LOGIN_LOCKED'; message: string; retryAfterMs: number };
}

/** One login attempt (GET /api/auth/attempts, staff.view). The key itself is never stored. */
export interface LoginAttemptView {
  id: number;
  at: number;
  ok: boolean;
  /** 'long' | 'short' | null when what was typed is neither shape. */
  kind: KeyKind | null;
  /** Known key: its prefix ("MGR-7K3Q", "••••42"); null for a wrong key. */
  prefix: string | null;
  staffName: string | null;
  device: string | null;
  ip: string | null;
  /** ok | wrong_key | revoked | expired | inactive | locked | branch_locked */
  result: string;
}

export interface LoginAttemptsResponse {
  attempts: LoginAttemptView[];
}

/** GET /api/license (license.view or any signed-in person: what the banner shows). */
export interface LicenseResponse {
  status: LicenseStatus;
  /** This HUB's id as a license names it (HUB_ID, or `club:<id>` without a cloud). */
  hubId: string;
  /** Licenses are checked on this HUB. false in tests and the demo. */
  enforced: boolean;
  /** When the license in force was installed and where it came from. */
  installedAt: number | null;
  source: 'cloud' | 'manual' | null;
}

/** POST /api/license (license.install): a signed license text `TS1.…`. 422 LICENSE_INVALID when the signature or the HUB does not match. */
export interface InstallLicenseRequest {
  license: string;
}

export interface AccessKeyView {
  id: string;
  staffId: string;
  /** Long key for the platform and managers, short (6 digits) for staff. */
  kind: KeyKind;
  /** "MGR-7K3Q" or "••••42" — the key itself is never returned after issue. */
  prefix: string;
  label: string | null;
  createdAt: number;
  createdBy: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
}

/**
 * POST /api/staff/:staffId/keys (201). The caller must be allowed to assign the
 * person's roles. Staff get a short key (6 digits, this branch only), managers
 * and the platform a long one — the kind follows the roles.
 */
export interface IssueKeyRequest {
  label?: string;
  /** Omit for a key that does not expire. */
  expiresInDays?: number;
  /**
   * Short keys only: six digits chosen by the manager instead of random ones.
   * Refused when weak (111111, 123456…) — 422 KEY_WEAK — or already used in
   * this branch — 409 KEY_TAKEN.
   */
  key?: string;
}

export interface IssueKeyResponse {
  /** Shown once. */
  key: string;
  view: AccessKeyView;
}

/** GET /api/staff/:staffId/keys */
export interface KeyListResponse {
  keys: AccessKeyView[];
}

// ── Staff, roles, audit (stage 3) ───────────────────────────────────────────

export interface StaffView {
  id: string;
  name: string;
  /** primaryRole(roles). */
  role: Role;
  /** A set: waiter + cashier… Rights are the union. */
  roles: Role[];
  /** 'cloud' — created in the manager's cabinet and kept in sync from there (edit it there); 'hub' — created on this HUB. */
  origin: 'hub' | 'cloud';
  isActive: boolean;
  /** Active (not revoked, not expired) access keys. */
  activeKeys: number;
  /** A PIN is set (the PIN itself is never returned). */
  hasPin: boolean;
  /** Tables a waiter is assigned to; empty = all. */
  tableIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** GET /api/staff → { staff: StaffView[] } (inactive included, active first). */
export interface StaffListResponse {
  staff: StaffView[];
}

/**
 * POST /api/staff (201 → StaffView). `roles` per normalizeRoles; the caller must
 * be allowed to assign every one (canAssignRoles). 409 LICENSE_STAFF_LIMIT over
 * the license's maxStaff.
 */
export interface CreateStaffRequest {
  name: string;
  roles: Role[];
  /** Tablet unlock PIN, 4–6 digits; stored hashed. Not a login key — see IssueKeyRequest. */
  pin?: string;
  tableIds?: string[];
}

/** POST /api/staff/:staffId/update (→ StaffView). `pin: null` removes the PIN. */
export interface UpdateStaffRequest {
  name?: string;
  roles?: Role[];
  pin?: string | null;
  isActive?: boolean;
  tableIds?: string[];
}

/** POST /api/staff/:staffId/verify-pin → { ok: boolean } (stage 3 login groundwork). */
export interface VerifyPinRequest {
  pin: string;
}

export interface AuditEntryView {
  id: number;
  at: number;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}

/**
 * GET /api/audit?actor=&tableId=&from=&to=&limit=&before=
 * `from`/`to` are epoch ms; `before` is the id to page from (entries with a smaller id).
 */
export interface AuditListResponse {
  entries: AuditEntryView[];
  /** Pass as `before` to get the next page; null when there is no more. */
  nextBefore: number | null;
  /** Distinct actors seen in the log, for the filter. */
  actors: string[];
}

// ── Owner cabinet (stage 6 groundwork, one club for now) ────────────────────

export interface RevenuePoint {
  /** Local date YYYY-MM-DD. */
  date: string;
  amount: Minor;
  games: number;
}

export interface TableStat {
  tableId: string;
  name: string;
  revenue: Minor;
  games: number;
  /** Billed seconds in the period. */
  seconds: number;
}

/** GET /api/reports/summary?date=YYYY-MM-DD (local club date; default today). */
export interface OwnerSummary {
  generatedAt: number;
  date: string;
  timezone: string;
  currency: string;
  /** Stopped games (AWAITING_PAYMENT and CLOSED) plus bar orders, by period containing `date`. */
  revenue: { today: Minor; week: Minor; month: Minor };
  games: { today: number; week: number; month: number };
  /** Average per game today (time + orders); 0 when no games. */
  avgCheck: Minor;
  /** For each local hour 0..23 of `date`: share of tables busy (0..1). */
  occupancyByHour: number[];
  /** Last 14 local days ending with `date`. */
  revenueByDay: RevenuePoint[];
  /** This month, best first. */
  topTables: TableStat[];
  openAlerts: number;
  liveGames: number;
  unpaidGames: number;
  unpaidAmount: Minor;
}
