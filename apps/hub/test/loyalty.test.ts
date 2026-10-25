import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CheckLoyaltyView,
  CheckView,
  CreateCounterOrderResponse,
  LoyaltyApplyRequest,
  LoyaltyGuestDetail,
  LoyaltyGuestsView,
  LoyaltyLookupView,
  LoyaltySettings,
  PaymentMethod,
  ProductView,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import { all, one, openDb } from '../src/db.ts';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { TestHub } from './helpers.ts';
import { Harness, post, sessionStatus, tableId, waitFor } from './helpers.ts';

/**
 * «Лояльность без приложения»: a guest by phone on the counter and on billiards checks; the
 * reward is a check discount, earnings come when the check is paid and go back on a refund.
 * Everything runs on the HUB alone (no cloud configured in these tests).
 */

type ErrorBody = { error?: { code: string; message: string } };
type Part = { method: PaymentMethod; amount: number };
type Line = { product: string; qty?: number; options?: string[] };

const PHONE = '8 701 123 45 67';
const MASKED = '+7 ••• ••• 45 67';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function cafe(h: Harness): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }));
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

async function setLoyalty(hub: TestHub, patch: Partial<LoyaltySettings>): Promise<LoyaltySettings> {
  const res = await send<LoyaltySettings>(hub, '/api/loyalty/settings', patch);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function openShift(hub: TestHub): Promise<ShiftView> {
  const res = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat: 10_000_00 });
  assert.equal(res.status, 201);
  return res.body;
}

async function productId(hub: TestHub, name: string): Promise<string> {
  const p = (await get<CatalogView>(hub, '/api/bar/catalog')).body.products.find((x: ProductView) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p.id;
}

async function take(hub: TestHub, lines: Line[], payment: Part[] | null, loyalty?: LoyaltyApplyRequest, key?: string) {
  const items = await Promise.all(
    lines.map(async (l) => ({ productId: await productId(hub, l.product), qty: l.qty ?? 1, ...(l.options ? { options: l.options } : {}) })),
  );
  return send<CreateCounterOrderResponse>(
    hub,
    '/api/counter/orders',
    { items, service: 'HERE', payment: payment && { parts: payment }, ...(loyalty ? { loyalty } : {}) },
    key,
  );
}

const lookup = async (hub: TestHub, phone = PHONE) =>
  (await get<LoyaltyLookupView>(hub, `/api/loyalty/lookup?phone=${encodeURIComponent(phone)}`)).body;

const moves = (hub: TestHub) =>
  all<{ kind: string; bonus: number; stamps: number }>(hub.db, 'SELECT kind, bonus, stamps FROM loyalty_moves ORDER BY at, rowid').map((m) => ({
    kind: m.kind,
    bonus: m.bonus,
    stamps: m.stamps,
  }));

/** Американо S = 900 ₸, Капучино S = 1200 ₸ (demo menu). */
const AMERICANO: Line = { product: 'Американо', options: ['s'] };
const CAPPUCCINO: Line = { product: 'Капучино', options: ['s'] };

// ─── Cashback ───────────────────────────────────────────────────────────────

test('off by default: the counter refuses a guest until the manager switches loyalty on', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  assert.equal((await get<LoyaltySettings>(hub, '/api/loyalty/settings')).body.enabled, false);
  const res = await take(hub, [AMERICANO], [{ method: 'CARD', amount: 900_00 }], { phone: PHONE });
  assertError(res, 409, 'LOYALTY_OFF');
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM bar_orders')?.n, 0, 'nothing is left behind');
});

test('cashback: a new number becomes a guest on the first paid order and earns N % of what was paid', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, program: 'cashback', cashbackPercent: 5 });

  const before = await lookup(hub);
  assert.equal(before.known, false);
  assert.equal(before.guest.phone, MASKED);
  assertError(await get(hub, '/api/loyalty/lookup?phone=123'), 422, 'PHONE_INVALID');

  const res = await take(hub, [CAPPUCCINO, AMERICANO], [{ method: 'CASH', amount: 2100_00 }], { phone: PHONE, name: 'Аня' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.check.status, 'PAID');
  assert.equal(res.body.loyalty?.accrued?.bonus, 105_00, '5 % of 2100 ₸');
  assert.equal(res.body.loyalty?.guest?.phone, MASKED);

  const after = await lookup(hub, '+7 (701) 123-45-67');
  assert.equal(after.known, true);
  assert.equal(after.guest.name, 'Аня');
  assert.equal(after.guest.bonus, 105_00);
  assert.equal(after.guest.visits, 1);
  assert.ok(after.guest.expiring && after.guest.expiring.at > h.clock.now(), 'bonuses expire in 180 days by default');
  assert.deepEqual(moves(hub), [{ kind: 'ACCRUE', bonus: 105_00, stamps: 0 }]);
  // Journal and outbox carry it; the number is masked there.
  const accrued = one<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'loyalty.accrued'");
  assert.ok(accrued && accrued.data.includes(MASKED) && !accrued.data.includes('7011234567'));
  assert.ok((one<{ n: number }>(hub.db, "SELECT COUNT(*) AS n FROM outbox WHERE topic = 'loyalty.accrued'")?.n ?? 0) === 1);
});

test('no accrual for an unpaid order or a cancelled one; the guest is not even created', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true });
  const res = await take(hub, [CAPPUCCINO], null, { phone: PHONE });
  assert.equal(res.status, 201);
  assert.equal(res.body.check.status, 'OPEN');
  assert.equal(res.body.loyalty?.status, 'OPEN');
  assert.equal(res.body.loyalty?.accrued, null);
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM loyalty_guests')?.n, 0);

  const cancelled = await send(hub, `/api/counter/orders/${res.body.order.id}/cancel`, { reason: 'Гость ушёл' });
  assert.equal(cancelled.status, 200);
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM loyalty_guests')?.n, 0);
  assert.deepEqual(moves(hub), []);

  // Paid later in «Счета»: then it earns.
  const later = await take(hub, [AMERICANO], null, { phone: PHONE });
  const paid = await send<{ check: CheckView }>(hub, `/api/checks/${later.body.check.id}/pay`, { parts: [{ method: 'CARD', amount: 900_00 }] });
  assert.equal(paid.status, 200);
  assert.deepEqual(moves(hub), [{ kind: 'ACCRUE', bonus: 45_00, stamps: 0 }]);
});

test('redemption: bonuses pay at most the share of the check, as a discount; X/Z and cash stay real money', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const shift = await openShift(hub);
  await setLoyalty(hub, { enabled: true, cashbackPercent: 10, maxRedeemPercent: 50 });
  // 10 × 1200 ₸ → 1200 ₸ of bonuses.
  assert.equal((await take(hub, [{ ...CAPPUCCINO, qty: 10 }], [{ method: 'CARD', amount: 12_000_00 }], { phone: PHONE })).status, 201);
  assert.equal((await lookup(hub)).guest.bonus, 1200_00);

  // An americano (900 ₸): at most 450 ₸ by bonuses.
  const over = await take(hub, [AMERICANO], [{ method: 'CASH', amount: 400_00 }], { phone: PHONE, redeem: 500_00 });
  assertError(over, 422, 'LOYALTY_REDEEM_LIMIT');
  const changed = await take(hub, [AMERICANO], [{ method: 'CASH', amount: 450_00 }], { phone: PHONE, redeem: 450_00, expectDiscount: 400_00 });
  assertError(changed, 409, 'LOYALTY_CHANGED');

  const res = await take(hub, [AMERICANO], [{ method: 'CASH', amount: 450_00 }], { phone: PHONE, redeem: 450_00, expectDiscount: 450_00 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const check = res.body.check;
  assert.deepEqual([check.subtotal, check.discountAmount, check.total, check.paid, check.status], [900_00, 450_00, 450_00, 450_00, 'PAID']);
  assert.equal(check.discount?.kind, 'AMOUNT');
  assert.match(check.discount?.reason ?? '', /^Лояльность/);
  assert.deepEqual(res.body.loyalty?.applied, { kind: 'BONUS', discount: 450_00, redeemBonus: 450_00, freeUnits: 0 });
  // Cashback is earned on the money part only: 10 % of 450.
  assert.equal(res.body.loyalty?.accrued?.bonus, 45_00);
  assert.equal((await lookup(hub)).guest.bonus, 1200_00 - 450_00 + 45_00);

  const x = (await get<ShiftReport>(hub, `/api/shifts/${shift.id}/report`)).body;
  assert.equal(x.sales.CASH, 450_00, 'the drawer got 450 ₸, not 900');
  assert.equal(x.discounts, 450_00);
  assert.deepEqual(x.revenue, { time: 0, bar: 12_000_00 + 450_00 });
  assert.equal(x.expectedCash, 10_000_00 + 450_00);
});

test('a bonus-only check (100 %) is closed with no payment parts', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, cashbackPercent: 50, maxRedeemPercent: 100 });
  await take(hub, [{ ...CAPPUCCINO, qty: 2 }], [{ method: 'CARD', amount: 2400_00 }], { phone: PHONE });
  const res = await take(hub, [AMERICANO], [], { phone: PHONE, redeem: 900_00 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual([res.body.check.total, res.body.check.status], [0, 'PAID']);
  assert.equal(res.body.loyalty?.accrued?.bonus, 0);
});

test('refund: cashback shrinks with a partial refund; a full refund takes it back and returns the spent bonuses', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, cashbackPercent: 10 });
  await take(hub, [{ ...CAPPUCCINO, qty: 5 }], [{ method: 'CARD', amount: 6000_00 }], { phone: PHONE }); // +600
  const res = await take(hub, [{ ...CAPPUCCINO, qty: 2 }], [{ method: 'CARD', amount: 1800_00 }], { phone: PHONE, redeem: 600_00 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.loyalty?.accrued?.bonus, 180_00);
  assert.equal((await lookup(hub)).guest.bonus, 180_00);

  const refund = (amount: number) =>
    send<CheckView>(hub, `/api/checks/${res.body.check.id}/refund`, { method: 'CARD', amount, reason: 'Остыл', approvedBy: 'Марат Управляющий' });
  assert.equal((await refund(900_00)).status, 200);
  assert.equal((await lookup(hub)).guest.bonus, 90_00, 'cashback of the 900 ₸ still paid');
  assert.equal((await refund(900_00)).status, 200);
  const g = (await lookup(hub)).guest;
  assert.equal(g.bonus, 600_00, 'all earned taken back, the 600 ₸ spent given back');
  assert.equal(g.visits, 1);
  assert.deepEqual(
    moves(hub).map((m) => [m.kind, m.bonus]),
    [
      ['ACCRUE', 600_00],
      ['REDEEM', -600_00],
      ['ACCRUE', 180_00],
      ['REVERSE', -90_00],
      ['REVERSE', -90_00],
      ['RETURN', 600_00],
    ],
  );
  assert.ok(all<{ action: string }>(hub.db, "SELECT action FROM audit_log WHERE action = 'loyalty.reversed'").length === 2);
});

test('an open check holds its bonuses: a second check cannot spend them again', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, cashbackPercent: 10, maxRedeemPercent: 100 });
  await take(hub, [{ ...CAPPUCCINO, qty: 5 }], [{ method: 'CARD', amount: 6000_00 }], { phone: PHONE }); // +600
  assert.equal((await take(hub, [AMERICANO], null, { phone: PHONE, redeem: 600_00 })).status, 201);
  assert.equal((await lookup(hub)).guest.bonus, 0);
  assertError(await take(hub, [AMERICANO], null, { phone: PHONE, redeem: 100_00 }), 422, 'LOYALTY_REDEEM_LIMIT');
});

test('idempotent retry: the same key replays the order and earns once', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true });
  const key = randomUUID();
  const a = await take(hub, [CAPPUCCINO], [{ method: 'CARD', amount: 1200_00 }], { phone: PHONE }, key);
  const b = await take(hub, [CAPPUCCINO], [{ method: 'CARD', amount: 1200_00 }], { phone: PHONE }, key);
  assert.equal(a.status, 201);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(b.body.order.id, a.body.order.id);
  assert.deepEqual(moves(hub), [{ kind: 'ACCRUE', bonus: 60_00, stamps: 0 }]);
});

// ─── Stamps ─────────────────────────────────────────────────────────────────

test('stamps: every N-th coffee is free — one tap makes the cheapest coffee a «Лояльность» discount', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, program: 'stamps', stampsEvery: 3 });

  // Two coffees and a croissant: two stamps (food does not count).
  const first = await take(hub, [CAPPUCCINO, AMERICANO, { product: 'Круассан' }], [{ method: 'CARD', amount: 3000_00 }], { phone: PHONE });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.loyalty?.accrued?.stamps, 2);
  assert.equal((await lookup(hub)).guest.stamps, 2);

  // Asking for a gift that is not due.
  const tea = await take(hub, [{ product: 'Чёрный' }], null, { phone: PHONE, free: true });
  assertError(tea, 409, 'LOYALTY_NO_GIFT');

  // The 3rd coffee is free: a capuccino and an americano → the cheaper (900) is the gift.
  const res = await take(hub, [CAPPUCCINO, AMERICANO], [{ method: 'CASH', amount: 1200_00 }], { phone: PHONE, free: true, expectDiscount: 900_00 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const check = res.body.check;
  assert.deepEqual([check.subtotal, check.discountAmount, check.total], [2100_00, 900_00, 1200_00]);
  assert.equal(check.discount?.reason, 'Лояльность: напиток в подарок');
  assert.deepEqual(res.body.loyalty?.applied, { kind: 'FREE', discount: 900_00, redeemBonus: 0, freeUnits: 1 });
  // 2 stamps used for the gift, the paid capuccino earns one.
  assert.equal(res.body.loyalty?.accrued?.stamps, 1);
  assert.equal((await lookup(hub)).guest.stamps, 1);
  assert.deepEqual(
    moves(hub).map((m) => [m.kind, m.stamps]),
    [
      ['ACCRUE', 2],
      ['REDEEM', -2],
      ['ACCRUE', 1],
    ],
  );
  const discountSet = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'check.discount_set'");
  assert.ok(discountSet.some((r) => r.data.includes('Лояльность')), 'journaled with the reason «Лояльность»');
});

test('stamps: a manual discount is not mixed with the gift; removing the discount drops the gift', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, program: 'stamps', stampsEvery: 2 });
  await take(hub, [CAPPUCCINO], [{ method: 'CARD', amount: 1200_00 }], { phone: PHONE });
  const open = await take(hub, [AMERICANO], null, { phone: PHONE, free: true });
  assert.equal(open.status, 201);
  assert.equal(open.body.check.total, 0);
  const manual = await send(hub, `/api/checks/${open.body.check.id}/discount`, { discount: { kind: 'PERCENT', value: 10, reason: 'друг' } });
  assertError(manual, 409, 'LOYALTY_DISCOUNT');
  const removed = await send<CheckView>(hub, `/api/checks/${open.body.check.id}/discount`, { discount: null });
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.body.discountAmount, removed.body.total], [0, 900_00]);
  assert.equal((await get<CheckLoyaltyView>(hub, `/api/checks/${open.body.check.id}/loyalty`)).body.offer.freeUnits, 1);
});

test('cancelling an unpaid order with a gift leaves a clean void check and the stamps untouched', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, program: 'stamps', stampsEvery: 2 });
  await take(hub, [CAPPUCCINO], [{ method: 'CARD', amount: 1200_00 }], { phone: PHONE });
  const open = await take(hub, [AMERICANO], null, { phone: PHONE, free: true });
  assert.equal((await lookup(hub)).guest.stamps, 0, 'held by the open check');
  assert.equal((await send(hub, `/api/counter/orders/${open.body.order.id}/cancel`, { reason: 'Передумал' })).status, 200);
  const voided = await get<CheckView>(hub, `/api/checks/${open.body.check.id}`);
  assert.deepEqual([voided.status, voided.body.status, voided.body.discountAmount], [200, 'VOID', 0]);
  assert.equal((await lookup(hub)).guest.stamps, 1, 'the stamp is free again');
});

// ─── Billiards checks (cash desk) ───────────────────────────────────────────

test('billiards: the cash desk attaches a guest to a check, spends bonuses, earns on payment', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, cashbackPercent: 10, maxRedeemPercent: 50 });

  const play = async () => {
    const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
    assert.equal(opened.status, 201);
    await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
    h.clock.advance(60 * 60 * 1000);
    await post(hub, `/api/sessions/${opened.body.id}/stop`);
    const check = await send<CheckView>(hub, '/api/checks', { sessionIds: [opened.body.id] });
    assert.equal(check.status, 201);
    return check.body;
  };

  const c1 = await play();
  const attached = await send<{ loyalty: CheckLoyaltyView; check: CheckView }>(hub, `/api/checks/${c1.id}/loyalty`, { phone: '7011234567', name: 'Ержан' });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.equal(attached.body.loyalty.known, false);
  assert.equal(attached.body.check.total, c1.total);
  assert.equal((await send(hub, `/api/checks/${c1.id}/pay`, { parts: [{ method: 'CARD', amount: c1.due }] })).status, 200);
  const earned = Math.floor((c1.total * 10) / 100 / 100) * 100;
  assert.equal((await lookup(hub)).guest.bonus, earned);
  assert.equal((await get<CheckLoyaltyView>(hub, `/api/checks/${c1.id}/loyalty`)).body.accrued?.bonus, earned);

  const c2 = await play();
  const view = (await send<{ loyalty: CheckLoyaltyView }>(hub, `/api/checks/${c2.id}/loyalty`, { phone: PHONE })).body.loyalty;
  assert.equal(view.offer.redeemMax, Math.min(earned, Math.floor(c2.subtotal / 2 / 100) * 100));
  const spent = await send<{ check: CheckView }>(hub, `/api/checks/${c2.id}/loyalty`, { phone: PHONE, redeem: view.offer.redeemMax });
  assert.equal(spent.status, 200, JSON.stringify(spent.body));
  assert.equal(spent.body.check.due, c2.subtotal - view.offer.redeemMax);
  // Taking the guest off returns the check to its full price.
  const removed = await send<{ check: CheckView }>(hub, `/api/checks/${c2.id}/loyalty/remove`);
  assert.equal(removed.body.check.due, c2.subtotal);
  assert.equal((await lookup(hub)).guest.bonus, earned, 'nothing was spent');
  // Once money is on the check the guest can no longer change.
  await send(hub, `/api/checks/${c2.id}/pay`, { parts: [{ method: 'CARD', amount: 100_00 }] });
  assertError(await send(hub, `/api/checks/${c2.id}/loyalty`, { phone: PHONE }), 409, 'CHECK_HAS_PAYMENTS');
});

// ─── Manager: guests and adjustments ────────────────────────────────────────

test('manager: guests by last digits with full numbers, manual adjust with a reason, never below zero', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  await openShift(hub);
  await setLoyalty(hub, { enabled: true, cashbackPercent: 10 });
  await take(hub, [{ ...CAPPUCCINO, qty: 5 }], [{ method: 'CARD', amount: 6000_00 }], { phone: PHONE, name: 'Аня' });
  await take(hub, [CAPPUCCINO], [{ method: 'CARD', amount: 1200_00 }], { phone: '7771112233' });

  const all2 = (await get<LoyaltyGuestsView>(hub, '/api/loyalty/guests')).body;
  assert.equal(all2.total, 2);
  const found = (await get<LoyaltyGuestsView>(hub, '/api/loyalty/guests?q=4567')).body;
  assert.equal(found.guests.length, 1);
  const anya = found.guests[0]!;
  assert.deepEqual([anya.phoneFull, anya.phone, anya.name, anya.bonus, anya.visits], ['+7 701 123 45 67', MASKED, 'Аня', 600_00, 1]);
  assert.equal((await get<LoyaltyGuestsView>(hub, '/api/loyalty/guests?q=Аня')).body.guests.length, 1);

  assertError(await send(hub, `/api/loyalty/guests/${anya.id}/adjust`, { bonus: 100_00 }), 422, 'REASON_REQUIRED');
  assertError(await send(hub, `/api/loyalty/guests/${anya.id}/adjust`, { bonus: -700_00, reason: 'ошибка' }), 422, 'ADJUST_BELOW_ZERO');
  const adj = await send<LoyaltyGuestDetail>(hub, `/api/loyalty/guests/${anya.id}/adjust`, { bonus: 250_00, reason: 'День рождения' });
  assert.equal(adj.status, 200);
  assert.equal(adj.body.guest.bonus, 850_00);
  assert.equal(adj.body.moves[0]?.kind, 'ADJUST');
  assert.equal(adj.body.moves[0]?.reason, 'День рождения');
  assert.ok(all<{ action: string }>(hub.db, "SELECT action FROM audit_log WHERE action = 'loyalty.adjusted'").length === 1);
});

test('rights: a cashier looks guests up and applies rewards; only the manager sees the list and changes settings', async (t) => {
  const h = harness(t);
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
  const tokenOf = async (name: string) => {
    const staff = hub.hub.staff.list().find((x) => x.name === name);
    assert.ok(staff, name);
    const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
    return (res.json() as { token: string }).token;
  };
  const call = async (token: string, method: 'GET' | 'POST', url: string, body?: object) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (method === 'POST') headers['idempotency-key'] = randomUUID();
    return (await hub.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: body ?? {} } : {}) })).statusCode;
  };
  const cashier = await tokenOf('Айгерим Кассир');
  const manager = await tokenOf('Марат Управляющий');
  assert.equal(await call(cashier, 'POST', '/api/loyalty/settings', { enabled: true }), 403);
  assert.equal(await call(manager, 'POST', '/api/loyalty/settings', { enabled: true }), 200);
  assert.equal(await call(cashier, 'GET', `/api/loyalty/lookup?phone=${encodeURIComponent(PHONE)}`), 200);
  assert.equal(await call(cashier, 'GET', '/api/loyalty/guests'), 403);
  assert.equal(await call(manager, 'GET', '/api/loyalty/guests'), 200);
});
