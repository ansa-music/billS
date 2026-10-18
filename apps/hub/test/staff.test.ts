import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AuditListResponse, StaffListResponse, StaffView } from '@bills/domain';
import { all } from '../src/db.ts';
import type { TestHub } from './helpers.ts';
import { Harness, post, sessionStatus, tableId, waitFor } from './helpers.ts';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function getJson<T>(hub: TestHub, url: string): Promise<{ status: number; body: T }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
}

async function listStaff(hub: TestHub): Promise<StaffView[]> {
  return (await getJson<StaffListResponse>(hub, '/api/staff')).body.staff;
}

async function createStaff(hub: TestHub, body: object, key = randomUUID()) {
  const res = await post(hub, '/api/staff', body, key);
  return { status: res.status, body: res.body as unknown as StaffView & { error?: { code: string } }, headers: res.headers };
}

async function updateStaff(hub: TestHub, id: string, body: object) {
  const res = await post(hub, `/api/staff/${id}/update`, body);
  return { status: res.status, body: res.body as unknown as StaffView & { error?: { code: string } } };
}

async function verifyPin(hub: TestHub, id: string, pin: string) {
  const res = await post(hub, `/api/staff/${id}/verify-pin`, { pin });
  return { status: res.status, body: res.body as unknown as { ok: boolean; error?: { code: string } } };
}

test('GET /api/staff lists the demo staff with hasPin and never the PIN hash', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const staff = await listStaff(hub);
  assert.equal(staff.length, 5);
  assert.deepEqual(
    staff.map((s) => s.role).sort(),
    ['cashier', 'manager', 'owner', 'superadmin', 'waiter'],
  );
  for (const s of staff) {
    assert.equal(s.hasPin, true);
    assert.equal(s.isActive, true);
    assert.ok(!('pin' in s) && !('pinHash' in s) && !('pin_hash' in s), 'no PIN field is exposed');
  }
  const waiter = staff.find((s) => s.role === 'waiter')!;
  assert.equal(waiter.tableIds.length, 3);
  const tables = hub.hub.state().tables.map((x) => x.id);
  for (const id of waiter.tableIds) assert.ok(tables.includes(id));
});

test('a new employee with a PIN can be verified; a wrong PIN is refused', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const created = await createStaff(hub, { name: 'Ержан Кассир', role: 'cashier', pin: '2468' });
  assert.equal(created.status, 201);
  assert.equal(created.body.hasPin, true);
  assert.equal(created.body.tableIds.length, 0);
  assert.ok(!('pin' in created.body));

  assert.deepEqual((await verifyPin(hub, created.body.id, '2468')).body, { ok: true });
  assert.deepEqual((await verifyPin(hub, created.body.id, '1111')).body, { ok: false });

  // Audit shows what happened, not the PIN itself.
  const entries = all<{ action: string; data: string }>(
    hub.db,
    "SELECT action, data FROM audit_log WHERE action LIKE 'staff.%' ORDER BY id",
  );
  assert.deepEqual(entries.map((e) => e.action), ['staff.created', 'staff.pin_checked', 'staff.pin_checked']);
  for (const e of entries) assert.ok(!e.data.includes('2468'));
  assert.deepEqual(JSON.parse(entries[0]!.data), { name: 'Ержан Кассир', role: 'cashier', tableIds: [], hasPin: true });
  assert.deepEqual(entries.slice(1).map((e) => JSON.parse(e.data).ok), [true, false]);
});

test('a PIN must be 4–6 digits; an employee without a PIN never verifies', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  for (const pin of ['12', '1234567', 'abcd', '12a4']) {
    const res = await createStaff(hub, { name: `Тест ${pin}`, role: 'waiter', pin });
    assert.equal(res.status, 422, pin);
    assert.equal(res.body.error?.code, 'PIN_INVALID');
  }
  assert.equal(all(hub.db, 'SELECT id FROM staff').length, 5);

  const noPin = await createStaff(hub, { name: 'Без PIN', role: 'waiter' });
  assert.equal(noPin.status, 201);
  assert.equal(noPin.body.hasPin, false);
  assert.deepEqual((await verifyPin(hub, noPin.body.id, '1234')).body, { ok: false });

  // Setting and removing a PIN later.
  const set = await updateStaff(hub, noPin.body.id, { pin: '123456' });
  assert.equal(set.body.hasPin, true);
  assert.deepEqual((await verifyPin(hub, noPin.body.id, '123456')).body, { ok: true });
  const bad = await updateStaff(hub, noPin.body.id, { pin: '12' });
  assert.equal(bad.status, 422);
  const removed = await updateStaff(hub, noPin.body.id, { pin: null });
  assert.equal(removed.body.hasPin, false);
  assert.deepEqual((await verifyPin(hub, noPin.body.id, '123456')).body, { ok: false });
  const updates = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'staff.updated' ORDER BY id");
  assert.deepEqual(JSON.parse(updates[0]!.data), { pinChanged: true });
  assert.deepEqual(JSON.parse(updates[1]!.data), { pinChanged: true, pinRemoved: true });

  assert.equal((await verifyPin(hub, 'no-such-id', '1234')).status, 404);
});

test('the last active owner cannot be dismissed or demoted; a dismissed employee cannot log in', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const owner = (await listStaff(hub)).find((s) => s.role === 'owner')!;

  const fired = await updateStaff(hub, owner.id, { isActive: false });
  assert.equal(fired.status, 409);
  assert.equal(fired.body.error?.code, 'LAST_OWNER');
  const demoted = await updateStaff(hub, owner.id, { role: 'manager' });
  assert.equal(demoted.status, 409);
  assert.equal(demoted.body.error?.code, 'LAST_OWNER');

  // With a second owner the first one can go.
  const second = await createStaff(hub, { name: 'Второй владелец', role: 'owner', pin: '9999' });
  assert.equal(second.status, 201);
  const gone = await updateStaff(hub, owner.id, { isActive: false });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.isActive, false);
  assert.deepEqual((await verifyPin(hub, owner.id, '1234')).body, { ok: false });

  // The row stays and the list shows active staff first.
  const staff = await listStaff(hub);
  assert.equal(staff.length, 6);
  assert.equal(staff[staff.length - 1]!.id, owner.id);
  assert.ok(staff.slice(0, 5).every((s) => s.isActive));

  // Now the second owner is the last one.
  assert.equal((await updateStaff(hub, second.body.id, { isActive: false })).status, 409);
  // Bringing the first back frees the second.
  assert.equal((await updateStaff(hub, owner.id, { isActive: true })).body.isActive, true);
  assert.equal((await updateStaff(hub, second.body.id, { role: 'waiter' })).status, 200);
});

test('names are unique among active staff and trimmed', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const dup = await createStaff(hub, { name: '  Данияр   Официант ', role: 'waiter' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error?.code, 'STAFF_NAME_TAKEN');

  const created = await createStaff(hub, { name: '  Новый   Сотрудник ', role: 'cashier' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Новый Сотрудник');

  const renamed = await updateStaff(hub, created.body.id, { name: 'Асель Владелец' });
  assert.equal(renamed.status, 409);

  // A dismissed employee's name can be reused.
  await updateStaff(hub, created.body.id, { isActive: false });
  assert.equal((await createStaff(hub, { name: 'Новый Сотрудник', role: 'waiter' })).status, 201);

  const blank = await createStaff(hub, { name: '   ', role: 'waiter' });
  assert.equal(blank.status, 422);
  const badRole = await createStaff(hub, { name: 'Кто-то', role: 'boss' });
  assert.equal(badRole.status, 400);
});

test('a waiter can be assigned only to tables of the club', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const t1 = tableId(hub, 'Стол 1');
  const t2 = tableId(hub, 'Стол 2');
  const created = await createStaff(hub, { name: 'Официант Два', role: 'waiter', tableIds: [t1, t2, t1] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.tableIds, [t1, t2]);

  const bad = await createStaff(hub, { name: 'Официант Три', role: 'waiter', tableIds: [t1, 'nope'] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error?.code, 'TABLE_NOT_FOUND');

  const updated = await updateStaff(hub, created.body.id, { tableIds: [] });
  assert.deepEqual(updated.body.tableIds, []);
  const audit = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'staff.updated' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(audit[0]!.data), { tableIds: [] });
});

test('replaying POST /api/staff with the same key creates one row', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const key = randomUUID();
  const body = { name: 'Идемпотентный', role: 'waiter', pin: '4321' };
  const first = await createStaff(hub, body, key);
  const second = await createStaff(hub, body, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(all(hub.db, 'SELECT id FROM staff WHERE name = ?', 'Идемпотентный').length, 1);
  assert.equal(all(hub.db, "SELECT id FROM audit_log WHERE action = 'staff.created'").length, 1);
});

test('the audit log filters by table, actor and action, and pages by id', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const table = tableId(hub, 'Стол 1');
  const other = tableId(hub, 'Стол 2');

  const opened = await post(hub, `/api/tables/${table}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(10 * 60 * 1000);
  await post(hub, `/api/sessions/${opened.body.id}/stop`);
  await waitFor(() => hub.hub.state().tables.find((x) => x.id === table)?.lamp.reported === 'OFF');
  // Something on another table and by another actor, to be filtered out.
  const otherOpen = await hub.app.inject({
    method: 'POST',
    url: `/api/tables/${other}/open`,
    payload: {},
    headers: { 'idempotency-key': randomUUID(), 'x-actor': encodeURIComponent('Марат Управляющий') },
  });
  assert.equal(otherOpen.statusCode, 201);

  const byTable = (await getJson<AuditListResponse>(hub, `/api/audit?tableId=${table}`)).body;
  const tableActions = byTable.entries.map((e) => e.action);
  assert.ok(tableActions.includes('session.open_requested'));
  assert.ok(tableActions.includes('session.stopped'));
  assert.ok(tableActions.includes('session.started'));
  assert.ok(byTable.entries.every((e) => e.entityId === table || e.data.tableId === table));
  assert.ok(byTable.entries.every((e) => e.data.tableId !== other));
  assert.ok(byTable.actors.includes('Кассир Айгерим') && byTable.actors.includes('Марат Управляющий'));
  // Newest first, data parsed from JSON.
  assert.ok(byTable.entries.every((e, i, arr) => i === 0 || arr[i - 1]!.id > e.id));
  const stopped = byTable.entries.find((e) => e.action === 'session.stopped')!;
  assert.equal(typeof stopped.data.amount, 'number');
  assert.equal(stopped.actor, 'Кассир Айгерим');

  const byActor = (await getJson<AuditListResponse>(hub, `/api/audit?actor=${encodeURIComponent('Марат Управляющий')}`)).body;
  assert.ok(byActor.entries.length >= 1);
  assert.ok(byActor.entries.every((e) => e.actor === 'Марат Управляющий'));
  assert.deepEqual(byActor.entries.map((e) => e.action), ['session.open_requested']);

  const bySession = (await getJson<AuditListResponse>(hub, '/api/audit?action=session.')).body;
  assert.ok(bySession.entries.length >= 4);
  assert.ok(bySession.entries.every((e) => e.action.startsWith('session.')));
  const byLamp = (await getJson<AuditListResponse>(hub, '/api/audit?action=lamp.')).body;
  assert.ok(byLamp.entries.every((e) => e.action.startsWith('lamp.')));

  // Paging: one entry per page, each page older than the last.
  const page1 = (await getJson<AuditListResponse>(hub, '/api/audit?action=session.&limit=1')).body;
  assert.equal(page1.entries.length, 1);
  assert.equal(page1.nextBefore, page1.entries[0]!.id);
  const page2 = (await getJson<AuditListResponse>(hub, `/api/audit?action=session.&limit=1&before=${page1.nextBefore}`)).body;
  assert.equal(page2.entries.length, 1);
  assert.ok(page2.entries[0]!.id < page1.entries[0]!.id);
  // The full list fits in one page: no further page is offered.
  const whole = (await getJson<AuditListResponse>(hub, '/api/audit?limit=200')).body;
  assert.equal(whole.nextBefore, null);

  // Time range on `at`.
  const late = (await getJson<AuditListResponse>(hub, `/api/audit?from=${h.clock.now()}`)).body;
  assert.ok(late.entries.length >= 1);
  assert.ok(late.entries.every((e) => e.at >= h.clock.now()));
  assert.ok(late.entries.every((e) => e.action !== 'session.open_requested' || e.data.tableId === other));
  const early = (await getJson<AuditListResponse>(hub, `/api/audit?to=${h.clock.now() - 1}`)).body;
  assert.ok(early.entries.every((e) => e.at < h.clock.now()));

  assert.equal((await getJson(hub, '/api/audit?limit=0')).status, 400);
});
