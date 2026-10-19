import type { PowerView } from '@bills/domain';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import { afterCommit, one, run, transaction } from '../db.ts';
import type { HubEvents } from '../events.ts';
import { raiseAlert, record, SYSTEM } from '../journal.ts';
import type { UpsReading, UpsSource } from './ups.ts';

export interface PowerOptions {
  /** How often the UPS is read. 0 disables the monitor. */
  intervalMs: number;
  /** Battery charge below this (while on battery) is critical. */
  criticalPercent: number;
  /** Consecutive failed readings before the UPS counts as unreachable. */
  unreachableAfter: number;
  /** Timeout of one reading. */
  readTimeoutMs: number;
}

export const DEFAULT_POWER_OPTIONS: PowerOptions = {
  intervalMs: 5000,
  criticalPercent: 20,
  unreachableAfter: 3,
  readTimeoutMs: 3000,
};

/**
 * What the HUB does with running games when the mains fail. The pause
 * mechanism (stage 1) plugs in here; without it the monitor only alerts.
 */
export interface PowerActions {
  /** Pauses every running game; returns the ids paused. */
  pauseAll(at: number, reason: 'power'): string[];
  /** Resumes the games paused by `pauseAll`; returns the ids resumed. */
  resumeAll(at: number, reason: 'power'): string[];
}

/** Club setting: pause games automatically while on battery. Off by default. */
export interface PowerSettings {
  autoPauseOnPowerLoss: boolean;
}

const SETTINGS_KEY = 'power';
const DEFAULT_SETTINGS: PowerSettings = { autoPauseOnPowerLoss: false };

export function getPowerSettings(db: Db): PowerSettings {
  const row = one<{ value: string }>(db, 'SELECT value FROM hub_settings WHERE key = ?', SETTINGS_KEY);
  if (!row) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<PowerSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function setPowerSettings(
  db: Db,
  now: number,
  events: HubEvents,
  actor: string,
  patch: Partial<PowerSettings>,
): PowerSettings {
  return transaction(db, () => {
    const next = { ...getPowerSettings(db), ...patch };
    run(
      db,
      `INSERT INTO hub_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      SETTINGS_KEY,
      JSON.stringify(next),
      now,
      actor,
    );
    record(db, now, { actor, action: 'power.settings_changed', entityType: 'hub', entityId: 'hub', data: { ...next } });
    afterCommit(db, () => events.changed({ kind: 'settings' }));
    return next;
  });
}

/**
 * Polls the UPS and turns readings into alerts, audit records and (if the
 * club asked for it) automatic pauses:
 *
 *   mains → battery          POWER_ON_BATTERY alert, audit, optional pauseAll
 *   charge < critical        POWER_CRITICAL alert, audit (once per outage)
 *   battery → mains          audit, power alerts resolved, games resumed
 *   N failed readings        UPS_UNREACHABLE alert, audit
 */
export class PowerMonitor {
  readonly #db: Db;
  readonly #source: UpsSource | null;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #actions: PowerActions;
  readonly #options: PowerOptions;
  #timer: NodeJS.Timeout | undefined;
  #polling: Promise<PowerView> | undefined;
  #closed = false;

  // Live state (the UPS is not persisted: after a restart the first reading decides).
  #last: UpsReading | null = null;
  #checkedAt: number | null = null;
  #onBatterySince: number | null = null;
  #criticalRaised = false;
  #failures = 0;
  #unreachableRaised = false;
  #autoPaused: string[] = [];

  constructor(deps: {
    db: Db;
    source: UpsSource | null;
    clock: Clock;
    events: HubEvents;
    actions: PowerActions;
    options?: Partial<PowerOptions>;
  }) {
    this.#db = deps.db;
    this.#source = deps.source;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#actions = deps.actions;
    this.#options = { ...DEFAULT_POWER_OPTIONS, ...deps.options };
  }

  get options(): PowerOptions {
    return this.#options;
  }

  get configured(): boolean {
    return this.#source !== null;
  }

  start(): void {
    if (!this.#source || this.#options.intervalMs <= 0 || this.#timer) return;
    this.#timer = setInterval(() => void this.poll(), this.#options.intervalMs);
    this.#timer.unref?.();
    void this.poll();
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** What screens and /api/health show. */
  view(): PowerView {
    const settings = getPowerSettings(this.#db);
    const l = this.#last;
    return {
      configured: this.#source !== null,
      source: this.#source?.kind ?? null,
      label: this.#source?.label ?? null,
      reachable: this.#source !== null && this.#failures < this.#options.unreachableAfter && l !== null,
      onBattery: l?.onBattery ?? false,
      chargePercent: l?.chargePercent ?? null,
      runtimeSeconds: l?.runtimeSeconds ?? null,
      status: l?.status ?? null,
      model: l?.model ?? null,
      checkedAt: this.#checkedAt,
      onBatterySince: this.#onBatterySince,
      critical: this.#criticalRaised,
      autoPausedSessions: this.#autoPaused.length,
      settings,
    };
  }

  /** One reading. Concurrent calls share it. */
  poll(): Promise<PowerView> {
    if (!this.#polling) this.#polling = this.#poll().finally(() => (this.#polling = undefined));
    return this.#polling;
  }

  async #poll(): Promise<PowerView> {
    const source = this.#source;
    if (!source || this.#closed) return this.view();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`No UPS answer within ${this.#options.readTimeoutMs} ms`)),
      this.#options.readTimeoutMs,
    );
    let reading: UpsReading | null = null;
    let error: string | null = null;
    try {
      reading = await source.read(controller.signal);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (this.#closed) return this.view();
    const now = this.#clock.now();
    transaction(this.#db, () => {
      if (reading) this.#observe(reading, now);
      else this.#failed(error ?? 'unknown error', now);
    });
    return this.view();
  }

  #failed(message: string, now: number): void {
    this.#failures++;
    if (this.#failures !== this.#options.unreachableAfter || this.#unreachableRaised) return;
    this.#unreachableRaised = true;
    const db = this.#db;
    record(db, now, {
      actor: SYSTEM,
      action: 'power.ups_unreachable',
      entityType: 'hub',
      entityId: 'hub',
      data: { source: this.#source?.label ?? null, failures: this.#failures, error: message },
    });
    raiseAlert(db, now, {
      kind: 'UPS_UNREACHABLE',
      tableId: null,
      sessionId: null,
      message: `ИБП не отвечает (${this.#source?.label ?? ''}) — HUB не узнает об отключении света; проверьте кабель и службу ИБП`,
    });
    afterCommit(db, () => this.#events.changed({ kind: 'alert' }));
  }

  #observe(reading: UpsReading, now: number): void {
    const db = this.#db;
    const wasOnBattery = this.#last?.onBattery ?? false;
    const wasReachable = this.#failures < this.#options.unreachableAfter && this.#last !== null;
    this.#last = reading;
    this.#checkedAt = now;
    this.#failures = 0;
    let changed = false;

    if (this.#unreachableRaised) {
      this.#unreachableRaised = false;
      this.#resolve('UPS_UNREACHABLE', now);
      record(db, now, { actor: SYSTEM, action: 'power.ups_reachable', entityType: 'hub', entityId: 'hub', data: { ...reading } });
      changed = true;
    }

    if (reading.onBattery && !wasOnBattery) {
      this.#onBatterySince = now;
      this.#criticalRaised = false;
      record(db, now, {
        actor: SYSTEM,
        action: 'power.on_battery',
        entityType: 'hub',
        entityId: 'hub',
        data: { chargePercent: reading.chargePercent, runtimeSeconds: reading.runtimeSeconds, status: reading.status },
      });
      raiseAlert(db, now, {
        kind: 'POWER_ON_BATTERY',
        tableId: null,
        sessionId: null,
        message: `Нет электричества: HUB работает от ИБП${describe(reading)}. Лампы над столами погасли — остановите или поставьте игры на паузу`,
      });
      if (getPowerSettings(db).autoPauseOnPowerLoss) {
        const paused = this.#actions.pauseAll(now, 'power');
        this.#autoPaused = paused;
        record(db, now, {
          actor: SYSTEM,
          action: 'power.auto_paused',
          entityType: 'hub',
          entityId: 'hub',
          data: { sessionIds: paused },
        });
      }
      changed = true;
    }

    if (reading.onBattery && !this.#criticalRaised && reading.chargePercent !== null && reading.chargePercent < this.#options.criticalPercent) {
      this.#criticalRaised = true;
      record(db, now, {
        actor: SYSTEM,
        action: 'power.critical',
        entityType: 'hub',
        entityId: 'hub',
        data: { chargePercent: reading.chargePercent, runtimeSeconds: reading.runtimeSeconds, since: this.#onBatterySince },
      });
      raiseAlert(db, now, {
        kind: 'POWER_CRITICAL',
        tableId: null,
        sessionId: null,
        message: `Батарея ИБП почти разряжена (${reading.chargePercent}%${
          reading.runtimeSeconds !== null ? `, ≈${Math.max(1, Math.round(reading.runtimeSeconds / 60))} мин` : ''
        }) — остановите все игры сейчас, пока HUB работает`,
      });
      changed = true;
    }

    if (!reading.onBattery && wasOnBattery) {
      const outageMs = this.#onBatterySince === null ? null : now - this.#onBatterySince;
      record(db, now, {
        actor: SYSTEM,
        action: 'power.restored',
        entityType: 'hub',
        entityId: 'hub',
        data: { since: this.#onBatterySince, outageMs, chargePercent: reading.chargePercent, critical: this.#criticalRaised },
      });
      this.#resolve('POWER_ON_BATTERY', now);
      this.#resolve('POWER_CRITICAL', now);
      if (this.#autoPaused.length > 0) {
        const resumed = this.#actions.resumeAll(now, 'power');
        record(db, now, {
          actor: SYSTEM,
          action: 'power.auto_resumed',
          entityType: 'hub',
          entityId: 'hub',
          data: { sessionIds: resumed },
        });
        this.#autoPaused = [];
      }
      this.#onBatterySince = null;
      this.#criticalRaised = false;
      changed = true;
    }

    if (changed || !wasReachable) afterCommit(db, () => this.#events.changed({ kind: 'power' }));
  }

  /** Closes an open alert of a kind: the condition is gone. */
  #resolve(kind: string, now: number): void {
    run(
      this.#db,
      'UPDATE alerts SET resolved_at = ?, resolved_by = ? WHERE kind = ? AND table_id IS NULL AND resolved_at IS NULL',
      now,
      SYSTEM,
      kind,
    );
  }
}

function describe(r: UpsReading): string {
  const parts: string[] = [];
  if (r.chargePercent !== null) parts.push(`заряд ${Math.round(r.chargePercent)}%`);
  if (r.runtimeSeconds !== null) parts.push(`≈${Math.max(1, Math.round(r.runtimeSeconds / 60))} мин`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
