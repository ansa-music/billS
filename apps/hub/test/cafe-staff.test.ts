import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CatalogView,
  CloseShiftResponse,
  CreateCounterOrderResponse,
  DeleteStaffResponse,
  HubState,
  IssueKeyResponse,
  KeyListResponse,
  LoginResponse,
  RosterResponse,
  ShiftReport,
  ShiftView,
  StaffListResponse,
  StaffView,
} from '@bills/domain';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, MIGRATIONS_DIR, one, openDb, run } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { TestHub } from './helpers.ts';
import { Harness } from './helpers.ts';

/*
 * Coffee shop feedback on people and the cash desk, on a production-like HUB (tokens only):
 *  - the admin («Управляющий» there) hires and keys the staff below them;
 *  - the director deletes a person for good — gone from lists, history kept;
 *  - the barista opens and closes the shift and takes the X and Z reports.
 * Each rule is checked against a billiard club too, which must stay exactly as it was.
 */

const DIRECTOR = 'Марат Директор';
const CAFE_ADMIN = 'Асель Управляющая';
const CASHIER = 'Айгерим Кассир';
const BARISTA = 'Данияр Бариста';

const MANAGER = 'Марат Управляющий';
const ADMIN = 'Асель Администратор';

interface ErrorBody {
  error?: { code: string; message: string };
}

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** A demo coffee shop, seeded before the HUB starts (the default billiard seed is then a no-op). */
async function cafe(h: Harness): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now(), h.migrationsDir ? { migrationsDir: h.migrationsDir } : {});
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
}

async function billiards(h: Harness): Promise<TestHub> {
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
}

function person(t: TestHub, name: string): StaffView {
  const s = all<{ id: string }>(t.db, 'SELECT id FROM staff WHERE name = ? ORDER BY created_at LIMIT 1', name)[0];
  if (!s) throw new Error(`No staff ${name}`);
  return t.hub.staff.get(s.id);
}

async function login(t: TestHub, key: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
  return { status: res.statusCode, body: res.json() as LoginResponse & ErrorBody };
}

async function loginAs(t: TestHub, name: string): Promise<string> {
  const { key } = t.hub.auth.issueKey({ staffId: person(t, name).id, actor: SYSTEM_ACTOR });
  const res = await login(t, key);
  assert.equal(res.status, 200, `login as ${name}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function call<T = unknown>(t: TestHub, token: string | null, method: 'GET' | 'POST', url: string, body?: object) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  const res = await t.app.inject({ method, url, headers, ...(method !== 'GET' ? { payload: body ?? {} } : {}) });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code });
}

// ── 1. Words ───────────────────────────────────────────────────────────────

test('coffee shop: HUB messages use its role words; a billiard club keeps its own', async (t) => {
  const c = await cafe(harness(t));
  const admin = await loginAs(c, CAFE_ADMIN);
  const hireAdmin = await call(c, admin, 'POST', '/api/staff', { name: 'Ещё управляющий', roles: ['admin'] });
  assertError(hireAdmin, 403, 'ROLE_NOT_ALLOWED');
  assert.match(hireAdmin.body.error!.message, /«Управляющий»/);
  const director = await loginAs(c, DIRECTOR);
  const mixed = await call(c, director, 'POST', '/api/staff', { name: 'Смесь', roles: ['manager', 'cashier'] });
  assertError(mixed, 422, 'ROLE_INVALID');
  assert.match(mixed.body.error!.message, /«Директор»/);
  const roster = (await c.app.inject({ method: 'GET', url: '/api/auth/roster' })).json() as RosterResponse;
  assert.equal(roster.business, 'cafe');

  const b = await billiards(harness(t));
  const manager = await loginAs(b, MANAGER);
  const billiardMixed = await call(b, manager, 'POST', '/api/staff', { name: 'Смесь', roles: ['manager', 'cashier'] });
  assert.match(billiardMixed.body.error!.message, /«Управляющий»/);
  assert.equal(((await b.app.inject({ method: 'GET', url: '/api/auth/roster' })).json() as RosterResponse).business, 'billiards');
});

// ── 2. The admin of a coffee shop manages the staff below ──────────────────

test('coffee shop: the admin hires, edits and keys the staff below them, never an admin or the director', async (t) => {
  const c = await cafe(harness(t));
  const admin = await loginAs(c, CAFE_ADMIN);

  const hired = await call<StaffView>(c, admin, 'POST', '/api/staff', { name: 'Новая бариста', roles: ['bartender'] });
  assert.equal(hired.status, 201, JSON.stringify(hired.body));
  const combo = await call<StaffView>(c, admin, 'POST', '/api/staff', { name: 'Кассир-официант', roles: ['cashier', 'waiter', 'senior'] });
  assert.equal(combo.status, 201);
  const renamed = await call<StaffView>(c, admin, 'POST', `/api/staff/${hired.body.id}/update`, { name: 'Алия Бариста', roles: ['bartender', 'cashier'] });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.roles, ['cashier', 'bartender']);

  const issued = await call<IssueKeyResponse>(c, admin, 'POST', `/api/staff/${hired.body.id}/keys`, {});
  assert.equal(issued.status, 201);
  assert.equal((await login(c, issued.body.key)).status, 200);
  const revoked = await call(c, admin, 'POST', `/api/keys/${issued.body.view.id}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.equal((await login(c, issued.body.key)).status, 401);

  // Never above or beside themselves.
  for (const roles of [['admin'], ['manager'], ['tech'], ['owner'], ['admin', 'cashier']]) {
    assertError(await call(c, admin, 'POST', '/api/staff', { name: `Кто-то ${roles.join('+')}`, roles }), 403, 'ROLE_NOT_ALLOWED');
  }
  assertError(await call(c, admin, 'POST', `/api/staff/${hired.body.id}/update`, { roles: ['admin'] }), 403, 'ROLE_NOT_ALLOWED');
  const director = person(c, DIRECTOR);
  assertError(await call(c, admin, 'POST', `/api/staff/${director.id}/update`, { name: 'Переименован' }), 403, 'ROLE_NOT_ALLOWED');
  assertError(await call(c, admin, 'POST', `/api/staff/${director.id}/keys`, {}), 403, 'ROLE_NOT_ALLOWED');
  const otherAdmin = c.hub.staff.create({ name: 'Второй управляющий', roles: ['admin'], actor: 'system' });
  assertError(await call(c, admin, 'POST', `/api/staff/${otherAdmin.id}/keys`, {}), 403, 'ROLE_NOT_ALLOWED');
  const directorKey = c.hub.auth.issueKey({ staffId: director.id, actor: SYSTEM_ACTOR }).view;
  assertError(await call(c, admin, 'POST', `/api/keys/${directorKey.id}/revoke`, {}), 403, 'ROLE_NOT_ALLOWED');
  // Their own roles stay theirs to keep.
  assertError(await call(c, admin, 'POST', `/api/staff/${person(c, CAFE_ADMIN).id}/update`, { roles: ['senior'] }), 403, 'ROLE_NOT_ALLOWED');

  // The barista and the cashier still hire nobody.
  const barista = await loginAs(c, BARISTA);
  assertError(await call(c, barista, 'POST', '/api/staff', { name: 'Друг', roles: ['waiter'] }), 403, 'FORBIDDEN');
});

test('billiards: the administrator still hires and keys nobody', async (t) => {
  const b = await billiards(harness(t));
  const admin = await loginAs(b, ADMIN);
  assertError(await call(b, admin, 'POST', '/api/staff', { name: 'Ещё официант', roles: ['waiter'] }), 403, 'FORBIDDEN');
  const cashier = person(b, 'Айгерим Кассир');
  assertError(await call(b, admin, 'POST', `/api/staff/${cashier.id}/keys`, {}), 403, 'FORBIDDEN');
  assertError(await call(b, admin, 'POST', `/api/staff/${cashier.id}/update`, { name: 'Другое имя' }), 403, 'FORBIDDEN');
  assert.equal((await call(b, admin, 'GET', '/api/staff')).status, 200);
});

// ── 3. Delete: only the director, history kept ─────────────────────────────

test('coffee shop: the director deletes a person — gone from the list, the roster and the login; history stays', async (t) => {
  const c = await cafe(harness(t));
  const director = await loginAs(c, DIRECTOR);
  const barista = await loginAs(c, BARISTA);
  const baristaId = person(c, BARISTA).id;

  // The barista works a little first: opens the shift and sells a coffee.
  const opened = await call<ShiftView>(c, barista, 'POST', '/api/shifts/open', { openingFloat: 5_000_00 });
  assert.equal(opened.status, 201);
  const catalog = (await call<CatalogView>(c, barista, 'GET', '/api/bar/catalog')).body;
  const croissant = catalog.products.find((p) => p.name === 'Круассан')!;
  const sold = await call<CreateCounterOrderResponse>(c, barista, 'POST', '/api/counter/orders', {
    items: [{ productId: croissant.id, qty: 1 }],
    service: 'HERE',
    payment: { parts: [{ method: 'CASH', amount: croissant.price }] },
  });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));

  const res = await call<DeleteStaffResponse>(c, director, 'POST', `/api/staff/${baristaId}/delete`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, BARISTA);

  // Gone from the staff list, the login roster and the login itself; the session is over.
  const list = (await call<StaffListResponse>(c, director, 'GET', '/api/staff')).body.staff;
  assert.ok(!list.some((s) => s.id === baristaId));
  const roster = (await c.app.inject({ method: 'GET', url: '/api/auth/roster' })).json() as RosterResponse;
  assert.ok(!roster.people.some((p) => p.id === baristaId));
  assert.equal((await call(c, barista, 'GET', '/api/auth/me')).status, 401);
  const keys = (await call<KeyListResponse>(c, director, 'GET', `/api/staff/${baristaId}/keys`)).body.keys;
  assert.ok(keys.length > 0 && keys.every((k) => k.revokedAt !== null));
  // Not editable or keyable any more.
  assertError(await call(c, director, 'POST', `/api/staff/${baristaId}/update`, { isActive: true }), 404, 'STAFF_NOT_FOUND');
  assertError(await call(c, director, 'POST', `/api/staff/${baristaId}/keys`, {}), 409, 'STAFF_INACTIVE');

  // History keeps the name: the shift, the receipt, the journal.
  const state = (await call<HubState>(c, director, 'GET', '/api/state')).body;
  assert.equal(state.shift?.openedBy, BARISTA);
  const report = (await call<ShiftReport>(c, director, 'GET', `/api/shifts/${opened.body.id}/report`)).body;
  assert.equal(report.openedBy, BARISTA);
  assert.ok(one(c.db, "SELECT id FROM audit_log WHERE actor = ? AND action = 'order.created'", BARISTA));
  const deleted = all<{ actor: string; data: string }>(c.db, "SELECT actor, data FROM audit_log WHERE action = 'staff.deleted'");
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]!.actor, DIRECTOR);
  assert.equal(JSON.parse(deleted[0]!.data).name, BARISTA);
  assert.equal(one<{ name: string }>(c.db, 'SELECT name FROM staff WHERE id = ?', baristaId)?.name, BARISTA);

  // The name is free again for a new person.
  const again = await call<StaffView>(c, director, 'POST', '/api/staff', { name: BARISTA, roles: ['bartender'] });
  assert.equal(again.status, 201);
});

test('coffee shop: only the director deletes — not the admin, not themselves, never the last director', async (t) => {
  const c = await cafe(harness(t));
  const director = await loginAs(c, DIRECTOR);
  const admin = await loginAs(c, CAFE_ADMIN);
  const cashier = person(c, CASHIER);

  assertError(await call(c, admin, 'POST', `/api/staff/${cashier.id}/delete`, {}), 403, 'FORBIDDEN');
  const baristaToken = await loginAs(c, BARISTA);
  assertError(await call(c, baristaToken, 'POST', `/api/staff/${cashier.id}/delete`, {}), 403, 'FORBIDDEN');

  const me = person(c, DIRECTOR);
  assertError(await call(c, director, 'POST', `/api/staff/${me.id}/delete`, {}), 403, 'ROLE_NOT_ALLOWED');
  // Another director is not theirs to delete either (directors are hired by the platform).
  const second = c.hub.staff.create({ name: 'Второй директор', roles: ['manager'], actor: 'system' });
  assertError(await call(c, director, 'POST', `/api/staff/${second.id}/delete`, {}), 403, 'ROLE_NOT_ALLOWED');

  // The platform may remove a director, but never the last one.
  const support = c.hub.staff.create({ name: 'Поддержка', roles: ['tech'], actor: 'system' });
  const tech = await loginAs(c, support.name);
  assert.equal((await call(c, tech, 'POST', `/api/staff/${second.id}/delete`, {})).status, 200);
  const last = await call(c, tech, 'POST', `/api/staff/${me.id}/delete`, {});
  assertError(last, 409, 'LAST_MANAGER');
  assert.match(last.body.error!.message, /последнего директора/);

  // People are deleted, not switched off: «отключить» is refused in a coffee shop.
  const off = await call(c, director, 'POST', `/api/staff/${cashier.id}/update`, { isActive: false });
  assertError(off, 422, 'STAFF_DELETE_INSTEAD');
  assertError(await call(c, admin, 'POST', `/api/staff/${cashier.id}/update`, { isActive: false }), 422, 'STAFF_DELETE_INSTEAD');
  assert.equal(person(c, CASHIER).isActive, true);

  // The director deletes a staff member.
  assert.equal((await call(c, director, 'POST', `/api/staff/${cashier.id}/delete`, {})).status, 200);
});

test('billiards: nobody deletes people — the manager switches them off and they stay listed', async (t) => {
  const b = await billiards(harness(t));
  const manager = await loginAs(b, MANAGER);
  const cashier = person(b, 'Айгерим Кассир');
  assertError(await call(b, manager, 'POST', `/api/staff/${cashier.id}/delete`, {}), 403, 'FORBIDDEN');
  assert.throws(() => b.hub.staff.delete({ staffId: cashier.id, actor: 'system' }), /только в кофейне/);
  const off = await call<StaffView>(b, manager, 'POST', `/api/staff/${cashier.id}/update`, { isActive: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.isActive, false);
  const list = (await call<StaffListResponse>(b, manager, 'GET', '/api/staff')).body.staff;
  assert.equal(list.find((s) => s.id === cashier.id)?.isActive, false);
});

test('coffee shop: people the cabinet switched off are not listed either', async (t) => {
  const c = await cafe(harness(t));
  const director = await loginAs(c, DIRECTOR);
  const cashier = person(c, CASHIER);
  run(c.db, "UPDATE staff SET is_active = 0, origin = 'cloud' WHERE id = ?", cashier.id);
  const list = (await call<StaffListResponse>(c, director, 'GET', '/api/staff')).body.staff;
  assert.ok(!list.some((s) => s.id === cashier.id));
  assert.ok(list.some((s) => s.name === BARISTA));
  // The cabinet's people are deleted in the cabinet.
  run(c.db, "UPDATE staff SET is_active = 1 WHERE id = ?", cashier.id);
  assertError(await call(c, director, 'POST', `/api/staff/${cashier.id}/delete`, {}), 409, 'STAFF_CLOUD_MANAGED');
});

// ── 4. The barista closes the cash desk ────────────────────────────────────

test('coffee shop: the barista opens the shift, moves cash, takes the X report and closes with the Z report', async (t) => {
  const c = await cafe(harness(t));
  const barista = await loginAs(c, BARISTA);

  const opened = await call<ShiftView>(c, barista, 'POST', '/api/shifts/open', { openingFloat: 5_000_00 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.expectedCash, 5_000_00);
  const deposit = await call<ShiftView>(c, barista, 'POST', `/api/shifts/${opened.body.id}/cash`, { kind: 'DEPOSIT', amount: 1_000_00, reason: 'Размен' });
  assert.equal(deposit.status, 200);
  assert.equal(deposit.body.expectedCash, 6_000_00);
  assert.equal((await call<HubState>(c, barista, 'GET', '/api/state')).body.shift?.expectedCash, 6_000_00);

  // «Без оплаты — счёт потом»: the shift does not close with it open, so the barista settles it.
  const catalog = (await call<CatalogView>(c, barista, 'GET', '/api/bar/catalog')).body;
  const croissant = catalog.products.find((p) => p.name === 'Круассан')!;
  const later = await call<CreateCounterOrderResponse>(c, barista, 'POST', '/api/counter/orders', {
    items: [{ productId: croissant.id, qty: 1 }],
    service: 'HERE',
    payment: null,
  });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const early = await call(c, barista, 'POST', `/api/shifts/${opened.body.id}/close`, { countedCash: 6_000_00 });
  assertError(early, 409, 'UNPAID_CHECKS');
  const paid = await call(c, barista, 'POST', `/api/checks/${later.body.check.id}/pay`, { parts: [{ method: 'CASH', amount: croissant.price }] });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  // Refunds and discounts stay with the senior staff.
  assertError(await call(c, barista, 'POST', `/api/checks/${later.body.check.id}/refund`, { method: 'CASH', amount: 100, reason: 'Остыл', approvedBy: 'Марат' }), 403, 'FORBIDDEN');

  const x = await call<ShiftReport>(c, barista, 'GET', `/api/shifts/${opened.body.id}/report`);
  assert.equal(x.status, 200);
  assert.equal(x.body.kind, 'X');
  assert.equal(x.body.net.total, croissant.price);

  const counted = 6_000_00 + croissant.price;
  const closed = await call<CloseShiftResponse>(c, barista, 'POST', `/api/shifts/${opened.body.id}/close`, { countedCash: counted });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.report?.kind, 'Z');
  assert.equal(closed.body.shift.difference, 0);
  const z = await call<ShiftReport>(c, barista, 'GET', `/api/shifts/${opened.body.id}/report`);
  assert.equal(z.body.kind, 'Z');

  // Still no revenue page, menu editing, staff or settings.
  assertError(await call(c, barista, 'GET', '/api/reports/summary'), 403, 'FORBIDDEN');
  assertError(await call(c, barista, 'GET', '/api/staff'), 403, 'FORBIDDEN');
  assertError(await call(c, barista, 'POST', '/api/bar/categories', { name: 'Новая' }), 403, 'FORBIDDEN');
});

test('coffee shop: the cashier still counts blind', async (t) => {
  const c = await cafe(harness(t));
  const cashier = await loginAs(c, CASHIER);
  const opened = await call<ShiftView>(c, cashier, 'POST', '/api/shifts/open', { openingFloat: 5_000_00 });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.expectedCash, null);
  assertError(await call(c, cashier, 'GET', `/api/shifts/${opened.body.id}/report`), 403, 'FORBIDDEN');
  const closed = await call<CloseShiftResponse>(c, cashier, 'POST', `/api/shifts/${opened.body.id}/close`, { countedCash: 5_000_00 });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.report, null);
  assert.equal(closed.body.shift.difference, null);
});

test('billiards: a bartender gets no shift and no report', async (t) => {
  const b = await billiards(harness(t));
  const bartender = b.hub.staff.create({ name: 'Бармен Ержан', roles: ['bartender'], actor: 'system' });
  const token = await loginAs(b, bartender.name);
  assertError(await call(b, token, 'POST', '/api/shifts/open', { openingFloat: 0 }), 403, 'FORBIDDEN');
  assertError(await call(b, token, 'POST', '/api/checks/nope/pay', { parts: [{ method: 'CASH', amount: 100 }] }), 403, 'FORBIDDEN');
  const manager = await loginAs(b, MANAGER);
  const opened = await call<ShiftView>(b, manager, 'POST', '/api/shifts/open', { openingFloat: 0 });
  assert.equal(opened.status, 201);
  assertError(await call(b, token, 'GET', `/api/shifts/${opened.body.id}/report`), 403, 'FORBIDDEN');
  assertError(await call(b, token, 'POST', `/api/shifts/${opened.body.id}/cash`, { kind: 'DEPOSIT', amount: 100, reason: 'тест' }), 403, 'FORBIDDEN');
  assertError(await call(b, token, 'POST', `/api/shifts/${opened.body.id}/close`, { countedCash: 0 }), 403, 'FORBIDDEN');
  // The billiard cashier keeps counting blind too.
  const cashier = await loginAs(b, 'Айгерим Кассир');
  assert.equal((await call<HubState>(b, cashier, 'GET', '/api/state')).body.shift?.expectedCash, null);
});

// ── 4a. The waiter takes orders, the till takes the money ──────────────────

test('coffee shop: a waiter sends orders to the barista without payment; the money is the till’s', async (t) => {
  const c = await cafe(harness(t));
  const waiterStaff = c.hub.staff.create({ name: 'Официант Алия', roles: ['waiter'], actor: 'system' });
  const comboStaff = c.hub.staff.create({ name: 'Официант-кассир Ден', roles: ['waiter', 'cashier'], actor: 'system' });
  const waiter = await loginAs(c, waiterStaff.name);
  const combo = await loginAs(c, comboStaff.name);
  const cashier = await loginAs(c, CASHIER);
  const opened = await call<ShiftView>(c, cashier, 'POST', '/api/shifts/open', { openingFloat: 0 });
  assert.equal(opened.status, 201);
  const croissant = (await call<CatalogView>(c, waiter, 'GET', '/api/bar/catalog')).body.products.find((p) => p.name === 'Круассан')!;
  const order = (payment: object | null) => ({ items: [{ productId: croissant.id, qty: 1 }], service: 'HERE', guestName: 'Аня', payment });
  const cash = { parts: [{ method: 'CASH', amount: croissant.price }] };

  // «Без оплаты — счёт потом»: the order goes to the barista, the check stays open.
  const sent = await call<CreateCounterOrderResponse>(c, waiter, 'POST', '/api/counter/orders', order(null));
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.order.stage, 'NEW');
  assert.equal(sent.body.payment, null);
  // With money: refused before anything is written, in plain words.
  const before = one<{ n: number }>(c.db, 'SELECT COUNT(*) AS n FROM bar_orders')!.n;
  const paid = await call(c, waiter, 'POST', '/api/counter/orders', order(cash));
  assertError(paid, 403, 'FORBIDDEN');
  assert.match(paid.body.error!.message, /без оплаты/);
  assert.equal(one<{ n: number }>(c.db, 'SELECT COUNT(*) AS n FROM bar_orders')!.n, before);
  // The cashier settles the waiter's check later; a waiter who is also a cashier pays at once.
  const settled = await call(c, cashier, 'POST', `/api/checks/${sent.body.check.id}/pay`, cash);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  const comboPaid = await call<CreateCounterOrderResponse>(c, combo, 'POST', '/api/counter/orders', order(cash));
  assert.equal(comboPaid.status, 201, JSON.stringify(comboPaid.body));
  assert.notEqual(comboPaid.body.payment, null);
});

// ── 5. The update: people already switched off in a coffee shop disappear ─

function migrationsWithout020(h: Harness): { dir: string; url: URL } {
  const dir = join(h.dir, 'migrations');
  mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (!f.startsWith('020_')) copyFileSync(new URL(f, MIGRATIONS_DIR), join(dir, f));
  return { dir, url: pathToFileURL(dir + '/') };
}

function addMigration020(dir: string): void {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('020_'))!;
  copyFileSync(new URL(file, MIGRATIONS_DIR), join(dir, file));
}

test('update: people switched off in a coffee shop before are deleted by the migration; a billiard club keeps them', async (t) => {
  for (const kind of ['cafe', 'billiards'] as const) {
    const h = harness(t);
    const migrations = migrationsWithout020(h);
    h.migrationsDir = migrations.url;
    const old = kind === 'cafe' ? await cafe(h) : await billiards(h);
    // The old schema has no deleted_at: plain SQL, as the old build would see it.
    const cashier = one<{ id: string }>(old.db, 'SELECT id FROM staff WHERE name = ?', CASHIER)!;
    old.hub.auth.issueKey({ staffId: cashier.id, actor: SYSTEM_ACTOR });
    // The old build: switched off, kept in the list as «Отключён».
    run(old.db, 'UPDATE staff SET is_active = 0 WHERE id = ?', cashier.id);
    await h.crash();

    addMigration020(migrations.dir);
    const updated = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
    const listed = updated.hub.staff.list().find((s) => s.id === cashier.id);
    const row = one<{ deleted_at: number | null; name: string }>(updated.db, 'SELECT deleted_at, name FROM staff WHERE id = ?', cashier.id);
    const liveKeys = one<{ n: number }>(updated.db, 'SELECT COUNT(*) AS n FROM access_keys WHERE staff_id = ? AND revoked_at IS NULL', cashier.id)?.n;
    if (kind === 'cafe') {
      assert.equal(listed, undefined);
      assert.notEqual(row?.deleted_at, null);
      assert.equal(liveKeys, 0);
    } else {
      assert.equal(listed?.isActive, false);
      assert.equal(row?.deleted_at, null);
      assert.equal(liveKeys, 1);
    }
    assert.equal(row?.name, CASHIER);
    // Everyone else is untouched.
    assert.equal(updated.hub.staff.list().filter((s) => s.isActive).length, 3);
  }
});
