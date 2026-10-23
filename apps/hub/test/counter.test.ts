import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CatalogView,
  CheckView,
  ClubAdminView,
  CounterBoardView,
  CounterOrdersView,
  CounterOrderView,
  CreateCounterOrderResponse,
  HubState,
  OrderView,
  PaymentMethod,
  ProductOptionGroup,
  ProductView,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import { all, MIGRATIONS_DIR, one, openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { SimulatorUps } from '../src/power/ups.ts';
import type { TestHub } from './helpers.ts';
import { Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';

/**
 * Coffee shop counter: an order from the menu with options, paid at once on its own
 * check, a number of the working day, stages at the bar, the public guest board.
 */

const HOUR = 60 * 60 * 1000;
type ErrorBody = { error?: { code: string; message: string } };
type Part = { method: PaymentMethod; amount: number };
type Line = { product: string; qty?: number; options?: string[] };

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** A demo coffee shop (HUB_DEMO_BUSINESS=cafe): seeded before the HUB starts, so the default seed is a no-op. */
async function cafe(h: Harness, options: Parameters<Harness['start']>[1] = {}): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }), options);
}

async function get<T>(hub: TestHub, url: string): Promise<{ status: number; body: T & ErrorBody }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

async function send<T = unknown>(hub: TestHub, url: string, body: object = {}, key?: string) {
  const res = await post(hub, url, body, key);
  return { ...res, body: res.body as unknown as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code });
}

async function catalog(hub: TestHub): Promise<CatalogView> {
  return (await get<CatalogView>(hub, '/api/bar/catalog')).body;
}

async function product(hub: TestHub, name: string): Promise<ProductView> {
  const p = (await catalog(hub)).products.find((x) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p;
}

async function openShift(hub: TestHub, openingFloat = 10_000_00): Promise<ShiftView> {
  const res = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat });
  assert.equal(res.status, 201);
  return res.body;
}

async function take(
  hub: TestHub,
  lines: Line[],
  payment: Part[] | null,
  extra: { service?: string; guestName?: string; note?: string } = {},
  key?: string,
) {
  const items = await Promise.all(
    lines.map(async (l) => ({
      productId: (await product(hub, l.product)).id,
      qty: l.qty ?? 1,
      ...(l.options ? { options: l.options } : {}),
    })),
  );
  return send<CreateCounterOrderResponse>(
    hub,
    '/api/counter/orders',
    { items, service: extra.service ?? 'HERE', payment: payment && { parts: payment }, ...extra },
    key,
  );
}

async function taken(hub: TestHub, lines: Line[], payment: Part[] | null = null, guestName?: string) {
  const res = await take(hub, lines, payment, guestName ? { guestName } : {});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function stage(hub: TestHub, id: string, to: string) {
  return send<CounterOrderView>(hub, `/api/counter/orders/${id}/stage`, { stage: to });
}

function cancel(hub: TestHub, id: string, reason = 'Гость ушёл') {
  return send<CounterOrderView>(hub, `/api/counter/orders/${id}/cancel`, { reason });
}

function counts(hub: TestHub) {
  const n = (sql: string) => one<{ n: number }>(hub.db, sql)?.n ?? 0;
  return {
    orders: n('SELECT COUNT(*) AS n FROM bar_orders'),
    lines: n('SELECT COUNT(*) AS n FROM bar_order_items'),
    checks: n('SELECT COUNT(*) AS n FROM checks'),
    payments: n('SELECT COUNT(*) AS n FROM payments'),
  };
}

const CAPPUCCINO_L_OAT = { product: 'Капучино', options: ['l', 'oat'] };

// ─── Taking an order with its payment ───────────────────────────────────────

test('take and pay in cash: change, a paid check, the order closed, stock down, the bar revenue in X', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const shift = await openShift(hub);

  const res = await take(
    hub,
    [CAPPUCCINO_L_OAT, { product: 'Круассан', qty: 2 }],
    [{ method: 'CASH', amount: 4000_00 }],
    { service: 'TAKEAWAY', guestName: '  Аня  ' },
  );
  assert.equal(res.status, 201);
  const { order, check, payment } = res.body;
  // 1200 + L 400 + oat 300 = 1900; croissants 2 × 900.
  assert.equal(order.total, 3700_00);
  assert.equal(order.number, 1);
  assert.equal(order.stage, 'NEW');
  assert.equal(order.status, 'CLOSED');
  assert.equal(order.service, 'TAKEAWAY');
  assert.equal(order.guestName, 'Аня');
  assert.equal(order.checkId, check.id);
  assert.deepEqual(
    order.items.map((i) => [i.title, i.optionNames, i.unitPrice, i.qty, i.amount]),
    [
      ['Капучино · L · Овсяное', ['L', 'Овсяное'], 1900_00, 1, 1900_00],
      ['Круассан', [], 900_00, 2, 1800_00],
    ],
  );
  assert.equal(check.status, 'PAID');
  assert.deepEqual(
    check.items.map((i) => [i.kind, i.title, i.amount, i.sessionId, i.tableId]),
    [
      ['ORDER', 'Капучино · L · Овсяное', 1900_00, null, null],
      ['ORDER', 'Круассан', 1800_00, null, null],
    ],
  );
  assert.deepEqual(payment && { applied: payment.applied, change: payment.change, remaining: payment.remaining }, {
    applied: 3700_00,
    change: 300_00,
    remaining: 0,
  });
  assert.equal((await product(hub, 'Круассан')).stock, 10);

  const x = await get<ShiftReport>(hub, `/api/shifts/${shift.id}/report`);
  assert.deepEqual(x.body.revenue, { time: 0, bar: 3700_00 });
  assert.equal(x.body.sales.CASH, 3700_00);
  assert.equal(x.body.checksPaid, 1);

  const actions = all<{ action: string }>(hub.db, 'SELECT action FROM audit_log ORDER BY id').map((r) => r.action);
  for (const a of ['order.created', 'check.created', 'check.item_added', 'payment.accepted', 'order.closed', 'check.paid']) {
    assert.ok(actions.includes(a), a);
  }
  // The outbox carries the same events for the cloud.
  assert.ok((one<{ n: number }>(hub.db, "SELECT COUNT(*) AS n FROM outbox WHERE topic = 'order.created'")?.n ?? 0) >= 1);
});

test('card above the due is refused and nothing is left behind (order, check, stock)', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  const before = counts(hub);
  const res = await take(hub, [{ product: 'Круассан', qty: 1 }], [{ method: 'CARD', amount: 1000_00 }]);
  assertError(res, 422, 'NON_CASH_OVERPAYMENT');
  assert.deepEqual(counts(hub), before);
  assert.equal((await product(hub, 'Круассан')).stock, 12);
  // The number is not used up either.
  assert.equal((await taken(hub, [{ product: 'Круассан' }], [{ method: 'CARD', amount: 900_00 }])).order.number, 1);
});

test('no open shift: a paid order is refused with nothing created; an unpaid one is taken onto an open check', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const before = counts(hub);
  assertError(await take(hub, [{ product: 'Печенье' }], [{ method: 'CASH', amount: 500_00 }]), 409, 'SHIFT_NOT_OPEN');
  assert.deepEqual(counts(hub), before);

  const later = await taken(hub, [{ product: 'Печенье' }], null);
  assert.equal(later.payment, null);
  assert.equal(later.order.status, 'OPEN');
  assert.equal(later.check.status, 'OPEN');
  assert.equal(later.check.due, 500_00);
  // It waits in «Счета» like any open check, and is paid there.
  assert.ok((await get<HubState>(hub, '/api/state')).body.checks.some((c) => c.id === later.check.id));
  await openShift(hub);
  const paid = await send<{ check: CheckView }>(hub, `/api/checks/${later.check.id}/pay`, {
    parts: [{ method: 'QR', amount: 500_00 }],
  });
  assert.equal(paid.status, 200);
  const list = (await get<CounterOrdersView>(hub, '/api/counter/orders')).body;
  assert.equal(list.orders.find((o) => o.id === later.order.id)?.status, 'CLOSED');
});

test('options: priced and named as a snapshot; a catalog change does not reprice the order; several syrups at once', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  const latte = await taken(
    hub,
    [
      { product: 'Латте', options: ['m', 'caramel', 'vanilla', 'extra-shot'] },
      { product: 'Латте', options: ['s'], qty: 2 },
    ],
    [{ method: 'CASH', amount: 10_000_00 }],
  );
  // 1300 + M 200 + 2 syrups 400 + shot 300 = 2200; plain S 1300 × 2.
  assert.deepEqual(
    latte.order.items.map((i) => [i.title, i.unitPrice, i.amount]),
    [
      ['Латте · M · Карамель · Ваниль · Доп. шот эспрессо', 2200_00, 2200_00],
      ['Латте · S', 1300_00, 2600_00],
    ],
  );

  const p = await product(hub, 'Латте');
  const cheaper: ProductOptionGroup[] = p.options.map((g) => ({
    ...g,
    choices: g.choices.map((c) => ({ ...c, priceDelta: 0 })),
  }));
  const upd = await send<ProductView>(hub, `/api/bar/products/${p.id}/update`, { price: 1_00, options: cheaper });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.options[0]?.choices[1]?.priceDelta, 0);
  const again = (await get<CounterOrdersView>(hub, '/api/counter/orders')).body.orders.find((o) => o.id === latte.order.id);
  assert.equal(again?.total, 4800_00);
  assert.equal(again?.items[0]?.title, 'Латте · M · Карамель · Ваниль · Доп. шот эспрессо');
});

test('options: a required group left out, two sizes, an unknown choice or the same line twice are 422', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  const before = counts(hub);
  const cash = [{ method: 'CASH' as const, amount: 5000_00 }];
  const r1 = await take(hub, [{ product: 'Капучино' }], cash);
  assertError(r1, 422, 'OPTION_REQUIRED');
  assert.match(r1.body.error?.message ?? '', /Капучино: выберите «Размер»/);
  assertError(await take(hub, [{ product: 'Капучино', options: ['s', 'l'] }], cash), 422, 'OPTION_SINGLE');
  assertError(await take(hub, [{ product: 'Круассан', options: ['l'] }], cash), 422, 'OPTION_UNKNOWN');
  assertError(await take(hub, [CAPPUCCINO_L_OAT, { product: 'Капучино', options: ['oat', 'l'] }], cash), 422, 'ORDER_INVALID');
  assertError(await take(hub, [{ product: 'Круассан' }], cash, { service: 'DELIVERY' }), 422, 'SERVICE_INVALID');
  assertError(await take(hub, [{ product: 'Круассан' }], cash, { guestName: 'А'.repeat(31) }), 422, 'GUEST_NAME_TOO_LONG');
  assert.deepEqual(counts(hub), before);
});

test('stock: all lines of a product count together; «нет в наличии» refuses the whole order', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  const cheesecake = await product(hub, 'Чизкейк');
  assert.equal(cheesecake.stock, 6);
  const res = await take(hub, [{ product: 'Чизкейк', qty: 7 }], [{ method: 'CASH', amount: 20_000_00 }]);
  assertError(res, 409, 'OUT_OF_STOCK');
  assert.match(res.body.error?.message ?? '', /Нет в наличии: Чизкейк \(осталось 6\)/);
  await taken(hub, [{ product: 'Чизкейк', qty: 6 }], [{ method: 'CASH', amount: 9000_00 }]);
  assert.equal((await product(hub, 'Чизкейк')).stock, 0);
  assertError(await take(hub, [{ product: 'Чизкейк' }], [{ method: 'CASH', amount: 1500_00 }]), 409, 'OUT_OF_STOCK');
});

test('numbers run through the working day and start over at 06:00; live numbers are not handed out twice', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const a = await taken(hub, [{ product: 'Печенье' }]);
  const b = await taken(hub, [{ product: 'Печенье' }]);
  assert.deepEqual([a.order.number, b.order.number], [1, 2]);

  // 02:00 next night is still the same working day.
  h.clock.set(MONDAY_NOON + 14 * HOUR);
  assert.equal((await taken(hub, [{ product: 'Печенье' }])).order.number, 3);

  // 06:00: a new working day. Yesterday's #1 and #3 were handed over, #2 is still on the board.
  await stage(hub, a.order.id, 'ISSUED');
  const third = (await get<CounterOrdersView>(hub, '/api/counter/orders')).body.orders.find((o) => o.number === 3)!;
  await stage(hub, third.id, 'ISSUED');
  h.clock.set(MONDAY_NOON + 18 * HOUR);
  const next = await taken(hub, [{ product: 'Печенье' }]);
  assert.equal(next.order.number, 1);
  assert.equal((await taken(hub, [{ product: 'Печенье' }])).order.number, 3, '#2 of yesterday is still being made');
  const days = all<{ business_day: string }>(hub.db, 'SELECT DISTINCT business_day FROM bar_orders ORDER BY 1').map(
    (r) => r.business_day,
  );
  assert.deepEqual(days, ['2026-10-12', '2026-10-13']);
});

// ─── The bar: stages and the guest board ────────────────────────────────────

test('stages: forward a step, back a step, straight to issued; issued is final; times are kept', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const { order } = await taken(hub, [{ product: 'Чёрный' }]);
  assertError(await stage(hub, order.id, 'READY'), 409, 'STAGE_NOT_ALLOWED');
  assertError(await stage(hub, order.id, 'NEW'), 409, 'STAGE_NOT_ALLOWED');
  assertError(await stage(hub, order.id, 'LOST'), 400, 'BAD_REQUEST');

  assert.equal((await stage(hub, order.id, 'PREPARING')).body.stage, 'PREPARING');
  h.clock.advance(60_000);
  const ready = await stage(hub, order.id, 'READY');
  assert.deepEqual([ready.body.stage, ready.body.readyAt], ['READY', MONDAY_NOON + 60_000]);
  const back = await stage(hub, order.id, 'PREPARING');
  assert.deepEqual([back.body.stage, back.body.readyAt], ['PREPARING', null]);
  h.clock.advance(60_000);
  await stage(hub, order.id, 'READY');
  h.clock.advance(30_000);
  const issued = await stage(hub, order.id, 'ISSUED');
  assert.deepEqual(
    [issued.body.stage, issued.body.readyAt, issued.body.issuedAt],
    ['ISSUED', MONDAY_NOON + 120_000, MONDAY_NOON + 150_000],
  );
  const late = await stage(hub, order.id, 'READY');
  assertError(late, 409, 'STAGE_NOT_ALLOWED');
  assert.match(late.body.error?.message ?? '', /уже выдан/);

  const straight = await taken(hub, [{ product: 'Зелёный' }]);
  assert.equal((await stage(hub, straight.order.id, 'ISSUED')).body.stage, 'ISSUED');
  const moves = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'counter.stage' ORDER BY id");
  assert.equal(moves.length, 6);
  assert.deepEqual(JSON.parse(moves[0]!.data), { counterNumber: 1, from: 'NEW', to: 'PREPARING', service: 'HERE', status: 'OPEN' });
});

test('board and list: making (oldest first), ready, issued gone from the board; list keeps the last issued at the end', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const make = async (name?: string) => {
    h.clock.advance(1000);
    return (await taken(hub, [{ product: 'Печенье' }], null, name)).order;
  };
  const o1 = await make('Аня');
  const o2 = await make();
  const o3 = await make('Борис');
  const o4 = await make();
  const o5 = await make();
  await stage(hub, o2.id, 'PREPARING');
  await stage(hub, o3.id, 'PREPARING');
  await stage(hub, o3.id, 'READY');
  await stage(hub, o4.id, 'ISSUED');
  assert.equal((await cancel(hub, o5.id)).status, 200);

  const board = await get<CounterBoardView>(hub, '/api/counter/board');
  assert.equal(board.status, 200);
  assert.deepEqual(board.body.preparing, [
    { number: 1, guestName: 'Аня' },
    { number: 2, guestName: null },
  ]);
  assert.deepEqual(board.body.ready, [{ number: 3, guestName: 'Борис' }]);
  assert.equal(board.body.now, h.clock.now());
  assert.deepEqual([board.body.title, board.body.logoUrl, board.body.timezone], ['Кофейня «Демо»', null, 'Asia/Almaty']);

  const list = (await get<CounterOrdersView>(hub, '/api/counter/orders')).body.orders;
  assert.deepEqual(
    list.map((o) => [o.number, o.stage]),
    [
      [1, 'NEW'],
      [2, 'PREPARING'],
      [3, 'READY'],
      [4, 'ISSUED'],
    ],
  );
  assert.equal(list[0]!.id, o1.id);

  await stage(hub, o3.id, 'ISSUED');
  assert.deepEqual((await get<CounterBoardView>(hub, '/api/counter/board')).body.ready, []);
});

test('the board is public; the order list and taking orders need a key', async (t) => {
  const h = harness(t);
  const hub = await cafe(h, { secure: true });
  const board = await hub.app.inject({ method: 'GET', url: '/api/counter/board' });
  assert.equal(board.statusCode, 200);
  assert.deepEqual(Object.keys(board.json()).sort(), ['logoUrl', 'now', 'preparing', 'ready', 'timezone', 'title']);
  assert.equal((await hub.app.inject({ method: 'GET', url: '/api/counter/orders' })).statusCode, 401);
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/counter/orders',
    payload: { items: [], service: 'HERE', payment: null },
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(res.statusCode, 401);
});

// ─── Cancelling ─────────────────────────────────────────────────────────────

test('cancel an unpaid order: the check is voided, stock comes back, the order leaves the list', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const { order, check } = await taken(hub, [{ product: 'Сэндвич с курицей', qty: 2 }]);
  assert.equal((await product(hub, 'Сэндвич с курицей')).stock, 6);
  assertError(await cancel(hub, order.id, 'а'), 422, 'REASON_REQUIRED');

  const res = await cancel(hub, order.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'CANCELLED');
  assert.equal((await product(hub, 'Сэндвич с курицей')).stock, 8);
  const voided = await get<CheckView>(hub, `/api/checks/${check.id}`);
  assert.equal(voided.body.status, 'VOID');
  assert.equal(voided.body.items.length, 0);
  assert.equal((await get<CounterOrdersView>(hub, '/api/counter/orders')).body.orders.length, 0);
  assertError(await cancel(hub, order.id), 409, 'ORDER_NOT_OPEN');
  // A game order's cancel route does not take counter orders.
  assertError(await send(hub, `/api/orders/${order.id}/cancel`, { reason: 'Ошибка' }), 409, 'COUNTER_ORDER');
});

test('cancel a paid order is refused until the money is refunded in «Счета»', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  const { order, check } = await taken(hub, [{ product: 'Круассан' }], [{ method: 'CARD', amount: 900_00 }]);
  const refused = await cancel(hub, order.id);
  assertError(refused, 409, 'ORDER_PAID');
  assert.match(refused.body.error?.message ?? '', /сначала оформите возврат в «Счетах»/);
  assert.equal((await product(hub, 'Круассан')).stock, 11);

  const refund = await send(hub, `/api/checks/${check.id}/refund`, {
    method: 'CARD',
    amount: 900_00,
    reason: 'Остыл',
    approvedBy: 'Марат Управляющий',
  });
  assert.equal(refund.status, 200);
  const done = await cancel(hub, order.id);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'CANCELLED');
  assert.equal((await product(hub, 'Круассан')).stock, 12);
  // The paid check stays as history with its payment and refund.
  assert.equal((await get<CheckView>(hub, `/api/checks/${check.id}`)).body.status, 'PAID');
});

// ─── Idempotency, zero tables, settings ─────────────────────────────────────

test('a retry with the same Idempotency-Key returns the same order and takes nothing twice', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  const key = randomUUID();
  const first = await take(hub, [{ product: 'Круассан' }], [{ method: 'CASH', amount: 1000_00 }], {}, key);
  const second = await take(hub, [{ product: 'Круассан' }], [{ method: 'CASH', amount: 1000_00 }], {}, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(second.body.order.id, first.body.order.id);
  assert.equal(counts(hub).orders, 1);
  assert.equal(counts(hub).payments, 1);
  assert.equal((await product(hub, 'Круассан')).stock, 11);
});

test('a coffee shop with no tables: state, owner summary, power loss and closing the shift all work', async (t) => {
  const h = harness(t);
  const ups = new SimulatorUps();
  const hub = await cafe(h, { ups, powerOptions: { intervalMs: 0 } });
  const state = await get<HubState>(hub, '/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.tables, []);
  assert.deepEqual(state.body.tariffs, []);
  assert.equal(state.body.settings.business.type, 'cafe');
  assert.equal(state.body.club.name, 'Кофейня «Демо»');

  const shift = await openShift(hub);
  await taken(hub, [{ product: 'Американо', options: ['s'] }], [{ method: 'CASH', amount: 900_00 }]);
  const summary = await get<{ revenue: { today: number }; occupancyByHour: number[] }>(hub, '/api/reports/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.revenue.today, 900_00);
  assert.equal(summary.body.occupancyByHour.length, 24);

  assert.equal((await send(hub, '/api/power/settings', { autoPauseOnPowerLoss: true })).status, 200);
  await hub.hub.power.poll();
  ups.set({ onBattery: true });
  await hub.hub.power.poll();
  ups.set({ onBattery: false });
  await hub.hub.power.poll();
  assert.equal((await get<HubState>(hub, '/api/state')).status, 200);

  const closed = await send<{ report: ShiftReport }>(hub, `/api/shifts/${shift.id}/close`, { countedCash: 10_900_00 });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.report.revenue, { time: 0, bar: 900_00 });
});

test('an unpaid counter order keeps the shift open like any open check', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const shift = await openShift(hub);
  await taken(hub, [{ product: 'Печенье' }], null);
  assertError(await send(hub, `/api/shifts/${shift.id}/close`, { countedCash: 10_000_00 }), 409, 'UNPAID_CHECKS');
});

test('business type round-trips through the club settings', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const club = await get<ClubAdminView>(hub, '/api/club');
  assert.equal(club.body.settings.business.type, 'billiards');
  const res = await send<ClubAdminView>(hub, '/api/club', { settings: { business: { type: 'cafe' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.business.type, 'cafe');
  assert.equal((await get<HubState>(hub, '/api/state')).body.settings.business.type, 'cafe');
  assert.equal((await send(hub, '/api/club', { settings: { business: { type: 'bar' } } })).status, 400);
});

// ─── Product options on the billiard side ───────────────────────────────────

test('product options: stored, validated, and orders on a game accept them with a snapshot', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const cat = (await catalog(hub)).categories[0]!;
  const size: ProductOptionGroup = {
    id: 'size',
    name: ' Размер ',
    required: true,
    multiple: false,
    choices: [
      { id: 'small', name: '0,3', priceDelta: 0 },
      { id: 'big', name: '0,5', priceDelta: 200_00 },
    ],
  };
  const bad = await send(hub, '/api/bar/products', {
    categoryId: cat.id,
    name: 'Лимонад',
    price: 500_00,
    options: [{ ...size, choices: [] }],
  });
  assertError(bad, 422, 'OPTIONS_INVALID');
  const made = await send<ProductView>(hub, '/api/bar/products', { categoryId: cat.id, name: 'Лимонад', price: 500_00, options: [size] });
  assert.equal(made.status, 201);
  assert.equal(made.body.options[0]?.name, 'Размер');
  // Plain products report an empty list.
  assert.deepEqual((await catalog(hub)).products.find((p) => p.name === 'Чипсы')?.options, []);

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const url = `/api/sessions/${opened.body.id}/orders`;
  assertError(await send(hub, url, { items: [{ productId: made.body.id, qty: 1 }] }), 422, 'OPTION_REQUIRED');
  const ordered = await send<OrderView>(hub, url, {
    items: [
      { productId: made.body.id, qty: 1, options: ['big'] },
      { productId: made.body.id, qty: 2, options: ['small'] },
    ],
  });
  assert.equal(ordered.status, 201);
  assert.deepEqual(
    ordered.body.items.map((i) => [i.title, i.price, i.amount, i.optionNames]),
    [
      ['Лимонад · 0,5', 700_00, 700_00, ['0,5']],
      ['Лимонад · 0,3', 500_00, 1000_00, ['0,3']],
    ],
  );
  assert.equal(ordered.body.total, 1700_00);
});

// ─── Migration ──────────────────────────────────────────────────────────────

test('migration 014 keeps bar orders of an older database, with their checks and lines', async (t) => {
  const h = harness(t);
  const dir = join(h.dir, 'migrations');
  mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => Number.parseInt(f, 10) < 14)) {
    copyFileSync(new URL(f, MIGRATIONS_DIR), join(dir, f));
  }
  h.migrationsDir = pathToFileURL(dir + '/');
  const old = await h.start();
  const chips = (await catalog(old)).products.find((p) => p.name === 'Чипсы')!;
  const opened = await post(old, `/api/tables/${tableId(old, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(old, opened.body.id) === 'ACTIVE');
  // The order as the old build wrote it (no option columns yet), then billed on a check.
  old.db.exec(`INSERT INTO bar_orders (id, club_id, session_id, table_id, status, total, created_at, created_by, updated_at)
    SELECT 'o-old', club_id, id, table_id, 'OPEN', 1400, 1, 'Официант', 1 FROM table_sessions WHERE id = '${opened.body.id}'`);
  old.db.exec(`INSERT INTO bar_order_items (id, order_id, product_id, title, price, qty, amount, created_at)
    VALUES ('o-old-01', 'o-old', '${chips.id}', 'Чипсы', 700, 2, 1400, 1)`);
  await post(old, `/api/sessions/${opened.body.id}/stop`);
  const check = await send<CheckView>(old, '/api/checks', { sessionIds: [opened.body.id] });
  assert.equal(check.status, 201);
  await h.crash();

  h.migrationsDir = undefined;
  const hub = await h.start();
  const row = one<{ session_id: string; counter_number: number | null; stage: string | null }>(
    hub.db,
    "SELECT session_id, counter_number, stage FROM bar_orders WHERE id = 'o-old'",
  );
  assert.deepEqual({ ...row }, { session_id: opened.body.id, counter_number: null, stage: null });
  const orders = (await get<HubState>(hub, '/api/state')).body.orders;
  assert.deepEqual(
    orders.map((o) => [o.id, o.items[0]?.title, o.items[0]?.optionNames]),
    [['o-old', 'Чипсы', []]],
  );
  const billed = await get<CheckView>(hub, `/api/checks/${check.body.id}`);
  assert.deepEqual(
    billed.body.items.filter((i) => i.kind === 'ORDER').map((i) => [i.orderId, i.title, i.amount]),
    [['o-old', 'Чипсы', 1400]],
  );
  assert.equal(all(hub.db, 'PRAGMA foreign_key_check').length, 0);
});

test('a database from before 012 with bar orders upgrades all the way (012 rebuilds order lines too)', (t) => {
  const h = harness(t);
  const dir = join(h.dir, 'migrations-011');
  mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => Number.parseInt(f, 10) < 12)) {
    copyFileSync(new URL(f, MIGRATIONS_DIR), join(dir, f));
  }
  const path = join(h.dir, 'old-011.db');
  // The rows an 011 build had written: a game with a bar order and its line.
  const old = openDb(path, 1, { migrationsDir: pathToFileURL(dir + '/') });
  old.exec(`
    INSERT INTO companies (id, name, created_at) VALUES ('co', 'Компания', 1);
    INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES ('cl', 'co', 'Клуб', 'Asia/Almaty', 'KZT', 1);
    INSERT INTO tariffs (id, club_id, name, config, created_at, updated_at) VALUES ('tf', 'cl', 'Тариф', '{}', 1, 1);
    INSERT INTO billiard_tables (id, club_id, name, kind, lamp_channel, default_tariff_id) VALUES ('tb', 'cl', 'Стол 1', 'pool', 'sim:1', 'tf');
    INSERT INTO table_sessions (id, club_id, table_id, tariff_id, tariff_name, tariff_snapshot, timezone, status, requested_at, opened_by, updated_at)
      VALUES ('ss', 'cl', 'tb', 'tf', 'Тариф', '{}', 'Asia/Almaty', 'AWAITING_PAYMENT', 1, 'Админ', 1);
    INSERT INTO product_categories (id, club_id, name, created_at, updated_at) VALUES ('pc', 'cl', 'Бар', 1, 1);
    INSERT INTO products (id, club_id, category_id, name, price, created_at, updated_at) VALUES ('pr', 'cl', 'pc', 'Чипсы', 700, 1, 1);
    INSERT INTO bar_orders (id, club_id, session_id, table_id, status, total, created_at, created_by, updated_at)
      VALUES ('o-011', 'cl', 'ss', 'tb', 'OPEN', 700, 1, 'Официант', 1);
    INSERT INTO bar_order_items (id, order_id, product_id, title, price, qty, amount, created_at)
      VALUES ('o-011-01', 'o-011', 'pr', 'Чипсы', 700, 1, 700, 1);
  `);
  old.close();

  const db = openDb(path, 2);
  try {
    const rows = all<{ id: string; title: string; status: string }>(
      db,
      'SELECT o.id, i.title, o.status FROM bar_orders o JOIN bar_order_items i ON i.order_id = o.id',
    );
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: 'o-011', title: 'Чипсы', status: 'OPEN' }]);
    assert.equal(all(db, 'PRAGMA foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('HUB_DEMO_BUSINESS=cafe picks the coffee shop demo; anything else is refused', async () => {
  const { loadConfig } = await import('../src/config.ts');
  assert.equal(loadConfig({ HUB_DEMO_BUSINESS: 'cafe' }).demoBusiness, 'cafe');
  assert.equal(loadConfig({}).demoBusiness, 'billiards');
  assert.throws(() => loadConfig({ HUB_DEMO_BUSINESS: 'bar' }), /HUB_DEMO_BUSINESS/);
});

test('the demo coffee shop menu: coffee with options, tea, counted baked goods; a barista on staff', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const menu = await catalog(hub);
  assert.deepEqual(
    menu.categories.map((c) => c.name),
    ['Кофе', 'Чай', 'Еда'],
  );
  const byName = new Map(menu.products.map((p) => [p.name, p]));
  assert.equal(byName.get('Эспрессо')?.price, 800_00);
  assert.deepEqual(
    byName.get('Капучино')?.options.map((g) => [g.name, g.required, g.multiple, g.choices.map((c) => c.priceDelta)]),
    [
      ['Размер', true, false, [0, 200_00, 400_00]],
      ['Молоко', false, false, [0, 300_00, 300_00, 200_00]],
      ['Сироп', false, true, [200_00, 200_00, 200_00]],
      ['Доп. шот', false, false, [300_00]],
    ],
  );
  assert.deepEqual(byName.get('Матча-латте')?.options.map((g) => g.name), ['Размер', 'Молоко']);
  assert.equal(byName.get('Круассан')?.stock, 12);
  const staff = all<{ name: string; roles: string }>(hub.db, 'SELECT name, roles FROM staff ORDER BY name');
  assert.ok(staff.some((s) => s.roles === '["bartender"]'));
});
