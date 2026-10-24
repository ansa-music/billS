/**
 * Manager cabinet (the client): the license, branches within maxClubs, staff of each
 * branch with a set of roles, their six-digit keys. The `owners` table holds the
 * client's managers. Shared by Fastify (/api/company/…) and the Edge Function `owner`
 * (/owner/company/…).
 */
import { randomUUID } from 'node:crypto';
import type {
  Action,
  BranchView,
  BusinessType,
  OnboardingResponse,
  CloudKeyView,
  CloudStaffView,
  CreateBranchResponse,
  IssueCloudKeyResponse,
  LicenseView,
  Role,
} from '@bills/domain';
import {
  BUSINESS_TYPES,
  decide,
  formatShortKey,
  isShortKeyShape,
  isStaffRole,
  isWeakShortKey,
  keyPrefixOf,
  licenseGateOf,
  licenseStatus,
  normalizeAccessKey,
  normalizeRoles,
  shortKeyHashInput,
} from '@bills/domain';
import { AdminError, checkClubInput, insertClubWithHub, newHubKey } from './admin.ts';
import { hashApiKey } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import type { LicenseSigner } from './license.ts';
import { bumpClubAccess, currentLicense, reissueLicense, toLicenseView } from './license.ts';
import { businessTypeOf, initialSettings } from './settings.ts';

/** The signed-in manager: an `owners` row. */
export interface ManagerRef {
  id: string;
  companyId: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const DAY_MS = 86_400_000;

/** Refuses an action the license does not allow now (expired, blocked, missing → read-only). */
export async function requireLicensed(db: SqlDriver, now: number, companyId: string, action: Action) {
  const stored = await currentLicense(db, companyId);
  const status = licenseStatus(stored?.payload ?? null, now);
  const decision = decide(['manager'], action, licenseGateOf(status));
  if (decision === 'read_only') {
    throw new CloudError(403, 'LICENSE_READ_ONLY', status.message ?? 'Лицензия не действует — режим «только чтение»');
  }
  if (decision !== 'ok') throw new CloudError(403, 'FORBIDDEN', 'Недостаточно прав');
  return stored?.payload ?? null;
}

export async function companyLicense(db: SqlDriver, now: number, me: ManagerRef): Promise<{ license: LicenseView | null }> {
  return { license: toLicenseView(await currentLicense(db, me.companyId), now) };
}

// ---------------------------------------------------------------------------
// Branches

interface ClubRow {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  created_at: number | string;
  business_type?: string | null;
}

async function branchViews(db: SqlDriver, companyId: string, clubId?: string): Promise<BranchView[]> {
  const clubs = await db.all<ClubRow>(
    `SELECT * FROM clubs WHERE company_id = ?${clubId ? ' AND id = ?' : ''} ORDER BY created_at, id`,
    clubId ? [companyId, clubId] : [companyId],
  );
  const hubs = await db.all<{ id: string; club_id: string; name: string; last_seen_at: number | string | null }>(
    'SELECT h.id, h.club_id, h.name, h.last_seen_at FROM hubs h JOIN clubs k ON k.id = h.club_id WHERE k.company_id = ? ORDER BY h.created_at, h.id',
    [companyId],
  );
  return clubs.map((c) => ({
    id: c.id,
    name: c.name,
    timezone: c.timezone,
    currency: c.currency,
    createdAt: Number(c.created_at),
    hubs: hubs.filter((h) => h.club_id === c.id).map((h) => ({ id: h.id, name: h.name, lastSeenAt: numOrNull(h.last_seen_at) })),
    businessType: businessTypeOf(c),
  }));
}

export async function listBranches(db: SqlDriver, me: ManagerRef): Promise<{ branches: BranchView[] }> {
  return { branches: await branchViews(db, me.companyId) };
}

/** A new branch and its HUB (API key shown once); the license is re-signed with the new HUB. */
export async function createBranch(
  db: SqlDriver,
  signer: LicenseSigner,
  now: number,
  me: ManagerRef,
  raw: unknown,
): Promise<CreateBranchResponse> {
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужно название филиала');
  let input: { name: string; timezone: string; currency: string };
  try {
    input = checkClubInput({
      name: text(raw.name),
      ...(typeof raw.timezone === 'string' ? { timezone: raw.timezone } : {}),
      ...(typeof raw.currency === 'string' ? { currency: raw.currency } : {}),
    });
  } catch (e) {
    if (e instanceof AdminError) throw new CloudError(422, 'BRANCH_INVALID', e.message.replace(/: --name.*$/, ''));
    throw e;
  }
  return db.transaction(async (tx) => {
    const license = await requireLicensed(tx, now, me.companyId, 'branches.edit');
    const count = await tx.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM clubs WHERE company_id = ?', [me.companyId]);
    const max = license?.maxClubs ?? 0;
    if (Number(count[0]?.n ?? 0) >= max) {
      throw new CloudError(409, 'LICENSE_CLUB_LIMIT', `По лицензии филиалов не больше ${max}. Чтобы открыть ещё, расширьте лицензию.`);
    }
    const created = await insertClubWithHub(tx, now, me.companyId, input);
    await initialSettings(tx, created.clubId, input, now);
    await reissueLicense(tx, signer, now, me.companyId, me.id);
    const [branch] = await branchViews(tx, me.companyId, created.clubId);
    return { branch: branch!, hubId: created.hubId, hubApiKey: created.apiKey };
  });
}

/**
 * A new API key for the branch's HUB (its oldest one): the connection code is shown again.
 * The previous key stops working at once, like `new-hub-key` of the CLI.
 */
export async function reissueBranchHubKey(db: SqlDriver, now: number, me: ManagerRef, clubId: string): Promise<{ hubId: string; apiKey: string }> {
  return db.transaction(async (tx) => {
    await requireBranch(tx, me, clubId);
    await requireLicensed(tx, now, me.companyId, 'branches.edit');
    const hubs = await tx.all<{ id: string }>('SELECT id FROM hubs WHERE club_id = ? ORDER BY created_at, id LIMIT 1', [clubId]);
    if (!hubs[0]) throw new CloudError(404, 'HUB_NOT_FOUND', 'У филиала нет HUB');
    return { hubId: hubs[0].id, apiKey: await newHubKey(tx, hubs[0].id) };
  });
}

export function isBusinessType(v: unknown): v is BusinessType {
  return typeof v === 'string' && (BUSINESS_TYPES as readonly string[]).includes(v);
}

/** Billiards or cafe for a branch; its HUB(s) pull it with the access package (GET /sync/access). */
export async function setBranchBusinessType(db: SqlDriver, now: number, me: ManagerRef, clubId: string, raw: unknown): Promise<BranchView> {
  const type = isObject(raw) ? raw.type : undefined;
  if (!isBusinessType(type)) throw new CloudError(422, 'INVALID_BUSINESS_TYPE', 'Выберите тип заведения: бильярдный клуб или кофейня');
  return db.transaction(async (tx) => {
    await requireBranch(tx, me, clubId);
    await requireLicensed(tx, now, me.companyId, 'club.edit');
    await tx.run('UPDATE clubs SET business_type = ? WHERE id = ?', [type, clubId]);
    await bumpClubAccess(tx, clubId);
    const [branch] = await branchViews(tx, me.companyId, clubId);
    return branch!;
  });
}

/** What the «Первые шаги» checklist needs for every branch, in one call. */
export async function onboarding(db: SqlDriver, me: ManagerRef): Promise<OnboardingResponse> {
  const clubs = await db.all<{ id: string; name: string; business_type?: string | null }>(
    'SELECT * FROM clubs WHERE company_id = ? ORDER BY created_at, id',
    [me.companyId],
  );
  if (clubs.length === 0) return { clubs: [] };
  const ids = clubs.map((c) => c.id);
  const inList = ids.map(() => '?').join(', ');
  const hubs = await db.all<{ id: string; club_id: string; last_seen_at: number | string | null }>(
    `SELECT id, club_id, last_seen_at FROM hubs WHERE club_id IN (${inList}) ORDER BY created_at, id`,
    ids,
  );
  const counts = async (sql: string): Promise<Map<string, number>> =>
    new Map((await db.all<{ club_id: string; n: number | string }>(sql, ids)).map((r) => [r.club_id, Number(r.n)]));
  const staff = await counts(`SELECT club_id, COUNT(*) AS n FROM club_staff WHERE club_id IN (${inList}) AND is_active = 1 GROUP BY club_id`);
  const shifts = await counts(`SELECT club_id, COUNT(*) AS n FROM shifts WHERE club_id IN (${inList}) GROUP BY club_id`);
  const settings = await db.all<{ club_id: string; tariffs_json: string }>(
    `SELECT club_id, tariffs_json FROM club_settings WHERE club_id IN (${inList})`,
    ids,
  );
  const tariffs = new Map(
    settings.map((s) => {
      try {
        const list = JSON.parse(s.tariffs_json) as unknown;
        return [s.club_id, Array.isArray(list) ? list.length : 0] as const;
      } catch {
        return [s.club_id, 0] as const;
      }
    }),
  );
  return {
    clubs: clubs.map((c) => {
      const own = hubs.filter((h) => h.club_id === c.id);
      const seen = own.map((h) => numOrNull(h.last_seen_at)).filter((v): v is number => v !== null);
      return {
        clubId: c.id,
        name: c.name,
        businessType: businessTypeOf(c),
        hubId: own[0]?.id ?? null,
        hubConnected: seen.length > 0,
        lastSeenAt: seen.length ? Math.max(...seen) : null,
        staff: staff.get(c.id) ?? 0,
        tariffs: tariffs.get(c.id) ?? 0,
        shifts: shifts.get(c.id) ?? 0,
        menu: null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Staff and short keys

interface StaffRow {
  id: string;
  club_id: string;
  name: string;
  roles: string;
  is_active: number | boolean;
  created_at: number | string;
}

interface KeyRow {
  id: string;
  staff_id: string;
  kind: 'long' | 'short';
  prefix: string;
  label: string | null;
  created_at: number | string;
  expires_at: number | string | null;
  revoked_at: number | string | null;
}

const toKeyView = (k: KeyRow): CloudKeyView => ({
  id: k.id,
  kind: k.kind,
  prefix: k.prefix,
  label: k.label ?? null,
  createdAt: Number(k.created_at),
  expiresAt: numOrNull(k.expires_at),
  revokedAt: numOrNull(k.revoked_at),
});

async function staffViews(db: SqlDriver, companyId: string, filter: { clubId?: string; staffId?: string } = {}): Promise<CloudStaffView[]> {
  const where = ['company_id = ?'];
  const params: unknown[] = [companyId];
  if (filter.clubId) {
    where.push('club_id = ?');
    params.push(filter.clubId);
  }
  if (filter.staffId) {
    where.push('id = ?');
    params.push(filter.staffId);
  }
  const staff = await db.all<StaffRow>(
    `SELECT id, club_id, name, roles, is_active, created_at FROM club_staff WHERE ${where.join(' AND ')} ORDER BY created_at, id`,
    params,
  );
  if (staff.length === 0) return [];
  const keys = await db.all<KeyRow>(
    `SELECT id, staff_id, kind, prefix, label, created_at, expires_at, revoked_at FROM club_keys
     WHERE staff_id IN (${staff.map(() => '?').join(', ')}) ORDER BY created_at, id`,
    staff.map((s) => s.id),
  );
  return staff.map((s) => ({
    id: s.id,
    clubId: s.club_id,
    name: s.name,
    roles: JSON.parse(s.roles) as Role[],
    isActive: Boolean(Number(s.is_active)),
    keys: keys.filter((k) => k.staff_id === s.id).map(toKeyView),
    createdAt: Number(s.created_at),
  }));
}

async function requireBranch(db: SqlDriver, me: ManagerRef, clubId: unknown): Promise<string> {
  if (typeof clubId !== 'string' || !clubId) throw new CloudError(400, 'BAD_REQUEST', 'Укажите филиал (clubId)');
  const rows = await db.all<{ id: string }>('SELECT id FROM clubs WHERE id = ? AND company_id = ?', [clubId, me.companyId]);
  if (!rows[0]) throw new CloudError(404, 'CLUB_NOT_FOUND', 'Филиал не найден');
  return clubId;
}

async function requireStaff(db: SqlDriver, me: ManagerRef, staffId: string): Promise<CloudStaffView> {
  const [staff] = await staffViews(db, me.companyId, { staffId });
  if (!staff) throw new CloudError(404, 'STAFF_NOT_FOUND', 'Сотрудник не найден');
  return staff;
}

/** Staff roles only, any non-empty combination. */
function readRoles(raw: unknown): Role[] {
  if (!Array.isArray(raw)) throw new CloudError(422, 'ROLES_INVALID', 'Укажите роли списком');
  const r = normalizeRoles(raw);
  if (!r.ok) throw new CloudError(422, 'ROLES_INVALID', r.message);
  if (!r.roles.every(isStaffRole)) throw new CloudError(422, 'ROLES_INVALID', 'Сотруднику филиала можно дать только роли персонала');
  return r.roles;
}

async function checkStaffLimit(tx: SqlDriver, clubId: string, maxStaff: number | null | undefined): Promise<void> {
  if (maxStaff === null || maxStaff === undefined) return;
  const rows = await tx.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM club_staff WHERE club_id = ? AND is_active = 1', [clubId]);
  if (Number(rows[0]?.n ?? 0) >= maxStaff) {
    throw new CloudError(409, 'LICENSE_STAFF_LIMIT', `По лицензии в филиале не больше ${maxStaff} сотрудников`);
  }
}

export async function listStaff(db: SqlDriver, me: ManagerRef, clubId: string | null): Promise<{ staff: CloudStaffView[] }> {
  if (clubId) await requireBranch(db, me, clubId);
  return { staff: await staffViews(db, me.companyId, clubId ? { clubId } : {}) };
}

export async function createStaff(db: SqlDriver, now: number, me: ManagerRef, raw: unknown): Promise<CloudStaffView> {
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужны филиал, имя и роли');
  const name = text(raw.name).slice(0, 120);
  if (!name) throw new CloudError(422, 'STAFF_INVALID', 'Укажите имя сотрудника');
  const roles = readRoles(raw.roles);
  return db.transaction(async (tx) => {
    const clubId = await requireBranch(tx, me, raw.clubId);
    const license = await requireLicensed(tx, now, me.companyId, 'staff.edit');
    await checkStaffLimit(tx, clubId, license?.maxStaff);
    const id = randomUUID();
    await tx.run(
      'INSERT INTO club_staff (id, club_id, company_id, name, roles, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [id, clubId, me.companyId, name, JSON.stringify(roles), now, now],
    );
    await bumpClubAccess(tx, clubId);
    return requireStaff(tx, me, id);
  });
}

/** Rename, change roles, (de)activate. Allowed with a read-only license except bringing someone back. */
export async function updateStaff(db: SqlDriver, now: number, me: ManagerRef, staffId: string, raw: unknown): Promise<CloudStaffView> {
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нет изменений');
  return db.transaction(async (tx) => {
    const staff = await requireStaff(tx, me, staffId);
    const name = raw.name === undefined ? staff.name : text(raw.name).slice(0, 120);
    if (!name) throw new CloudError(422, 'STAFF_INVALID', 'Укажите имя сотрудника');
    const roles = raw.roles === undefined ? staff.roles : readRoles(raw.roles);
    if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') throw new CloudError(400, 'BAD_REQUEST', 'isActive: да или нет');
    const isActive = raw.isActive === undefined ? staff.isActive : raw.isActive;
    if (isActive && !staff.isActive) {
      const license = await requireLicensed(tx, now, me.companyId, 'staff.edit');
      await checkStaffLimit(tx, staff.clubId, license?.maxStaff);
    }
    await tx.run('UPDATE club_staff SET name = ?, roles = ?, is_active = ?, updated_at = ? WHERE id = ?', [
      name,
      JSON.stringify(roles),
      isActive ? 1 : 0,
      now,
      staffId,
    ]);
    await bumpClubAccess(tx, staff.clubId);
    return requireStaff(tx, me, staffId);
  });
}

function randomShortKey(): string {
  for (;;) {
    const key = formatShortKey(globalThis.crypto.getRandomValues(new Uint32Array(36)));
    if (key) return key;
  }
}

/** A six-digit key for a staff member, unique within the branch; shown once. */
export async function issueStaffKey(db: SqlDriver, now: number, me: ManagerRef, staffId: string, raw: unknown): Promise<IssueCloudKeyResponse> {
  const body = isObject(raw) ? raw : {};
  const label = text(body.label).slice(0, 80) || null;
  let expiresAt: number | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = body.expiresInDays;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 3650) {
      throw new CloudError(422, 'KEY_EXPIRY', 'Срок ключа — от 1 до 3650 дней');
    }
    expiresAt = now + (days as number) * DAY_MS;
  }
  let chosen: string | null = null;
  if (body.key !== undefined && body.key !== null && body.key !== '') {
    if (typeof body.key !== 'string') throw new CloudError(422, 'KEY_WEAK', 'Ключ — шесть цифр');
    chosen = normalizeAccessKey(body.key);
    if (!isShortKeyShape(chosen)) throw new CloudError(422, 'KEY_WEAK', 'Ключ — шесть цифр');
    if (isWeakShortKey(chosen)) throw new CloudError(422, 'KEY_WEAK', 'Слишком простой ключ: не используйте повторы и подряд идущие цифры');
  }
  return db.transaction(async (tx) => {
    const staff = await requireStaff(tx, me, staffId);
    await requireLicensed(tx, now, me.companyId, 'staff.edit');
    if (!staff.isActive) throw new CloudError(409, 'STAFF_INACTIVE', 'Сотрудник отключён: сначала включите его');
    const taken = async (key: string) =>
      (await tx.all<{ id: string }>('SELECT id FROM club_keys WHERE club_id = ? AND key_hash = ?', [staff.clubId, hashApiKey(shortKeyHashInput(staff.clubId, key))]))
        .length > 0;
    let key: string;
    if (chosen !== null) {
      if (await taken(chosen)) throw new CloudError(409, 'KEY_TAKEN', 'Такой ключ в филиале уже есть — выберите другой');
      key = chosen;
    } else {
      let tries = 0;
      do {
        key = randomShortKey();
        if (++tries > 50) throw new CloudError(409, 'KEY_TAKEN', 'Не удалось подобрать свободный ключ, попробуйте ещё раз');
      } while (await taken(key));
    }
    const row: KeyRow = {
      id: randomUUID(),
      staff_id: staff.id,
      kind: 'short',
      prefix: keyPrefixOf(key),
      label,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
    };
    await tx.run(
      `INSERT INTO club_keys (id, staff_id, club_id, kind, key_hash, prefix, label, created_at, expires_at)
       VALUES (?, ?, ?, 'short', ?, ?, ?, ?, ?)`,
      [row.id, staff.id, staff.clubId, hashApiKey(shortKeyHashInput(staff.clubId, key)), row.prefix, label, now, expiresAt],
    );
    await bumpClubAccess(tx, staff.clubId);
    return { key, view: toKeyView(row) };
  });
}

export async function revokeStaffKey(db: SqlDriver, now: number, me: ManagerRef, keyId: string): Promise<CloudKeyView> {
  return db.transaction(async (tx) => {
    const rows = await tx.all<KeyRow & { club_id: string }>(
      `SELECT k.id, k.staff_id, k.club_id, k.kind, k.prefix, k.label, k.created_at, k.expires_at, k.revoked_at
       FROM club_keys k JOIN club_staff s ON s.id = k.staff_id WHERE k.id = ? AND s.company_id = ?`,
      [keyId, me.companyId],
    );
    const row = rows[0];
    if (!row) throw new CloudError(404, 'KEY_NOT_FOUND', 'Ключ не найден');
    if (row.revoked_at === null) {
      await tx.run('UPDATE club_keys SET revoked_at = ? WHERE id = ?', [now, keyId]);
      await bumpClubAccess(tx, row.club_id);
      row.revoked_at = now;
    }
    return toKeyView(row);
  });
}
