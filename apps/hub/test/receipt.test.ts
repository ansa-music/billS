import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  ArchiveView,
  BusinessType,
  CatalogView,
  CheckView,
  ClubAdminView,
  CreateCounterOrderResponse,
  DayChecksView,
  HubState,
  LoginResponse,
  PayResponse,
  ProductView,
  ReceiptSettings,
  Role,
  ShiftView,
} from '@bills/domain';
import { buildReceipt, normalizeReceiptSettings } from '@bills/domain';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, openDb } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { TestHub } from './helpers.ts';
import { Harness } from './helpers.ts';

/*
 * Receipts of a coffee shop: a counter check carries what its receipt prints (order number,
 * «здесь / с собой», guest, options of each line, the cashier's role), the same through every
 * route a receipt is printed from; «Чек» settings are the manager's and the administrator's,
 * only the allowed fields, checked by the HUB.
 */

type ErrorBody = { error?: { code: string; message: string } };
type People = Record<Role | 'combo', string>;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function venue(h: Harness, business: BusinessType): Promise<{ hub: TestHub; tokens: People }> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', business);
  db.close();
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
  const people: Array<[Role | 'combo', Role[]]> = [
    ['manager', ['manager']],
    ['admin', ['admin']],
    ['senior', ['senior']],
    ['cashier', ['cashier']],
    ['bartender', ['bartender']],
    ['waiter', ['waiter']],
    ['combo', ['cashier', 'waiter']],
  ];
  const tokens = {} as People;
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

function choice(p: ProductView, name: string): string {
  const c = p.options.flatMap((g) => g.choices).find((x) => x.name === name);
  if (!c) throw new Error(`No option ${name} on ${p.name}`);
  return c.id;
}

async function openShift(hub: TestHub, token: string): Promise<ShiftView> {
  const res = await call<ShiftView>(hub, token, 'POST', '/api/shifts/open', { openingFloat: 10_000_00 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const club = { name: 'Кофейня', currency: 'KZT', timezone: 'Asia/Almaty' };
const receipt = (check: CheckView, settings: ReceiptSettings = normalizeReceiptSettings(undefined)) =>
  buildReceipt({ check, club, settings, business: 'cafe', now: 0 });

test('a counter check carries its receipt: number, «с собой», guest, options, change, the barista — the same from every route', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await venue(h, 'cafe');
  const shift = await openShift(hub, tokens.bartender);
  const cappuccino = await product(hub, tokens.bartender, 'Капучино');
  const croissant = await product(hub, tokens.bartender, 'Круассан');
  const res = await call<CreateCounterOrderResponse>(hub, tokens.bartender, 'POST', '/api/counter/orders', {
    items: [
      { productId: cappuccino.id, qty: 1, options: [choice(cappuccino, 'L'), choice(cappuccino, 'Овсяное')] },
      { productId: croissant.id, qty: 2 },
    ],
    service: 'TAKEAWAY',
    guestName: 'Аня',
    payment: { parts: [{ method: 'CASH', amount: 5000_00 }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { check, order } = res.body;
  assert.equal(check.status, 'PAID');
  assert.deepEqual(check.counter, [{ id: order.id, number: order.number, service: 'TAKEAWAY', guestName: 'Аня', status: 'CLOSED' }]);
  assert.deepEqual(
    check.items.map((i) => [i.title, i.optionNames ?? null, i.qty, i.unitPrice, i.amount]),
    [
      ['Капучино · L · Овсяное', ['L', 'Овсяное'], 1, 1900_00, 1900_00],
      ['Круассан', null, 2, 900_00, 1800_00],
    ],
  );
  assert.deepEqual(check.actorRoles, { 'Тест bartender': 'bartender' });

  const r = receipt(check);
  assert.deepEqual(r.orderNumbers, [order.number]);
  assert.equal(r.service, 'С собой');
  assert.equal(r.guestName, 'Аня');
  assert.deepEqual(r.cashier, { label: 'Бариста', name: 'Тест bartender' });
  assert.deepEqual(
    r.groups.flatMap((g) => g.items.map((i) => [i.name, i.options.join(' · '), i.amount])),
    [
      ['Капучино', 'L · Овсяное', 1900_00],
      ['Круассан', '', 1800_00],
    ],
  );
  assert.equal(r.total, 3700_00);
  assert.deepEqual(r.payments.map((p) => [p.label, p.amount, p.tendered, p.change]), [['Наличные', 3700_00, 5000_00, 1300_00]]);

  // «Чеки за день», «Чеки смены» and GET /api/checks/:id give the same check — so the same receipt.
  const day = await call<DayChecksView>(hub, tokens.bartender, 'GET', '/api/checks/day');
  const fromDay = day.body.checks.find((c) => c.check.id === check.id)!.check;
  const fromShift = (await call<CheckView[]>(hub, tokens.bartender, 'GET', `/api/shifts/${shift.id}/checks`)).body.find((c) => c.id === check.id)!;
  const one = (await call<CheckView>(hub, tokens.bartender, 'GET', `/api/checks/${check.id}`)).body;
  for (const again of [fromDay, fromShift, one]) assert.deepEqual(receipt(again), r);
});

test('«счёт потом»: the waiter sends the order, the cashier takes the money later — the receipt names the order and the cashier', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await venue(h, 'cafe');
  await openShift(hub, tokens.cashier);
  const latte = await product(hub, tokens.waiter, 'Латте');
  const sent = await call<CreateCounterOrderResponse>(hub, tokens.waiter, 'POST', '/api/counter/orders', {
    items: [{ productId: latte.id, qty: 1, options: [choice(latte, 'M')] }],
    service: 'HERE',
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const pre = receipt(sent.body.check);
  assert.equal(pre.precheck, true);
  assert.equal(pre.due, 1500_00);
  assert.deepEqual(pre.orderNumbers, [sent.body.order.number]);
  assert.deepEqual(pre.cashier, { label: 'Официант', name: 'Тест waiter' });

  // The open check is in the state for the cash desk, with its counter order.
  const state = await call<HubState>(hub, tokens.cashier, 'GET', '/api/state');
  assert.equal(state.body.checks.find((c) => c.id === sent.body.check.id)?.counter?.[0]?.number, sent.body.order.number);

  const paid = await call<PayResponse>(hub, tokens.cashier, 'POST', `/api/checks/${sent.body.check.id}/pay`, {
    parts: [{ method: 'CARD', amount: 1500_00 }],
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const r = receipt(paid.body.check);
  assert.equal(r.precheck, false);
  assert.deepEqual(r.orderNumbers, [sent.body.order.number]);
  assert.equal(r.service, 'Здесь');
  assert.deepEqual(r.cashier, { label: 'Кассир', name: 'Тест cashier' });
  assert.deepEqual(r.groups[0]!.items.map((i) => [i.name, i.options]), [['Латте', ['M']]]);
  assert.deepEqual(r.payments.map((p) => p.label), ['Карта']);
});

test('a refund in «Архив» points at its check, so its receipt can be shown again', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await venue(h, 'cafe');
  await openShift(hub, tokens.cashier);
  const cake = await product(hub, tokens.cashier, 'Чизкейк');
  const res = await call<CreateCounterOrderResponse>(hub, tokens.cashier, 'POST', '/api/counter/orders', {
    items: [{ productId: cake.id, qty: 1 }],
    service: 'HERE',
    payment: { parts: [{ method: 'CARD', amount: cake.price }] },
  });
  assert.equal(res.status, 201);
  const refund = await call(hub, tokens.manager, 'POST', `/api/checks/${res.body.check.id}/refund`, {
    method: 'CARD',
    amount: cake.price,
    reason: 'Остыл',
    approvedBy: 'Тест manager',
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const archive = await call<ArchiveView>(hub, tokens.bartender, 'GET', '/api/archive');
  const entry = archive.body.entries.find((e) => e.kind === 'REFUND')!;
  assert.equal(entry.checkId, res.body.check.id);
  const again = await call<CheckView>(hub, tokens.bartender, 'GET', `/api/checks/${entry.checkId}`);
  const r = receipt(again.body);
  assert.deepEqual(r.refunds.map((x) => [x.label, x.amount, x.reason]), [['Возврат · Карта', cake.price, 'Остыл']]);
  assert.deepEqual(r.orderNumbers, [res.body.order.number]);
});

test('«Чек» settings: the director and the manager save only the allowed fields; everyone else gets 403', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await venue(h, 'cafe');
  const patch = {
    title: 'Coffee Lab',
    address: 'ул. Абая 10',
    phone: '+7 777 123 45 67',
    taxId: '123456789012',
    logo: 'data:image/png;base64,iVBORw0KGgo=',
    header: 'Кофе с собой с 8:00',
    footer: 'Спасибо!\nЖдём снова',
    wifiName: 'Lab_Guest',
    wifiPassword: 'coffee2026',
    instagram: '@coffee.lab',
    qrUrl: 'https://instagram.com/coffee.lab',
    showCashier: false,
    showGuest: true,
    showService: false,
    paper: '58',
    copies: 2,
  };
  const saved = await call<ReceiptSettings>(hub, tokens.manager, 'POST', '/api/receipt/settings', patch);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.instagram, 'coffee.lab');
  assert.equal(saved.body.paper, '58');
  assert.equal(saved.body.copies, 2);
  // Every screen gets it with the state: the barista's receipt prints with it.
  const state = await call<HubState>(hub, tokens.bartender, 'GET', '/api/state');
  assert.equal(state.body.settings.receipt.title, 'Coffee Lab');
  assert.equal(state.body.settings.receipt.showCashier, false);

  const byAdmin = await call<ReceiptSettings>(hub, tokens.admin, 'POST', '/api/receipt/settings', { header: null, copies: 1 });
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
  assert.equal(byAdmin.body.header, null);
  assert.equal(byAdmin.body.title, 'Coffee Lab', 'a patch keeps the rest');

  for (const who of ['senior', 'cashier', 'bartender', 'waiter', 'combo'] as const) {
    const res = await call(hub, tokens[who], 'POST', '/api/receipt/settings', { title: 'Чужое' });
    assert.equal(res.status, 403, who);
    assert.equal(res.body.error?.code, 'FORBIDDEN', who);
  }

  // Amounts, lines, the order number, the date and the non-fiscal note are not settings at all:
  // the schema drops such keys (Fastify removes additional properties), nothing else is stored.
  const before = (await call<ClubAdminView>(hub, tokens.manager, 'GET', '/api/club')).body.settings;
  for (const extra of [{ total: 1 }, { notice: '' }, { orderNumber: 1 }, { date: 'x' }]) {
    const res = await call<ReceiptSettings>(hub, tokens.manager, 'POST', '/api/receipt/settings', extra);
    assert.equal(res.status, 200, JSON.stringify(extra));
    assert.deepEqual(res.body, before.receipt, JSON.stringify(extra));
    assert.ok(!(Object.keys(extra)[0]! in res.body));
  }
  // …and the club route cannot reach the receipt either.
  const viaClub = await call<ClubAdminView>(hub, tokens.manager, 'POST', '/api/club', { settings: { receipt: { title: 'Обход' } } });
  assert.ok(viaClub.status === 200 || viaClub.status === 400, JSON.stringify(viaClub.body));
  assert.equal((await call<ClubAdminView>(hub, tokens.manager, 'GET', '/api/club')).body.settings.receipt.title, 'Coffee Lab');
  // The administrator of a coffee shop changes the look of the hall (display.edit) but never the receipt through it.
  const adminViaClub = await call<ClubAdminView>(hub, tokens.admin, 'POST', '/api/club', { settings: { receipt: { title: 'Обход' }, display: { theme: 'light' } } });
  assert.equal(adminViaClub.status, 200, JSON.stringify(adminViaClub.body));
  assert.equal(adminViaClub.body.settings.receipt.title, 'Coffee Lab');

  // Lengths and characters: the whole patch is refused with words for people.
  const bad = await call(hub, tokens.manager, 'POST', '/api/receipt/settings', { title: 'Новое', taxId: '123', qrUrl: 'javascript:alert(1)' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error?.code, 'RECEIPT_INVALID');
  assert.match(bad.body.error?.message ?? '', /БИН\/ИИН: ровно 12 цифр/);
  assert.match(bad.body.error?.message ?? '', /Ссылка для QR/);
  const emoji = await call(hub, tokens.manager, 'POST', '/api/receipt/settings', { footer: 'Спасибо ☕' });
  assert.equal(emoji.status, 422);
  const after = await call<ClubAdminView>(hub, tokens.manager, 'GET', '/api/club');
  assert.equal(after.body.settings.receipt.title, 'Coffee Lab', 'nothing of a refused patch is saved');

  // The journal says who changed what; the logo itself is not copied there.
  const db = openDb(h.dbPath, h.clock.now());
  const rows = all<{ actor: string; data: string }>(db, "SELECT actor, data FROM audit_log WHERE action = 'club.updated' ORDER BY id");
  db.close();
  const first = rows.find((r) => r.data.includes('Coffee Lab'))!;
  assert.equal(first.actor, 'Тест manager');
  assert.ok(first.data.includes('"logo":"загружен"'));
  assert.ok(!first.data.includes('iVBORw0KGgo'));
});

test('a billiard club: the manager and the administrator edit the receipt too; its defaults stay as before', async (t) => {
  const h = harness(t);
  const { hub, tokens } = await venue(h, 'billiards');
  const state = await call<HubState>(hub, tokens.cashier, 'GET', '/api/state');
  assert.deepEqual(state.body.settings.receipt, normalizeReceiptSettings(undefined));
  assert.equal((await call(hub, tokens.admin, 'POST', '/api/receipt/settings', { footer: 'Спасибо за игру!' })).status, 200);
  assert.equal((await call(hub, tokens.senior, 'POST', '/api/receipt/settings', { footer: 'x' })).status, 403);
  assert.equal((await call(hub, tokens.cashier, 'POST', '/api/receipt/settings', { footer: 'x' })).status, 403);
});
