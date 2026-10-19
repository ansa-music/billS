import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import { afterCommit, all, run, transaction } from '../db.ts';
import type { HubEvents } from '../events.ts';
import { raiseAlert, record, SYSTEM } from '../journal.ts';
import type { LampController } from './controller.ts';
import type { LampDriver, LampState } from './driver.ts';

export interface MonitorOptions {
  /** How often every lamp is polled. 0 disables the monitor. */
  intervalMs: number;
  /** How long an anomaly must persist before staff and the owner are alerted. */
  alertAfterMs: number;
  /** Timeout of one readState call. */
  readTimeoutMs: number;
}

export const DEFAULT_MONITOR_OPTIONS: MonitorOptions = { intervalMs: 10_000, alertAfterMs: 60_000, readTimeoutMs: 3000 };

export type AnomalyKind = 'LIGHT_WITHOUT_GAME' | 'LAMP_DARK_DURING_GAME';

interface Anomaly {
  kind: AnomalyKind;
  since: number;
  alerted: boolean;
}

interface PollRow {
  table_id: string;
  name: string;
  lamp_channel: string;
  desired: 'ON' | 'OFF' | null;
  reported: 'ON' | 'OFF' | 'UNKNOWN' | null;
  /** The lamp is meant to blink steadily (paused game, tariff pauseLamp = 'blink'). */
  blink: number | null;
  session_id: string | null;
  session_status: 'OPENING' | 'ACTIVE' | null;
  /** The game is paused (an open row in session_pauses): its lamp is off or blinking by design. */
  paused: number;
  pending: number;
}

export interface PollResult {
  polled: number;
  unreachable: number;
}

/**
 * Periodically reads relays and current sensors through the driver and
 * compares them with the games:
 *
 *   light on, no game, for alertAfterMs   → LIGHT_WITHOUT_GAME (staff lighting a table for friends, bypass)
 *   game running, no current, alertAfterMs → LAMP_DARK_DURING_GAME (dead bulb, tripped breaker, bypass)
 *
 * A relay that disagrees with the desired state and has no command in flight
 * is told again once (audited); if the light still disagrees, the alert follows.
 * Lamps are never judged while a command is pending or in manual mode.
 */
export class LampMonitor {
  readonly #db: Db;
  readonly #driver: LampDriver;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #lamps: LampController;
  readonly #quiet: () => boolean;
  readonly #options: MonitorOptions;
  readonly #anomalies = new Map<string, Anomaly>();
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<PollResult> | undefined;
  #closed = false;

  constructor(deps: {
    db: Db;
    driver: LampDriver;
    clock: Clock;
    events: HubEvents;
    lamps: LampController;
    quiet?: () => boolean;
    options?: Partial<MonitorOptions>;
  }) {
    this.#db = deps.db;
    this.#driver = deps.driver;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#lamps = deps.lamps;
    this.#quiet = deps.quiet ?? (() => false);
    this.#options = { ...DEFAULT_MONITOR_OPTIONS, ...deps.options };
  }

  get options(): MonitorOptions {
    return this.#options;
  }

  /** The driver can be polled at all. */
  get supported(): boolean {
    return typeof this.#driver.readState === 'function';
  }

  start(): void {
    if (!this.supported || this.#options.intervalMs <= 0 || this.#timer) return;
    this.#timer = setInterval(() => void this.poll(), this.#options.intervalMs);
    this.#timer.unref?.();
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One round over every table. Concurrent calls share the same round. */
  poll(): Promise<PollResult> {
    if (!this.#polling) this.#polling = this.#poll().finally(() => (this.#polling = undefined));
    return this.#polling;
  }

  async #poll(): Promise<PollResult> {
    const readState = this.#driver.readState?.bind(this.#driver);
    if (!readState || this.#closed) return { polled: 0, unreachable: 0 };
    const rows = all<PollRow>(
      this.#db,
      `SELECT t.id AS table_id, t.name, t.lamp_channel, l.desired, l.reported, l.blink, s.id AS session_id, s.status AS session_status,
              EXISTS (SELECT 1 FROM session_pauses p WHERE p.session_id = s.id AND p.resumed_at IS NULL) AS paused,
              EXISTS (SELECT 1 FROM lamp_commands c WHERE c.table_id = t.id AND c.status = 'PENDING') AS pending
       FROM billiard_tables t
       LEFT JOIN lamp_states l ON l.table_id = t.id
       LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status IN ('OPENING', 'ACTIVE')
       WHERE t.is_active = 1
       ORDER BY t.sort_order, t.name`,
    );
    let unreachable = 0;
    const states = await Promise.all(
      rows.map(async (row) => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error(`No status within ${this.#options.readTimeoutMs} ms`)),
          this.#options.readTimeoutMs,
        );
        try {
          return await readState(row.lamp_channel, controller.signal);
        } catch {
          unreachable++;
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    if (this.#closed) return { polled: 0, unreachable };
    const now = this.#clock.now();
    const quiet = this.#quiet();
    transaction(this.#db, () => {
      rows.forEach((row, i) => {
        const state = states[i] ?? null;
        if (state) this.#observe(row, state, now, quiet);
        else this.#anomalies.delete(row.table_id);
      });
    });
    return { polled: rows.length - unreachable, unreachable };
  }

  #observe(row: PollRow, state: LampState, now: number, quiet: boolean): void {
    const db = this.#db;
    const currentOn = state.currentOn === undefined ? null : state.currentOn ? 1 : 0;
    run(
      db,
      `INSERT INTO lamp_states (table_id, desired, reported, updated_at, polled_on, current_on, polled_at)
       VALUES (?, 'OFF', 'UNKNOWN', ?, ?, ?, ?)
       ON CONFLICT (table_id) DO UPDATE SET polled_on = excluded.polled_on, current_on = excluded.current_on, polled_at = excluded.polled_at`,
      row.table_id,
      now,
      state.on ? 1 : 0,
      currentOn,
      now,
    );
    const desired = row.desired ?? 'OFF';
    const actual = state.on ? 'ON' : 'OFF';
    const busy = row.pending === 1 || row.session_status === 'OPENING';

    // The controller is back after a failure: what it reports is the truth now.
    if (!busy && row.reported === 'UNKNOWN' && actual === desired) {
      run(db, 'UPDATE lamp_states SET reported = ?, reported_at = ?, updated_at = ? WHERE table_id = ?', actual, now, now, row.table_id);
      afterCommit(db, () => this.#events.changed({ kind: 'lamp', tableId: row.table_id }));
    }

    if (busy || quiet) {
      this.#anomalies.delete(row.table_id);
      return;
    }

    const lit = state.currentOn ?? state.on;
    // A paused game has its lamp off (or blinking) on purpose: only a running game must be lit.
    const running = row.session_status === 'ACTIVE' && row.paused !== 1 && row.blink !== 1;
    let kind: AnomalyKind | null = null;
    if (running && !lit) kind = 'LAMP_DARK_DURING_GAME';
    else if (row.session_status === null && lit) kind = 'LIGHT_WITHOUT_GAME';

    if (kind === null) {
      this.#anomalies.delete(row.table_id);
      return;
    }

    let anomaly = this.#anomalies.get(row.table_id);
    if (!anomaly || anomaly.kind !== kind) {
      anomaly = { kind, since: now, alerted: false };
      this.#anomalies.set(row.table_id, anomaly);
      // First sight: the relay itself disagrees with what the HUB wants — tell it again.
      if (actual !== desired) {
        record(db, now, {
          actor: SYSTEM,
          action: 'lamp.mismatch',
          entityType: 'table',
          entityId: row.table_id,
          data: { desired, relay: actual, currentOn: state.currentOn ?? null, sessionId: row.session_id },
        });
        this.#lamps.request(row.table_id, desired, row.session_id, { blink: row.blink === 1 });
      }
      return;
    }

    if (anomaly.alerted || now - anomaly.since < this.#options.alertAfterMs) return;
    anomaly.alerted = true;
    const minutes = Math.max(1, Math.round((now - anomaly.since) / 60_000));
    record(db, now, {
      actor: SYSTEM,
      action: kind === 'LIGHT_WITHOUT_GAME' ? 'lamp.light_without_game' : 'lamp.dark_during_game',
      entityType: 'table',
      entityId: row.table_id,
      data: { since: anomaly.since, relay: actual, currentOn: state.currentOn ?? null, sessionId: row.session_id },
    });
    raiseAlert(db, now, {
      kind,
      tableId: row.table_id,
      sessionId: row.session_id,
      message:
        kind === 'LIGHT_WITHOUT_GAME'
          ? `${row.name}: свет горит без игры уже ${minutes} мин — проверьте стол`
          : `${row.name}: идёт игра, а лампа не горит — проверьте лампу и щиток`,
    });
    afterCommit(db, () => this.#events.changed({ kind: 'alert', tableId: row.table_id }));
  }
}
