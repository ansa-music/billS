import type {
  AlertView,
  ClubSettings,
  HubState,
  OrderItemView,
  OrderView,
  SessionStatus,
  SessionView,
  TableView,
  TariffConfig,
} from '@bills/domain';
import { calculateCharge, normalizeClubSettings } from '@bills/domain';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';

export type { AlertView, HubState, SessionView, TableView };

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

export function toSessionView(row: SessionRow, now: number, ordersTotal = 0): SessionView {
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
    ordersTotal,
    failureReason: row.failure_reason,
    openedBy: row.opened_by,
    stoppedBy: row.stopped_by,
  };
}

export function loadSession(db: Db, id: string, now: number): SessionView {
  const row = one<SessionRow>(db, 'SELECT * FROM table_sessions WHERE id = ?', id);
  if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
  return toSessionView(row, now, ordersTotalOf(db, id));
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
  }));
}

export function loadOrder(db: Db, id: string): OrderView {
  const row = one<OrderRow>(db, 'SELECT * FROM bar_orders WHERE id = ?', id);
  if (!row) throw new HubError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
  return toOrderViews(db, [row])[0]!;
}

export function buildState(db: Db, now: number): HubState {
  const club = one<HubState['club']>(db, 'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

  const settings = loadSettings(db, club.id);

  const tariffs = all<{ id: string; name: string; config: string }>(
    db,
    'SELECT id, name, config FROM tariffs WHERE club_id = ? AND is_active = 1 ORDER BY name',
    club.id,
  ).map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) as TariffConfig }));

  // Open bar orders on games that are live or waiting for payment.
  const orders = toOrderViews(
    db,
    all<OrderRow>(
      db,
      `SELECT o.* FROM bar_orders o JOIN table_sessions s ON s.id = o.session_id
       WHERE o.club_id = ? AND o.status = 'OPEN' AND s.status IN ('OPENING', 'ACTIVE', 'AWAITING_PAYMENT')
       ORDER BY o.created_at`,
      club.id,
    ),
  );
  const ordersBySession = new Map<string, number>();
  for (const o of orders) ordersBySession.set(o.sessionId, (ordersBySession.get(o.sessionId) ?? 0) + o.total);

  const live = new Map(
    all<SessionRow>(db, "SELECT * FROM table_sessions WHERE club_id = ? AND status IN ('OPENING', 'ACTIVE')", club.id).map(
      (r) => [r.table_id, toSessionView(r, now, ordersBySession.get(r.id) ?? 0)],
    ),
  );

  const tables = all<{
    id: string;
    name: string;
    kind: TableView['kind'];
    default_tariff_id: string;
    desired: 'ON' | 'OFF' | null;
    reported: 'ON' | 'OFF' | 'UNKNOWN' | null;
  }>(
    db,
    `SELECT t.id, t.name, t.kind, t.default_tariff_id, l.desired, l.reported
     FROM billiard_tables t LEFT JOIN lamp_states l ON l.table_id = t.id
     WHERE t.club_id = ? AND t.is_active = 1
     ORDER BY t.sort_order, t.name`,
    club.id,
  ).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    defaultTariffId: t.default_tariff_id,
    lamp: { desired: t.desired ?? 'OFF', reported: t.reported ?? 'UNKNOWN' },
    session: live.get(t.id) ?? null,
  }));

  const unpaid = all<SessionRow>(
    db,
    "SELECT * FROM table_sessions WHERE club_id = ? AND status = 'AWAITING_PAYMENT' ORDER BY stopped_at",
    club.id,
  ).map((r) => toSessionView(r, now, ordersBySession.get(r.id) ?? 0));

  const alerts = all<AlertView>(
    db,
    `SELECT id, at, kind, table_id AS tableId, message FROM alerts
     WHERE resolved_at IS NULL ORDER BY at DESC LIMIT 20`,
  );

  return { serverNow: now, club, settings, tariffs, tables, unpaid, orders, alerts };
}
