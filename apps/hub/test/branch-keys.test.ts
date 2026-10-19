import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CheckView, LoginAttemptsResponse, LoginResponse, SessionView, StaffView } from '@bills/domain';
import { LOGIN_THROTTLE } from '@bills/domain';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, one, run } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import type { TestHub } from './helpers.ts';
import { Harness, sessionStatus, tableId, waitFor } from './helpers.ts';

/*
 * Short staff keys (six digits) belong to one branch; guessing them is stopped
 * by the login throttle; a person may hold several roles.
 */

const WAITER = 'Данияр Официант';
const MANAGER = 'Марат Управляющий';

interface ErrorBody {
  error?: { code: string; message: string; retryAfterMs?: number };
}

async function secureHub(t: { after: (fn: () => Promise<void>) => void }): Promise<{ h: Harness; hub: TestHub }> {
  const h = new Harness();
  t.after(() => h.dispose());
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
  return { h, hub };
}

function staffId(t: TestHub, name: string): string {
  const s = t.hub.staff.list().find((x) => x.name === name);
  if (!s) throw new Error(`No staff ${name}`);
  return s.id;
}

async function login(t: TestHub, key: string, device = 'планшет', remoteAddress = '127.0.0.1') {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device }, remoteAddress });
  return { status: res.statusCode, body: res.json() as LoginResponse & ErrorBody };
}

async function authed<T = unknown>(t: TestHub, token: string, method: 'GET' | 'POST', url: string, body?: object) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  const res = await t.app.inject({ method, url, headers, ...(method !== 'GET' ? { payload: body ?? {} } : {}) });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

/** A six-digit key that is not `key` and not weak. */
function wrongKey(i: number): string {
  return String(204_816 + i * 7919).padStart(6, '0').slice(-6);
}

test('a short key issued in branch A does not work in branch B — nor does its hash copied over', async (t) => {
  const a = await secureHub(t);
  const b = await secureHub(t);
  const clubA = a.hub.hub.state().club.id;
  const clubB = b.hub.hub.state().club.id;
  assert.notEqual(clubA, clubB);

  const issued = a.hub.hub.auth.issueKey({ staffId: staffId(a.hub, WAITER), actor: SYSTEM_ACTOR });
  assert.match(issued.key, /^\d{6}$/);
  assert.equal((await login(a.hub, issued.key)).status, 200);
  const inB = await login(b.hub, issued.key);
  assert.equal(inB.status, 401);
  assert.equal(inB.body.error?.code, 'KEY_INVALID');

  // Someone copies the key row (hash and all) from A's database into B's, onto B's waiter.
  const row = one<{ key_hash: string; prefix: string }>(a.hub.db, 'SELECT key_hash, prefix FROM access_keys WHERE id = ?', issued.view.id)!;
  run(
    b.hub.db,
    `INSERT INTO access_keys (id, club_id, staff_id, kind, origin, key_hash, prefix, created_at, created_by)
     VALUES (?, ?, ?, 'short', 'hub', ?, ?, 0, 'копия')`,
    randomUUID(),
    clubB,
    staffId(b.hub, WAITER),
    row.key_hash,
    row.prefix,
  );
  const copied = await login(b.hub, issued.key, 'другой планшет');
  assert.equal(copied.status, 401);
  assert.equal(copied.body.error?.code, 'KEY_INVALID');

  // The same six digits issued in B make a different hash and work only there.
  const own = b.hub.hub.auth.issueKey({ staffId: staffId(b.hub, 'Айгерим Кассир'), key: issued.key, actor: SYSTEM_ACTOR });
  assert.equal(own.key, issued.key);
  const ownHash = one<{ key_hash: string }>(b.hub.db, 'SELECT key_hash FROM access_keys WHERE id = ?', own.view.id)!.key_hash;
  assert.notEqual(ownHash, row.key_hash);
  assert.equal((await login(b.hub, issued.key, 'третий')).body.staff.name, 'Айгерим Кассир');
  assert.equal((await login(a.hub, issued.key, 'третий')).body.staff.name, WAITER);
});

test('guessing short keys: a growing pause per source, the right key refused while locked, then a branch pause; all journaled', async (t) => {
  const { h, hub } = await secureHub(t);
  const waiter = hub.hub.auth.issueKey({ staffId: staffId(hub, WAITER), actor: SYSTEM_ACTOR });
  const manager = hub.hub.auth.issueKey({ staffId: staffId(hub, MANAGER), actor: SYSTEM_ACTOR });

  // Four free mistakes, the fifth locks this device for 30 s.
  for (let i = 0; i < LOGIN_THROTTLE.freeFailures - 1; i++) {
    const res = await login(hub, wrongKey(i), 'чужой');
    assert.equal(res.status, 401, String(i));
    assert.equal(res.body.error?.code, 'KEY_INVALID');
  }
  const fifth = await login(hub, wrongKey(9), 'чужой');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.error?.code, 'LOGIN_LOCKED');
  assert.equal(fifth.body.error?.retryAfterMs, LOGIN_THROTTLE.baseLockMs);

  // Even the right key is refused from the locked source, while another source is not affected.
  const right = await login(hub, waiter.key, 'чужой');
  assert.equal(right.status, 429);
  assert.ok(right.body.error!.retryAfterMs! > 0);
  assert.equal((await login(hub, waiter.key, 'чужой', '10.0.0.7')).status, 200, 'another IP');
  // Renaming the device does not reset the count: the device name is the client's to choose.
  assert.equal((await login(hub, waiter.key, 'планшет у бара')).status, 429, 'same IP, another device name');

  // After the pause one more mistake doubles it.
  h.clock.advance(LOGIN_THROTTLE.baseLockMs + 1);
  const sixth = await login(hub, wrongKey(10), 'чужой');
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error?.retryAfterMs, LOGIN_THROTTLE.baseLockMs * 2);
  h.clock.advance(LOGIN_THROTTLE.baseLockMs * 2 + 1);
  assert.equal((await login(hub, waiter.key, 'чужой')).status, 200, 'the right key once the pause is over');

  // Many sources, each under its own limit: the branch pauses short keys after branchFailures in the window.
  let failures = all(hub.db, "SELECT id FROM login_attempts WHERE ok = 0 AND result NOT IN ('locked', 'branch_locked')").length;
  for (let i = 0; failures < LOGIN_THROTTLE.branchFailures; i++) {
    const res = await login(hub, wrongKey(100 + i), 'планшет', `10.1.${Math.floor(i / 3)}.1`);
    assert.ok(res.status === 401 || res.status === 429, String(res.status));
    failures++;
  }
  const paused = await login(hub, waiter.key, 'новый планшет', '10.0.0.8');
  assert.equal(paused.status, 429);
  assert.equal(paused.body.error?.code, 'LOGIN_LOCKED');
  assert.ok(paused.body.error!.retryAfterMs! <= LOGIN_THROTTLE.branchLockMs);
  // Long keys are not paused with the branch.
  const mgr = await login(hub, manager.key, 'ноутбук', '10.0.0.9');
  assert.equal(mgr.status, 200);
  h.clock.advance(LOGIN_THROTTLE.branchLockMs + 1);
  assert.equal((await login(hub, waiter.key, 'новый планшет', '10.0.0.8')).status, 200);

  // The journal: every attempt, with results, never the key.
  const journal = await authed<LoginAttemptsResponse>(hub, mgr.body.token, 'GET', '/api/auth/attempts?limit=500');
  assert.equal(journal.status, 200);
  const results = new Set(journal.body.attempts.map((a) => a.result));
  for (const r of ['ok', 'wrong_key', 'locked', 'branch_locked']) assert.ok(results.has(r), r);
  const ok = journal.body.attempts.find((a) => a.result === 'ok' && a.staffName === WAITER)!;
  assert.equal(ok.kind, 'short');
  assert.equal(ok.prefix, `••••${waiter.key.slice(-2)}`);
  assert.ok(journal.body.attempts.some((a) => a.ip === '10.0.0.7'));
  assert.ok(!JSON.stringify(journal.body).includes(waiter.key), 'no key in the journal');
  assert.ok(journal.body.attempts.every((a, i, arr) => i === 0 || arr[i - 1]!.id > a.id), 'newest first');
  assert.ok(all(hub.db, "SELECT id FROM audit_log WHERE action = 'auth.branch_locked'").length >= 1);
});

test('one person, two roles: a waiter + cashier opens a table and takes the payment, but gives no discount or refund', async (t) => {
  const { h, hub } = await secureHub(t);
  const person: StaffView = hub.hub.staff.create({ name: 'Официант-кассир', roles: ['waiter', 'cashier'], actor: 'system' });
  assert.deepEqual(person.roles, ['cashier', 'waiter']);
  const { key } = hub.hub.auth.issueKey({ staffId: person.id, actor: SYSTEM_ACTOR });
  const signed = await login(hub, key);
  assert.equal(signed.status, 200);
  assert.deepEqual(signed.body.staff.roles, ['cashier', 'waiter']);
  const token = signed.body.token;

  const open = await authed<SessionView>(hub, token, 'POST', `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  assert.equal(open.status, 201);
  await waitFor(() => sessionStatus(hub, open.body.id) === 'ACTIVE');
  h.clock.advance(60 * 60 * 1000);
  assert.equal((await authed(hub, token, 'POST', `/api/sessions/${open.body.id}/stop`)).status, 200);

  const shift = await authed<{ id: string }>(hub, token, 'POST', '/api/shifts/open', { openingFloat: 0 });
  assert.equal(shift.status, 201);
  const check = await authed<CheckView>(hub, token, 'POST', '/api/checks', { sessionIds: [open.body.id] });
  assert.equal(check.status, 201);
  const discount = await authed(hub, token, 'POST', `/api/checks/${check.body.id}/discount`, {
    discount: { kind: 'PERCENT', value: 10, reason: 'друг' },
  });
  assert.equal(discount.status, 403);
  assert.equal(discount.body.error?.code, 'FORBIDDEN');
  const paid = await authed<{ check: CheckView }>(hub, token, 'POST', `/api/checks/${check.body.id}/pay`, {
    parts: [{ method: 'CASH', amount: check.body.due }],
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.check.status, 'PAID');
  const refund = await authed(hub, token, 'POST', `/api/checks/${check.body.id}/refund`, { method: 'CASH', amount: 100_00 });
  assert.equal(refund.status, 403);
  assert.equal(refund.body.error?.code, 'FORBIDDEN');
  // Neither of the two roles edits the staff.
  assert.equal((await authed(hub, token, 'GET', '/api/staff')).status, 403);
});
