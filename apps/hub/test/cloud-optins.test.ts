/**
 * The opt-ins the cloud café (apps/cloud-hub) switches on, and proof that a HUB without them behaves as before:
 * lean reads (the open shift's cash as a running tally, open checks and bar orders by index), no outbox, external
 * timers (`tick`, `nextWakeAt`, nothing armed by start()) and a license built from the host's terms.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { HubState, LicenseStatus, PaymentMethod } from '@bills/domain';
import { licenseStatus, shiftTotals } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import type { Db } from '../src/db.ts';
import { all, one, openDb, run, transaction } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import type { HubDeps } from '../src/hub.ts';
import { Hub } from '../src/hub.ts';
import { record } from '../src/journal.ts';
import { leanReads, outboxEnabled } from '../src/lean.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { setupTrialClub } from '../src/trial.ts';
import { openShiftRow, shiftLedger, toShiftView } from '../src/views.ts';
import type { ShiftRow } from '../src/views.ts';
import { FAST_LAMPS, Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';

type T = { after: (fn: () => unknown) => void };
const MANAGER = 'Мадина';
const MINUTE = 60_000;

/** A coffee shop like the trial welcome screen makes one, with a HUB built with `deps`. */
async function cafe(t: T, deps: Partial<HubDeps> = {}) {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 0 }), lampOptions: FAST_LAMPS, ...deps });
  const app = buildApp(hub, { trustActorHeader: true });
  await app.ready();
  await hub.license.init();
  setupTrialClub(hub, { venue: 'Кофейня', managerName: MANAGER, key: '583104', timezone: 'Asia/Almaty', withMenu: true, now: clock.now() });
  hub.start();
  t.after(async () => {
    await app.close();
    hub.close();
    db.close();
  });
  return { clock, db, hub, app };
}

function drink(hub: Hub): { productId: string; options?: string[]; price: number } {
  const p = hub.bar.catalog().products.find((x) => x.isActive && x.stock === null)!;
  const required = p.options.filter((g) => g.required && g.choices.length);
  const options = required.map((g) => g.choices[0]!.id);
  return { productId: p.id, ...(options.length ? { options } : {}), price: p.price + required.reduce((n, g) => n + g.choices[0]!.priceDelta, 0) };
}

function sell(hub: Hub, method: PaymentMethod): { checkId: string; amount: number } {
  const d = drink(hub);
  const res = hub.counter.create({
    items: [{ productId: d.productId, qty: 1, ...(d.options ? { options: d.options } : {}) }],
    service: 'TAKEAWAY',
    payment: { parts: [{ method, amount: d.price }] },
    actor: MANAGER,
  }) as unknown as { order: { checkId: string } };
  return { checkId: res.order.checkId, amount: d.price };
}

/** What toShiftView said before lean reads: the whole ledger, every time. */
function fullExpectedCash(db: Db, row: ShiftRow): number {
  return shiftTotals(shiftLedger(db, row)).expectedCash;
}

test('lean reads: the open shift’s expected cash is a running tally with exactly the ledger’s numbers', async (t) => {
  const { db, hub, clock } = await cafe(t, { leanReads: true });
  assert.ok(leanReads(db));
  const club = one<{ id: string }>(db, 'SELECT id FROM clubs LIMIT 1')!.id;
  const shift = hub.shifts.open({ openingFloat: 5_000_00, actor: MANAGER });
  const check = () => {
    const row = openShiftRow(db, club)!;
    const lean = toShiftView(db, row).expectedCash;
    assert.equal(lean, fullExpectedCash(db, row));
    assert.equal(hub.state().shift?.expectedCash, lean);
    return lean;
  };
  assert.equal(check(), 5_000_00);
  const sales: Array<{ checkId: string; amount: number }> = [];
  for (let i = 0; i < 12; i++) {
    clock.advance(MINUTE);
    sales.push(sell(hub, (['CASH', 'CARD', 'QR'] as const)[i % 3]!));
    check();
  }
  hub.shifts.moveCash({ shiftId: shift.id, kind: 'DEPOSIT', amount: 1_000_00, reason: 'Размен', actor: MANAGER });
  check();
  hub.shifts.moveCash({ shiftId: shift.id, kind: 'WITHDRAWAL', amount: 700_00, reason: 'Инкассация', actor: MANAGER });
  check();
  // A cash refund and a card refund (only cash moves the drawer).
  hub.checks.refund({ checkId: sales[0]!.checkId, method: 'CASH', amount: sales[0]!.amount, reason: 'Пролил', approvedBy: MANAGER, actor: MANAGER });
  check();
  hub.checks.refund({ checkId: sales[1]!.checkId, method: 'CARD', amount: sales[1]!.amount, reason: 'Ошибка', approvedBy: MANAGER, actor: MANAGER });
  const before = check();

  // A transaction that adds cash and then fails: the tally is never fed from inside it.
  assert.throws(() =>
    transaction(db, () => {
      hub.shifts.moveCash({ shiftId: shift.id, kind: 'DEPOSIT', amount: 99_00, reason: 'Откат', actor: MANAGER });
      assert.equal(toShiftView(db, openShiftRow(db, club)!).expectedCash, before + 99_00);
      throw new Error('rollback');
    }),
  );
  assert.equal(check(), before);
  // The rowid of the rolled-back movement is used again by the next one: still counted.
  hub.shifts.moveCash({ shiftId: shift.id, kind: 'DEPOSIT', amount: 1_00, reason: 'Ещё', actor: MANAGER });
  assert.equal(check(), before + 1_00);

  // The next shift starts its own tally.
  const closed = hub.shifts.close({ shiftId: shift.id, countedCash: before + 1_00, actor: MANAGER });
  assert.equal(closed.shift.expectedCash, before + 1_00);
  hub.shifts.open({ openingFloat: 2_000_00, actor: MANAGER });
  assert.equal(check(), 2_000_00);
  sell(hub, 'CASH');
  check();
});

test('lean reads: GET /api/state is the same as without them (billiards with open games, orders and checks)', async (t) => {
  const plain = new Harness();
  const lean = new Harness();
  t.after(() => plain.dispose());
  t.after(() => lean.dispose());
  const a = await plain.start();
  const b = await lean.start(undefined, { leanReads: true });
  assert.ok(!leanReads(a.db) && leanReads(b.db));
  for (const h of [a, b]) {
    await post(h, '/api/shifts/open', { openingFloat: 10_000_00 });
    const opened = await post(h, `/api/tables/${tableId(h, 'Стол 1')}/open`);
    await waitFor(() => sessionStatus(h, opened.body.id) === 'ACTIVE');
    const product = h.hub.bar.catalog().products.find((p) => p.isActive && p.stock === null)!;
    await post(h, `/api/sessions/${opened.body.id}/orders`, { items: [{ productId: product.id, qty: 2 }] });
    const second = await post(h, `/api/tables/${tableId(h, 'Стол 2')}/open`);
    await waitFor(() => sessionStatus(h, second.body.id) === 'ACTIVE');
    h.clock.advance(30 * MINUTE);
    await post(h, `/api/sessions/${second.body.id}/stop`);
    await post(h, '/api/checks', { sessionIds: [second.body.id] });
  }
  const view = (s: HubState) => ({
    orders: s.orders.map((o) => [s.tables.find((t) => t.session?.id === o.sessionId)?.name ?? o.sessionId, o.total, o.items.length]),
    checks: s.checks.map((c) => [c.number, c.status, c.total, c.items.length]),
    shift: s.shift && [s.shift.number, s.shift.expectedCash],
    unpaid: s.unpaid.length,
  });
  const sa = view(a.hub.state());
  assert.ok(sa.orders.length > 0 && sa.checks.length > 0, JSON.stringify(sa));
  assert.deepEqual(view(b.hub.state()), sa);
});

test('no outbox: the journal is written, nothing is queued for the TS cloud; by default both are', async (t) => {
  const plain = await cafe(t);
  const quiet = await cafe(t, { outbox: false });
  assert.ok(outboxEnabled(plain.db) && !outboxEnabled(quiet.db));
  for (const c of [plain, quiet]) {
    transaction(c.db, () => record(c.db, c.clock.now(), { actor: MANAGER, action: 'test.entry', entityType: 'test', entityId: 'x', data: {} }));
  }
  const count = (db: Db, table: string) => one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'outbox' ? 'topic' : 'action'} = 'test.entry'`)!.n;
  assert.equal(count(plain.db, 'audit_log'), 1);
  assert.equal(count(plain.db, 'outbox'), 1);
  assert.equal(count(quiet.db, 'audit_log'), 1);
  assert.equal(count(quiet.db, 'outbox'), 0);
  assert.equal(quiet.hub.state().sync.pending, 0);
});

test('external timers: start() arms nothing and writes nothing; tick() runs the work that is due', async (t) => {
  const armed: unknown[] = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    armed.push(ms);
    return real(fn, ms);
  }) as typeof setInterval;
  let started: Awaited<ReturnType<typeof cafe>>;
  try {
    started = await cafe(t, { timers: 'external' });
  } finally {
    globalThis.setInterval = real;
  }
  const { hub, db, clock } = started;
  assert.ok(hub.externalTimers);
  assert.deepEqual(armed, [], 'no interval from the HUB, its prepaid games or its bookings');
  assert.equal(all(db, "SELECT 1 FROM audit_log WHERE action = 'hub.recovered'").length, 0);

  // First tick after a (re)start: everything once; right after: nothing; later: by period.
  assert.deepEqual(hub.tick(clock.now()).sort(), ['bookings', 'guard', 'prepaid', 'purge', 'reconcile']);
  assert.deepEqual(hub.tick(clock.now() + 1000), []);
  assert.deepEqual(hub.tick(clock.now() + 31_000).sort(), ['bookings', 'guard']);
  // An idle café has no deadline: no alarm needed.
  assert.equal(hub.nextWakeAt(clock.now()), null);

  // The purge reads the oldest key and only purges once it is well past the TTL.
  run(db, 'INSERT INTO idempotency_keys (key, request_hash, status_code, response, created_at) VALUES (?, ?, ?, ?, ?)', 'old', 'h', 200, '{}', clock.now());
  clock.advance(25 * 60 * MINUTE);
  hub.tick(clock.now());
  assert.equal(all(db, 'SELECT 1 FROM idempotency_keys').length, 1, 'a day and an hour: not yet');
  clock.advance(6 * 60 * MINUTE);
  hub.tick(clock.now());
  assert.equal(all(db, 'SELECT 1 FROM idempotency_keys').length, 0);
});

test('external timers: «Сторож» and prepaid games set the next wake-up; the alarm tick runs them', async (t) => {
  const h = new Harness();
  t.after(() => h.dispose());
  const hub = await h.start(undefined, { timers: 'external' });
  assert.equal(hub.hub.nextWakeAt(), null);
  // Manual lamp mode on: «Сторож» raises its alert after the configured minutes.
  hub.hub.setManualMode({ enabled: true, reason: 'контроллер', actor: 'Управляющий' });
  const since = hub.hub.manualMode().since!;
  const due = since + hub.hub.guardSettings().manualMode.minutes * MINUTE;
  assert.equal(hub.hub.nextWakeAt(), due);
  h.clock.set(due);
  assert.ok(hub.hub.tick().includes('guard'));
  assert.equal(all(hub.db, "SELECT 1 FROM alerts WHERE kind = 'MANUAL_MODE_LONG'").length, 1);
  assert.equal(hub.hub.nextWakeAt(), null, 'raised once: no more alarms for it');
  hub.hub.setManualMode({ enabled: false, actor: 'Управляющий' });

  // A prepaid game: the blink 5 minutes before the end, then the end.
  const table = tableId(hub, 'Стол 3');
  const tariff = hub.hub.state().tariffs[0]!.id;
  const opened = { body: hub.hub.prepaid.open({ tableId: table, tariffId: tariff, minutes: 30, actor: 'Кассир' }) };
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  hub.hub.prepaid.sync();
  const deadline = one<{ deadline_at: number }>(hub.db, 'SELECT deadline_at FROM prepaid_games')!.deadline_at;
  assert.equal(hub.hub.nextWakeAt(), deadline - 5 * MINUTE);
  h.clock.set(deadline - 5 * MINUTE);
  hub.hub.tick();
  assert.equal(hub.hub.nextWakeAt(), deadline);
  h.clock.set(deadline);
  hub.hub.tick();
  await waitFor(() => sessionStatus(hub, opened.body.id) !== 'ACTIVE');
  assert.equal(hub.hub.nextWakeAt(), null);
});

test('external timers: no cloud sync, and background jobs are only for them', () => {
  const db = openDb(':memory:', MONDAY_NOON);
  const deps = { db, clock: new ManualClock(MONDAY_NOON), lampDriver: new SimulatorLampDriver({ latencyMs: 0 }) };
  assert.throws(() => new Hub({ ...deps, timers: 'external', sync: { cloudUrl: 'https://x', hubId: 'h', hubKey: 'k' } as never }), /own timers/);
  const own = new Hub(deps);
  assert.throws(() => own.addBackgroundJob({ name: 'x', everyMs: 1, run: () => {} }), /timers: external/);
  own.close();
  db.close();
});

test('license from terms: the status is the host’s, installing is refused, nothing is stored', async (t) => {
  let terms: LicenseStatus = licenseStatus(null, MONDAY_NOON);
  const { hub, db, app } = await cafe(t, { license: { mode: 'enforce', publicKeys: {}, terms: () => terms } });
  assert.ok(hub.license.fromTerms);
  assert.equal(hub.license.status().state, 'missing');
  assert.equal(hub.license.gate()?.readOnly, true);
  terms = { ...terms, state: 'active', readOnly: false, message: null };
  assert.equal(hub.state().license?.readOnly, false);
  assert.equal(hub.license.limits(), null);
  const res = await app.inject({ method: 'POST', url: '/api/license', payload: { license: 'TS1.x.y' }, headers: { 'x-actor': 'Управляющий', 'idempotency-key': randomUUID() } });
  assert.ok([403, 409].includes(res.statusCode), `${res.statusCode} ${res.body}`);
  await assert.rejects(hub.license.install('TS1.x.y', 'manual'), /задаёт TS/);
  assert.equal(one<{ signed: string | null }>(db, 'SELECT signed FROM license_state WHERE id = 1')?.signed ?? null, null);
});
