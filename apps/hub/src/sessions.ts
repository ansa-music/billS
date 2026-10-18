import { randomUUID } from 'node:crypto';
import type { TariffConfig } from '@bills/domain';
import { calculateChargeWithPauses, pauseLimits, pauseRefusal, unpaidSpans } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { LampController } from './lamps/controller.ts';
import { desiredLampFor } from './lamps/controller.ts';
import type { SessionRow, SessionView } from './views.ts';
import { effectiveStatus, loadPauseSpans, loadSession, loadSessionRow } from './views.ts';

export interface OpenTableInput {
  tableId: string;
  tariffId?: string | undefined;
  actor: string;
}

export interface SessionCommandInput {
  sessionId: string;
  actor: string;
}

export interface TransferSessionInput extends SessionCommandInput {
  toTableId: string;
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

  /** Requests the lamp; time starts only when the lamp confirms (see LampController). */
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

      const id = randomUUID();
      run(
        db,
        `INSERT INTO table_sessions
           (id, club_id, table_id, tariff_id, tariff_name, tariff_snapshot, timezone, status, requested_at, opened_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPENING', ?, ?, ?)`,
        id,
        table.club_id,
        table.id,
        tariff.id,
        tariff.name,
        tariff.config,
        club.timezone,
        now,
        input.actor,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'session.open_requested',
        entityType: 'session',
        entityId: id,
        data: { tableId: table.id, tariffId: tariff.id },
      });
      this.#lamps.request(table.id, 'ON', id);
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: table.id }));
      return loadSession(db, id, now);
    });
  }

  /** Billing ends now, not when the lamp confirms OFF. The table is free right away. */
  stop(input: SessionCommandInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = this.#session(input.sessionId);
      const status = effectiveStatus(s);

      if ((status === 'ACTIVE' || status === 'PAUSED') && s.started_at !== null) {
        const tariff = JSON.parse(s.tariff_snapshot) as TariffConfig;
        const end = Math.max(now, s.started_at);
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

  /** Asks for the lamp; like opening, time runs again only once the lamp confirms ON. */
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

      run(
        db,
        'UPDATE session_pauses SET resume_requested_at = ?, resumed_by = ? WHERE id = ?',
        now,
        input.actor,
        s.pause_id,
      );
      run(db, 'UPDATE table_sessions SET updated_at = ? WHERE id = ?', now, s.id);
      this.#lamps.request(s.table_id, 'ON', s.id);
      record(db, now, {
        actor: input.actor,
        action: 'session.resume_requested',
        entityType: 'session',
        entityId: s.id,
        data: { tableId: s.table_id, pauseId: s.pause_id, pausedAt: s.pause_started_at },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'session', tableId: s.table_id }));
      return loadSession(db, s.id, now);
    });
  }

  /**
   * Moves a game to a free table. The old lamp goes off, the new one on; the
   * time in between is an unpaid pause (reason `transfer`) that ends when the
   * new lamp confirms. The tariff snapshot stays as it was.
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

      let pauseId: string | null = null;
      if (status === 'ACTIVE') {
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
        data: { fromTableId: from, toTableId: to.id, status, pauseId },
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
