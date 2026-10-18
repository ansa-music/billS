import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import { HubEvents } from './events.ts';
import { purgeIdempotencyKeys } from './idempotency.ts';
import { record } from './journal.ts';
import type { LampOptions } from './lamps/controller.ts';
import { LampController } from './lamps/controller.ts';
import type { LampDriver } from './lamps/driver.ts';
import { SessionService } from './sessions.ts';
import type { HubState } from './views.ts';
import { buildState } from './views.ts';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface HubDeps {
  db: Db;
  clock: Clock;
  lampDriver: LampDriver;
  lampOptions?: LampOptions;
  /** How often lamps in an unknown state are retried. */
  reconcileIntervalMs?: number;
}

/** The club server: wires storage, lamps and game rules together. */
export class Hub {
  readonly db: Db;
  readonly clock: Clock;
  readonly events = new HubEvents();
  readonly lamps: LampController;
  readonly sessions: SessionService;
  readonly #reconcileIntervalMs: number;
  #reconcileTimer: NodeJS.Timeout | undefined;

  constructor(deps: HubDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.#reconcileIntervalMs = deps.reconcileIntervalMs ?? 60_000;
    this.events.setMaxListeners(0);
    this.lamps = new LampController({
      db: deps.db,
      driver: deps.lampDriver,
      clock: deps.clock,
      events: this.events,
      ...(deps.lampOptions ? { options: deps.lampOptions } : {}),
    });
    this.sessions = new SessionService({ db: deps.db, clock: deps.clock, lamps: this.lamps, events: this.events });
  }

  /** Restores lamps and pending commands after a (re)start. */
  start(): void {
    purgeIdempotencyKeys(this.db, this.clock.now() - IDEMPOTENCY_TTL_MS);
    this.lamps.recover();
    this.#reconcileTimer = setInterval(() => this.lamps.reconcile(), this.#reconcileIntervalMs);
    this.#reconcileTimer.unref();
  }

  state(): HubState {
    return buildState(this.db, this.clock.now());
  }

  resolveAlert(alertId: string, actor: string): { id: string } {
    const now = this.clock.now();
    return transaction(this.db, () => {
      const changed = run(
        this.db,
        'UPDATE alerts SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL',
        now,
        actor,
        alertId,
      );
      if (!changed) throw new HubError(404, 'ALERT_NOT_FOUND', 'Тревога не найдена или уже закрыта');
      record(this.db, now, { actor, action: 'alert.resolved', entityType: 'alert', entityId: alertId, data: {} });
      afterCommit(this.db, () => this.events.changed({ kind: 'alert' }));
      return { id: alertId };
    });
  }

  close(): void {
    clearInterval(this.#reconcileTimer);
    this.lamps.close();
    this.events.removeAllListeners();
  }
}
