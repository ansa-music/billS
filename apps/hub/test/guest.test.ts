import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CreateCounterOrderResponse,
  GuestLinksResponse,
  GuestPageView,
  GuestRequestsResponse,
  GuestRequestView,
  OrderView,
  ShiftView,
  StaffGuestRequestView,
} from '@bills/domain';
import { GUEST_RATE } from '@bills/domain';
import { all, one, openDb } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { TestHub } from './helpers.ts';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { GuestService } from '../src/guest.ts';
import { auditActions, Harness, post, tableId, waitFor } from './helpers.ts';

/**
 * «Страница гостя по QR»: a per-table token opens the guest page (public), guests read
 * only their table and create requests; staff accept (a real order is made by the usual
 * service) or reject; a coffee-shop order ahead is taken on the counter with its payment.
 */

type ErrorBody = { error?: { code: string; message: string; retryAfterMs?: number } };
const MIN = 60_000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function cafe(h: Harness, secure = false): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure });
}

async function get<T>(hub: TestHub, url: string, headers: Record<string, string> = {}) {
  const res = await hub.app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

async function send<T>(hub: TestHub, url: string, body: object = {}, actor = 'Марат Управляющий') {
  const res = await post(hub, url, body, randomUUID(), actor);
  return { status: res.status, body: res.body as unknown as T & ErrorBody };
}

/** A guest's phone: no token, no idempotency key, its own address. */
async function guestPost(hub: TestHub, token: string, body: object, ip = '10.0.0.7') {
  const res = await hub.app.inject({ method: 'POST', url: `/api/guest/${token}/requests`, payload: body, remoteAddress: ip });
  return { status: res.statusCode, body: res.json() as GuestRequestView & ErrorBody };
}

async function enable(hub: TestHub): Promise<GuestLinksResponse> {
  const res = await send<GuestLinksResponse>(hub, '/api/guest-links/settings', { enabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.enabled, true);
  return res.body;
}

function tokenOf(links: GuestLinksResponse, tableName: string | null): string {
  const link = links.links.find((l) => l.tableName === tableName);
  if (!link) throw new Error(`No link for ${tableName}`);
  return link.token;
}

async function productId(hub: TestHub, name: string): Promise<string> {
  const c = (await get<CatalogView>(hub, '/api/bar/catalog')).body;
  const p = c.products.find((x) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p.id;
}

async function startGame(hub: TestHub, table: string): Promise<string> {
  const res = await post(hub, `/api/tables/${tableId(hub, table)}/open`);
  assert.equal(res.status, 201);
  await waitFor(() => hub.hub.state().tables.find((t) => t.name === table)?.session?.status === 'ACTIVE');
  return res.body.id;
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string) {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code });
}

// ─── Tokens, the switch, privacy ────────────────────────────────────────────

test('off by default; a manager switches it on and gets one QR per table', async (t) => {
  const hub = await harness(t).start();
  const before = (await get<GuestLinksResponse>(hub, '/api/guest-links')).body;
  assert.equal(before.enabled, false);
  assert.equal(before.business, 'billiards');
  assert.equal(before.links.length, hub.hub.state().tables.length);
  const token = tokenOf(before, 'Стол 1');
  assert.match(token, /^[A-Za-z0-9_-]{24}$/);
  assertError(await get(hub, `/api/guest/${token}`), 404, 'GUEST_OFF');

  const links = await enable(hub);
  assert.equal(tokenOf(links, 'Стол 1'), token, 'enabling keeps printed stickers');
  assert.equal(new Set(links.links.map((l) => l.token)).size, links.links.length, 'every table has its own token');
  const page = await get<GuestPageView>(hub, `/api/guest/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.table?.name, 'Стол 1');
  assert.equal(page.body.table?.status, 'FREE');
  assert.ok(auditActions(hub).includes('guest.settings'));
});

test('public without a key; wrong and rotated tokens are 404; staff routes need a key', async (t) => {
  const hub = await harness(t).start(undefined, { secure: true });
  // Secure mode has no X-Actor fallback: switch on and read the links through the service, as a manager would.
  const service = new GuestService(hub.hub);
  service.setEnabled(true, 'Марат Управляющий');
  const links = service.links();
  const token = tokenOf(links, 'Стол 2');

  assert.equal((await get<GuestPageView>(hub, `/api/guest/${token}`)).status, 200);
  assertError(await get(hub, '/api/guest/AAAAAAAAAAAAAAAAAAAAAAAA'), 404, 'GUEST_NOT_FOUND');
  assertError(await get(hub, '/api/guest/short'), 404, 'GUEST_NOT_FOUND');
  assertError(await get(hub, '/api/guest-requests'), 401, 'UNAUTHORIZED');
  assertError(await get(hub, '/api/guest-links'), 401, 'UNAUTHORIZED');
  const created = await guestPost(hub, token, { kind: 'WAITER' });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const link = links.links.find((l) => l.token === token)!;
  const rotated = service.rotate(link.id, 'Марат Управляющий');
  assert.notEqual(rotated.token, token);
  assertError(await get(hub, `/api/guest/${token}`), 404, 'GUEST_NOT_FOUND');
  assertError(await guestPost(hub, token, { kind: 'BILL' }), 404, 'GUEST_NOT_FOUND');
  assert.equal((await get(hub, `/api/guest/${rotated.token}`)).status, 200);
  assert.ok(auditActions(hub).includes('guest.link_rotated'));

  // A waiter sees the requests, but the QR codes are the manager's and the administrator's.
  const waiter = hub.hub.staff.list().find((s) => s.name === 'Данияр Официант')!;
  const { key } = hub.hub.auth.issueKey({ staffId: waiter.id, actor: SYSTEM_ACTOR });
  const login = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key } });
  const auth = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
  assert.equal((await get(hub, '/api/guest-requests', auth)).status, 200);
  assertError(await get(hub, '/api/guest-links', auth), 403, 'FORBIDDEN');
});

test('rotating over HTTP: the old sticker stops working at once', async (t) => {
  const hub = await harness(t).start();
  const links = await enable(hub);
  const link = links.links.find((l) => l.tableName === 'Стол 3')!;
  const res = await send<{ token: string }>(hub, `/api/guest-links/${link.id}/rotate`);
  assert.equal(res.status, 200);
  assertError(await get(hub, `/api/guest/${link.token}`), 404, 'GUEST_NOT_FOUND');
  assert.equal((await get(hub, `/api/guest/${res.body.token}`)).status, 200);
});

test('a guest sees only their own table: its game, amount and orders, never another table or staff names', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const links = await enable(hub);
  const t1 = tokenOf(links, 'Стол 1');
  const t2 = tokenOf(links, 'Стол 2');

  const sessionId = await startGame(hub, 'Стол 1');
  h.clock.advance(37 * MIN);
  const cola = await productId(hub, 'Кола 0,5');
  const order = await send<OrderView>(hub, `/api/sessions/${sessionId}/orders`, { items: [{ productId: cola, qty: 2 }] });
  assert.equal(order.status, 201, JSON.stringify(order.body));

  const page = (await get<GuestPageView>(hub, `/api/guest/${t1}`)).body;
  const hall = hub.hub.state().tables.find((x) => x.name === 'Стол 1')!.session!;
  assert.equal(page.table?.status, 'ACTIVE');
  assert.equal(page.table?.amount, hall.amount, 'the same amount as the hall');
  assert.equal(page.table?.tariffName, hall.tariffName);
  assert.ok((page.table?.pricePerHour ?? 0) > 0);
  assert.equal(page.table?.orders.length, 1);
  assert.deepEqual(page.table?.orders[0]?.items, [{ title: 'Кола 0,5', qty: 2, amount: 1200_00 }]);
  assert.equal(page.table?.ordersTotal, 1200_00);
  assert.equal(page.table?.total, (hall.amount ?? 0) + 1200_00);
  assert.equal(page.can.BAR, true);
  assert.equal(page.can.EXTEND, true);
  const raw = JSON.stringify(page);
  assert.ok(!raw.includes('openedBy') && !raw.includes('Кассир'), 'no staff data on the guest page');

  // Стол 2 is free and knows nothing about Стол 1.
  await guestPost(hub, t1, { kind: 'WAITER' });
  const other = (await get<GuestPageView>(hub, `/api/guest/${t2}`)).body;
  assert.equal(other.table?.name, 'Стол 2');
  assert.equal(other.table?.status, 'FREE');
  assert.equal(other.table?.orders.length, 0);
  assert.equal(other.requests.length, 0);
  assert.equal(other.can.BAR, false);
  assert.equal((await get<GuestPageView>(hub, `/api/guest/${t1}`)).body.requests.length, 1);
});

// ─── Request lifecycle ──────────────────────────────────────────────────────

test('requests: waiter (one per table), bar → accepted into a real order by the waiter, extend rejected', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const links = await enable(hub);
  const token = tokenOf(links, 'Стол 1');

  // No game: the bar and «продлить» are refused, the waiter is not.
  const chips = await productId(hub, 'Чипсы');
  assertError(await guestPost(hub, token, { kind: 'BAR', items: [{ productId: chips, qty: 1 }] }), 409, 'GUEST_NOT_ALLOWED');
  assertError(await guestPost(hub, token, { kind: 'EXTEND', minutes: 30 }), 409, 'GUEST_NOT_ALLOWED');
  const waiter = await guestPost(hub, token, { kind: 'WAITER' });
  assert.equal(waiter.status, 201);
  assert.equal(waiter.body.status, 'PENDING');
  const again = await guestPost(hub, token, { kind: 'WAITER' });
  assert.equal(again.body.id, waiter.body.id, 'a second tap is the same call');

  h.clock.advance(MIN);
  const sessionId = await startGame(hub, 'Стол 1');
  const bar = await guestPost(hub, token, { kind: 'BAR', items: [{ productId: chips, qty: 2 }], note: 'побыстрее' });
  assert.equal(bar.status, 201, JSON.stringify(bar.body));
  assert.equal(bar.body.total, 1400_00);
  assertError(await guestPost(hub, token, { kind: 'EXTEND', minutes: 45 }), 422, 'GUEST_INVALID');
  const extend = await guestPost(hub, token, { kind: 'EXTEND', minutes: 60 });
  assert.equal(extend.status, 201);
  // Nothing about money changed yet.
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM bar_orders')?.n, 0);

  const list = (await get<GuestRequestsResponse>(hub, '/api/guest-requests')).body;
  const pending = list.requests.filter((r) => r.status === 'PENDING');
  assert.deepEqual(
    pending.map((r) => r.summary),
    ['Позвать официанта', 'Заказ из бара: 2 позиции', 'Продлить на 60 мин'],
  );
  assert.equal(pending[1]?.tableName, 'Стол 1');
  assert.equal(pending[1]?.sessionId, sessionId);

  const accepted = await send<{ request: StaffGuestRequestView; order: OrderView }>(
    hub,
    `/api/guest-requests/${bar.body.id}/accept`,
    {},
    'Данияр Официант',
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.request.status, 'ACCEPTED');
  assert.equal(accepted.body.order.sessionId, sessionId);
  assert.equal(accepted.body.order.createdBy, 'Данияр Официант');
  assert.equal(accepted.body.order.total, 1400_00);
  assert.equal(accepted.body.request.orderId, accepted.body.order.id);
  assert.equal(hub.hub.state().tables.find((x) => x.name === 'Стол 1')?.session?.ordersTotal, 1400_00);
  assertError(await send(hub, `/api/guest-requests/${bar.body.id}/accept`), 409, 'GUEST_REQUEST_DONE');

  const rejected = await send<StaffGuestRequestView>(hub, `/api/guest-requests/${extend.body.id}/reject`, { reason: 'Стол забронирован' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'REJECTED');
  assert.equal(rejected.body.rejectReason, 'Стол забронирован');
  assertError(await send(hub, `/api/guest-requests/${extend.body.id}/accept`), 409, 'GUEST_REQUEST_DONE');

  const page = (await get<GuestPageView>(hub, `/api/guest/${token}`)).body;
  assert.deepEqual(
    page.requests.map((r) => [r.kind, r.status]).sort(),
    [
      ['BAR', 'ACCEPTED'],
      ['EXTEND', 'REJECTED'],
    ],
    'the guest sees the requests of this game',
  );
  const actions = auditActions(hub);
  assert.ok(actions.includes('guest.request_created'));
  assert.ok(actions.includes('guest.request_accepted'));
  assert.ok(actions.includes('guest.request_rejected'));
  const journal = all<{ actor: string }>(hub.db, "SELECT actor FROM audit_log WHERE action = 'guest.request_created'");
  assert.ok(journal.every((j) => j.actor === 'Гость (QR)'));
});

test('a double tap with the same client key is one request', async (t) => {
  const hub = await harness(t).start();
  const token = tokenOf(await enable(hub), 'Стол 1');
  await startGame(hub, 'Стол 1');
  const tea = await productId(hub, 'Чай');
  const body = { kind: 'BAR', items: [{ productId: tea, qty: 1 }], clientKey: 'tap-12345678' };
  const a = await guestPost(hub, token, body);
  const b = await guestPost(hub, token, body);
  assert.equal(a.body.id, b.body.id);
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM guest_requests')?.n, 1);
});

test('rate limit per phone, and a cap on pending requests per table', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const token = tokenOf(await enable(hub), 'Стол 1');
  await startGame(hub, 'Стол 1');
  const tea = await productId(hub, 'Чай');
  const bar = { kind: 'BAR', items: [{ productId: tea, qty: 1 }] };

  for (let i = 0; i < GUEST_RATE.perClient; i++) {
    const r = await guestPost(hub, token, bar);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await send(hub, `/api/guest-requests/${r.body.id}/reject`)).status, 200);
  }
  const limited = await guestPost(hub, token, bar);
  assertError(limited, 429, 'GUEST_RATE_LIMIT');
  assert.ok((limited.body.error?.retryAfterMs ?? 0) > 0);
  // Another phone at the same table is not blocked by this one.
  assert.equal((await guestPost(hub, token, bar, '10.0.0.8')).status, 201);
  h.clock.advance(GUEST_RATE.windowMs + 1000);
  assert.equal((await guestPost(hub, token, bar)).status, 201);

  // Pending cap: staff are not buried under a prank from many phones.
  for (let i = 0; ; i++) {
    const r = await guestPost(hub, token, bar, `10.0.1.${i}`);
    if (r.status === 429) {
      assertError(r, 429, 'GUEST_TOO_MANY');
      break;
    }
    assert.equal(r.status, 201);
    assert.ok(i < GUEST_RATE.pendingPerTable);
  }
  assert.equal(
    one<{ n: number }>(hub.db, "SELECT COUNT(*) AS n FROM guest_requests WHERE status = 'PENDING'")?.n,
    GUEST_RATE.pendingPerTable,
  );
});

// ─── Coffee shop: order ahead ───────────────────────────────────────────────

test('coffee shop: order ahead → loaded on the counter and paid → the guest sees the number and the stage', async (t) => {
  const hub = await cafe(harness(t));
  const links = await enable(hub);
  assert.equal(links.business, 'cafe');
  assert.equal(links.links.length, 1);
  assert.equal(links.links[0]?.tableName, null);
  const token = links.links[0]!.token;

  const page = (await get<GuestPageView>(hub, `/api/guest/${token}`)).body;
  assert.equal(page.business, 'cafe');
  assert.equal(page.table, null);
  assert.equal(page.can.PREORDER, true);
  assert.equal(page.can.WAITER, false);
  const cappuccino = page.menu.products.find((p) => p.name === 'Капучино')!;
  assert.ok(cappuccino.options.length > 0, 'the menu has the options');

  const items = [{ productId: cappuccino.id, qty: 2, options: ['l', 'oat'] }];
  assertError(await guestPost(hub, token, { kind: 'PREORDER', items }), 422, 'GUEST_NAME_REQUIRED');
  assertError(await guestPost(hub, token, { kind: 'WAITER' }), 409, 'GUEST_NOT_ALLOWED');
  const created = await guestPost(hub, token, { kind: 'PREORDER', items, guestName: '  Аня ' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.total, 2 * (1200_00 + 400_00 + 300_00));
  assert.equal(created.body.order, null);

  // Another phone with the same QR does not see Аня's order.
  assert.equal((await get<GuestPageView>(hub, `/api/guest/${token}`)).body.requests.length, 0);

  const list = (await get<GuestRequestsResponse>(hub, '/api/guest-requests')).body;
  const req = list.requests.find((r) => r.id === created.body.id)!;
  assert.equal(req.summary, 'Заказ гостя: Аня, 2 позиции');
  assert.deepEqual(req.lines, items);
  assertError(await send(hub, `/api/guest-requests/${req.id}/accept`), 409, 'GUEST_PREORDER');

  const body = { items: req.lines, service: 'TAKEAWAY', guestName: req.guestName, payment: { parts: [{ method: 'CARD', amount: req.total }] } };
  // No shift: the payment is refused and the request stays for the cashier.
  assertError(await send(hub, `/api/guest-requests/${req.id}/counter-order`, body), 409, 'SHIFT_NOT_OPEN');
  assert.equal((await get<GuestRequestsResponse>(hub, '/api/guest-requests')).body.requests.find((r) => r.id === req.id)?.status, 'PENDING');

  const shift = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat: 0 });
  assert.equal(shift.status, 201);
  const taken = await send<CreateCounterOrderResponse & { request: StaffGuestRequestView }>(
    hub,
    `/api/guest-requests/${req.id}/counter-order`,
    body,
    'Айгерим Кассир',
  );
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(taken.body.check.status, 'PAID');
  assert.equal(taken.body.request.status, 'ACCEPTED');
  assert.equal(taken.body.request.orderId, taken.body.order.id);
  const number = taken.body.order.number;

  const mine = (await get<GuestPageView>(hub, `/api/guest/${token}?mine=${created.body.id}`)).body.requests[0]!;
  assert.deepEqual(mine.order, { number, stage: 'NEW', stageText: 'Готовится', cancelled: false });
  for (const stage of ['PREPARING', 'READY']) {
    assert.equal((await send(hub, `/api/counter/orders/${taken.body.order.id}/stage`, { stage })).status, 200);
  }
  const ready = (await get<GuestPageView>(hub, `/api/guest/${token}?mine=${created.body.id}`)).body.requests[0]!;
  assert.equal(ready.order?.stageText, 'Готово — заберите');
  assertError(await send(hub, `/api/guest-requests/${req.id}/counter-order`, body), 409, 'GUEST_REQUEST_DONE');
});

test('a sticker of the other kind of venue does not open', async (t) => {
  const hub = await harness(t).start();
  const links = await enable(hub);
  const token = tokenOf(links, 'Стол 1');
  const switched = await send(hub, '/api/club', { settings: { business: { type: 'cafe' } } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assertError(await get(hub, `/api/guest/${token}`), 404, 'GUEST_NOT_FOUND');
});
