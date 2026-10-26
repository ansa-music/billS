import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CheckView,
  ExtendPrepaidResponse,
  GuestLinksResponse,
  GuestPageView,
  GuestRequestView,
  HubState,
  OpenPrepaidResponse,
  PaymentMethod,
  SessionView,
  ShiftReport,
  ShiftView,
  StaffGuestRequestView,
} from '@bills/domain';
import { all, one } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, MONDAY_NOON, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

/**
 * «Продлить предоплаченную игру на N минут»: the deadline moves by N (pauses keep working),
 * the extra minutes cost what the tariff says after the current deadline; a game paid
 * upfront gets a line «Продление» on a check of its own (paid now with an open shift, or
 * left open for the cashier), a game paid after the stop is billed by played time as
 * always. A guest's «Продлить» is accepted the same way; an open-ended game has nothing
 * to extend — accepting it is an acknowledgement.
 */

const MIN = 60_000;
const T1 = 'Стол 1';
const T2 = 'Стол 2';

type ErrorBody = { error?: { code: string; message: string } };
type Part = { method: PaymentMethod; amount: number };

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function send<T>(hub: TestHub, url: string, body: object = {}, key: string = randomUUID(), actor?: string) {
  const res = await post(hub, url, body, key, actor);
  return { status: res.status, body: res.body as unknown as T & ErrorBody, headers: res.headers };
}

async function get<T>(hub: TestHub, url: string) {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code });
}

const extend = (hub: TestHub, sessionId: string, body: object, key: string = randomUUID(), actor?: string) =>
  send<ExtendPrepaidResponse>(hub, `/api/sessions/${sessionId}/extend`, body, key, actor);

async function openShift(hub: TestHub, openingFloat = 0): Promise<ShiftView> {
  const res = await send<ShiftView>(hub, '/api/shifts/open', { openingFloat });
  assert.equal(res.status, 201);
  return res.body;
}

/** A timed game, paid after the HUB stops it. */
async function openTimed(hub: TestHub, table: string, minutes: number): Promise<SessionView> {
  const res = await post(hub, `/api/tables/${tableId(hub, table)}/open`, { prepaidMinutes: minutes });
  assert.equal(res.status, 201);
  await waitFor(() => sessionStatus(hub, res.body.id) === 'ACTIVE');
  return live(hub, table);
}

/** A game paid upfront. */
async function openPaid(hub: TestHub, table: string, minutes: number, amount: number, parts: Part[]): Promise<OpenPrepaidResponse> {
  const res = await send<OpenPrepaidResponse>(hub, `/api/tables/${tableId(hub, table)}/open-prepaid`, { minutes, amount, parts });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await waitFor(() => sessionStatus(hub, res.body.session.id) === 'ACTIVE');
  return res.body;
}

function live(hub: TestHub, table: string): SessionView {
  const s = tableState(hub, table).session;
  assert.ok(s, `${table} has a game`);
  return s;
}

function untilOf(s: SessionView): number {
  const until = s.prepaid?.until;
  assert.ok(typeof until === 'number', 'deadline is set');
  return until;
}

function blinks(hub: TestHub, table: string): number {
  return all(hub.db, "SELECT id FROM lamp_commands WHERE table_id = ? AND action = 'BLINK'", tableId(hub, table)).length;
}

async function state(hub: TestHub): Promise<HubState> {
  return (await get<HubState>(hub, '/api/state')).body;
}

const sync = (hub: TestHub) => hub.hub.prepaid.sync();

// ─── The deadline ────────────────────────────────────────────────────────────

test('a timed game extended by 30 minutes ends 30 minutes later and is billed for the longer time', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);
  assert.equal(until, MONDAY_NOON + 30 * MIN);

  h.clock.set(MONDAY_NOON + 20 * MIN);
  const res = await extend(hub, game.id, { minutes: 30 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.extended, true);
  assert.equal(res.body.minutes, 30);
  assert.equal(res.body.price, 1000_00, '30 minutes at 2000/h');
  assert.equal(res.body.check, null, 'paid after the stop: no check yet');
  assert.equal(res.body.session.prepaid?.minutes, 60);
  assert.equal(res.body.session.prepaid?.until, until + 30 * MIN);
  assert.equal(untilOf(live(hub, T1)), until + 30 * MIN);
  assert.equal(all(hub.db, 'SELECT id FROM checks').length, 0);

  // The old deadline passes: nothing happens.
  h.clock.set(until + MIN);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'ACTIVE');

  h.clock.set(until + 30 * MIN);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
  const stopped = (await state(hub)).unpaid.find((s) => s.id === game.id);
  assert.equal(stopped?.playedSeconds, 60 * 60);
  assert.equal(stopped?.amount, 2000_00, 'the amount grows: an hour is billed');

  const row = one<{ minutes: number; extended_minutes: number }>(
    hub.db,
    'SELECT minutes, extended_minutes FROM prepaid_games WHERE session_id = ?',
    game.id,
  );
  assert.deepEqual({ ...row }, { minutes: 60, extended_minutes: 30 });
  assert.ok(auditActions(hub).includes('session.prepaid_extended'));
  const outbox = all<{ payload: string }>(hub.db, "SELECT payload FROM outbox WHERE topic = 'session.prepaid_extended'");
  assert.equal(outbox.length, 1);
  const data = (JSON.parse(outbox[0]!.payload) as { data: Record<string, unknown> }).data;
  assert.equal(data.minutes, 30);
  assert.equal(data.totalMinutes, 60);
  assert.equal(data.from, until);
  assert.equal(data.to, until + 30 * MIN);
  assert.equal(data.price, 1000_00);
});

test('after a pause the deadline still moves by exactly the extra minutes', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);

  h.clock.set(MONDAY_NOON + 10 * MIN);
  assert.equal((await post(hub, `/api/sessions/${game.id}/pause`)).status, 200);
  h.clock.set(MONDAY_NOON + 20 * MIN);
  assert.equal((await post(hub, `/api/sessions/${game.id}/resume`)).status, 200);
  await waitFor(() => tableState(hub, T1).session?.status === 'ACTIVE');
  assert.equal(untilOf(live(hub, T1)), MONDAY_NOON + 40 * MIN, '10 minutes of pause');

  const res = await extend(hub, game.id, { minutes: 30 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(untilOf(live(hub, T1)), MONDAY_NOON + 70 * MIN);

  // A pause after the extension keeps moving the new deadline.
  h.clock.set(MONDAY_NOON + 30 * MIN);
  assert.equal((await post(hub, `/api/sessions/${game.id}/pause`)).status, 200);
  const paused = await extend(hub, game.id, { minutes: 5 });
  assert.equal(paused.status, 200, 'a paused game can be extended too');
  h.clock.set(MONDAY_NOON + 35 * MIN);
  assert.equal((await post(hub, `/api/sessions/${game.id}/resume`)).status, 200);
  await waitFor(() => tableState(hub, T1).session?.status === 'ACTIVE');
  assert.equal(untilOf(live(hub, T1)), MONDAY_NOON + 80 * MIN);

  h.clock.set(MONDAY_NOON + 80 * MIN);
  sync(hub);
  const stopped = (await state(hub)).unpaid.find((s) => s.id === game.id);
  assert.equal(stopped?.playedSeconds, 65 * 60, '30 + 30 + 5 minutes of play');
  assert.equal(stopped?.pausedSeconds, 15 * 60);
});

test('the 5-minute blink is given again before the new end', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30);
  const until = untilOf(game);

  h.clock.set(until - 5 * MIN);
  sync(hub);
  assert.equal(blinks(hub, T1), 1);
  assert.equal(live(hub, T1).prepaid?.warnedAt, until - 5 * MIN);

  h.clock.set(until - 3 * MIN);
  const res = await extend(hub, game.id, { minutes: 30 });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.prepaid?.warnedAt, null, 'the warning re-arms');
  sync(hub);
  assert.equal(blinks(hub, T1), 1, 'no blink 33 minutes before the end');

  h.clock.set(until + 25 * MIN - 1);
  sync(hub);
  assert.equal(blinks(hub, T1), 1);
  h.clock.set(until + 25 * MIN);
  sync(hub);
  assert.equal(blinks(hub, T1), 2, 'blinks 5 minutes before the new deadline');
  h.clock.set(until + 30 * MIN);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'AWAITING_PAYMENT');
});

test('extra minutes cross a tariff boundary: day rate until 18:00, evening rate after', async (t) => {
  const h = harness(t);
  h.clock.set(MONDAY_NOON + 5 * 60 * MIN + 15 * MIN); // 17:15 in Almaty
  const hub = await h.start();
  const game = await openTimed(hub, T1, 30); // until 17:45

  assertError(await extend(hub, game.id, { minutes: 30, amount: 1000_00 }), 409, 'PREPAID_PRICE_CHANGED');
  assert.equal(live(hub, T1).prepaid?.minutes, 30, 'a refused extension changes nothing');
  const res = await extend(hub, game.id, { minutes: 30, amount: 1250_00 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.price, 1250_00, '15 min × 2000/h + 15 min × 3000/h');
});

test('extra minutes are whole minutes from 5; a game stays within 12 hours', async (t) => {
  const hub = await harness(t).start();
  const game = await openTimed(hub, T1, 600);
  for (const minutes of [0, 4]) assertError(await extend(hub, game.id, { minutes }), 422, 'INVALID_PREPAID_MINUTES');
  assertError(await extend(hub, game.id, { minutes: 121 }), 422, 'PREPAID_TOO_LONG');
  assert.equal((await extend(hub, game.id, { minutes: 120 })).status, 200);
  assert.equal(live(hub, T1).prepaid?.minutes, 720);
});

test('only a running game can be extended', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 60_000 }));
  const opening = await post(hub, `/api/tables/${tableId(hub, T1)}/open`, { prepaidMinutes: 30 });
  assertError(await extend(hub, opening.body.id, { minutes: 30 }), 409, 'SESSION_NOT_STARTED');
  assertError(await extend(hub, randomUUID(), { minutes: 30 }), 404, 'SESSION_NOT_FOUND');
});

test('a game stopped already cannot be extended', async (t) => {
  const hub = await harness(t).start();
  const game = await openTimed(hub, T1, 30);
  assert.equal((await post(hub, `/api/sessions/${game.id}/stop`)).status, 200);
  assertError(await extend(hub, game.id, { minutes: 30 }), 409, 'SESSION_NOT_LIVE');
});

// ─── Money ───────────────────────────────────────────────────────────────────

test('a game paid upfront: the extension is a line «Продление» on a check of its own, paid right away', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 0);
  const paid = await openPaid(hub, T1, 60, 2000_00, [{ method: 'CASH', amount: 2000_00 }]);
  const game = live(hub, T1);
  const until = untilOf(game);

  h.clock.set(MONDAY_NOON + 50 * MIN);
  const res = await extend(hub, game.id, { minutes: 30, amount: 1000_00, parts: [{ method: 'CASH', amount: 1500_00 }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, 1000_00);
  assert.equal(res.body.change, 500_00);
  const check = res.body.check!;
  assert.notEqual(check.id, paid.check.id, 'the prepaid check is PAID and stays as it was');
  assert.equal(check.status, 'PAID');
  assert.equal(check.number, paid.check.number + 1);
  assert.deepEqual(
    check.items.map((i) => [i.kind, i.sessionId, i.tableId, i.amount, i.title]),
    [['EXTENSION', game.id, tableId(hub, T1), 1000_00, 'Продление 30 мин · Стол 1']],
  );
  assert.deepEqual([check.subtotal, check.total, check.paid, check.due], [1000_00, 1000_00, 1000_00, 0]);
  assert.equal(res.body.session.prepaid?.amount, 3000_00, 'the prepaid time now costs 3000');
  assert.equal(res.body.session.prepaid?.checkId, paid.check.id);
  assert.equal(untilOf(live(hub, T1)), until + 30 * MIN);

  const prepaidCheck = (await get<CheckView>(hub, `/api/checks/${paid.check.id}`)).body;
  assert.deepEqual([prepaidCheck.status, prepaidCheck.total], ['PAID', 2000_00]);

  const report = (await get<ShiftReport>(hub, `/api/shifts/${shift.id}/report`)).body;
  assert.deepEqual(
    { cash: report.sales.CASH, total: report.sales.total, checks: report.checksPaid, expected: report.expectedCash },
    { cash: 3000_00, total: 3000_00, checks: 2, expected: 3000_00 },
  );

  // At the new deadline the game closes with the whole prepaid amount: nothing more to pay.
  h.clock.set(until + 30 * MIN);
  sync(hub);
  assert.equal(sessionStatus(hub, game.id), 'CLOSED');
  const closed = one<{ amount: number }>(hub.db, 'SELECT amount FROM table_sessions WHERE id = ?', game.id);
  assert.equal(closed?.amount, 3000_00);
  const s = await state(hub);
  assert.deepEqual([s.unpaid.length, s.checks.length], [0, 0]);
});

test('an extension not paid right away waits on an open check; a second one joins it', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const shift = await openShift(hub, 0);
  await openPaid(hub, T1, 60, 2000_00, [{ method: 'CARD', amount: 2000_00 }]);
  const game = live(hub, T1);

  const first = await extend(hub, game.id, { minutes: 30 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const check = first.body.check!;
  assert.deepEqual([check.status, check.due], ['OPEN', 1000_00]);

  const second = await extend(hub, game.id, { minutes: 60 });
  assert.equal(second.status, 200);
  assert.equal(second.body.check?.id, check.id, 'the open check of this game');
  assert.deepEqual(
    second.body.check?.items.map((i) => [i.kind, i.amount]),
    [
      ['EXTENSION', 1000_00],
      ['EXTENSION', 2000_00],
    ],
  );
  assert.deepEqual([second.body.check?.total, second.body.check?.due], [3000_00, 3000_00]);
  assert.equal(live(hub, T1).prepaid?.minutes, 150);

  // The minutes are on the game already: the line cannot be dropped to make them free.
  const line = second.body.check!.items[0]!;
  assertError(await send(hub, `/api/checks/${check.id}/items/${line.id}/remove`), 409, 'EXTENSION_LINE_LOCKED');

  // An open check blocks closing the shift, like any unpaid check.
  assertError(await send(hub, `/api/shifts/${shift.id}/close`, { countedCash: 0 }), 409, 'UNPAID_CHECKS');
  const s = await state(hub);
  assert.deepEqual(
    s.checks.map((c) => c.id),
    [check.id],
  );

  const pay = await send<{ check: CheckView }>(hub, `/api/checks/${check.id}/pay`, { parts: [{ method: 'CASH', amount: 3000_00 }] });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.check.status, 'PAID');
  assert.equal(sessionStatus(hub, game.id), 'ACTIVE', 'paying the extension does not touch the running game');
});

test('paying right away needs an open shift; a refusal changes nothing', async (t) => {
  const hub = await harness(t).start();
  const shift = await openShift(hub, 0);
  await openPaid(hub, T1, 60, 2000_00, [{ method: 'CARD', amount: 2000_00 }]);
  const game = live(hub, T1);
  assert.equal((await send(hub, `/api/shifts/${shift.id}/close`, { countedCash: 0 })).status, 200);

  const res = await extend(hub, game.id, { minutes: 30, parts: [{ method: 'CASH', amount: 1000_00 }] });
  assertError(res, 409, 'SHIFT_NOT_OPEN');
  assertError(await extend(hub, game.id, { minutes: 30, parts: [{ method: 'CASH', amount: 500_00 }] }), 409, 'SHIFT_NOT_OPEN');
  assert.equal(live(hub, T1).prepaid?.minutes, 60);
  assert.equal(all(hub.db, 'SELECT id FROM checks').length, 1, 'only the prepaid check');

  // Without a payment no shift is needed: the line waits for the cashier.
  const later = await extend(hub, game.id, { minutes: 30 });
  assert.equal(later.status, 200);
  assert.equal(later.body.check?.status, 'OPEN');
});

test('paying right away must cover the whole extension', async (t) => {
  const hub = await harness(t).start();
  await openShift(hub, 0);
  await openPaid(hub, T1, 60, 2000_00, [{ method: 'CARD', amount: 2000_00 }]);
  const game = live(hub, T1);
  assertError(await extend(hub, game.id, { minutes: 30, parts: [{ method: 'CASH', amount: 500_00 }] }), 422, 'PREPAID_NOT_FULLY_PAID');
  assert.equal(live(hub, T1).prepaid?.minutes, 60);
  assert.equal(all(hub.db, 'SELECT id FROM payments').length, 1);
});

test('a game paid after the stop takes no payment for its extension', async (t) => {
  const hub = await harness(t).start();
  await openShift(hub, 0);
  const game = await openTimed(hub, T1, 30);
  assertError(await extend(hub, game.id, { minutes: 30, parts: [{ method: 'CASH', amount: 1000_00 }] }), 422, 'PREPAID_PAID_AFTER');
  assert.equal(live(hub, T1).prepaid?.minutes, 30);
});

test('a repeated extension with the same key extends and charges once', async (t) => {
  const hub = await harness(t).start();
  await openShift(hub, 0);
  await openPaid(hub, T1, 60, 2000_00, [{ method: 'CARD', amount: 2000_00 }]);
  const game = live(hub, T1);
  const until = untilOf(game);
  const key = randomUUID();
  const body = { minutes: 30, amount: 1000_00, parts: [{ method: 'CASH', amount: 1000_00 }] };

  const a = await extend(hub, game.id, body, key);
  const b = await extend(hub, game.id, body, key);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.deepEqual(b.body, a.body);
  assert.equal(untilOf(live(hub, T1)), until + 30 * MIN);
  assert.equal(all(hub.db, "SELECT id FROM check_items WHERE kind = 'EXTENSION'").length, 1);
  assert.equal(all(hub.db, 'SELECT id FROM payments').length, 2, 'the prepaid payment and one for the extension');
  assert.equal(auditActions(hub).filter((x) => x === 'session.prepaid_extended').length, 1);
});

test('an open-ended game has nothing to extend: the answer says so and nothing changes', async (t) => {
  const hub = await harness(t).start();
  const res = await post(hub, `/api/tables/${tableId(hub, T1)}/open`);
  await waitFor(() => sessionStatus(hub, res.body.id) === 'ACTIVE');
  const ext = await extend(hub, res.body.id, { minutes: 30 });
  assert.equal(ext.status, 200);
  assert.equal(ext.body.extended, false);
  assert.equal(ext.body.minutes, 0);
  assert.equal(ext.body.session.prepaid, null);
  assert.ok(!auditActions(hub).includes('session.prepaid_extended'));
  assert.equal(all(hub.db, 'SELECT session_id FROM prepaid_games').length, 0);
});

// ─── Who may extend ──────────────────────────────────────────────────────────

test('extending is for those who may sell prepaid time: a waiter may, a bartender may not', async (t) => {
  const h = harness(t);
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), { secure: true });
  hub.hub.staff.create({ name: 'Бармен Тимур', roles: ['bartender'], actor: 'Марат Управляющий' });
  const game = hub.hub.prepaid.open({ tableId: tableId(hub, T1), minutes: 30, actor: 'Марат Управляющий' });
  await waitFor(() => sessionStatus(hub, game.id) === 'ACTIVE');

  const login = async (name: string) => {
    const staff = hub.hub.staff.list().find((s) => s.name === name)!;
    const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
    return (res.json() as { token: string }).token;
  };
  const call = async (token: string) => {
    const res = await hub.app.inject({
      method: 'POST',
      url: `/api/sessions/${game.id}/extend`,
      payload: { minutes: 30 },
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    });
    return { status: res.statusCode, body: res.json() as ErrorBody };
  };
  assertError(await call(await login('Бармен Тимур')), 403, 'FORBIDDEN');
  assert.equal(tableState(hub, T1).session?.prepaid?.minutes, 30);
  assert.equal((await call(await login('Данияр Официант'))).status, 200);
  assert.equal(tableState(hub, T1).session?.prepaid?.minutes, 60);
});

// ─── The guest's «Продлить» ──────────────────────────────────────────────────

async function enableGuests(hub: TestHub): Promise<GuestLinksResponse> {
  const res = await send<GuestLinksResponse>(hub, '/api/guest-links/settings', { enabled: true });
  assert.equal(res.status, 200);
  return res.body;
}

function tokenOf(links: GuestLinksResponse, table: string): string {
  return links.links.find((l) => l.tableName === table)!.token;
}

async function guestAsks(hub: TestHub, token: string, body: object): Promise<GuestRequestView> {
  const res = await hub.app.inject({ method: 'POST', url: `/api/guest/${token}/requests`, payload: body, remoteAddress: '10.0.0.9' });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as GuestRequestView;
}

test('a guest asks for 30 more minutes of a prepaid game; staff accept and the page shows the new time', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const token = tokenOf(await enableGuests(hub), T1);
  await openShift(hub, 0);
  await openPaid(hub, T1, 60, 2000_00, [{ method: 'CARD', amount: 2000_00 }]);
  const game = live(hub, T1);
  const until = untilOf(game);

  h.clock.set(MONDAY_NOON + 45 * MIN);
  const before = (await get<GuestPageView>(hub, `/api/guest/${token}`)).body;
  assert.equal(before.table?.prepaid?.leftMs, 15 * MIN);
  const asked = await guestAsks(hub, token, { kind: 'EXTEND', minutes: 30 });

  const res = await send<{ request: StaffGuestRequestView; extension: ExtendPrepaidResponse }>(
    hub,
    `/api/guest-requests/${asked.id}/extend`,
    { amount: 1000_00, parts: [{ method: 'QR', amount: 1000_00 }] },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.request.status, 'ACCEPTED');
  assert.equal(res.body.extension.extended, true);
  assert.equal(res.body.extension.minutes, 30);
  assert.equal(res.body.extension.check?.status, 'PAID');
  assert.equal(untilOf(live(hub, T1)), until + 30 * MIN);

  const after = (await get<GuestPageView>(hub, `/api/guest/${token}`)).body;
  assert.equal(after.table?.prepaid?.minutes, 90);
  assert.equal(after.table?.prepaid?.until, until + 30 * MIN);
  assert.equal(after.table?.prepaid?.leftMs, 45 * MIN);
  assert.equal(after.requests.find((r) => r.id === asked.id)?.status, 'ACCEPTED');
  const accepted = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'guest.request_accepted'");
  assert.equal((JSON.parse(accepted[0]!.data) as { extendedMinutes?: number }).extendedMinutes, 30);

  // Accepted once: a second tap is refused, nothing is added twice.
  assertError(await send(hub, `/api/guest-requests/${asked.id}/extend`, {}), 409, 'GUEST_REQUEST_DONE');
  assert.equal(live(hub, T1).prepaid?.minutes, 90);
});

test('an unpaid extension of a paid game shows on the guest page as due', async (t) => {
  const hub = await harness(t).start();
  const token = tokenOf(await enableGuests(hub), T1);
  await openShift(hub, 0);
  await openPaid(hub, T1, 60, 2000_00, [{ method: 'CARD', amount: 2000_00 }]);
  const asked = await guestAsks(hub, token, { kind: 'EXTEND', minutes: 60 });
  const res = await send<{ extension: ExtendPrepaidResponse }>(hub, `/api/guest-requests/${asked.id}/extend`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.extension.check?.status, 'OPEN');
  const page = (await get<GuestPageView>(hub, `/api/guest/${token}`)).body;
  assert.equal(page.table?.prepaid?.minutes, 120);
  assert.equal(page.table?.total, 2000_00, 'the hour added waits for payment');
});

test('a guest «Продлить» at an open-ended game is just accepted: nothing to extend', async (t) => {
  const hub = await harness(t).start();
  const token = tokenOf(await enableGuests(hub), T2);
  const res = await post(hub, `/api/tables/${tableId(hub, T2)}/open`);
  await waitFor(() => sessionStatus(hub, res.body.id) === 'ACTIVE');
  const asked = await guestAsks(hub, token, { kind: 'EXTEND', minutes: 30 });

  const ext = await send<{ request: StaffGuestRequestView; extension: ExtendPrepaidResponse }>(hub, `/api/guest-requests/${asked.id}/extend`, {});
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  assert.equal(ext.body.request.status, 'ACCEPTED');
  assert.equal(ext.body.extension.extended, false);
  assert.equal(tableState(hub, T2).session?.prepaid, null);
  assert.ok(!auditActions(hub).includes('session.prepaid_extended'));

  // The plain «Принять» stays an acknowledgement as before.
  const again = await guestAsks(hub, token, { kind: 'EXTEND', minutes: 60 });
  const ack = await send<{ request: StaffGuestRequestView }>(hub, `/api/guest-requests/${again.id}/accept`);
  assert.equal(ack.status, 200);
  assert.equal(ack.body.request.status, 'ACCEPTED');
});

test('the guest route extends only EXTEND requests of a live game', async (t) => {
  const hub = await harness(t).start();
  const token = tokenOf(await enableGuests(hub), T1);
  const game = await openTimed(hub, T1, 30);
  const waiter = await guestAsks(hub, token, { kind: 'WAITER' });
  assertError(await send(hub, `/api/guest-requests/${waiter.id}/extend`, {}), 409, 'GUEST_NOT_EXTEND');

  const asked = await guestAsks(hub, token, { kind: 'EXTEND', minutes: 30 });
  assert.equal((await post(hub, `/api/sessions/${game.id}/stop`)).status, 200);
  assertError(await send(hub, `/api/guest-requests/${asked.id}/extend`, {}), 409, 'SESSION_NOT_LIVE');
  const row = one<{ status: string }>(hub.db, 'SELECT status FROM guest_requests WHERE id = ?', asked.id);
  assert.equal(row?.status, 'PENDING', 'a refused extension leaves the request pending');
});
