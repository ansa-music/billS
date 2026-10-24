import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccessKeyView, AuthStaff, KeyKind, LoginAttemptView, LoginResponse, Role, RosterPerson } from '@bills/domain';
import {
  canAssignRoles,
  DEMO_LOGIN_THROTTLE,
  formatAccessKey,
  isDemoKeyShape,
  formatShortKey,
  isWeakShortKey,
  KEY_ALPHABET,
  KEY_GROUP_LENGTH,
  KEY_GROUPS,
  keyKindOf,
  keyPrefixOf,
  LOGIN_THROTTLE,
  loginLockMs,
  normalizeAccessKey,
  normalizeRoles,
  primaryRole,
  rolesLabel,
  SESSION_TTL_MS,
  shortKeyHashInput,
  usesLongKey,
} from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record, SYSTEM } from './journal.ts';
import { clubId, loadSettings } from './views.ts';

/**
 * Who is acting, as resolved from the session token. `id` is null only for
 * the test-only X-Actor fallback (see http/auth.ts).
 */
export interface Actor {
  id: string | null;
  name: string;
  /** primaryRole(roles). */
  role: Role;
  /** Rights are the union of these. */
  roles: Role[];
}

/** An actor with every right, for system jobs and tests (bootstrap, sync). */
export const SYSTEM_ACTOR: Actor = { id: null, name: SYSTEM, role: 'owner', roles: ['owner'] };

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The stored hash of a canonical key: long keys alone, digit keys (short, demo) together with the branch. */
export function keyHashOf(key: string, club: string): string {
  return /^\d+$/.test(key) ? sha256(shortKeyHashInput(club, key)) : sha256(key);
}

/** Kind of a canonical key; four-digit demo keys count as short, but only on a demo HUB. */
export function loginKindOf(key: string, demo: boolean): KeyKind | null {
  const kind = keyKindOf(key);
  if (kind) return kind;
  return demo && isDemoKeyShape(key) ? 'short' : null;
}

/** How long a source waits after `failures` failures; the demo HUB is softer. */
function lockMsFor(failures: number, demo: boolean): number {
  if (!demo) return loginLockMs(failures);
  const t = DEMO_LOGIN_THROTTLE;
  if (failures < t.freeFailures) return 0;
  return Math.min(t.baseLockMs * 2 ** (failures - t.freeFailures), t.maxLockMs);
}

/** How often a session's last_seen_at is written (not on every request). */
const TOUCH_INTERVAL_MS = 60_000;
/** Login attempts are kept this long. */
const ATTEMPTS_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const BRANCH_SOURCE = 'branch';
/** The installer account created on a fresh HUB without anyone who could sign in. */
export const INSTALLER_NAME = 'Установщик';

export function generateAccessKey(role: Role): string {
  const bytes = randomBytes(KEY_GROUPS * KEY_GROUP_LENGTH * 2);
  // 16-bit values modulo 31: the bias is negligible for 4-char groups.
  const indices = Array.from({ length: KEY_GROUPS * KEY_GROUP_LENGTH }, (_, i) => bytes.readUInt16BE(i * 2) % KEY_ALPHABET.length);
  return formatAccessKey(role, indices);
}

/** Six random digits, never a weak combination. */
export function generateShortKey(): string {
  for (;;) {
    const bytes = randomBytes(6 * 8 * 4);
    const values = Array.from({ length: 6 * 8 }, (_, i) => bytes.readUInt32BE(i * 4));
    const key = formatShortKey(values);
    if (key) return key;
  }
}

export function parseRoles(json: string, fallback: string): Role[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as Role[];
  } catch {
    // fall through
  }
  return [fallback as Role];
}

interface KeyRow {
  id: string;
  club_id: string;
  staff_id: string;
  kind: KeyKind;
  origin: 'hub' | 'cloud';
  key_hash: string;
  prefix: string;
  label: string | null;
  created_at: number;
  created_by: string;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
}

interface StaffRow {
  id: string;
  club_id: string;
  name: string;
  role: Role;
  roles: string;
  origin: 'hub' | 'cloud';
  is_active: number;
}

const STAFF_COLUMNS = 'id, club_id, name, role, roles, origin, is_active';

interface SessionRow {
  token_hash: string;
  staff_id: string;
  key_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface ThrottleRow {
  source: string;
  failures: number;
  last_failure_at: number | null;
  locked_until: number | null;
}

function toKeyView(r: KeyRow): AccessKeyView {
  return {
    id: r.id,
    staffId: r.staff_id,
    kind: r.kind,
    prefix: r.prefix,
    label: r.label,
    createdAt: r.created_at,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    lastUsedAt: r.last_used_at,
  };
}

export function rolesOf(row: { roles: string; role: string }): Role[] {
  return parseRoles(row.roles, row.role);
}

export interface IssueKeyInput {
  staffId: string;
  label?: string | undefined;
  expiresInDays?: number | undefined;
  /** Short keys only: six digits picked by hand instead of random ones. */
  key?: string | undefined;
  /** Who issues it; must be allowed to assign the person's roles. */
  actor: Actor;
}

export interface LoginInput {
  key: string;
  device?: string | undefined;
  ip?: string | undefined;
}

export interface AuthServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
  /** Public demo: four-digit demo keys log in, the throttle is softer and never pauses the branch. */
  demo?: boolean | undefined;
}

export interface IssuedKey {
  name: string;
  role: Role;
  roles: Role[];
  key: string;
}

type LoginOutcome =
  | { ok: true; response: LoginResponse }
  | { ok: false; error: HubError };

/** Access keys, login sessions, the login throttle and the hierarchy of who may issue keys to whom. */
export class AuthService {
  readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  /** Keys of one person, newest first, revoked included. */
  listKeys(staffId: string): AccessKeyView[] {
    this.#staff(staffId);
    return all<KeyRow>(this.deps.db, 'SELECT * FROM access_keys WHERE staff_id = ? ORDER BY created_at DESC, id', staffId).map(
      toKeyView,
    );
  }

  /**
   * Issues a key. Staff (no long-key role) get a short key — six random digits
   * or the ones given in `key` (422 KEY_WEAK, 409 KEY_TAKEN) — that works only
   * in this branch; managers and the platform get a long one. Returns the key
   * in clear once; only its hash is kept.
   */
  issueKey(input: IssueKeyInput): { key: string; view: AccessKeyView } {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const staff = this.#staff(input.staffId);
      if (staff.origin === 'cloud') throw cloudManaged();
      if (staff.is_active !== 1) throw new HubError(409, 'STAFF_INACTIVE', 'Сотрудник уволен: ключ выдать нельзя');
      const roles = rolesOf(staff);
      // A spare key for yourself (another device) is always yours to take.
      if (input.actor.id !== staff.id) assertMayManage(input.actor, roles);
      const label = (input.label ?? '').trim().slice(0, 80) || null;
      const days = input.expiresInDays;
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
        throw new HubError(422, 'EXPIRY_INVALID', 'Срок действия — от 1 до 3650 дней');
      }
      let fixed: string | undefined;
      if (input.key !== undefined) {
        if (usesLongKey(roles)) throw new HubError(422, 'KEY_NOT_SHORT', 'Свои цифры можно задать только для короткого ключа сотрудника');
        fixed = normalizeAccessKey(input.key);
        if (keyKindOf(fixed) !== 'short') throw new HubError(422, 'KEY_WEAK', 'Ключ сотрудника — ровно 6 цифр');
        if (isWeakShortKey(fixed)) throw new HubError(422, 'KEY_WEAK', 'Слишком простой ключ (повторы, 123456…) — выберите другие цифры');
        if (this.shortKeyTaken(fixed)) throw new HubError(409, 'KEY_TAKEN', 'Такой ключ уже есть в этом филиале — выберите другие цифры');
      }
      const { key, view } = this.#insertKey(staff, label, days ? now + days * 86_400_000 : null, input.actor.name, now, fixed);
      record(db, now, {
        actor: input.actor.name,
        action: 'key.issued',
        entityType: 'staff',
        entityId: staff.id,
        data: { keyId: view.id, kind: view.kind, prefix: view.prefix, label, expiresAt: view.expiresAt, forRoles: roles, custom: fixed !== undefined },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'staff' }));
      return { key, view };
    });
  }

  /** Revokes a key and every session opened with it. Your own keys you may always revoke. */
  revokeKey(keyId: string, actor: Actor): AccessKeyView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const key = one<KeyRow>(db, 'SELECT * FROM access_keys WHERE id = ?', keyId);
      if (!key) throw new HubError(404, 'KEY_NOT_FOUND', 'Ключ не найден');
      const staff = this.#staff(key.staff_id);
      if (key.origin === 'cloud') throw cloudManaged();
      if (actor.id !== staff.id) assertMayManage(actor, rolesOf(staff));
      if (key.revoked_at !== null) return toKeyView(key);
      run(db, 'UPDATE access_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', now, actor.name, key.id);
      run(db, 'UPDATE auth_sessions SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL', now, key.id);
      record(db, now, {
        actor: actor.name,
        action: 'key.revoked',
        entityType: 'staff',
        entityId: staff.id,
        data: { keyId: key.id, prefix: key.prefix },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'staff' }));
      return toKeyView({ ...key, revoked_at: now, revoked_by: actor.name });
    });
  }

  /**
   * Hashes a short key may have here: over the local club id and, when the HUB
   * is connected to the cloud, over the cloud's id of this branch (keys issued in
   * the manager's cabinet are hashed by the cloud).
   */
  shortKeyHashes(key: string): string[] {
    const local = clubId(this.deps.db);
    const cloud = one<{ cloud_club_id: string | null }>(this.deps.db, 'SELECT cloud_club_id FROM access_sync WHERE id = 1')?.cloud_club_id;
    const hashes = [sha256(shortKeyHashInput(local, key))];
    if (cloud && cloud !== local) hashes.push(sha256(shortKeyHashInput(cloud, key)));
    return hashes;
  }

  /** Six digits already used in this branch (by any key, revoked ones included). */
  shortKeyTaken(key: string): boolean {
    const hashes = this.shortKeyHashes(key);
    return hashes.some((h) => one(this.deps.db, 'SELECT id FROM access_keys WHERE key_hash = ?', h) !== undefined);
  }

  /**
   * Exchanges a key for a session token. Every wrong key looks the same to the
   * caller (401 KEY_INVALID); after LOGIN_THROTTLE.freeFailures wrong keys from
   * one source (IP) it must wait — 429 LOGIN_LOCKED with retryAfterMs —
   * and too many failures in the whole branch pause short keys for everyone.
   * Every attempt lands in login_attempts (never the key itself).
   */
  login(input: LoginInput): LoginResponse {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    const device = (input.device ?? '').trim().slice(0, 120) || null;
    const ip = (input.ip ?? '').trim().slice(0, 64) || null;
    // The source is the IP alone: the device name is typed by the client, so it
    // would let a guesser start over just by renaming itself. It is only logged.
    const source = ip ?? '-';
    const key = normalizeAccessKey(input.key);
    const demo = this.deps.demo === true;
    // A real HUB refuses the four-digit demo keys outright, even if such a row were in its database.
    const kind = loginKindOf(key, demo);

    const outcome = transaction(db, (): LoginOutcome => {
      const attempt = (result: string, extra: { keyId?: string; staffId?: string; prefix?: string } = {}) =>
        run(
          db,
          `INSERT INTO login_attempts (at, ok, kind, key_id, staff_id, prefix, device, ip, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          now,
          result === 'ok' ? 1 : 0,
          kind,
          extra.keyId ?? null,
          extra.staffId ?? null,
          extra.prefix ?? null,
          device,
          ip,
          result,
        );
      run(db, 'DELETE FROM login_attempts WHERE at < ?', now - ATTEMPTS_KEEP_MS);

      // 1. Is this source (or, for short keys, the branch) waiting?
      const src = this.#throttle(source, now);
      if (src.locked_until !== null && src.locked_until > now) {
        attempt('locked');
        return { ok: false, error: locked(src.locked_until - now, 'Слишком много неверных ключей с этого устройства') };
      }
      if (kind === 'short' && !demo) {
        const branch = one<ThrottleRow>(db, 'SELECT * FROM login_throttle WHERE source = ?', BRANCH_SOURCE);
        if (branch?.locked_until && branch.locked_until > now) {
          attempt('branch_locked');
          return { ok: false, error: locked(branch.locked_until - now, 'Слишком много неверных ключей в филиале: вход по коротким ключам на паузе') };
        }
      }

      // 2. The key itself.
      const fail = (result: string, extra: { keyId?: string; staffId?: string; prefix?: string } = {}): LoginOutcome => {
        attempt(result, extra);
        return { ok: false, error: this.#failed(source, src, now) };
      };
      if (!kind) return fail('wrong_key');
      const club = clubId(db);
      const hashes = kind === 'short' ? this.shortKeyHashes(key) : [sha256(key)];
      // Local keys first: on the (unlikely) clash with a cloud key of the same digits the HUB's own wins.
      const row = hashes
        .map((h) => one<KeyRow>(db, 'SELECT * FROM access_keys WHERE key_hash = ? AND kind = ? AND club_id = ?', h, kind, club))
        .find((r) => r !== undefined);
      if (!row) return fail('wrong_key');
      const ref = { keyId: row.id, staffId: row.staff_id, prefix: row.prefix };
      if (row.revoked_at !== null) return fail('revoked', ref);
      if (row.expires_at !== null && row.expires_at <= now) return fail('expired', ref);
      const staff = one<StaffRow>(db, `SELECT ${STAFF_COLUMNS} FROM staff WHERE id = ?`, row.staff_id);
      if (!staff || staff.is_active !== 1) return fail('inactive', ref);

      attempt('ok', ref);
      run(db, 'UPDATE login_throttle SET failures = 0, locked_until = NULL WHERE source = ?', source);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = now + SESSION_TTL_MS;
      run(
        db,
        `INSERT INTO auth_sessions (token_hash, staff_id, key_id, created_at, last_seen_at, expires_at, device)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        sha256(token),
        staff.id,
        row.id,
        now,
        now,
        expiresAt,
        device,
      );
      run(db, 'UPDATE access_keys SET last_used_at = ? WHERE id = ?', now, row.id);
      record(db, now, {
        actor: staff.name,
        action: 'auth.login',
        entityType: 'staff',
        entityId: staff.id,
        data: { keyId: row.id, prefix: row.prefix, device },
      });
      return { ok: true, response: { token, staff: this.#authStaff(staff), expiresAt } };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.response;
  }

  /**
   * «Кто на смене?» (GET /api/auth/roster, public): active people of this branch with a working
   * six-digit key, by name. Names and roles only — the key is still needed to sign in. Empty when
   * the club switched the list off (`display.showRoster`). Long-key people (manager, support) sign
   * in with their long key and are not listed.
   */
  roster(): RosterPerson[] {
    const db = this.deps.db;
    const club = clubId(db);
    if (!loadSettings(db, club).display.showRoster) return [];
    const now = this.deps.clock.now();
    return all<StaffRow>(
      db,
      `SELECT s.id, s.club_id, s.name, s.role, s.roles, s.origin, s.is_active FROM staff s
       WHERE s.club_id = ? AND s.is_active = 1 AND EXISTS (
         SELECT 1 FROM access_keys k
         WHERE k.staff_id = s.id AND k.kind = 'short' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
       )
       ORDER BY s.name COLLATE NOCASE, s.id`,
      club,
      now,
    )
      .map((s) => ({ id: s.id, name: s.name, roles: rolesOf(s) }))
      .filter((p) => !usesLongKey(p.roles));
  }

  /** Newest first (GET /api/auth/attempts). */
  attempts(limit = 100, before?: number): LoginAttemptView[] {
    const n = Math.min(500, Math.max(1, Math.floor(limit)));
    return all<{
      id: number;
      at: number;
      ok: number;
      kind: KeyKind | null;
      prefix: string | null;
      staff_name: string | null;
      device: string | null;
      ip: string | null;
      result: string;
    }>(
      this.deps.db,
      `SELECT a.id, a.at, a.ok, a.kind, a.prefix, s.name AS staff_name, a.device, a.ip, a.result
       FROM login_attempts a LEFT JOIN staff s ON s.id = a.staff_id
       WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`,
      before ?? Number.MAX_SAFE_INTEGER,
      n,
    ).map((r) => ({
      id: r.id,
      at: r.at,
      ok: r.ok === 1,
      kind: r.kind,
      prefix: r.prefix,
      staffName: r.staff_name,
      device: r.device,
      ip: r.ip,
      result: r.result,
    }));
  }

  logout(token: string, actor: Actor): void {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    transaction(db, () => {
      const changed = run(db, 'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now, sha256(token));
      if (changed && actor.id) {
        record(db, now, { actor: actor.name, action: 'auth.logout', entityType: 'staff', entityId: actor.id, data: {} });
      }
    });
  }

  /** Session token → actor, or null when the token is unknown, expired, revoked or the person is gone. */
  resolve(token: string): { actor: Actor; staff: AuthStaff; expiresAt: number } | null {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    const s = one<SessionRow>(db, 'SELECT * FROM auth_sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.revoked_at !== null || s.expires_at <= now) return null;
    const staff = one<StaffRow>(db, `SELECT ${STAFF_COLUMNS} FROM staff WHERE id = ?`, s.staff_id);
    if (!staff || staff.is_active !== 1) return null;
    const key = one<{ revoked_at: number | null; expires_at: number | null }>(
      db,
      'SELECT revoked_at, expires_at FROM access_keys WHERE id = ?',
      s.key_id,
    );
    if (!key || key.revoked_at !== null || (key.expires_at !== null && key.expires_at <= now)) return null;
    let expiresAt = s.expires_at;
    if (now - s.last_seen_at >= TOUCH_INTERVAL_MS) {
      expiresAt = now + SESSION_TTL_MS;
      run(db, 'UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', now, expiresAt, s.token_hash);
      run(db, 'UPDATE access_keys SET last_used_at = ? WHERE id = ?', now, s.key_id);
    }
    const authStaff = this.#authStaff(staff);
    return { actor: { id: staff.id, name: staff.name, role: authStaff.role, roles: authStaff.roles }, staff: authStaff, expiresAt };
  }

  /**
   * First start and upgrades: nobody must be locked out. When no active owner,
   * tech or manager has a working key, the HUB's own long-key people get one;
   * with nobody like that, an installer account (tech, «Установщик») is created
   * and keyed. With `everyone` (a fresh demo club) all active people without a
   * working key get one too. Returns the keys in clear.
   */
  bootstrapKeys(everyone: boolean): IssuedKey[] {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const active = all<StaffRow>(db, `SELECT ${STAFF_COLUMNS} FROM staff WHERE is_active = 1 AND club_id = ? ORDER BY created_at, name`, club);
      const hasWorkingKey = (s: StaffRow) =>
        one(
          db,
          'SELECT 1 AS x FROM access_keys WHERE staff_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
          s.id,
          now,
        ) !== undefined;
      const longPeople = active.filter((s) => usesLongKey(rolesOf(s)));
      const targets: StaffRow[] = [];
      if (!longPeople.some(hasWorkingKey)) {
        const own = longPeople.filter((s) => s.origin === 'hub');
        if (own.length > 0) targets.push(...own);
        else targets.push(this.#createPerson(club, INSTALLER_NAME, ['tech'], now));
      }
      if (everyone) {
        for (const s of active) if (!targets.some((t) => t.id === s.id) && !hasWorkingKey(s) && s.origin === 'hub') targets.push(s);
      }
      return targets.map((staff) => {
        const { key, view } = this.#insertKey(staff, 'стартовый ключ', null, SYSTEM, now);
        const roles = rolesOf(staff);
        record(db, now, {
          actor: SYSTEM,
          action: 'key.issued',
          entityType: 'staff',
          entityId: staff.id,
          data: { keyId: view.id, kind: view.kind, prefix: view.prefix, label: view.label, bootstrap: true, forRoles: roles },
        });
        return { name: staff.name, role: primaryRole(roles) ?? staff.role, roles, key };
      });
    });
  }

  /**
   * Public demo (HUB_DEMO=1): every demo key goes to its person — found by name,
   * else the first active person with exactly those roles, else created. Keys
   * that already exist are skipped. Returns what was issued.
   */
  issueFixedKeys(keys: ReadonlyArray<{ roles: readonly Role[]; name: string; key: string }>): IssuedKey[] {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const issued: IssuedKey[] = [];
      const taken = new Set<string>();
      for (const demo of keys) {
        const key = normalizeAccessKey(demo.key);
        if (!loginKindOf(key, true)) continue;
        const norm = normalizeRoles([...demo.roles]);
        if (!norm.ok) continue;
        const roles = norm.roles;
        const want = JSON.stringify(roles);
        if (one(db, 'SELECT id FROM access_keys WHERE key_hash = ?', keyHashOf(key, club))) continue;
        const active = all<StaffRow>(db, `SELECT ${STAFF_COLUMNS} FROM staff WHERE is_active = 1 AND club_id = ? ORDER BY created_at, name`, club);
        const staff =
          active.find((s) => s.name === demo.name && !taken.has(s.id)) ??
          active.find((s) => JSON.stringify(rolesOf(s)) === want && !taken.has(s.id) && !this.#hasDemoKey(s.id)) ??
          this.#createPerson(club, demo.name, roles, now);
        taken.add(staff.id);
        this.#insertKey(staff, 'демо-ключ', null, SYSTEM, now, key);
        issued.push({ name: staff.name, role: primaryRole(roles) ?? staff.role, roles, key });
      }
      if (issued.length) afterCommit(db, () => this.deps.events.changed({ kind: 'staff' }));
      return issued;
    });
  }

  #hasDemoKey(staffId: string): boolean {
    return one(this.deps.db, "SELECT id FROM access_keys WHERE staff_id = ? AND label = 'демо-ключ'", staffId) !== undefined;
  }

  #createPerson(club: string, name: string, roles: Role[], now: number): StaffRow {
    const id = randomUUID();
    const role = primaryRole(roles) ?? roles[0]!;
    run(
      this.deps.db,
      `INSERT INTO staff (id, club_id, name, role, roles, origin, scope, pin_hash, is_active, table_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'hub', ?, NULL, 1, '[]', ?, ?)`,
      id,
      club,
      name,
      role,
      JSON.stringify(roles),
      scopeOf(roles),
      now,
      now,
    );
    record(this.deps.db, now, {
      actor: SYSTEM,
      action: 'staff.created',
      entityType: 'staff',
      entityId: id,
      data: { name, roles, bootstrap: true },
    });
    return { id, club_id: club, name, role, roles: JSON.stringify(roles), origin: 'hub', is_active: 1 };
  }

  /** Counts a failure of `source` (and of the branch); returns the error to throw. */
  #failed(source: string, src: ThrottleRow, now: number): HubError {
    const db = this.deps.db;
    const failures = src.failures + 1;
    const demo = this.deps.demo === true;
    const lockMs = lockMsFor(failures, demo);
    run(
      db,
      `INSERT INTO login_throttle (source, failures, last_failure_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET failures = excluded.failures, last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until`,
      source,
      failures,
      now,
      lockMs > 0 ? now + lockMs : null,
    );
    // The branch: every failure of every source in the window counts (locked attempts are not failures).
    const recent =
      one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM login_attempts WHERE at > ? AND ok = 0 AND result NOT IN ('locked', 'branch_locked')",
        now - LOGIN_THROTTLE.windowMs,
      )?.n ?? 0;
    if (!demo && recent >= LOGIN_THROTTLE.branchFailures) {
      const branch = one<ThrottleRow>(db, 'SELECT * FROM login_throttle WHERE source = ?', BRANCH_SOURCE);
      if (!branch?.locked_until || branch.locked_until <= now) {
        run(
          db,
          `INSERT INTO login_throttle (source, failures, last_failure_at, locked_until) VALUES (?, ?, ?, ?)
           ON CONFLICT (source) DO UPDATE SET failures = excluded.failures, last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until`,
          BRANCH_SOURCE,
          recent,
          now,
          now + LOGIN_THROTTLE.branchLockMs,
        );
        record(db, now, {
          actor: SYSTEM,
          action: 'auth.branch_locked',
          entityType: 'club',
          entityId: clubId(db),
          data: { failures: recent, lockMs: LOGIN_THROTTLE.branchLockMs },
        });
      }
    }
    if (lockMs > 0) return locked(lockMs, 'Слишком много неверных ключей с этого устройства');
    return new HubError(401, 'KEY_INVALID', 'Ключ не подходит');
  }

  /** The source's throttle row; failures older than the window are forgotten. */
  #throttle(source: string, now: number): ThrottleRow {
    const row = one<ThrottleRow>(this.deps.db, 'SELECT * FROM login_throttle WHERE source = ?', source);
    if (!row) return { source, failures: 0, last_failure_at: null, locked_until: null };
    if (row.last_failure_at !== null && now - row.last_failure_at > LOGIN_THROTTLE.windowMs && (row.locked_until ?? 0) <= now) {
      return { source, failures: 0, last_failure_at: null, locked_until: null };
    }
    return row;
  }

  #insertKey(staff: StaffRow, label: string | null, expiresAt: number | null, createdBy: string, now: number, fixedKey?: string) {
    const roles = rolesOf(staff);
    let key: string;
    if (fixedKey !== undefined) key = fixedKey;
    else if (usesLongKey(roles)) key = generateAccessKey(primaryRole(roles) ?? 'manager');
    else {
      key = generateShortKey();
      for (let i = 0; i < 50 && this.shortKeyTaken(key); i++) key = generateShortKey();
      if (this.shortKeyTaken(key)) throw new HubError(409, 'KEY_TAKEN', 'Не удалось подобрать свободный ключ — попробуйте ещё раз');
    }
    const kind: KeyKind = /^\d+$/.test(key) ? 'short' : 'long';
    const row: KeyRow = {
      id: randomUUID(),
      club_id: staff.club_id,
      staff_id: staff.id,
      kind,
      origin: 'hub',
      key_hash: keyHashOf(key, staff.club_id),
      prefix: keyPrefixOf(key),
      label,
      created_at: now,
      created_by: createdBy,
      expires_at: expiresAt,
      revoked_at: null,
      revoked_by: null,
      last_used_at: null,
    };
    run(
      this.deps.db,
      `INSERT INTO access_keys (id, club_id, staff_id, kind, origin, key_hash, prefix, label, created_at, created_by, expires_at)
       VALUES (?, ?, ?, ?, 'hub', ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.club_id,
      row.staff_id,
      row.kind,
      row.key_hash,
      row.prefix,
      row.label,
      row.created_at,
      row.created_by,
      row.expires_at,
    );
    return { key, view: toKeyView(row) };
  }

  #staff(staffId: string): StaffRow {
    const row = one<StaffRow>(this.deps.db, `SELECT ${STAFF_COLUMNS} FROM staff WHERE id = ?`, staffId);
    if (!row) throw new HubError(404, 'STAFF_NOT_FOUND', 'Сотрудник не найден');
    return row;
  }

  #authStaff(staff: StaffRow): AuthStaff {
    const club = one<{ name: string }>(this.deps.db, 'SELECT name FROM clubs WHERE id = ?', staff.club_id);
    const roles = rolesOf(staff);
    return {
      id: staff.id,
      name: staff.name,
      role: primaryRole(roles) ?? staff.role,
      roles,
      clubId: staff.club_id,
      clubName: club?.name ?? '',
    };
  }
}

/** Where a person with these roles belongs: the platform, the company (manager) or the branch. */
export function scopeOf(roles: readonly Role[]): 'platform' | 'company' | 'club' {
  if (roles.includes('owner') || roles.includes('tech')) return 'platform';
  if (roles.includes('manager')) return 'company';
  return 'club';
}

function locked(retryAfterMs: number, why: string): HubError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const wait = seconds >= 120 ? `${Math.ceil(seconds / 60)} мин` : `${seconds} с`;
  return new HubError(429, 'LOGIN_LOCKED', `${why}. Попробуйте через ${wait}.`, { retryAfterMs });
}

export function cloudManaged(): HubError {
  return new HubError(409, 'STAFF_CLOUD_MANAGED', 'Сотрудник заведён в кабинете управляющего — измените его в кабинете');
}

/** The hierarchy: you may manage (hire, edit, issue keys to) only people whose every role you may assign. */
export function assertMayManage(actor: Actor, targetRoles: readonly Role[]): void {
  if (!canAssignRoles(actor.roles, targetRoles)) {
    throw new HubError(403, 'ROLE_NOT_ALLOWED', `Ваша роль не позволяет управлять сотрудником с ролью «${rolesLabel(targetRoles)}»`);
  }
}

/** Writes bootstrap keys where the installer can find them: next to the database. */
export function writeBootstrapKeys(file: string, keys: IssuedKey[], at: number): void {
  if (keys.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    `# ${new Date(at).toISOString()} — ключи доступа, выданные HUB при старте. Передайте их и удалите файл.`,
    ...keys.map((k) => `${k.roles.join('+').padEnd(16)} ${k.name.padEnd(28)} ${k.key}`),
    '',
  ];
  appendFileSync(file, lines.join('\n'), 'utf8');
}
