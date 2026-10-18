import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccessKeyView, IssueKeyResponse, KeyListResponse, LoginResponse, MeResponse, StaffListResponse, StaffView } from '@bills/domain';
import { SESSION_TTL_MS } from '@bills/domain';
import { writeBootstrapKeys } from '../src/auth.ts';
import type { Actor } from '../src/auth.ts';
import { all } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, sessionStatus, tableId, waitFor } from './helpers.ts';

/*
 * Production-like HUB: tokens only, no X-Actor fallback. Keys are issued
 * straight through the service as the platform (what bootstrap does), then
 * every request goes through the HTTP layer with a Bearer token.
 */

const DAY = 24 * 60 * 60 * 1000;
const SYSTEM_ACTOR: Actor = { id: null, name: 'system', role: 'superadmin' };

const OWNER = 'Асель Владелец';
const MANAGER = 'Марат Управляющий';
const CASHIER = 'Айгерим Кассир';
const WAITER = 'Данияр Официант';

/** A tariff body that passes the route schema; what the role gets is decided before it runs. */
const TARIFF_BODY = {
  name: 'Тестовый',
  config: { currency: 'KZT', basePricePerHour: 1000_00, windows: [], stepMinutes: 1, minimumMinutes: 0, freeMinutes: 0, roundingMinor: 100 },
};

interface ErrorBody {
  error?: { code: string; message: string };
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

async function login(t: TestHub, key: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
  return { status: res.statusCode, body: res.json() as LoginResponse & ErrorBody };
}

async function loginAs(t: TestHub, staffName: string): Promise<string> {
  const { key } = keyFor(t, staffName);
  const res = await login(t, key);
  assert.equal(res.status, 200, `login as ${staffName}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function authed<T = unknown>(t: TestHub, token: string | null, method: 'GET' | 'POST', url: string, body?: object, idemKey = randomUUID()) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'POST') headers['idempotency-key'] = idemKey;
  const res = await t.app.inject({ method, url, headers, ...(method === 'POST' ? { payload: body ?? {} } : {}) });
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

  // A garbage token is the same as no token.
  const junk = await authed(hub, 'not-a-token', 'GET', '/api/state');
  assert.equal(junk.status, 401);

  const health = await hub.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal((health.json() as { ok: boolean }).ok, true);
});

test('a malformed key is refused; a valid key typed in lowercase with spaces still logs in', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  for (const bad of ['', 'abc', 'OWNER-AAAA-BBBB', 'OWNER-AAAA-BBBB-CCCC-DDDD-EEEE', 'WTR-0000-1111-2222-3333']) {
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: bad } });
    assert.equal(res.statusCode, bad === '' ? 400 : 401, bad);
    if (bad !== '') assert.equal((res.json() as ErrorBody).error?.code, 'KEY_INVALID', bad);
  }
  // Right shape, unknown key.
  const unknown = await login(hub, 'WTR-ABCD-EFGH-JKMN-PQRS');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error?.code, 'KEY_INVALID');

  const { key } = keyFor(hub, WAITER);
  const sloppy = `  ${key.toLowerCase().replace(/-/g, '  ')} `;
  const res = await login(hub, sloppy);
  assert.equal(res.status, 200);
  assert.equal(res.body.staff.name, WAITER);
  assert.equal(res.body.staff.role, 'waiter');
});

test('login → /api/auth/me shows who is signed in and when the session ends', async (t) => {
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
  assert.equal(me.body.staff.clubName, 'Клуб «Демо»');
  assert.equal(me.body.expiresAt, h.clock.now() + 30 * DAY);
  // The token itself is never echoed back.
  assert.ok(!('token' in me.body));
});

test('a waiter opens tables but cannot edit tariffs, read the audit or staff, or resolve alerts', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, WAITER);

  const open = await authed<{ id: string }>(hub, token, 'POST', `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(open.status, 201);
  await waitFor(() => sessionStatus(hub, open.body.id) === 'ACTIVE');
  // The audit names the employee from the session, not a header.
  const opened = all<{ actor: string }>(hub.db, "SELECT actor FROM audit_log WHERE action = 'session.open_requested'");
  assert.deepEqual(opened.map((r) => r.actor), [WAITER]);

  const state = await authed(hub, token, 'GET', '/api/state');
  assert.equal(state.status, 200);

  const tariff = await authed(hub, token, 'POST', '/api/tariffs', TARIFF_BODY);
  assert.equal(tariff.status, 403);
  assert.equal(tariff.body.error?.code, 'FORBIDDEN');
  assert.equal(all(hub.db, 'SELECT id FROM tariffs').length, 2);

  for (const url of ['/api/audit', '/api/staff', '/api/club', '/api/reports/summary']) {
    const res = await authed(hub, token, 'GET', url);
    assert.equal(res.status, 403, url);
    assert.equal(res.body.error?.code, 'FORBIDDEN', url);
  }
  const resolve = await authed(hub, token, 'POST', '/api/alerts/no-such/resolve');
  assert.equal(resolve.status, 403);
  assert.equal(resolve.body.error?.code, 'FORBIDDEN');

  // The catalog and ordering are the waiter's job.
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
  // Resolving alerts is cash desk work: not forbidden (404 — there is no such alert).
  const resolve = await authed(hub, token, 'POST', '/api/alerts/no-such/resolve');
  assert.notEqual(resolve.status, 403);
});

test('a manager hires below themself, never touches the owner, own role or own employment', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, MANAGER);
  const me = staffByName(hub, MANAGER);
  const owner = staffByName(hub, OWNER);

  const waiter = await authed<StaffView>(hub, token, 'POST', '/api/staff', { name: 'Новый официант', role: 'waiter' });
  assert.equal(waiter.status, 201);
  assert.equal(waiter.body.role, 'waiter');
  const cashier = await authed<StaffView>(hub, token, 'POST', '/api/staff', { name: 'Новый кассир', role: 'cashier' });
  assert.equal(cashier.status, 201);

  const boss = await authed(hub, token, 'POST', '/api/staff', { name: 'Ещё владелец', role: 'owner' });
  assert.equal(boss.status, 403);
  assert.equal(boss.body.error?.code, 'ROLE_NOT_ALLOWED');
  assert.equal(all(hub.db, 'SELECT id FROM staff WHERE role = ?', 'owner').length, 1);

  const rename = await authed(hub, token, 'POST', `/api/staff/${owner.id}/update`, { name: 'Переименованный' });
  assert.equal(rename.status, 403);
  assert.equal(rename.body.error?.code, 'ROLE_NOT_ALLOWED');
  assert.equal(staffByName(hub, OWNER).name, OWNER);

  const promote = await authed(hub, token, 'POST', `/api/staff/${me.id}/update`, { role: 'owner' });
  assert.equal(promote.status, 403);
  const demoteSelf = await authed(hub, token, 'POST', `/api/staff/${me.id}/update`, { role: 'waiter' });
  assert.equal(demoteSelf.status, 403);
  const fireSelf = await authed(hub, token, 'POST', `/api/staff/${me.id}/update`, { isActive: false });
  assert.equal(fireSelf.status, 403);
  assert.equal(fireSelf.body.error?.code, 'ROLE_NOT_ALLOWED');
  assert.equal(staffByName(hub, MANAGER).isActive, true);
  // Still signed in after all that.
  assert.equal((await authed(hub, token, 'GET', '/api/auth/me')).status, 200);
});

test('a manager issues keys to waiters, sees only prefixes afterwards, and cannot key the owner', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, MANAGER);
  const waiter = staffByName(hub, WAITER);
  const owner = staffByName(hub, OWNER);

  const before = await authed<StaffListResponse>(hub, token, 'GET', '/api/staff');
  assert.equal(before.status, 200);
  assert.equal(before.body.staff.find((s) => s.id === waiter.id)?.activeKeys, 0);

  const issued = await authed<IssueKeyResponse>(hub, token, 'POST', `/api/staff/${waiter.id}/keys`, { label: 'планшет у бара' });
  assert.equal(issued.status, 201);
  assert.match(issued.body.key, /^WTR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(issued.body.view.staffId, waiter.id);
  assert.equal(issued.body.view.label, 'планшет у бара');
  assert.equal(issued.body.view.createdBy, MANAGER);
  assert.equal(issued.body.view.prefix, issued.body.key.slice(0, 8));

  const list = await authed<KeyListResponse>(hub, token, 'GET', `/api/staff/${waiter.id}/keys`);
  assert.equal(list.status, 200);
  assert.equal(list.body.keys.length, 1);
  assert.equal(list.body.keys[0]!.id, issued.body.view.id);
  assert.equal(list.body.keys[0]!.prefix, issued.body.view.prefix);
  assert.ok(!JSON.stringify(list.body).includes(issued.body.key), 'the key is shown once, never listed');

  const after = await authed<StaffListResponse>(hub, token, 'GET', '/api/staff');
  assert.equal(after.body.staff.find((s) => s.id === waiter.id)?.activeKeys, 1);

  // The waiter can use it.
  assert.equal((await login(hub, issued.body.key)).status, 200);

  const forOwner = await authed(hub, token, 'POST', `/api/staff/${owner.id}/keys`, {});
  assert.equal(forOwner.status, 403);
  assert.equal(forOwner.body.error?.code, 'ROLE_NOT_ALLOWED');
  assert.equal(hub.hub.auth.listKeys(owner.id).length, 0);

  // Nor revoke something of the owner's.
  const ownerKey = keyFor(hub, OWNER);
  const revoke = await authed(hub, token, 'POST', `/api/keys/${ownerKey.view.id}/revoke`);
  assert.equal(revoke.status, 403);
  assert.equal((await login(hub, ownerKey.key)).status, 200);
});

test('an owner hires managers, keys themself, and alone changes the club name', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const ownerToken = await loginAs(hub, OWNER);
  const owner = staffByName(hub, OWNER);

  const manager = await authed<StaffView>(hub, ownerToken, 'POST', '/api/staff', { name: 'Второй управляющий', role: 'manager' });
  assert.equal(manager.status, 201);

  const selfKey = await authed<IssueKeyResponse>(hub, ownerToken, 'POST', `/api/staff/${owner.id}/keys`, { label: 'запасной' });
  assert.equal(selfKey.status, 201);
  assert.match(selfKey.body.key, /^OWNER-/);
  assert.equal((await login(hub, selfKey.body.key)).status, 200);

  const renamed = await authed<{ name: string }>(hub, ownerToken, 'POST', '/api/club', { name: 'Клуб «Шар»' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Клуб «Шар»');

  const managerToken = await loginAs(hub, MANAGER);
  const look = await authed(hub, managerToken, 'POST', '/api/club', { settings: { display: { title: 'Зал 2' }, rules: { defaultFreeMinutes: 5 } } });
  assert.equal(look.status, 200);
  const name = await authed(hub, managerToken, 'POST', '/api/club', { name: 'Чужой клуб' });
  assert.equal(name.status, 403);
  assert.equal(name.body.error?.code, 'FORBIDDEN');
  const mixed = await authed(hub, managerToken, 'POST', '/api/club', { currency: 'USD', settings: { display: { title: 'X' } } });
  assert.equal(mixed.status, 403);
  assert.equal(hub.hub.settings.club().name, 'Клуб «Шар»');
  assert.equal(hub.hub.settings.club().currency, 'KZT');
  // A manager still edits tables and tariffs.
  assert.equal((await authed(hub, managerToken, 'POST', '/api/tariffs', TARIFF_BODY)).status, 201);
  assert.equal((await authed(hub, managerToken, 'GET', '/api/club')).status, 200);
  assert.equal((await authed(hub, managerToken, 'GET', '/api/reports/summary')).status, 200);
});

test('revoking a key ends its sessions and the key stops logging in', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const ownerToken = await loginAs(hub, OWNER);
  const { key, view } = keyFor(hub, CASHIER);
  const session = await login(hub, key);
  assert.equal(session.status, 200);
  assert.equal((await authed(hub, session.body.token, 'GET', '/api/state')).status, 200);

  const revoked = await authed<AccessKeyView>(hub, ownerToken, 'POST', `/api/keys/${view.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revokedAt, h.clock.now());
  assert.equal(revoked.body.revokedBy, OWNER);

  const next = await authed(hub, session.body.token, 'GET', '/api/state');
  assert.equal(next.status, 401);
  assert.equal(next.body.error?.code, 'UNAUTHORIZED');
  const again = await login(hub, key);
  assert.equal(again.status, 401);
  assert.equal(again.body.error?.code, 'KEY_INVALID');
  assert.equal(staffByName(hub, CASHIER).activeKeys, 0);
  // Revoking twice is harmless.
  assert.equal((await authed(hub, ownerToken, 'POST', `/api/keys/${view.id}/revoke`)).status, 200);
});

test('logout kills the session; login, keys and logout are audited without the key itself', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const ownerToken = await loginAs(hub, OWNER);
  const { key, view } = keyFor(hub, WAITER);
  const session = await login(hub, key);
  assert.equal(session.status, 200);

  const out = await authed(hub, session.body.token, 'POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal((await authed(hub, session.body.token, 'GET', '/api/state')).status, 401);
  assert.equal((await authed(hub, session.body.token, 'POST', '/api/auth/logout')).status, 401);
  // The key is still good: only the session is gone.
  assert.equal((await login(hub, key)).status, 200);

  assert.equal((await authed(hub, ownerToken, 'POST', `/api/keys/${view.id}/revoke`)).status, 200);

  const actions = auditActions(hub);
  for (const a of ['auth.login', 'auth.logout', 'key.issued', 'key.revoked']) assert.ok(actions.includes(a), a);
  const logout = all<{ actor: string; entity_id: string }>(hub.db, "SELECT actor, entity_id FROM audit_log WHERE action = 'auth.logout'");
  assert.deepEqual(logout.map((r) => ({ ...r })), [{ actor: WAITER, entity_id: staffByName(hub, WAITER).id }]);

  for (const row of auditDataRows(hub)) {
    assert.ok(!row.includes(key), `audit leaks the key: ${row}`);
    assert.ok(!row.includes(session.body.token), `audit leaks the token: ${row}`);
    assert.ok(!row.includes(ownerToken), `audit leaks the owner token: ${row}`);
  }
  const issued = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'key.issued' AND entity_id = ?", staffByName(hub, WAITER).id);
  assert.deepEqual(JSON.parse(issued[0]!.data).prefix, view.prefix);
});

test('a dismissed employee is signed out at once', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const ownerToken = await loginAs(hub, OWNER);
  const waiterToken = await loginAs(hub, WAITER);
  assert.equal((await authed(hub, waiterToken, 'GET', '/api/state')).status, 200);

  const fired = await authed<StaffView>(hub, ownerToken, 'POST', `/api/staff/${staffByName(hub, WAITER).id}/update`, { isActive: false });
  assert.equal(fired.status, 200);
  assert.equal(fired.body.isActive, false);

  const res = await authed(hub, waiterToken, 'GET', '/api/state');
  assert.equal(res.status, 401);
  assert.equal(res.body.error?.code, 'UNAUTHORIZED');
  // Nor can they come back with their key, and nobody can issue them a new one.
  const waiterKey = hub.hub.auth.listKeys(staffByName(hub, WAITER).id);
  assert.equal(waiterKey.length, 1);
  assert.equal(waiterKey[0]!.revokedAt, null);
  const fresh = await authed(hub, ownerToken, 'POST', `/api/staff/${staffByName(hub, WAITER).id}/keys`, {});
  assert.equal(fresh.status, 409);
  assert.equal(fresh.body.error?.code, 'STAFF_INACTIVE');
});

test('sessions expire after 30 idle days; a one-day key stops logging in after two', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const token = await loginAs(hub, CASHIER);
  assert.equal((await authed(hub, token, 'GET', '/api/state')).status, 200);

  // Activity keeps the session alive (sliding window).
  h.clock.advance(20 * DAY);
  const me = await authed<MeResponse>(hub, token, 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.expiresAt, h.clock.now() + 30 * DAY);

  h.clock.advance(31 * DAY);
  const gone = await authed(hub, token, 'GET', '/api/state');
  assert.equal(gone.status, 401);
  assert.equal(gone.body.error?.code, 'UNAUTHORIZED');

  const short = keyFor(hub, WAITER, 1);
  assert.equal(short.view.expiresAt, h.clock.now() + DAY);
  const fresh = await login(hub, short.key);
  assert.equal(fresh.status, 200);
  h.clock.advance(2 * DAY);
  const late = await login(hub, short.key);
  assert.equal(late.status, 401);
  assert.equal(late.body.error?.code, 'KEY_INVALID');
  // The session opened with the expired key dies with it.
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
  assert.equal(first.headers['idempotent-replayed'], 'false');

  const second = await authed<{ id: string }>(hub, cashierToken, 'POST', url, {}, idem);
  assert.notEqual(second.headers['idempotent-replayed'], 'true', 'the cashier must not get the waiter\'s result');
  assert.ok(second.status === 422 || second.body.id !== first.body.id, JSON.stringify(second.body));
  if (second.status === 422) assert.equal(second.body.error?.code, 'IDEMPOTENCY_KEY_REUSED');

  // The same person retrying does get a replay.
  const retry = await authed<{ id: string }>(hub, waiterToken, 'POST', url, {}, idem);
  assert.equal(retry.status, 201);
  assert.equal(retry.headers['idempotent-replayed'], 'true');
  assert.equal(retry.body.id, first.body.id);
});

test('bootstrap keys: owner and tech when they have none, everyone on a fresh demo, written to a file', async (t) => {
  const h = harness(t);
  const hub = await secure(h);
  const auth = hub.hub.auth;

  // Fresh database, nobody has a key: everyone gets one.
  const everyone = auth.bootstrapKeys(true);
  assert.equal(everyone.length, 5);
  assert.deepEqual(everyone.map((k) => k.role).sort(), ['cashier', 'manager', 'owner', 'superadmin', 'waiter']);
  for (const k of everyone) assert.equal((await login(hub, k.key)).status, 200, k.name);
  assert.deepEqual(auth.bootstrapKeys(true), []);
  assert.deepEqual(auth.bootstrapKeys(false), []);

  // Revoke every owner key: the next start restores access for the owner only.
  const owner = staffByName(hub, OWNER);
  for (const k of auth.listKeys(owner.id)) auth.revokeKey(k.id, SYSTEM_ACTOR);
  assert.equal(staffByName(hub, OWNER).activeKeys, 0);
  const ownerOnly = auth.bootstrapKeys(false);
  assert.deepEqual(ownerOnly.map((k) => [k.role, k.name]), [['owner', OWNER]]);
  assert.match(ownerOnly[0]!.key, /^OWNER-/);

  // Owner and tech both without keys: both get one, nobody else.
  for (const s of [OWNER, 'Платформа billS']) for (const k of auth.listKeys(staffByName(hub, s).id)) auth.revokeKey(k.id, SYSTEM_ACTOR);
  const restored = auth.bootstrapKeys(false);
  assert.deepEqual(restored.map((k) => k.role).sort(), ['owner', 'superadmin']);
  assert.match(restored.find((k) => k.role === 'superadmin')!.key, /^TECH-/);
  assert.deepEqual(auth.bootstrapKeys(false), []);
  // The manager, cashier and waiter keep their original single key.
  for (const s of [MANAGER, CASHIER, WAITER]) assert.equal(staffByName(hub, s).activeKeys, 1, s);
  // Bootstrap issues are audited as the system, prefix only.
  const bootstrapped = all<{ actor: string; data: string }>(hub.db, "SELECT actor, data FROM audit_log WHERE action = 'key.issued'");
  assert.ok(bootstrapped.every((r) => r.actor === 'system' && JSON.parse(r.data).bootstrap === true));
  for (const r of bootstrapped) for (const k of [...everyone, ...ownerOnly, ...restored]) assert.ok(!r.data.includes(k.key));

  const file = join(h.dir, 'keys', 'access-keys.txt');
  writeBootstrapKeys(file, [], h.clock.now());
  assert.ok(!existsSync(file), 'nothing to write → no file');
  writeBootstrapKeys(file, restored, h.clock.now());
  const text = readFileSync(file, 'utf8');
  for (const k of restored) {
    assert.ok(text.includes(k.key), k.role);
    assert.ok(text.includes(k.name), k.role);
  }
  assert.ok(text.includes(new Date(h.clock.now()).toISOString()));
  // A second start appends rather than overwrites.
  writeBootstrapKeys(file, ownerOnly, h.clock.now());
  const appended = readFileSync(file, 'utf8');
  assert.ok(appended.includes(restored[0]!.key) && appended.includes(ownerOnly[0]!.key));
});
