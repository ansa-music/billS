import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AuditEntryView, AuditListResponse, Role, StaffView } from '@bills/domain';
import { ROLES } from '@bills/domain';
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

export interface StaffServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

export interface CreateStaffInput {
  name: string;
  role: Role;
  pin?: string | undefined;
  tableIds?: string[] | undefined;
  actor: string;
}

export interface UpdateStaffInput {
  staffId: string;
  name?: string | undefined;
  role?: Role | undefined;
  /** A string sets a new PIN, null removes it, undefined keeps it. */
  pin?: string | null | undefined;
  isActive?: boolean | undefined;
  tableIds?: string[] | undefined;
  actor: string;
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
  pin_hash: string | null;
  is_active: number;
  table_ids: string;
  created_at: number;
  updated_at: number;
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
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: row.is_active === 1,
    hasPin: row.pin_hash !== null,
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

/**
 * Staff, PINs and the audit log. Every command is one transaction with an
 * audit record. Who may assign which role is not enforced here yet: until PIN
 * login (stage 3) the actor is only a name, so the UI limits the choice with
 * `canAssignRole` and the HUB validates shape and uniqueness only.
 */
export class StaffService {
  readonly deps: StaffServiceDeps;

  constructor(deps: StaffServiceDeps) {
    this.deps = deps;
  }

  /** All staff of the club, active first then by name. Inactive («уволен») rows are kept. */
  list(): StaffView[] {
    const db = this.deps.db;
    return all<StaffRow>(
      db,
      'SELECT * FROM staff WHERE club_id = ? ORDER BY is_active DESC, name COLLATE NOCASE, created_at',
      clubId(db),
    ).map(toStaffView);
  }

  get(staffId: string): StaffView {
    return toStaffView(this.#row(staffId));
  }

  create(input: CreateStaffInput): StaffView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const name = cleanName(input.name);
      if (!ROLES.includes(input.role)) throw new HubError(422, 'ROLE_INVALID', 'Неизвестная роль');
      this.#assertNameFree(club, name, null);
      const pinHash = input.pin === undefined ? null : hashPin(checkPin(input.pin));
      const tableIds = this.#checkTables(club, input.tableIds ?? []);

      const id = randomUUID();
      run(
        db,
        `INSERT INTO staff (id, club_id, name, role, pin_hash, is_active, table_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        id,
        club,
        name,
        input.role,
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
        data: { name, role: input.role, tableIds, hasPin: pinHash !== null },
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
      if (input.role !== undefined && input.role !== row.role) {
        if (!ROLES.includes(input.role)) throw new HubError(422, 'ROLE_INVALID', 'Неизвестная роль');
        sets.push('role = ?');
        params.push(input.role);
        changed.role = input.role;
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
      const losesOwner =
        row.role === 'owner' &&
        row.is_active === 1 &&
        ((changed.isActive === false) || (changed.role !== undefined && changed.role !== 'owner'));
      if (losesOwner && this.#activeOwners(row.club_id, row.id) === 0) {
        throw new HubError(409, 'LAST_OWNER', 'Нельзя убрать последнего владельца');
      }

      if (sets.length === 0) return toStaffView(row);

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

  #activeOwners(club: string, exceptId: string): number {
    return (
      one<{ n: number }>(
        this.deps.db,
        "SELECT COUNT(*) AS n FROM staff WHERE club_id = ? AND role = 'owner' AND is_active = 1 AND id <> ?",
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
