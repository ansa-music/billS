import { randomUUID } from 'node:crypto';
import type { CashMovementKind, CheckView, CloseShiftResponse, ShiftReport, ShiftView } from '@bills/domain';
import { assertCashAmount, assertCashAvailable, assertReason, cashDifference, shiftTotals } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { ShiftRow } from './views.ts';
import { cashMovements, loadChecksWhere, openShiftRow, shiftLedger, toShiftView } from './views.ts';

export interface OpenShiftInput {
  openingFloat: number;
  actor: string;
}

export interface CashMovementInput {
  shiftId: string;
  kind: CashMovementKind;
  amount: number;
  reason: string | undefined;
  actor: string;
}

export interface CloseShiftInput {
  shiftId: string;
  countedCash: number;
  note?: string | undefined;
  actor: string;
}

/** The club this HUB serves. */
export function clubId(db: Db): string {
  const club = one<{ id: string }>(db, 'SELECT id FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
  return club.id;
}

/** Money moves only while a cash shift is open. */
export function requireOpenShift(db: Db, club: string): ShiftRow {
  const shift = openShiftRow(db, club);
  if (!shift) throw new HubError(409, 'SHIFT_NOT_OPEN', 'Смена не открыта: откройте кассовую смену');
  return shift;
}

function loadShiftRow(db: Db, id: string): ShiftRow {
  const row = one<ShiftRow>(db, 'SELECT * FROM cash_shifts WHERE id = ?', id);
  if (!row) throw new HubError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена');
  return row;
}

function requireThisOpenShift(db: Db, id: string): ShiftRow {
  const row = loadShiftRow(db, id);
  if (row.status !== 'OPEN') throw new HubError(409, 'SHIFT_NOT_OPEN', `Смена №${row.number} уже закрыта`);
  return row;
}

/** Opening, cash in/out, X and Z reports, closing. Every command is one transaction. */
export class ShiftService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;

  constructor(deps: { db: Db; clock: Clock; events: HubEvents }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
  }

  open(input: OpenShiftInput): ShiftView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      assertCashAmount(input.openingFloat, true);
      const club = clubId(db);
      const current = openShiftRow(db, club);
      if (current) throw new HubError(409, 'SHIFT_ALREADY_OPEN', `Смена №${current.number} уже открыта`);
      const number =
        (one<{ n: number | null }>(db, 'SELECT MAX(number) AS n FROM cash_shifts WHERE club_id = ?', club)?.n ?? 0) + 1;
      const id = randomUUID();
      run(
        db,
        `INSERT INTO cash_shifts (id, club_id, number, status, opening_float, opened_at, opened_by)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?)`,
        id,
        club,
        number,
        input.openingFloat,
        now,
        input.actor,
      );
      record(db, now, {
        actor: input.actor,
        action: 'shift.opened',
        entityType: 'shift',
        entityId: id,
        data: { number, openingFloat: input.openingFloat },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'shift' }));
      return toShiftView(db, loadShiftRow(db, id));
    });
  }

  /** Cash put in (change, float top-up) or taken out (collection) — not sales. */
  moveCash(input: CashMovementInput): ShiftView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const shift = requireThisOpenShift(db, input.shiftId);
      assertCashAmount(input.amount);
      const reason = assertReason(input.reason, input.kind === 'DEPOSIT' ? 'причину внесения' : 'причину изъятия');
      if (input.kind === 'WITHDRAWAL') {
        assertCashAvailable(shiftTotals(shiftLedger(db, shift)).expectedCash, input.amount);
      }
      const id = randomUUID();
      run(
        db,
        'INSERT INTO cash_movements (id, shift_id, kind, amount, reason, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        shift.id,
        input.kind,
        input.amount,
        reason,
        now,
        input.actor,
      );
      record(db, now, {
        actor: input.actor,
        action: input.kind === 'DEPOSIT' ? 'shift.cash_deposited' : 'shift.cash_withdrawn',
        entityType: 'shift',
        entityId: shift.id,
        data: { movementId: id, amount: input.amount, reason },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'shift' }));
      return toShiftView(db, shift);
    });
  }

  /** X report while the shift is open; the Z report fixed at close afterwards. */
  report(shiftId: string): ShiftReport {
    const row = loadShiftRow(this.#db, shiftId);
    if (row.status === 'CLOSED' && row.z_report) return JSON.parse(row.z_report) as ShiftReport;
    return buildReport(this.#db, row, 'X', this.#clock.now(), null);
  }

  /** Checks with money in or out during the shift, newest first: where refunds start. */
  checks(shiftId: string): CheckView[] {
    loadShiftRow(this.#db, shiftId);
    return loadChecksWhere(
      this.#db,
      `c.id IN (SELECT check_id FROM payments WHERE shift_id = ?) OR c.closed_shift_id = ?
       ORDER BY c.number DESC`,
      shiftId,
      shiftId,
    );
  }

  close(input: CloseShiftInput): CloseShiftResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const shift = requireThisOpenShift(db, input.shiftId);
      assertCashAmount(input.countedCash, true);

      const unpaidGames =
        one<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM table_sessions s
           WHERE s.club_id = ? AND s.status = 'AWAITING_PAYMENT'
             AND NOT EXISTS (SELECT 1 FROM check_items ci WHERE ci.session_id = s.id)`,
          shift.club_id,
        )?.n ?? 0;
      const openChecks =
        one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM checks WHERE club_id = ? AND status = 'OPEN'", shift.club_id)
          ?.n ?? 0;
      if (unpaidGames + openChecks > 0) {
        throw new HubError(
          409,
          'UNPAID_CHECKS',
          `Нельзя закрыть смену: не оплачено счетов — ${unpaidGames + openChecks}. Примите оплату или отмените игры.`,
        );
      }

      const note = input.note?.trim().slice(0, 500) || null;
      const closed: ShiftRow = { ...shift, status: 'CLOSED', closed_at: now, closed_by: input.actor, close_note: note };
      const report = buildReport(db, closed, 'Z', now, input.countedCash);
      run(
        db,
        `UPDATE cash_shifts
         SET status = 'CLOSED', closed_at = ?, closed_by = ?, counted_cash = ?, expected_cash = ?, difference = ?,
             close_note = ?, z_report = ?
         WHERE id = ?`,
        now,
        input.actor,
        input.countedCash,
        report.expectedCash,
        report.difference,
        note,
        JSON.stringify(report),
        shift.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'shift.closed',
        entityType: 'shift',
        entityId: shift.id,
        data: {
          number: shift.number,
          expectedCash: report.expectedCash,
          countedCash: input.countedCash,
          difference: report.difference,
          note,
          net: report.net,
        },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'shift' }));
      return { shift: toShiftView(db, loadShiftRow(db, shift.id)), report };
    });
  }
}

function buildReport(db: Db, row: ShiftRow, kind: 'X' | 'Z', now: number, countedCash: number | null): ShiftReport {
  const totals = shiftTotals(shiftLedger(db, row));
  const paidChecks = loadChecksWhere(db, 'c.closed_shift_id = ?', row.id);
  const counts = one<{ payments: number; refunds: number }>(
    db,
    `SELECT COUNT(DISTINCT CASE WHEN kind = 'PAYMENT' THEN operation_id END) AS payments,
            COUNT(CASE WHEN kind = 'REFUND' THEN 1 END) AS refunds
     FROM payments WHERE shift_id = ?`,
    row.id,
  );
  const cancelledGames =
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM table_sessions
       WHERE club_id = ? AND cancel_reason IS NOT NULL AND cancelled_at >= ? AND cancelled_at <= ?`,
      row.club_id,
      row.opened_at,
      row.closed_at ?? now,
    )?.n ?? 0;
  return {
    ...totals,
    kind,
    shiftId: row.id,
    shiftNumber: row.number,
    generatedAt: now,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    countedCash,
    difference: countedCash === null ? null : cashDifference(countedCash, totals.expectedCash),
    note: row.close_note,
    checksPaid: paidChecks.length,
    paymentsCount: counts?.payments ?? 0,
    refundsCount: counts?.refunds ?? 0,
    discounts: paidChecks.reduce((s, c) => s + c.discountAmount, 0),
    cancelledGames,
    movements: cashMovements(db, row.id),
  };
}
