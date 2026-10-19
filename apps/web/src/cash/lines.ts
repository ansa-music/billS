import type { CheckItemView, CheckView, HubState, Minor, OrderView, SessionView } from '@bills/domain';

/**
 * Check lines and what is owed: games together with their bar orders.
 * Shared by the pay dialog, the unpaid panel, the «Счета» section and the printed receipt.
 */

/** A game line and the bar lines ordered at that game. `game` is null for bar lines whose game is not on the check. */
export interface LineGroup {
  key: string;
  game: CheckItemView | null;
  orders: CheckItemView[];
  /** The table the game (or the orders) were on. */
  tableId: string | null;
}

/**
 * The HUB lists each GAME line followed by its ORDER lines, then the bar lines whose game is
 * not on the check. Groups by game (ORDER lines carry the sessionId of the game they were
 * made at) and keeps that order.
 */
export function groupLines(items: readonly CheckItemView[]): LineGroup[] {
  const groups: LineGroup[] = [];
  const bySession = new Map<string, LineGroup>();
  for (const item of items) {
    const known = item.sessionId != null ? bySession.get(item.sessionId) : undefined;
    if (item.kind === 'GAME') {
      if (known && known.game === null) {
        known.game = item;
        known.key = item.id;
        continue;
      }
      const group: LineGroup = { key: item.id, game: item, orders: [], tableId: item.tableId };
      groups.push(group);
      if (item.sessionId != null) bySession.set(item.sessionId, group);
    } else if (known) {
      known.orders.push(item);
    } else {
      const group: LineGroup = { key: `bar:${item.id}`, game: null, orders: [item], tableId: item.tableId };
      groups.push(group);
      if (item.sessionId != null) bySession.set(item.sessionId, group);
    }
  }
  return groups;
}

/** Sum of the bar (ORDER) lines. */
export function barOf(items: readonly CheckItemView[]): Minor {
  return items.reduce((sum, i) => (i.kind === 'ORDER' ? sum + i.amount : sum), 0);
}

/** «Стол 1, Стол 2 · бар 1 800 ₸» — for lists of checks. */
export function checkSummary(check: CheckView, names: ReadonlyMap<string, string>, money: (a: Minor) => string): string {
  const places = [
    ...new Set(groupLines(check.items).map((g) => g.game?.title ?? (g.tableId != null ? names.get(g.tableId) : undefined) ?? 'Бар')),
  ];
  const bar = barOf(check.items);
  const parts = [places.join(', ') || 'Без позиций'];
  if (bar > 0) parts.push(`бар ${money(bar)}`);
  return parts.join(' · ');
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
  const live = new Set(state.tables.map((t) => t.session?.id));
  const unpaid = new Set(state.unpaid.map((s) => s.id));
  return state.orders
    .filter((o) => o.status === 'OPEN' && o.checkId == null && !live.has(o.sessionId) && !unpaid.has(o.sessionId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Unbilled orders by table, in the order of each table's oldest order. */
export function ordersByTable(orders: readonly OrderView[]): Array<{ tableId: string; orders: OrderView[] }> {
  const byTable = new Map<string, OrderView[]>();
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
