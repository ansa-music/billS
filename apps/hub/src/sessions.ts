import { randomUUID } from 'node:crypto';
import type { TariffConfig } from '@bills/domain';
import { calculateCharge } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import { isManualMode } from './settings.ts';
import type { LampController } from './lamps/controller.ts';
import type { SessionRow, SessionView } from './views.ts';
import { loadSession } from './views.ts';

export interface OpenTableInput {
  tableId: string;
  tariffId?: string | undefined;
  actor: string;
}

export interface StopSessionInput {
  sessionId: string;
  actor: string;
}

/** Opening and stopping games. Every method is one transaction. */
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
      const table = one<{ id: string; club_id: string; name: string; default_tariff_id: string }>(
        db,
        'SELECT id, club_id, name, default_tariff_id FROM billiard_tables WHERE id = ? AND is_active = 1',
        input.tableId,
      );
      if (!table) throw new HubError(404, 'TABLE_NOT_FOUND', 'Стол не найден');

      const live = one<{ id: string }>(
        db,
        "SELECT id FROM table_sessions WHERE table_id = ? AND status IN ('OPENING', 'ACTIVE')",
        table.id,
      );
      if (live) throw new HubError(409, 'TABLE_BUSY', `${table.name}: игра уже идёт`);

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

  /** Billing ends now, not when the lamp confirms OFF. The table is free right away. */
  stop(input: StopSessionInput): SessionView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const s = one<SessionRow>(db, 'SELECT * FROM table_sessions WHERE id = ?', input.sessionId);
      if (!s) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');

      if (s.status === 'ACTIVE' && s.started_at !== null) {
        const tariff = JSON.parse(s.tariff_snapshot) as TariffConfig;
        const end = Math.max(now, s.started_at);
        const charge = calculateCharge(s.started_at, end, tariff, s.timezone);
        run(
          db,
          `UPDATE table_sessions
           SET status = 'AWAITING_PAYMENT', stopped_at = ?, played_seconds = ?, billed_seconds = ?, amount = ?,
               stopped_by = ?, updated_at = ?
           WHERE id = ?`,
          end,
          charge.playedSeconds,
          charge.billedSeconds,
          charge.amount,
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
            playedSeconds: charge.playedSeconds,
            billedSeconds: charge.billedSeconds,
            amount: charge.amount,
            segments: charge.segments,
          },
        });
      } else if (s.status === 'OPENING') {
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
}
