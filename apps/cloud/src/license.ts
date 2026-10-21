/**
 * Client licenses in the cloud: terms → signed `TS1.…` text (packages/domain license.ts),
 * stored as history in `licenses` (the highest seq of a company is in force).
 *
 * The private key is the secret LICENSE_SIGNING_KEY (PKCS#8 Ed25519, base64url or base64)
 * with LICENSE_KEY_ID (default 'ts-2026'). Without it the cloud signs with DEV_LICENSE_KEY
 * (kid 'dev', private half in the repo) and says so in the log: such licenses are accepted
 * only by a HUB started with HUB_LICENSE_DEV_KEY=1.
 *
 * Every reissue (new client, extension, block, new branch/HUB) bumps the company's
 * access_version so all its HUBs pull GET /sync/access.
 */
import { randomUUID } from 'node:crypto';
import type { LicenseModule, LicensePayload, LicenseTermsRequest, LicenseView } from '@bills/domain';
import { DEV_LICENSE_KEY, LICENSE_MODULES, licensePayloadProblem, licenseStatus, licenseTermEnd, signLicense } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';

export interface LicenseSigner {
  kid: string;
  privateKey: string;
  /** Signing with the public dev key (no LICENSE_SIGNING_KEY). */
  dev: boolean;
}

export const DEFAULT_LICENSE_KEY_ID = 'ts-2026';

export const DEV_SIGNER: LicenseSigner = { kid: DEV_LICENSE_KEY.kid, privateKey: DEV_LICENSE_KEY.privateKey, dev: true };

/**
 * A private key as people paste it into a secret: PEM (`-----BEGIN PRIVATE KEY-----` … with line
 * breaks), base64 with padding or base64url — all become one base64url line.
 */
export function normalizeSigningKey(raw: string): string {
  return raw
    .replace(/-----(BEGIN|END)[^-]*-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** LICENSE_SIGNING_KEY / LICENSE_KEY_ID from the environment; the dev key (with a warning) without them. */
export function licenseSignerFromEnv(env: Record<string, string | undefined>, log: (m: string) => void = () => undefined): LicenseSigner {
  const key = env.LICENSE_SIGNING_KEY?.trim() ? normalizeSigningKey(env.LICENSE_SIGNING_KEY) : '';
  if (!key) {
    log('LICENSE_SIGNING_KEY не задан: лицензии подписываются DEV-ключом (kid "dev") — их примет только HUB с HUB_LICENSE_DEV_KEY=1');
    return DEV_SIGNER;
  }
  return { kid: env.LICENSE_KEY_ID?.trim() || DEFAULT_LICENSE_KEY_ID, privateKey: key, dev: false };
}

// ---------------------------------------------------------------------------
// Stored licenses

interface LicenseRow {
  id: string;
  payload_json: string;
  signed: string;
}

export interface StoredLicense {
  payload: LicensePayload;
  signed: string;
}

export async function currentLicense(db: SqlDriver, companyId: string): Promise<StoredLicense | null> {
  const rows = await db.all<LicenseRow>("SELECT id, payload_json, signed FROM licenses WHERE company_id = ? AND signed <> '' ORDER BY seq DESC LIMIT 1", [
    companyId,
  ]);
  const row = rows[0];
  return row ? { payload: JSON.parse(row.payload_json) as LicensePayload, signed: row.signed } : null;
}

export function toLicenseView(stored: StoredLicense | null, now: number): LicenseView | null {
  if (!stored) return null;
  return { payload: stored.payload, status: licenseStatus(stored.payload, now), signed: stored.signed };
}

/**
 * Signs licenses stored without a signature (signed = ''): written by SQL that cannot sign,
 * e.g. public.ts_seed_demo_cloud on Supabase. The Edge Functions call it before handling a
 * request; a payload that fails the domain check is logged and left alone. Returns how many.
 */
export async function signPendingLicenses(db: SqlDriver, signer: LicenseSigner, log: (m: string) => void = () => undefined): Promise<number> {
  const rows = await db.all<{ id: string; company_id: string; payload_json: string }>(
    "SELECT id, company_id, payload_json FROM licenses WHERE signed = '' ORDER BY company_id, seq",
  );
  let signed = 0;
  for (const row of rows) {
    let payload: LicensePayload;
    try {
      payload = JSON.parse(row.payload_json) as LicensePayload;
    } catch {
      log(`Лицензия ${row.id}: payload не JSON — не подписана`);
      continue;
    }
    const problem = licensePayloadProblem(payload);
    if (problem || payload.companyId !== row.company_id) {
      log(`Лицензия ${row.id}: ${problem ?? 'чужая компания'} — не подписана`);
      continue;
    }
    const text = await signLicense(payload, signer.privateKey, signer.kid);
    await db.transaction(async (tx) => {
      const changed = await tx.run("UPDATE licenses SET signed = ?, payload_json = ? WHERE id = ? AND signed = ''", [
        text,
        JSON.stringify(payload),
        row.id,
      ]);
      if (changed > 0) await bumpCompanyAccess(tx, row.company_id);
    });
    signed++;
  }
  return signed;
}

/** Everything every HUB of the company has to pull again. */
export async function bumpCompanyAccess(tx: SqlDriver, companyId: string): Promise<void> {
  await tx.run('UPDATE companies SET access_version = access_version + 1 WHERE id = ?', [companyId]);
}

/** Only the HUB(s) of one branch (its staff and keys changed). */
export async function bumpClubAccess(tx: SqlDriver, clubId: string): Promise<void> {
  await tx.run('UPDATE clubs SET access_version = access_version + 1 WHERE id = ?', [clubId]);
}

/** Platform people or keys changed: every HUB of every client. */
export async function bumpAllAccess(tx: SqlDriver): Promise<void> {
  await tx.run('UPDATE companies SET access_version = access_version + 1');
}

/**
 * Signs and stores a payload as the company's license in force; bumps access_version.
 * Writes only (no reads), so scripts/supabase-sql.ts can print it as SQL.
 */
export async function storeLicense(
  tx: SqlDriver,
  signer: LicenseSigner,
  payload: LicensePayload,
  issuedBy: string | null,
): Promise<StoredLicense> {
  let signed: string;
  try {
    signed = await signLicense(payload, signer.privateKey, signer.kid);
  } catch (e) {
    throw new CloudError(
      500,
      'LICENSE_SIGN_FAILED',
      `Не удалось подписать лицензию: ${(e as Error).message}. Проверьте секреты функций: LICENSE_SIGNING_KEY — закрытый ключ Ed25519 (PKCS#8, base64 или PEM), LICENSE_KEY_ID — строчные латинские буквы, цифры, дефис (сейчас «${signer.kid}»)`,
    );
  }
  await tx.run(
    `INSERT INTO licenses (id, company_id, seq, payload_json, signed, issued_at, issued_by)
     VALUES (?, ?, (SELECT COALESCE(MAX(l.seq), 0) + 1 FROM licenses l WHERE l.company_id = ?), ?, ?, ?, ?)`,
    [payload.id, payload.companyId, payload.companyId, JSON.stringify(payload), signed, payload.issuedAt, issuedBy],
  );
  await bumpCompanyAccess(tx, payload.companyId);
  return { payload, signed };
}

/** HUB ids of the company's first `maxClubs` branches (oldest first). */
export async function companyHubIds(db: SqlDriver, companyId: string, maxClubs: number): Promise<string[]> {
  const clubs = await db.all<{ id: string }>('SELECT id FROM clubs WHERE company_id = ? ORDER BY created_at, id', [companyId]);
  const allowed = clubs.slice(0, maxClubs).map((c) => c.id);
  if (allowed.length === 0) return [];
  const hubs = await db.all<{ id: string; club_id: string }>(
    `SELECT id, club_id FROM hubs WHERE club_id IN (${allowed.map(() => '?').join(', ')}) ORDER BY created_at, id`,
    allowed,
  );
  return hubs.map((h) => h.id);
}

// ---------------------------------------------------------------------------
// Terms

const bad = (message: string): CloudError => new CloudError(422, 'LICENSE_TERMS', message);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function limit(v: unknown, name: string): number | null {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 0) throw bad(`${name}: целое число не меньше 0 или пусто`);
  return v as number;
}

/** Checks a terms request (loose JSON) and returns it typed. */
export function readTerms(raw: unknown): LicenseTermsRequest {
  if (!isObject(raw)) throw bad('Нужны условия лицензии');
  const term = raw.term;
  if (!isObject(term)) throw bad('Укажите срок');
  let t: LicenseTermsRequest['term'];
  if (term.kind === 'trial') {
    if (term.days !== 3 && term.days !== 7) throw bad('Пробный период — 3 или 7 дней');
    t = { kind: 'trial', days: term.days };
  } else if (term.kind === 'months') {
    if (!Number.isInteger(term.months) || (term.months as number) < 1 || (term.months as number) > 36) throw bad('От 1 до 36 месяцев');
    t = { kind: 'months', months: term.months as number };
  } else if (term.kind === 'until') {
    if (typeof term.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(term.date)) throw bad('Дата — в виде ГГГГ-ММ-ДД');
    t = { kind: 'until', date: term.date };
  } else {
    throw bad('Срок: trial, months или until');
  }
  if (raw.plan !== undefined && raw.plan !== 'trial' && raw.plan !== 'paid') throw bad('План: trial или paid');
  if (!Number.isInteger(raw.maxClubs) || (raw.maxClubs as number) < 1 || (raw.maxClubs as number) > 1000) {
    throw bad('Филиалов: целое число от 1');
  }
  const modulesRaw = raw.modules;
  if (!isObject(modulesRaw)) throw bad('Укажите модули');
  const modules = {} as Record<LicenseModule, boolean>;
  for (const m of LICENSE_MODULES) {
    if (typeof modulesRaw[m] !== 'boolean') throw bad(`Модуль ${m}: да или нет`);
    modules[m] = modulesRaw[m] as boolean;
  }
  if (raw.fromCurrentEnd !== undefined && typeof raw.fromCurrentEnd !== 'boolean') throw bad('fromCurrentEnd: да или нет');
  return {
    term: t,
    ...(raw.plan !== undefined ? { plan: raw.plan as 'trial' | 'paid' } : {}),
    maxClubs: raw.maxClubs as number,
    maxTables: limit(raw.maxTables, 'Столов'),
    maxStaff: limit(raw.maxStaff, 'Сотрудников'),
    modules,
    ...(raw.fromCurrentEnd !== undefined ? { fromCurrentEnd: raw.fromCurrentEnd as boolean } : {}),
  };
}

/**
 * New payload from terms. An extension (there is a license already) starts at the end of
 * the current term unless `fromCurrentEnd: false`; the license keeps its validFrom then.
 */
export function payloadFromTerms(
  terms: LicenseTermsRequest,
  now: number,
  company: { id: string; name: string; blocked: boolean },
  current: LicensePayload | null,
  hubIds: string[],
): LicensePayload {
  const extend = current !== null && terms.fromCurrentEnd !== false;
  const from = extend && terms.term.kind !== 'until' ? Math.max(now, current.validUntil) : now;
  let validUntil: number;
  try {
    validUntil = licenseTermEnd(terms.term, from);
  } catch (e) {
    throw bad((e as Error).message);
  }
  const validFrom = extend ? Math.min(current.validFrom, now) : now;
  if (validUntil <= validFrom) throw bad('Дата окончания должна быть в будущем');
  return {
    v: 1,
    id: randomUUID(),
    companyId: company.id,
    companyName: company.name,
    plan: terms.plan ?? (terms.term.kind === 'trial' ? 'trial' : 'paid'),
    issuedAt: now,
    validFrom,
    validUntil,
    maxClubs: terms.maxClubs,
    maxTables: terms.maxTables ?? null,
    maxStaff: terms.maxStaff ?? null,
    modules: terms.modules,
    hubIds,
    blocked: company.blocked,
  };
}

/** The current license again with fresh hubIds / blocked / name (new branch, block, rename). */
export async function reissueLicense(
  tx: SqlDriver,
  signer: LicenseSigner,
  now: number,
  companyId: string,
  issuedBy: string | null,
): Promise<StoredLicense | null> {
  const current = await currentLicense(tx, companyId);
  if (!current) {
    await bumpCompanyAccess(tx, companyId);
    return null;
  }
  const rows = await tx.all<{ name: string; blocked: number | boolean }>('SELECT name, blocked FROM companies WHERE id = ?', [companyId]);
  const company = rows[0];
  if (!company) throw new CloudError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
  const payload: LicensePayload = {
    ...current.payload,
    id: randomUUID(),
    companyName: company.name,
    issuedAt: now,
    hubIds: await companyHubIds(tx, companyId, current.payload.maxClubs),
    blocked: Boolean(Number(company.blocked)),
  };
  return storeLicense(tx, signer, payload, issuedBy);
}
