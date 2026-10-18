import { randomUUID } from 'node:crypto';
import type { TariffConfig } from '@bills/domain';
import { calculateChargeWithPauses, pauseLimits, pauseRefusal, unpaidSpans } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record, SYSTEM } from './journal.ts';
import { shiftPrepaidDeadline } from './prepaid-deadline.ts';
import { isManualMode } from './manual-mode.ts';
import type { LampController } from './lamps/controller.ts';
import { desiredLampFor } from './lamps/controller.ts';
import type { SessionRow, SessionView } from './views.ts';
import { effectiveStatus, loadPauseSpans, loadSession, loadSessionRow, SESSION_SQL } from './views.ts';

export interface OpenTableInput {
  tableId: string;
  tariffId?: string | undefined;
  actor: string;
}

export interface SessionCommandInput {
  sessionId: string;
  actor: string;
}

export interface StopSessionInput extends SessionCommandInput {
  /**
   * Bill up to this moment instead of now (never later than now): the prepaid
   * service stops a game at its deadline even when it gets there late.
   */
  at?: number | undefined;
}

export interface TransferSessionInput extends SessionCommandInput {
  toTableId: string;
}

/** A pause of every running game by the HUB itself (power loss), not by staff. */
export interface SystemPauseInput {
  reason: 'power';
  now: number;
}

interface TableRow {
  id: string;
  club_id: string;
  name: string;
  default_tariff_id: string;
}

/** Opening, pausing, moving and stopping games. Every method is one transaction. */
export class SessionService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #lamps: LampController;
  readonly #events: HubEvents;

  constructor(deps: { db: Db; clock: Clock; lamps: LampController; events: HubEvents }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#lamps = deps.lamps;
    this.#events = deps.events;
  }

  /**
   * Requests the lamp; time starts only when the lamp confirms (see LampController).
   * In manual mode (controller broken, lamps switched by hand) the game starts at
   * once and is marked `manual`; the lamp command is still sent in case the
   * controller is back.
   */
  open(input: OpenTableInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const table = this.#table(input.tableId);
      this.#assertFree(table);

      const tariff = one<{ id: string; name: string; config: string }>(
        db,
        'SELECT id, name, config FROM tariffs WHERE id = ? AND club_id = ? AND is_active = 1',
        input.tariffId ?? table.default_tariff_id,
        table.club_id,
      );
      if (!tariff) throw new HubError(422, 'TARIFF_NOT_AVAILABLE', 'Тариф недоступен для этого стола');

      const club = one<{ timezone: string }>(db, 'SELECT timezone FROM clubs WHERE id = ?', table.club_id);
      if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

      const manual = isManualMode(db);
      const id = randomUUID();
      run(
        db,
        `INSERT INTO table_sessions
           (id, club_id, table_id, tariff_id, tariff_name, tariff_snapshot, timezone, status, requested_at, started_at, manual, opened_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        table.club_id,
        table.id,
        tariff.id,
        tariff.name,
        tariff.config,
        club.timezone,
        manual ? 'ACTIVE' : 'OPENING',
        now,
        manual ? now : null,
        manual ? 1 : 0,
        input.actor,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'session.open_requested',
        entityType: 'session',
        entityId: id,
        data: { tableId: table.id, tariffId: tariff.id, manual },
      });
      if (manual) {
        record(db, now, {
          actor: input.actor,
          action: 'session.started',
          entityType: 'session',
          entityId: id,
          data: { tableId: table.id, startedAt: now, manual: true },
        });
      }
      this.#lamps.request(table.id, 'ON', id);
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: table.id }));
      return loadSession(db, id, now);
    });
  }

  /** Billing ends now (or at `input.at`), not when the lamp confirms OFF. The table is free right away. */
  stop(input: StopSessionInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = this.#session(input.sessionId);
      const status = effectiveStatus(s);

      if ((status === 'ACTIVE' || status === 'PAUSED') && s.started_at !== null) {
        const tariff = JSON.parse(s.tariff_snapshot) as TariffConfig;
        const end = Math.max(Math.min(input.at ?? now, now), s.started_at);
        // A game stopped while paused: the pause ends with the game.
        if (s.pause_id !== null) {
          run(db, 'UPDATE session_pauses SET resumed_at = ?, resumed_by = ? WHERE id = ?', end, input.actor, s.pause_id);
        }
        const pauses = loadPauseSpans(db, s.id);
        const charge = calculateChargeWithPauses(s.started_at, end, unpaidSpans(pauses, tariff, end), tariff, s.timezone);
        run(
          db,
          `UPDATE table_sessions
           SET status = 'AWAITING_PAYMENT', stopped_at = ?, played_seconds = ?, billed_seconds = ?, amount = ?,
               paused_seconds = ?, stopped_by = ?, updated_at = ?
           WHERE id = ?`,
          end,
          charge.playedSeconds,
          charge.billedSeconds,
          charge.amount,
          charge.pausedSeconds,
          input.actor,
          now,
          s.id,
        );
        record(db, now, {
          actor: input.actor,
          action: 'session.stopped',
          entityType: 'session',
          entityId: s.id,
          data: {
            tableId: s.table_id,
            startedAt: s.started_at,
            stoppedAt: end,
            stoppedWhilePaused: status === 'PAUSED',
            playedSeconds: charge.playedSeconds,
            pausedSeconds: charge.pausedSeconds,
            billedSeconds: charge.billedSeconds,
            amount: charge.amount,
            segments: charge.segments,
            pauses,
          },
        });
      } else if (status === 'OPENING') {
        run(
          db,
          `UPDATE table_sessions
           SET status = 'CANCELLED', stopped_at = ?, played_seconds = 0, billed_seconds = 0, amount = 0,
               stopped_by = ?, updated_at = ?
           WHERE id = ?`,
          now,
          input.actor,
          now,
          s.id,
        );
        record(db, now, {
          actor: input.actor,
          action: 'session.cancelled',
          entityType: 'session',
          entityId: s.id,
          data: { tableId: s.table_id, reason: 'STOPPED_BEFORE_LAMP_CONFIRMED' },
        });
      } else {
        throw new HubError(409, 'SESSION_NOT_LIVE', 'Игра уже остановлена');
      }

      this.#lamps.request(s.table_id, 'OFF', s.id);
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      return loadSession(db, s.id, now);
    });
  }

  /**
   * Time and money stop now; the lamp goes off (or blinks, by tariff). Refused
   * beyond the tariff's pause count or total pause time.
   */
  pause(input: SessionCommandInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = this.#session(input.sessionId);
      const status = effectiveStatus(s);
      if (status === 'PAUSED') throw new HubError(409, 'SESSION_ALREADY_PAUSED', 'Игра уже на паузе');
      if (status !== 'ACTIVE' || s.started_at === null) {
        throw new HubError(409, 'SESSION_NOT_ACTIVE', 'На паузу можно поставить только идущую игру');
      }
      const tariff = JSON.parse(s.tariff_snapshot) as TariffConfig;
      const pauses = loadPauseSpans(db, s.id);
      const refusal = pauseRefusal(pauses, tariff, now);
      if (refusal) throw new HubError(422, 'PAUSE_LIMIT', refusal);

      const pauseId = randomUUID();
      run(
        db,
        `INSERT INTO session_pauses (id, session_id, reason, paused_at, paused_by) VALUES (?, ?, 'pause', ?, ?)`,
        pauseId,
        s.id,
        now,
        input.actor,
      );
      run(db, 'UPDATE table_sessions SET updated_at = ? WHERE id = ?', now, s.id);
      const lamp = pauseLimits(tariff).lamp;
      if (lamp === 'blink') this.#lamps.request(s.table_id, 'ON', s.id, { blink: true });
      else this.#lamps.request(s.table_id, 'OFF', s.id);
      record(db, now, {
        actor: input.actor,
        action: 'session.paused',
        entityType: 'session',
        entityId: s.id,
        data: {
          tableId: s.table_id,
          pauseId,
          pausedAt: now,
          pauseNumber: pauses.filter((p) => p.reason === 'pause').length + 1,
          lamp,
        },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      return loadSession(db, s.id, now);
    });
  }

  /**
   * Asks for the lamp; like opening, time runs again only once the lamp confirms ON.
   * In manual mode (lamps switched by hand) time runs again at once.
   */
  resume(input: SessionCommandInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = this.#session(input.sessionId);
      if (effectiveStatus(s) !== 'PAUSED' || s.pause_id === null) {
        throw new HubError(409, 'SESSION_NOT_PAUSED', 'Игра не на паузе');
      }
      // Already switching the lamp on: a second press changes nothing.
      if (s.resume_requested_at !== null) return loadSession(db, s.id, now);

      const manual = isManualMode(db);
      run(
        db,
        'UPDATE session_pauses SET resume_requested_at = ?, resumed_by = ?, resumed_at = ? WHERE id = ?',
        now,
        input.actor,
        manual ? now : null,
        s.pause_id,
      );
      run(db, 'UPDATE table_sessions SET updated_at = ? WHERE id = ?', now, s.id);
      // Manual mode: the pause is over now, a prepaid deadline moves by its length.
      if (manual) shiftPrepaidDeadline(db, s.id, now);
      // The lamp command is still sent in case the controller is back.
      this.#lamps.request(s.table_id, 'ON', s.id);
      record(db, now, {
        actor: input.actor,
        action: 'session.resume_requested',
        entityType: 'session',
        entityId: s.id,
        data: { tableId: s.table_id, pauseId: s.pause_id, pausedAt: s.pause_started_at, manual },
      });
      if (manual && s.pause_started_at !== null) {
        record(db, now, {
          actor: input.actor,
          action: 'session.resumed',
          entityType: 'session',
          entityId: s.id,
          data: {
            tableId: s.table_id,
            reason: s.pause_reason,
            pausedAt: s.pause_started_at,
            resumedAt: now,
            pausedSeconds: Math.floor((now - s.pause_started_at) / 1000),
            manual: true,
          },
        });
      }
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      return loadSession(db, s.id, now);
    });
  }

  /**
   * Power loss: every running game is paused with reason `power` (never billed,
   * not counted against the staff pause budget). Lamps are told OFF so the
   * desired state matches. Returns the ids paused. Called by PowerMonitor
   * inside its transaction.
   */
  pauseAll(input: SystemPauseInput): string[] {
    const db = this.#db;
    const now = input.now;
    return transaction(db, () => {
      const running = all<SessionRow>(
        db,
        `${SESSION_SQL} WHERE s.status = 'ACTIVE' AND s.started_at IS NOT NULL AND p.id IS NULL ORDER BY s.started_at, s.rowid`,
      );
      for (const s of running) {
        const pauseId = randomUUID();
        run(
          db,
          'INSERT INTO session_pauses (id, session_id, reason, paused_at, paused_by) VALUES (?, ?, ?, ?, ?)',
          pauseId,
          s.id,
          input.reason,
          now,
          SYSTEM,
        );
        run(db, 'UPDATE table_sessions SET updated_at = ? WHERE id = ?', now, s.id);
        this.#lamps.request(s.table_id, 'OFF', s.id);
        record(db, now, {
          actor: SYSTEM,
          action: 'session.paused',
          entityType: 'session',
          entityId: s.id,
          data: { tableId: s.table_id, pauseId, pausedAt: now, reason: input.reason, lamp: 'off' },
        });
        afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      }
      return running.map((s) => s.id);
    });
  }

  /**
   * Mains are back: every game still paused by `pauseAll` asks for its lamp; time
   * runs again when the lamp confirms (at once in manual mode), like `resume`.
   * Games staff already resumed or stopped are left alone. Returns the ids resumed.
   */
  resumeAll(input: SystemPauseInput): string[] {
    const db = this.#db;
    const now = input.now;
    return transaction(db, () => {
      const paused = all<SessionRow>(
        db,
        `${SESSION_SQL} WHERE s.status = 'ACTIVE' AND p.id IS NOT NULL AND p.reason = ? AND p.resume_requested_at IS NULL
         ORDER BY s.started_at, s.rowid`,
        input.reason,
      );
      const manual = isManualMode(db);
      for (const s of paused) {
        run(
          db,
          'UPDATE session_pauses SET resume_requested_at = ?, resumed_by = ?, resumed_at = ? WHERE id = ?',
          now,
          SYSTEM,
          manual ? now : null,
          s.pause_id,
        );
        run(db, 'UPDATE table_sessions SET updated_at = ? WHERE id = ?', now, s.id);
        if (manual) shiftPrepaidDeadline(db, s.id, now);
        this.#lamps.request(s.table_id, 'ON', s.id);
        record(db, now, {
          actor: SYSTEM,
          action: 'session.resume_requested',
          entityType: 'session',
          entityId: s.id,
          data: { tableId: s.table_id, pauseId: s.pause_id, pausedAt: s.pause_started_at, reason: input.reason, manual },
        });
        if (manual && s.pause_started_at !== null) {
          record(db, now, {
            actor: SYSTEM,
            action: 'session.resumed',
            entityType: 'session',
            entityId: s.id,
            data: {
              tableId: s.table_id,
              reason: input.reason,
              pausedAt: s.pause_started_at,
              resumedAt: now,
              pausedSeconds: Math.floor((now - s.pause_started_at) / 1000),
              manual: true,
            },
          });
        }
        afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      }
      return paused.map((s) => s.id);
    });
  }

  /**
   * Moves a game to a free table. The old lamp goes off, the new one on; the
   * time in between is an unpaid pause (reason `transfer`) that ends when the
   * new lamp confirms. The tariff snapshot stays as it was. In manual mode the
   * lamps are switched by hand, so a running game keeps running: no pause.
   */
  transfer(input: TransferSessionInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = this.#session(input.sessionId);
      const status = effectiveStatus(s);
      if (status === 'OPENING') {
        throw new HubError(409, 'SESSION_NOT_STARTED', 'Игра ещё не началась — отмените её и откройте нужный стол');
      }
      if (status === 'PAUSED' && s.resume_requested_at !== null) {
        throw new HubError(409, 'SESSION_RESUMING', 'Дождитесь, пока лампа включится, затем переносите');
      }
      if (status !== 'ACTIVE' && status !== 'PAUSED') throw new HubError(409, 'SESSION_NOT_LIVE', 'Игра уже остановлена');

      const to = this.#table(input.toTableId);
      if (to.club_id !== s.club_id) throw new HubError(422, 'TABLE_IN_OTHER_CLUB', 'Стол из другого клуба');
      if (to.id === s.table_id) throw new HubError(422, 'SAME_TABLE', 'Игра уже на этом столе');
      this.#assertFree(to);
      const from = s.table_id;
      const manual = isManualMode(db);

      let pauseId: string | null = null;
      if (status === 'ACTIVE' && !manual) {
        pauseId = randomUUID();
        run(
          db,
          `INSERT INTO session_pauses
             (id, session_id, reason, paused_at, resume_requested_at, paused_by, resumed_by, from_table_id, to_table_id)
           VALUES (?, ?, 'transfer', ?, ?, ?, ?, ?, ?)`,
          pauseId,
          s.id,
          now,
          now,
          input.actor,
          input.actor,
          from,
          to.id,
        );
      }
      run(db, 'UPDATE table_sessions SET table_id = ?, updated_at = ? WHERE id = ?', to.id, now, s.id);

      this.#lamps.request(from, 'OFF', s.id);
      const moved = loadSessionRow(db, s.id);
      const desired = desiredLampFor({
        live_session_id: s.id,
        pause_id: moved?.pause_id ?? null,
        resume_requested_at: moved?.resume_requested_at ?? null,
        tariff_snapshot: s.tariff_snapshot,
      });
      this.#lamps.request(to.id, desired.action, s.id, { blink: desired.blink });

      record(db, now, {
        actor: input.actor,
        action: 'session.transferred',
        entityType: 'session',
        entityId: s.id,
        data: { fromTableId: from, toTableId: to.id, status, pauseId, manual },
      });
      afterCommit(db, () => {
        this.#events.changed({ kind: 'session', tableId: from });
        this.#events.changed({ kind: 'session', tableId: to.id });
      });
      return loadSession(db, s.id, now);
    });
  }

  #session(id: string): SessionRow {
    const s = loadSessionRow(this.#db, id);
    if (!s) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
    return s;
  }

  #table(id: string): TableRow {
    const table = one<TableRow>(
      this.#db,
      'SELECT id, club_id, name, default_tariff_id FROM billiard_tables WHERE id = ? AND is_active = 1',
      id,
    );
    if (!table) throw new HubError(404, 'TABLE_NOT_FOUND', 'Стол не найден');
    return table;
  }

  #assertFree(table: TableRow): void {
    const live = one<{ id: string }>(
      this.#db,
      "SELECT id FROM table_sessions WHERE table_id = ? AND status IN ('OPENING', 'ACTIVE')",
      table.id,
    );
    if (live) throw new HubError(409, 'TABLE_BUSY', `${table.name}: игра уже идёт`);
  }
}
