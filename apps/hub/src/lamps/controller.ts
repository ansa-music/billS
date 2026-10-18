import { randomUUID } from 'node:crypto';
import type { TariffConfig } from '@bills/domain';
import { pauseLimits } from '@bills/domain';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import { afterCommit, all, one, run, transaction } from '../db.ts';
import type { HubEvents } from '../events.ts';
import { raiseAlert, record, SYSTEM } from '../journal.ts';
import type { LampDriver } from './driver.ts';

export type LampAction = 'ON' | 'OFF';

export interface LampRequestOptions {
  /** ON with a blinking lamp (paused game, tariff pauseLamp = 'blink'). */
  blink?: boolean;
}

export interface DesiredLamp {
  action: LampAction;
  blink: boolean;
}

/** What a live game needs from its table's lamp, from the live-session + open-pause join. */
export interface LiveLampRow {
  live_session_id: string | null;
  pause_id: string | null;
  resume_requested_at: number | null;
  tariff_snapshot: string | null;
}

/**
 * The lamp state a table should be in: ON for a game that runs or is being
 * resumed, OFF (or blinking, by tariff) while paused, OFF without a game.
 */
export function desiredLampFor(row: LiveLampRow): DesiredLamp {
  if (!row.live_session_id) return { action: 'OFF', blink: false };
  if (row.pause_id !== null && row.resume_requested_at === null) {
    const lamp = row.tariff_snapshot ? pauseLimits(JSON.parse(row.tariff_snapshot) as TariffConfig).lamp : 'off';
    return lamp === 'blink' ? { action: 'ON', blink: true } : { action: 'OFF', blink: false };
  }
  return { action: 'ON', blink: false };
}

/** Tables with their live game and its open pause: feeds desiredLampFor. */
const LIVE_LAMP_SQL = `
  SELECT t.id AS table_id, s.id AS live_session_id, s.tariff_snapshot, p.id AS pause_id, p.resume_requested_at
  FROM billiard_tables t
  LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status IN ('OPENING', 'ACTIVE')
  LEFT JOIN session_pauses p ON p.session_id = s.id AND p.resumed_at IS NULL
  WHERE t.is_active = 1`;

export interface LampOptions {
  /** How long to wait for one confirmation from the controller. */
  attemptTimeoutMs: number;
  /** Pauses between attempts; attempts = retryDelaysMs.length + 1. */
  retryDelaysMs: number[];
}

export const DEFAULT_LAMP_OPTIONS: LampOptions = { attemptTimeoutMs: 2000, retryDelaysMs: [500, 1000, 2000] };

interface CommandRow {
  id: string;
  table_id: string;
  session_id: string | null;
  action: LampAction;
  blink: number;
  status: 'PENDING' | 'ACKED' | 'FAILED' | 'SUPERSEDED';
  attempts: number;
}

async function withTimeout(task: (signal: AbortSignal) => Promise<void>, ms: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`No controller confirmation within ${ms} ms`)), ms);
  try {
    await Promise.race([
      task(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Durable lamp command queue. Commands are written in the same transaction as
 * the game change that needs them, sent after commit, retried, and re-sent on
 * HUB start. Confirming ON for an opening game is what starts its billing.
 */
export class LampController {
  readonly #db: Db;
  readonly #driver: LampDriver;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #options: LampOptions;
  readonly #inFlight = new Set<string>();
  readonly #retryAt = new Map<string, number>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;

  constructor(deps: { db: Db; driver: LampDriver; clock: Clock; events: HubEvents; options?: LampOptions }) {
    this.#db = deps.db;
    this.#driver = deps.driver;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#options = deps.options ?? DEFAULT_LAMP_OPTIONS;
  }

  /** Queues a command; call inside the transaction that decided it. Supersedes a pending one. */
  request(tableId: string, action: LampAction, sessionId: string | null, options: LampRequestOptions = {}): string {
    const db = this.#db;
    const now = this.#clock.now();
    const blink = action === 'ON' && options.blink ? 1 : 0;
    run(
      db,
      "UPDATE lamp_commands SET status = 'SUPERSEDED', finished_at = ? WHERE table_id = ? AND status = 'PENDING'",
      now,
      tableId,
    );
    const id = randomUUID();
    run(
      db,
      "INSERT INTO lamp_commands (id, table_id, session_id, action, blink, status, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)",
      id,
      tableId,
      sessionId,
      action,
      blink,
      now,
    );
    run(
      db,
      `INSERT INTO lamp_states (table_id, desired, blink, reported, updated_at) VALUES (?, ?, ?, 'UNKNOWN', ?)
       ON CONFLICT (table_id) DO UPDATE SET desired = excluded.desired, blink = excluded.blink, updated_at = excluded.updated_at`,
      tableId,
      action,
      blink,
      now,
    );
    afterCommit(db, () => this.kick());
    return id;
  }

  /**
   * Re-sends the state every lamp should be in. Called on HUB start: the
   * controller may have rebooted, and commands may have been cut off.
   * Running games keep their start time — the downtime is billed.
   */
  recover(): void {
    const db = this.#db;
    transaction(db, () => {
      const tables = all<LiveLampRow & { table_id: string }>(db, LIVE_LAMP_SQL);
      let resent = 0;
      for (const t of tables) {
        const desired = desiredLampFor(t);
        const pending = one<CommandRow>(
          db,
          "SELECT * FROM lamp_commands WHERE table_id = ? AND status = 'PENDING'",
          t.table_id,
        );
        if (pending && pending.action === desired.action && pending.blink === (desired.blink ? 1 : 0)) continue;
        this.request(t.table_id, desired.action, t.live_session_id, { blink: desired.blink });
        resent++;
      }
      record(db, this.#clock.now(), {
        actor: SYSTEM,
        action: 'hub.recovered',
        entityType: 'hub',
        entityId: 'hub',
        data: { tables: tables.length, resent },
      });
    });
    this.kick();
  }

  /**
   * Re-sends the desired state to lamps left in an unknown state by a failed
   * command — the controller may be back. Runs periodically.
   */
  reconcile(): number {
    const db = this.#db;
    return transaction(db, () => {
      const rows = all<LiveLampRow & { table_id: string }>(
        db,
        `${LIVE_LAMP_SQL}
           AND EXISTS (SELECT 1 FROM lamp_states l WHERE l.table_id = t.id AND l.reported = 'UNKNOWN')
           AND NOT EXISTS (SELECT 1 FROM lamp_commands c WHERE c.table_id = t.id AND c.status = 'PENDING')`,
      );
      for (const r of rows) {
        const desired = desiredLampFor(r);
        this.request(r.table_id, desired.action, r.live_session_id, { blink: desired.blink });
      }
      return rows.length;
    });
  }

  /** Sends every pending command whose table is not busy and whose retry pause is over. */
  kick(): void {
    if (this.#closed) return;
    const pending = all<CommandRow>(this.#db, "SELECT * FROM lamp_commands WHERE status = 'PENDING' ORDER BY created_at");
    const now = performance.now();
    for (const cmd of pending) {
      if (this.#inFlight.has(cmd.table_id)) continue;
      const retryAt = this.#retryAt.get(cmd.id);
      if (retryAt !== undefined && retryAt > now) continue;
      void this.#attempt(cmd);
    }
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  async #attempt(cmd: CommandRow): Promise<void> {
    this.#inFlight.add(cmd.table_id);
    let error: unknown = null;
    try {
      const table = one<{ lamp_channel: string }>(
        this.#db,
        'SELECT lamp_channel FROM billiard_tables WHERE id = ?',
        cmd.table_id,
      );
      if (!table) throw new Error(`Unknown table ${cmd.table_id}`);
      await withTimeout(
        (signal) => this.#driver.setLamp(table.lamp_channel, cmd.action === 'ON', signal, { blink: cmd.blink === 1 }),
        this.#options.attemptTimeoutMs,
      );
    } catch (err) {
      error = err;
    } finally {
      this.#inFlight.delete(cmd.table_id);
    }
    if (this.#closed) return;
    if (error === null) this.#confirmed(cmd);
    else this.#failedAttempt(cmd, error);
    this.kick();
  }

  #confirmed(cmd: CommandRow): void {
    const db = this.#db;
    const now = this.#clock.now();
    this.#retryAt.delete(cmd.id);
    transaction(db, () => {
      run(
        db,
        'UPDATE lamp_states SET reported = ?, reported_at = ?, updated_at = ? WHERE table_id = ?',
        cmd.action,
        now,
        now,
        cmd.table_id,
      );
      afterCommit(db, () => this.#events.changed({ kind: 'lamp', tableId: cmd.table_id }));
      const acked = run(
        db,
        "UPDATE lamp_commands SET status = 'ACKED', attempts = attempts + 1, finished_at = ? WHERE id = ? AND status = 'PENDING'",
        now,
        cmd.id,
      );
      // Superseded while in flight: the lamp state is recorded, the newer command goes next.
      if (!acked) return;
      record(db, now, {
        actor: SYSTEM,
        action: cmd.action === 'ON' ? 'lamp.on' : 'lamp.off',
        entityType: 'table',
        entityId: cmd.table_id,
        data: { commandId: cmd.id, sessionId: cmd.session_id, blink: cmd.blink === 1 },
      });
      if (cmd.action === 'ON' && cmd.session_id && !cmd.blink) {
        const started = run(
          db,
          "UPDATE table_sessions SET status = 'ACTIVE', started_at = ?, updated_at = ? WHERE id = ? AND status = 'OPENING'",
          now,
          now,
          cmd.session_id,
        );
        if (started) {
          record(db, now, {
            actor: SYSTEM,
            action: 'session.started',
            entityType: 'session',
            entityId: cmd.session_id,
            data: { tableId: cmd.table_id, startedAt: now },
          });
          return;
        }
        // A paused (or transferred) game whose lamp is back on: time runs again from now.
        const pause = one<{ id: string; reason: string; paused_at: number }>(
          db,
          `SELECT p.id, p.reason, p.paused_at FROM session_pauses p
           JOIN table_sessions s ON s.id = p.session_id
           WHERE p.session_id = ? AND p.resumed_at IS NULL AND p.resume_requested_at IS NOT NULL
             AND s.status = 'ACTIVE' AND s.table_id = ?`,
          cmd.session_id,
          cmd.table_id,
        );
        if (pause) {
          run(db, 'UPDATE session_pauses SET resumed_at = ? WHERE id = ?', now, pause.id);
          run(db, 'UPDATE table_sessions SET updated_at = ? WHERE id = ?', now, cmd.session_id);
          record(db, now, {
            actor: SYSTEM,
            action: 'session.resumed',
            entityType: 'session',
            entityId: cmd.session_id,
            data: {
              tableId: cmd.table_id,
              reason: pause.reason,
              pausedAt: pause.paused_at,
              resumedAt: now,
              pausedSeconds: Math.floor((now - pause.paused_at) / 1000),
            },
          });
        }
      }
    });
  }

  #failedAttempt(cmd: CommandRow, error: unknown): void {
    const db = this.#db;
    const now = this.#clock.now();
    const message = error instanceof Error ? error.message : String(error);
    let retryIn: number | undefined;
    transaction(db, () => {
      const current = one<CommandRow>(db, 'SELECT * FROM lamp_commands WHERE id = ?', cmd.id);
      if (current?.status !== 'PENDING') return;
      const attempts = current.attempts + 1;
      retryIn = this.#options.retryDelaysMs[attempts - 1];
      if (retryIn !== undefined) {
        run(db, 'UPDATE lamp_commands SET attempts = ?, last_error = ? WHERE id = ?', attempts, message, cmd.id);
        return;
      }

      run(
        db,
        "UPDATE lamp_commands SET status = 'FAILED', attempts = ?, last_error = ?, finished_at = ? WHERE id = ?",
        attempts,
        message,
        now,
        cmd.id,
      );
      run(db, "UPDATE lamp_states SET reported = 'UNKNOWN', updated_at = ? WHERE table_id = ?", now, cmd.table_id);
      record(db, now, {
        actor: SYSTEM,
        action: 'lamp.failed',
        entityType: 'table',
        entityId: cmd.table_id,
        data: { commandId: cmd.id, action: cmd.action, attempts, error: message },
      });
      const tableName =
        one<{ name: string }>(db, 'SELECT name FROM billiard_tables WHERE id = ?', cmd.table_id)?.name ?? cmd.table_id;

      let gameFailed = false;
      let resumeFailed = false;
      if (cmd.action === 'ON' && cmd.session_id && !cmd.blink) {
        gameFailed =
          run(
            db,
            `UPDATE table_sessions SET status = 'FAILED', failure_reason = ?, stopped_at = ?, updated_at = ?
             WHERE id = ? AND status = 'OPENING'`,
            'LAMP_NOT_CONFIRMED',
            now,
            now,
            cmd.session_id,
          ) > 0;
        if (gameFailed) {
          record(db, now, {
            actor: SYSTEM,
            action: 'session.failed',
            entityType: 'session',
            entityId: cmd.session_id,
            data: { tableId: cmd.table_id, reason: 'LAMP_NOT_CONFIRMED' },
          });
        } else {
          // Resuming a paused game: it stays paused, staff can press «Продолжить» again.
          resumeFailed =
            run(
              db,
              `UPDATE session_pauses SET resume_requested_at = NULL, resumed_by = NULL
               WHERE session_id = ? AND resumed_at IS NULL AND resume_requested_at IS NOT NULL`,
              cmd.session_id,
            ) > 0;
          if (resumeFailed) {
            record(db, now, {
              actor: SYSTEM,
              action: 'session.resume_failed',
              entityType: 'session',
              entityId: cmd.session_id,
              data: { tableId: cmd.table_id, reason: 'LAMP_NOT_CONFIRMED' },
            });
          }
        }
      }
      raiseAlert(db, now, {
        kind: cmd.action === 'ON' ? 'LAMP_ON_FAILED' : 'LAMP_OFF_FAILED',
        tableId: cmd.table_id,
        sessionId: cmd.session_id,
        message:
          cmd.action === 'OFF'
            ? `${tableName}: лампа не подтвердила выключение — проверьте свет на столе`
            : gameFailed
              ? `${tableName}: лампа не подтвердила включение — игра не начата, время не считается`
              : resumeFailed
                ? `${tableName}: лампа не подтвердила включение — игра остаётся на паузе, нажмите «Продолжить» ещё раз`
                : `${tableName}: лампа не подтвердила включение — проверьте свет на столе`,
      });
      // The lamp may have switched on without confirming: make sure it goes off.
      if (gameFailed) this.request(cmd.table_id, 'OFF', null);
      if (resumeFailed) this.request(cmd.table_id, 'OFF', cmd.session_id);
      afterCommit(db, () => this.#events.changed({ kind: 'alert', tableId: cmd.table_id }));
    });
    if (retryIn !== undefined) this.#scheduleRetry(cmd.id, retryIn);
  }

  #scheduleRetry(commandId: string, delayMs: number): void {
    this.#retryAt.set(commandId, performance.now() + delayMs);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#retryAt.delete(commandId);
      this.kick();
    }, delayMs);
    this.#timers.add(timer);
  }
}
