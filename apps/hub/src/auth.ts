import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccessKeyView, AuthStaff, LoginResponse, Role } from '@bills/domain';
import {
  canAssignRole,
  formatAccessKey,
  isAccessKeyShape,
  KEY_ALPHABET,
  KEY_GROUP_LENGTH,
  KEY_GROUPS,
  keyPrefixOf,
  normalizeAccessKey,
  SESSION_TTL_MS,
} from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record, SYSTEM } from './journal.ts';

/**
 * Who is acting, as resolved from the session token. `id` is null only for
 * the test-only X-Actor fallback (see http/command.ts).
 */
export interface Actor {
  id: string | null;
  name: string;
  role: Role;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** How often a session's last_seen_at is written (not on every request). */
const TOUCH_INTERVAL_MS = 60_000;

export function generateAccessKey(role: Role): string {
  const bytes = randomBytes(KEY_GROUPS * KEY_GROUP_LENGTH * 2);
  // Rejection-free mapping: 31 symbols, take 16-bit values modulo 31 — bias is negligible for 4-char groups.
  const indices = Array.from({ length: KEY_GROUPS * KEY_GROUP_LENGTH }, (_, i) => bytes.readUInt16BE(i * 2) % KEY_ALPHABET.length);
  return formatAccessKey(role, indices);
}

interface KeyRow {
  id: string;
  club_id: string;
  staff_id: string;
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
  is_active: number;
}

interface SessionRow {
  token_hash: string;
  staff_id: string;
  key_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function toKeyView(r: KeyRow): AccessKeyView {
  return {
    id: r.id,
    staffId: r.staff_id,
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

export interface IssueKeyInput {
  staffId: string;
  label?: string | undefined;
  expiresInDays?: number | undefined;
  /** Who issues it; role decides whether the target role may be managed. */
  actor: Actor;
}

export interface AuthServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

/** Access keys, login sessions and the hierarchy of who may issue keys to whom. */
export class AuthService {
  readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  /** Keys of one employee, newest first, revoked included. */
  listKeys(staffId: string): AccessKeyView[] {
    this.#staff(staffId);
    return all<KeyRow>(this.deps.db, 'SELECT * FROM access_keys WHERE staff_id = ? ORDER BY created_at DESC', staffId).map(
      toKeyView,
    );
  }

  /**
   * Issues a key for an employee. A manager may issue keys to cashiers and
   * waiters (and other managers), an owner to anyone in the club, tech to all.
   * Returns the key in clear once; only its hash is kept.
   */
  issueKey(input: IssueKeyInput): { key: string; view: AccessKeyView } {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const staff = this.#staff(input.staffId);
      if (staff.is_active !== 1) throw new HubError(409, 'STAFF_INACTIVE', 'Сотрудник уволен: ключ выдать нельзя');
      assertMayManage(input.actor, staff.role);
      const label = (input.label ?? '').trim().slice(0, 80) || null;
      const days = input.expiresInDays;
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
        throw new HubError(422, 'EXPIRY_INVALID', 'Срок действия — от 1 до 3650 дней');
      }
      const { key, view } = this.#insertKey(staff, label, days ? now + days * 86_400_000 : null, input.actor.name, now);
      record(db, now, {
        actor: input.actor.name,
        action: 'key.issued',
        entityType: 'staff',
        entityId: staff.id,
        data: { keyId: view.id, prefix: view.prefix, label, expiresAt: view.expiresAt, forRole: staff.role },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'staff' }));
      return { key, view };
    });
  }

  /** Revokes a key and every session opened with it. */
  revokeKey(keyId: string, actor: Actor): AccessKeyView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const key = one<KeyRow>(db, 'SELECT * FROM access_keys WHERE id = ?', keyId);
      if (!key) throw new HubError(404, 'KEY_NOT_FOUND', 'Ключ не найден');
      const staff = this.#staff(key.staff_id);
      if (actor.id !== staff.id) assertMayManage(actor, staff.role);
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

  /** Exchanges a key for a session token. Every failure looks the same to the caller. */
  login(rawKey: string, device: string | undefined): LoginResponse {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    const key = normalizeAccessKey(rawKey);
    const fail = () => new HubError(401, 'KEY_INVALID', 'Ключ не подходит');
    if (!isAccessKeyShape(key)) throw fail();
    return transaction(db, () => {
      const row = one<KeyRow>(db, 'SELECT * FROM access_keys WHERE key_hash = ?', sha256(key));
      if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)) throw fail();
      const staff = one<StaffRow>(db, 'SELECT id, club_id, name, role, is_active FROM staff WHERE id = ?', row.staff_id);
      if (!staff || staff.is_active !== 1) throw fail();

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
        (device ?? '').trim().slice(0, 120) || null,
      );
      run(db, 'UPDATE access_keys SET last_used_at = ? WHERE id = ?', now, row.id);
      record(db, now, {
        actor: staff.name,
        action: 'auth.login',
        entityType: 'staff',
        entityId: staff.id,
        data: { keyId: row.id, prefix: row.prefix, device: device ?? null },
      });
      return { token, staff: this.#authStaff(staff), expiresAt };
    });
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

  /** Session token → actor, or null when the token is unknown, expired, revoked or the employee is gone. */
  resolve(token: string): { actor: Actor; staff: AuthStaff; expiresAt: number } | null {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    const s = one<SessionRow>(db, 'SELECT * FROM auth_sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.revoked_at !== null || s.expires_at <= now) return null;
    const staff = one<StaffRow>(db, 'SELECT id, club_id, name, role, is_active FROM staff WHERE id = ?', s.staff_id);
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
    return { actor: { id: staff.id, name: staff.name, role: staff.role }, staff: this.#authStaff(staff), expiresAt };
  }

  /**
   * First start and upgrades: every active owner and tech account without a
   * working key gets one, so nobody is locked out. With `everyone`, all active
   * staff get one (demo club on first run). Returns the keys in clear.
   */
  bootstrapKeys(everyone: boolean): Array<{ name: string; role: Role; key: string }> {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const rows = all<StaffRow>(
        db,
        `SELECT s.id, s.club_id, s.name, s.role, s.is_active FROM staff s
         WHERE s.is_active = 1 AND (? = 1 OR s.role IN ('owner', 'superadmin'))
           AND NOT EXISTS (
             SELECT 1 FROM access_keys k WHERE k.staff_id = s.id AND k.revoked_at IS NULL
               AND (k.expires_at IS NULL OR k.expires_at > ?)
           )
         ORDER BY s.role, s.name`,
        everyone ? 1 : 0,
        now,
      );
      return rows.map((staff) => {
        const { key, view } = this.#insertKey(staff, 'стартовый ключ', null, SYSTEM, now);
        record(db, now, {
          actor: SYSTEM,
          action: 'key.issued',
          entityType: 'staff',
          entityId: staff.id,
          data: { keyId: view.id, prefix: view.prefix, label: view.label, bootstrap: true, forRole: staff.role },
        });
        return { name: staff.name, role: staff.role, key };
      });
    });
  }

  /**
   * Public demo (HUB_DEMO=1): gives the first active employee of each role the
   * fixed key from the list, unless that key already exists. Returns what was issued.
   */
  issueFixedKeys(keys: ReadonlyArray<{ role: Role; key: string }>): Array<{ name: string; role: Role; key: string }> {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const issued: Array<{ name: string; role: Role; key: string }> = [];
      for (const { role, key } of keys) {
        if (one(db, 'SELECT id FROM access_keys WHERE key_hash = ?', sha256(key))) continue;
        const staff = one<StaffRow>(
          db,
          `SELECT id, club_id, name, role, is_active FROM staff WHERE role = ? AND is_active = 1 ORDER BY created_at, name LIMIT 1`,
          role,
        );
        if (!staff) continue;
        this.#insertKey(staff, 'демо-ключ', null, SYSTEM, now, key);
        issued.push({ name: staff.name, role, key });
      }
      return issued;
    });
  }

  #insertKey(staff: StaffRow, label: string | null, expiresAt: number | null, createdBy: string, now: number, fixedKey?: string) {
    const key = fixedKey ?? generateAccessKey(staff.role);
    const row: KeyRow = {
      id: randomUUID(),
      club_id: staff.club_id,
      staff_id: staff.id,
      key_hash: sha256(key),
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
      `INSERT INTO access_keys (id, club_id, staff_id, key_hash, prefix, label, created_at, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.club_id,
      row.staff_id,
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
    const row = one<StaffRow>(this.deps.db, 'SELECT id, club_id, name, role, is_active FROM staff WHERE id = ?', staffId);
    if (!row) throw new HubError(404, 'STAFF_NOT_FOUND', 'Сотрудник не найден');
    return row;
  }

  #authStaff(staff: StaffRow): AuthStaff {
    const club = one<{ name: string }>(this.deps.db, 'SELECT name FROM clubs WHERE id = ?', staff.club_id);
    return { id: staff.id, name: staff.name, role: staff.role, clubId: staff.club_id, clubName: club?.name ?? '' };
  }
}

/** The hierarchy: you may manage (hire, edit, issue keys to) only roles you may assign. */
export function assertMayManage(actor: Actor, targetRole: Role): void {
  if (!canAssignRole(actor.role, targetRole)) {
    throw new HubError(403, 'ROLE_NOT_ALLOWED', 'Ваша роль не позволяет управлять этим сотрудником');
  }
}

/** Writes bootstrap keys where the owner can find them: next to the database. */
export function writeBootstrapKeys(file: string, keys: Array<{ name: string; role: Role; key: string }>, at: number): void {
  if (keys.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    `# ${new Date(at).toISOString()} — ключи доступа, выданные HUB при старте. Передайте их владельцам и удалите файл.`,
    ...keys.map((k) => `${k.role.padEnd(10)} ${k.name.padEnd(28)} ${k.key}`),
    '',
  ];
  appendFileSync(file, lines.join('\n'), 'utf8');
}
