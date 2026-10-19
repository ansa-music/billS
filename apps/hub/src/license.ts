import type { LicenseGate, LicensePayload, LicenseResponse, LicenseStatus } from '@bills/domain';
import { licenseGateOf, licenseStatus, standaloneHubId, verifyLicense } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record, SYSTEM } from './journal.ts';
import { clubId } from './views.ts';

/**
 * The license of this branch (packages/domain license.ts).
 *
 * The signed text is kept in `license_state` and checked against the platform's
 * public keys when installed and on every start (`init`); routes only ever see
 * the copy verified in memory, so editing the database does not widen anything —
 * after a restart a changed row fails the signature and the club is read-only.
 * `high_water` is the latest time this HUB has seen: winding the clock back does
 * not bring an expired license back.
 *
 * Modes: `enforce` — the HUB refuses what the license does not allow (decide());
 * `off` — no limits (tests by default, the demo). Without options = off.
 */

export interface LicenseOptions {
  mode: 'enforce' | 'off';
  /** kid → raw Ed25519 public key (base64url): PLATFORM_LICENSE_PUBLIC_KEYS, plus DEV_LICENSE_KEY when allowed. */
  publicKeys: Readonly<Record<string, string>>;
  /** This HUB's id as licenses name it; default `club:<local club id>`. */
  hubId?: string;
}

export interface LicenseServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
  options?: LicenseOptions | undefined;
}

/** How often the high-water mark is written (it is kept in memory between writes). */
const HIGH_WATER_WRITE_MS = 60_000;

interface StateRow {
  signed: string | null;
  source: 'cloud' | 'manual' | null;
  installed_at: number | null;
  high_water: number;
}

export type InstallSource = 'cloud' | 'manual';

export class LicenseService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  #mode: 'enforce' | 'off';
  readonly #publicKeys: Readonly<Record<string, string>>;
  readonly #hubIdOption: string | undefined;
  /** The verified payload in force; null without one (or when the stored one failed the check). */
  #payload: LicensePayload | null = null;
  /** The stored text failed verifyLicense on start. */
  #invalid = false;
  #signed: string | null = null;
  #source: InstallSource | null = null;
  #installedAt: number | null = null;
  #highWater = 0;
  #highWaterWritten = 0;
  #initialized = false;

  constructor(deps: LicenseServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#mode = deps.options?.mode ?? 'off';
    this.#publicKeys = deps.options?.publicKeys ?? {};
    this.#hubIdOption = deps.options?.hubId || undefined;
  }

  /** Stops checking licenses (the demo, when a trial license cannot be made in this browser). */
  disable(): void {
    this.#mode = 'off';
  }

  /** Licenses are checked on this HUB. */
  get enforced(): boolean {
    return this.#mode === 'enforce';
  }

  get hubId(): string {
    return this.#hubIdOption ?? standaloneHubId(clubId(this.#db));
  }

  /** The signed text in force (as stored), or null. */
  get signed(): string | null {
    return this.#signed;
  }

  /** Reads and verifies the stored license. Call once before serving requests. */
  async init(): Promise<void> {
    const row = this.#row();
    this.#highWater = Math.max(row.high_water, 0);
    this.#highWaterWritten = this.#highWater;
    this.#signed = row.signed;
    this.#source = row.source;
    this.#installedAt = row.installed_at;
    this.#payload = null;
    this.#invalid = false;
    if (row.signed) {
      const check = await verifyLicense(row.signed, this.#publicKeys);
      if (check.ok) this.#payload = check.license;
      else this.#invalid = true;
    }
    this.#initialized = true;
  }

  /**
   * Checks and installs a signed license. 422 LICENSE_INVALID when the signature
   * does not hold, the license names other HUBs, or (pasted by hand) it is older
   * than the one in force — an old unblocked license must not undo a block.
   */
  async install(text: string, source: InstallSource, actor?: string): Promise<LicenseResponse> {
    const payload = await this.verify(text);
    return this.installVerified(text.trim(), payload, source, actor);
  }

  /** The asynchronous half of install: signature and shape. */
  async verify(text: string): Promise<LicensePayload> {
    const check = await verifyLicense(text.trim(), this.#publicKeys);
    if (!check.ok) throw new HubError(422, 'LICENSE_INVALID', check.message);
    return check.license;
  }

  /** The synchronous half: HUB id, age, storage and audit. `payload` must come from `verify(text)`. */
  installVerified(text: string, payload: LicensePayload, source: InstallSource, actor?: string): LicenseResponse {
    const now = this.#clock.now();
    if (!payload.hubIds.includes(this.hubId)) {
      throw new HubError(422, 'LICENSE_INVALID', 'Лицензия выдана для другого филиала (другого HUB)');
    }
    const current = this.#payload;
    if (source === 'manual' && current && current.companyId === payload.companyId && payload.issuedAt < current.issuedAt) {
      throw new HubError(422, 'LICENSE_INVALID', 'Эта лицензия старше установленной — вставьте последнюю выданную');
    }
    transaction(this.#db, () => {
      this.#bumpHighWater(now);
      run(
        this.#db,
        'UPDATE license_state SET signed = ?, source = ?, installed_at = ?, high_water = ? WHERE id = 1',
        text,
        source,
        now,
        this.#highWater,
      );
      this.#highWaterWritten = this.#highWater;
      record(this.#db, now, {
        actor: actor ?? (source === 'cloud' ? 'cloud' : SYSTEM),
        action: 'license.installed',
        entityType: 'license',
        entityId: payload.id,
        data: {
          source,
          companyId: payload.companyId,
          plan: payload.plan,
          validFrom: payload.validFrom,
          validUntil: payload.validUntil,
          blocked: payload.blocked,
          modules: payload.modules,
          maxTables: payload.maxTables,
          maxStaff: payload.maxStaff,
        },
      });
      afterCommit(this.#db, () => this.#events.changed({ kind: 'license' }));
    });
    this.#payload = payload;
    this.#invalid = false;
    this.#signed = text;
    this.#source = source;
    this.#installedAt = now;
    return this.response();
  }

  /** Where the license stands now (also when not enforced: what it would say). */
  status(): LicenseStatus {
    if (!this.#initialized) this.#initSync();
    const now = this.#clock.now();
    this.#bumpHighWater(now);
    if (this.#highWater - this.#highWaterWritten >= HIGH_WATER_WRITE_MS && this.#db.isOpen) {
      try {
        run(this.#db, 'UPDATE license_state SET high_water = MAX(high_water, ?) WHERE id = 1', this.#highWater);
        this.#highWaterWritten = this.#highWater;
      } catch {
        // Busy database: the mark stays in memory and is written next time.
      }
    }
    return licenseStatus(this.#payload, now, { hubId: this.hubId, highWater: this.#highWater, invalid: this.#invalid });
  }

  /** What the permission check needs; null when licenses are not enforced. */
  gate(): LicenseGate | null {
    return this.enforced ? licenseGateOf(this.status()) : null;
  }

  /** The status for HubState / MeResponse: null when not enforced. */
  shown(): LicenseStatus | null {
    return this.enforced ? this.status() : null;
  }

  /** Limits for staff and tables; null when not enforced or there is nothing to limit by. */
  limits(): { maxTables: number | null; maxStaff: number | null } | null {
    if (!this.enforced || !this.#payload) return null;
    return { maxTables: this.#payload.maxTables, maxStaff: this.#payload.maxStaff };
  }

  response(): LicenseResponse {
    return {
      status: this.status(),
      hubId: this.hubId,
      enforced: this.enforced,
      installedAt: this.#installedAt,
      source: this.#source,
    };
  }

  #bumpHighWater(now: number): void {
    if (now > this.#highWater) this.#highWater = now;
  }

  /**
   * Used only when someone forgot `init()` (tests with license off): the stored
   * text cannot be verified synchronously, so it counts as missing until init.
   */
  #initSync(): void {
    const row = this.#row();
    this.#highWater = Math.max(this.#highWater, row.high_water);
    this.#highWaterWritten = row.high_water;
    this.#signed = row.signed;
    this.#source = row.source;
    this.#installedAt = row.installed_at;
    this.#initialized = true;
  }

  #row(): StateRow {
    return (
      one<StateRow>(this.#db, 'SELECT signed, source, installed_at, high_water FROM license_state WHERE id = 1') ?? {
        signed: null,
        source: null,
        installed_at: null,
        high_water: 0,
      }
    );
  }
}
