import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccessKeyView,
  HallLayoutView,
  IssueKeyResponse,
  JournalPage,
  KeyListResponse,
  LoginResponse,
  MeResponse,
  SessionView,
  StaffListResponse,
  StaffView,
} from '@bills/domain';
import { SESSION_TTL_MS } from '@bills/domain';
import { INSTALLER_NAME, SYSTEM_ACTOR, writeBootstrapKeys } from '../src/auth.ts';
import { all, run } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, sessionStatus, tableId, waitFor } from './helpers.ts';

/*
 * Production-like HUB: tokens only, no X-Actor fallback. Keys are issued
 * straight through the service as the platform (what bootstrap does), then
 * every request goes through the HTTP layer with a Bearer token.
 */

const DAY = 24 * 60 * 60 * 1000;

const MANAGER = 'Марат Управляющий';
const ADMIN = 'Асель Администратор';
const CASHIER = 'Айгерим Кассир';
const WAITER = 'Данияр Официант';

/** A tariff body that passes the route schema; what the role gets is decided before it runs. */
const TARIFF_BODY = {
  name: 'Тестовый',
  config: { currency: 'KZT', basePricePerHour: 1000_00, windows: [], stepMinutes: 1, minimumMinutes: 0, freeMinutes: 0, roundingMinor: 100 },
};

interface ErrorBody {
  error?: { code: string; message: string; retryAfterMs?: number };
}

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function secure(h: Harness): Promise<TestHub> {
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
}

function staffByName(t: TestHub, name: string): StaffView {
  const s = t.hub.staff.list().find((x) => x.name === name);
  if (!s) throw new Error(`No staff ${name}`);
  return s;
}

function keyFor(t: TestHub, staffName: string, expiresInDays?: number): { key: string; view: AccessKeyView } {
  return t.hub.auth.issueKey({ staffId: staffByName(t, staffName).id, expiresInDays, actor: SYSTEM_ACTOR });
}

async function login(t: TestHub, key: string, device = 'тест') {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device } });
  return { status: res.statusCode, body: res.json() as LoginResponse & ErrorBody };
}

async function loginAs(t: TestHub, staffName: string): Promise<string> {
  const { key } = keyFor(t, staffName);
  const res = await login(t, key);
  assert.equal(res.status, 200, `login as ${staffName}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function authed<T = unknown>(t: TestHub, token: string | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: object, idemKey = randomUUID()) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['idempotency-key'] = idemKey;
  const res = await t.app.inject({ method, url, headers, ...(method !== 'GET' ? { payload: body ?? {} } : {}) });
  return { status: res.statusCode, body: res.json() as T & ErrorBody, headers: res.headers };
}

function auditDataRows(t: TestHub): string[] {
  return all<{ data: string; actor: string }>(t.db, 'SELECT data, actor FROM audit_log').map((r) => `${r.actor} ${r.data}`);
}

test('without a token every /api route but health and login answers 401', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const state = await authed(hub, null, 'GET', '/api/state');
  assert.equal(state.status, 401);
  assert.equal(state.body.error?.code, 'UNAUTHORIZED');

  const open = await authed(hub, null, 'POST', `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(open.status, 401);
  assert.equal(open.body.error?.code, 'UNAUTHORIZED');
  assert.equal(all(hub.db, 'SELECT id FROM table_sessions').length, 0);

  const junk = await authed(hub, 'not-a-token', 'GET', '/api/state');
  assert.equal(junk.status, 401);
  for (const url of ['/api/license', '/api/auth/attempts']) assert.equal((await authed(hub, null, 'GET', url)).status, 401, url);

  const health = await hub.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal((health.json() as { ok: boolean }).ok, true);
});

test('a malformed key is refused; valid keys typed sloppily still log in', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  let device = 0;
  for (const bad of ['', 'abc', 'MGR-AAAA-BBBB', 'MGR-AAAA-BBBB-CCCC-DDDD-EEEE', 'WTR-0000-1111-2222-3333', '12345', '1234567', '1111']) {
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: bad, device: `d${device}` }, remoteAddress: `10.2.0.${device++}` });
    assert.equal(res.statusCode, bad === '' ? 400 : 401, bad);
    if (bad !== '') assert.equal((res.json() as ErrorBody).error?.code, 'KEY_INVALID', bad);
  }
  const unknown = await login(hub, 'MGR-ABCD-EFGH-JKMN-PQRS', 'other');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error?.code, 'KEY_INVALID');

  const manager = keyFor(hub, MANAGER);
  assert.match(manager.key, /^MGR-/);
  const sloppy = `  ${manager.key.toLowerCase().replace(/-/g, '  ')} `;
  const res = await login(hub, sloppy);
  assert.equal(res.status, 200);
  assert.equal(res.body.staff.name, MANAGER);
  assert.deepEqual(res.body.staff.roles, ['manager']);

  const waiter = keyFor(hub, WAITER);
  assert.match(waiter.key, /^\d{6}$/);
  const spaced = `${waiter.key.slice(0, 3)} ${waiter.key.slice(3)}`;
  const w = await login(hub, spaced);
  assert.equal(w.status, 200);
  assert.equal(w.body.staff.role, 'waiter');
  assert.deepEqual(w.body.staff.roles, ['waiter']);
});

test('login → /api/auth/me shows who is signed in, their roles and when the session ends', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const { key } = keyFor(hub, CASHIER);
  const res = await login(hub, key);
  assert.equal(res.status, 200);
  assert.match(res.body.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(res.body.expiresAt, h.clock.now() + SESSION_TTL_MS);
  assert.equal(res.body.expiresAt, h.clock.now() + 30 * DAY);

  const me = await authed<MeResponse>(hub, res.body.token, 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.staff.id, staffByName(hub, CASHIER).id);
  assert.equal(me.body.staff.name, CASHIER);
  assert.equal(me.body.staff.role, 'cashier');
  assert.deepEqual(me.body.staff.roles, ['cashier']);
  assert.equal(me.body.staff.clubName, 'Клуб «Демо»');
  assert.equal(me.body.expiresAt, h.clock.now() + 30 * DAY);
  // Licenses are not enforced on this HUB.
  assert.equal(me.body.license, null);
  assert.ok(!('token' in me.body));
});

test('a waiter opens tables but cannot edit tariffs, read the audit or staff, or resolve alerts', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, WAITER);

  const open = await authed<{ id: string }>(hub, token, 'POST', `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(open.status, 201);
  await waitFor(() => sessionStatus(hub, open.body.id) === 'ACTIVE');
  const opened = all<{ actor: string }>(hub.db, "SELECT actor FROM audit_log WHERE action = 'session.open_requested'");
  assert.deepEqual(opened.map((r) => r.actor), [WAITER]);

  assert.equal((await authed(hub, token, 'GET', '/api/state')).status, 200);
  // Pause and resume are "continue a game": the waiter may.
  assert.equal((await authed(hub, token, 'POST', `/api/sessions/${open.body.id}/pause`)).status, 200);
  assert.equal((await authed(hub, token, 'POST', `/api/sessions/${open.body.id}/resume`)).status, 200);

  const tariff = await authed(hub, token, 'POST', '/api/tariffs', TARIFF_BODY);
  assert.equal(tariff.status, 403);
  assert.equal(tariff.body.error?.code, 'FORBIDDEN');
  assert.equal(all(hub.db, 'SELECT id FROM tariffs').length, 2);

  for (const url of ['/api/audit', '/api/staff', '/api/club', '/api/reports/summary', '/api/auth/attempts']) {
    const res = await authed(hub, token, 'GET', url);
    assert.equal(res.status, 403, url);
    assert.equal(res.body.error?.code, 'FORBIDDEN', url);
  }
  const resolve = await authed(hub, token, 'POST', '/api/alerts/no-such/resolve');
  assert.equal(resolve.status, 403);
  assert.equal(resolve.body.error?.code, 'FORBIDDEN');

  assert.equal((await authed(hub, token, 'GET', '/api/bar/catalog')).status, 200);
  assert.equal((await authed(hub, token, 'GET', `/api/sessions/${open.body.id}/orders`)).status, 200);
  const product = hub.hub.bar.catalog().products[0]!;
  const order = await authed<{ id: string }>(hub, token, 'POST', `/api/sessions/${open.body.id}/orders`, { items: [{ productId: product.id, qty: 1 }] });
  assert.equal(order.status, 201);
  const cancel = await authed(hub, token, 'POST', `/api/orders/${order.body.id}/cancel`, { reason: 'ошибка' });
  assert.equal(cancel.status, 403);
  const category = await authed(hub, token, 'POST', '/api/bar/categories', { name: 'Новая' });
  assert.equal(category.status, 403);
});

test('a cashier cannot edit tariffs but sees the catalog and cancels orders', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, CASHIER);

  const tariff = await authed(hub, token, 'POST', '/api/tariffs', TARIFF_BODY);
  assert.equal(tariff.status, 403);
  assert.equal(tariff.body.error?.code, 'FORBIDDEN');

  const catalog = await authed<{ products: unknown[] }>(hub, token, 'GET', '/api/bar/catalog');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.products.length >= 10);

  assert.equal((await authed(hub, token, 'POST', '/api/tables', { name: 'Стол 9', kind: 'pool', lampChannel: 'relay-9', defaultTariffId: 'x' })).status, 403);
  assert.equal((await authed(hub, token, 'GET', '/api/staff')).status, 403);
  assert.equal((await authed(hub, token, 'GET', '/api/reports/summary')).status, 403);
  const resolve = await authed(hub, token, 'POST', '/api/alerts/no-such/resolve');
  assert.notEqual(resolve.status, 403);
});

test('a manager hires staff with role sets, never managers or the platform, never changes own roles or employment', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, MANAGER);
  const me = staffByName(hub, MANAGER);
  const other = hub.hub.staff.create({ name: 'Второй управляющий', roles: ['manager'], actor: 'system' });

  const waiter = await authed<StaffView>(hub, token, 'POST', '/api/staff', { name: 'Новый официант', roles: ['waiter'] });
  assert.equal(waiter.status, 201);
  assert.equal(waiter.body.role, 'waiter');
  const combo = await authed<StaffView>(hub, token, 'POST', '/api/staff', { name: 'Бармен-кассир', roles: ['bartender', 'cashier'] });
  assert.equal(combo.status, 201);
  assert.deepEqual(combo.body.roles, ['cashier', 'bartender']);

  for (const roles of [['manager'], ['tech'], ['owner']]) {
    const res = await authed(hub, token, 'POST', '/api/staff', { name: `Кто-то ${roles[0]}`, roles });
    assert.equal(res.status, 403, roles[0]);
    assert.equal(res.body.error?.code, 'ROLE_NOT_ALLOWED');
  }
  const rename = await authed(hub, token, 'POST', `/api/staff/${other.id}/update`, { name: 'Переименованный' });
  assert.equal(rename.status, 403);
  assert.equal(rename.body.error?.code, 'ROLE_NOT_ALLOWED');
  const promote = await authed(hub, token, 'POST', `/api/staff/${waiter.body.id}/update`, { roles: ['manager'] });
  assert.equal(promote.status, 403);

  const demoteSelf = await authed(hub, token, 'POST', `/api/staff/${me.id}/update`, { roles: ['waiter'] });
  assert.equal(demoteSelf.status, 403);
  const fireSelf = await authed(hub, token, 'POST', `/api/staff/${me.id}/update`, { isActive: false });
  assert.equal(fireSelf.status, 403);
  assert.equal(fireSelf.body.error?.code, 'ROLE_NOT_ALLOWED');
  assert.equal(staffByName(hub, MANAGER).isActive, true);
  assert.equal((await authed(hub, token, 'GET', '/api/auth/me')).status, 200);

  // An administrator sees the staff but hires nobody.
  const admin = await loginAs(hub, ADMIN);
  assert.equal((await authed(hub, admin, 'GET', '/api/staff')).status, 200);
  const hire = await authed(hub, admin, 'POST', '/api/staff', { name: 'Ещё официант', roles: ['waiter'] });
  assert.equal(hire.status, 403);
  assert.equal(hire.body.error?.code, 'FORBIDDEN');
});

test('a manager issues short keys to staff (random or picked), sees only prefixes, and cannot key another manager', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, MANAGER);
  const waiter = staffByName(hub, WAITER);
  const other = hub.hub.staff.create({ name: 'Второй управляющий', roles: ['manager'], actor: 'system' });

  const before = await authed<StaffListResponse>(hub, token, 'GET', '/api/staff');
  assert.equal(before.body.staff.find((s) => s.id === waiter.id)?.activeKeys, 0);

  const issued = await authed<IssueKeyResponse>(hub, token, 'POST', `/api/staff/${waiter.id}/keys`, { label: 'планшет у бара' });
  assert.equal(issued.status, 201);
  assert.match(issued.body.key, /^\d{6}$/);
  assert.equal(issued.body.view.kind, 'short');
  assert.equal(issued.body.view.staffId, waiter.id);
  assert.equal(issued.body.view.label, 'планшет у бара');
  assert.equal(issued.body.view.createdBy, MANAGER);
  assert.equal(issued.body.view.prefix, `••••${issued.body.key.slice(-2)}`);

  const list = await authed<KeyListResponse>(hub, token, 'GET', `/api/staff/${waiter.id}/keys`);
  assert.equal(list.body.keys.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(issued.body.key), 'the key is shown once, never listed');
  assert.equal((await login(hub, issued.body.key)).status, 200);

  // Picked by hand: weak and taken digits are refused; good ones work, with an expiry.
  for (const weak of ['111111', '123456', '654321', '121212', '123123', '12345', 'abcdef']) {
    const res = await authed(hub, token, 'POST', `/api/staff/${waiter.id}/keys`, { key: weak });
    assert.equal(res.status, 422, weak);
    assert.equal(res.body.error?.code, 'KEY_WEAK', weak);
  }
  const taken = await authed(hub, token, 'POST', `/api/staff/${staffByName(hub, CASHIER).id}/keys`, { key: issued.body.key });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error?.code, 'KEY_TAKEN');
  const picked = await authed<IssueKeyResponse>(hub, token, 'POST', `/api/staff/${staffByName(hub, CASHIER).id}/keys`, { key: '480 731', expiresInDays: 7 });
  assert.equal(picked.status, 201);
  assert.equal(picked.body.key, '480731');
  assert.equal(picked.body.view.expiresAt, h.clock.now() + 7 * DAY);
  assert.equal((await login(hub, '480731')).body.staff.name, CASHIER);

  // A long key for a manager is not the manager's to issue; nor revoking someone else's above them.
  const forManager = await authed(hub, token, 'POST', `/api/staff/${other.id}/keys`, {});
  assert.equal(forManager.status, 403);
  assert.equal(forManager.body.error?.code, 'ROLE_NOT_ALLOWED');
  const managerKey = hub.hub.auth.issueKey({ staffId: other.id, actor: SYSTEM_ACTOR });
  assert.match(managerKey.key, /^MGR-/);
  const revoke = await authed(hub, token, 'POST', `/api/keys/${managerKey.view.id}/revoke`);
  assert.equal(revoke.status, 403);
  assert.equal((await login(hub, managerKey.key)).status, 200);
  // Own digits only for short keys.
  const custom = await authed(hub, token, 'POST', `/api/staff/${staffByName(hub, MANAGER).id}/keys`, { key: '480732' });
  assert.equal(custom.status, 422);
});

test('the platform hires a manager; the manager alone of the client changes the club name', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  // Support (tech) on this HUB, as the cloud would hand it over.
  hub.hub.staff.create({ name: 'Поддержка', roles: ['tech'], actor: 'system' });
  const techToken = await loginAs(hub, 'Поддержка');

  const manager = await authed<StaffView>(hub, techToken, 'POST', '/api/staff', { name: 'Второй управляющий', roles: ['manager'] });
  assert.equal(manager.status, 201);
  const selfKey = await authed<IssueKeyResponse>(hub, techToken, 'POST', `/api/staff/${staffByName(hub, 'Поддержка').id}/keys`, { label: 'запасной' });
  assert.equal(selfKey.status, 201);
  assert.match(selfKey.body.key, /^TECH-/);
  const owner = await authed(hub, techToken, 'POST', '/api/staff', { name: 'Владелец', roles: ['owner'] });
  assert.equal(owner.status, 403, 'tech does not hire owners');

  const managerToken = await loginAs(hub, MANAGER);
  const renamed = await authed<{ name: string }>(hub, managerToken, 'POST', '/api/club', { name: 'Клуб «Шар»' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Клуб «Шар»');

  const adminToken = await loginAs(hub, ADMIN);
  const look = await authed(hub, adminToken, 'POST', '/api/club', { settings: { display: { title: 'Зал 2' }, rules: { defaultFreeMinutes: 5 } } });
  assert.equal(look.status, 200);
  const name = await authed(hub, adminToken, 'POST', '/api/club', { name: 'Чужой клуб' });
  assert.equal(name.status, 403);
  assert.equal(name.body.error?.code, 'FORBIDDEN');
  const mixed = await authed(hub, adminToken, 'POST', '/api/club', { currency: 'USD', settings: { display: { title: 'X' } } });
  assert.equal(mixed.status, 403);
  assert.equal(hub.hub.settings.club().name, 'Клуб «Шар»');
  assert.equal((await authed(hub, adminToken, 'POST', '/api/tariffs', TARIFF_BODY)).status, 201);
  assert.equal((await authed(hub, adminToken, 'GET', '/api/reports/summary')).status, 200);
});

test('revoking a key ends its sessions and the key stops logging in', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const managerToken = await loginAs(hub, MANAGER);
  const { key, view } = keyFor(hub, CASHIER);
  const session = await login(hub, key);
  assert.equal(session.status, 200);
  assert.equal((await authed(hub, session.body.token, 'GET', '/api/state')).status, 200);

  const revoked = await authed<AccessKeyView>(hub, managerToken, 'POST', `/api/keys/${view.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revokedAt, h.clock.now());
  assert.equal(revoked.body.revokedBy, MANAGER);

  const next = await authed(hub, session.body.token, 'GET', '/api/state');
  assert.equal(next.status, 401);
  const again = await login(hub, key);
  assert.equal(again.status, 401);
  assert.equal(again.body.error?.code, 'KEY_INVALID');
  assert.equal(staffByName(hub, CASHIER).activeKeys, 0);
  assert.equal((await authed(hub, managerToken, 'POST', `/api/keys/${view.id}/revoke`)).status, 200);
});

test('logout kills the session; login, keys and logout are audited without the key itself', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const managerToken = await loginAs(hub, MANAGER);
  const { key, view } = keyFor(hub, WAITER);
  const session = await login(hub, key);
  assert.equal(session.status, 200);

  const out = await authed(hub, session.body.token, 'POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal((await authed(hub, session.body.token, 'GET', '/api/state')).status, 401);
  assert.equal((await authed(hub, session.body.token, 'POST', '/api/auth/logout')).status, 401);
  assert.equal((await login(hub, key)).status, 200);

  assert.equal((await authed(hub, managerToken, 'POST', `/api/keys/${view.id}/revoke`)).status, 200);

  const actions = auditActions(hub);
  for (const a of ['auth.login', 'auth.logout', 'key.issued', 'key.revoked']) assert.ok(actions.includes(a), a);
  const logout = all<{ actor: string; entity_id: string }>(hub.db, "SELECT actor, entity_id FROM audit_log WHERE action = 'auth.logout'");
  assert.deepEqual(logout.map((r) => ({ ...r })), [{ actor: WAITER, entity_id: staffByName(hub, WAITER).id }]);

  for (const row of auditDataRows(hub)) {
    assert.ok(!row.includes(`"${key}"`), `audit leaks the key: ${row}`);
    assert.ok(!row.includes(session.body.token), `audit leaks the token: ${row}`);
    assert.ok(!row.includes(managerToken), `audit leaks the manager token: ${row}`);
  }
  for (const row of all<Record<string, unknown>>(hub.db, 'SELECT * FROM login_attempts')) {
    assert.ok(!JSON.stringify(row).includes(key), 'login attempts never keep the key');
  }
  const issued = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'key.issued' AND entity_id = ?", staffByName(hub, WAITER).id);
  assert.deepEqual(JSON.parse(issued[0]!.data).prefix, view.prefix);
});

test('a dismissed employee is signed out at once', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const managerToken = await loginAs(hub, MANAGER);
  const waiterToken = await loginAs(hub, WAITER);
  assert.equal((await authed(hub, waiterToken, 'GET', '/api/state')).status, 200);

  const fired = await authed<StaffView>(hub, managerToken, 'POST', `/api/staff/${staffByName(hub, WAITER).id}/update`, { isActive: false });
  assert.equal(fired.status, 200);
  assert.equal(fired.body.isActive, false);

  const res = await authed(hub, waiterToken, 'GET', '/api/state');
  assert.equal(res.status, 401);
  const fresh = await authed(hub, managerToken, 'POST', `/api/staff/${staffByName(hub, WAITER).id}/keys`, {});
  assert.equal(fresh.status, 409);
  assert.equal(fresh.body.error?.code, 'STAFF_INACTIVE');
});

test('sessions expire after 30 idle days; a one-day key stops logging in after two', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, CASHIER);
  assert.equal((await authed(hub, token, 'GET', '/api/state')).status, 200);

  h.clock.advance(20 * DAY);
  const me = await authed<MeResponse>(hub, token, 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.expiresAt, h.clock.now() + 30 * DAY);

  h.clock.advance(31 * DAY);
  assert.equal((await authed(hub, token, 'GET', '/api/state')).status, 401);

  const short = keyFor(hub, WAITER, 1);
  assert.equal(short.view.expiresAt, h.clock.now() + DAY);
  const fresh = await login(hub, short.key);
  assert.equal(fresh.status, 200);
  h.clock.advance(2 * DAY);
  const late = await login(hub, short.key);
  assert.equal(late.status, 401);
  assert.equal(late.body.error?.code, 'KEY_INVALID');
  assert.equal((await authed(hub, fresh.body.token, 'GET', '/api/state')).status, 401);
  assert.equal(staffByName(hub, WAITER).activeKeys, 0);
});

test('an Idempotency-Key belongs to the person who used it first', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const waiterToken = await loginAs(hub, WAITER);
  const cashierToken = await loginAs(hub, CASHIER);
  const idem = randomUUID();
  const url = `/api/tables/${tableId(hub, 'Стол 2')}/open`;

  const first = await authed<{ id: string }>(hub, waiterToken, 'POST', url, {}, idem);
  assert.equal(first.status, 201);
  const second = await authed<{ id: string }>(hub, cashierToken, 'POST', url, {}, idem);
  assert.notEqual(second.headers['idempotent-replayed'], 'true');
  assert.ok(second.status === 422 || second.body.id !== first.body.id, JSON.stringify(second.body));
  const retry = await authed<{ id: string }>(hub, waiterToken, 'POST', url, {}, idem);
  assert.equal(retry.status, 201);
  assert.equal(retry.headers['idempotent-replayed'], 'true');
  assert.equal(retry.body.id, first.body.id);
});

test('bootstrap keys: the HUB manager when no long key works, an installer when nobody can, everyone on a fresh demo', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const auth = hub.hub.auth;

  const everyone = auth.bootstrapKeys(true);
  assert.equal(everyone.length, 4);
  assert.deepEqual(everyone.map((k) => k.role).sort(), ['admin', 'cashier', 'manager', 'waiter']);
  assert.match(everyone.find((k) => k.role === 'manager')!.key, /^MGR-/);
  assert.match(everyone.find((k) => k.role === 'waiter')!.key, /^\d{6}$/);
  for (const k of everyone) assert.equal((await login(hub, k.key)).status, 200, k.name);
  assert.deepEqual(auth.bootstrapKeys(true), []);
  assert.deepEqual(auth.bootstrapKeys(false), []);

  // Every manager key revoked: the next start keys the manager again, nobody else.
  const manager = staffByName(hub, MANAGER);
  for (const k of auth.listKeys(manager.id)) auth.revokeKey(k.id, SYSTEM_ACTOR);
  const managerOnly = auth.bootstrapKeys(false);
  assert.deepEqual(managerOnly.map((k) => [k.role, k.name]), [['manager', MANAGER]]);

  // Nobody who could ever sign in with a long key: an installer (tech) is created and keyed.
  run(hub.db, "UPDATE staff SET is_active = 0 WHERE role = 'manager'");
  const installer = auth.bootstrapKeys(false);
  assert.equal(installer.length, 1);
  assert.equal(installer[0]!.name, INSTALLER_NAME);
  assert.deepEqual(installer[0]!.roles, ['tech']);
  assert.match(installer[0]!.key, /^TECH-/);
  assert.equal((await login(hub, installer[0]!.key)).status, 200);
  assert.deepEqual(auth.bootstrapKeys(false), []);
  for (const s of [CASHIER, WAITER, ADMIN]) assert.equal(staffByName(hub, s).activeKeys, 1, s);
  const bootstrapped = all<{ actor: string; data: string }>(hub.db, "SELECT actor, data FROM audit_log WHERE action = 'key.issued'");
  assert.ok(bootstrapped.every((r) => r.actor === 'system' && JSON.parse(r.data).bootstrap === true));

  const file = join(h.dir, 'keys', 'access-keys.txt');
  writeBootstrapKeys(file, [], h.clock.now());
  assert.ok(!existsSync(file), 'nothing to write → no file');
  writeBootstrapKeys(file, installer, h.clock.now());
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(installer[0]!.key) && text.includes(INSTALLER_NAME));
  writeBootstrapKeys(file, managerOnly, h.clock.now());
  const appended = readFileSync(file, 'utf8');
  assert.ok(appended.includes(installer[0]!.key) && appended.includes(managerOnly[0]!.key));
});

test('hall screens: a waiter reads the plan and the day but cannot save the plan, read the journal or the lamps', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const waiter = await loginAs(hub, WAITER);
  const admin = await loginAs(hub, ADMIN);

  const plan = await authed<HallLayoutView>(hub, waiter, 'GET', '/api/hall');
  assert.equal(plan.status, 200);
  assert.equal(plan.body.layout.tables.length, 6);
  const day = await authed<SessionView[]>(hub, waiter, 'GET', `/api/sessions?from=${h.clock.now() - DAY}&to=${h.clock.now()}`);
  assert.equal(day.status, 200);

  const layout = { ...plan.body.layout, tables: plan.body.layout.tables.map((p, i) => (i === 0 ? { ...p, rotation: 90 as const } : p)) };
  const denied = await authed(hub, waiter, 'PUT', '/api/hall', layout);
  assert.equal(denied.status, 403);
  assert.equal((await authed<HallLayoutView>(hub, waiter, 'GET', '/api/hall')).body.saved, false);

  for (const url of ['/api/journal', '/api/lamps']) {
    const res = await authed(hub, waiter, 'GET', url);
    assert.equal(res.status, 403, url);
  }
  for (const url of ['/api/hall', '/api/journal', '/api/lamps']) {
    assert.equal((await authed(hub, null, 'GET', url)).status, 401, url);
    assert.equal((await authed(hub, admin, 'GET', url)).status, 200, url);
  }
  const saved = await authed<HallLayoutView>(hub, admin, 'PUT', '/api/hall', layout);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.updatedBy, ADMIN);
  const journal = await authed<JournalPage>(hub, admin, 'GET', '/api/journal?limit=5');
  assert.equal(journal.body.entries[0]?.action, 'hall.layout_saved');
});
