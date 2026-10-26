import { randomUUID } from 'node:crypto';
import type { CheckView, ExtendPrepaidResponse, OpenPrepaidResponse, PaymentPart, SessionView, TariffConfig } from '@bills/domain';
import {
  assertPrepaidExtension,
  assertPrepaidMinutes,
  BillingError,
  formatMoney,
  PREPAID_QUOTE_TTL_MS,
  PREPAID_WARNING_MS,
  prepaidExtensionPrice,
  prepaidPrice,
} from '@bills/domain';
import type { CheckService } from './checks.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { ChangeEvent, HubEvents } from './events.ts';
import { raiseAlert, record, SYSTEM } from './journal.ts';
import type { LampController } from './lamps/controller.ts';
import { DEFAULT_BLINK_TIMES } from './lamps/controller.ts';
import { computePrepaidDeadline, shiftPrepaidDeadline } from './prepaid-deadline.ts';
import type { SessionService } from './sessions.ts';
import { clubId, requireOpenShift } from './shifts.ts';
import type { SessionRow } from './views.ts';
import { effectiveStatus, loadCheck, loadSession, SESSION_SELECT } from './views.ts';

export interface OpenPrepaidInput {
  tableId: string;
  tariffId?: string | undefined;
  minutes: number;
  actor: string;
}

export interface OpenPaidInput extends OpenPrepaidInput {
  /** The price the guest was shown, and when it was computed. */
  amount: number;
  quotedAt?: number | undefined;
  parts: PaymentPart[];
}

export interface ExtendPrepaidInput {
  sessionId: string;
  /** Minutes to add. */
  minutes: number;
  /** The price staff saw; refused (409 PREPAID_PRICE_CHANGED) when the HUB price differs. */
  amount?: number | undefined;
  /** A game paid upfront: pay the extension now (needs an open shift, must cover it all). */
  parts?: PaymentPart[] | undefined;
  actor: string;
}

interface RunningRow {
  session_id: string;
  table_id: string;
  minutes: number;
  deadline_at: number;
  warned_at: number | null;
}

/**
 * Games opened for N minutes. The deadline (lamp-confirmed start + minutes + unpaid
 * pause time, see prepaid-deadline.ts) is stored in the database; `sync()` blinks the
 * lamp 5 minutes before it, stops the game at it and closes games that were paid
 * upfront. It runs every second, after every change, and on HUB start — so a restart
 * never loses a deadline. A paused game is left alone until it resumes; a game
 * stopped or voided early simply drops out of the running set — no timer to cancel.
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
    this.#timer.unref?.();
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
      // A recent quote stands: across a rate change the price moves every few seconds.
      const q = input.quotedAt;
      const at = q !== undefined && q >= now - PREPAID_QUOTE_TTL_MS && q <= now + 5_000 ? q : now;
      const price = prepaidPrice(at, input.minutes, session.tariff, session.timezone);
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

  /**
   * «Продлить на N минут»: adds paid minutes to a running prepaid game in one transaction.
   *
   * - The deadline moves by exactly N: `minutes` grows and the deadline is recomputed from
   *   the lamp-confirmed start and the closed pauses (prepaid-deadline.ts), so pauses before
   *   and after keep working. A paused game can be extended; its time left stays frozen.
   * - The 5-minute warning re-arms when the new end is more than 5 minutes of play away.
   * - Price: prepaidExtensionPrice — the game's own tariff, from the current deadline on.
   * - A game paid upfront gets a line «Продление» (kind EXTENSION) on the open extension
   *   check of that game, or on a new check: its prepaid check is PAID and stays untouched.
   *   With `parts` the check is paid at once (open shift, the whole due), otherwise it waits
   *   for the cashier like any open check (and blocks closing the shift).
   * - A game paid after the stop just plays longer: it is billed by played time as always.
   * - A game without a time limit has nothing to extend: `extended: false`, nothing changes.
   */
  extend(input: ExtendPrepaidInput): ExtendPrepaidResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const row = one<SessionRow>(db, `${SESSION_SELECT} WHERE s.id = ?`, input.sessionId);
      if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
      const status = effectiveStatus(row);
      if (status === 'OPENING') {
        throw new HubError(409, 'SESSION_NOT_STARTED', 'Свет ещё не включился — продлить можно, когда игра начнётся');
      }
      if (status !== 'ACTIVE' && status !== 'PAUSED') {
        throw new HubError(409, 'SESSION_NOT_LIVE', 'Игра уже закончилась — продлевать нечего');
      }
      if (row.prepaid_minutes === null) {
        return { extended: false, session: loadSession(db, row.id, now), minutes: 0, price: 0, check: null, applied: 0, change: 0 };
      }

      assertPrepaidExtension(input.minutes, row.prepaid_minutes);
      const paidUpfront = row.prepaid_check_id !== null;
      const payNow = (input.parts?.length ?? 0) > 0;
      if (payNow && !paidUpfront) {
        throw new HubError(422, 'PREPAID_PAID_AFTER', 'Эта игра оплачивается после остановки — продление войдёт в её счёт');
      }
      const before = computePrepaidDeadline(db, row.id, now);
      if (!before) throw new HubError(409, 'SESSION_NOT_LIVE', 'Игра уже закончилась — продлевать нечего');
      // On a pause the time left is frozen at the pause start.
      const clock = row.pause_started_at ?? now;
      if (before.deadline <= clock) {
        throw new HubError(409, 'PREPAID_OVER', 'Время уже вышло — игра сейчас остановится');
      }
      const tariff = JSON.parse(row.tariff_snapshot) as TariffConfig;
      const money = (a: number) => formatMoney(a, tariff.currency);
      const price = prepaidExtensionPrice(before.deadline, row.prepaid_minutes, input.minutes, tariff, row.timezone);
      if (input.amount !== undefined && input.amount !== price) {
        throw new HubError(409, 'PREPAID_PRICE_CHANGED', `Цена изменилась: ${money(price)} — назовите гостю новую сумму`);
      }
      if (payNow) requireOpenShift(db, row.club_id);

      run(
        db,
        `UPDATE prepaid_games SET minutes = minutes + ?, extended_minutes = extended_minutes + ?,
           amount = CASE WHEN amount IS NULL THEN NULL ELSE amount + ? END
         WHERE session_id = ?`,
        input.minutes,
        input.minutes,
        price,
        row.id,
      );
      const after = computePrepaidDeadline(db, row.id, now)!.deadline;
      const rearm = after - clock > PREPAID_WARNING_MS;
      run(
        db,
        'UPDATE prepaid_games SET deadline_at = ?, warned_at = CASE WHEN ? THEN NULL ELSE warned_at END WHERE session_id = ?',
        after,
        rearm ? 1 : 0,
        row.id,
      );

      let check: CheckView | null = null;
      let applied = 0;
      let change = 0;
      if (paidUpfront) {
        const checkId = this.#addExtensionLine(row, input.minutes, price, input.actor, now);
        if (payNow) {
          const paid = this.#checks.pay({ checkId, parts: input.parts!, actor: input.actor });
          if (paid.remaining > 0) {
            throw new BillingError('PREPAID_NOT_FULLY_PAID', `Продление оплачивается полностью: не хватает ${money(paid.remaining)}`);
          }
          ({ applied, change } = paid);
          check = paid.check;
        } else {
          check = loadCheck(db, checkId);
        }
      }

      record(db, now, {
        actor: input.actor,
        action: 'session.prepaid_extended',
        entityType: 'session',
        entityId: row.id,
        data: {
          tableId: row.table_id,
          minutes: input.minutes,
          totalMinutes: row.prepaid_minutes + input.minutes,
          from: before.deadline,
          to: after,
          price,
          paidUpfront,
          checkId: check?.id ?? null,
          paidNow: payNow,
          warningRearmed: rearm && before.warnedAt !== null,
        },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: row.table_id }));
      return { extended: true, session: loadSession(db, row.id, now), minutes: input.minutes, price, check, applied, change };
    });
  }

  /**
   * The line «Продление N мин · Стол 1» for a game paid upfront: on the open check that
   * already holds an extension of this game, or on a new check. Returns the check id.
   */
  #addExtensionLine(row: SessionRow, minutes: number, amount: number, actor: string, now: number): string {
    const db = this.#db;
    const tableName = one<{ name: string }>(db, 'SELECT name FROM billiard_tables WHERE id = ?', row.table_id)?.name ?? 'Стол';
    const itemId = randomUUID();
    const item = { itemId, kind: 'EXTENSION', extendsSessionId: row.id, tableId: row.table_id, minutes, amount };
    const open = one<{ id: string }>(
      db,
      `SELECT c.id FROM checks c
       WHERE c.status = 'OPEN' AND EXISTS (SELECT 1 FROM check_items ci WHERE ci.check_id = c.id AND ci.extends_session_id = ?)
       ORDER BY c.created_at DESC LIMIT 1`,
      row.id,
    );
    let checkId: string;
    if (open) {
      checkId = open.id;
    } else {
      checkId = randomUUID();
      const number = (one<{ n: number | null }>(db, 'SELECT MAX(number) AS n FROM checks WHERE club_id = ?', row.club_id)?.n ?? 0) + 1;
      run(
        db,
        `INSERT INTO checks (id, club_id, number, status, created_at, created_by, updated_at) VALUES (?, ?, ?, 'OPEN', ?, ?, ?)`,
        checkId,
        row.club_id,
        number,
        now,
        actor,
        now,
      );
      // No sessionId on the item: the game stays on its prepaid check (here and in the cloud).
      record(db, now, { actor, action: 'check.created', entityType: 'check', entityId: checkId, data: { number, extension: true, items: [] } });
    }
    run(
      db,
      `INSERT INTO check_items (id, check_id, kind, extends_session_id, minutes, title, amount, created_at)
       VALUES (?, ?, 'EXTENSION', ?, ?, ?, ?, ?)`,
      itemId,
      checkId,
      row.id,
      minutes,
      `Продление ${minutes} мин · ${tableName}`,
      amount,
      now,
    );
    run(db, 'UPDATE checks SET updated_at = ? WHERE id = ?', now, checkId);
    record(db, now, { actor, action: 'check.item_added', entityType: 'check', entityId: checkId, data: item });
    afterCommit(db, () => this.#events.changed({ kind: 'check' }));
    return checkId;
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

      // Started games get their deadline: lamp-confirmed start + minutes (+ pauses closed meanwhile).
      for (const r of all<{ session_id: string }>(
        db,
        `SELECT p.session_id FROM prepaid_games p JOIN table_sessions s ON s.id = p.session_id
         WHERE p.settled_at IS NULL AND p.deadline_at IS NULL AND s.started_at IS NOT NULL`,
      )) {
        shiftPrepaidDeadline(db, r.session_id, now);
        changed = true;
      }

      // Running games: blink 5 minutes before the end, stop at the end. A paused game
      // (ACTIVE with an open pause) waits: its deadline moves when the pause closes.
      for (const r of all<RunningRow>(
        db,
        `SELECT p.session_id, p.minutes, p.deadline_at, p.warned_at, s.table_id
         FROM prepaid_games p JOIN table_sessions s ON s.id = p.session_id
         WHERE p.settled_at IS NULL AND p.ended_at IS NULL AND p.deadline_at IS NOT NULL AND s.status = 'ACTIVE'
           AND NOT EXISTS (SELECT 1 FROM session_pauses sp WHERE sp.session_id = s.id AND sp.resumed_at IS NULL)`,
      )) {
        if (now >= r.deadline_at) {
          this.#end(r, now);
          changed = true;
        } else if (r.warned_at === null && now >= r.deadline_at - PREPAID_WARNING_MS) {
          this.#lamps.request(r.table_id, 'BLINK', r.session_id, { times: DEFAULT_BLINK_TIMES });
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
    const stopped = this.#sessions.stop({ sessionId: r.session_id, actor: SYSTEM, at: r.deadline_at });
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
        playedSeconds: stopped.playedSeconds,
        pausedSeconds: stopped.pausedSeconds,
        amount: stopped.amount,
      },
    });
  }
}
