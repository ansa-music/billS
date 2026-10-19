import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CategoryView,
  CheckView,
  CloseShiftResponse,
  HubState,
  OpenPrepaidResponse,
  OrderView,
  PaymentMethod,
  PayResponse,
  ProductView,
  SessionView,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import { all } from '../src/db.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, post, sessionStatus, tableId, waitFor } from './helpers.ts';

/**
 * Bar orders in guest checks: a game's open orders ride on its check as ORDER
 * lines, are paid (and closed) with it, and can be billed on their own.
 */

const MINUTE = 60 * 1000;
const REASON = 'Гость передумал';

type ErrorBody = { error?: { code: string } };
type Part = { method: PaymentMethod; amount: number };
/** An ORDER line as [title, qty, unitPrice, amount, orderId]. */
type Line = [string, number | null, number | null, number, string | null];

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function get<T>(hub: TestHub, url: string): Promise<{ status: number; body: T }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
}

/** `post` from the helpers, with the response typed as the documented view. */
async function send<T = unknown>(hub: TestHub, url: string, body: object = {}, key?: string) {
  const res = await post(hub, url, body, key);
  return { ...res, body: res.body as unknown as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code });
}

async function state(hub: TestHub): Promise<HubState> {
  const res = await get<HubState>(hub, '/api/state');
  assert.equal(res.status, 200);
  return res.body;
}

// ─── Menu and orders ────────────────────────────────────────────────────────

interface Menu {
  beer: ProductView;
  nachos: ProductView;
}

/** A category of its own with «Пиво» 600 ₸ and «Начос» 300 ₸; stock is not tracked. */
async function menu(hub: TestHub): Promise<Menu> {
  const cat = await send<CategoryView>(hub, '/api/bar/categories', { name: 'Тестовый бар' });
  assert.equal(cat.status, 201);
  const make = async (name: string, price: number): Promise<ProductView> => {
    const res = await send<ProductView>(hub, '/api/bar/products', { categoryId: cat.body.id, name, price });
    assert.equal(res.status, 201);
    return res.body;
  };
  return { beer: await make('Пиво', 600_00), nachos: await make('Начос', 300_00) };
}

async function order(hub: TestHub, sessionId: string, items: Array<[ProductView, number]>): Promise<OrderView> {
  const res = await send<OrderView>(hub, `/api/sessions/${sessionId}/orders`, {
    items: items.map(([p, qty]) => ({ productId: p.id, qty })),
  });
  assert.equal(res.status, 201);
  return res.body;
}

function cancelOrder(hub: TestHub, orderId: string, reason = REASON) {
  return send<OrderView>(hub, `/api/orders/${orderId}/cancel`, { reason });
}

async function ordersOf(hub: TestHub, sessionId: string): Promise<OrderView[]> {
  const res = await get<{ orders: OrderView[] }>(hub, `/api/sessions/${sessionId}/orders`);
  assert.equal(res.status, 200);
  return res.body.orders;
}

async function openOrder(hub: TestHub, orderId: string): Promise<OrderView | undefined> {
  return (await state(hub)).orders.find((o) => o.id === orderId);
}

// ─── Games ──────────────────────────────────────────────────────────────────

/** Opens a table and waits until the lamp confirms. */
async function openGame(hub: TestHub, table: string): Promise<string> {
  const opened = await post(hub, `/api/tables/${tableId(hub, table)}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  return opened.body.id;
}

async function stopGame(hub: TestHub, id: string): Promise<SessionView> {
  const stopped = await post(hub, `/api/sessions/${id}/stop`);
  assert.equal(stopped.status, 200);
  return stopped.body;
}

/** Opens a table, lets the game run for `minutes` and stops it. */
async function playGame(hub: TestHub, h: Harness, table: string, minutes: number): Promise<string> {
  const id = await openGame(hub, table);
  h.clock.advance(minutes * MINUTE);
  await stopGame(hub, id);
  return id;
}

/** Opens a paid prepaid game (cash, exact amount) and waits until the lamp confirms. */
async function openPaid(hub: TestHub, table: string, minutes: number, amount: number): Promise<OpenPrepaidResponse> {
  const res = await send<OpenPrepaidResponse>(hub, `/api/tables/${tableId(hub, table)}/open-prepaid`, {
    minutes,
    amount,
    parts: [{ method: 'CASH', amount }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.check.status, 'PAID');
  await waitFor(() => sessionStatus(hub, res.body.session.id) === 'ACTIVE');
  return res.body;
}

// ─── Checks, payments, shift ────────────────────────────────────────────────

async function createCheck(hub: TestHub, sessionIds: string[], orderIds?: string[]): Promise<CheckView> {
  const res = await send<CheckView>(hub, '/api/checks', orderIds === undefined ? { sessionIds } : { sessionIds, orderIds });
  assert.equal(res.status, 201);
  return res.body;
}

async function getCheck(hub: TestHub, checkId: string): Promise<CheckView> {
  const res = await get<CheckView>(hub, `/api/checks/${checkId}`);
  assert.equal(res.status, 200);
  return res.body;
}

function pay(hub: TestHub, checkId: string, parts: Part[]) {
  return send<PayResponse>(hub, `/api/checks/${checkId}/pay`, { parts });
}

function removeItem(hub: TestHub, checkId: string, itemId: string) {
  return send<CheckView>(hub, `/api/checks/${checkId}/items/${itemId}/remove`);
}

async function openShift(hub: TestHub, openingFloat: number): Promise<ShiftView> {
  const res = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat });
  assert.equal(res.status, 201);
  return res.body;
}

function closeShift(hub: TestHub, shiftId: string, countedCash: number) {
  return send<CloseShiftResponse>(hub, `/api/shifts/${shiftId}/close`, { countedCash });
}

async function report(hub: TestHub, shiftId: string): Promise<ShiftReport> {
  const res = await get<ShiftReport>(hub, `/api/shifts/${shiftId}/report`);
  assert.equal(res.status, 200);
  return res.body;
}

function sorted(lines: Line[]): Line[] {
  return [...lines].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** ORDER lines of a check, order-independent. */
function orderLines(check: CheckView): Line[] {
  return sorted(
    check.items.filter((i) => i.kind === 'ORDER').map((i): Line => [i.title, i.qty, i.unitPrice, i.amount, i.orderId]),
  );
}

/** What an order should look like on a check: one line per order line. */
function linesOf(...orders: OrderView[]): Line[] {
  return sorted(orders.flatMap((o) => o.items.map((i): Line => [i.title, i.qty, i.price, i.amount, o.id])));
}

function gameLines(check: CheckView): Array<[string | null, number]> {
  return check.items.filter((i) => i.kind === 'GAME').map((i) => [i.sessionId, i.amount]);
}

// ─── 1. A game's check brings its open orders ───────────────────────────────

test('a check for a game brings its open orders as ORDER lines', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer, nachos } = await menu(hub);

  const game = await openGame(hub, 'Стол 1');
  const first = await order(hub, game, [
    [beer, 2],
    [nachos, 1],
  ]);
  const second = await order(hub, game, [[nachos, 2]]);
  const dropped = await order(hub, game, [[beer, 1]]);
  assert.equal((await cancelOrder(hub, dropped.id)).status, 200);
  const other = await openGame(hub, 'Стол 2');
  const elsewhere = await order(hub, other, [[beer, 1]]);
  h.clock.advance(60 * MINUTE);
  assert.equal((await stopGame(hub, game)).amount, 2000_00);

  const check = await createCheck(hub, [game]);
  assert.deepEqual(gameLines(check), [[game, 2000_00]]);
  assert.deepEqual(
    orderLines(check),
    sorted([
      ['Пиво', 2, 600_00, 1200_00, first.id],
      ['Начос', 1, 300_00, 300_00, first.id],
      ['Начос', 2, 300_00, 600_00, second.id],
    ]),
  );
  assert.deepEqual(
    { subtotal: check.subtotal, total: check.total, due: check.due },
    { subtotal: 4100_00, total: 4100_00, due: 4100_00 },
  );

  const s = await state(hub);
  assert.deepEqual(
    [first.id, second.id].map((id) => s.orders.find((o) => o.id === id)?.checkId),
    [check.id, check.id],
  );
  assert.equal(s.orders.find((o) => o.id === elsewhere.id)?.checkId, null);
  const listed = await ordersOf(hub, game);
  assert.deepEqual(
    listed.filter((o) => o.status === 'OPEN').map((o) => [o.id, o.checkId]).sort(),
    [
      [first.id, check.id],
      [second.id, check.id],
    ].sort(),
  );
});

// ─── 2. Orders join an open check ───────────────────────────────────────────

test('an order placed while the game check is open joins it at once', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const check = await createCheck(hub, [game]);
  assert.equal(check.total, 2000_00);

  const late = await order(hub, game, [[beer, 1]]);
  const now = await getCheck(hub, check.id);
  assert.equal(now.status, 'OPEN');
  assert.equal(now.total, 2600_00);
  assert.equal(now.due, 2600_00);
  assert.deepEqual(orderLines(now), [['Пиво', 1, 600_00, 600_00, late.id]]);
  assert.equal((await openOrder(hub, late.id))?.checkId, check.id);
  assert.equal((await state(hub)).checks.find((c) => c.id === check.id)?.total, 2600_00);
});

test('adding a game to a check brings its open orders too', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { nachos } = await menu(hub);
  const a = await playGame(hub, h, 'Стол 1', 60);
  const b = await playGame(hub, h, 'Стол 2', 30);
  const ob = await order(hub, b, [[nachos, 2]]);
  const check = await createCheck(hub, [a]);
  assert.deepEqual(orderLines(check), []);
  assert.equal(check.total, 2000_00);

  const added = await send<CheckView>(hub, `/api/checks/${check.id}/items`, { sessionId: b });
  assert.equal(added.status, 200);
  assert.deepEqual(gameLines(added.body).sort(), [
    [a, 2000_00],
    [b, 1000_00],
  ].sort());
  assert.deepEqual(orderLines(added.body), [['Начос', 2, 300_00, 600_00, ob.id]]);
  assert.equal(added.body.total, 3600_00);
  assert.equal((await openOrder(hub, ob.id))?.checkId, check.id);
});

// ─── 3. Removing lines ──────────────────────────────────────────────────────

test('an ORDER line cannot be removed from a check', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const o = await order(hub, game, [[beer, 1]]);
  const check = await createCheck(hub, [game]);
  const line = check.items.find((i) => i.kind === 'ORDER' && i.orderId === o.id);
  assert.ok(line, 'the order is on the check');

  assertError(await removeItem(hub, check.id, line.id), 409, 'ORDER_LINE_LOCKED');
  const now = await getCheck(hub, check.id);
  assert.equal(now.total, 2600_00);
  assert.deepEqual(orderLines(now), linesOf(o));
});

test('removing a game takes its ORDER lines off the check', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer, nachos } = await menu(hub);
  const a = await playGame(hub, h, 'Стол 1', 60);
  const b = await playGame(hub, h, 'Стол 2', 30);
  const oa = await order(hub, a, [[beer, 1]]);
  const ob = await order(hub, b, [[nachos, 1]]);
  const check = await createCheck(hub, [a, b]);
  assert.equal(check.total, 2000_00 + 600_00 + 1000_00 + 300_00);

  const gameA = check.items.find((i) => i.kind === 'GAME' && i.sessionId === a)!;
  const removed = await removeItem(hub, check.id, gameA.id);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.status, 'OPEN');
  assert.deepEqual(gameLines(removed.body), [[b, 1000_00]]);
  assert.deepEqual(orderLines(removed.body), linesOf(ob));
  assert.equal(removed.body.total, 1300_00);

  const s = await state(hub);
  const back = s.orders.find((o) => o.id === oa.id);
  assert.deepEqual([back?.status, back?.checkId], ['OPEN', null]);
  assert.equal(s.orders.find((o) => o.id === ob.id)?.checkId, check.id);
  assert.equal(s.unpaid.find((g) => g.id === a)?.checkId, null);
});

// ─── 4. Discount ────────────────────────────────────────────────────────────

test('a percent discount covers both the game and the bar', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  await order(hub, game, [[beer, 2]]);
  const check = await createCheck(hub, [game]);
  assert.equal(check.subtotal, 3200_00);

  const res = await send<CheckView>(hub, `/api/checks/${check.id}/discount`, {
    discount: { kind: 'PERCENT', value: 10, reason: 'Постоянный гость' },
  });
  assert.equal(res.status, 200);
  const c = res.body;
  assert.deepEqual(
    { subtotal: c.subtotal, discountAmount: c.discountAmount, total: c.total, due: c.due },
    { subtotal: 3200_00, discountAmount: 320_00, total: 2880_00, due: 2880_00 },
  );
});

// ─── 5. Payment ─────────────────────────────────────────────────────────────

test('a partial payment leaves the orders open', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const o = await order(hub, game, [[beer, 1]]);
  const check = await createCheck(hub, [game]);

  const partial = await pay(hub, check.id, [{ method: 'CARD', amount: 500_00 }]);
  assert.equal(partial.status, 200);
  assert.equal(partial.body.check.status, 'OPEN');
  assert.equal(partial.body.remaining, 2100_00);
  assert.equal(sessionStatus(hub, game), 'AWAITING_PAYMENT');
  const open = await openOrder(hub, o.id);
  assert.deepEqual([open?.status, open?.checkId, open?.closedAt], ['OPEN', check.id, null]);
});

test('paying the check in full closes the game and every order on it', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const { beer, nachos } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const first = await order(hub, game, [[beer, 1]]);
  const second = await order(hub, game, [[nachos, 3]]);
  const check = await createCheck(hub, [game]);
  assert.equal(check.total, 2000_00 + 600_00 + 900_00);

  h.clock.advance(MINUTE);
  const paid = await pay(hub, check.id, [{ method: 'CASH', amount: 5000_00 }]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.check.status, 'PAID');
  assert.equal(paid.body.change, 1500_00);
  assert.equal(sessionStatus(hub, game), 'CLOSED');

  const closedAt = paid.body.check.closedAt;
  assert.equal(typeof closedAt, 'number');
  const listed = await ordersOf(hub, game);
  assert.deepEqual(
    listed.map((o) => [o.id, o.status, o.checkId, o.closedAt]).sort(),
    [
      [first.id, 'CLOSED', check.id, closedAt],
      [second.id, 'CLOSED', check.id, closedAt],
    ].sort(),
  );
  const s = await state(hub);
  assert.ok(!s.orders.some((o) => o.id === first.id || o.id === second.id), 'closed orders leave the state');
});

// ─── 6. Cancelling an order ─────────────────────────────────────────────────

test('cancelling an order takes its lines off an unpaid check', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer, nachos } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const keep = await order(hub, game, [[nachos, 2]]);
  const drop = await order(hub, game, [
    [beer, 1],
    [nachos, 1],
  ]);
  const check = await createCheck(hub, [game]);
  assert.equal(check.total, 2000_00 + 600_00 + 900_00);

  const cancelled = await cancelOrder(hub, drop.id);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'CANCELLED');
  const now = await getCheck(hub, check.id);
  assert.equal(now.status, 'OPEN');
  assert.equal(now.total, 2600_00);
  assert.equal(now.due, 2600_00);
  assert.deepEqual(orderLines(now), linesOf(keep));
  assert.ok(auditActions(hub).includes('order.cancelled'));
});

test('a check left with no lines after an order is cancelled becomes void', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 30);
  const o = await order(hub, game, [[beer, 1]]);
  const check = await createCheck(hub, [], [o.id]);

  assert.equal((await cancelOrder(hub, o.id)).status, 200);
  const now = await getCheck(hub, check.id);
  assert.equal(now.status, 'VOID');
  assert.ok(!(await state(hub)).checks.some((c) => c.id === check.id));
});

test('an order on a partly paid check cannot be cancelled', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const o = await order(hub, game, [[beer, 1]]);
  const check = await createCheck(hub, [game]);
  assert.equal((await pay(hub, check.id, [{ method: 'CARD', amount: 500_00 }])).status, 200);

  assertError(await cancelOrder(hub, o.id), 409, 'CHECK_HAS_PAYMENTS');
  const still = await openOrder(hub, o.id);
  assert.deepEqual([still?.status, still?.checkId], ['OPEN', check.id]);
  assert.equal((await getCheck(hub, check.id)).total, 2600_00);
});

test('a closed order cannot be cancelled', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const o = await order(hub, game, [[beer, 1]]);
  const check = await createCheck(hub, [game]);
  assert.equal((await pay(hub, check.id, [{ method: 'CASH', amount: 2600_00 }])).status, 200);

  assertError(await cancelOrder(hub, o.id), 409, 'ORDER_NOT_OPEN');
  assert.equal((await ordersOf(hub, game)).find((x) => x.id === o.id)?.status, 'CLOSED');
});

test('cancelling an order on a check needs a reason', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const o = await order(hub, game, [[beer, 1]]);
  const check = await createCheck(hub, [game]);

  assertError(await cancelOrder(hub, o.id, '   '), 422, 'REASON_REQUIRED');
  const now = await getCheck(hub, check.id);
  assert.equal(now.total, 2600_00);
  assert.deepEqual(orderLines(now), linesOf(o));
  assert.equal((await openOrder(hub, o.id))?.status, 'OPEN');
});

// ─── 7. Orders billed without their game ────────────────────────────────────

test('an order can be billed on a check of its own', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer, nachos } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const alone = await order(hub, game, [
    [beer, 1],
    [nachos, 1],
  ]);
  const rest = await order(hub, game, [[nachos, 2]]);

  const check = await createCheck(hub, [], [alone.id]);
  assert.equal(check.status, 'OPEN');
  assert.ok(check.items.every((i) => i.kind === 'ORDER'), 'only ORDER lines');
  assert.deepEqual(orderLines(check), linesOf(alone));
  assert.equal(check.total, 900_00);
  assert.equal(check.due, 900_00);

  const s = await state(hub);
  assert.equal(s.orders.find((o) => o.id === alone.id)?.checkId, check.id);
  assert.equal(s.orders.find((o) => o.id === rest.id)?.checkId, null);
  assert.equal(s.unpaid.find((g) => g.id === game)?.checkId, null);
});

test('an order already on a check or not open cannot be billed on its own', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const billed = await order(hub, game, [[beer, 1]]);
  await createCheck(hub, [game]);
  assertError(await send(hub, '/api/checks', { sessionIds: [], orderIds: [billed.id] }), 409, 'ORDER_NOT_PAYABLE');

  const other = await playGame(hub, h, 'Стол 2', 30);
  const cancelled = await order(hub, other, [[beer, 1]]);
  assert.equal((await cancelOrder(hub, cancelled.id)).status, 200);
  assertError(await send(hub, '/api/checks', { sessionIds: [], orderIds: [cancelled.id] }), 409, 'ORDER_NOT_PAYABLE');
});

test('a check needs at least one game or order', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  assert.equal((await send(hub, '/api/checks', { sessionIds: [], orderIds: [] })).status, 422);
  assert.equal((await send(hub, '/api/checks', { sessionIds: [] })).status, 422);
  assert.equal(all(hub.db, 'SELECT id FROM checks').length, 0);
});

// ─── 8. Prepaid games ───────────────────────────────────────────────────────

test('an order on a paid prepaid game stays unbilled and is paid on a check of its own', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const { beer } = await menu(hub);
  const prepaid = await openPaid(hub, 'Стол 1', 60, 2000_00);
  const game = prepaid.session.id;

  const o = await order(hub, game, [[beer, 1]]);
  assert.equal((await openOrder(hub, o.id))?.checkId, null);
  const upfront = await getCheck(hub, prepaid.check.id);
  assert.equal(upfront.status, 'PAID');
  assert.equal(upfront.total, 2000_00);
  assert.deepEqual(orderLines(upfront), []);

  h.clock.advance(20 * MINUTE);
  await stopGame(hub, game);
  const left = await openOrder(hub, o.id);
  assert.deepEqual([left?.status, left?.checkId], ['OPEN', null]);

  const check = await createCheck(hub, [], [o.id]);
  assert.deepEqual(orderLines(check), [['Пиво', 1, 600_00, 600_00, o.id]]);
  assert.equal(check.total, 600_00);
  const paid = await pay(hub, check.id, [{ method: 'CASH', amount: 600_00 }]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.check.status, 'PAID');
  assert.equal((await ordersOf(hub, game)).find((x) => x.id === o.id)?.status, 'CLOSED');
  assert.ok(!(await state(hub)).orders.some((x) => x.id === o.id));
});

// ─── 9. Shift close ─────────────────────────────────────────────────────────

test('the shift cannot close while an open order is on no check', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const { beer } = await menu(hub);
  const prepaid = await openPaid(hub, 'Стол 1', 60, 2000_00);
  const o = await order(hub, prepaid.session.id, [[beer, 1]]);
  h.clock.advance(20 * MINUTE);
  await stopGame(hub, prepaid.session.id);
  assert.equal(sessionStatus(hub, prepaid.session.id), 'CLOSED');
  assert.deepEqual((await state(hub)).unpaid, []);

  assertError(await closeShift(hub, shift.id, 3000_00), 409, 'UNPAID_CHECKS');
  assert.equal((await state(hub)).shift?.status, 'OPEN');

  const check = await createCheck(hub, [], [o.id]);
  assert.equal((await pay(hub, check.id, [{ method: 'CASH', amount: 600_00 }])).status, 200);
  const closed = await closeShift(hub, shift.id, 3600_00);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.report.difference, 0);
});

// ─── 10. Revenue in the X/Z report ──────────────────────────────────────────

test('the shift report splits revenue into time and bar, discount included', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const { beer } = await menu(hub);
  const game = await playGame(hub, h, 'Стол 1', 60);
  await order(hub, game, [[beer, 2]]);
  const check = await createCheck(hub, [game]);
  const discounted = await send<CheckView>(hub, `/api/checks/${check.id}/discount`, {
    discount: { kind: 'PERCENT', value: 10, reason: 'Постоянный гость' },
  });
  assert.equal(discounted.status, 200);
  const paid = await pay(hub, check.id, [{ method: 'CASH', amount: 2880_00 }]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.check.status, 'PAID');
  const total = paid.body.check.total;
  assert.equal(total, 2880_00);

  const x = await report(hub, shift.id);
  assert.equal(x.kind, 'X');
  assert.deepEqual(x.revenue, { time: 1800_00, bar: 1080_00 });
  assert.equal(x.revenue.time + x.revenue.bar, total);

  const closed = await closeShift(hub, shift.id, 1000_00 + 2880_00);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.report.kind, 'Z');
  assert.deepEqual(closed.body.report.revenue, { time: 1800_00, bar: 1080_00 });
});

// ─── 11. Audit and outbox ───────────────────────────────────────────────────

test('every step of the bar-and-check cycle is audited and queued for the cloud', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const { beer, nachos } = await menu(hub);

  const game = await openGame(hub, 'Стол 1');
  await order(hub, game, [[beer, 2]]);
  const drop = await order(hub, game, [[nachos, 1]]);
  h.clock.advance(60 * MINUTE);
  await stopGame(hub, game);
  const check = await createCheck(hub, [game]);
  assert.equal((await cancelOrder(hub, drop.id)).status, 200);
  await order(hub, game, [[nachos, 1]]);
  const discounted = await send<CheckView>(hub, `/api/checks/${check.id}/discount`, {
    discount: { kind: 'AMOUNT', value: 100_00, reason: 'Акция дня' },
  });
  assert.equal(discounted.status, 200);
  const due = discounted.body.due;
  assert.equal((await pay(hub, check.id, [{ method: 'CARD', amount: 500_00 }])).status, 200);
  assert.equal((await pay(hub, check.id, [{ method: 'CASH', amount: due - 500_00 }])).status, 200);

  const prepaid = await openPaid(hub, 'Стол 2', 60, 2000_00);
  const late = await order(hub, prepaid.session.id, [[beer, 1]]);
  h.clock.advance(10 * MINUTE);
  await stopGame(hub, prepaid.session.id);
  const own = await createCheck(hub, [], [late.id]);
  assert.equal((await pay(hub, own.id, [{ method: 'CASH', amount: 600_00 }])).status, 200);

  const expected = (await state(hub)).shift?.expectedCash ?? NaN;
  assert.equal((await closeShift(hub, shift.id, expected)).status, 200);

  const actions = auditActions(hub);
  assert.ok(actions.includes('order.created') && actions.includes('order.cancelled'), actions.join(', '));
  const audit = all(hub.db, 'SELECT id FROM audit_log').length;
  const outbox = all(hub.db, 'SELECT id FROM outbox').length;
  assert.equal(outbox, audit);
});

// ─── 12. UPS dev endpoint without a simulator ───────────────────────────────

test('the UPS dev endpoint answers "not configured" when the HUB has no simulator', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await get<{ configured: boolean }>(hub, '/api/dev/ups');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { configured: false });
});
