import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  ArchiveView,
  CatalogView,
  CloseShiftResponse,
  CreateCounterOrderResponse,
  DayChecksView,
  HubState,
  LoginResponse,
  ProductView,
  Role,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { openDb } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { TestHub } from './helpers.ts';
import { Harness } from './helpers.ts';

/*
 * The coffee shop client's rights and «Архив»: only the manager and the administrator cancel
 * a counter order; the barista keeps the stop list but not the menu; revenue (X/Z, expected
 * cash) is for seniors and up; the archive and the X report list what was cancelled.
 * Production-like HUB: tokens only, every request with a Bearer token.
 */

type ErrorBody = { error?: { code: string; message: string } };

const HOUR = 60 * 60 * 1000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** A demo coffee shop behind keys, with one person for each role the tests need. */
async function cafe(h: Harness): Promise<{ hub: TestHub; tokens: Record<Role | 'combo', string> }> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
  const people: Array<[Role | 'combo', Role[]]> = [
    ['manager', ['manager']],
    ['admin', ['admin']],
    ['senior', ['senior']],
    ['cashier', ['cashier']],
    ['bartender', ['bartender']],
    ['waiter', ['waiter']],
    ['combo', ['cashier', 'bartender']],
  ];
  const tokens = {} as Record<Role | 'combo', string>;
  for (const [label, roles] of people) {
    const staff = hub.hub.staff.create({ name: `Тест ${label}`, roles, actor: 'system' });
    const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
    assert.equal(res.statusCode, 200, `login ${label}: ${res.body}`);
    tokens[label] = (res.json() as LoginResponse).token;
  }
  return { hub, tokens };
}

async function call<T = unknown>(hub: TestHub, token: string, method: 'GET' | 'POST', url: string, body?: object) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === 'POST') headers['idempotency-key'] = randomUUID();
  const res = await hub.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: body ?? {} } : {}) });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

async function product(hub: TestHub, token: string, name: string): Promise<ProductView> {
  const catalog = (await call<CatalogView>(hub, token, 'GET', '/api/bar/catalog')).body;
  const p = catalog.products.find((x) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p;
}

async function openShift(hub: TestHub, token: string): Promise<ShiftView> {
  const res = await call<ShiftView>(hub, token, 'POST', '/api/shifts/open', { openingFloat: 10_000_00 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function order(hub: TestHub, token: string, name: string, qty: number, pay: 'CASH' | 'CARD' | null) {
  const p = await product(hub, token, name);
  const res = await call<CreateCounterOrderResponse>(hub, token, 'POST', '/api/counter/orders', {
    items: [{ productId: p.id, qty }],
    service: 'HERE',
    payment: pay ? { parts: [{ method: pay, amount: p.price * qty }] } : null,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('only the manager and the administrator cancel a counter order; the barista and the cashier get 403', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await cafe(h);
  await openShift(hub, tokens.cashier);
  // The barista takes the order (counter.take) but cannot delete it.
  const { order: o } = await order(hub, tokens.bartender, 'Круассан', 1, null);
  for (const who of ['bartender', 'cashier', 'combo', 'waiter', 'senior'] as const) {
    const res = await call(hub, tokens[who], 'POST', `/api/counter/orders/${o.id}/cancel`, { reason: 'Гость ушёл' });
    assert.equal(res.status, 403, who);
    assert.equal(res.body.error?.code, 'FORBIDDEN', who);
  }
  const done = await call<{ status: string }>(hub, tokens.admin, 'POST', `/api/counter/orders/${o.id}/cancel`, { reason: 'Гость ушёл' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'CANCELLED');

  const { order: o2 } = await order(hub, tokens.bartender, 'Круассан', 1, null);
  const byManager = await call(hub, tokens.manager, 'POST', `/api/counter/orders/${o2.id}/cancel`, { reason: 'Ошибка кассира' });
  assert.equal(byManager.status, 200);
});

test('the barista does not change the menu (403) but keeps the stop list', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await cafe(h);
  const p = await product(hub, tokens.bartender, 'Круассан');

  const price = await call(hub, tokens.bartender, 'POST', `/api/bar/products/${p.id}/update`, { price: 1 });
  assert.equal(price.status, 403);
  assert.equal(price.body.error?.code, 'FORBIDDEN');
  // Hiding together with a price change is still a menu change.
  assert.equal((await call(hub, tokens.bartender, 'POST', `/api/bar/products/${p.id}/update`, { isActive: false, price: 1 })).status, 403);
  assert.equal((await call(hub, tokens.bartender, 'POST', '/api/bar/categories', { name: 'Новая' })).status, 403);
  assert.equal((await call(hub, tokens.bartender, 'POST', '/api/templates/apply', { kind: 'menu-cafe' })).status, 403);

  const off = await call<ProductView>(hub, tokens.bartender, 'POST', `/api/bar/products/${p.id}/update`, { isActive: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.isActive, false);
  assert.equal(off.body.price, p.price);
  const on = await call<ProductView>(hub, tokens.bartender, 'POST', `/api/bar/products/${p.id}/update`, { isActive: true });
  assert.equal(on.body.isActive, true);
  // The waiter has no stop list; the administrator edits the menu.
  assert.equal((await call(hub, tokens.waiter, 'POST', `/api/bar/products/${p.id}/update`, { isActive: false })).status, 403);
  assert.equal((await call(hub, tokens.admin, 'POST', `/api/bar/products/${p.id}/update`, { price: p.price + 100_00 })).status, 200);
});

test('revenue is for seniors and up: X report 403 for the cashier and the barista, blind count at close', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await cafe(h);
  const shift = await openShift(hub, tokens.cashier);
  // The cashier's own answer to the open does not show the drawer.
  assert.equal(shift.expectedCash, null);
  await order(hub, tokens.cashier, 'Круассан', 2, 'CASH');

  for (const who of ['cashier', 'bartender', 'combo', 'waiter'] as const) {
    const report = await call(hub, tokens[who], 'GET', `/api/shifts/${shift.id}/report`);
    assert.equal(report.status, 403, who);
    assert.equal((await call(hub, tokens[who], 'GET', '/api/insights')).status, 403, who);
    assert.equal((await call(hub, tokens[who], 'GET', '/api/reports/summary')).status, 403, who);
    const state = await call<HubState>(hub, tokens[who], 'GET', '/api/state');
    assert.equal(state.status, 200, who);
    assert.equal(state.body.shift?.expectedCash, null, who);
  }
  for (const who of ['senior', 'admin', 'manager'] as const) {
    const report = await call<ShiftReport>(hub, tokens[who], 'GET', `/api/shifts/${shift.id}/report`);
    assert.equal(report.status, 200, who);
    assert.equal(report.body.net.total, 1800_00, who);
    assert.equal((await call<HubState>(hub, tokens[who], 'GET', '/api/state')).body.shift?.expectedCash, 11_800_00, who);
  }
  // The barista sees the checks one by one (no totals) — checks.view.
  const checks = await call<DayChecksView>(hub, tokens.bartender, 'GET', '/api/checks/day');
  assert.equal(checks.status, 200);
  assert.equal(checks.body.checks.length, 1);
  assert.equal((await call(hub, tokens.bartender, 'GET', `/api/shifts/${shift.id}/checks`)).status, 200);
  assert.equal((await call(hub, tokens.waiter, 'GET', '/api/checks/day')).status, 403);

  // The cashier closes counting blind: no expected cash, no difference, no Z report.
  const closed = await call<CloseShiftResponse>(hub, tokens.cashier, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: 11_700_00 });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.report, null);
  assert.equal(closed.body.shift.expectedCash, null);
  assert.equal(closed.body.shift.difference, null);
  assert.equal(closed.body.shift.countedCash, 11_700_00);
  // The manager sees the Z report with the shortage.
  const z = await call<ShiftReport>(hub, tokens.manager, 'GET', `/api/shifts/${shift.id}/report`);
  assert.equal(z.body.kind, 'Z');
  assert.equal(z.body.expectedCash, 11_800_00);
  assert.equal(z.body.difference, -100_00);
});

test('«Архив»: cancelled orders and refunds of the day with number, time, sum, who and why; the X report lists them', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await cafe(h);
  const shift = await openShift(hub, tokens.cashier);

  // 1. Unpaid order, cancelled by the administrator: the check is VOID, the order stays CANCELLED.
  const unpaid = await order(hub, tokens.bartender, 'Круассан', 2, null);
  h.clock.advance(5 * 60_000);
  const cancelAt = h.clock.now();
  assert.equal(
    (await call(hub, tokens.admin, 'POST', `/api/counter/orders/${unpaid.order.id}/cancel`, { reason: 'Гость передумал' })).status,
    200,
  );
  // 2. Paid by card, refunded with approval, then cancelled by the manager.
  const paid = await order(hub, tokens.cashier, 'Чизкейк', 1, 'CARD');
  h.clock.advance(60_000);
  const refund = await call(hub, tokens.manager, 'POST', `/api/checks/${paid.check.id}/refund`, {
    method: 'CARD',
    amount: paid.order.total,
    reason: 'Остыл',
    approvedBy: 'Тест manager',
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  h.clock.advance(60_000);
  assert.equal(
    (await call(hub, tokens.manager, 'POST', `/api/counter/orders/${paid.order.id}/cancel`, { reason: 'Вернули деньги' })).status,
    200,
  );
  // 3. A paid order that stays: not in the archive.
  await order(hub, tokens.cashier, 'Круассан', 1, 'CASH');

  const archive = await call<ArchiveView>(hub, tokens.bartender, 'GET', '/api/archive');
  assert.equal(archive.status, 200, JSON.stringify(archive.body));
  const a = archive.body;
  assert.equal(a.date, '2026-10-12');
  assert.deepEqual(
    a.entries.map((e) => e.kind),
    ['ORDER', 'REFUND', 'ORDER'],
  );
  const first = a.entries.find((e) => e.id === unpaid.order.id)!;
  assert.equal(first.title, `Заказ №${unpaid.order.number}`);
  assert.equal(first.number, unpaid.order.number);
  assert.equal(first.checkNumber, unpaid.check.number);
  assert.equal(first.amount, unpaid.order.total);
  assert.equal(first.at, cancelAt);
  assert.equal(first.by, 'Тест admin');
  assert.equal(first.reason, 'Гость передумал');
  assert.equal(first.createdBy, 'Тест bartender');
  assert.match(first.detail ?? '', /Круассан ×2/);
  const back = a.entries.find((e) => e.kind === 'REFUND')!;
  assert.equal(back.amount, paid.order.total);
  assert.equal(back.checkNumber, paid.check.number);
  assert.equal(back.reason, 'Остыл');
  assert.equal(back.approvedBy, 'Тест manager');
  assert.match(back.detail ?? '', /картой/);
  // The VOID check of order 1 is explained by its cancelled order: no extra row.
  assert.ok(!a.entries.some((e) => e.kind === 'VOID'));
  assert.deepEqual(
    { count: a.cancelled.count, total: a.cancelled.total },
    { count: 2, total: unpaid.order.total + paid.order.total },
  );
  assert.deepEqual(a.refunds, { count: 1, total: paid.order.total });

  // Nothing is erased: the orders and the voided check are still in the database.
  assert.equal(hub.hub.counter.get(unpaid.order.id).status, 'CANCELLED');
  const voided = await call<{ status: string }>(hub, tokens.manager, 'GET', `/api/checks/${unpaid.check.id}`);
  assert.equal(voided.body.status, 'VOID');

  // The X report: «Отменённые» with count, sum and the list.
  const x = await call<ShiftReport>(hub, tokens.senior, 'GET', `/api/shifts/${shift.id}/report`);
  assert.equal(x.status, 200);
  assert.equal(x.body.cancelled.count, 2);
  assert.equal(x.body.cancelled.total, unpaid.order.total + paid.order.total);
  assert.deepEqual(
    x.body.cancelled.items.map((e) => [e.number, e.by, e.reason]),
    [
      [paid.order.number, 'Тест manager', 'Вернули деньги'],
      [unpaid.order.number, 'Тест admin', 'Гость передумал'],
    ],
  );

  // …and the Z report keeps it.
  const closed = await call<CloseShiftResponse>(hub, tokens.manager, 'POST', `/api/shifts/${shift.id}/close`, {
    countedCash: 10_000_00 + 900_00,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.report?.cancelled.count, 2);

  // Day checks: every check of the day, with the orders on it and their status.
  const day = await call<DayChecksView>(hub, tokens.bartender, 'GET', '/api/checks/day');
  assert.equal(day.body.checks.length, 3);
  const paidRow = day.body.checks.find((c) => c.check.id === paid.check.id)!;
  assert.deepEqual(
    paidRow.orders.map((o) => [o.number, o.status]),
    [[paid.order.number, 'CANCELLED']],
  );
  assert.equal(day.body.checks.find((c) => c.check.id === unpaid.check.id)!.check.status, 'VOID');
});

test('«Архив» of another day, a bad date and the rights', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await cafe(h);
  await openShift(hub, tokens.cashier);
  const { order: o } = await order(hub, tokens.cashier, 'Круассан', 1, null);
  assert.equal((await call(hub, tokens.admin, 'POST', `/api/counter/orders/${o.id}/cancel`, { reason: 'Ошибка' })).status, 200);

  assert.equal((await call<ArchiveView>(hub, tokens.cashier, 'GET', '/api/archive?date=2026-10-12')).body.entries.length, 1);
  assert.equal((await call<ArchiveView>(hub, tokens.cashier, 'GET', '/api/archive?date=2026-10-11')).body.entries.length, 0);
  // The next working day starts at 06:00: before that it is still the 12th.
  h.clock.advance(17 * HOUR); // 05:00 on the 13th, Almaty
  assert.equal((await call<ArchiveView>(hub, tokens.cashier, 'GET', '/api/archive')).body.date, '2026-10-12');
  h.clock.advance(2 * HOUR);
  const next = await call<ArchiveView>(hub, tokens.cashier, 'GET', '/api/archive');
  assert.equal(next.body.date, '2026-10-13');
  assert.equal(next.body.entries.length, 0);

  // A check left open yesterday stays in today's checks until it is paid or cancelled.
  const { check: owed } = await order(hub, tokens.cashier, 'Печенье', 1, null);
  h.clock.advance(24 * HOUR);
  const today = await call<DayChecksView>(hub, tokens.bartender, 'GET', '/api/checks/day');
  assert.deepEqual(
    today.body.checks.map((c) => c.check.id),
    [owed.id],
  );
  const yesterday = await call<DayChecksView>(hub, tokens.bartender, 'GET', '/api/checks/day?date=2026-10-13');
  assert.ok(yesterday.body.checks.some((c) => c.check.id === owed.id));
  assert.equal((await call<DayChecksView>(hub, tokens.bartender, 'GET', '/api/checks/day?date=2026-10-12')).body.checks.length, 1);

  const bad = await call(hub, tokens.cashier, 'GET', '/api/archive?date=12.10.2026');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error?.code, 'BAD_DATE');
  assert.equal((await call(hub, tokens.waiter, 'GET', '/api/archive')).status, 403);
  assert.equal((await call(hub, tokens.bartender, 'GET', '/api/archive')).status, 200);
});
