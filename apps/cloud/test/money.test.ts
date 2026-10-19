import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClubDetails, CloudSessionView, OwnerOverview, SyncEvent } from '@bills/domain';
import { clubIdOf, cloud, event, gameEvents, HOUR, HUB1, HUB2, login, MONDAY_NOON, ownerGet, sendEvents, tableIdOf } from './helpers.ts';

const MIN = 60_000;
const NOON = MONDAY_NOON;
const TODAY = '2026-10-12';

const hubEvent = (id: number, at: number, topic: string, data: Record<string, unknown>): SyncEvent =>
  event(id, at, topic, 'hub', data, { actor: 'system', entityType: 'hub' });

interface PaidGameOptions {
  checkId: string;
  shiftId: string;
  number: number;
  method?: 'CASH' | 'CARD' | 'QR';
  /** Emit shift.opened before the payment (once per shift). */
  openShift?: boolean;
}

/**
 * A game played, put on a check and paid in full in one go: open → started → stopped →
 * check.created → [shift.opened] → payment.accepted → session.closed → check.paid.
 * Money events happen at `stoppedAt`.
 */
function paidGame(firstId: number, sessionId: string, tableId: string, startedAt: number, stoppedAt: number, amount: number, o: PaidGameOptions): SyncEvent[] {
  const method = o.method ?? 'CASH';
  const events = [
    ...gameEvents(firstId, sessionId, tableId, startedAt, stoppedAt, amount),
    event(firstId + 3, stoppedAt, 'check.created', o.checkId, {
      number: o.number,
      items: [{ itemId: `${o.checkId}-i1`, sessionId, tableId, amount }],
    }),
  ];
  let id = firstId + 4;
  if (o.openShift) events.push(event(id++, stoppedAt, 'shift.opened', o.shiftId, { number: o.number, openingFloat: 10_000_00 }));
  events.push(
    event(id++, stoppedAt + 1000, 'payment.accepted', o.checkId, {
      number: o.number,
      shiftId: o.shiftId,
      operationId: `${o.checkId}-op1`,
      parts: [method === 'CASH' ? { method, amount, tendered: amount, change: 0 } : { method, amount, tendered: null, change: null }],
      applied: amount,
      change: 0,
      remaining: 0,
    }),
    event(id++, stoppedAt + 1000, 'session.closed', sessionId, { tableId, checkId: o.checkId }),
    event(id++, stoppedAt + 1000, 'check.paid', o.checkId, {
      number: o.number,
      shiftId: o.shiftId,
      subtotal: amount,
      discount: 0,
      total: amount,
      paid: amount,
      sessionIds: [sessionId],
    }),
  );
  return events;
}

/** Test 2's story: a 3000 ₸ game, 500 ₸ discount, CASH 1000 + CARD 1500, a 500 ₸ QR refund, cash in and out, Z report −200 ₸. */
function mixedShiftEvents(tableId: string): SyncEvent[] {
  const stop = NOON;
  return [
    ...gameEvents(1, 'g2', tableId, NOON - HOUR, stop, 3000_00),
    event(4, stop, 'check.created', 'chk-2', { number: 2, items: [{ itemId: 'i2', sessionId: 'g2', tableId, amount: 3000_00 }] }),
    event(5, stop + 1000, 'check.discount_set', 'chk-2', { kind: 'FIXED', value: 500_00, amount: 500_00, reason: 'Постоянный клиент', subtotal: 3000_00 }),
    event(6, stop + 2000, 'shift.opened', 'shift-2', { number: 2, openingFloat: 5000_00 }),
    event(7, stop + 3000, 'shift.cash_deposited', 'shift-2', { movementId: 'm1', amount: 1000_00, reason: 'размен' }),
    event(8, stop + 4000, 'payment.accepted', 'chk-2', {
      number: 2,
      shiftId: 'shift-2',
      operationId: 'op-2',
      parts: [
        { method: 'CASH', amount: 1000_00, tendered: 1500_00, change: 500_00 },
        { method: 'CARD', amount: 1500_00, tendered: null, change: null },
      ],
      applied: 2500_00,
      change: 500_00,
      remaining: 0,
    }),
    event(9, stop + 4000, 'session.closed', 'g2', { tableId, checkId: 'chk-2' }),
    event(10, stop + 4000, 'check.paid', 'chk-2', { number: 2, shiftId: 'shift-2', subtotal: 3000_00, discount: 500_00, total: 2500_00, paid: 2500_00, sessionIds: ['g2'] }),
    event(11, stop + 5000, 'payment.refunded', 'chk-2', { number: 2, shiftId: 'shift-2', method: 'QR', amount: 500_00, reason: 'Пересчёт', approvedBy: 'Менеджер' }),
    event(12, stop + 6000, 'shift.cash_withdrawn', 'shift-2', { movementId: 'm2', amount: 300_00, reason: 'инкассация' }),
    event(13, stop + 7000, 'shift.closed', 'shift-2', {
      number: 2,
      expectedCash: 6700_00,
      countedCash: 6500_00,
      difference: -200_00,
      note: 'не сошлось',
      net: { CASH: 1000_00, CARD: 1500_00, QR: -500_00, total: 2000_00 },
    }),
  ];
}

test('1. a paid game: CLOSED with paid_at and check, cash in daily_stats, revenue = billed = 2000', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 1');

  const res = await sendEvents(c, HUB1, paidGame(1, 'g1', tableId, NOON - HOUR, NOON, 2000_00, { checkId: 'chk-1', shiftId: 'shift-1', number: 1, openShift: true }));
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 8);

  const rows = await c.db.all<{ status: string; paid_at: number | null; check_id: string | null; stopped_by: string }>(
    'SELECT status, paid_at, check_id, stopped_by FROM sessions WHERE id = ?',
    ['g1'],
  );
  assert.deepEqual(rows, [{ status: 'CLOSED', paid_at: NOON + 1000, check_id: 'chk-1', stopped_by: 'Кассир' }]);
  const day = await c.db.all<{ day: string; revenue: number; paid_cash: number; paid_total: number; checks_paid: number }>(
    'SELECT day, revenue, paid_cash, paid_total, checks_paid FROM daily_stats WHERE club_id = ?',
    [clubId],
  );
  assert.deepEqual(day, [{ day: TODAY, revenue: 2000_00, paid_cash: 2000_00, paid_total: 2000_00, checks_paid: 1 }]);
  const checks = await c.db.all<{ status: string; number: number; paid: number; shift_id: string; closed_at: number }>(
    'SELECT status, number, paid, shift_id, closed_at FROM checks WHERE id = ?',
    ['chk-1'],
  );
  assert.deepEqual(checks, [{ status: 'PAID', number: 1, paid: 2000_00, shift_id: 'shift-1', closed_at: NOON + 1000 }]);

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  const club = ov.body.clubs.find((x) => x.id === clubId)!;
  assert.deepEqual(club.today, {
    revenue: 2000_00,
    billed: 2000_00,
    games: 1,
    playedSeconds: 3600,
    paid: { cash: 2000_00, card: 0, qr: 0, total: 2000_00 },
    refunded: 0,
    checksPaid: 1,
    discounts: 0,
    averageCheck: 2000_00,
    cancelledGames: 0,
  });
  assert.deepEqual(club.week, club.today);
  assert.equal(club.liveGames, 0);
  // The shift is still open: money from payments, no Z figures yet.
  assert.equal(club.lastClosedShift, null);
  assert.equal(club.openShift?.id, 'shift-1');
  assert.equal(club.openShift?.status, 'OPEN');
  assert.equal(club.openShift?.number, 1);
  assert.equal(club.openShift?.openedBy, 'Кассир');
  assert.equal(club.openShift?.openingFloat, 10_000_00);
  assert.deepEqual(club.openShift?.sales, { cash: 2000_00, card: 0, qr: 0, total: 2000_00 });
  assert.deepEqual(club.openShift?.net, { cash: 2000_00, card: 0, qr: 0, total: 2000_00 });
  assert.equal(club.openShift?.checksPaid, 1);
  assert.equal(club.openShift?.paymentsCount, 1);
  assert.equal(club.openShift?.refundsCount, 0);
  assert.equal(club.openShift?.expectedCash, null);
  assert.equal(club.openShift?.difference, null);
  assert.equal(club.openShift?.clubName, 'Клуб «Демо»');
  assert.deepEqual(ov.body.recentShifts, []);

  const sessions = await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`);
  assert.equal(sessions.body.length, 1);
  const v = sessions.body[0]!;
  assert.equal(v.status, 'CLOSED');
  assert.equal(v.checkId, 'chk-1');
  assert.equal(v.checkNumber, 1);
  assert.equal(v.paidAt, NOON + 1000);
  assert.equal(v.stoppedBy, 'Кассир');
  assert.equal(v.openedBy, 'Кассир');
  assert.equal(v.pausedSeconds, 0);
  assert.equal(v.pausedAt, null);
  assert.equal(v.pauseReason, null);
  assert.equal(v.cancelReason, null);
  assert.equal(v.prepaidMinutes, null);
  assert.equal(v.amount, 2000_00);
  const details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(details.body.days.at(-1)?.revenue, 2000_00);
  assert.equal(details.body.days.at(-1)?.checksPaid, 1);
  assert.deepEqual(details.body.days.at(-1)?.paid, { cash: 2000_00, card: 0, qr: 0, total: 2000_00 });
  assert.equal(details.body.shifts.length, 1);
  assert.equal(details.body.shifts[0]?.status, 'OPEN');
  assert.equal(details.body.recentSessions[0]?.checkNumber, 1);
});

test('2. mixed payment, discount, refund and a Z report with a −200 ₸ shortage', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 2');

  const res = await sendEvents(c, HUB1, mixedShiftEvents(tableId));
  assert.equal(res.body.inserted, 13);

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  const club = ov.body.clubs.find((x) => x.id === clubId)!;
  assert.deepEqual(club.today, {
    revenue: 2000_00,
    billed: 3000_00,
    games: 1,
    playedSeconds: 3600,
    paid: { cash: 1000_00, card: 1500_00, qr: 0, total: 2500_00 },
    refunded: 500_00,
    checksPaid: 1,
    discounts: 500_00,
    averageCheck: 2000_00,
    cancelledGames: 0,
  });
  assert.deepEqual(ov.body.totals.today, club.today);

  assert.equal(club.openShift, null);
  const shift = club.lastClosedShift!;
  assert.equal(shift.id, 'shift-2');
  assert.equal(shift.status, 'CLOSED');
  assert.equal(shift.number, 2);
  assert.equal(shift.clubName, 'Клуб «Демо»');
  assert.equal(shift.openedAt, NOON + 2000);
  assert.equal(shift.closedAt, NOON + 7000);
  assert.equal(shift.closedBy, 'Кассир');
  assert.equal(shift.openingFloat, 5000_00);
  assert.deepEqual(shift.sales, { cash: 1000_00, card: 1500_00, qr: 0, total: 2500_00 });
  assert.deepEqual(shift.refunds, { cash: 0, card: 0, qr: 500_00, total: 500_00 });
  // net comes from the HUB's Z report once closed.
  assert.deepEqual(shift.net, { cash: 1000_00, card: 1500_00, qr: -500_00, total: 2000_00 });
  assert.equal(shift.deposits, 1000_00);
  assert.equal(shift.withdrawals, 300_00);
  assert.equal(shift.expectedCash, 6700_00);
  assert.equal(shift.countedCash, 6500_00);
  assert.equal(shift.difference, -200_00);
  assert.equal(shift.note, 'не сошлось');
  assert.equal(shift.checksPaid, 1);
  assert.equal(shift.paymentsCount, 1); // one operation with two parts
  assert.equal(shift.refundsCount, 1);

  assert.equal(ov.body.recentShifts.length, 1);
  assert.deepEqual(ov.body.recentShifts[0], shift);

  const checks = await c.db.all<{ status: string; subtotal: number; discount: number; discount_reason: string; total: number; paid: number; refunded: number }>(
    'SELECT status, subtotal, discount, discount_reason, total, paid, refunded FROM checks WHERE id = ?',
    ['chk-2'],
  );
  assert.deepEqual(checks, [{ status: 'PAID', subtotal: 3000_00, discount: 500_00, discount_reason: 'Постоянный клиент', total: 2500_00, paid: 2500_00, refunded: 500_00 }]);
  const payments = await c.db.all<{ id: string; kind: string; method: string; amount: number; operation_id: string }>(
    'SELECT id, kind, method, amount, operation_id FROM payments ORDER BY at, id',
  );
  assert.deepEqual(payments, [
    { id: `${HUB1.id}:8:0`, kind: 'PAYMENT', method: 'CASH', amount: 1000_00, operation_id: 'op-2' },
    { id: `${HUB1.id}:8:1`, kind: 'PAYMENT', method: 'CARD', amount: 1500_00, operation_id: 'op-2' },
    { id: `${HUB1.id}:11`, kind: 'REFUND', method: 'QR', amount: 500_00, operation_id: `${HUB1.id}:11` },
  ]);

  const details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(details.body.shifts.length, 1);
  assert.equal(details.body.shifts[0]?.difference, -200_00);
  assert.equal(details.body.days.at(-1)?.discounts, 500_00);
  assert.equal(details.body.days.at(-1)?.refunded, 500_00);
});

test('3. a voided game: CANCELLED with reason and approver, billed taken out of the day, check VOID', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 3');

  await sendEvents(c, HUB1, [
    ...gameEvents(1, 'g3', tableId, NOON - HOUR, NOON, 2000_00),
    event(4, NOON, 'check.created', 'chk-3', { number: 3, items: [{ itemId: 'i3', sessionId: 'g3', tableId, amount: 2000_00 }] }),
  ]);
  let day = await c.db.all<{ revenue: number; games: number; cancelled_games: number }>('SELECT revenue, games, cancelled_games FROM daily_stats');
  assert.deepEqual(day, [{ revenue: 2000_00, games: 1, cancelled_games: 0 }]);
  let session = await c.db.all<{ check_id: string | null }>('SELECT check_id FROM sessions WHERE id = ?', ['g3']);
  assert.deepEqual(session, [{ check_id: 'chk-3' }]);

  await sendEvents(c, HUB1, [
    event(5, NOON + 5 * MIN, 'check.item_removed', 'chk-3', { sessionId: 'g3', amount: 2000_00, reason: 'GAME_CANCELLED' }),
    event(6, NOON + 5 * MIN, 'check.voided', 'chk-3', {}),
    event(7, NOON + 5 * MIN, 'session.voided', 'g3', { tableId, amount: 2000_00, checkId: 'chk-3', reason: 'Стол сломан', approvedBy: 'Менеджер' }),
  ]);

  const rows = await c.db.all<{ status: string; cancel_reason: string; cancel_approved_by: string; check_id: string | null; amount: number }>(
    'SELECT status, cancel_reason, cancel_approved_by, check_id, amount FROM sessions WHERE id = ?',
    ['g3'],
  );
  assert.deepEqual(rows, [{ status: 'CANCELLED', cancel_reason: 'Стол сломан', cancel_approved_by: 'Менеджер', check_id: null, amount: 2000_00 }]);
  day = await c.db.all<{ revenue: number; games: number; cancelled_games: number }>('SELECT revenue, games, cancelled_games FROM daily_stats');
  assert.deepEqual(day, [{ revenue: 0, games: 1, cancelled_games: 1 }]);
  const checks = await c.db.all<{ status: string; closed_at: number; subtotal: number }>('SELECT status, closed_at, subtotal FROM checks WHERE id = ?', ['chk-3']);
  assert.deepEqual(checks, [{ status: 'VOID', closed_at: NOON + 5 * MIN, subtotal: 0 }]);

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  const club = ov.body.clubs.find((x) => x.id === clubId)!;
  assert.equal(club.today.billed, 0);
  assert.equal(club.today.revenue, 0);
  assert.equal(club.today.cancelledGames, 1);
  assert.equal(club.today.games, 1);
  const sessions = await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`);
  assert.equal(sessions.body[0]?.status, 'CANCELLED');
  assert.equal(sessions.body[0]?.cancelReason, 'Стол сломан');
  assert.equal(sessions.body[0]?.cancelApprovedBy, 'Менеджер');
  assert.equal(sessions.body[0]?.checkId, null);
  const details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(details.body.days.at(-1)?.cancelledGames, 1);
  // A voided game is not table load.
  assert.equal(details.body.tables.find((x) => x.id === tableId)?.revenue, 0);
});

test('4. pause, transfer, resume, a power outage with auto-pause, stop with pausedSeconds', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const table1 = await tableIdOf(c, HUB1.id, 'Стол 1');
  const table2 = await tableIdOf(c, HUB1.id, 'Стол 2');
  const start = NOON - HOUR;

  await sendEvents(c, HUB1, [
    event(1, start - 1000, 'session.open_requested', 'g4', { tableId: table1, tariffId: 't', manual: false }),
    event(2, start, 'session.started', 'g4', { tableId: table1, startedAt: start }, { actor: 'system' }),
    event(3, start + 10 * MIN, 'session.paused', 'g4', { tableId: table1, pauseId: 'p1', pausedAt: start + 10 * MIN, pauseNumber: 1, lamp: 'off' }),
  ]);
  let view = (await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`)).body[0]!;
  assert.equal(view.status, 'PAUSED');
  assert.equal(view.pausedAt, start + 10 * MIN);
  assert.equal(view.pauseReason, 'pause');
  assert.equal(view.tableName, 'Стол 1');
  let ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.body.clubs.find((x) => x.id === clubId)?.liveGames, 1, 'a paused game is live');

  await sendEvents(c, HUB1, [
    event(4, start + 12 * MIN, 'session.transferred', 'g4', { fromTableId: table1, toTableId: table2, status: 'PAUSED', pauseId: 'p1', manual: false }),
    event(5, start + 20 * MIN, 'session.resume_requested', 'g4', { tableId: table2, pauseId: 'p1', pausedAt: start + 10 * MIN, manual: false }),
  ]);
  view = (await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`)).body[0]!;
  assert.equal(view.status, 'PAUSED', 'resume_requested keeps PAUSED until the lamp confirms');
  assert.equal(view.tableId, table2);
  assert.equal(view.tableName, 'Стол 2');

  await sendEvents(c, HUB1, [
    event(6, start + 20 * MIN + 500, 'session.resumed', 'g4', { tableId: table2, reason: 'pause', pausedAt: start + 10 * MIN, resumedAt: start + 20 * MIN, pausedSeconds: 600, manual: false }, { actor: 'system' }),
  ]);
  view = (await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`)).body[0]!;
  assert.equal(view.status, 'ACTIVE');
  assert.equal(view.pausedAt, null);
  assert.equal(view.pauseReason, null);

  // Mains go down at 12:50 for 5 minutes; the HUB pauses the game and resumes it afterwards.
  const outageAt = NOON - 10 * MIN;
  await sendEvents(c, HUB1, [
    hubEvent(7, outageAt, 'power.on_battery', { chargePercent: 80, runtimeSeconds: 1200, status: 'OB' }),
    event(8, outageAt, 'session.paused', 'g4', { tableId: table2, pauseId: 'p2', pausedAt: outageAt, reason: 'power', lamp: 'off' }, { actor: 'system' }),
    hubEvent(9, outageAt, 'power.auto_paused', { sessionIds: ['g4'] }),
    hubEvent(10, outageAt + 2 * MIN, 'power.critical', { chargePercent: 10, runtimeSeconds: 60, since: outageAt }),
  ]);
  view = (await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`)).body[0]!;
  assert.equal(view.status, 'PAUSED');
  assert.equal(view.pauseReason, 'power');
  assert.equal(view.pausedAt, outageAt);
  let outages = await c.db.all<{ id: string; started_at: number; ended_at: number | null; critical: number; paused_games: number }>('SELECT id, started_at, ended_at, critical, paused_games FROM power_outages');
  assert.deepEqual(outages, [{ id: `${HUB1.id}:7`, started_at: outageAt, ended_at: null, critical: 1, paused_games: 1 }]);

  const restoredAt = outageAt + 5 * MIN;
  await sendEvents(c, HUB1, [
    hubEvent(11, restoredAt, 'power.restored', { since: outageAt, outageMs: 5 * MIN, chargePercent: 12, critical: true }),
    event(12, restoredAt, 'session.resume_requested', 'g4', { tableId: table2, pauseId: 'p2', pausedAt: outageAt, reason: 'power', manual: false }, { actor: 'system' }),
    event(13, restoredAt, 'session.resumed', 'g4', { tableId: table2, reason: 'power', pausedAt: outageAt, resumedAt: restoredAt, pausedSeconds: 300, manual: false }, { actor: 'system' }),
    hubEvent(14, restoredAt, 'power.auto_resumed', { sessionIds: ['g4'] }),
    event(15, NOON, 'session.stopped', 'g4', {
      tableId: table2,
      startedAt: start,
      stoppedAt: NOON,
      stoppedWhilePaused: false,
      playedSeconds: 2700,
      pausedSeconds: 900,
      billedSeconds: 2700,
      amount: 1500_00,
      segments: [],
      pauses: [],
    }),
  ]);
  outages = await c.db.all('SELECT id, started_at, ended_at, critical, paused_games FROM power_outages');
  assert.deepEqual(outages, [{ id: `${HUB1.id}:7`, started_at: outageAt, ended_at: restoredAt, critical: 1, paused_games: 1 }]);
  const rows = await c.db.all<{ status: string; table_id: string; paused_seconds: number; played_seconds: number; amount: number; pause_started_at: number | null; pause_reason: string | null }>(
    'SELECT status, table_id, paused_seconds, played_seconds, amount, pause_started_at, pause_reason FROM sessions WHERE id = ?',
    ['g4'],
  );
  assert.deepEqual(rows, [{ status: 'AWAITING_PAYMENT', table_id: table2, paused_seconds: 900, played_seconds: 2700, amount: 1500_00, pause_started_at: null, pause_reason: null }]);
  const day = await c.db.all<{ power_outages: number; games: number }>('SELECT power_outages, games FROM daily_stats');
  assert.deepEqual(day, [{ power_outages: 1, games: 1 }]);

  view = (await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`)).body[0]!;
  assert.equal(view.status, 'AWAITING_PAYMENT');
  assert.equal(view.pausedSeconds, 900);
  assert.equal(view.billedSeconds, 2700);
  const details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.deepEqual(details.body.outages, [
    { id: `${HUB1.id}:7`, clubId, startedAt: outageAt, endedAt: restoredAt, critical: true, pausedGames: 1 },
  ]);
  ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.body.clubs.find((x) => x.id === clubId)?.liveGames, 0);
});

test('5. the same money batch twice: one payments row per part, sums not doubled, one shift', async (t) => {
  const c = await cloud(t);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 2');
  const batch = mixedShiftEvents(tableId);

  const first = await sendEvents(c, HUB1, [...batch, batch[7]!, batch[10]!]); // duplicates inside the batch too
  assert.equal(first.body.inserted, 13);
  const second = await sendEvents(c, HUB1, batch);
  assert.equal(second.body.inserted, 0);

  const payments = await c.db.all<{ c: number }>('SELECT COUNT(*) AS c FROM payments');
  assert.deepEqual(payments, [{ c: 3 }]);
  const checks = await c.db.all<{ paid: number; refunded: number; discount: number; subtotal: number }>('SELECT paid, refunded, discount, subtotal FROM checks');
  assert.deepEqual(checks, [{ paid: 2500_00, refunded: 500_00, discount: 500_00, subtotal: 3000_00 }]);
  const day = await c.db.all<{ paid_total: number; paid_cash: number; paid_card: number; refunded: number; checks_paid: number; discounts: number; revenue: number; games: number }>(
    'SELECT paid_total, paid_cash, paid_card, refunded, checks_paid, discounts, revenue, games FROM daily_stats',
  );
  assert.deepEqual(day, [{ paid_total: 2500_00, paid_cash: 1000_00, paid_card: 1500_00, refunded: 500_00, checks_paid: 1, discounts: 500_00, revenue: 3000_00, games: 1 }]);
  const shifts = await c.db.all<{ id: string; status: string; difference: number }>('SELECT id, status, difference FROM shifts');
  assert.deepEqual(shifts, [{ id: 'shift-2', status: 'CLOSED', difference: -200_00 }]);
  const movements = await c.db.all<{ c: number }>('SELECT COUNT(*) AS c FROM cash_movements');
  assert.deepEqual(movements, [{ c: 2 }]);
});

test('6. gaps: session.closed and check.paid without their earlier events still leave rows', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const tableId = await tableIdOf(c, HUB1.id, 'Стол 1');

  await sendEvents(c, HUB1, [
    event(1, NOON, 'session.closed', 'ghost', { tableId, checkId: 'chk-ghost' }),
    event(2, NOON, 'check.paid', 'chk-ghost', { number: 7, shiftId: 'shift-ghost', subtotal: 1200_00, discount: 0, total: 1200_00, paid: 1200_00, sessionIds: ['ghost'] }),
    // A payment on a check and a shift the cloud never saw created.
    event(3, NOON + 1000, 'payment.accepted', 'chk-late', {
      number: 8,
      shiftId: 'shift-late',
      operationId: 'op-late',
      parts: [{ method: 'QR', amount: 700_00, tendered: null, change: null }],
      applied: 700_00,
      change: 0,
      remaining: 0,
    }),
    event(4, NOON + 2000, 'shift.cash_withdrawn', 'shift-late', { movementId: 'm-late', amount: 100_00, reason: 'x' }),
    hubEvent(5, NOON + 3000, 'power.restored', { since: NOON + 1000, outageMs: 2000, chargePercent: 50, critical: false }),
  ]);

  const sessions = await c.db.all<{ id: string; status: string; check_id: string; paid_at: number; opened_by: string; requested_at: number }>(
    'SELECT id, status, check_id, paid_at, opened_by, requested_at FROM sessions',
  );
  assert.deepEqual(sessions, [{ id: 'ghost', status: 'CLOSED', check_id: 'chk-ghost', paid_at: NOON, opened_by: 'unknown', requested_at: NOON }]);
  const checks = await c.db.all<{ id: string; status: string; number: number; subtotal: number; paid: number; shift_id: string }>(
    'SELECT id, status, number, subtotal, paid, shift_id FROM checks ORDER BY id',
  );
  assert.deepEqual(checks, [
    { id: 'chk-ghost', status: 'PAID', number: 7, subtotal: 1200_00, paid: 1200_00, shift_id: 'shift-ghost' },
    { id: 'chk-late', status: 'OPEN', number: 8, subtotal: 0, paid: 700_00, shift_id: 'shift-late' },
  ]);
  const shifts = await c.db.all<{ id: string; status: string; number: number }>('SELECT id, status, number FROM shifts ORDER BY id');
  assert.deepEqual(shifts, [
    { id: 'shift-ghost', status: 'OPEN', number: 0 },
    { id: 'shift-late', status: 'OPEN', number: 0 },
  ]);
  const outages = await c.db.all<{ started_at: number; ended_at: number; critical: number }>('SELECT started_at, ended_at, critical FROM power_outages');
  assert.deepEqual(outages, [{ started_at: NOON + 1000, ended_at: NOON + 3000, critical: 0 }]);

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  const club = ov.body.clubs.find((x) => x.id === clubId)!;
  assert.equal(club.today.checksPaid, 1);
  assert.equal(club.today.revenue, 700_00);
  assert.deepEqual(club.today.paid, { cash: 0, card: 0, qr: 700_00, total: 700_00 });
  assert.equal(club.today.billed, 0);
  assert.equal(club.today.games, 0);
  const sessionsView = await ownerGet<CloudSessionView[]>(c, cookie, `/api/owner/clubs/${clubId}/sessions?day=${TODAY}`);
  assert.equal(sessionsView.body[0]?.checkNumber, 7);
  // Two open shifts: the newest opened one is "the" open shift.
  assert.equal(club.openShift?.id, 'shift-late');
  assert.equal(club.openShift?.withdrawals, 100_00);
  assert.deepEqual(club.openShift?.sales, { cash: 0, card: 0, qr: 700_00, total: 700_00 });
});

test('7. two clubs: overview totals add payments of both, recentShifts carries both club names', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const club1 = await clubIdOf(c, HUB1.id);
  const club2 = await clubIdOf(c, HUB2.id);
  const table1 = await tableIdOf(c, HUB1.id, 'Стол 1');
  const table2 = await tableIdOf(c, HUB2.id, 'Стол 3');

  await sendEvents(c, HUB1, [
    ...paidGame(1, 'a', table1, NOON - 2 * HOUR, NOON - HOUR, 2000_00, { checkId: 'chk-a', shiftId: 'shift-a', number: 1, openShift: true }),
    event(9, NOON - 30 * MIN, 'shift.closed', 'shift-a', { number: 1, expectedCash: 12_000_00, countedCash: 12_000_00, difference: 0, note: null, net: { CASH: 2000_00, CARD: 0, QR: 0, total: 2000_00 } }),
  ]);
  await sendEvents(c, HUB2, [
    ...paidGame(1, 'b', table2, NOON - 2 * HOUR, NOON - HOUR / 2, 4000_00, { checkId: 'chk-b', shiftId: 'shift-b', number: 1, method: 'CARD', openShift: true }),
    event(9, NOON - 10 * MIN, 'shift.closed', 'shift-b', { number: 1, expectedCash: 10_000_00, countedCash: 10_050_00, difference: 50_00, note: 'лишние', net: { CASH: 0, CARD: 4000_00, QR: 0, total: 4000_00 } }),
  ]);

  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  const s1 = ov.body.clubs.find((x) => x.id === club1)!;
  const s2 = ov.body.clubs.find((x) => x.id === club2)!;
  assert.equal(s1.today.revenue, 2000_00);
  assert.equal(s2.today.revenue, 4000_00);
  assert.deepEqual(ov.body.totals.today, {
    revenue: 6000_00,
    billed: 6000_00,
    games: 2,
    playedSeconds: 3600 + 5400,
    paid: { cash: 2000_00, card: 4000_00, qr: 0, total: 6000_00 },
    refunded: 0,
    checksPaid: 2,
    discounts: 0,
    averageCheck: 3000_00,
    cancelledGames: 0,
  });
  assert.deepEqual(ov.body.totals.week, ov.body.totals.today);
  assert.deepEqual(ov.body.totals.month, ov.body.totals.today);

  assert.deepEqual(
    ov.body.recentShifts.map((s) => [s.id, s.clubName, s.difference, s.net.total]),
    [
      ['shift-b', 'Клуб «Север»', 50_00, 4000_00],
      ['shift-a', 'Клуб «Демо»', 0, 2000_00],
    ],
  );
  assert.equal(s1.lastClosedShift?.id, 'shift-a');
  assert.equal(s2.lastClosedShift?.id, 'shift-b');
  assert.equal(s1.openShift, null);

  // Club pages stay isolated.
  const d1 = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${club1}`);
  assert.deepEqual(d1.body.shifts.map((s) => s.id), ['shift-a']);
  assert.equal(d1.body.club.today.paid.card, 0);
  const d2 = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${club2}`);
  assert.deepEqual(d2.body.shifts.map((s) => s.id), ['shift-b']);
  assert.equal(d2.body.shifts[0]?.sales.card, 4000_00);
});
