import type { LicenseGate, LicenseModule } from './permissions.ts';
import { LICENSE_MODULES } from './permissions.ts';

/**
 * Licenses: what a client (a company) bought and until when.
 *
 * The platform owner sets the terms in the cloud; the cloud signs them with the
 * platform's Ed25519 key and hands the signed text to every HUB of the client
 * (sync). The HUB checks the signature with the public key built into TS, so a
 * manager cannot extend or widen the license by editing their own HUB's
 * database: a changed byte breaks the signature, and the HUB re-checks the
 * stored license on every start. The signed text works offline until
 * `validUntil`.
 *
 * Text form: `TS1.<kid>.<payload base64url>.<signature base64url>`; the
 * signature covers the bytes `TS1.<kid>.<payload base64url>`.
 *
 * Signing and checking use WebCrypto (`crypto.subtle`, Ed25519), present in
 * Node 24, Deno (Supabase Edge Functions) and current browsers.
 */

export interface LicensePayload {
  v: 1;
  /** License id: changes with every reissue (extension, new branch, block). */
  id: string;
  companyId: string;
  companyName: string;
  plan: 'trial' | 'paid';
  issuedAt: number;
  validFrom: number;
  /** Exclusive: from this instant the client is read-only. */
  validUntil: number;
  /** Branches the client may have. */
  maxClubs: number;
  /** null = no limit. */
  maxTables: number | null;
  /** Active staff per branch; null = no limit. Managers and the platform do not count. */
  maxStaff: number | null;
  modules: Record<LicenseModule, boolean>;
  /**
   * HUBs this license may run on (HUB_ID of each branch; a HUB without a cloud
   * connection is `club:<local club id>`). At most `maxClubs` branches' HUBs.
   */
  hubIds: string[];
  /** The platform blocked the client: read-only right away, whatever the dates. */
  blocked: boolean;
}

export const LICENSE_PREFIX = 'TS1';

/**
 * Public keys of the platform by key id (raw Ed25519, base64url). The private
 * half of `ts-2026` is the Supabase secret LICENSE_SIGNING_KEY, never in the repo.
 */
export const PLATFORM_LICENSE_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  'ts-2026': 'yTokfUh8loDgkuijOBknZqx-lhevBZCSwlCNKRLKF-A',
};

/**
 * Development, tests and the self-hosted demo: a key pair whose private half
 * IS in the repo, so anyone can sign with it. A HUB accepts it only when told
 * so (HUB_LICENSE_DEV_KEY=1), the cloud uses it only without LICENSE_SIGNING_KEY.
 */
export const DEV_LICENSE_KEY = {
  kid: 'dev',
  publicKey: 'OsVvd4K71ra_J4pQy8asUy5rHb34MoSA6LfMYZlSU4c',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEINR2YI5oFjWrEhLVSSaUSFwpYNZRVpWov1dQv4OSVwv5',
} as const;

const DAY_MS = 86_400_000;

/** How far the HUB clock may be behind the cloud's when a fresh license arrives (validFrom). */
export const LICENSE_CLOCK_TOLERANCE_MS = 15 * 60_000;
/** Warn the client this many days before the end. */
export const LICENSE_WARN_DAYS = 3;

// ── base64url without Buffer (the domain runs in browsers too) ─────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

export function b64urlDecodeBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(clean) || clean.length % 4 === 1) throw new Error('bad base64url');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]!) : 0));
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available');
  return s;
}

/** Copies into a fresh ArrayBuffer-backed view (WebCrypto wants BufferSource, not SharedArrayBuffer views). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

// ── Payload checks ──────────────────────────────────────────────────────────

/** Structural check of a decoded payload; returns a message for the first problem. */
export function licensePayloadProblem(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'not an object';
  const o = p as Record<string, unknown>;
  if (o.v !== 1) return 'unknown version';
  for (const k of ['id', 'companyId', 'companyName'] as const) if (typeof o[k] !== 'string' || !o[k]) return `${k} missing`;
  if (o.plan !== 'trial' && o.plan !== 'paid') return 'plan';
  for (const k of ['issuedAt', 'validFrom', 'validUntil'] as const) if (!Number.isFinite(o[k])) return `${k} missing`;
  if ((o.validUntil as number) <= (o.validFrom as number)) return 'validUntil before validFrom';
  if (!Number.isInteger(o.maxClubs) || (o.maxClubs as number) < 1) return 'maxClubs';
  for (const k of ['maxTables', 'maxStaff'] as const) {
    if (o[k] !== null && (!Number.isInteger(o[k]) || (o[k] as number) < 0)) return k;
  }
  if (typeof o.modules !== 'object' || o.modules === null) return 'modules';
  for (const m of LICENSE_MODULES) if (typeof (o.modules as Record<string, unknown>)[m] !== 'boolean') return `modules.${m}`;
  if (!Array.isArray(o.hubIds) || !o.hubIds.every((h) => typeof h === 'string')) return 'hubIds';
  if (typeof o.blocked !== 'boolean') return 'blocked';
  return null;
}

// ── Sign and verify ─────────────────────────────────────────────────────────

/** Signs a payload with a PKCS#8 Ed25519 private key (base64url or base64). */
export async function signLicense(payload: LicensePayload, privateKeyPkcs8: string, kid: string): Promise<string> {
  const problem = licensePayloadProblem(payload);
  if (problem) throw new Error(`Invalid license payload: ${problem}`);
  if (!/^[a-z0-9-]{1,32}$/.test(kid)) throw new Error('Invalid key id');
  const key = await subtle().importKey('pkcs8', buf(b64urlDecodeBytes(privateKeyPkcs8.replace(/\+/g, '-').replace(/\//g, '_'))), { name: 'Ed25519' }, false, ['sign']);
  const body = `${LICENSE_PREFIX}.${kid}.${b64urlEncode(utf8.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key, buf(utf8.encode(body))));
  return `${body}.${b64urlEncode(sig)}`;
}

export type LicenseCheck =
  | { ok: true; license: LicensePayload; kid: string }
  | { ok: false; reason: 'format' | 'unknown_key' | 'signature' | 'payload'; message: string };

/**
 * Checks the signature against the given public keys (kid → raw key base64url)
 * and the payload's shape. Says nothing about dates or which HUB — see `licenseStatus`.
 */
export async function verifyLicense(text: string, publicKeys: Readonly<Record<string, string>>): Promise<LicenseCheck> {
  const parts = text.trim().split('.');
  if (parts.length !== 4 || parts[0] !== LICENSE_PREFIX) return { ok: false, reason: 'format', message: 'Это не лицензия TS' };
  const [, kid, payloadB64, sigB64] = parts as [string, string, string, string];
  const pub = publicKeys[kid];
  if (!pub) return { ok: false, reason: 'unknown_key', message: 'Лицензия подписана неизвестным ключом' };
  let valid = false;
  try {
    const key = await subtle().importKey('raw', buf(b64urlDecodeBytes(pub)), { name: 'Ed25519' }, false, ['verify']);
    valid = await subtle().verify(
      { name: 'Ed25519' },
      key,
      buf(b64urlDecodeBytes(sigB64)),
      buf(utf8.encode(`${LICENSE_PREFIX}.${kid}.${payloadB64}`)),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature', message: 'Подпись лицензии не сходится: лицензия изменена или поддельная' };
  let payload: unknown;
  try {
    payload = JSON.parse(fromUtf8.decode(b64urlDecodeBytes(payloadB64)));
  } catch {
    return { ok: false, reason: 'payload', message: 'Лицензия повреждена' };
  }
  const problem = licensePayloadProblem(payload);
  if (problem) return { ok: false, reason: 'payload', message: `Лицензия повреждена (${problem})` };
  return { ok: true, license: payload as LicensePayload, kid };
}

/** Reads the payload WITHOUT checking the signature — for showing a pasted license before installing. */
export function peekLicense(text: string): LicensePayload | null {
  const parts = text.trim().split('.');
  if (parts.length !== 4 || parts[0] !== LICENSE_PREFIX) return null;
  try {
    const p = JSON.parse(fromUtf8.decode(b64urlDecodeBytes(parts[2]!)));
    return licensePayloadProblem(p) ? null : (p as LicensePayload);
  } catch {
    return null;
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

export type LicenseState =
  | 'active'
  | 'expiring' // ≤ LICENSE_WARN_DAYS left
  | 'last_day' // < 24 h left
  | 'expired'
  | 'blocked'
  | 'not_yet' // validFrom is ahead even with the clock tolerance
  | 'wrong_hub' // signed for other HUBs
  | 'missing'
  | 'invalid'; // stored license fails the signature check

export interface LicenseStatus {
  state: LicenseState;
  /** New games, orders and settings changes are refused (see READ_ONLY_ACTIONS). */
  readOnly: boolean;
  /** Something to tell people: warning or the reason for read-only; null when all is fine. */
  message: string | null;
  plan: LicensePayload['plan'] | null;
  companyName: string | null;
  validUntil: number | null;
  /** Whole days left, rounded up; 0 when over. null without a license. */
  daysLeft: number | null;
  modules: Record<LicenseModule, boolean>;
  maxClubs: number | null;
  maxTables: number | null;
  maxStaff: number | null;
  /** Id of the license in force. */
  licenseId: string | null;
}

const ALL_MODULES = Object.fromEntries(LICENSE_MODULES.map((m) => [m, true])) as Record<LicenseModule, boolean>;
const NO_MODULES = Object.fromEntries(LICENSE_MODULES.map((m) => [m, false])) as Record<LicenseModule, boolean>;

export interface LicenseStatusOptions {
  /** This HUB's id (`hubIds` must contain it). Omit in the cloud. */
  hubId?: string;
  /**
   * The latest time this HUB has ever seen (kept in its database). Winding the
   * clock back does not bring an expired license back: the check uses the later
   * of `now` and this.
   */
  highWater?: number;
  /** The stored license failed `verifyLicense`. */
  invalid?: boolean;
}

function dateRu(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

/** Where a license stands at `now`. */
export function licenseStatus(license: LicensePayload | null, now: number, options: LicenseStatusOptions = {}): LicenseStatus {
  const base = {
    plan: license?.plan ?? null,
    companyName: license?.companyName ?? null,
    validUntil: license?.validUntil ?? null,
    modules: license ? { ...NO_MODULES, ...license.modules } : ALL_MODULES,
    maxClubs: license?.maxClubs ?? null,
    maxTables: license?.maxTables ?? null,
    maxStaff: license?.maxStaff ?? null,
    licenseId: license?.id ?? null,
  };
  if (options.invalid) {
    return { ...base, state: 'invalid', readOnly: true, daysLeft: null, message: 'Лицензия не прошла проверку подписи — режим «только чтение». Обратитесь в поддержку TS.' };
  }
  if (!license) {
    return { ...base, state: 'missing', readOnly: true, daysLeft: null, message: 'Лицензия не установлена — режим «только чтение». Подключите HUB к облаку или вставьте лицензию.' };
  }
  const t = Math.max(now, options.highWater ?? now);
  const left = license.validUntil - t;
  const daysLeft = Math.max(0, Math.ceil(left / DAY_MS));
  if (license.blocked) {
    return { ...base, state: 'blocked', readOnly: true, daysLeft, message: 'Доступ приостановлен владельцем платформы — режим «только чтение». Данные сохранены.' };
  }
  if (options.hubId !== undefined && !license.hubIds.includes(options.hubId)) {
    return { ...base, state: 'wrong_hub', readOnly: true, daysLeft, message: 'Лицензия выдана для другого филиала — режим «только чтение».' };
  }
  if (now + LICENSE_CLOCK_TOLERANCE_MS < license.validFrom) {
    return { ...base, state: 'not_yet', readOnly: true, daysLeft, message: `Лицензия начнёт действовать ${dateRu(license.validFrom)}. Проверьте часы HUB.` };
  }
  if (left <= 0) {
    return { ...base, state: 'expired', readOnly: true, daysLeft: 0, message: `Срок лицензии истёк ${dateRu(license.validUntil)} — режим «только чтение»: новые игры не открываются, идущие доигрываются и оплачиваются, данные сохранены. Продлите доступ.` };
  }
  if (left < DAY_MS) {
    return { ...base, state: 'last_day', readOnly: false, daysLeft, message: 'Лицензия заканчивается сегодня. Продлите доступ, чтобы клуб не перешёл в режим «только чтение».' };
  }
  if (left <= LICENSE_WARN_DAYS * DAY_MS) {
    return { ...base, state: 'expiring', readOnly: false, daysLeft, message: `Лицензия заканчивается через ${daysLeft} дн. (${dateRu(license.validUntil)}). Продлите доступ.` };
  }
  return { ...base, state: 'active', readOnly: false, daysLeft, message: null };
}

export function licenseGateOf(status: LicenseStatus | null | undefined): LicenseGate | null {
  return status ? { readOnly: status.readOnly, modules: status.modules } : null;
}

// ── Terms the platform owner picks ──────────────────────────────────────────

/** How long access lasts: a 3- or 7-day trial, N months, or until a date. */
export type LicenseTerm =
  | { kind: 'trial'; days: 3 | 7 }
  | { kind: 'months'; months: number }
  | { kind: 'until'; date: string /* YYYY-MM-DD, access through the end of that day (UTC+5) */ };

/** Kazakhstan time (UTC+5): "until 31.12" means through the end of that local day. */
const KZ_OFFSET_MS = 5 * 3_600_000;

/** End of a term started at `from` (epoch ms, exclusive). Throws on a bad term. */
export function licenseTermEnd(term: LicenseTerm, from: number): number {
  if (term.kind === 'trial') {
    if (term.days !== 3 && term.days !== 7) throw new Error('Пробный период — 3 или 7 дней');
    return from + term.days * DAY_MS;
  }
  if (term.kind === 'months') {
    if (!Number.isInteger(term.months) || term.months < 1 || term.months > 36) throw new Error('От 1 до 36 месяцев');
    const d = new Date(from);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + term.months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    return end;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term.date);
  if (!m) throw new Error('Дата — в виде ГГГГ-ММ-ДД');
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) - KZ_OFFSET_MS;
  if (!Number.isFinite(end) || end <= from) throw new Error('Дата окончания должна быть в будущем');
  return end;
}

/** The HUB id a license names for a HUB that is not connected to the cloud. */
export function standaloneHubId(localClubId: string): string {
  return `club:${localClubId}`;
}
