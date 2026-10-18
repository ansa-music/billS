import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CheckView,
  CloseShiftResponse,
  HubState,
  PaymentMethod,
  PayResponse,
  SessionView,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import { all } from '../src/db.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

const MINUTE = 60 * 1000;
const CASHIER = 'Кассир Айгерим';
const MANAGER = 'Управляющий Ерлан';

type ErrorBody = { error?: { code: string } };

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

/** Opens a table, lets the game run for `minutes` and stops it. */
async function playGame(hub: TestHub, h: Harness, table: string, minutes: number) {
  const opened = await post(hub, `/api/tables/${tableId(hub, table)}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(minutes * MINUTE);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.status, 200);
  return { id: opened.body.id, amount: stopped.body.amount as number };
}

async function openShift(hub: TestHub, openingFloat: number): Promise<ShiftView> {
  const res = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat });
  assert.equal(res.status, 201);
  return res.body;
}

async function createCheck(hub: TestHub, sessionIds: string[]): Promise<CheckView> {
  const res = await send<CheckView>(hub, '/api/checks', { sessionIds });
  assert.equal(res.status, 201);
  return res.body;
}

function pay(hub: TestHub, checkId: string, parts: Array<{ method: PaymentMethod; amount: number }>, key?: string) {
  return send<PayResponse>(hub, `/api/checks/${checkId}/pay`, { parts }, key);
}

function closeShift(hub: TestHub, shiftId: string, countedCash: number, note?: string) {
  return send<CloseShiftResponse>(hub, `/api/shifts/${shiftId}/close`, note === undefined ? { countedCash } : { countedCash, note });
}

async function report(hub: TestHub, shiftId: string): Promise<ShiftReport> {
  const res = await get<ShiftReport>(hub, `/api/shifts/${shiftId}/report`);
  assert.equal(res.status, 200);
  return res.body;
}

function paymentCount(hub: TestHub): number {
  return all(hub.db, 'SELECT id FROM payments').length;
}

function auditRows(hub: TestHub): Array<{ action: string; actor: string; data: string }> {
  return all<{ action: string; actor: string; data: string }>(
    hub.db,
    'SELECT action, actor, data FROM audit_log ORDER BY id',
  );
}

test('a shift opens with a float, takes deposits and withdrawals and closes with a count', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  assert.equal((await state(hub)).shift, null);

  const shift = await openShift(hub, 10000_00);
  assert.equal(shift.status, 'OPEN');
  assert.equal(shift.openingFloat, 10000_00);
  assert.equal(shift.expectedCash, 10000_00);
  assert.equal(shift.openedBy, CASHIER);
  assert.equal((await state(hub)).shift?.id, shift.id);
  assertError(await send(hub, '/api/shifts/open', { openingFloat: 5000_00 }), 409, 'SHIFT_ALREADY_OPEN');

  const cash = `/api/shifts/${shift.id}/cash`;
  const deposit = await send<ShiftView>(hub, cash, { kind: 'DEPOSIT', amount: 5000_00, reason: 'Размен из сейфа' });
  assert.equal(deposit.status, 200);
  assert.equal(deposit.body.expectedCash, 15000_00);
  const withdrawal = await send<ShiftView>(hub, cash, { kind: 'WITHDRAWAL', amount: 2000_00, reason: 'Инкассация' });
  assert.equal(withdrawal.status, 200);
  assert.equal(withdrawal.body.expectedCash, 13000_00);

  assertError(await send(hub, cash, { kind: 'WITHDRAWAL', amount: 13000_01, reason: 'Инкассация' }), 422, 'INSUFFICIENT_CASH');
  assertError(await send(hub, cash, { kind: 'DEPOSIT', amount: 100_00, reason: '   ' }), 422, 'REASON_REQUIRED');
  assertError(await send(hub, cash, { kind: 'DEPOSIT', amount: 100_00 }), 422, 'REASON_REQUIRED');

  const x = await report(hub, shift.id);
  assert.equal(x.kind, 'X');
  assert.equal(x.shiftId, shift.id);
  assert.equal(x.openingFloat, 10000_00);
  assert.equal(x.deposits, 5000_00);
  assert.equal(x.withdrawals, 2000_00);
  assert.equal(x.expectedCash, 13000_00);
  assert.equal(x.closedAt, null);
  assert.equal(x.note, null);
  assert.deepEqual(
    x.movements.map((m) => [m.kind, m.amount]),
    [
      ['DEPOSIT', 5000_00],
      ['WITHDRAWAL', 2000_00],
    ],
  );

  const closed = await closeShift(hub, shift.id, 12900_00, 'Не хватает 100 ₸');
  assert.equal(closed.status, 200);
  assert.equal(closed.body.shift.status, 'CLOSED');
  assert.equal(closed.body.shift.expectedCash, 13000_00);
  assert.equal(closed.body.shift.countedCash, 12900_00);
  assert.equal(closed.body.shift.difference, -100_00);
  const z = closed.body.report;
  assert.equal(z.kind, 'Z');
  assert.equal(z.expectedCash, 13000_00);
  assert.equal(z.countedCash, 12900_00);
  assert.equal(z.difference, -100_00);
  assert.equal(z.note, 'Не хватает 100 ₸');
  assert.deepEqual(await report(hub, shift.id), z);
  assert.equal((await state(hub)).shift, null);

  const next = await openShift(hub, 12900_00);
  assert.equal(next.number, shift.number + 1);
  assert.ok(auditActions(hub).filter((a) => a.startsWith('shift.')).length >= 5);
});

test('payments need an open shift', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await playGame(hub, h, 'Стол 1', 60);
  const check = await createCheck(hub, [game.id]);

  assertError(await pay(hub, check.id, [{ method: 'CASH', amount: 2000_00 }]), 409, 'SHIFT_NOT_OPEN');
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  assert.equal(paymentCount(hub), 0);

  await openShift(hub, 1000_00);
  const paid = await pay(hub, check.id, [{ method: 'CASH', amount: 2000_00 }]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.check.status, 'PAID');
  assert.equal(sessionStatus(hub, game.id), 'CLOSED');
});

test('a cash payment with change settles the check and closes the game', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 10000_00);
  const game = await playGame(hub, h, 'Стол 1', 60);
  assert.equal(game.amount, 2000_00);

  const check = await createCheck(hub, [game.id]);
  assert.equal(check.status, 'OPEN');
  assert.deepEqual(
    check.items.map((i) => [i.kind, i.sessionId, i.amount]),
    [['GAME', game.id, 2000_00]],
  );
  assert.equal(check.total, 2000_00);
  assert.equal(check.due, 2000_00);
  let s = await state(hub);
  assert.equal(s.unpaid.find((g) => g.id === game.id)?.checkId, check.id);
  assert.deepEqual(
    s.checks.map((c) => c.id),
    [check.id],
  );

  const paid = await pay(hub, check.id, [{ method: 'CASH', amount: 5000_00 }]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.change, 3000_00);
  assert.equal(paid.body.remaining, 0);
  assert.equal(paid.body.check.status, 'PAID');
  assert.equal(paid.body.check.due, 0);
  assert.equal(paid.body.check.paid, 2000_00);
  assert.deepEqual(
    paid.body.check.payments.map((p) => [p.kind, p.method, p.amount, p.tendered, p.change]),
    [['PAYMENT', 'CASH', 2000_00, 5000_00, 3000_00]],
  );
  assert.equal(sessionStatus(hub, game.id), 'CLOSED');

  s = await state(hub);
  assert.deepEqual(s.unpaid, []);
  assert.deepEqual(s.checks, []);
  assert.equal(s.shift?.expectedCash, 12000_00);

  const x = await report(hub, shift.id);
  assert.equal(x.sales.CASH, 2000_00);
  assert.equal(x.sales.total, 2000_00);
  assert.equal(x.expectedCash, 12000_00);
  assert.equal(x.checksPaid, 1);
  assert.equal(x.paymentsCount, 1);

  const checks = await get<CheckView[]>(hub, `/api/shifts/${shift.id}/checks`);
  assert.equal(checks.status, 200);
  assert.deepEqual(
    checks.body.map((c) => [c.id, c.status]),
    [[check.id, 'PAID']],
  );
});

test('a check can be paid in parts', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const check = await createCheck(hub, [game.id]);

  h.clock.advance(60_000);
  const first = await pay(hub, check.id, [{ method: 'CARD', amount: 500_00 }]);
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 500_00);
  assert.ok(first.body.check.updatedAt > check.updatedAt, 'a payment marks the check as changed');
  assert.equal(first.body.remaining, 1500_00);
  assert.equal(first.body.change, 0);
  assert.equal(first.body.check.status, 'OPEN');
  assert.equal(first.body.check.due, 1500_00);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  const s = await state(hub);
  assert.equal(s.checks.find((c) => c.id === check.id)?.due, 1500_00);
  assert.ok(s.unpaid.some((g) => g.id === game.id));

  const rest = await pay(hub, check.id, [{ method: 'CASH', amount: 1500_00 }]);
  assert.equal(rest.status, 200);
  assert.equal(rest.body.remaining, 0);
  assert.equal(rest.body.check.status, 'PAID');
  assert.equal(rest.body.check.paid, 2000_00);
  assert.equal(rest.body.check.due, 0);
  assert.equal(sessionStatus(hub, game.id), 'CLOSED');

  const x = await report(hub, shift.id);
  assert.deepEqual(
    { card: x.sales.CARD, cash: x.sales.CASH, payments: x.paymentsCount, checks: x.checksPaid },
    { card: 500_00, cash: 1500_00, payments: 2, checks: 1 },
  );
});

test('one payment can mix cash, card and QR', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const check = await createCheck(hub, [game.id]);

  assertError(await pay(hub, check.id, [{ method: 'CARD', amount: 2500_00 }]), 422, 'NON_CASH_OVERPAYMENT');
  assert.equal(paymentCount(hub), 0);
  assert.equal((await state(hub)).checks.find((c) => c.id === check.id)?.due, 2000_00);

  const paid = await pay(hub, check.id, [
    { method: 'CASH', amount: 1500_00 },
    { method: 'CARD', amount: 600_00 },
    { method: 'QR', amount: 400_00 },
  ]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.change, 500_00);
  assert.equal(paid.body.remaining, 0);
  assert.equal(paid.body.check.status, 'PAID');
  const parts = paid.body.check.payments;
  assert.deepEqual(
    parts.map((p) => [p.method, p.amount]).sort(),
    [
      ['CARD', 600_00],
      ['CASH', 1000_00],
      ['QR', 400_00],
    ],
  );
  assert.equal(new Set(parts.map((p) => p.operationId)).size, 1);

  const x = await report(hub, shift.id);
  assert.deepEqual(x.sales, { CASH: 1000_00, CARD: 600_00, QR: 400_00, total: 2000_00 });
  assert.equal(x.paymentsCount, 1);
  assert.equal(x.expectedCash, 2000_00);
});

test('one check for two games with a percent discount', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const a = await playGame(hub, h, 'Стол 1', 60);
  const b = await playGame(hub, h, 'Стол 2', 45);
  assert.deepEqual([a.amount, b.amount], [2000_00, 1500_00]);
  const check = await createCheck(hub, [a.id, b.id]);
  assert.equal(check.items.length, 2);
  assert.equal(check.subtotal, 3500_00);
  assert.equal(check.total, 3500_00);

  const url = `/api/checks/${check.id}/discount`;
  const reason = 'Постоянный гость';
  assertError(await send(hub, url, { discount: { kind: 'PERCENT', value: 10, reason: '  ' } }), 422, 'REASON_REQUIRED');
  assert.equal((await send(hub, url, { discount: { kind: 'PERCENT', value: 20, reason } })).status, 200);
  const removed = await send<CheckView>(hub, url, { discount: null });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.discount, null);
  assert.equal(removed.body.total, 3500_00);

  const discounted = await send<CheckView>(hub, url, { discount: { kind: 'PERCENT', value: 10, reason } });
  assert.equal(discounted.status, 200);
  const c = discounted.body;
  assert.deepEqual(
    { subtotal: c.subtotal, discountAmount: c.discountAmount, total: c.total, due: c.due },
    { subtotal: 3500_00, discountAmount: 350_00, total: 3150_00, due: 3150_00 },
  );
  assert.deepEqual(c.discount, { kind: 'PERCENT', value: 10, reason, by: CASHIER });

  const paid = await pay(hub, check.id, [{ method: 'CASH', amount: 3150_00 }]);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.change, 0);
  assert.equal(paid.body.check.status, 'PAID');
  assert.equal(sessionStatus(hub, a.id), 'CLOSED');
  assert.equal(sessionStatus(hub, b.id), 'CLOSED');

  const x = await report(hub, shift.id);
  assert.equal(x.discounts, 350_00);
  assert.equal(x.sales.CASH, 3150_00);
  assert.equal(x.checksPaid, 1);
});

test('a check holds only stopped games, each on one check at most', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const running = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, running.body.id) === 'ACTIVE');
  assertError(await send(hub, '/api/checks', { sessionIds: [running.body.id] }), 409, 'SESSION_NOT_PAYABLE');

  const a = await playGame(hub, h, 'Стол 2', 60);
  const b = await playGame(hub, h, 'Стол 3', 30);
  const check = await createCheck(hub, [a.id, b.id]);
  assert.equal(check.total, 3000_00);
  assertError(await send(hub, '/api/checks', { sessionIds: [b.id] }), 409, 'SESSION_IN_OTHER_CHECK');

  const itemB = check.items.find((i) => i.sessionId === b.id)!;
  const removed = await send<CheckView>(hub, `/api/checks/${check.id}/items/${itemB.id}/remove`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.status, 'OPEN');
  assert.equal(removed.body.total, 2000_00);
  assert.equal((await state(hub)).unpaid.find((g) => g.id === b.id)?.checkId, null);

  const added = await send<CheckView>(hub, `/api/checks/${check.id}/items`, { sessionId: b.id });
  assert.equal(added.status, 200);
  assert.equal(added.body.total, 3000_00);
  const discount = { kind: 'AMOUNT', value: 3000_01, reason: 'Ошибка ввода' };
  assertError(await send(hub, `/api/checks/${check.id}/discount`, { discount }), 422, 'DISCOUNT_EXCEEDS_TOTAL');

  await openShift(hub, 1000_00);
  assert.equal((await pay(hub, check.id, [{ method: 'CARD', amount: 1000_00 }])).status, 200);
  const itemNow = added.body.items.find((i) => i.sessionId === b.id)!;
  assertError(await send(hub, `/api/checks/${check.id}/items/${itemNow.id}/remove`), 409, 'CHECK_HAS_PAYMENTS');

  const c = await playGame(hub, h, 'Стол 4', 30);
  const single = await createCheck(hub, [c.id]);
  const emptied = await send<CheckView>(hub, `/api/checks/${single.id}/items/${single.items[0]!.id}/remove`);
  assert.equal(emptied.status, 200);
  assert.equal(emptied.body.status, 'VOID');
  const s = await state(hub);
  assert.ok(!s.checks.some((x) => x.id === single.id));
  assert.equal(s.unpaid.find((g) => g.id === c.id)?.checkId, null);
  assert.equal(sessionStatus(hub, c.id), 'AWAITING_PAYMENT');
});

test('the shift cannot close while a game or a check is unpaid', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const running = await post(hub, `/api/tables/${tableId(hub, 'Стол 3')}/open`);
  await waitFor(() => sessionStatus(hub, running.body.id) === 'ACTIVE');
  const game = await playGame(hub, h, 'Стол 1', 60);

  assertError(await closeShift(hub, shift.id, 1000_00), 409, 'UNPAID_CHECKS');
  assert.equal((await state(hub)).shift?.status, 'OPEN');

  const check = await createCheck(hub, [game.id]);
  assert.equal((await pay(hub, check.id, [{ method: 'CARD', amount: 500_00 }])).status, 200);
  assertError(await closeShift(hub, shift.id, 1000_00), 409, 'UNPAID_CHECKS');
  assert.equal((await report(hub, shift.id)).kind, 'X');

  assert.equal((await pay(hub, check.id, [{ method: 'CASH', amount: 1500_00 }])).status, 200);
  const closed = await closeShift(hub, shift.id, 2500_00);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.report.kind, 'Z');
  assert.equal(closed.body.report.difference, 0);
  assert.equal(sessionStatus(hub, running.body.id), 'ACTIVE'); // a running game does not block closing
});

test('a refund needs a reason and a manager and is limited to what was paid by that method', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const check = await createCheck(hub, [game.id]);
  const paid = await pay(hub, check.id, [
    { method: 'CASH', amount: 1000_00 },
    { method: 'CARD', amount: 1000_00 },
  ]);
  assert.equal(paid.status, 200);

  const refund = (body: object) => send<CheckView>(hub, `/api/checks/${check.id}/refund`, body);
  const reason = 'Стол не работал, гость недоволен';
  assertError(await refund({ method: 'CASH', amount: 500_00, approvedBy: MANAGER }), 422, 'REASON_REQUIRED');
  assertError(await refund({ method: 'CASH', amount: 500_00, reason: ' ', approvedBy: MANAGER }), 422, 'REASON_REQUIRED');
  assertError(await refund({ method: 'CASH', amount: 500_00, reason }), 422, 'APPROVAL_REQUIRED');
  assertError(await refund({ method: 'CASH', amount: 500_00, reason, approvedBy: '  ' }), 422, 'APPROVAL_REQUIRED');
  assertError(await refund({ method: 'CASH', amount: 1500_00, reason, approvedBy: MANAGER }), 422, 'REFUND_EXCEEDS_PAID');
  assertError(await refund({ method: 'QR', amount: 100_00, reason, approvedBy: MANAGER }), 422, 'REFUND_EXCEEDS_PAID');
  assert.equal(paymentCount(hub), 2);

  const refunded = await refund({ method: 'CASH', amount: 500_00, reason, approvedBy: MANAGER });
  assert.equal(refunded.status, 200);
  assert.equal(refunded.body.status, 'PAID');
  assert.equal(refunded.body.refunded, 500_00);
  const row = refunded.body.payments.find((p) => p.kind === 'REFUND');
  assert.deepEqual([row?.method, row?.amount, row?.reason, row?.approvedBy], ['CASH', 500_00, reason, MANAGER]);
  assert.equal((await state(hub)).shift?.expectedCash, 1500_00);

  const x = await report(hub, shift.id);
  assert.equal(x.refunds.CASH, 500_00);
  assert.equal(x.refunds.total, 500_00);
  assert.equal(x.net.CASH, 500_00);
  assert.equal(x.refundsCount, 1);
  assert.equal(x.expectedCash, 1500_00);
  const checks = await get<CheckView[]>(hub, `/api/shifts/${shift.id}/checks`);
  assert.ok(checks.body.some((c) => c.id === check.id && c.refunded === 500_00));

  const approved = auditRows(hub).filter((r) => r.data.includes(MANAGER));
  assert.ok(approved.length >= 1, 'the approver is in the audit');
  assert.ok(approved.every((r) => /^(check|payment)\./.test(r.action)), approved.map((r) => r.action).join(', '));

  assert.equal((await closeShift(hub, shift.id, 1500_00)).status, 200);
  assertError(await refund({ method: 'CARD', amount: 500_00, reason, approvedBy: MANAGER }), 409, 'SHIFT_NOT_OPEN');
});

test('a game is voided only with a reason and a manager, even while it runs', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const url = `/api/sessions/${game.id}/cancel`;
  const reason = 'Стол не работал';

  assertError(await send(hub, url, { reason: '', approvedBy: MANAGER }), 422, 'REASON_REQUIRED');
  assertError(await send(hub, url, { approvedBy: MANAGER }), 422, 'REASON_REQUIRED');
  assertError(await send(hub, url, { reason }), 422, 'APPROVAL_REQUIRED');
  assertError(await send(hub, url, { reason, approvedBy: ' ' }), 422, 'APPROVAL_REQUIRED');
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');

  const voided = await send<SessionView>(hub, url, { reason, approvedBy: MANAGER });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.status, 'CANCELLED');
  assert.equal(voided.body.cancelReason, reason);
  assert.equal(voided.body.cancelApprovedBy, MANAGER);
  assert.equal(sessionStatus(hub, game.id), 'CANCELLED');
  assert.ok(!(await state(hub)).unpaid.some((g) => g.id === game.id));

  const running = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  await waitFor(() => sessionStatus(hub, running.body.id) === 'ACTIVE');
  h.clock.advance(20 * MINUTE);
  const stopped = await send<SessionView>(hub, `/api/sessions/${running.body.id}/cancel`, {
    reason: 'Гости ушли сразу',
    approvedBy: MANAGER,
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'CANCELLED');
  await waitFor(() => tableState(hub, 'Стол 2').lamp.reported === 'OFF');
  assert.ok(!hub.driver.isOn('relay-2'));
  assert.equal(tableState(hub, 'Стол 2').session, null);
  assert.ok(!(await state(hub)).unpaid.some((g) => g.id === running.body.id));

  assert.equal((await report(hub, shift.id)).cancelledGames, 2);
  const approvals = auditRows(hub).filter((r) => r.action.startsWith('session.') && r.data.includes(MANAGER));
  assert.ok(approvals.length >= 2, 'both approvals are in the audit');
});

test('a game with money on its check cannot be voided; voided games do not block the shift', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const loose = await playGame(hub, h, 'Стол 1', 30);
  const voidMe = await playGame(hub, h, 'Стол 2', 30);
  const keep = await playGame(hub, h, 'Стол 3', 45);
  const partly = await playGame(hub, h, 'Стол 4', 60);
  const shared = await createCheck(hub, [voidMe.id, keep.id]);
  const started = await createCheck(hub, [partly.id]);
  assert.equal((await pay(hub, started.id, [{ method: 'CARD', amount: 500_00 }])).status, 200);

  const cancel = (id: string) =>
    send<SessionView>(hub, `/api/sessions/${id}/cancel`, { reason: 'Ошибка кассира', approvedBy: MANAGER });
  assertError(await cancel(partly.id), 409, 'CHECK_HAS_PAYMENTS');
  assert.equal(sessionStatus(hub, partly.id), 'AWAITING_PAYMENT');

  const voided = await cancel(voidMe.id);
  assert.equal(voided.status, 200);
  assert.equal(voided.body.status, 'CANCELLED');
  const left = (await state(hub)).checks.find((c) => c.id === shared.id);
  assert.deepEqual(
    left?.items.map((i) => i.sessionId),
    [keep.id],
  );
  assert.equal(left?.total, 1500_00);
  assert.equal((await cancel(loose.id)).status, 200);

  assertError(await closeShift(hub, shift.id, 1000_00), 409, 'UNPAID_CHECKS');
  assert.equal((await pay(hub, shared.id, [{ method: 'CASH', amount: 1500_00 }])).status, 200);
  assert.equal((await pay(hub, started.id, [{ method: 'CASH', amount: 1500_00 }])).status, 200);

  const closed = await closeShift(hub, shift.id, 4000_00);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.report.difference, 0);
  assert.equal(closed.body.report.cancelledGames, 2);
});

test('a repeated payment with the same key is taken once', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 1000_00);
  const game = await playGame(hub, h, 'Стол 1', 60);
  const check = await createCheck(hub, [game.id]);

  const key = randomUUID();
  const first = await pay(hub, check.id, [{ method: 'CASH', amount: 5000_00 }], key);
  const second = await pay(hub, check.id, [{ method: 'CASH', amount: 5000_00 }], key);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(first.headers['idempotent-replayed'], 'false');
  assert.equal(second.headers['idempotent-replayed'], 'true');

  assert.equal(paymentCount(hub), 1);
  assert.equal((await state(hub)).shift?.expectedCash, 3000_00);
  const x = await report(hub, shift.id);
  assert.equal(x.paymentsCount, 1);
  assert.equal(x.sales.CASH, 2000_00);
});

test('every money action is audited with its actor and queued for the cloud', async (t) => {
  const h = harness(t);
  const hub = await h.start();

  /** Runs one command and checks it succeeded and wrote an audit record with the given prefix. */
  async function step<T extends { status: number }>(prefix: RegExp, command: () => Promise<T>): Promise<T> {
    const before = auditActions(hub).length;
    const res = await command();
    assert.ok(res.status >= 200 && res.status < 300, `status ${res.status}`);
    const added = auditActions(hub).slice(before);
    assert.ok(added.some((a) => prefix.test(a)), `expected ${prefix} in [${added.join(', ')}]`);
    return res;
  }

  const money = /^(check|payment)\./;
  const shift = (await step(/^shift\./, () => send<ShiftView>(hub, '/api/shifts/open', { openingFloat: 1000_00 }))).body;
  await step(/^shift\./, () => send(hub, `/api/shifts/${shift.id}/cash`, { kind: 'DEPOSIT', amount: 500_00, reason: 'Размен' }));
  const game = await playGame(hub, h, 'Стол 1', 60);
  await waitFor(() => tableState(hub, 'Стол 1').lamp.reported === 'OFF');
  const check = (await step(money, () => send<CheckView>(hub, '/api/checks', { sessionIds: [game.id] }))).body;
  await step(money, () =>
    send(hub, `/api/checks/${check.id}/discount`, { discount: { kind: 'AMOUNT', value: 200_00, reason: 'Акция дня' } }),
  );
  await step(money, () => pay(hub, check.id, [{ method: 'CASH', amount: 1800_00 }]));
  await step(money, () =>
    send(hub, `/api/checks/${check.id}/refund`, { method: 'CASH', amount: 300_00, reason: 'Жалоба гостя', approvedBy: MANAGER }),
  );
  await step(/^shift\./, () => closeShift(hub, shift.id, 1000_00 + 500_00 + 1800_00 - 300_00));
  assert.equal(sessionStatus(hub, game.id), 'CLOSED');

  const rows = auditRows(hub).filter((r) => /^(shift|check|payment)\./.test(r.action));
  assert.ok(rows.length >= 7, `${rows.length} money records`);
  assert.ok(
    rows.every((r) => r.actor === CASHIER),
    rows.map((r) => `${r.action}:${r.actor}`).join(', '),
  );
  const audit = all(hub.db, 'SELECT id FROM audit_log').length;
  const outbox = all(hub.db, 'SELECT id FROM outbox').length;
  assert.equal(outbox, audit);
});
