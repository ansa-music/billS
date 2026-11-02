import type { CheckItemView, CheckLineGroup, CheckView, HubState, Minor, OrderView, SessionView } from '@bills/domain';
import { groupCheckLines } from '@bills/domain';

/**
 * Check lines and what is owed: games together with their bar orders.
 * Shared by the pay dialog, the unpaid panel, the «Счета» section and the printed receipt
 * (the receipt groups through the same domain function, packages/domain receipt.ts).
 */

/** A game line and the bar lines ordered at that game. `game` is null for bar lines whose game is not on the check. */
export type LineGroup = CheckLineGroup;

/** Games with their bar lines, in the HUB's order (groupCheckLines). */
export const groupLines = groupCheckLines;

/** Sum of the bar (ORDER) lines. */
export function barOf(items: readonly CheckItemView[]): Minor {
  return items.reduce((sum, i) => (i.kind === 'ORDER' ? sum + i.amount : sum), 0);
}

/** «Стол 1, Стол 2 · бар 1 800 ₸» — for lists of checks. */
export function checkSummary(check: CheckView, names: ReadonlyMap<string, string>, money: (a: Minor) => string): string {
  const places = [
    ...new Set(groupLines(check.items).map((g) => g.game?.title ?? (g.tableId != null ? (names.get(g.tableId) ?? 'Бар') : 'Стойка'))),
  ];
  const bar = barOf(check.items);
  const parts = [places.join(', ') || 'Без позиций'];
  if (bar > 0) parts.push(`бар ${money(bar)}`);
  return parts.join(' · ');
}

/** Where an order was made: the table's name, or «Стойка» for a coffee shop counter order (no table). */
export function placeName(names: ReadonlyMap<string, string>, tableId: string | null | undefined): string {
  return tableId == null ? 'Стойка' : (names.get(tableId) ?? 'Стол');
}

/** What a stopped game not on a check costs: time plus its open bar orders. */
export function gameDue(s: SessionView): Minor {
  return (s.amount ?? 0) + s.ordersTotal;
}

/** «Пиво светлое ×2, Чипсы ×1» */
export function orderSummary(order: OrderView): string {
  return order.items.map((i) => `${i.title} ×${i.qty}`).join(', ') || 'Без позиций';
}

/**
 * Open bar orders that no check will pick up by itself: on no check, and their game is over
 * (paid upfront, voided, …) — neither on a table nor waiting for payment. Oldest first.
 */
export function unbilledOrders(state: HubState): OrderView[] {
  const live = new Set<string | null | undefined>(state.tables.map((t) => t.session?.id));
  const unpaid = new Set<string | null | undefined>(state.unpaid.map((s) => s.id));
  // Counter orders (coffee shop) have no game: sessionId is null, so they count as «after the game».
  return state.orders
    .filter((o) => o.status === 'OPEN' && o.checkId == null && !live.has(o.sessionId) && !unpaid.has(o.sessionId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Unbilled orders by table, in the order of each table's oldest order. */
export function ordersByTable(orders: readonly OrderView[]): Array<{ tableId: string | null; orders: OrderView[] }> {
  // A counter order has no table (null): those group together under «Стойка».
  const byTable = new Map<string | null, OrderView[]>();
  for (const o of orders) {
    const list = byTable.get(o.tableId);
    if (list) list.push(o);
    else byTable.set(o.tableId, [o]);
  }
  return [...byTable].map(([tableId, list]) => ({ tableId, orders: list }));
}

/** Everything still owed: open checks, stopped games not on a check (with their bar), unbilled orders. */
export function owedTotal(state: HubState): Minor {
  return (
    state.checks.reduce((sum, c) => sum + c.due, 0) +
    state.unpaid.filter((s) => s.checkId == null).reduce((sum, s) => sum + gameDue(s), 0) +
    unbilledOrders(state).reduce((sum, o) => sum + o.total, 0)
  );
}
