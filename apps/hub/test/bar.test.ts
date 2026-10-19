import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CatalogView, OrderView, ProductView } from '@bills/domain';
import { all, run } from '../src/db.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

function catalog(t: TestHub): CatalogView {
  return t.hub.bar.catalog();
}

function product(t: TestHub, name: string): ProductView {
  const p = catalog(t).products.find((x) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p;
}

async function openActive(t: TestHub, table = 'Стол 1'): Promise<string> {
  const opened = await post(t, `/api/tables/${tableId(t, table)}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(t, opened.body.id) === 'ACTIVE');
  return opened.body.id;
}

async function order(t: TestHub, sessionId: string, items: Array<{ productId: string; qty: number }>, note?: string, key?: string) {
  const res = await post(t, `/api/sessions/${sessionId}/orders`, note === undefined ? { items } : { items, note }, key);
  return { status: res.status, body: res.body as unknown as OrderView & { error?: { code: string; message: string } }, headers: res.headers };
}

test('the demo menu is seeded and served by the catalog', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await hub.app.inject({ method: 'GET', url: '/api/bar/catalog' });
  assert.equal(res.statusCode, 200);
  const c = res.json() as CatalogView;
  assert.deepEqual(c.categories.map((x) => x.name), ['Напитки', 'Снеки', 'Аренда']);
  assert.ok(c.products.length >= 10);
  assert.ok(c.products.every((p) => p.stock === null && p.isActive));
});

test('an order on a running game shows up in the state and the game total', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const cola = product(hub, 'Кола 0,5');
  const chips = product(hub, 'Чипсы');

  const res = await order(hub, sessionId, [{ productId: cola.id, qty: 2 }, { productId: chips.id, qty: 1 }], 'без льда');
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'OPEN');
  assert.equal(res.body.sessionId, sessionId);
  assert.equal(res.body.tableId, tableId(hub, 'Стол 1'));
  assert.equal(res.body.note, 'без льда');
  assert.equal(res.body.total, 2 * 600_00 + 700_00);
  assert.equal(res.body.createdBy, 'Кассир Айгерим');
  assert.deepEqual(
    res.body.items.map((i) => [i.title, i.price, i.qty, i.amount]),
    [
      ['Кола 0,5', 600_00, 2, 1200_00],
      ['Чипсы', 700_00, 1, 700_00],
    ],
  );

  const state = hub.hub.state();
  assert.deepEqual(state.orders.map((o) => o.id), [res.body.id]);
  assert.equal(tableState(hub, 'Стол 1').session?.ordersTotal, 1900_00);

  const list = await hub.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/orders` });
  assert.equal(list.statusCode, 200);
  assert.deepEqual((list.json() as { orders: OrderView[] }).orders.map((o) => o.id), [res.body.id]);
});

test('a stopped game waiting for payment still takes orders', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  h.clock.advance(30 * 60 * 1000);
  const stopped = await post(hub, `/api/sessions/${sessionId}/stop`);
  assert.equal(stopped.body.status, 'AWAITING_PAYMENT');

  const tea = product(hub, 'Чай');
  const res = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }]);
  assert.equal(res.status, 201);

  const state = hub.hub.state();
  assert.equal(state.unpaid[0]?.ordersTotal, 500_00);
  assert.equal(state.unpaid[0]?.amount, 1000_00); // time is untouched by orders
  assert.equal(state.orders.length, 1);
});

test('orders are refused on a free table, a game that has not started and a closed game', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const tea = product(hub, 'Чай');

  const missing = await order(hub, randomUUID(), [{ productId: tea.id, qty: 1 }]);
  assert.equal(missing.status, 404);

  hub.driver.offline = true;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  assert.equal(opened.body.status, 'OPENING');
  const early = await order(hub, opened.body.id, [{ productId: tea.id, qty: 1 }]);
  assert.equal(early.status, 409);
  assert.equal(early.body.error?.code, 'SESSION_NOT_ORDERABLE');
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');
  hub.driver.offline = false;

  const sessionId = await openActive(hub, 'Стол 3');
  await post(hub, `/api/sessions/${sessionId}/stop`);
  run(hub.db, "UPDATE table_sessions SET status = 'CLOSED' WHERE id = ?", sessionId);
  const closed = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }]);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error?.code, 'SESSION_NOT_ORDERABLE');
});

test('bad lines are rejected with a readable message', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const tea = product(hub, 'Чай');

  const empty = await order(hub, sessionId, []);
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error?.code, 'ORDER_INVALID');

  const zero = await order(hub, sessionId, [{ productId: tea.id, qty: 0 }]);
  assert.equal(zero.status, 422);
  assert.match(zero.body.error?.message ?? '', /от 1 до 99/);

  const dup = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }, { productId: tea.id, qty: 1 }]);
  assert.equal(dup.status, 422);

  const unknown = await order(hub, sessionId, [{ productId: randomUUID(), qty: 1 }]);
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error?.code, 'PRODUCT_NOT_AVAILABLE');

  assert.equal(hub.hub.state().orders.length, 0);
});

test('inactive products and products of an inactive category are not sold', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const tea = product(hub, 'Чай');
  const chalk = product(hub, 'Мел');
  const rent = catalog(hub).categories.find((c) => c.name === 'Аренда')!;

  await post(hub, `/api/bar/products/${tea.id}/update`, { isActive: false });
  const off = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }]);
  assert.equal(off.status, 422);
  assert.equal(off.body.error?.code, 'PRODUCT_NOT_AVAILABLE');
  assert.match(off.body.error?.message ?? '', /Чай/);

  await post(hub, `/api/bar/categories/${rent.id}/update`, { isActive: false });
  const catOff = await order(hub, sessionId, [{ productId: chalk.id, qty: 1 }]);
  assert.equal(catOff.status, 422);
  assert.match(catOff.body.error?.message ?? '', /Мел/);
  // The product itself is untouched: switching the category back on brings it back.
  assert.equal(product(hub, 'Мел').isActive, true);
});

test('a price change after ordering does not reprice the order', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const cola = product(hub, 'Кола 0,5');
  const placed = await order(hub, sessionId, [{ productId: cola.id, qty: 1 }]);
  assert.equal(placed.body.total, 600_00);

  const upd = await post(hub, `/api/bar/products/${cola.id}/update`, { price: 999_00, name: 'Кола большая' });
  assert.equal(upd.status, 200);
  assert.equal(product(hub, 'Кола большая').price, 999_00);

  const list = (await hub.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/orders` })).json() as { orders: OrderView[] };
  assert.equal(list.orders[0]?.total, 600_00);
  assert.equal(list.orders[0]?.items[0]?.title, 'Кола 0,5');
  assert.equal(list.orders[0]?.items[0]?.price, 600_00);
  assert.equal(tableState(hub, 'Стол 1').session?.ordersTotal, 600_00);
});

test('tracked stock goes down with orders, refuses what is not there and comes back on cancel', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const nuts = product(hub, 'Орешки');
  assert.equal((await post(hub, `/api/bar/products/${nuts.id}/update`, { stock: 3 })).status, 200);

  const first = await order(hub, sessionId, [{ productId: nuts.id, qty: 2 }]);
  assert.equal(first.status, 201);
  assert.equal(product(hub, 'Орешки').stock, 1);

  const tooMany = await order(hub, sessionId, [{ productId: nuts.id, qty: 2 }]);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error?.code, 'OUT_OF_STOCK');
  assert.match(tooMany.body.error?.message ?? '', /Орешки \(осталось 1\)/);
  assert.equal(product(hub, 'Орешки').stock, 1);
  assert.equal(all(hub.db, 'SELECT id FROM bar_orders').length, 1);

  const cancelled = await post(hub, `/api/orders/${first.body.id}/cancel`, { reason: 'Гость передумал' });
  assert.equal(cancelled.status, 200);
  const view = cancelled.body as unknown as OrderView;
  assert.equal(view.status, 'CANCELLED');
  assert.equal(view.cancelReason, 'Гость передумал');
  assert.equal(view.cancelledBy, 'Кассир Айгерим');
  assert.ok(view.cancelledAt);
  assert.equal(product(hub, 'Орешки').stock, 3);

  // Cancelled orders leave the state and the game total, but stay in the history.
  assert.equal(hub.hub.state().orders.length, 0);
  assert.equal(tableState(hub, 'Стол 1').session?.ordersTotal, 0);
  const list = (await hub.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/orders` })).json() as { orders: OrderView[] };
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0]?.status, 'CANCELLED');

  const again = await post(hub, `/api/orders/${first.body.id}/cancel`, { reason: 'Ещё раз' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error?.code, 'ORDER_NOT_OPEN');
});

test('cancelling needs a reason and is impossible once the order is paid', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const tea = product(hub, 'Чай');
  const placed = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }]);

  const noReason = await post(hub, `/api/orders/${placed.body.id}/cancel`, { reason: '  ' });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.error?.code, 'REASON_REQUIRED');
  const short = await post(hub, `/api/orders/${placed.body.id}/cancel`, { reason: 'ok' });
  assert.equal(short.status, 422);

  assert.equal((await post(hub, `/api/orders/${randomUUID()}/cancel`, { reason: 'Нет такого' })).status, 404);

  // The game's check takes the order; once the check is paid the order is CLOSED for good.
  await post(hub, `/api/sessions/${sessionId}/stop`);
  await post(hub, '/api/shifts/open', { openingFloat: 0 });
  const check = (await post(hub, '/api/checks', { sessionIds: [sessionId] })).body as unknown as { id: string; due: number };
  assert.equal((await post(hub, `/api/checks/${check.id}/pay`, { parts: [{ method: 'CARD', amount: check.due }] })).status, 200);
  const late = await post(hub, `/api/orders/${placed.body.id}/cancel`, { reason: 'Поздно' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error?.code, 'ORDER_NOT_OPEN');
  assert.equal(all(hub.db, "SELECT id FROM bar_orders WHERE status = 'CLOSED'").length, 1);
});

test('a replayed order request does not create a second order', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const sessionId = await openActive(hub);
  const tea = product(hub, 'Чай');
  const key = randomUUID();

  const first = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }], undefined, key);
  const second = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }], undefined, key);
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(all(hub.db, 'SELECT id FROM bar_orders').length, 1);
  assert.equal(tableState(hub, 'Стол 1').session?.ordersTotal, 500_00);

  const different = await order(hub, sessionId, [{ productId: tea.id, qty: 2 }], undefined, key);
  assert.equal(different.status, 422);
  assert.equal(different.body.error?.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('catalog and order actions are audited and announced', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const kinds: string[] = [];
  hub.hub.events.on('changed', (e) => kinds.push(e.kind));
  const sessionId = await openActive(hub);
  const tea = product(hub, 'Чай');

  const cat = await post(hub, '/api/bar/categories', { name: 'Кальян' });
  assert.equal(cat.status, 201);
  const created = await post(hub, '/api/bar/products', { categoryId: (cat.body as unknown as { id: string }).id, name: 'Кальян классика', price: 5000_00, stock: 10 });
  assert.equal(created.status, 201);
  await post(hub, `/api/bar/products/${(created.body as unknown as { id: string }).id}/update`, { price: 5500_00 });
  await post(hub, `/api/bar/categories/${(cat.body as unknown as { id: string }).id}/update`, { name: 'Кальяны' });
  const placed = await order(hub, sessionId, [{ productId: tea.id, qty: 1 }]);
  await post(hub, `/api/orders/${placed.body.id}/cancel`, { reason: 'Ошибка официанта' });

  const actions = auditActions(hub).filter((a) => /^(category|product|order)\./.test(a));
  assert.deepEqual(actions, [
    'category.created',
    'product.created',
    'product.updated',
    'category.updated',
    'order.created',
    'order.cancelled',
  ]);
  const entry = all<{ actor: string; data: string }>(hub.db, "SELECT actor, data FROM audit_log WHERE action = 'order.created'")[0]!;
  assert.equal(entry.actor, 'Кассир Айгерим');
  const data = JSON.parse(entry.data) as { sessionId: string; tableId: string; total: number; items: unknown[] };
  assert.equal(data.sessionId, sessionId);
  assert.equal(data.tableId, tableId(hub, 'Стол 1'));
  assert.equal(data.total, 500_00);
  assert.equal(data.items.length, 1);
  assert.ok(kinds.includes('catalog') && kinds.includes('order'));
  assert.equal(all(hub.db, 'SELECT id FROM outbox').length, all(hub.db, 'SELECT id FROM audit_log').length);
});

test('catalog basics: names, prices, stock and uniqueness are checked', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const drinks = catalog(hub).categories.find((c) => c.name === 'Напитки')!;

  assert.equal((await post(hub, '/api/bar/categories', { name: '   ' })).status, 422);
  assert.equal((await post(hub, '/api/bar/categories', { name: 'x'.repeat(61) })).status, 422);
  const dup = await post(hub, '/api/bar/categories', { name: 'напитки' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error?.code, 'CATEGORY_EXISTS');

  const cat = await post(hub, '/api/bar/categories', { name: 'Десерты' });
  assert.equal(cat.status, 201);
  const catView = cat.body as unknown as { id: string; sortOrder: number; isActive: boolean };
  assert.equal(catView.sortOrder, 4);
  assert.equal(catView.isActive, true);

  const negative = await post(hub, '/api/bar/products', { categoryId: drinks.id, name: 'Сок', price: -1 });
  assert.equal(negative.status, 422);
  assert.equal(negative.body.error?.code, 'PRICE_INVALID');
  assert.equal((await post(hub, '/api/bar/products', { categoryId: drinks.id, name: 'Сок', price: 10.5 })).status, 422);
  assert.equal((await post(hub, '/api/bar/products', { categoryId: drinks.id, name: 'Сок', price: 100, stock: -2 })).status, 422);
  assert.equal((await post(hub, '/api/bar/products', { categoryId: randomUUID(), name: 'Сок', price: 100 })).status, 404);
  assert.equal((await post(hub, '/api/bar/products', { categoryId: drinks.id, name: '', price: 100 })).status, 422);
  assert.equal((await post(hub, '/api/bar/products', { categoryId: drinks.id, name: 'Сок', price: 100, extra: 1 })).status, 201);

  const juice = product(hub, 'Сок');
  assert.equal(juice.price, 100);
  assert.equal(juice.stock, null);
  assert.equal(juice.sortOrder, 6);

  const moved = await post(hub, `/api/bar/products/${juice.id}/update`, { categoryId: catView.id, stock: 5, name: ' Сок  яблочный ' });
  assert.equal(moved.status, 200);
  const movedView = moved.body as unknown as ProductView;
  assert.equal(movedView.categoryId, catView.id);
  assert.equal(movedView.stock, 5);
  assert.equal(movedView.name, 'Сок яблочный');
  const untracked = await post(hub, `/api/bar/products/${juice.id}/update`, { stock: null });
  assert.equal((untracked.body as unknown as ProductView).stock, null);

  // Deactivated categories free their name; the name stays taken while active.
  assert.equal((await post(hub, `/api/bar/categories/${catView.id}/update`, { isActive: false })).status, 200);
  assert.equal((await post(hub, '/api/bar/categories', { name: 'Десерты' })).status, 201);
  const back = await post(hub, `/api/bar/categories/${catView.id}/update`, { isActive: true });
  assert.equal(back.status, 409);

  const c = catalog(hub);
  assert.ok(c.categories.some((x) => !x.isActive));
  assert.equal(c.categories.length, 5);
});
