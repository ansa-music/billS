import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { OwnerKeyView, OwnerView } from '@bills/domain';
import { formatAccessKey, isAccessKeyShape, keyPrefixOf, normalizeAccessKey, roleOfKeyPrefix } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';

export const OWNER_COOKIE = 'bills_owner';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;

// ---------------------------------------------------------------------------
// Passwords and API keys
// ---------------------------------------------------------------------------

/** `salt:hash` in hex, scrypt with Node defaults. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** HUB API keys are stored as sha256 hex digests. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// ---------------------------------------------------------------------------
// Owner sessions. An `owners` row is a client's MANAGER (the table name is historical):
// cabinet sign-in by e-mail + password, phone keys, MGR-… keys.
// ---------------------------------------------------------------------------

interface OwnerRow {
  id: string;
  email: string;
  name: string;
  company_id: string;
  company_name: string;
  password_hash: string;
}

const OWNER_SELECT = `SELECT o.id, o.email, o.name, o.company_id, o.password_hash, c.name AS company_name
   FROM owners o JOIN companies c ON c.id = o.company_id`;

function toView(row: OwnerRow): OwnerView {
  return { id: row.id, email: row.email, name: row.name, company: { id: row.company_id, name: row.company_name } };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Checks the password; returns the owner or null without saying which part was wrong. */
export async function authenticateOwner(db: SqlDriver, email: string, password: string): Promise<OwnerView | null> {
  const rows = await db.all<OwnerRow>(`${OWNER_SELECT} WHERE o.email = ?`, [normalizeEmail(email)]);
  const row = rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return toView(row);
}

export async function createSession(db: SqlDriver, ownerId: string, now: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM owner_sessions WHERE expires_at <= ?', [now]);
    await tx.run('INSERT INTO owner_sessions (token, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      token,
      ownerId,
      now,
      now + SESSION_TTL_MS,
    ]);
  });
  return token;
}

export async function deleteSession(db: SqlDriver, token: string): Promise<void> {
  await db.run('DELETE FROM owner_sessions WHERE token = ?', [token]);
}

export async function ownerByToken(db: SqlDriver, token: string, now: number): Promise<OwnerView | null> {
  const rows = await db.all<OwnerRow>(
    `${OWNER_SELECT} JOIN owner_sessions s ON s.owner_id = o.id WHERE s.token = ? AND s.expires_at > ?`,
    [token, now],
  );
  const row = rows[0];
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------------------
// Owner keys: sign-in on the phone by a key typed or scanned from a QR
// ---------------------------------------------------------------------------

interface OwnerKeyRow {
  id: string;
  owner_id: string;
  prefix: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

const toKeyView = (r: OwnerKeyRow): OwnerKeyView => ({
  id: r.id,
  prefix: r.prefix,
  label: r.label,
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
});

/** Issues an OWNER-… key; the key itself is returned once and stored only as sha256. */
export async function createOwnerKey(
  db: SqlDriver,
  now: number,
  ownerId: string,
  label: string,
): Promise<{ key: string; view: OwnerKeyView }> {
  const key = formatAccessKey('owner', randomBytes(16));
  const row: OwnerKeyRow = {
    id: randomUUID(),
    owner_id: ownerId,
    prefix: keyPrefixOf(key),
    label: label.trim().slice(0, 80) || 'Телефон',
    created_at: now,
    last_used_at: null,
  };
  await db.run('INSERT INTO owner_keys (id, owner_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    row.id,
    ownerId,
    hashApiKey(key),
    row.prefix,
    row.label,
    now,
  ]);
  return { key, view: toKeyView(row) };
}

export async function listOwnerKeys(db: SqlDriver, ownerId: string): Promise<OwnerKeyView[]> {
  const rows = await db.all<OwnerKeyRow>(
    'SELECT id, owner_id, prefix, label, created_at, last_used_at FROM owner_keys WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at',
    [ownerId],
  );
  return rows.map(toKeyView);
}

export async function revokeOwnerKey(db: SqlDriver, now: number, ownerId: string, keyId: string): Promise<boolean> {
  return (await db.run('UPDATE owner_keys SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL', [now, keyId, ownerId])) > 0;
}

/**
 * Owner (the client's manager) of a live key, or null (bad shape, unknown, revoked — not
 * told apart): a phone key OWNER-… (owner_keys) or the manager's long key MGR-… (manager_keys).
 * Platform keys (OWNER-…/TECH-… of TS) live in platform_keys and never match here.
 */
export async function authenticateOwnerKey(db: SqlDriver, now: number, raw: string): Promise<OwnerView | null> {
  const key = normalizeAccessKey(raw);
  if (!isAccessKeyShape(key)) return null;
  const role = roleOfKeyPrefix(key);
  const table = role === 'owner' ? 'owner_keys' : role === 'manager' ? 'manager_keys' : null;
  if (!table) return null;
  const rows = await db.all<OwnerRow & { key_id: string }>(
    `${OWNER_SELECT} JOIN ${table} k ON k.owner_id = o.id WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    [hashApiKey(key)],
  );
  const row = rows[0];
  if (!row) return null;
  await db.run(`UPDATE ${table} SET last_used_at = ? WHERE key_hash = ?`, [now, hashApiKey(key)]);
  return toView(row);
}

// ---------------------------------------------------------------------------
// Cookies (parsed and serialised by hand: no @fastify/cookie)
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure?: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.maxAgeSeconds <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
