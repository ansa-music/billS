/**
 * Client licenses in the cloud: terms → signed `TS1.…` text (packages/domain license.ts),
 * stored as history in `licenses` (the highest seq of a company is in force).
 *
 * The private key is the secret LICENSE_SIGNING_KEY (PKCS#8 Ed25519: base64url, base64, PEM or
 * the whole generated key file, see parseSigningKey) with LICENSE_KEY_ID (default 'ts-2026').
 * Without it the cloud signs with DEV_LICENSE_KEY
 * (kid 'dev', private half in the repo) and says so in the log: such licenses are accepted
 * only by a HUB started with HUB_LICENSE_DEV_KEY=1.
 *
 * Every reissue (new client, extension, block, new branch/HUB) bumps the company's
 * access_version so all its HUBs pull GET /sync/access.
 */
import { randomUUID } from 'node:crypto';
import type { LicenseModule, LicensePayload, LicenseTermsRequest, LicenseView } from '@bills/domain';
import {
  b64urlDecodeBytes,
  b64urlEncode,
  DEV_LICENSE_KEY,
  LICENSE_MODULES,
  licensePayloadProblem,
  licenseStatus,
  licenseTermEnd,
  PLATFORM_LICENSE_PUBLIC_KEYS,
  signLicense,
} from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';

export interface LicenseSigner {
  kid: string;
  privateKey: string;
  /** Signing with the public dev key (no LICENSE_SIGNING_KEY). */
  dev: boolean;
  /** LICENSE_SIGNING_KEY is set but holds no usable key: why (signing then fails with it). */
  problem?: string;
}

export const DEFAULT_LICENSE_KEY_ID = 'ts-2026';

export const DEV_SIGNER: LicenseSigner = { kid: DEV_LICENSE_KEY.kid, privateKey: DEV_LICENSE_KEY.privateKey, dev: true };

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export interface ParsedSigningKey {
  /** PKCS#8 DER, base64url without padding. */
  privateKey: string;
  /** `kid: …` / `LICENSE_KEY_ID=…` found next to the key, if any. */
  kid: string | null;
}

function decodeKeyToken(token: string): Uint8Array | null {
  try {
    return b64urlDecodeBytes(token.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch {
    return null;
  }
}

function isPkcs8Ed25519(bytes: Uint8Array): boolean {
  return bytes.length === 48 && PKCS8_ED25519_PREFIX.every((b, i) => bytes[i] === b);
}

function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(48);
  out.set(PKCS8_ED25519_PREFIX);
  out.set(seed, 16);
  return out;
}

/**
 * The signing key as people paste it into a secret: the key alone (PKCS#8 DER in base64 or
 * base64url, or a raw 32-byte seed), a PEM block, or the whole generated key file with its
 * comments and labels (`private (pkcs8, base64url): …`, `… LICENSE_SIGNING_KEY=…`,
 * `kid: ts-2026`, a `public (raw, base64url): …` line that is skipped). BOM, CR, literal `\n`
 * and stray whitespace are ignored. Throws a plain message when no private key is found or
 * the text holds two different ones.
 */
export function parseSigningKey(raw: string): ParsedSigningKey {
  const text = raw.replace(/^﻿/, '').replace(/\\r\\n|\\n/g, '\n').replace(/\r\n?/g, '\n');
  const kid = /(?:^|[\s(])(?:kid|LICENSE_KEY_ID)\s*[:=]\s*["'«]?([a-z0-9-]{1,32})/im.exec(text)?.[1] ?? null;

  const found: Uint8Array[] = [];
  const pem = /-----BEGIN (?:ED25519 )?PRIVATE KEY-----([\s\S]*?)-----END [^-\n]*-----/.exec(text);
  if (pem) {
    const bytes = decodeKeyToken(pem[1]!.replace(/\s+/g, ''));
    if (!bytes || !isPkcs8Ed25519(bytes)) throw new Error('блок PEM в LICENSE_SIGNING_KEY — не закрытый ключ Ed25519 (PKCS#8)');
    found.push(bytes);
  } else {
    const seeds: Uint8Array[] = [];
    for (const line of text.split('\n')) {
      // The key file also lists the public half (32 bytes, like a seed): never take it for the key.
      const isPublic = /public|публичн|открыт/i.test(line);
      for (const m of line.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
        const bytes = decodeKeyToken(m[0]);
        if (!bytes) continue;
        if (isPkcs8Ed25519(bytes)) found.push(bytes);
        else if (bytes.length === 32 && !isPublic) seeds.push(bytes);
      }
    }
    // A key wrapped over several lines without PEM armor.
    if (!found.length && !seeds.length) {
      const joined = decodeKeyToken(text.replace(/\s+/g, ''));
      if (joined && isPkcs8Ed25519(joined)) found.push(joined);
      else if (joined && joined.length === 32) seeds.push(joined);
    }
    if (!found.length) found.push(...seeds.map(pkcs8FromSeed));
  }
  if (!found.length) {
    throw new Error('в LICENSE_SIGNING_KEY не найден закрытый ключ Ed25519 (нужен PKCS#8 в base64/base64url, блок PEM или 32-байтовый seed)');
  }
  const key = b64urlEncode(found[0]!);
  if (found.some((b) => b64urlEncode(b) !== key)) throw new Error('в LICENSE_SIGNING_KEY несколько разных закрытых ключей — оставьте один');
  return { privateKey: key, kid };
}

/** The private key of a pasted secret as one base64url line (see parseSigningKey). */
export function normalizeSigningKey(raw: string): string {
  return parseSigningKey(raw).privateKey;
}

/**
 * LICENSE_SIGNING_KEY / LICENSE_KEY_ID from the environment; the dev key (with a warning)
 * without them. LICENSE_KEY_ID wins over a `kid:` line inside the pasted key file.
 */
export function licenseSignerFromEnv(env: Record<string, string | undefined>, log: (m: string) => void = () => undefined): LicenseSigner {
  const raw = env.LICENSE_SIGNING_KEY ?? '';
  if (!raw.replace(/^﻿/, '').trim()) {
    log('LICENSE_SIGNING_KEY не задан: лицензии подписываются DEV-ключом (kid "dev") — их примет только HUB с HUB_LICENSE_DEV_KEY=1');
    return DEV_SIGNER;
  }
  const envKid = env.LICENSE_KEY_ID?.trim();
  try {
    const parsed = parseSigningKey(raw);
    return { kid: envKid || parsed.kid || DEFAULT_LICENSE_KEY_ID, privateKey: parsed.privateKey, dev: false };
  } catch (e) {
    const problem = (e as Error).message;
    log(`LICENSE_SIGNING_KEY: ${problem}`);
    return { kid: envKid || DEFAULT_LICENSE_KEY_ID, privateKey: '', dev: false, problem };
  }
}

/** Public keys a HUB knows: the platform's and the dev key. */
const KNOWN_PUBLIC_KEYS: Readonly<Record<string, string>> = { ...PLATFORM_LICENSE_PUBLIC_KEYS, [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey };

function bytesOf(b64url: string): Uint8Array<ArrayBuffer> {
  const src = b64urlDecodeBytes(b64url);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

async function signsFor(privateKey: string, publicKey: string): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const probe = new TextEncoder().encode('TS license key check');
  const priv = await subtle.importKey('pkcs8', bytesOf(privateKey), { name: 'Ed25519' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'Ed25519' }, priv, probe);
  const pub = await subtle.importKey('raw', bytesOf(publicKey), { name: 'Ed25519' }, false, ['verify']);
  return subtle.verify({ name: 'Ed25519' }, pub, sig, probe);
}

const signerChecks = new WeakMap<LicenseSigner, Promise<string | null>>();

/**
 * Why a signer cannot sign licenses a HUB accepts, or null: the key did not parse, or its
 * public half is not the platform key of its kid. Checked once per signer.
 */
export function signerProblem(signer: LicenseSigner): Promise<string | null> {
  if (signer.problem) return Promise.resolve(signer.problem);
  if (signer.dev) return Promise.resolve(null);
  let check = signerChecks.get(signer);
  if (!check) {
    check = (async () => {
      const own = KNOWN_PUBLIC_KEYS[signer.kid];
      if (own && (await signsFor(signer.privateKey, own))) return null;
      for (const [kid, pub] of Object.entries(KNOWN_PUBLIC_KEYS)) {
        if (kid !== signer.kid && (await signsFor(signer.privateKey, pub))) {
          return `ключ подписи относится к kid «${kid}», а LICENSE_KEY_ID — «${signer.kid}»`;
        }
      }
      return `ключ подписи не соответствует публичному ключу платформы (kid «${signer.kid}»): HUB не примет такие лицензии`;
    })().catch((e: unknown) => `ключ подписи не читается: ${(e as Error).message}`);
    signerChecks.set(signer, check);
  }
  return check;
}

async function signWith(signer: LicenseSigner, payload: LicensePayload): Promise<string> {
  const problem = await signerProblem(signer);
  if (problem) throw new Error(problem);
  return signLicense(payload, signer.privateKey, signer.kid);
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
    const text = await signWith(signer, payload);
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
    signed = await signWith(signer, payload);
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
