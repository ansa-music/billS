import type { Minor } from './money.ts';
import type { Role } from './permissions.ts';
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
  playedSeconds: number | null;
  billedSeconds: number | null;
  /** Final for stopped games; for a running game — the amount if stopped at `serverNow`. */
  amount: number | null;
  /** Bar orders on this game (stage 4), minor units. Not included in `amount`. */
  ordersTotal: Minor;
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
  /** Hall screen look and house rules. */
  settings: ClubSettings;
  tariffs: Array<{ id: string; name: string; config: TariffConfig }>;
  tables: TableView[];
  unpaid: SessionView[];
  /** Open bar orders on live and unpaid games (stage 4). */
  orders: OrderView[];
  alerts: AlertView[];
}

export interface ApiError {
  error: { code: string; message: string };
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
}

export interface UpdateProductRequest {
  categoryId?: string;
  name?: string;
  price?: Minor;
  stock?: number | null;
  sortOrder?: number;
  isActive?: boolean;
}

export type OrderStatus = 'OPEN' | 'CANCELLED';

export interface OrderItemView {
  id: string;
  productId: string;
  /** Name and price are snapshots: later catalog edits do not reprice the order. */
  title: string;
  price: Minor;
  qty: number;
  /** price × qty. */
  amount: Minor;
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
}

/** POST /api/sessions/:sessionId/orders (201 → OrderView). The game must be ACTIVE or AWAITING_PAYMENT. */
export interface CreateOrderRequest {
  items: Array<{ productId: string; qty: number }>;
  note?: string;
}

/** POST /api/orders/:orderId/cancel (→ OrderView). Needs a reason; stock comes back. */
export interface CancelOrderRequest {
  reason: string;
}

// ── Staff, roles, audit (stage 3) ───────────────────────────────────────────

export interface StaffView {
  id: string;
  name: string;
  role: Role;
  isActive: boolean;
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

/** POST /api/staff (201 → StaffView). */
export interface CreateStaffRequest {
  name: string;
  role: Role;
  /** 4–6 digits; stored hashed. */
  pin?: string;
  tableIds?: string[];
}

/** POST /api/staff/:staffId/update (→ StaffView). `pin: null` removes the PIN. */
export interface UpdateStaffRequest {
  name?: string;
  role?: Role;
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
