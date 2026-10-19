import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AuditEntryView, AuditListResponse, Role, StaffView } from '@bills/domain';
import { normalizeRoles, primaryRole } from '@bills/domain';
import type { Actor } from './auth.ts';
import { assertMayManage, cloudManaged, rolesOf, scopeOf } from './auth.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import { clubId } from './views.ts';

/** PIN storage: "scrypt$<salt hex>$<hash hex>". A PIN is 4–6 digits. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const PIN_RE = /^\d{4,6}$/;

/** License limits in force; null = none (licenses not enforced, or no license). */
export type LicenseLimits = () => { maxTables: number | null; maxStaff: number | null } | null;

export interface StaffServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
  limits?: LicenseLimits | undefined;
}

export interface CreateStaffInput {
  name: string;
  /** A set; checked by normalizeRoles (422 ROLE_INVALID). */
  roles: readonly unknown[];
  pin?: string | undefined;
  tableIds?: string[] | undefined;
  actor: string;
  /** The signed-in person; limits which roles may be assigned (canAssignRoles). */
  by?: Actor | undefined;
}

export interface UpdateStaffInput {
  staffId: string;
  name?: string | undefined;
  roles?: readonly unknown[] | undefined;
  /** A string sets a new PIN, null removes it, undefined keeps it. */
  pin?: string | null | undefined;
  isActive?: boolean | undefined;
  tableIds?: string[] | undefined;
  actor: string;
  by?: Actor | undefined;
}

export interface AuditQuery {
  actor?: string | undefined;
  tableId?: string | undefined;
  /** Prefix match, e.g. 'session.'. */
  action?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
  before?: number | undefined;
}

interface StaffRow {
  id: string;
  club_id: string;
  name: string;
  role: Role;
  roles: string;
  origin: 'hub' | 'cloud';
  scope: 'platform' | 'company' | 'club';
  pin_hash: string | null;
  is_active: number;
  table_ids: string;
  created_at: number;
  updated_at: number;
  active_keys?: number;
}

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  data: string;
}

const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;

/** The PIN hash never leaves this module: views carry only `hasPin`. */
function toStaffView(row: StaffRow): StaffView {
  let tableIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.table_ids);
    if (Array.isArray(parsed)) tableIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // Damaged JSON must not take the staff page down: treat as "all tables".
  }
  const roles = rolesOf(row);
  return {
    id: row.id,
    name: row.name,
    role: primaryRole(roles) ?? row.role,
    roles,
    origin: row.origin,
    isActive: row.is_active === 1,
    hasPin: row.pin_hash !== null,
    activeKeys: row.active_keys ?? 0,
    tableIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAuditView(row: AuditRow): AuditEntryView {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Keep the entry visible even if its payload is unreadable.
  }
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    data,
  };
}

function checkRoles(input: readonly unknown[]): Role[] {
  const r = normalizeRoles(input);
  if (!r.ok) throw new HubError(422, 'ROLE_INVALID', r.message);
  return r.roles;
}

const sameRoles = (a: readonly Role[], b: readonly Role[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Staff, PINs and the audit log. Every command is one transaction with an
 * audit record. The hierarchy (canAssignRoles): when the signed-in actor is
 * known (`by`), they may create and edit only people whose roles they could
 * assign, never change their own roles or dismiss themselves. People synced
 * from the cloud (origin 'cloud') are edited in the manager's cabinet only.
 */
export class StaffService {
  readonly deps: StaffServiceDeps;

  constructor(deps: StaffServiceDeps) {
    this.deps = deps;
  }

  /** Everyone of the club, active first then by name. Inactive («уволен») rows are kept. */
  list(): StaffView[] {
    const db = this.deps.db;
    return all<StaffRow>(
      db,
      `SELECT s.*, (SELECT COUNT(*) FROM access_keys k WHERE k.staff_id = s.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)) AS active_keys FROM staff s WHERE s.club_id = ? ORDER BY s.is_active DESC, s.name COLLATE NOCASE, s.created_at`,
      this.deps.clock.now(),
      clubId(db),
    ).map(toStaffView);
  }

  get(staffId: string): StaffView {
    const row = one<StaffRow>(this.deps.db, `SELECT s.*, (SELECT COUNT(*) FROM access_keys k WHERE k.staff_id = s.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)) AS active_keys FROM staff s WHERE s.id = ?`, this.deps.clock.now(), staffId);
    if (!row) throw new HubError(404, 'STAFF_NOT_FOUND', 'Сотрудник не найден');
    return toStaffView(row);
  }

  create(input: CreateStaffInput): StaffView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const name = cleanName(input.name);
      const roles = checkRoles(input.roles);
      if (input.by) assertMayManage(input.by, roles);
      this.#assertNameFree(club, name, null);
      const scope = scopeOf(roles);
      if (scope === 'club') this.#assertStaffLimit(club, null);
      const pinHash = input.pin === undefined ? null : hashPin(checkPin(input.pin));
      const tableIds = this.#checkTables(club, input.tableIds ?? []);

      const id = randomUUID();
      run(
        db,
        `INSERT INTO staff (id, club_id, name, role, roles, origin, scope, pin_hash, is_active, table_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'hub', ?, ?, 1, ?, ?, ?)`,
        id,
        club,
        name,
        primaryRole(roles)!,
        JSON.stringify(roles),
        scope,
        pinHash,
        JSON.stringify(tableIds),
        now,
        now,
      );
      // The PIN never reaches the audit log, only the fact that one was set.
      record(db, now, {
        actor: input.actor,
        action: 'staff.created',
        entityType: 'staff',
        entityId: id,
        data: { name, roles, tableIds, hasPin: pinHash !== null },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'staff' }));
      return this.get(id);
    });
  }

  update(input: UpdateStaffInput): StaffView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const row = this.#row(input.staffId);
      if (row.origin === 'cloud') throw cloudManaged();
      const current = rolesOf(row);
      const nextRoles = input.roles !== undefined ? checkRoles(input.roles) : current;
      const rolesChanged = !sameRoles(nextRoles, current);
      if (input.by) {
        // You may edit only people whose roles you could assign; your own roles and employment are not yours to change.
        if (input.by.id !== row.id) assertMayManage(input.by, current);
        if (rolesChanged) {
          if (input.by.id === row.id) throw new HubError(403, 'ROLE_NOT_ALLOWED', 'Свои роли изменить нельзя');
          assertMayManage(input.by, nextRoles);
        }
        if (input.by.id === row.id && input.isActive === false) {
          throw new HubError(403, 'ROLE_NOT_ALLOWED', 'Нельзя уволить самого себя');
        }
      }
      const changed: Record<string, unknown> = {};
      const sets: string[] = [];
      const params: Array<string | number | null> = [];

      if (input.name !== undefined) {
        const name = cleanName(input.name);
        if (name !== row.name) {
          this.#assertNameFree(row.club_id, name, row.id);
          sets.push('name = ?');
          params.push(name);
          changed.name = name;
        }
      }
      if (rolesChanged) {
        sets.push('roles = ?', 'role = ?', 'scope = ?');
        params.push(JSON.stringify(nextRoles), primaryRole(nextRoles)!, scopeOf(nextRoles));
        changed.roles = nextRoles;
      }
      if (input.isActive !== undefined && (input.isActive ? 1 : 0) !== row.is_active) {
        sets.push('is_active = ?');
        params.push(input.isActive ? 1 : 0);
        changed.isActive = input.isActive;
      }
      if (input.pin !== undefined) {
        sets.push('pin_hash = ?');
        params.push(input.pin === null ? null : hashPin(checkPin(input.pin)));
        changed.pinChanged = true;
        if (input.pin === null) changed.pinRemoved = true;
      }
      if (input.tableIds !== undefined) {
        const tableIds = this.#checkTables(row.club_id, input.tableIds);
        const json = JSON.stringify(tableIds);
        if (json !== JSON.stringify(parseIds(row.table_ids))) {
          sets.push('table_ids = ?');
          params.push(json);
          changed.tableIds = tableIds;
        }
      }

      // The club must always keep someone who can manage it.
      const willBeActive = input.isActive ?? row.is_active === 1;
      const losesManager = current.includes('manager') && row.is_active === 1 && (!willBeActive || !nextRoles.includes('manager'));
      if (losesManager && this.#activeManagers(row.club_id, row.id) === 0) {
        throw new HubError(409, 'LAST_MANAGER', 'Нельзя убрать последнего управляющего');
      }
      // A person who starts counting against the license's staff limit (hired back, or no longer a manager).
      const counted = (active: boolean, roles: Role[]) => active && scopeOf(roles) === 'club';
      if (counted(willBeActive, nextRoles) && !counted(row.is_active === 1, current)) this.#assertStaffLimit(row.club_id, row.id);

      if (sets.length === 0) return this.get(row.id);

      sets.push('updated_at = ?');
      params.push(now);
      run(db, `UPDATE staff SET ${sets.join(', ')} WHERE id = ?`, ...params, row.id);
      record(db, now, {
        actor: input.actor,
        action: 'staff.updated',
        entityType: 'staff',
        entityId: row.id,
        data: changed,
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'staff' }));
      return this.get(row.id);
    });
  }

  /** 409 LICENSE_STAFF_LIMIT when the branch already has the license's maxStaff active staff (managers and the platform do not count). */
  #assertStaffLimit(club: string, exceptId: string | null): void {
    const max = this.deps.limits?.()?.maxStaff;
    if (max === null || max === undefined) return;
    const n =
      one<{ n: number }>(
        this.deps.db,
        "SELECT COUNT(*) AS n FROM staff WHERE club_id = ? AND is_active = 1 AND scope = 'club' AND id <> ?",
        club,
        exceptId ?? '',
      )?.n ?? 0;
    if (n >= max) {
      throw new HubError(409, 'LICENSE_STAFF_LIMIT', `По лицензии в филиале не больше ${max} активных сотрудников. Расширьте лицензию или отметьте уволенных.`);
    }
  }


  /**
   * Checks a PIN against the stored hash. Groundwork for PIN login (stage 3):
   * a wrong PIN and a dismissed employee look the same to the caller.
   */
  verifyPin(staffId: string, pin: string, actor: string): { ok: boolean } {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const row = this.#row(staffId);
      const ok = row.is_active === 1 && PIN_RE.test(pin) && verifyPin(pin, row.pin_hash);
      record(db, now, {
        actor,
        action: 'staff.pin_checked',
        entityType: 'staff',
        entityId: row.id,
        data: { ok },
      });
      return { ok };
    });
  }

  /** Newest first; `nextBefore` pages further back. `actors` ignores the filters. */
  audit(query: AuditQuery = {}): AuditListResponse {
    const db = this.deps.db;
    const limit = Math.min(AUDIT_MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? AUDIT_DEFAULT_LIMIT)));
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (query.actor) {
      where.push('actor = ?');
      params.push(query.actor);
    }
    if (query.action) {
      where.push("action LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(query.action)}%`);
    }
    if (query.tableId) {
      where.push("(entity_id = ? OR json_extract(data, '$.tableId') = ?)");
      params.push(query.tableId, query.tableId);
    }
    if (query.from !== undefined) {
      where.push('at >= ?');
      params.push(query.from);
    }
    if (query.to !== undefined) {
      where.push('at <= ?');
      params.push(query.to);
    }
    if (query.before !== undefined) {
      where.push('id < ?');
      params.push(query.before);
    }

    const rows = all<AuditRow>(
      db,
      `SELECT id, at, actor, action, entity_type, entity_id, data FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ?`,
      ...params,
      limit,
    );
    const entries = rows.map(toAuditView);
    const last = entries[entries.length - 1];
    const nextBefore = entries.length === limit && last ? last.id : null;
    const actors = all<{ actor: string }>(
      db,
      'SELECT DISTINCT actor FROM audit_log ORDER BY actor COLLATE NOCASE LIMIT 100',
    ).map((r) => r.actor);
    return { entries, nextBefore, actors };
  }

  #row(staffId: string): StaffRow {
    const row = one<StaffRow>(this.deps.db, 'SELECT * FROM staff WHERE id = ?', staffId);
    if (!row) throw new HubError(404, 'STAFF_NOT_FOUND', 'Сотрудник не найден');
    return row;
  }

  #assertNameFree(club: string, name: string, exceptId: string | null): void {
    const taken = one<{ id: string }>(
      this.deps.db,
      'SELECT id FROM staff WHERE club_id = ? AND is_active = 1 AND name = ? COLLATE NOCASE AND id <> ?',
      club,
      name,
      exceptId ?? '',
    );
    if (taken) throw new HubError(409, 'STAFF_NAME_TAKEN', `Сотрудник «${name}» уже есть`);
  }

  #activeManagers(club: string, exceptId: string): number {
    return (
      one<{ n: number }>(
        this.deps.db,
        "SELECT COUNT(*) AS n FROM staff WHERE club_id = ? AND role = 'manager' AND is_active = 1 AND id <> ?",
        club,
        exceptId,
      )?.n ?? 0
    );
  }

  /** Every id must be a table of the club; duplicates are dropped, order kept. */
  #checkTables(club: string, tableIds: string[]): string[] {
    const unique = [...new Set(tableIds)];
    if (unique.length === 0) return [];
    const known = new Set(
      all<{ id: string }>(
        this.deps.db,
        `SELECT id FROM billiard_tables WHERE club_id = ? AND id IN (${unique.map(() => '?').join(',')})`,
        club,
        ...unique,
      ).map((t) => t.id),
    );
    const missing = unique.find((id) => !known.has(id));
    if (missing !== undefined) throw new HubError(422, 'TABLE_NOT_FOUND', 'Стол не найден');
    return unique;
  }
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 80) throw new HubError(422, 'NAME_INVALID', 'Имя — от 1 до 80 символов');
  return name;
}

function checkPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new HubError(422, 'PIN_INVALID', 'PIN — от 4 до 6 цифр');
  return pin;
}

function parseIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
