import type { OpenPrepaidResponse, PaymentPart, SessionView, TariffConfig } from '@bills/domain';
import {
  assertPrepaidMinutes,
  BillingError,
  calculateCharge,
  formatMoney,
  PREPAID_WARNING_MS,
  prepaidDeadline,
  prepaidPrice,
} from '@bills/domain';
import type { CheckService } from './checks.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { ChangeEvent, HubEvents } from './events.ts';
import { raiseAlert, record, SYSTEM } from './journal.ts';
import type { LampController } from './lamps/controller.ts';
import type { SessionService } from './sessions.ts';
import { clubId, requireOpenShift } from './shifts.ts';
import { loadSession } from './views.ts';

export interface OpenPrepaidInput {
  tableId: string;
  tariffId?: string | undefined;
  minutes: number;
  actor: string;
}

export interface OpenPaidInput extends OpenPrepaidInput {
  /** The price the guest was shown. */
  amount: number;
  parts: PaymentPart[];
}

interface RunningRow {
  session_id: string;
  table_id: string;
  minutes: number;
  deadline_at: number;
  warned_at: number | null;
  started_at: number;
  tariff_snapshot: string;
  timezone: string;
}

/**
 * Games opened for N minutes. The deadline (lamp-confirmed start + minutes) is
 * stored in the database; `sync()` blinks the lamp 5 minutes before it, stops the
 * game at it and closes games that were paid upfront. It runs every second, after
 * every change, and on HUB start — so a restart never loses a deadline.
 */
export class PrepaidService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #sessions: SessionService;
  readonly #checks: CheckService;
  readonly #lamps: LampController;
  readonly #tickMs: number;
  #timer: NodeJS.Timeout | undefined;
  #syncing = false;
  #again = false;
  readonly #onChange = (_e: ChangeEvent) => this.#safeSync();

  constructor(deps: {
    db: Db;
    clock: Clock;
    events: HubEvents;
    sessions: SessionService;
    checks: CheckService;
    lamps: LampController;
    tickMs?: number;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#sessions = deps.sessions;
    this.#checks = deps.checks;
    this.#lamps = deps.lamps;
    this.#tickMs = deps.tickMs ?? 1000;
  }

  start(): void {
    this.sync();
    this.#events.on('changed', this.#onChange);
    this.#timer = setInterval(() => this.#safeSync(), this.#tickMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#events.off('changed', this.#onChange);
  }

  /** Opens a timed game: the HUB stops it after `minutes`; it is paid afterwards like any game. */
  open(input: OpenPrepaidInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      assertPrepaidMinutes(input.minutes);
      const session = this.#sessions.open({ tableId: input.tableId, tariffId: input.tariffId, actor: input.actor });
      run(
        db,
        'INSERT INTO prepaid_games (session_id, minutes, created_at) VALUES (?, ?, ?)',
        session.id,
        input.minutes,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'session.prepaid',
        entityType: 'session',
        entityId: session.id,
        data: { tableId: input.tableId, minutes: input.minutes },
      });
      return loadSession(db, session.id, now);
    });
  }

  /**
   * Opens a game for `minutes` and takes the whole payment in the same transaction:
   * either the table opens and the check is PAID, or nothing happens.
   */
  openPaid(input: OpenPaidInput): OpenPrepaidResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      assertPrepaidMinutes(input.minutes);
      requireOpenShift(db, clubId(db));
      const session = this.open(input);
      const price = prepaidPrice(now, input.minutes, session.tariff, session.timezone);
      const money = (a: number) => formatMoney(a, session.tariff.currency);
      if (price !== input.amount) {
        throw new HubError(409, 'PREPAID_PRICE_CHANGED', `Цена изменилась: ${money(price)} — назовите гостю новую сумму`);
      }
      const check = this.#checks.createPrepaid({ sessionId: session.id, amount: price, actor: input.actor });
      const paid = this.#checks.pay({ checkId: check.id, parts: input.parts, actor: input.actor });
      if (paid.remaining > 0) {
        throw new BillingError(
          'PREPAID_NOT_FULLY_PAID',
          `Предоплата принимается полностью: не хватает ${money(paid.remaining)}`,
        );
      }
      run(db, 'UPDATE prepaid_games SET amount = ?, check_id = ? WHERE session_id = ?', price, check.id, session.id);
      return {
        session: loadSession(db, session.id, now),
        check: paid.check,
        applied: paid.applied,
        change: paid.change,
      };
    });
  }

  /** Brings prepaid games in line with the clock. Safe to call any time; tests call it directly. */
  sync(): void {
    if (this.#syncing) {
      this.#again = true;
      return;
    }
    this.#syncing = true;
    try {
      do {
        this.#again = false;
        this.#syncOnce();
      } while (this.#again);
    } finally {
      this.#syncing = false;
    }
  }

  // Runs from timers and other commands' change events: a failure here must not break them.
  #safeSync(): void {
    try {
      this.sync();
    } catch (err) {
      console.error('prepaid sync failed', err);
    }
  }

  #syncOnce(): void {
    const db = this.#db;
    const now = this.#clock.now();
    transaction(db, () => {
      let changed = false;

      // Started games get their deadline: lamp-confirmed start + minutes.
      for (const r of all<{ session_id: string; started_at: number; minutes: number }>(
        db,
        `SELECT p.session_id, s.started_at, p.minutes FROM prepaid_games p JOIN table_sessions s ON s.id = p.session_id
         WHERE p.settled_at IS NULL AND p.deadline_at IS NULL AND s.started_at IS NOT NULL`,
      )) {
        run(
          db,
          'UPDATE prepaid_games SET deadline_at = ? WHERE session_id = ?',
          prepaidDeadline(r.started_at, r.minutes),
          r.session_id,
        );
        changed = true;
      }

      // Running games: blink 5 minutes before the end, stop at the end.
      for (const r of all<RunningRow>(
        db,
        `SELECT p.session_id, p.minutes, p.deadline_at, p.warned_at, s.table_id, s.started_at, s.tariff_snapshot, s.timezone
         FROM prepaid_games p JOIN table_sessions s ON s.id = p.session_id
         WHERE p.settled_at IS NULL AND p.deadline_at IS NOT NULL AND s.status = 'ACTIVE'`,
      )) {
        if (now >= r.deadline_at) {
          this.#end(r, now);
          changed = true;
        } else if (r.warned_at === null && now >= r.deadline_at - PREPAID_WARNING_MS) {
          this.#lamps.request(r.table_id, 'BLINK', r.session_id);
          run(db, 'UPDATE prepaid_games SET warned_at = ? WHERE session_id = ?', now, r.session_id);
          record(db, now, {
            actor: SYSTEM,
            action: 'session.prepaid_warning',
            entityType: 'session',
            entityId: r.session_id,
            data: { tableId: r.table_id, deadlineAt: r.deadline_at, remainingMs: r.deadline_at - now },
          });
          changed = true;
        }
      }

      if (this.#closePaid(now, null)) changed = true;

      // Paid upfront but the game never started (lamp failed, cancelled): staff must refund.
      for (const r of all<{ session_id: string; table_id: string; table_name: string; amount: number; number: number; currency: string }>(
        db,
        `SELECT p.session_id, s.table_id, t.name AS table_name, p.amount, c.number, cl.currency
         FROM prepaid_games p
         JOIN table_sessions s ON s.id = p.session_id
         JOIN billiard_tables t ON t.id = s.table_id
         JOIN checks c ON c.id = p.check_id
         JOIN clubs cl ON cl.id = s.club_id
         WHERE p.settled_at IS NULL AND s.status IN ('FAILED', 'CANCELLED')`,
      )) {
        raiseAlert(db, now, {
          kind: 'PREPAID_NOT_STARTED',
          tableId: r.table_id,
          sessionId: r.session_id,
          message: `${r.table_name}: предоплаченная игра не началась — верните гостю ${formatMoney(r.amount, r.currency)} (счёт №${r.number})`,
        });
        run(db, 'UPDATE prepaid_games SET settled_at = ? WHERE session_id = ?', now, r.session_id);
        changed = true;
      }

      // Timed games paid afterwards need nothing more once they are over.
      run(
        db,
        `UPDATE prepaid_games SET settled_at = ?
         WHERE settled_at IS NULL AND check_id IS NULL
           AND session_id IN (SELECT id FROM table_sessions WHERE status NOT IN ('OPENING', 'ACTIVE'))`,
        now,
      );

      if (changed) afterCommit(db, () => this.#events.changed({ kind: 'session' }));
    });
  }

  /**
   * Closes a game paid upfront right after it stops, in the stop's own transaction,
   * so the stop response already says CLOSED. Does nothing for other games.
   */
  settleStopped(sessionId: string): void {
    transaction(this.#db, () => {
      if (this.#closePaid(this.#clock.now(), sessionId)) {
        afterCommit(this.#db, () => this.#events.changed({ kind: 'session' }));
      }
    });
  }

  /** Paid upfront and stopped (at the deadline or earlier): nothing more to pay. */
  #closePaid(now: number, sessionId: string | null): boolean {
    const db = this.#db;
    const rows = all<{ session_id: string; table_id: string; amount: number; check_id: string }>(
      db,
      `SELECT p.session_id, s.table_id, p.amount, p.check_id
       FROM prepaid_games p
       JOIN table_sessions s ON s.id = p.session_id
       JOIN checks c ON c.id = p.check_id
       WHERE p.settled_at IS NULL AND s.status = 'AWAITING_PAYMENT' AND c.status = 'PAID'
         AND (? IS NULL OR p.session_id = ?)`,
      sessionId,
      sessionId,
    );
    for (const r of rows) {
      run(
        db,
        "UPDATE table_sessions SET status = 'CLOSED', amount = ?, updated_at = ? WHERE id = ? AND status = 'AWAITING_PAYMENT'",
        r.amount,
        now,
        r.session_id,
      );
      run(db, 'UPDATE prepaid_games SET settled_at = ? WHERE session_id = ?', now, r.session_id);
      record(db, now, {
        actor: SYSTEM,
        action: 'session.closed',
        entityType: 'session',
        entityId: r.session_id,
        data: { tableId: r.table_id, checkId: r.check_id, prepaid: true },
      });
    }
    return rows.length > 0;
  }

  /** Stops a game at its deadline — also when the HUB gets to it late (it was down): billing ends at the deadline. */
  #end(r: RunningRow, now: number): void {
    const db = this.#db;
    this.#sessions.stop({ sessionId: r.session_id, actor: SYSTEM });
    const tariff = JSON.parse(r.tariff_snapshot) as TariffConfig;
    const charge = calculateCharge(r.started_at, r.deadline_at, tariff, r.timezone);
    run(
      db,
      `UPDATE table_sessions SET stopped_at = ?, played_seconds = ?, billed_seconds = ?, amount = ?, updated_at = ?
       WHERE id = ?`,
      r.deadline_at,
      charge.playedSeconds,
      charge.billedSeconds,
      charge.amount,
      now,
      r.session_id,
    );
    run(db, 'UPDATE prepaid_games SET ended_at = ? WHERE session_id = ?', now, r.session_id);
    record(db, now, {
      actor: SYSTEM,
      action: 'session.prepaid_ended',
      entityType: 'session',
      entityId: r.session_id,
      data: {
        tableId: r.table_id,
        minutes: r.minutes,
        deadlineAt: r.deadline_at,
        lateMs: now - r.deadline_at,
        playedSeconds: charge.playedSeconds,
        amount: charge.amount,
      },
    });
  }
}
