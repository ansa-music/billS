import { createHash } from 'node:crypto';
import type {
  BusinessType,
  ClubSnapshot,
  SyncAccessResponse,
  SyncEvent,
  SyncEventPayload,
  SyncEventsRequest,
  SyncEventsResponse,
  SyncSettingsResponse,
  SyncSnapshotRequest,
  SyncSnapshotResponse,
  SyncStatus,
  TableSetting,
  TariffSetting,
  TariffConfig,
} from '@bills/domain';
import { BUSINESS_TYPES, isValidTimeZone, normalizeRoles, primaryRole, validateTariff } from '@bills/domain';
import { scopeOf } from './auth.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { LicenseService } from './license.ts';
import { clubId, loadSettings } from './views.ts';

/**
 * HUB → cloud sync (stage 6). One worker per HUB:
 *  1. POST /sync/snapshot when the local settings changed since the cloud last accepted them;
 *  2. POST /sync/events with up to BATCH undelivered outbox rows (an empty batch is a heartbeat);
 *  3. GET /sync/settings when the cloud reports a newer settings version, then `applySettings`;
 *  4. GET /sync/access when the cloud's access version differs from the one applied, then
 *     `applyAccess` (people and keys of this branch) and the license from the package.
 * Errors back off exponentially (interval × 2^n, at most 5 minutes); a success resets the pause.
 */

const BATCH = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAUSE_MS = 5 * 60_000;
const CLOUD_ACTOR = 'cloud';

export interface SyncLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** What the config provides; `Hub` adds db, clock and events. */
export interface SyncOptions {
  url: string;
  apiKey: string;
  hubId: string;
  /** Push/heartbeat period; also the base of the error back-off. Default 10 s. */
  intervalMs?: number;
  /** Debounce of `kick()` after a local change. Default 1 s. */
  kickDelayMs?: number;
  fetch?: typeof fetch;
  logger?: SyncLogger;
}

export interface SyncWorkerDeps extends SyncOptions {
  db: Db;
  clock: Clock;
  events: HubEvents;
  /** Installs the license that comes with the access package. */
  license?: LicenseService;
}

interface SyncStateRow {
  settings_version: number;
  settings_hash: string | null;
  last_sent_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

function readSyncState(db: Db): SyncStateRow {
  const row = one<SyncStateRow>(
    db,
    'SELECT settings_version, settings_hash, last_sent_at, last_error, last_error_at FROM sync_state WHERE id = 1',
  );
  if (!row) throw new Error('sync_state is missing: migration 009 not applied');
  return row;
}

/** Status as shown in GET /api/state; `enabled` is decided by the caller. */
export function syncStatus(db: Db, enabled: boolean): SyncStatus {
  const st = readSyncState(db);
  const pending = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL')?.n ?? 0;
  return {
    enabled,
    lastSentAt: st.last_sent_at,
    pending,
    lastError: st.last_error,
    lastErrorAt: st.last_error_at,
    settingsVersion: st.settings_version,
  };
}

export type LocalSnapshot = Omit<SyncSnapshotRequest, 'hubId'>;

/** The club's own settings as the cloud wants to see them (inactive rows included). */
export function localSnapshot(db: Db): LocalSnapshot {
  const club = one<{ id: string; name: string; timezone: string; currency: string }>(
    db,
    'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1',
  );
  if (!club) throw new Error('Клуб не настроен');
  const tariffs = all<{ id: string; name: string; config: string; is_active: number }>(
    db,
    'SELECT id, name, config, is_active FROM tariffs WHERE club_id = ? ORDER BY name, id',
    club.id,
  ).map<TariffSetting>((t) => ({
    id: t.id,
    name: t.name,
    config: JSON.parse(t.config) as TariffConfig,
    isActive: t.is_active === 1,
  }));
  const tables = all<{
    id: string;
    name: string;
    kind: TableSetting['kind'];
    lamp_channel: string;
    default_tariff_id: string;
    sort_order: number;
    is_active: number;
  }>(
    db,
    `SELECT id, name, kind, lamp_channel, default_tariff_id, sort_order, is_active
     FROM billiard_tables WHERE club_id = ? ORDER BY sort_order, name, id`,
    club.id,
  ).map<TableSetting>((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    lampChannel: t.lamp_channel,
    defaultTariffId: t.default_tariff_id,
    sortOrder: t.sort_order,
    isActive: t.is_active === 1,
  }));
  return {
    settingsVersion: readSyncState(db).settings_version,
    club: { name: club.name, timezone: club.timezone, currency: club.currency },
    tariffs,
    tables,
  };
}

export function settingsHash(snapshot: LocalSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

const TABLE_KINDS = new Set<TableSetting['kind']>(['pool', 'russian', 'snooker']);

/**
 * Applies settings received from the cloud in one transaction: tariffs and tables are upserted
 * (tables missing from the package are deactivated, never deleted), the club row is updated,
 * `cloud.settings_applied` is recorded and `sync_state.settings_version` advanced.
 * Any invalid tariff or table rejects the whole package — nothing is applied partially.
 * Running games keep their tariff snapshot and are not repriced.
 */
export function applySettings(db: Db, now: number, settings: ClubSnapshot, events?: HubEvents): void {
  transaction(db, () => {
    const club = one<{ id: string; timezone: string }>(db, 'SELECT id, timezone FROM clubs ORDER BY created_at LIMIT 1');
    if (!club) throw new Error('Клуб не настроен');
    const timezone = settings.club?.timezone ?? club.timezone;
    if (!isValidTimeZone(timezone)) throw new Error(`Настройки из облака: неизвестный часовой пояс ${timezone}`);

    for (const t of settings.tariffs) {
      if (!t.id || !t.name) throw new Error('Настройки из облака: у тарифа нет id или имени');
      const errors = validateTariff(t.config, timezone);
      if (errors.length) throw new Error(`Настройки из облака: тариф «${t.name}» некорректен: ${errors.join('; ')}`);
    }
    const tariffIds = new Set(settings.tariffs.map((t) => t.id));
    for (const t of settings.tables) {
      if (!t.id || !t.name) throw new Error('Настройки из облака: у стола нет id или имени');
      if (!TABLE_KINDS.has(t.kind)) throw new Error(`Настройки из облака: стол «${t.name}»: неизвестный тип ${t.kind}`);
      if (!t.lampChannel) throw new Error(`Настройки из облака: стол «${t.name}» без канала лампы`);
      if (!tariffIds.has(t.defaultTariffId) && !one(db, 'SELECT id FROM tariffs WHERE id = ?', t.defaultTariffId)) {
        throw new Error(`Настройки из облака: стол «${t.name}» ссылается на неизвестный тариф`);
      }
    }

    for (const t of settings.tariffs) {
      run(
        db,
        `INSERT INTO tariffs (id, club_id, name, config, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, config = excluded.config, is_active = excluded.is_active, updated_at = excluded.updated_at`,
        t.id,
        club.id,
        t.name,
        JSON.stringify(t.config),
        t.isActive ? 1 : 0,
        now,
        now,
      );
    }

    // An empty table list means the cloud has no snapshot yet (the HUB sends one next);
    // it must not switch off the hall.
    if (settings.tables.length > 0) {
      for (const t of settings.tables) {
        run(
          db,
          `INSERT INTO billiard_tables (id, club_id, name, kind, lamp_channel, default_tariff_id, sort_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name, kind = excluded.kind, lamp_channel = excluded.lamp_channel,
             default_tariff_id = excluded.default_tariff_id, sort_order = excluded.sort_order, is_active = excluded.is_active`,
          t.id,
          club.id,
          t.name,
          t.kind,
          t.lampChannel,
          t.defaultTariffId,
          t.sortOrder,
          t.isActive ? 1 : 0,
        );
      }
      const keep = settings.tables.map((t) => t.id);
      run(
        db,
        `UPDATE billiard_tables SET is_active = 0
         WHERE club_id = ? AND is_active = 1 AND id NOT IN (${keep.map(() => '?').join(', ')})`,
        club.id,
        ...keep,
      );
    }

    if (settings.club) {
      run(
        db,
        'UPDATE clubs SET name = ?, timezone = ?, currency = ? WHERE id = ?',
        settings.club.name,
        timezone,
        settings.club.currency,
        club.id,
      );
    }

    // What the club is (billiards / coffee shop), as chosen at sign-up in the cabinet.
    const businessType = businessTypeOf(settings);
    const businessChanged = writeBusinessType(db, club.id, businessType);

    record(db, now, {
      actor: CLOUD_ACTOR,
      action: 'cloud.settings_applied',
      entityType: 'club',
      entityId: club.id,
      data: {
        version: settings.version,
        tariffs: settings.tariffs.length,
        tables: settings.tables.length,
        ...(businessChanged ? { businessType } : {}),
      },
    });
    run(db, 'UPDATE sync_state SET settings_version = ? WHERE id = 1', settings.version);
    if (events) {
      afterCommit(db, () => {
        events.changed({ kind: 'session' });
        if (businessChanged) events.changed({ kind: 'club' });
      });
    }
  });
}

/**
 * `business.type` of a package from the cloud (GET /sync/settings — changed or not — and GET
 * /sync/access carry it), when it names a known type. Older clouds send none; an unknown type is
 * ignored rather than failing the whole package.
 */
export function businessTypeOf(pkg: unknown): BusinessType | null {
  const business = pkg !== null && typeof pkg === 'object' ? (pkg as { business?: unknown }).business : undefined;
  const type = business !== null && typeof business === 'object' ? (business as { type?: unknown }).type : undefined;
  return typeof type === 'string' && (BUSINESS_TYPES as readonly string[]).includes(type) ? (type as BusinessType) : null;
}

/** Writes the business type into the club settings (other settings kept); true when it changed. */
function writeBusinessType(db: Db, club: string, type: BusinessType | null): boolean {
  if (!type) return false;
  const current = loadSettings(db, club);
  if (current.business.type === type) return false;
  run(db, 'UPDATE clubs SET settings = ? WHERE id = ?', JSON.stringify({ ...current, business: { type } }), club);
  return true;
}

/**
 * Applies the business type a cloud package names. A freshly connected HUB may never pull settings
 * (the cloud is still at version 0), so the unchanged settings answer and the access package — pulled
 * regularly — bring it too. Returns true when the club switched (journal `cloud.business_applied`).
 */
export function applyBusinessType(db: Db, now: number, pkg: unknown, events?: HubEvents): boolean {
  const type = businessTypeOf(pkg);
  if (!type) return false;
  return transaction(db, () => {
    const club = clubId(db);
    if (!writeBusinessType(db, club, type)) return false;
    record(db, now, { actor: CLOUD_ACTOR, action: 'cloud.business_applied', entityType: 'club', entityId: club, data: { businessType: type } });
    if (events) afterCommit(db, () => events.changed({ kind: 'club' }));
    return true;
  });
}

/** The access package version this HUB applied; null = never. */
export function appliedAccessVersion(db: Db): number | null {
  return one<{ version: number | null }>(db, 'SELECT version FROM access_sync WHERE id = 1')?.version ?? null;
}

export interface AccessApplied {
  people: number;
  keys: number;
  deactivated: number;
  revoked: number;
  /** Cloud keys skipped because their hash is already used by a key of this HUB. */
  conflicts: number;
}

const KEY_KINDS = new Set(['long', 'short']);
const SCOPES = new Set(['platform', 'company', 'club']);

/**
 * Applies GET /sync/access in one transaction: people and keys that came from
 * the cloud (origin 'cloud') are replaced by the package — upserted by id, those
 * missing from it deactivated or revoked — while people and keys created on
 * this HUB (origin 'hub') are left alone. Everyone is stored in the HUB's own
 * club; the cloud's club id is remembered because the cloud hashes short keys
 * over it. A cloud key whose hash a HUB key already has is skipped (key.conflict).
 */
export function applyAccess(db: Db, now: number, access: SyncAccessResponse, events?: HubEvents): AccessApplied {
  return transaction(db, () => {
    const club = clubId(db);
    const result: AccessApplied = { people: 0, keys: 0, deactivated: 0, revoked: 0, conflicts: 0 };
    const people = new Set<string>();
    for (const p of access.people ?? []) {
      if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name.trim()) continue;
      const norm = normalizeRoles(Array.isArray(p.roles) ? p.roles : []);
      if (!norm.ok || !SCOPES.has(p.scope)) continue;
      // The scope follows the roles: a 'club' person with a manager role is not a branch employee.
      const scope = scopeOf(norm.roles);
      const existing = one<{ origin: string }>(db, 'SELECT origin FROM staff WHERE id = ?', p.id);
      if (existing && existing.origin !== 'cloud') continue; // an id of a HUB person: never overwritten
      run(
        db,
        `INSERT INTO staff (id, club_id, name, role, roles, origin, scope, pin_hash, is_active, table_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'cloud', ?, NULL, ?, '[]', ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, role = excluded.role, roles = excluded.roles, scope = excluded.scope,
           is_active = excluded.is_active, updated_at = excluded.updated_at`,
        p.id,
        club,
        p.name.trim().slice(0, 80),
        primaryRole(norm.roles)!,
        JSON.stringify(norm.roles),
        scope,
        p.isActive ? 1 : 0,
        now,
        now,
      );
      people.add(p.id);
      result.people++;
    }
    result.deactivated = run(
      db,
      `UPDATE staff SET is_active = 0, updated_at = ? WHERE origin = 'cloud' AND is_active = 1
       AND id NOT IN (SELECT value FROM json_each(?))`,
      now,
      JSON.stringify([...people]),
    );

    const keys: string[] = [];
    for (const k of access.keys ?? []) {
      if (!k || typeof k.id !== 'string' || !people.has(k.personId)) continue;
      if (!KEY_KINDS.has(k.kind) || typeof k.keyHash !== 'string' || !/^[0-9a-f]{64}$/.test(k.keyHash)) continue;
      const clash = one<{ id: string; origin: string }>(db, 'SELECT id, origin FROM access_keys WHERE key_hash = ?', k.keyHash);
      if (clash && (clash.origin !== 'cloud' || clash.id !== k.id)) {
        result.conflicts++;
        record(db, now, {
          actor: CLOUD_ACTOR,
          action: 'key.conflict',
          entityType: 'staff',
          entityId: k.personId,
          data: { keyId: k.id, prefix: k.prefix, kind: k.kind, clashesWith: clash.id },
        });
        continue;
      }
      const existing = one<{ origin: string }>(db, 'SELECT origin FROM access_keys WHERE id = ?', k.id);
      if (existing && existing.origin !== 'cloud') continue;
      run(
        db,
        `INSERT INTO access_keys (id, club_id, staff_id, kind, origin, key_hash, prefix, label, created_at, created_by, expires_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, 'cloud', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           staff_id = excluded.staff_id, kind = excluded.kind, key_hash = excluded.key_hash, prefix = excluded.prefix,
           label = excluded.label, expires_at = excluded.expires_at,
           revoked_by = CASE WHEN access_keys.revoked_at IS NULL AND excluded.revoked_at IS NOT NULL THEN excluded.revoked_by ELSE access_keys.revoked_by END,
           revoked_at = COALESCE(access_keys.revoked_at, excluded.revoked_at)`,
        k.id,
        club,
        k.personId,
        k.kind,
        k.keyHash,
        String(k.prefix ?? '').slice(0, 40) || (k.kind === 'short' ? '••••' : 'KEY'),
        k.label ?? null,
        now,
        CLOUD_ACTOR,
        k.expiresAt ?? null,
        k.revokedAt ?? null,
        k.revokedAt ? CLOUD_ACTOR : null,
      );
      keys.push(k.id);
      result.keys++;
    }
    // Cloud keys no longer in the package are revoked; revoked keys end their sessions.
    result.revoked = run(
      db,
      `UPDATE access_keys SET revoked_at = ?, revoked_by = ? WHERE origin = 'cloud' AND revoked_at IS NULL
       AND id NOT IN (SELECT value FROM json_each(?))`,
      now,
      CLOUD_ACTOR,
      JSON.stringify(keys),
    );
    run(
      db,
      `UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL
       AND key_id IN (SELECT id FROM access_keys WHERE origin = 'cloud' AND revoked_at IS NOT NULL)`,
      now,
    );

    run(
      db,
      'UPDATE access_sync SET version = ?, cloud_club_id = ?, applied_at = ? WHERE id = 1',
      access.version,
      typeof access.clubId === 'string' && access.clubId ? access.clubId : null,
      now,
    );
    record(db, now, {
      actor: CLOUD_ACTOR,
      action: 'cloud.access_applied',
      entityType: 'club',
      entityId: club,
      data: { version: access.version, ...result },
    });
    if (events) afterCommit(db, () => events.changed({ kind: 'staff' }));
    return result;
  });
}

interface OutboxRow {
  id: number;
  at: number;
  topic: string;
  payload: string;
}

export class SyncWorker {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #fetch: typeof fetch;
  readonly #url: string;
  readonly #apiKey: string;
  readonly #hubId: string;
  readonly #intervalMs: number;
  readonly #kickDelayMs: number;
  readonly #logger: SyncLogger | undefined;
  readonly #license: LicenseService | undefined;
  readonly #onChanged = () => this.kick();

  #timer: NodeJS.Timeout | undefined;
  #kickTimer: NodeJS.Timeout | undefined;
  #inflight: Promise<void> | undefined;
  #abort = new AbortController();
  #failures = 0;
  #nextAttemptAt = 0;

  constructor(deps: SyncWorkerDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#url = deps.url.replace(/\/+$/, '');
    this.#apiKey = deps.apiKey;
    this.#hubId = deps.hubId;
    this.#intervalMs = deps.intervalMs ?? 10_000;
    this.#kickDelayMs = deps.kickDelayMs ?? 1000;
    this.#logger = deps.logger;
    this.#license = deps.license;
  }

  /** Earliest time of the next automatic tick; later than now while backing off after an error. */
  get nextAttemptAt(): number {
    return this.#nextAttemptAt;
  }

  /** Consecutive failed ticks. */
  get failures(): number {
    return this.#failures;
  }

  /** Starts the periodic push and follows local changes; the first tick happens after `kickDelayMs`. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#maybeTick(), this.#intervalMs);
    this.#timer.unref?.();
    this.#events.on('changed', this.#onChanged);
    this.kick();
  }

  /** Stops timers and aborts the request in flight. `tick()` still works for manual use. */
  stop(): void {
    clearInterval(this.#timer);
    clearTimeout(this.#kickTimer);
    this.#timer = undefined;
    this.#kickTimer = undefined;
    this.#events.off('changed', this.#onChanged);
    this.#abort.abort(new Error('Синхронизация остановлена'));
  }

  /** Asks for a tick soon (debounced); the back-off after an error is respected. */
  kick(): void {
    if (this.#kickTimer) return;
    this.#kickTimer = setTimeout(() => {
      this.#kickTimer = undefined;
      this.#maybeTick();
    }, this.#kickDelayMs);
    this.#kickTimer.unref?.();
  }

  status(): SyncStatus {
    return syncStatus(this.#db, true);
  }

  /** One full pass. Concurrent calls share the pass in flight. */
  tick(): Promise<void> {
    if (!this.#inflight) {
      if (this.#abort.signal.aborted) this.#abort = new AbortController();
      this.#inflight = this.#pass().finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  #maybeTick(): void {
    if (this.#inflight || this.#clock.now() < this.#nextAttemptAt) return;
    void this.tick();
  }

  async #pass(): Promise<void> {
    const now = this.#clock.now();
    try {
      const sent = await this.#exchange(now);
      this.#failures = 0;
      this.#nextAttemptAt = now;
      if (sent && this.#db.isOpen) {
        run(this.#db, 'UPDATE sync_state SET last_sent_at = ?, last_error = NULL, last_error_at = NULL WHERE id = 1', now);
      }
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.#failures++;
      const pause = Math.min(this.#intervalMs * 2 ** this.#failures, MAX_PAUSE_MS);
      this.#nextAttemptAt = now + pause;
      this.#logger?.warn(`Облако: ${message}; следующая попытка через ${Math.round(pause / 1000)} с`);
      if (this.#db.isOpen) {
        try {
          run(this.#db, 'UPDATE sync_state SET last_error = ?, last_error_at = ? WHERE id = 1', message, now);
        } catch {
          // The database is going away with the process; the error is already logged.
        }
      }
    }
  }

  /** Returns whether anything was exchanged with the cloud (false = heartbeat throttled). */
  async #exchange(now: number): Promise<boolean> {
    let state = readSyncState(this.#db);
    let cloudVersion: number | null = null;
    let accessVersion: number | undefined;
    let sent = false;

    // 1. Settings snapshot, when ours changed since the cloud last accepted them.
    const pushed = await this.#pushSnapshot(state);
    if (pushed !== null) {
      sent = true;
      cloudVersion = pushed;
    }

    // 2. Outbox batch; an empty one is a heartbeat, sent at most once per interval.
    const rows = all<OutboxRow>(
      this.#db,
      'SELECT id, at, topic, payload FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT ?',
      BATCH,
    );
    const heartbeatDue = state.last_sent_at === null || now - state.last_sent_at >= this.#intervalMs;
    if (rows.length > 0 || heartbeatDue) {
      const events = rows.map<SyncEvent>((r) => ({
        id: r.id,
        at: r.at,
        topic: r.topic,
        payload: JSON.parse(r.payload) as SyncEventPayload,
      }));
      const body: SyncEventsRequest = { hubId: this.#hubId, settingsVersion: state.settings_version, events };
      const res = await this.#request<SyncEventsResponse>('POST', '/sync/events', body);
      sent = true;
      cloudVersion = res.body.settingsVersion;
      accessVersion = res.body.accessVersion;
      const accepted = res.body.lastAcceptedId;
      if (accepted !== null && rows.length > 0) {
        run(this.#db, 'UPDATE outbox SET delivered_at = ? WHERE delivered_at IS NULL AND id <= ?', now, accepted);
      }
    }

    // 3. Newer settings in the cloud: pull and apply.
    if (cloudVersion !== null && cloudVersion > state.settings_version) {
      const res = await this.#request<SyncSettingsResponse>('GET', `/sync/settings?since=${state.settings_version}`);
      if (res.body.changed) {
        applySettings(this.#db, now, res.body, this.#events);
        state = readSyncState(this.#db);
        this.#logger?.info(`Облако: применены настройки версии ${state.settings_version}`);
        // Tell the cloud right away which version we run now; otherwise it would learn it a tick later.
        await this.#pushSnapshot(state);
      } else {
        applyBusinessType(this.#db, now, res.body, this.#events);
      }
    }

    // 4. People, keys and the license of this branch changed in the cloud.
    if (typeof accessVersion === 'number' && accessVersion !== appliedAccessVersion(this.#db)) {
      await this.pullAccess();
    }
    return sent;
  }

  /** GET /sync/access and apply it: people and keys, then the license. */
  async pullAccess(): Promise<AccessApplied> {
    const res = await this.#request<SyncAccessResponse>('GET', '/sync/access');
    const access = res.body;
    if (!Number.isFinite(access.version) || !Array.isArray(access.people) || !Array.isArray(access.keys)) {
      throw new Error('GET /sync/access: пакет доступа повреждён');
    }
    const applied = applyAccess(this.#db, this.#clock.now(), access, this.#events);
    if (applyBusinessType(this.#db, this.#clock.now(), access, this.#events)) {
      this.#logger?.info(`Облако: тип заведения — ${businessTypeOf(access) === 'cafe' ? 'кофейня' : 'бильярдный клуб'}`);
    }
    this.#logger?.info(
      `Облако: доступ версии ${access.version}: людей ${applied.people}, ключей ${applied.keys}` +
        (applied.conflicts ? `, конфликтов ключей ${applied.conflicts}` : ''),
    );
    const license = this.#license;
    const text = typeof access.license === 'string' ? access.license.trim() : '';
    if (license && text && text !== license.signed) {
      try {
        await license.install(text, 'cloud', CLOUD_ACTOR);
        this.#logger?.info('Облако: установлена лицензия');
      } catch (err) {
        const message = (err as Error).message;
        this.#logger?.warn(`Облако: лицензия не принята — ${message}`);
        if (this.#db.isOpen) {
          transaction(this.#db, () =>
            record(this.#db, this.#clock.now(), {
              actor: CLOUD_ACTOR,
              action: 'license.rejected',
              entityType: 'license',
              entityId: 'cloud',
              data: { message },
            }),
          );
        }
      }
    }
    return applied;
  }

  /** POSTs our settings when they differ from what the cloud last accepted. Returns the cloud version, or null when nothing was sent. */
  async #pushSnapshot(state: SyncStateRow): Promise<number | null> {
    const snapshot = localSnapshot(this.#db);
    const hash = settingsHash(snapshot);
    if (state.settings_hash === hash) return null;
    const body: SyncSnapshotRequest = { hubId: this.#hubId, ...snapshot };
    const res = await this.#request<SyncSnapshotResponse>('POST', '/sync/snapshot', body, [409]);
    if (res.status === 200 && res.body.accepted) {
      run(this.#db, 'UPDATE sync_state SET settings_hash = ? WHERE id = 1', hash);
    } else {
      this.#logger?.info(`Облако: настройки версии ${res.body.settingsVersion} новее наших (${snapshot.settingsVersion}), забираем`);
    }
    return res.body.settingsVersion;
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<{ status: number; body: T }> {
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      const cause = (err as Error & { cause?: Error }).cause;
      throw new Error(`${method} ${path}: ${cause?.message ?? (err as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const message = (json as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(`${method} ${path}: HTTP ${res.status}${message ? ` — ${message}` : ''}`);
    }
    if (json === null || typeof json !== 'object') throw new Error(`${method} ${path}: ответ не JSON`);
    return { status: res.status, body: json as T };
  }
}
