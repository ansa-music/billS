import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import { afterCommit, all, one, run, transaction } from '../db.ts';
import type { HubEvents } from '../events.ts';
import { raiseAlert, record, SYSTEM } from '../journal.ts';
import type { LampDriver } from './driver.ts';

/** BLINK is a warning signal (prepaid time ending), not a lamp state. */
export type LampAction = 'ON' | 'OFF' | 'BLINK';

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
  request(tableId: string, action: LampAction, sessionId: string | null): string {
    const db = this.#db;
    const now = this.#clock.now();
    if (action === 'BLINK') {
      // Neither supersedes a pending ON/OFF nor changes the wanted state; a later ON/OFF supersedes it.
      const id = randomUUID();
      run(
        db,
        "INSERT INTO lamp_commands (id, table_id, session_id, action, status, created_at) VALUES (?, ?, ?, 'BLINK', 'PENDING', ?)",
        id,
        tableId,
        sessionId,
        now,
      );
      afterCommit(db, () => this.kick());
      return id;
    }
    run(
      db,
      "UPDATE lamp_commands SET status = 'SUPERSEDED', finished_at = ? WHERE table_id = ? AND status = 'PENDING'",
      now,
      tableId,
    );
    const id = randomUUID();
    run(
      db,
      "INSERT INTO lamp_commands (id, table_id, session_id, action, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)",
      id,
      tableId,
      sessionId,
      action,
      now,
    );
    run(
      db,
      `INSERT INTO lamp_states (table_id, desired, reported, updated_at) VALUES (?, ?, 'UNKNOWN', ?)
       ON CONFLICT (table_id) DO UPDATE SET desired = excluded.desired, updated_at = excluded.updated_at`,
      tableId,
      action,
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
      const tables = all<{ id: string; live_session_id: string | null }>(
        db,
        `SELECT t.id, s.id AS live_session_id
         FROM billiard_tables t
         LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status IN ('OPENING', 'ACTIVE')
         WHERE t.is_active = 1`,
      );
      let resent = 0;
      for (const t of tables) {
        const desired: LampAction = t.live_session_id ? 'ON' : 'OFF';
        const pending = one<CommandRow>(
          db,
          "SELECT * FROM lamp_commands WHERE table_id = ? AND status = 'PENDING' AND action <> 'BLINK'",
          t.id,
        );
        if (pending?.action === desired) continue;
        this.request(t.id, desired, t.live_session_id);
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
      const rows = all<{ table_id: string; live_session_id: string | null }>(
        db,
        `SELECT l.table_id, s.id AS live_session_id
         FROM lamp_states l
         JOIN billiard_tables t ON t.id = l.table_id AND t.is_active = 1
         LEFT JOIN table_sessions s ON s.table_id = l.table_id AND s.status IN ('OPENING', 'ACTIVE')
         WHERE l.reported = 'UNKNOWN'
           AND NOT EXISTS (
             SELECT 1 FROM lamp_commands c WHERE c.table_id = l.table_id AND c.status = 'PENDING' AND c.action <> 'BLINK'
           )`,
      );
      for (const r of rows) this.request(r.table_id, r.live_session_id ? 'ON' : 'OFF', r.live_session_id);
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
      const channel = table.lamp_channel;
      await withTimeout(
        (signal) =>
          cmd.action === 'BLINK'
            ? (this.#driver.blink?.(channel, signal) ?? Promise.resolve())
            : this.#driver.setLamp(channel, cmd.action === 'ON', signal),
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
      if (cmd.action !== 'BLINK') {
        run(
          db,
          'UPDATE lamp_states SET reported = ?, reported_at = ?, updated_at = ? WHERE table_id = ?',
          cmd.action,
          now,
          now,
          cmd.table_id,
        );
        afterCommit(db, () => this.#events.changed({ kind: 'lamp', tableId: cmd.table_id }));
      }
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
        action: cmd.action === 'ON' ? 'lamp.on' : cmd.action === 'OFF' ? 'lamp.off' : 'lamp.blink',
        entityType: 'table',
        entityId: cmd.table_id,
        data: { commandId: cmd.id, sessionId: cmd.session_id },
      });
      if (cmd.action === 'ON' && cmd.session_id) {
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
      record(db, now, {
        actor: SYSTEM,
        action: 'lamp.failed',
        entityType: 'table',
        entityId: cmd.table_id,
        data: { commandId: cmd.id, action: cmd.action, attempts, error: message },
      });
      // A missed warning blink says nothing about the light itself: no alarm.
      if (cmd.action === 'BLINK') return;
      run(db, "UPDATE lamp_states SET reported = 'UNKNOWN', updated_at = ? WHERE table_id = ?", now, cmd.table_id);
      const tableName =
        one<{ name: string }>(db, 'SELECT name FROM billiard_tables WHERE id = ?', cmd.table_id)?.name ?? cmd.table_id;

      let gameFailed = false;
      if (cmd.action === 'ON' && cmd.session_id) {
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
              : `${tableName}: лампа не подтвердила включение — проверьте свет на столе`,
      });
      // The lamp may have switched on without confirming: make sure it goes off.
      if (gameFailed) this.request(cmd.table_id, 'OFF', null);
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
