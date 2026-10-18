import { randomUUID } from 'node:crypto';
import type { CheckView, DiscountKind, PaymentMethod, PaymentPart, PayResponse, SessionView } from '@bills/domain';
import {
  assertApprover,
  assertCashAvailable,
  assertReason,
  assertRefundable,
  BillingError,
  discountAmount,
  planPayment,
  shiftTotals,
} from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { SessionService } from './sessions.ts';
import { clubId, requireOpenShift } from './shifts.ts';
import type { PaymentRow, SessionRow } from './views.ts';
import { discountStep, loadCheck, loadSession, SESSION_SELECT, shiftLedger } from './views.ts';

export interface DiscountInput {
  kind: DiscountKind;
  value: number;
  reason?: string | undefined;
}

export interface RefundInput {
  checkId: string;
  method: PaymentMethod;
  amount: number;
  reason: string | undefined;
  approvedBy: string | undefined;
  actor: string;
}

export interface CancelGameInput {
  sessionId: string;
  reason: string | undefined;
  approvedBy: string | undefined;
  actor: string;
}

/** Guest checks: games on a check, discount, payments, refunds, voiding games. One transaction per command. */
export class CheckService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #sessions: SessionService;

  constructor(deps: { db: Db; clock: Clock; events: HubEvents; sessions: SessionService }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#sessions = deps.sessions;
  }

  get(checkId: string): CheckView {
    return loadCheck(this.#db, checkId);
  }

  /** Puts stopped games on a new check. No shift is needed until money moves. */
  create(input: { sessionIds: string[]; actor: string }): CheckView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      if (input.sessionIds.length === 0) throw new HubError(422, 'NO_GAMES', 'Выберите хотя бы одну игру');
      const club = clubId(db);
      const number =
        (one<{ n: number | null }>(db, 'SELECT MAX(number) AS n FROM checks WHERE club_id = ?', club)?.n ?? 0) + 1;
      const id = randomUUID();
      run(
        db,
        `INSERT INTO checks (id, club_id, number, status, created_at, created_by, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?)`,
        id,
        club,
        number,
        now,
        input.actor,
        now,
      );
      const items = input.sessionIds.map((sessionId) => this.#addGame(id, club, sessionId, now));
      record(db, now, {
        actor: input.actor,
        action: 'check.created',
        entityType: 'check',
        entityId: id,
        data: { number, items },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return loadCheck(db, id);
    });
  }

  /** A check for a game paid before it is played (prepaid time): the line is the prepaid price. */
  createPrepaid(input: { sessionId: string; amount: number; actor: string }): CheckView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = one<{ id: string; club_id: string; table_id: string; table_name: string }>(
        db,
        `SELECT s.id, s.club_id, s.table_id, t.name AS table_name
         FROM table_sessions s JOIN billiard_tables t ON t.id = s.table_id WHERE s.id = ?`,
        input.sessionId,
      );
      if (!s) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
      const number =
        (one<{ n: number | null }>(db, 'SELECT MAX(number) AS n FROM checks WHERE club_id = ?', s.club_id)?.n ?? 0) + 1;
      const id = randomUUID();
      run(
        db,
        `INSERT INTO checks (id, club_id, number, status, created_at, created_by, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?)`,
        id,
        s.club_id,
        number,
        now,
        input.actor,
        now,
      );
      const itemId = randomUUID();
      run(
        db,
        `INSERT INTO check_items (id, check_id, kind, session_id, title, amount, created_at)
         VALUES (?, ?, 'GAME', ?, ?, ?, ?)`,
        itemId,
        id,
        s.id,
        s.table_name,
        input.amount,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'check.created',
        entityType: 'check',
        entityId: id,
        data: { number, prepaid: true, items: [{ itemId, sessionId: s.id, tableId: s.table_id, amount: input.amount }] },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return loadCheck(db, id);
    });
  }

  addGame(input: { checkId: string; sessionId: string; actor: string }): CheckView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const check = this.#openCheck(input.checkId);
      const item = this.#addGame(check.id, check.club_id, input.sessionId, now);
      this.#assertTotals(check.id);
      this.#touch(check.id, now);
      record(db, now, {
        actor: input.actor,
        action: 'check.item_added',
        entityType: 'check',
        entityId: check.id,
        data: item,
      });
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return loadCheck(db, check.id);
    });
  }

  /** Takes a game off a check that has no money on it yet. An emptied check becomes VOID. */
  removeItem(input: { checkId: string; itemId: string; actor: string }): CheckView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const check = this.#openCheck(input.checkId);
      const item = one<{ id: string; session_id: string | null; amount: number }>(
        db,
        'SELECT id, session_id, amount FROM check_items WHERE id = ? AND check_id = ?',
        input.itemId,
        check.id,
      );
      if (!item) throw new HubError(404, 'ITEM_NOT_FOUND', 'Строки нет в этом счёте');
      this.#assertNoMoney(check.id);
      run(db, 'DELETE FROM check_items WHERE id = ?', item.id);
      this.#touch(check.id, now);
      record(db, now, {
        actor: input.actor,
        action: 'check.item_removed',
        entityType: 'check',
        entityId: check.id,
        data: { itemId: item.id, sessionId: item.session_id, amount: item.amount },
      });
      this.#voidIfEmpty(check.id, input.actor, now);
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return loadCheck(db, check.id);
    });
  }

  setDiscount(input: { checkId: string; discount: DiscountInput | null; actor: string }): CheckView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const check = this.#openCheck(input.checkId);
      const d = input.discount;
      if (d === null) {
        run(
          db,
          `UPDATE checks SET discount_kind = NULL, discount_value = NULL, discount_reason = NULL, discount_by = NULL,
             updated_at = ? WHERE id = ?`,
          now,
          check.id,
        );
        record(db, now, {
          actor: input.actor,
          action: 'check.discount_removed',
          entityType: 'check',
          entityId: check.id,
          data: {},
        });
      } else {
        const reason = assertReason(d.reason, 'причину скидки');
        const before = loadCheck(db, check.id);
        const amount = discountAmount(before.subtotal, { kind: d.kind, value: d.value }, discountStep(check.currency));
        if (before.subtotal - amount < before.paid - before.refunded) {
          throw new BillingError('DISCOUNT_BELOW_PAID', 'После скидки счёт будет меньше уже оплаченного');
        }
        run(
          db,
          `UPDATE checks SET discount_kind = ?, discount_value = ?, discount_reason = ?, discount_by = ?, updated_at = ?
           WHERE id = ?`,
          d.kind,
          d.value,
          reason,
          input.actor,
          now,
          check.id,
        );
        record(db, now, {
          actor: input.actor,
          action: 'check.discount_set',
          entityType: 'check',
          entityId: check.id,
          data: { kind: d.kind, value: d.value, amount, reason, subtotal: before.subtotal },
        });
      }
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return loadCheck(db, check.id);
    });
  }

  /**
   * Takes money for a check: one or several methods at once, the whole due or a part.
   * When nothing is left to pay the check is PAID and its games CLOSED.
   */
  pay(input: { checkId: string; parts: PaymentPart[]; actor: string }): PayResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const check = this.#openCheck(input.checkId);
      const shift = requireOpenShift(db, check.club_id);
      const before = loadCheck(db, check.id);
      const plan = planPayment(before.due, input.parts);

      const operationId = randomUUID();
      for (const part of plan.parts) {
        run(
          db,
          `INSERT INTO payments
             (id, club_id, check_id, shift_id, operation_id, kind, method, amount, tendered, change, at, actor)
           VALUES (?, ?, ?, ?, ?, 'PAYMENT', ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          check.club_id,
          check.id,
          shift.id,
          operationId,
          part.method,
          part.amount,
          part.tendered,
          part.change,
          now,
          input.actor,
        );
      }
      if (plan.parts.length > 0) {
        record(db, now, {
          actor: input.actor,
          action: 'payment.accepted',
          entityType: 'check',
          entityId: check.id,
          data: {
            number: check.number,
            shiftId: shift.id,
            operationId,
            parts: plan.parts,
            applied: plan.applied,
            change: plan.change,
            remaining: plan.remaining,
          },
        });
      }
      if (plan.remaining === 0) this.#settle(check.id, check.number, shift.id, input.actor, now);
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      this.#touch(check.id, now);
      return { check: loadCheck(db, check.id), applied: plan.applied, change: plan.change, remaining: plan.remaining };
    });
  }

  /** Money back to the guest: needs a reason and a manager, never more than was paid by that method. */
  refund(input: RefundInput): CheckView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const check = this.#checkRow(input.checkId);
      const shift = requireOpenShift(db, check.club_id);
      const reason = assertReason(input.reason, 'причину возврата');
      const approvedBy = assertApprover(input.approvedBy);
      const entries = all<PaymentRow>(db, 'SELECT * FROM payments WHERE check_id = ?', check.id);
      assertRefundable(entries, input.method, input.amount);
      if (input.method === 'CASH') assertCashAvailable(shiftTotals(shiftLedger(db, shift)).expectedCash, input.amount);

      const id = randomUUID();
      run(
        db,
        `INSERT INTO payments
           (id, club_id, check_id, shift_id, operation_id, kind, method, amount, reason, approved_by, at, actor)
         VALUES (?, ?, ?, ?, ?, 'REFUND', ?, ?, ?, ?, ?, ?)`,
        id,
        check.club_id,
        check.id,
        shift.id,
        id,
        input.method,
        input.amount,
        reason,
        approvedBy,
        now,
        input.actor,
      );
      record(db, now, {
        actor: input.actor,
        action: 'payment.refunded',
        entityType: 'check',
        entityId: check.id,
        data: { number: check.number, shiftId: shift.id, method: input.method, amount: input.amount, reason, approvedBy },
      });
      this.#touch(check.id, now);
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return loadCheck(db, check.id);
    });
  }

  /**
   * Voids a game so it is not paid: needs a reason and a manager. A running game is
   * stopped first (lamp off). A game on a check with money on it needs a refund first.
   */
  cancelGame(input: CancelGameInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const reason = assertReason(input.reason, 'причину отмены');
      const approvedBy = assertApprover(input.approvedBy);
      let s = one<SessionRow>(db, `${SESSION_SELECT} WHERE s.id = ?`, input.sessionId);
      if (!s) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
      if (s.status === 'ACTIVE') {
        this.#sessions.stop({ sessionId: s.id, actor: input.actor });
        s = one<SessionRow>(db, `${SESSION_SELECT} WHERE s.id = ?`, input.sessionId)!;
      }
      if (s.status !== 'AWAITING_PAYMENT') {
        throw new HubError(409, 'SESSION_NOT_CANCELLABLE', 'Отменить можно только идущую или неоплаченную игру');
      }

      if (s.check_id) {
        this.#assertNoMoney(s.check_id);
        run(db, 'DELETE FROM check_items WHERE session_id = ?', s.id);
        this.#touch(s.check_id, now);
        record(db, now, {
          actor: input.actor,
          action: 'check.item_removed',
          entityType: 'check',
          entityId: s.check_id,
          data: { sessionId: s.id, amount: s.amount, reason: 'GAME_CANCELLED' },
        });
        if (!this.#voidIfEmpty(s.check_id, input.actor, now)) this.#assertTotals(s.check_id);
      }

      run(
        db,
        `UPDATE table_sessions
         SET status = 'CANCELLED', cancel_reason = ?, cancel_approved_by = ?, cancelled_by = ?, cancelled_at = ?,
             updated_at = ?
         WHERE id = ?`,
        reason,
        approvedBy,
        input.actor,
        now,
        now,
        s.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'session.voided',
        entityType: 'session',
        entityId: s.id,
        data: { tableId: s.table_id, amount: s.amount, checkId: s.check_id, reason, approvedBy },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      return loadSession(db, s.id, now);
    });
  }

  #checkRow(id: string) {
    const row = one<{ id: string; club_id: string; number: number; status: string; currency: string }>(
      this.#db,
      'SELECT c.id, c.club_id, c.number, c.status, cl.currency FROM checks c JOIN clubs cl ON cl.id = c.club_id WHERE c.id = ?',
      id,
    );
    if (!row) throw new HubError(404, 'CHECK_NOT_FOUND', 'Счёт не найден');
    return row;
  }

  #openCheck(id: string) {
    const row = this.#checkRow(id);
    if (row.status !== 'OPEN') {
      throw new HubError(409, 'CHECK_NOT_OPEN', row.status === 'PAID' ? `Счёт №${row.number} уже оплачен` : `Счёт №${row.number} аннулирован`);
    }
    return row;
  }

  #addGame(checkId: string, club: string, sessionId: string, now: number) {
    const db = this.#db;
    const s = one<SessionRow & { table_name: string }>(
      db,
      `SELECT s.*, ci.check_id AS check_id, t.name AS table_name
       FROM table_sessions s
       JOIN billiard_tables t ON t.id = s.table_id
       LEFT JOIN check_items ci ON ci.session_id = s.id
       WHERE s.id = ? AND s.club_id = ?`,
      sessionId,
      club,
    );
    if (!s) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
    if (s.status !== 'AWAITING_PAYMENT') {
      throw new HubError(409, 'SESSION_NOT_PAYABLE', `${s.table_name}: игра не ожидает оплаты`);
    }
    if (s.check_id) throw new HubError(409, 'SESSION_IN_OTHER_CHECK', `${s.table_name}: игра уже в другом счёте`);
    const id = randomUUID();
    const amount = s.amount ?? 0;
    run(
      db,
      `INSERT INTO check_items (id, check_id, kind, session_id, title, amount, created_at)
       VALUES (?, ?, 'GAME', ?, ?, ?, ?)`,
      id,
      checkId,
      s.id,
      s.table_name,
      amount,
      now,
    );
    return { itemId: id, sessionId: s.id, tableId: s.table_id, amount };
  }

  /** Marks a change of items or money, so screens can tell the newer copy of a check. */
  #touch(checkId: string, now: number): void {
    run(this.#db, 'UPDATE checks SET updated_at = ? WHERE id = ?', now, checkId);
  }

  /** Recomputes totals: throws if the stored discount no longer fits. */
  #assertTotals(checkId: string): void {
    loadCheck(this.#db, checkId);
  }

  #assertNoMoney(checkId: string): void {
    const c = loadCheck(this.#db, checkId);
    if (c.paid - c.refunded > 0) {
      throw new HubError(409, 'CHECK_HAS_PAYMENTS', `По счёту №${c.number} уже есть оплата — сначала оформите возврат`);
    }
  }

  #voidIfEmpty(checkId: string, actor: string, now: number): boolean {
    const left = one<{ n: number }>(this.#db, 'SELECT COUNT(*) AS n FROM check_items WHERE check_id = ?', checkId)?.n ?? 0;
    if (left > 0) return false;
    run(this.#db, "UPDATE checks SET status = 'VOID', closed_at = ?, updated_at = ? WHERE id = ?", now, now, checkId);
    record(this.#db, now, { actor, action: 'check.voided', entityType: 'check', entityId: checkId, data: {} });
    return true;
  }

  #settle(checkId: string, number: number, shiftId: string, actor: string, now: number): void {
    const db = this.#db;
    run(
      db,
      "UPDATE checks SET status = 'PAID', closed_at = ?, closed_shift_id = ?, updated_at = ? WHERE id = ?",
      now,
      shiftId,
      now,
      checkId,
    );
    const games = all<{ id: string; table_id: string }>(
      db,
      `SELECT s.id, s.table_id FROM check_items ci JOIN table_sessions s ON s.id = ci.session_id
       WHERE ci.check_id = ? AND s.status = 'AWAITING_PAYMENT'`,
      checkId,
    );
    for (const g of games) {
      run(db, "UPDATE table_sessions SET status = 'CLOSED', updated_at = ? WHERE id = ?", now, g.id);
      record(db, now, {
        actor,
        action: 'session.closed',
        entityType: 'session',
        entityId: g.id,
        data: { tableId: g.table_id, checkId },
      });
    }
    const check = loadCheck(db, checkId);
    record(db, now, {
      actor,
      action: 'check.paid',
      entityType: 'check',
      entityId: checkId,
      data: {
        number,
        shiftId,
        subtotal: check.subtotal,
        discount: check.discountAmount,
        total: check.total,
        paid: check.paid,
        sessionIds: games.map((g) => g.id),
      },
    });
  }
}
