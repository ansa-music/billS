/**
 * Platform cabinet (owner and tech of TS): clients — a company, its manager (an `owners`
 * row) and the license — extensions, blocking, managers' MGR-… keys, the support team.
 * Shared by Fastify (/api/platform/…) and the Edge Function `platform`.
 */
import { randomUUID } from 'node:crypto';
import type {
  Action,
  BlockClientRequest,
  ClientView,
  CreateClientRequest,
  CreateClientResponse,
  IssuedLongKey,
  PlatformMe,
  PlatformRole,
} from '@bills/domain';
import { can, canAssignRoles } from '@bills/domain';
import { addPlatformStaff, issueManagerKey, listPlatformStaff } from './access.ts';
import { generatePassword, MIN_PASSWORD_LENGTH } from './admin.ts';
import { hashPassword, normalizeEmail } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import type { LicenseSigner } from './license.ts';
import { companyHubIds, currentLicense, payloadFromTerms, readTerms, reissueLicense, storeLicense, toLicenseView } from './license.ts';

export function requirePlatformAction(me: PlatformMe, action: Action): void {
  if (!can([me.role], action)) throw new CloudError(403, 'FORBIDDEN', 'Недостаточно прав');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

interface CompanyRow {
  id: string;
  name: string;
  created_at: number | string;
  blocked: number | boolean;
  blocked_reason: string | null;
}

async function companyRow(db: SqlDriver, companyId: string): Promise<CompanyRow> {
  const rows = await db.all<CompanyRow>('SELECT id, name, created_at, blocked, blocked_reason FROM companies WHERE id = ?', [companyId]);
  if (!rows[0]) throw new CloudError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
  return rows[0];
}

async function viewOf(db: SqlDriver, now: number, c: CompanyRow): Promise<ClientView> {
  const managers = await db.all<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM owners WHERE company_id = ? ORDER BY created_at, id',
    [c.id],
  );
  const clubs = await db.all<{ id: string; name: string }>('SELECT id, name FROM clubs WHERE company_id = ? ORDER BY created_at, id', [c.id]);
  const hubs = await db.all<{ id: string; club_id: string; last_seen_at: number | string | null }>(
    'SELECT h.id, h.club_id, h.last_seen_at FROM hubs h JOIN clubs k ON k.id = h.club_id WHERE k.company_id = ? ORDER BY h.created_at, h.id',
    [c.id],
  );
  return {
    companyId: c.id,
    companyName: c.name,
    createdAt: Number(c.created_at),
    managers: managers.map((m) => ({ id: m.id, name: m.name, email: m.email })),
    branches: clubs.map((club) => {
      const own = hubs.filter((h) => h.club_id === club.id);
      const seen = own.map((h) => h.last_seen_at).filter((v) => v !== null).map(Number);
      return { id: club.id, name: club.name, hubIds: own.map((h) => h.id), lastSeenAt: seen.length ? Math.max(...seen) : null };
    }),
    license: toLicenseView(await currentLicense(db, c.id), now),
    blocked: Boolean(Number(c.blocked)),
    blockedReason: c.blocked_reason ?? null,
  };
}

export async function clientView(db: SqlDriver, now: number, companyId: string): Promise<ClientView> {
  return viewOf(db, now, await companyRow(db, companyId));
}

export async function listClients(db: SqlDriver, now: number, me: PlatformMe): Promise<{ clients: ClientView[] }> {
  requirePlatformAction(me, 'platform.view');
  const rows = await db.all<CompanyRow>('SELECT id, name, created_at, blocked, blocked_reason FROM companies ORDER BY created_at, id');
  const clients: ClientView[] = [];
  for (const r of rows) clients.push(await viewOf(db, now, r));
  return { clients };
}

export interface CreateClientOptions {
  /** apps/cloud: the manager signs in with e-mail + password. Supabase: Supabase Auth, no password here. */
  passwords: boolean;
}

export async function createClient(
  db: SqlDriver,
  signer: LicenseSigner,
  now: number,
  me: PlatformMe,
  raw: unknown,
  options: CreateClientOptions,
): Promise<CreateClientResponse> {
  requirePlatformAction(me, 'clients.edit');
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужны данные клиента');
  const req = raw as Partial<CreateClientRequest>;
  const companyName = text(req.companyName);
  const managerName = text(req.managerName);
  const email = normalizeEmail(text(req.managerEmail));
  if (!companyName) throw new CloudError(422, 'CLIENT_INVALID', 'Укажите название компании');
  if (!managerName) throw new CloudError(422, 'CLIENT_INVALID', 'Укажите имя управляющего');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new CloudError(422, 'CLIENT_INVALID', 'Неверный e-mail управляющего');
  let password: string | null = null;
  let generated = false;
  if (options.passwords) {
    if (req.managerPassword !== undefined) {
      if (typeof req.managerPassword !== 'string' || req.managerPassword.length < MIN_PASSWORD_LENGTH) {
        throw new CloudError(422, 'PASSWORD_SHORT', `Пароль — не меньше ${MIN_PASSWORD_LENGTH} символов`);
      }
      password = req.managerPassword;
    } else {
      password = generatePassword();
      generated = true;
    }
  }
  const terms = readTerms(req.license);

  return db.transaction(async (tx) => {
    const taken = await tx.all<{ id: string }>('SELECT id FROM owners WHERE email = ?', [email]);
    if (taken.length) throw new CloudError(409, 'EMAIL_TAKEN', `Управляющий с e-mail ${email} уже есть`);
    const companyId = randomUUID();
    const ownerId = randomUUID();
    await tx.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [companyId, companyName, now]);
    // Supabase: no password ('!' never verifies); the manager signs up through Supabase Auth with this e-mail.
    await tx.run('INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      ownerId,
      companyId,
      email,
      managerName,
      password === null ? '!' : hashPassword(password),
      now,
    ]);
    const managerKey = await issueManagerKey(tx, now, ownerId, companyId);
    await storeLicense(tx, signer, payloadFromTerms(terms, now, { id: companyId, name: companyName, blocked: false }, null, []), me.id);
    return {
      client: await clientView(tx, now, companyId),
      managerKey,
      ...(generated && password !== null ? { managerPassword: password } : {}),
    };
  });
}

/** Extends or changes the terms; signs a new license. */
export async function updateClientLicense(
  db: SqlDriver,
  signer: LicenseSigner,
  now: number,
  me: PlatformMe,
  companyId: string,
  raw: unknown,
): Promise<ClientView> {
  requirePlatformAction(me, 'clients.edit');
  const terms = readTerms(raw);
  return db.transaction(async (tx) => {
    const c = await companyRow(tx, companyId);
    const current = await currentLicense(tx, companyId);
    const hubIds = await companyHubIds(tx, companyId, terms.maxClubs);
    const payload = payloadFromTerms(terms, now, { id: c.id, name: c.name, blocked: Boolean(Number(c.blocked)) }, current?.payload ?? null, hubIds);
    await storeLicense(tx, signer, payload, me.id);
    return clientView(tx, now, companyId);
  });
}

export async function blockClient(
  db: SqlDriver,
  signer: LicenseSigner,
  now: number,
  me: PlatformMe,
  companyId: string,
  raw: unknown,
): Promise<ClientView> {
  requirePlatformAction(me, 'clients.edit');
  if (!isObject(raw) || typeof raw.blocked !== 'boolean') throw new CloudError(400, 'BAD_REQUEST', 'blocked: да или нет');
  const req = raw as unknown as BlockClientRequest;
  const reason = req.blocked ? text(req.reason).slice(0, 500) || null : null;
  return db.transaction(async (tx) => {
    await companyRow(tx, companyId);
    await tx.run('UPDATE companies SET blocked = ?, blocked_reason = ? WHERE id = ?', [req.blocked ? 1 : 0, reason, companyId]);
    await reissueLicense(tx, signer, now, companyId, me.id);
    return clientView(tx, now, companyId);
  });
}

/** A new MGR-… key for the client's (first) manager; earlier keys keep working. */
export async function newClientManagerKey(db: SqlDriver, now: number, me: PlatformMe, companyId: string): Promise<IssuedLongKey> {
  requirePlatformAction(me, 'clients.edit');
  return db.transaction(async (tx) => {
    await companyRow(tx, companyId);
    const owners = await tx.all<{ id: string }>('SELECT id FROM owners WHERE company_id = ? ORDER BY created_at, id LIMIT 1', [companyId]);
    if (!owners[0]) throw new CloudError(404, 'MANAGER_NOT_FOUND', 'У клиента нет управляющего');
    return issueManagerKey(tx, now, owners[0].id, companyId);
  });
}

// ---------------------------------------------------------------------------
// The support team (owner only: platform.staff)

export async function platformStaff(db: SqlDriver, me: PlatformMe) {
  requirePlatformAction(me, 'platform.view');
  return { staff: await listPlatformStaff(db) };
}

export async function hirePlatformStaff(
  db: SqlDriver,
  now: number,
  me: PlatformMe,
  raw: unknown,
): Promise<{ staff: PlatformMe; key: IssuedLongKey }> {
  requirePlatformAction(me, 'platform.staff');
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужны имя и роль');
  const name = text(raw.name);
  const role = raw.role;
  if (!name) throw new CloudError(422, 'STAFF_INVALID', 'Укажите имя');
  if (role !== 'owner' && role !== 'tech') throw new CloudError(422, 'ROLES_INVALID', 'Роль: owner или tech');
  if (!canAssignRoles([me.role], [role as PlatformRole])) throw new CloudError(403, 'FORBIDDEN', 'Недостаточно прав');
  const email = text(raw.email) || null;
  return db.transaction((tx) => addPlatformStaff(tx, now, { name, role: role as PlatformRole, email }));
}
