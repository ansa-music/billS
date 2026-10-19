/**
 * Administration of companies, owners, clubs and HUB keys through any SqlDriver
 * (SQLite or PostgreSQL). Used by the CLI (apps/cloud/src/cli.ts).
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hashApiKey, hashPassword, normalizeEmail } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';

/** Thrown for problems the operator must fix (bad input, missing rows); the CLI prints the message. */
export class AdminError extends Error {}

// ---------------------------------------------------------------------------
// Secrets

/** No 0/O, 1/l/I: the password is read off a screen and typed by hand. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export const GENERATED_PASSWORD_LENGTH = 16;
export const MIN_PASSWORD_LENGTH = 8;

/** A random password over an unambiguous alphabet, with at least one upper, lower and digit. */
export function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}

/** 32 random bytes, base64url: what a HUB puts into CLOUD_API_KEY. */
export function generateHubKey(): string {
  return randomBytes(32).toString('base64url');
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AdminError(`Пароль слишком короткий: нужно не меньше ${MIN_PASSWORD_LENGTH} символов`);
  }
}

// ---------------------------------------------------------------------------
// Validation

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u',
  ү: 'u', һ: 'h', і: 'i',
};

/** Short latin slug of a club name (Cyrillic and Kazakh letters transliterated), '' when nothing is left. */
export function slugify(name: string, maxLength = 20): string {
  const latin = [...name.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join('');
  return latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

// ---------------------------------------------------------------------------
// Commands

export interface InitInput {
  company: string;
  email: string;
  name?: string;
  password?: string;
}

export interface InitResult {
  companyId: string;
  ownerId: string;
  email: string;
  /** Set only when the password was generated here. */
  generatedPassword: string | null;
}

/** Creates a company and its owner. Fails when the e-mail is already taken. */
export async function initCompany(db: SqlDriver, now: number, input: InitInput): Promise<InitResult> {
  const company = input.company.trim();
  if (!company) throw new AdminError('Укажите название компании: --company "<название>"');
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AdminError(`Неверный e-mail: ${input.email}`);
  const generatedPassword = input.password === undefined ? generatePassword() : null;
  const password = input.password ?? generatedPassword ?? '';
  checkPassword(password);
  const name = input.name?.trim() || 'Владелец';

  return db.transaction(async (tx) => {
    const taken = await tx.all<{ id: string }>('SELECT id FROM owners WHERE email = ?', [email]);
    if (taken.length) throw new AdminError(`Владелец с e-mail ${email} уже есть`);
    const companyId = randomUUID();
    const ownerId = randomUUID();
    await tx.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [companyId, company, now]);
    await tx.run(
      'INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ownerId, companyId, email, name, hashPassword(password), now],
    );
    return { companyId, ownerId, email, generatedPassword };
  });
}

export interface AddClubInput {
  name: string;
  timezone?: string;
  currency?: string;
  companyId?: string;
}

export interface AddClubResult {
  companyId: string;
  clubId: string;
  hubId: string;
  /** Shown once: only its sha256 is stored. */
  apiKey: string;
}

/** Creates a club and its HUB with a fresh random key. */
export async function addClub(db: SqlDriver, now: number, input: AddClubInput): Promise<AddClubResult> {
  const name = input.name.trim();
  if (!name) throw new AdminError('Укажите название клуба: --name "<название>"');
  const timezone = input.timezone?.trim() || 'Asia/Almaty';
  if (!isValidTimezone(timezone)) throw new AdminError(`Неизвестный часовой пояс: ${timezone} (пример: Asia/Almaty)`);
  const currency = (input.currency?.trim() || 'KZT').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AdminError(`Валюта — три латинские буквы (KZT, RUB…), а не «${input.currency}»`);

  return db.transaction(async (tx) => {
    const companies = await tx.all<{ id: string; name: string }>('SELECT id, name FROM companies ORDER BY created_at');
    let companyId: string;
    if (input.companyId) {
      if (!companies.some((c) => c.id === input.companyId)) throw new AdminError(`Компания не найдена: ${input.companyId}`);
      companyId = input.companyId;
    } else if (companies.length === 0) {
      throw new AdminError('Компаний ещё нет: сначала выполните init --company "<название>" --email <e-mail>');
    } else if (companies.length > 1) {
      const list = companies.map((c) => `${c.id} (${c.name})`).join(', ');
      throw new AdminError(`Компаний несколько — укажите --company <id>: ${list}`);
    } else {
      companyId = companies[0]!.id;
    }

    const clubId = randomUUID();
    const hubId = await freeHubId(tx, slugify(name));
    const apiKey = generateHubKey();
    await tx.run('INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      clubId,
      companyId,
      name,
      timezone,
      currency,
      now,
    ]);
    // No club_settings row: loadSettings reports version 0 with empty lists until the HUB sends its snapshot.
    await tx.run(
      `INSERT INTO hubs (id, club_id, name, api_key_hash, created_at, settings_version)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [hubId, clubId, `HUB ${name}`, hashApiKey(apiKey), now],
    );
    return { companyId, clubId, hubId, apiKey };
  });
}

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** `hub-<slug>`; a random suffix when the slug is empty or already used. */
async function freeHubId(tx: SqlDriver, slug: string): Promise<string> {
  const candidates = slug ? [`hub-${slug}`] : [];
  for (let i = 0; i < 5; i++) candidates.push(slug ? `hub-${slug}-${randomSuffix()}` : `hub-${randomSuffix()}`);
  for (const id of candidates) {
    const rows = await tx.all<{ id: string }>('SELECT id FROM hubs WHERE id = ?', [id]);
    if (!rows.length) return id;
  }
  return `hub-${randomUUID()}`;
}

/** Issues a new key for a HUB; the old key stops working at once. */
export async function newHubKey(db: SqlDriver, hubId: string): Promise<string> {
  const apiKey = generateHubKey();
  const changed = await db.run('UPDATE hubs SET api_key_hash = ? WHERE id = ?', [hashApiKey(apiKey), hubId]);
  if (changed === 0) throw new AdminError(`HUB не найден: ${hubId} (список — команда list)`);
  return apiKey;
}

export interface ResetPasswordResult {
  email: string;
  generatedPassword: string | null;
  /** Owner sessions removed: every signed-in browser has to log in again. */
  sessionsRemoved: number;
}

export async function resetPassword(db: SqlDriver, emailRaw: string, password?: string): Promise<ResetPasswordResult> {
  const email = normalizeEmail(emailRaw);
  const generatedPassword = password === undefined ? generatePassword() : null;
  const next = password ?? generatedPassword ?? '';
  checkPassword(next);
  return db.transaction(async (tx) => {
    const rows = await tx.all<{ id: string }>('SELECT id FROM owners WHERE email = ?', [email]);
    const owner = rows[0];
    if (!owner) throw new AdminError(`Владелец с e-mail ${email} не найден`);
    await tx.run('UPDATE owners SET password_hash = ? WHERE id = ?', [hashPassword(next), owner.id]);
    const sessionsRemoved = await tx.run('DELETE FROM owner_sessions WHERE owner_id = ?', [owner.id]);
    return { email, generatedPassword, sessionsRemoved };
  });
}

// ---------------------------------------------------------------------------
// Listing

export interface ListedHub {
  id: string;
  name: string;
  lastSeenAt: number | null;
}

export interface ListedClub {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  hubs: ListedHub[];
}

export interface ListedCompany {
  id: string;
  name: string;
  owners: Array<{ email: string; name: string }>;
  clubs: ListedClub[];
}

export async function listAll(db: SqlDriver): Promise<ListedCompany[]> {
  const companies = await db.all<{ id: string; name: string }>('SELECT id, name FROM companies ORDER BY created_at, id');
  const owners = await db.all<{ company_id: string; email: string; name: string }>(
    'SELECT company_id, email, name FROM owners ORDER BY created_at, email',
  );
  const clubs = await db.all<{ id: string; company_id: string; name: string; timezone: string; currency: string }>(
    'SELECT id, company_id, name, timezone, currency FROM clubs ORDER BY created_at, name',
  );
  const hubs = await db.all<{ id: string; club_id: string; name: string; last_seen_at: number | string | null }>(
    'SELECT id, club_id, name, last_seen_at FROM hubs ORDER BY created_at, id',
  );
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    owners: owners.filter((o) => o.company_id === c.id).map((o) => ({ email: o.email, name: o.name })),
    clubs: clubs
      .filter((club) => club.company_id === c.id)
      .map((club) => ({
        id: club.id,
        name: club.name,
        timezone: club.timezone,
        currency: club.currency,
        hubs: hubs
          .filter((h) => h.club_id === club.id)
          .map((h) => ({ id: h.id, name: h.name, lastSeenAt: h.last_seen_at === null ? null : Number(h.last_seen_at) })),
      })),
  }));
}
