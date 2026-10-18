import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CheckView,
  CloseShiftResponse,
  HubState,
  OpenPrepaidResponse,
  PaymentMethod,
  PayResponse,
  SessionView,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import { PREPAID_WARNING_MS } from '@bills/domain';
import { all } from '../src/db.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, MONDAY_NOON, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

const MINUTE = 60 * 1000;
const T1 = 'Стол 1';
const T2 = 'Стол 2';

type ErrorBody = { error?: { code: string } };
type Part = { method: PaymentMethod; amount: number };

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function get<T>(hub: TestHub, url: string): Promise<{ status: number; body: T }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
}

/** `post` from the helpers, with the response typed as the documented view. */
async function send<T = unknown>(hub: TestHub, url: string, body: object = {}, key?: string) {
  const res = await post(hub, url, body, key);
  return { ...res, body: res.body as unknown as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code });
}

async function state(hub: TestHub): Promise<HubState> {
  const res = await get<HubState>(hub, '/api/state');
  assert.equal(res.status, 200);
  return res.body;
}

async function openShift(hub: TestHub, openingFloat: number): Promise<ShiftView> {
  const res = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat });
  assert.equal(res.status, 201);
  return res.body;
}

function closeShift(hub: TestHub, shiftId: string, countedCash: number) {
  return send<CloseShiftResponse>(hub, `/api/shifts/${shiftId}/close`, { countedCash });
}

async function report(hub: TestHub, shiftId: string): Promise<ShiftReport> {
  const res = await get<ShiftReport>(hub, `/api/shifts/${shiftId}/report`);
  assert.equal(res.status, 200);
  return res.body;
}

/** The HUB checks deadlines on its own every second; tests drive it with the manual clock. */
function sync(hub: TestHub): void {
  hub.hub.prepaid.sync();
}

function advanceTo(h: Harness, at: number): void {
  h.clock.set(at);
}

/** Opens a timed game (paid after it stops) and waits until the lamp confirms. */
async function openTimed(hub: TestHub, table: string, minutes: number): Promise<SessionView> {
  const res = await post(hub, `/api/tables/${tableId(hub, table)}/open`, { prepaidMinutes: minutes });
  assert.equal(res.status, 201);
  await waitFor(() => sessionStatus(hub, res.body.id) === 'ACTIVE');
  const live = tableState(hub, table).session;
  assert.ok(live?.prepaid?.until, 'an active timed game has a deadline');
  return live;
}

function openPrepaid(
  hub: TestHub,
  table: string,
  body: { minutes: number; amount: number; parts: Part[]; tariffId?: string; quotedAt?: number },
  key?: string,
) {
  return send<OpenPrepaidResponse>(hub, `/api/tables/${tableId(hub, table)}/open-prepaid`, body, key);
}

/** Opens a paid prepaid game and waits until the lamp confirms; returns the response and the live view. */
async function openPaid(hub: TestHub, table: string, minutes: number, amount: number, parts: Part[]) {
  const res = await openPrepaid(hub, table, { minutes, amount, parts });
  assert.equal(res.status, 201);
  await waitFor(() => sessionStatus(hub, res.body.session.id) === 'ACTIVE');
  const live = tableState(hub, table).session;
  assert.ok(live?.prepaid?.until, 'an active prepaid game has a deadline');
  return { ...res.body, live };
}

function untilOf(view: SessionView): number {
  const until = view.prepaid?.until;
  assert.ok(typeof until === 'number', 'deadline is set');
  return until;
}

async function unpaidView(hub: TestHub, sessionId: string): Promise<SessionView | undefined> {
  return (await state(hub)).unpaid.find((g) => g.id === sessionId);
}

function sessionRow(hub: TestHub, id: string) {
  return all<{ status: string; stopped_at: number | null; played_seconds: number | null; amount: number | null }>(
    hub.db,
    'SELECT status, stopped_at, played_seconds, amount FROM table_sessions WHERE id = ?',
    id,
  )[0];
}

function lampCommands(hub: TestHub, table: string) {
  return all<{ action: string; status: string; session_id: string | null }>(
    hub.db,
    'SELECT action, status, session_id FROM lamp_commands WHERE table_id = ? ORDER BY rowid',
    tableId(hub, table),
  );
}

function blinkRows(hub: TestHub, table: string) {
  return lampCommands(hub, table).filter((c) => c.action === 'BLINK');
}

function paymentCount(hub: TestHub): number {
  return all(hub.db, 'SELECT id FROM payments').length;
}

function count(hub: TestHub, sql: string, ...params: string[]): number {
  return all(hub.db, sql, ...params).length;
}

/** A refused open must leave no trace: free table, no game, no check, no payment. */
function assertNothingCreated(hub: TestHub, table: string): void {
  assert.equal(tableState(hub, table).session, null);
  assert.equal(count(hub, 'SELECT id FROM table_sessions WHERE table_id = ?', tableId(hub, table)), 0);
  assert.equal(count(hub, 'SELECT id FROM checks'), 0);
  assert.equal(paymentCount(hub), 0);
}

// ─── Timed games (paid after the stop) ──────────────────────────────────────

test('a timed game shows its minutes and gets its deadline when the lamp confirms', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  hub.driver.latencyMs = 50;

  const res = await post(hub, `/api/tables/${tableId(hub, T1)}/open`, { prepaidMinutes: 60 });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'OPENING');
  assert.deepEqual(res.body.prepaid, { minutes: 60, until: null, amount: null, checkId: null, warnedAt: null });

  h.clock.advance(2000); // the controller answers two seconds later
  await waitFor(() => sessionStatus(hub, res.body.id) === 'ACTIVE');
  const live = tableState(hub, T1).session;
  assert.equal(live?.startedAt, MONDAY_NOON + 2000);
  assert.equal(live?.prepaid?.until, MONDAY_NOON + 2000 + 60 * MINUTE);

  const plain = await post(hub, `/api/tables/${tableId(hub, T2)}/open`);
  assert.equal(plain.status, 201);
  assert.equal(plain.body.prepaid, null);
});

test('prepaid minutes must be a whole number from 5 to 720', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const url = `/api/tables/${tableId(hub, T1)}/open`;

  for (const minutes of [3, 4, 721, 1000]) {
    assertError(await post(hub, url, { prepaidMinutes: minutes }), 422, 'INVALID_PREPAID_MINUTES');
  }
  const fraction = await post(hub, url, { prepaidMinutes: 10.5 });
  assert.ok(
    fraction.status === 400 || (fraction.status === 422 && fraction.body.error?.code === 'INVALID_PREPAID_MINUTES'),
    `10.5 minutes: ${fraction.status} ${fraction.body.error?.code}`,
  );
  assertNothingCreated(hub, T1);

  assert.equal((await post(hub, url, { prepaidMinutes: 5 })).status, 201);
  assert.equal((await post(hub, `/api/tables/${tableId(hub, T2)}/open`, { prepaidMinutes: 720 })).status, 201);
});

test('the lamp blinks once, five minutes before the end', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);
  assert.equal(PREPAID_WARNING_MS, 5 * MINUTE);

  advanceTo(h, until - 5 * MINUTE - 1);
  sync(hub);
  assert.deepEqual(blinkRows(hub, T1), []);
  assert.equal(tableState(hub, T1).session?.prepaid?.warnedAt, null);

  advanceTo(h, until - 5 * MINUTE);
  sync(hub);
  const rows = blinkRows(hub, T1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.session_id, game.id);
  assert.equal(tableState(hub, T1).session?.prepaid?.warnedAt, until - 5 * MINUTE);

  await waitFor(() => hub.driver.blinkCount('relay-1') === 1);
  await waitFor(() => blinkRows(hub, T1)[0]?.status === 'ACKED');
  assert.equal(tableState(hub, T1).lamp.desired, 'ON');
  assert.equal(tableState(hub, T1).lamp.reported, 'ON');
  assert.ok(hub.driver.isOn('relay-1'));
  assert.equal(sessionStatus(hub, game.id), 'ACTIVE');

  h.clock.advance(2 * MINUTE);
  sync(hub);
  sync(hub);
  assert.equal(blinkRows(hub, T1).length, 1);
  assert.equal(hub.driver.blinkCount('relay-1'), 1);
  assert.equal(tableState(hub, T1).session?.prepaid?.warnedAt, until - 5 * MINUTE);
});

test('at the deadline the HUB stops the game and bills exactly the prepaid time', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 45);
  const until = untilOf(game);

  advanceTo(h, until - 1);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'ACTIVE');

  advanceTo(h, until + 5 * MINUTE); // the check runs late
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  const stopped = await unpaidView(hub, game.id);
  assert.equal(stopped?.stoppedAt, until);
  assert.equal(stopped?.playedSeconds, 45 * 60);
  assert.equal(stopped?.amount, 1500_00);
  assert.equal(tableState(hub, T1).session, null);

  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF');
  assert.ok(!hub.driver.isOn('relay-1'));
  const actions = auditActions(hub);
  assert.ok(
    actions.some((a) => a.startsWith('session.prepaid')),
    actions.join(', '),
  );
});

test('a restart keeps the deadline of a running timed game', async (t) => {
  const h = harness(t);
  let hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);

  await h.crash();
  h.clock.advance(10 * MINUTE);
  hub = await h.start();
  assert.equal(sessionStatus(hub, game.id), 'ACTIVE');
  assert.equal(tableState(hub, T1).session?.prepaid?.until, until);
  assert.equal(tableState(hub, T1).session?.prepaid?.minutes, 30);

  advanceTo(h, until);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  assert.equal((await unpaidView(hub, game.id))?.stoppedAt, until);
});

test('a deadline passed while the HUB was down stops the game at the deadline on start', async (t) => {
  const h = harness(t);
  let hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);

  await h.crash();
  h.clock.advance(45 * MINUTE);
  hub = await h.start();
  await waitFor(() => sessionStatus(hub, game.id) === 'AWAITING_PAYMENT');
  const stopped = await unpaidView(hub, game.id);
  assert.equal(stopped?.stoppedAt, until);
  assert.equal(stopped?.playedSeconds, 30 * 60);
  assert.equal(stopped?.amount, 1000_00);
  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF');
  assert.ok(!hub.driver.isOn('relay-1'));
});

test('an OFF supersedes a warning blink still waiting for the controller', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);
  // Slow enough to stop while the blink is in flight, quicker than the attempt timeout (FAST_LAMPS: 200 ms).
  hub.driver.latencyMs = 150;

  advanceTo(h, until - 5 * MINUTE);
  sync(hub);
  assert.equal(blinkRows(hub, T1)[0]?.status, 'PENDING');
  const stopped = await post(hub, `/api/sessions/${game.id}/stop`);
  assert.equal(stopped.status, 200);

  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF');
  assert.equal(tableState(hub, T1).lamp.desired, 'OFF');
  assert.ok(!hub.driver.isOn('relay-1'));
  const blinks = blinkRows(hub, T1);
  assert.equal(blinks.length, 1);
  assert.ok(['SUPERSEDED', 'ACKED'].includes(blinks[0]!.status), blinks[0]!.status);
  assert.deepEqual(
    lampCommands(hub, T1).filter((c) => c.status === 'PENDING'),
    [],
  );
});

// ─── Paid upfront (open-prepaid) ─────────────────────────────────────────────

test('paid prepaid time needs an open shift', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const res = await openPrepaid(hub, T1, { minutes: 60, amount: 2000_00, parts: [{ method: 'CASH', amount: 2000_00 }] });
  assertError(res, 409, 'SHIFT_NOT_OPEN');
  assertNothingCreated(hub, T1);
});

test('paid prepaid time is refused when the price is not the HUB price', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);

  const low = await openPrepaid(hub, T1, { minutes: 60, amount: 1900_00, parts: [{ method: 'CASH', amount: 2000_00 }] });
  assertError(low, 409, 'PREPAID_PRICE_CHANGED');
  const high = await openPrepaid(hub, T1, { minutes: 60, amount: 2100_00, parts: [{ method: 'CASH', amount: 2100_00 }] });
  assertError(high, 409, 'PREPAID_PRICE_CHANGED');
  assertNothingCreated(hub, T1);
});

test('a price quoted less than a minute ago stands even when a rate change moves it', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  // Monday 17:30 in Almaty: the next hour crosses into the 18:00 evening rate, so the
  // price of "1 hour from now" grows every few seconds.
  const quotedAt = MONDAY_NOON + 330 * MINUTE;
  h.clock.set(quotedAt + 30_000);
  // Half an hour at 2 000 ₸/h + half an hour at 3 000 ₸/h, as shown to the guest.
  const parts: Part[] = [{ method: 'CASH', amount: 2500_00 }];

  assertError(await openPrepaid(hub, T1, { minutes: 60, amount: 2500_00, parts }), 409, 'PREPAID_PRICE_CHANGED');
  const stale = await openPrepaid(hub, T1, { minutes: 60, amount: 2500_00, parts, quotedAt: quotedAt - 60_000 });
  assertError(stale, 409, 'PREPAID_PRICE_CHANGED');
  assertNothingCreated(hub, T1);

  const quoted = await openPrepaid(hub, T1, { minutes: 60, amount: 2500_00, parts, quotedAt });
  assert.equal(quoted.status, 201);
  assert.equal(quoted.body.check.total, 2500_00);
  assert.equal(quoted.body.session.prepaid?.amount, 2500_00);
});

test('paid prepaid time must be paid in full, by card no more than the price', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const body = (parts: Part[]) => ({ minutes: 60, amount: 2000_00, parts });

  assertError(await openPrepaid(hub, T1, body([{ method: 'CASH', amount: 1500_00 }])), 422, 'PREPAID_NOT_FULLY_PAID');
  assertError(
    await openPrepaid(hub, T1, body([
      { method: 'CASH', amount: 1000_00 },
      { method: 'CARD', amount: 500_00 },
    ])),
    422,
    'PREPAID_NOT_FULLY_PAID',
  );
  assertError(await openPrepaid(hub, T1, body([{ method: 'CARD', amount: 2500_00 }])), 422, 'NON_CASH_OVERPAYMENT');
  assertNothingCreated(hub, T1);
});

test('paid prepaid time opens the table and takes the whole payment at once', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);

  const res = await openPrepaid(hub, T1, { minutes: 60, amount: 2000_00, parts: [{ method: 'CASH', amount: 5000_00 }] });
  assert.equal(res.status, 201);
  const { session, check } = res.body;
  assert.equal(session.status, 'OPENING');
  assert.equal(session.tableId, tableId(hub, T1));
  assert.deepEqual(session.prepaid, { minutes: 60, until: null, amount: 2000_00, checkId: check.id, warnedAt: null });
  assert.equal(check.status, 'PAID');
  assert.equal(check.total, 2000_00);
  assert.equal(check.due, 0);
  assert.deepEqual(
    check.items.map((i) => [i.kind, i.sessionId, i.amount]),
    [['GAME', session.id, 2000_00]],
  );
  assert.equal(res.body.applied, 2000_00);
  assert.equal(res.body.change, 3000_00);

  await waitFor(() => sessionStatus(hub, session.id) === 'ACTIVE');
  const live = tableState(hub, T1).session;
  assert.equal(live?.prepaid?.until, (live?.startedAt ?? NaN) + 60 * MINUTE);
  assert.equal(live?.prepaid?.amount, 2000_00);

  const s = await state(hub);
  assert.deepEqual(s.unpaid, []);
  assert.deepEqual(s.checks, []);
  assert.equal(s.shift?.expectedCash, 3000_00);
  const x = await report(hub, shift.id);
  assert.deepEqual(
    { cash: x.sales.CASH, total: x.sales.total, checks: x.checksPaid, payments: x.paymentsCount, expected: x.expectedCash },
    { cash: 2000_00, total: 2000_00, checks: 1, payments: 1, expected: 3000_00 },
  );
});

test('a paid prepaid game is closed, not billed again, at its deadline', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const paid = await openPaid(hub, T1, 30, 1000_00, [{ method: 'CARD', amount: 1000_00 }]);
  const until = untilOf(paid.live);

  advanceTo(h, until + MINUTE);
  sync(hub);
  assert.equal(sessionStatus(hub, paid.session.id), 'CLOSED');
  const row = sessionRow(hub, paid.session.id);
  assert.equal(row?.stopped_at, until);
  assert.equal(row?.amount, 1000_00);
  const s = await state(hub);
  assert.ok(!s.unpaid.some((g) => g.id === paid.session.id));
  assert.deepEqual(s.checks, []);
  assert.equal(s.tables.find((x) => x.name === T1)?.session, null);

  const check = await get<CheckView>(hub, `/api/checks/${paid.check.id}`);
  assert.equal(check.body.status, 'PAID');
  assert.equal(check.body.total, 1000_00);
  assert.equal(check.body.payments.length, 1);
  assert.equal(paymentCount(hub), 1);
  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF');
});

test('a paid prepaid game stopped early is closed with the prepaid amount', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const paid = await openPaid(hub, T1, 60, 2000_00, [{ method: 'CASH', amount: 2000_00 }]);

  h.clock.advance(20 * MINUTE);
  const stopped = await post(hub, `/api/sessions/${paid.session.id}/stop`);
  assert.equal(stopped.status, 200);
  // The reply already shows the game closed: nothing is owed on it.
  assert.equal(stopped.body.status, 'CLOSED');
  assert.equal(stopped.body.amount, 2000_00);
  assert.equal(sessionStatus(hub, paid.session.id), 'CLOSED');
  assert.equal(sessionRow(hub, paid.session.id)?.amount, 2000_00);
  assert.ok(!(await state(hub)).unpaid.some((g) => g.id === paid.session.id));
  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF');

  const x = await report(hub, shift.id);
  assert.equal(x.sales.total, 2000_00);
  assert.equal(x.refunds.total, 0);
  assert.equal(paymentCount(hub), 1);
});

test('a running paid prepaid game does not block closing the shift', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const paid = await openPaid(hub, T1, 60, 2000_00, [{ method: 'CASH', amount: 2000_00 }]);

  const closed = await closeShift(hub, shift.id, 3000_00);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.report.kind, 'Z');
  assert.equal(closed.body.report.difference, 0);
  assert.equal(closed.body.report.sales.CASH, 2000_00);
  assert.equal(sessionStatus(hub, paid.session.id), 'ACTIVE');

  // It still ends on its own after the shift is closed: nothing is owed.
  advanceTo(h, untilOf(paid.live));
  sync(hub);
  assert.equal(sessionStatus(hub, paid.session.id), 'CLOSED');
});

test('a paid prepaid game whose lamp never confirms raises an alert and keeps the money for a manual refund', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  hub.driver.offline = true;

  const res = await openPrepaid(hub, T1, { minutes: 60, amount: 2000_00, parts: [{ method: 'CASH', amount: 2000_00 }] });
  assert.equal(res.status, 201);
  await waitFor(() => sessionStatus(hub, res.body.session.id) === 'FAILED');
  sync(hub);
  sync(hub);

  const alerts = (await state(hub)).alerts.filter((a) => a.kind === 'PREPAID_NOT_STARTED');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.tableId, tableId(hub, T1));
  const check = await get<CheckView>(hub, `/api/checks/${res.body.check.id}`);
  assert.equal(check.body.status, 'PAID');
  assert.equal(check.body.refunded, 0);
  assert.equal(paymentCount(hub), 1);
});

test('a repeated paid open with the same key opens and charges once', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  await openShift(hub, 1000_00);
  const key = randomUUID();
  const body = {
    minutes: 60,
    amount: 2000_00,
    parts: [
      { method: 'CASH' as const, amount: 1000_00 },
      { method: 'CARD' as const, amount: 1000_00 },
    ],
  };

  const first = await openPrepaid(hub, T1, body, key);
  const second = await openPrepaid(hub, T1, body, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
  assert.equal(first.headers['idempotent-replayed'], 'false');
  assert.equal(second.headers['idempotent-replayed'], 'true');

  assert.equal(count(hub, 'SELECT id FROM table_sessions WHERE table_id = ?', tableId(hub, T1)), 1);
  assert.equal(count(hub, 'SELECT id FROM checks'), 1);
  assert.equal(paymentCount(hub), 2);
});

test('every prepaid step is audited and queued for the cloud', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const paid = await openPaid(hub, T1, 30, 1000_00, [{ method: 'CASH', amount: 1000_00 }]);
  const timed = await openTimed(hub, T2, 30);
  const until = Math.max(untilOf(paid.live), untilOf(timed));

  advanceTo(h, until - 5 * MINUTE);
  sync(hub);
  await waitFor(() => hub.driver.blinkCount('relay-1') + hub.driver.blinkCount('relay-2') === 2);
  advanceTo(h, until);
  sync(hub);
  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF' && tableState(hub, T2).lamp.reported === 'OFF');
  assert.equal(sessionStatus(hub, paid.session.id), 'CLOSED');
  assert.equal(sessionStatus(hub, timed.id), 'AWAITING_PAYMENT');

  const check = await send<CheckView>(hub, '/api/checks', { sessionIds: [timed.id] });
  assert.equal(check.status, 201);
  assert.equal(check.body.total, 1000_00);
  const payRes = await send<PayResponse>(hub, `/api/checks/${check.body.id}/pay`, {
    parts: [{ method: 'CASH', amount: 1000_00 }],
  });
  assert.equal(payRes.status, 200);
  assert.equal(sessionStatus(hub, timed.id), 'CLOSED');
  assert.equal((await closeShift(hub, shift.id, 3000_00)).status, 200);

  const prepaidRows = all<{ entity_id: string; data: string }>(
    hub.db,
    "SELECT entity_id, data FROM audit_log WHERE action LIKE 'session.prepaid%'",
  );
  for (const id of [paid.session.id, timed.id]) {
    assert.ok(
      prepaidRows.some((r) => r.entity_id === id || r.data.includes(id)),
      `a session.prepaid* record for ${id}`,
    );
  }
  assert.equal(count(hub, 'SELECT id FROM outbox'), count(hub, 'SELECT id FROM audit_log'));
});

// ─── Pauses, transfers, manual mode, early stops ─────────────────────────────

const MANAGER = 'Управляющий Ерлан';

test('a pause moves the deadline: 30 prepaid minutes with a 10-minute pause end at +40', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);
  assert.equal(until, MONDAY_NOON + 30 * MINUTE);

  advanceTo(h, MONDAY_NOON + 10 * MINUTE);
  assert.equal((await post(hub, `/api/sessions/${game.id}/pause`)).status, 200);
  assert.equal(tableState(hub, T1).session?.status, 'PAUSED');

  // While paused the clock passes the old deadline: nothing fires.
  advanceTo(h, until + MINUTE);
  sync(hub);
  assert.equal(tableState(hub, T1).session?.status, 'PAUSED');
  assert.deepEqual(blinkRows(hub, T1), []);

  advanceTo(h, MONDAY_NOON + 20 * MINUTE);
  assert.equal((await post(hub, `/api/sessions/${game.id}/resume`)).status, 200);
  await waitFor(() => tableState(hub, T1).session?.status === 'ACTIVE');
  assert.equal(tableState(hub, T1).session?.prepaid?.until, MONDAY_NOON + 40 * MINUTE);
  assert.ok(auditActions(hub).includes('session.prepaid_deadline_shifted'));

  // The warning counts from the new deadline.
  advanceTo(h, MONDAY_NOON + 35 * MINUTE);
  sync(hub);
  assert.equal(blinkRows(hub, T1).length, 1);

  advanceTo(h, MONDAY_NOON + 40 * MINUTE - 1);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'ACTIVE');
  advanceTo(h, MONDAY_NOON + 40 * MINUTE);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  const stopped = await unpaidView(hub, game.id);
  assert.equal(stopped?.stoppedAt, MONDAY_NOON + 40 * MINUTE);
  assert.equal(stopped?.playedSeconds, 30 * 60);
  assert.equal(stopped?.pausedSeconds, 10 * 60);
  assert.equal(stopped?.amount, 1000_00);
  await waitFor(() => tableState(hub, T1).lamp.reported === 'OFF');
});

test('a power-loss pause of the HUB itself moves the deadline too', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);

  advanceTo(h, MONDAY_NOON + 10 * MINUTE);
  assert.deepEqual(hub.hub.sessions.pauseAll({ reason: 'power', now: h.clock.now() }), [game.id]);
  advanceTo(h, MONDAY_NOON + 25 * MINUTE);
  assert.deepEqual(hub.hub.sessions.resumeAll({ reason: 'power', now: h.clock.now() }), [game.id]);
  await waitFor(() => tableState(hub, T1).session?.status === 'ACTIVE');
  assert.equal(tableState(hub, T1).session?.prepaid?.until, MONDAY_NOON + 45 * MINUTE);

  advanceTo(h, MONDAY_NOON + 45 * MINUTE);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  const stopped = await unpaidView(hub, game.id);
  assert.equal(stopped?.playedSeconds, 30 * 60);
  assert.equal(stopped?.amount, 1000_00);
});

test('a transfer keeps the prepaid time; the warning blinks on the new table', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);

  advanceTo(h, MONDAY_NOON + 10 * MINUTE);
  hub.driver.latencyMs = 100; // the new lamp confirms "two minutes" later on the manual clock
  const moved = await post(hub, `/api/sessions/${game.id}/transfer`, { toTableId: tableId(hub, T2) });
  assert.equal(moved.status, 200);
  advanceTo(h, MONDAY_NOON + 12 * MINUTE);
  await waitFor(() => tableState(hub, T2).session?.status === 'ACTIVE');
  assert.equal(tableState(hub, T1).session, null);
  const live = tableState(hub, T2).session;
  assert.equal(live?.prepaid?.minutes, 30);
  assert.equal(live?.prepaid?.until, MONDAY_NOON + 32 * MINUTE);

  advanceTo(h, MONDAY_NOON + 27 * MINUTE);
  sync(hub);
  assert.deepEqual(blinkRows(hub, T1), []);
  assert.equal(blinkRows(hub, T2).length, 1);
  await waitFor(() => hub.driver.blinkCount('relay-2') === 1);

  advanceTo(h, MONDAY_NOON + 32 * MINUTE);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  const stopped = await unpaidView(hub, game.id);
  assert.equal(stopped?.stoppedAt, MONDAY_NOON + 32 * MINUTE);
  assert.equal(stopped?.playedSeconds, 30 * 60);
  await waitFor(() => tableState(hub, T2).lamp.reported === 'OFF');
});

test('manual mode: a timed game starts at the button press and ends at its deadline', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  assert.equal((await post(hub, '/api/lamps/manual', { enabled: true, reason: 'Контроллер не отвечает' })).status, 200);

  const res = await post(hub, `/api/tables/${tableId(hub, T1)}/open`, { prepaidMinutes: 30 });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'ACTIVE');
  assert.equal(res.body.manual, true);
  assert.equal(tableState(hub, T1).session?.prepaid?.until, MONDAY_NOON + 30 * MINUTE);

  // A manual-mode pause and resume shift the deadline the same way.
  advanceTo(h, MONDAY_NOON + 5 * MINUTE);
  assert.equal((await post(hub, `/api/sessions/${res.body.id}/pause`)).status, 200);
  advanceTo(h, MONDAY_NOON + 8 * MINUTE);
  assert.equal((await post(hub, `/api/sessions/${res.body.id}/resume`)).status, 200);
  assert.equal(tableState(hub, T1).session?.status, 'ACTIVE');
  assert.equal(tableState(hub, T1).session?.prepaid?.until, MONDAY_NOON + 33 * MINUTE);

  advanceTo(h, MONDAY_NOON + 33 * MINUTE);
  sync(hub);
  assert.equal(sessionStatus(hub, res.body.id), 'AWAITING_PAYMENT');
  assert.equal((await unpaidView(hub, res.body.id))?.playedSeconds, 30 * 60);
});

test('a timed game stopped or voided early leaves nothing for the deadline to fire', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const stoppedEarly = await openTimed(hub, T1, 30);
  const voided = await openTimed(hub, T2, 30);

  advanceTo(h, MONDAY_NOON + 10 * MINUTE);
  assert.equal((await post(hub, `/api/sessions/${stoppedEarly.id}/stop`)).status, 200);
  const cancel = await post(hub, `/api/sessions/${voided.id}/cancel`, { reason: 'Гости ушли', approvedBy: MANAGER });
  assert.equal(cancel.status, 200);
  assert.equal(sessionStatus(hub, voided.id), 'CANCELLED');

  // Past the warning window and the deadline: no blink, no second stop, the tables are free.
  advanceTo(h, MONDAY_NOON + 31 * MINUTE);
  sync(hub);
  assert.deepEqual(blinkRows(hub, T1), []);
  assert.deepEqual(blinkRows(hub, T2), []);
  assert.ok(!auditActions(hub).includes('session.prepaid_ended'));
  assert.equal(sessionStatus(hub, stoppedEarly.id), 'AWAITING_PAYMENT');
  assert.equal((await unpaidView(hub, stoppedEarly.id))?.stoppedAt, MONDAY_NOON + 10 * MINUTE);
  assert.equal(sessionStatus(hub, voided.id), 'CANCELLED');
  assert.equal(tableState(hub, T1).session, null);
  assert.equal(tableState(hub, T2).session, null);
  assert.equal((await post(hub, `/api/tables/${tableId(hub, T1)}/open`)).status, 201);
});
