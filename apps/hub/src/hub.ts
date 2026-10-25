import { can } from '@bills/domain';
import type { Actor } from './auth.ts';
import { AuthService } from './auth.ts';
import { BarService } from './bar.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import { HubEvents } from './events.ts';
import type { GuardSettings, GuardSettingsPatch } from '@bills/domain';
import { getGuardSettings, guardManualMode, guardStaffNames, guardTableOpened, setGuardSettings } from './guard.ts';
import type { LicenseOptions } from './license.ts';
import { LicenseService } from './license.ts';
import { purgeIdempotencyKeys } from './idempotency.ts';
import { record } from './journal.ts';
import type { LampOptions } from './lamps/controller.ts';
import { DEFAULT_BLINK_TIMES, LampController } from './lamps/controller.ts';
import type { LampDriver } from './lamps/driver.ts';
import type { MonitorOptions } from './lamps/monitor.ts';
import { LampMonitor } from './lamps/monitor.ts';
import type { PowerActions, PowerOptions, PowerSettings } from './power/monitor.ts';
import { PowerMonitor, setPowerSettings } from './power/monitor.ts';
import type { UpsSource } from './power/ups.ts';
import { CheckService } from './checks.ts';
import { CounterService } from './counter.ts';
import { PrepaidService } from './prepaid.ts';
import { ReportService } from './reports.ts';
import type { StopSessionInput } from './sessions.ts';
import { SessionService } from './sessions.ts';
import { SettingsService } from './settings.ts';
import { ShiftService } from './shifts.ts';
import { StaffService } from './staff.ts';
import type { ManualMode } from './manual-mode.ts';
import { getManualMode, isManualMode, managerMatcher, setManualMode } from './manual-mode.ts';
import type { SyncOptions } from './sync.ts';
import { SyncWorker, syncStatus } from './sync.ts';
import type { HubState, SessionView } from './views.ts';
import { buildState, loadSession } from './views.ts';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_BLINK_TIMES = 10;

export interface HubDeps {
  db: Db;
  clock: Clock;
  lampDriver: LampDriver;
  lampOptions?: LampOptions;
  /** Relay/current-sensor poll; intervalMs 0 disables it. */
  monitorOptions?: Partial<MonitorOptions>;
  /** How often lamps in an unknown state are retried. */
  reconcileIntervalMs?: number;
  /** Who may switch manual mode off. Default: the X-Actor "Управляющий". */
  isManager?: (actor: string) => boolean;
  /** The club's UPS (HUB_UPS); null — no power monitoring. */
  ups?: UpsSource | null;
  powerOptions?: Partial<PowerOptions>;
  /**
   * What to do with running games on power loss. Default: the pause service —
   * every running game gets a `power` pause, resumed when the mains are back.
   * Tests may inject a fake.
   */
  powerActions?: PowerActions;
  /** Cloud sync (stage 6); omitted = standalone club, the outbox just accumulates. */
  sync?: SyncOptions;
  /** Licenses (packages/domain license.ts); omitted = not enforced (tests, demo). Call `hub.license.init()` before serving. */
  license?: LicenseOptions;
  /** Public demo club: four-digit demo keys and a softer login throttle (never on a real club). */
  demo?: boolean;
  /** How often «Сторож» checks timed rules (manual lamp mode left on). 0 disables the timer. Default 30 s. */
  guardIntervalMs?: number;
}

/** The club server: wires storage, lamps and game rules together. */
export class Hub {
  readonly db: Db;
  readonly clock: Clock;
  readonly events = new HubEvents();
  readonly lamps: LampController;
  readonly monitor: LampMonitor;
  readonly power: PowerMonitor;
  readonly sessions: SessionService;
  readonly checks: CheckService;
  readonly shifts: ShiftService;
  readonly sync: SyncWorker | undefined;
  readonly prepaid: PrepaidService;
  /** Club, tables, tariffs, display and rules. */
  readonly settings: SettingsService;
  /** Bar catalog and orders on games. */
  readonly bar: BarService;
  /** Coffee shop counter: orders without a game, their stages and the guest screen. */
  readonly counter: CounterService;
  /** Staff, roles, PINs, audit log. */
  readonly staff: StaffService;
  /** Owner summary. */
  readonly reports: ReportService;
  /** Access keys and login sessions. */
  readonly auth: AuthService;
  /** The branch's license: what the HUB allows (decide) and the banner. */
  readonly license: LicenseService;
  readonly #reconcileIntervalMs: number;
  readonly #isManager: (actor: string) => boolean;
  readonly #guardIntervalMs: number;
  #reconcileTimer: NodeJS.Timeout | undefined;
  #guardTimer: NodeJS.Timeout | undefined;

  constructor(deps: HubDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.#reconcileIntervalMs = deps.reconcileIntervalMs ?? 60_000;
    this.#isManager = deps.isManager ?? managerMatcher(['Управляющий']);
    this.#guardIntervalMs = deps.guardIntervalMs ?? 30_000;
    this.events.setMaxListeners(0);
    const quiet = () => isManualMode(this.db);
    this.lamps = new LampController({
      db: deps.db,
      driver: deps.lampDriver,
      clock: deps.clock,
      events: this.events,
      quiet,
      ...(deps.lampOptions ? { options: deps.lampOptions } : {}),
    });
    this.monitor = new LampMonitor({
      db: deps.db,
      driver: deps.lampDriver,
      clock: deps.clock,
      events: this.events,
      lamps: this.lamps,
      quiet,
      ...(deps.monitorOptions ? { options: deps.monitorOptions } : {}),
    });
    this.sessions = new SessionService({ db: deps.db, clock: deps.clock, lamps: this.lamps, events: this.events });
    // On power loss the monitor pauses every running game (reason `power`) and resumes them on mains.
    const powerActions: PowerActions = deps.powerActions ?? {
      pauseAll: (at, reason) => this.sessions.pauseAll({ reason, now: at }),
      resumeAll: (at, reason) => this.sessions.resumeAll({ reason, now: at }),
    };
    this.power = new PowerMonitor({
      db: deps.db,
      source: deps.ups ?? null,
      clock: deps.clock,
      events: this.events,
      actions: powerActions,
      ...(deps.powerOptions ? { options: deps.powerOptions } : {}),
    });
    this.checks = new CheckService({ db: deps.db, clock: deps.clock, events: this.events, sessions: this.sessions });
    this.shifts = new ShiftService({ db: deps.db, clock: deps.clock, events: this.events });
    this.license = new LicenseService({ db: deps.db, clock: deps.clock, events: this.events, options: deps.license });
    this.sync = deps.sync
      ? new SyncWorker({ db: deps.db, clock: deps.clock, events: this.events, license: this.license, ...deps.sync })
      : undefined;
    this.prepaid = new PrepaidService({
      db: deps.db,
      clock: deps.clock,
      events: this.events,
      sessions: this.sessions,
      checks: this.checks,
      lamps: this.lamps,
    });
    const common = { db: deps.db, clock: deps.clock, events: this.events };
    const limits = () => this.license.limits();
    this.settings = new SettingsService({ ...common, limits });
    this.bar = new BarService(common);
    this.counter = new CounterService({ ...common, checks: this.checks });
    this.staff = new StaffService({ ...common, limits });
    this.reports = new ReportService(common);
    this.auth = new AuthService({ ...common, demo: deps.demo === true });
    // «Сторож»: a game opened on a table right after the previous one stopped.
    this.events.on('changed', (e) => {
      if (e.kind === 'session' && e.tableId) this.#guardTable(e.tableId);
    });
  }

  /** «Сторож»: timed rules (manual lamp mode left on too long). The timer calls it; tests may too. */
  guardTick(): string | null {
    const raised = transaction(this.db, () => guardManualMode(this.db, this.clock.now()));
    if (raised) this.events.changed({ kind: 'alert' });
    return raised;
  }

  #guardTable(tableId: string): void {
    const raised = transaction(this.db, () => guardTableOpened(this.db, this.clock.now(), tableId));
    if (raised) this.events.changed({ kind: 'alert', tableId });
  }

  guardSettings(): GuardSettings {
    return getGuardSettings(this.db);
  }

  setGuardSettings(actor: string, patch: GuardSettingsPatch): GuardSettings {
    return setGuardSettings(this.db, this.clock.now(), this.events, actor, patch);
  }

  /** Restores lamps and pending commands after a (re)start. */
  start(): void {
    purgeIdempotencyKeys(this.db, this.clock.now() - IDEMPOTENCY_TTL_MS);
    this.lamps.recover();
    this.prepaid.start();
    this.#reconcileTimer = setInterval(() => this.lamps.reconcile(), this.#reconcileIntervalMs);
    // `?.`: the in-browser demo (apps/web/src/demo-hub) runs the HUB with browser timers, which have no unref.
    this.#reconcileTimer.unref?.();
    if (this.#guardIntervalMs > 0) {
      this.#guardTimer = setInterval(() => this.guardTick(), this.#guardIntervalMs);
      this.#guardTimer.unref?.();
    }
    this.monitor.start();
    this.power.start();
    this.sync?.start();
  }

  /** Stop from staff: a game paid upfront closes in the same transaction, so the reply already says so. */
  stopGame(input: StopSessionInput): SessionView {
    return transaction(this.db, () => {
      this.sessions.stop(input);
      this.prepaid.settleStopped(input.sessionId);
      return loadSession(this.db, input.sessionId, this.clock.now());
    });
  }

  /** `staffNames`: managers also see who is behind a «Сторож» alert (never part of the push text). */
  state(options: { staffNames?: boolean } = {}): HubState {
    const state = buildState(
      this.db,
      this.clock.now(),
      this.power.view(),
      this.sync ? this.sync.status() : syncStatus(this.db, false),
      this.license.shown(),
    );
    if (!options.staffNames || state.alerts.length === 0) return state;
    const names = guardStaffNames(this.db);
    return { ...state, alerts: state.alerts.map((a) => (names.has(a.id) ? { ...a, staff: names.get(a.id) ?? null } : a)) };
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

  /**
   * Flashes the lamp of a table: a hardware check from the screen, and the
   * "time is ending" warning for prepaid games (stage 2 calls it).
   */
  blink(tableId: string, actor: string, times = DEFAULT_BLINK_TIMES): { commandId: string; tableId: string; times: number } {
    if (!Number.isInteger(times) || times < 1 || times > MAX_BLINK_TIMES) {
      throw new HubError(422, 'BLINK_TIMES', `Число миганий — от 1 до ${MAX_BLINK_TIMES}`);
    }
    const now = this.clock.now();
    return transaction(this.db, () => {
      const table = one<{ id: string; name: string }>(
        this.db,
        'SELECT id, name FROM billiard_tables WHERE id = ? AND is_active = 1',
        tableId,
      );
      if (!table) throw new HubError(404, 'TABLE_NOT_FOUND', 'Стол не найден');
      const live = one<{ id: string }>(
        this.db,
        "SELECT id FROM table_sessions WHERE table_id = ? AND status IN ('OPENING', 'ACTIVE')",
        tableId,
      );
      record(this.db, now, {
        actor,
        action: 'lamp.blink_requested',
        entityType: 'table',
        entityId: tableId,
        data: { times, sessionId: live?.id ?? null },
      });
      const commandId = this.lamps.blink(tableId, live?.id ?? null, times);
      afterCommit(this.db, () => this.events.changed({ kind: 'lamp', tableId }));
      return { commandId, tableId, times };
    });
  }

  manualMode(): ManualMode {
    return getManualMode(this.db);
  }

  /**
   * Switches the emergency manual mode. Only a manager may switch it off: a
   * signed-in employee is judged by role (`lamps.manual_off`), a name-only actor
   * (tests, HUB_MANAGER_ACTORS) by the name matcher.
   */
  setManualMode(input: { enabled: boolean; reason?: string | undefined; actor: string; by?: Actor | undefined }): ManualMode {
    const by = input.by;
    const isManager = (name: string) => (by && by.id !== null ? can(by.roles, 'lamps.manual_off') : this.#isManager(name));
    const mode = setManualMode(this.db, this.clock.now(), this.events, {
      enabled: input.enabled,
      reason: input.reason,
      actor: input.actor,
      isManager,
    });
    // Leaving manual mode: the controller is back — resync lamps right away.
    if (!input.enabled) {
      this.lamps.reconcile();
      this.lamps.kick();
    }
    return mode;
  }

  /** Club setting: pause games automatically while the club is on battery. */
  setPowerSettings(actor: string, patch: Partial<PowerSettings>): PowerSettings {
    return setPowerSettings(this.db, this.clock.now(), this.events, actor, patch);
  }

  close(): void {
    clearInterval(this.#reconcileTimer);
    clearInterval(this.#guardTimer);
    this.prepaid.close();
    this.power.close();
    this.monitor.close();
    this.sync?.stop();
    this.lamps.close();
    this.events.removeAllListeners();
  }
}
