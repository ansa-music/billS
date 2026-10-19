/**
 * Long keys and sessions of the platform, managers' MGR-… keys and the access package a
 * HUB pulls (GET /sync/access). Runtime-neutral (node:crypto only): Fastify and the Edge
 * Functions share it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IssuedLongKey, PlatformMe, PlatformRole, Role, SyncAccessResponse, SyncKey, SyncPerson } from '@bills/domain';
import { formatAccessKey, isAccessKeyShape, keyPrefixOf, normalizeAccessKey, roleOfKeyPrefix, SESSION_TTL_MS } from '@bills/domain';
import { hashApiKey } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';
import { bumpAllAccess, bumpCompanyAccess, currentLicense } from './license.ts';
import type { HubRow } from './sync.ts';

export const PLATFORM_COOKIE = 'ts_platform';
export const PLATFORM_SESSION_TTL_MS = SESSION_TTL_MS;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => Boolean(Number(v));

// ---------------------------------------------------------------------------
// Platform staff, keys and sessions

interface PlatformStaffRow {
  id: string;
  name: string;
  role: PlatformRole;
  is_active: number | boolean;
}

const toMe = (r: PlatformStaffRow): PlatformMe => ({ id: r.id, name: r.name, role: r.role });

/** A platform person by a live long key whose prefix matches their role, or null. */
export async function authenticatePlatformKey(db: SqlDriver, now: number, raw: string): Promise<PlatformMe | null> {
  const key = normalizeAccessKey(raw);
  if (!isAccessKeyShape(key)) return null;
  const role = roleOfKeyPrefix(key);
  if (role !== 'owner' && role !== 'tech') return null;
  const hash = hashApiKey(key);
  const rows = await db.all<PlatformStaffRow>(
    `SELECT s.id, s.name, s.role, s.is_active FROM platform_staff s JOIN platform_keys k ON k.staff_id = s.id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND s.is_active = 1`,
    [hash],
  );
  const row = rows[0];
  if (!row || row.role !== role) return null;
  await db.run('UPDATE platform_keys SET last_used_at = ? WHERE key_hash = ?', [now, hash]);
  return toMe(row);
}

export async function createPlatformSession(db: SqlDriver, staffId: string, now: number): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = now + PLATFORM_SESSION_TTL_MS;
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM platform_sessions WHERE expires_at <= ?', [now]);
    await tx.run('INSERT INTO platform_sessions (token_hash, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      hashApiKey(token),
      staffId,
      now,
      expiresAt,
    ]);
  });
  return { token, expiresAt };
}

export async function deletePlatformSession(db: SqlDriver, token: string): Promise<void> {
  await db.run('DELETE FROM platform_sessions WHERE token_hash = ?', [hashApiKey(token)]);
}

export async function platformByToken(db: SqlDriver, token: string, now: number): Promise<PlatformMe | null> {
  const rows = await db.all<PlatformStaffRow>(
    `SELECT s.id, s.name, s.role, s.is_active FROM platform_staff s JOIN platform_sessions p ON p.staff_id = s.id
     WHERE p.token_hash = ? AND p.expires_at > ? AND s.is_active = 1`,
    [hashApiKey(token), now],
  );
  return rows[0] ? toMe(rows[0]) : null;
}

/** A random long key for a role (OWNER-…, TECH-…, MGR-…). */
export function newLongKey(role: Role): string {
  return formatAccessKey(role, randomBytes(16));
}

/** Adds a platform person with a long key (shown once). `key` fixes the key (demo seed). */
export async function addPlatformStaff(
  tx: SqlDriver,
  now: number,
  input: { name: string; role: PlatformRole; email?: string | null; key?: string; id?: string },
): Promise<{ staff: PlatformMe; key: IssuedLongKey }> {
  const id = input.id ?? randomUUID();
  const key = input.key ?? newLongKey(input.role);
  await tx.run('INSERT INTO platform_staff (id, name, role, email, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)', [
    id,
    input.name,
    input.role,
    input.email ?? null,
    now,
  ]);
  await tx.run('INSERT INTO platform_keys (id, staff_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    randomUUID(),
    id,
    hashApiKey(key),
    keyPrefixOf(key),
    null,
    now,
  ]);
  await bumpAllAccess(tx);
  return { staff: { id, name: input.name, role: input.role }, key: { key, prefix: keyPrefixOf(key) } };
}

export async function listPlatformStaff(db: SqlDriver): Promise<Array<PlatformMe & { isActive: boolean; createdAt: number }>> {
  const rows = await db.all<PlatformStaffRow & { created_at: number }>(
    "SELECT id, name, role, is_active, created_at FROM platform_staff ORDER BY created_at, CASE role WHEN 'owner' THEN 0 ELSE 1 END, id",
  );
  return rows.map((r) => ({ ...toMe(r), isActive: bool(r.is_active), createdAt: num(r.created_at) }));
}

// ---------------------------------------------------------------------------
// Managers' MGR-… keys

/** Issues an MGR-… key for a manager (owners row); the key is returned once. */
export async function issueManagerKey(
  tx: SqlDriver,
  now: number,
  ownerId: string,
  companyId: string,
  options: { key?: string; label?: string | null } = {},
): Promise<IssuedLongKey> {
  const key = options.key ?? newLongKey('manager');
  await tx.run('INSERT INTO manager_keys (id, owner_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    randomUUID(),
    ownerId,
    hashApiKey(key),
    keyPrefixOf(key),
    options.label ?? null,
    now,
  ]);
  await bumpCompanyAccess(tx, companyId);
  return { key, prefix: keyPrefixOf(key) };
}

/** Owner (manager) id of a live MGR-… key, or null. */
export async function managerByKey(db: SqlDriver, now: number, raw: string): Promise<string | null> {
  const key = normalizeAccessKey(raw);
  if (!isAccessKeyShape(key) || roleOfKeyPrefix(key) !== 'manager') return null;
  const hash = hashApiKey(key);
  const rows = await db.all<{ owner_id: string }>('SELECT owner_id FROM manager_keys WHERE key_hash = ? AND revoked_at IS NULL', [hash]);
  if (!rows[0]) return null;
  await db.run('UPDATE manager_keys SET last_used_at = ? WHERE key_hash = ?', [now, hash]);
  return rows[0].owner_id;
}

// ---------------------------------------------------------------------------
// GET /sync/access

/** Version of a HUB's access package: the company's plus its club's (both only grow). */
export async function accessVersionOf(db: SqlDriver, clubId: string): Promise<number> {
  const rows = await db.all<{ v: number | string | null }>(
    `SELECT (c.access_version + k.access_version) AS v FROM clubs k JOIN companies c ON c.id = k.company_id WHERE k.id = ?`,
    [clubId],
  );
  return num(rows[0]?.v ?? 0);
}

interface KeyRow {
  id: string;
  person_id: string;
  kind: 'long' | 'short';
  key_hash: string;
  prefix: string;
  label: string | null;
  expires_at: number | string | null;
  revoked_at: number | string | null;
}

const toSyncKey = (r: KeyRow): SyncKey => ({
  id: r.id,
  personId: r.person_id,
  kind: r.kind,
  keyHash: r.key_hash,
  prefix: r.prefix,
  label: r.label ?? null,
  expiresAt: numOrNull(r.expires_at),
  revokedAt: numOrNull(r.revoked_at),
});

/**
 * The access package of one HUB: license, the platform, the company's managers and the
 * staff of THIS branch with their live keys. Keys of other branches never leave the cloud.
 */
export async function accessPackage(db: SqlDriver, hub: HubRow): Promise<SyncAccessResponse> {
  const clubs = await db.all<{ id: string; company_id: string }>('SELECT id, company_id FROM clubs WHERE id = ?', [hub.club_id]);
  const club = clubs[0];
  if (!club) throw new Error(`club of hub ${hub.id} is missing`);
  const version = await accessVersionOf(db, club.id);
  const license = await currentLicense(db, club.company_id);

  const platform = await db.all<{ id: string; name: string; role: PlatformRole }>(
    "SELECT id, name, role FROM platform_staff WHERE is_active = 1 ORDER BY created_at, CASE role WHEN 'owner' THEN 0 ELSE 1 END, id",
  );
  const managers = await db.all<{ id: string; name: string }>('SELECT id, name FROM owners WHERE company_id = ? ORDER BY created_at, id', [
    club.company_id,
  ]);
  const staff = await db.all<{ id: string; name: string; roles: string; is_active: number | boolean }>(
    'SELECT id, name, roles, is_active FROM club_staff WHERE club_id = ? ORDER BY created_at, id',
    [club.id],
  );
  const people: SyncPerson[] = [
    ...platform.map((p): SyncPerson => ({ id: p.id, name: p.name, roles: [p.role], isActive: true, scope: 'platform' })),
    ...managers.map((m): SyncPerson => ({ id: m.id, name: m.name, roles: ['manager'], isActive: true, scope: 'company' })),
    ...staff.map(
      (s): SyncPerson => ({ id: s.id, name: s.name, roles: JSON.parse(s.roles) as Role[], isActive: bool(s.is_active), scope: 'club' }),
    ),
  ];

  const platformKeys = await db.all<KeyRow>(
    `SELECT k.id, k.staff_id AS person_id, 'long' AS kind, k.key_hash, k.prefix, k.label, NULL AS expires_at, k.revoked_at
     FROM platform_keys k JOIN platform_staff s ON s.id = k.staff_id
     WHERE s.is_active = 1 AND k.revoked_at IS NULL
     ORDER BY s.created_at, CASE s.role WHEN 'owner' THEN 0 ELSE 1 END, s.id, k.created_at, k.id`,
  );
  const managerKeys = await db.all<KeyRow>(
    `SELECT k.id, k.owner_id AS person_id, 'long' AS kind, k.key_hash, k.prefix, k.label, NULL AS expires_at, k.revoked_at
     FROM manager_keys k JOIN owners o ON o.id = k.owner_id
     WHERE o.company_id = ? AND k.revoked_at IS NULL ORDER BY k.created_at, k.id`,
    [club.company_id],
  );
  const clubKeys = await db.all<KeyRow>(
    `SELECT k.id, k.staff_id AS person_id, k.kind, k.key_hash, k.prefix, k.label, k.expires_at, k.revoked_at
     FROM club_keys k JOIN club_staff s ON s.id = k.staff_id
     WHERE k.club_id = ? AND s.club_id = ? AND k.revoked_at IS NULL ORDER BY k.created_at, k.id`,
    [club.id, club.id],
  );
  return {
    version,
    license: license?.signed ?? null,
    clubId: club.id,
    people,
    keys: [...platformKeys, ...managerKeys, ...clubKeys].map(toSyncKey),
  };
}
