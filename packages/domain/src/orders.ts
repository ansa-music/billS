import type { Minor } from './money.ts';

/**
 * Bar orders on a game (stage 4). Pure arithmetic and validation; the HUB
 * snapshots title and price per line, so an order never changes after it is
 * sent, whatever happens to the catalog.
 */

export const ORDER_MAX_QTY = 99;
export const ORDER_MAX_LINES = 50;
export const ORDER_NOTE_MAX = 200;
export const CANCEL_REASON_MIN = 3;

export interface OrderLineInput {
  productId: string;
  qty: number;
}

/** price × qty, minor units. */
export function orderItemAmount(price: Minor, qty: number): Minor {
  return price * qty;
}

/** Sum of the lines, minor units. Accepts snapshots and views alike. */
export function orderTotal(items: ReadonlyArray<{ price: Minor; qty: number }>): Minor {
  let total = 0;
  for (const it of items) total += orderItemAmount(it.price, it.qty);
  return total;
}

/** Problems with the lines of an order as the waiter sends them; empty = fine. */
export function validateOrderItems(items: ReadonlyArray<OrderLineInput> | null | undefined): string[] {
  const errors: string[] = [];
  if (!Array.isArray(items) || items.length === 0) return ['В заказе нет позиций'];
  if (items.length > ORDER_MAX_LINES) errors.push(`Не больше ${ORDER_MAX_LINES} позиций в одном заказе`);
  const seen = new Set<string>();
  items.forEach((it, i) => {
    const n = i + 1;
    if (!it || typeof it.productId !== 'string' || it.productId.length === 0) {
      errors.push(`Позиция ${n}: не указан товар`);
      return;
    }
    if (seen.has(it.productId)) errors.push(`Позиция ${n}: товар повторяется`);
    seen.add(it.productId);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > ORDER_MAX_QTY) {
      errors.push(`Позиция ${n}: количество должно быть от 1 до ${ORDER_MAX_QTY}`);
    }
  });
  return errors;
}

/** What the guest owes for the game so far: time plus open bar orders. */
export function sessionTotal(gameAmount: Minor | null | undefined, ordersTotal: Minor): Minor {
  return (gameAmount ?? 0) + ordersTotal;
}
