/**
 * The café's codes for the platform owner: «Код кофейни» and the director's sign-in code, so TS can help a client
 * sign in and fix things for them. Only the platform owner sees them (behind «Показать»); they live in service-only
 * columns (RLS on, no grants) and never appear in URLs or logs.
 *
 *   cash desk (trial token)  POST /trial/report {…, codes?: TrialReportCodes} — only when a code changed
 *                            → … + directorKeyNext? (a new director key from TS: install it now)
 *   platform owner           GET  /platform/trials/:id/codes        → TrialCodesView
 *                            POST /platform/trials/:id/director-key → TrialDirectorKeyIssued («Выдать новый код директора»)
 *
 * The browser trial knows the director's code it made at the start (TrialInfo.managerKey); the director may change
 * it in the cash desk since. The page then sends the code that works now when it can tell (the key it saw issued),
 * else says the one it knew stopped working (`directorKeyStale`): the cabinet shows «код мог быть изменён в кассе».
 * A new key from TS reaches a browser cash desk with the answer to its next report and replaces every other key of
 * the director there; a cloud café gets it at once through the Worker (POST /admin/cafes/<code>/director-key).
 * Pure types and rules shared by the cloud, the cabinet and the trial page.
 */
import { isAccessKeyShape, isWeakShortKey, normalizeAccessKey, SHORT_KEY_LENGTH } from './auth.ts';
import { normalizeCafeCode } from './trial-move.ts';

/** What the cash desk reports about its codes; sent only when something changed since the last accepted report. */
export interface TrialReportCodes {
  /** The café code in clear (normalised, 12 characters); the cloud keeps it only when it matches its hash. */
  cafeCode?: string;
  /**
   * The director's code that works in this cash desk now: 6 digits (the trial's own and TS's), or a long MGR-… key
   * (a director — role manager — who issues a key in «Сотрудники» gets a long one).
   */
  directorKey?: string;
  /** The director's code the page knew stopped working (changed in the cash desk) and it does not know the new one. */
  directorKeyStale?: true;
  /** TS's new key (directorKeyNext) could not be installed here (another person of the café has it): TS sends another. */
  directorKeyRefused?: string;
}

/** The report's body field. */
export interface TrialReportCodeFields {
  codes?: TrialReportCodes;
}

/** What the report's answer may add: a new director key from TS, to install now (it replaces the director's keys). */
export interface TrialReportCodeAnswer {
  directorKeyNext?: string;
}

/** GET /platform/trials/:id/codes — the platform owner only. */
export interface TrialCodesView {
  /**
   * The café code: of the browser trial (it moves the cash desk to another computer) or, once in the cloud, of the
   * cloud café (the address its devices open). null: the cash desk has not sent it yet.
   */
  cafeCode: string | null;
  cafeCodeKind: 'trial' | 'cloud';
  /** The director's sign-in code as TS last learned it; null: not known (not reported yet, or it stopped working). */
  directorKey: string | null;
  /** When TS learned it. */
  directorKeyAt: number | null;
  /** The code may have been changed in the cash desk since (the page said its code stopped working; a cloud café). */
  directorKeyStale: boolean;
  /** A new code from TS that waits for the browser cash desk to pick it up (its next report). */
  directorKeyPending: string | null;
  /** The browser cash desk could not install the last new code (another person has it): issue another. */
  directorKeyRefused: boolean;
}

/** POST /platform/trials/:id/director-key: the new code (shown once), and where it works. */
export interface TrialDirectorKeyIssued<T> {
  managerKey: string;
  /** 'cloud' — works now in the cloud café; 'next-report' — the browser cash desk installs it when it next reports. */
  applied: 'cloud' | 'next-report';
  trial: T;
}

/** A director's code as TS keeps and issues it: 6 digits, not a weak one (000000, 123456…). */
export function isDirectorKey(v: unknown): v is string {
  return typeof v === 'string' && v.length === SHORT_KEY_LENGTH && /^\d+$/.test(v) && !isWeakShortKey(v);
}

/** A director's sign-in code the cash desk may report: a director's 6 digits or a long key (MGR-…), canonical. */
export function isDirectorSignInKey(v: unknown): v is string {
  return isDirectorKey(v) || (typeof v === 'string' && v.length <= 64 && isAccessKeyShape(v) && normalizeAccessKey(v) === v);
}

/** A new director code from random bytes (≥ 24 for several tries); null when every try was weak. */
export function directorKeyFrom(bytes: ArrayLike<number>): string | null {
  for (let start = 0; start + SHORT_KEY_LENGTH * 2 <= bytes.length; start += SHORT_KEY_LENGTH * 2) {
    let s = '';
    for (let i = 0; i < SHORT_KEY_LENGTH; i++) s += String(((bytes[start + 2 * i]! << 8) | bytes[start + 2 * i + 1]!) % 10);
    if (isDirectorKey(s)) return s;
  }
  return null;
}

/** The codes part of a report as the cloud reads it: wrong shapes are dropped; null when nothing is left. */
export function parseReportCodes(v: unknown): TrialReportCodes | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: TrialReportCodes = {};
  const cafe = normalizeCafeCode(o.cafeCode);
  if (cafe) out.cafeCode = cafe;
  if (isDirectorSignInKey(o.directorKey)) out.directorKey = o.directorKey;
  else if (o.directorKeyStale === true) out.directorKeyStale = true;
  if (isDirectorKey(o.directorKeyRefused)) out.directorKeyRefused = o.directorKeyRefused;
  return Object.keys(out).length ? out : null;
}

/** What the page has to report now: the fields that differ from what it last reported; null when nothing does. */
export function codesToReport(now: TrialReportCodes, reported: TrialReportCodes | null | undefined): TrialReportCodes | null {
  const last = reported ?? {};
  const out: TrialReportCodes = {};
  if (now.cafeCode && now.cafeCode !== last.cafeCode) out.cafeCode = now.cafeCode;
  if (now.directorKey && now.directorKey !== last.directorKey) out.directorKey = now.directorKey;
  if (!now.directorKey && now.directorKeyStale && !(last.directorKeyStale && !last.directorKey)) out.directorKeyStale = true;
  if (now.directorKeyRefused && now.directorKeyRefused !== last.directorKeyRefused) out.directorKeyRefused = now.directorKeyRefused;
  return Object.keys(out).length ? out : null;
}
