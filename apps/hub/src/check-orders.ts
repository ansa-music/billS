import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { all, one, run } from './db.ts';
import { HubError } from './errors.ts';
import { record } from './journal.ts';

/**
 * Bar orders on guest checks. Every line of an order becomes an ORDER line of the
 * check; the order remembers its check and is CLOSED when the check is paid.
 * Plain functions: the check and bar services both call them inside their transactions.
 * Audit uses the check events the cloud already projects (check.item_added/removed).
 */

interface OrderLineRow {
  id: string;
  title: string;
  price: number;
  qty: number;
  amount: number;
}

/** Puts an open order on no check onto `checkId`. Returns its total. */
export function attachOrder(db: Db, checkId: string, orderId: string, actor: string, now: number): number {
  const order = one<{ id: string; session_id: string; table_id: string; status: string; check_id: string | null; total: number }>(
    db,
    'SELECT id, session_id, table_id, status, check_id, total FROM bar_orders WHERE id = ?',
    orderId,
  );
  if (!order) throw new HubError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
  if (order.status !== 'OPEN' || order.check_id !== null) {
    throw new HubError(409, 'ORDER_NOT_PAYABLE', 'Заказ уже в счёте, оплачен или отменён');
  }
  const lines = all<OrderLineRow>(
    db,
    'SELECT id, title, price, qty, amount FROM bar_order_items WHERE order_id = ? ORDER BY created_at, id',
    order.id,
  );
  for (const line of lines) {
    run(
      db,
      `INSERT INTO check_items (id, check_id, kind, session_id, title, amount, created_at, order_id, order_item_id, qty, unit_price)
       VALUES (?, ?, 'ORDER', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      checkId,
      line.title,
      line.amount,
      now,
      order.id,
      line.id,
      line.qty,
      line.price,
    );
  }
  run(db, 'UPDATE bar_orders SET check_id = ?, updated_at = ? WHERE id = ?', checkId, now, order.id);
  run(db, 'UPDATE checks SET updated_at = ? WHERE id = ?', now, checkId);
  record(db, now, {
    actor,
    action: 'check.item_added',
    entityType: 'check',
    entityId: checkId,
    data: {
      kind: 'ORDER',
      orderId: order.id,
      orderSessionId: order.session_id,
      tableId: order.table_id,
      amount: order.total,
      lines: lines.map((l) => ({ title: l.title, qty: l.qty, price: l.price, amount: l.amount })),
    },
  });
  return order.total;
}

/** Every open order of a game that is on no check joins `checkId` (oldest first). */
export function attachOrdersOfGame(db: Db, checkId: string, sessionId: string, actor: string, now: number): void {
  for (const o of all<{ id: string }>(
    db,
    "SELECT id FROM bar_orders WHERE session_id = ? AND status = 'OPEN' AND check_id IS NULL ORDER BY created_at, id",
    sessionId,
  )) {
    attachOrder(db, checkId, o.id, actor, now);
  }
}

/** Takes an order's lines off its check; the order is open again and on no check. */
export function detachOrder(db: Db, orderId: string, actor: string, now: number): void {
  const order = one<{ id: string; session_id: string; check_id: string | null; total: number }>(
    db,
    'SELECT id, session_id, check_id, total FROM bar_orders WHERE id = ?',
    orderId,
  );
  if (!order?.check_id) return;
  run(db, 'DELETE FROM check_items WHERE order_id = ? AND check_id = ?', order.id, order.check_id);
  run(db, 'UPDATE bar_orders SET check_id = NULL, updated_at = ? WHERE id = ?', now, order.id);
  run(db, 'UPDATE checks SET updated_at = ? WHERE id = ?', now, order.check_id);
  record(db, now, {
    actor,
    action: 'check.item_removed',
    entityType: 'check',
    entityId: order.check_id,
    data: { kind: 'ORDER', orderId: order.id, orderSessionId: order.session_id, amount: order.total },
  });
}

/** Orders of a game that sit on `checkId` leave it together with the game. */
export function detachOrdersOfGame(db: Db, checkId: string, sessionId: string, actor: string, now: number): void {
  for (const o of all<{ id: string }>(
    db,
    'SELECT id FROM bar_orders WHERE session_id = ? AND check_id = ?',
    sessionId,
    checkId,
  )) {
    detachOrder(db, o.id, actor, now);
  }
}

/** The OPEN check a game is on — a new order of that game joins it. Null when none (or it is paid). */
export function openCheckOfGame(db: Db, sessionId: string): string | null {
  return (
    one<{ id: string }>(
      db,
      `SELECT c.id FROM check_items ci JOIN checks c ON c.id = ci.check_id
       WHERE ci.session_id = ? AND ci.kind = 'GAME' AND c.status = 'OPEN'`,
      sessionId,
    )?.id ?? null
  );
}

/** Money on a check after refunds: an order on it can be cancelled only while this is 0. */
export function netPaidOn(db: Db, checkId: string): number {
  return (
    one<{ net: number | null }>(
      db,
      "SELECT SUM(CASE WHEN kind = 'PAYMENT' THEN amount ELSE -amount END) AS net FROM payments WHERE check_id = ?",
      checkId,
    )?.net ?? 0
  );
}

/** The orders of a paid check are CLOSED. */
export function closeOrdersOfCheck(db: Db, checkId: string, actor: string, now: number): void {
  for (const o of all<{ id: string; session_id: string; table_id: string; total: number }>(
    db,
    "SELECT id, session_id, table_id, total FROM bar_orders WHERE check_id = ? AND status = 'OPEN'",
    checkId,
  )) {
    run(
      db,
      "UPDATE bar_orders SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'",
      now,
      now,
      o.id,
    );
    record(db, now, {
      actor,
      action: 'order.closed',
      entityType: 'order',
      entityId: o.id,
      data: { checkId, sessionId: o.session_id, tableId: o.table_id, total: o.total },
    });
  }
}

/** A check left without lines before any payment is VOID. Returns true when it was voided. */
export function voidCheckIfEmpty(db: Db, checkId: string, actor: string, now: number): boolean {
  const left = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM check_items WHERE check_id = ?', checkId)?.n ?? 0;
  if (left > 0) return false;
  run(db, "UPDATE checks SET status = 'VOID', closed_at = ?, updated_at = ? WHERE id = ?", now, now, checkId);
  record(db, now, { actor, action: 'check.voided', entityType: 'check', entityId: checkId, data: {} });
  return true;
}
