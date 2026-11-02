/**
 * «Облачная касса» on the trial page (apps/web, VITE_TRIAL=1): pure rules of the old browser cash desk, its
 * devices and watching phones after the café moved to the cloud (packages/domain/src/cloud-cafe.ts).
 *
 * - The cash desk learns it from an answer: the terms / report carry `cloud` (a request approved straight into
 *   the cloud: once with the director's key), or a retired token's 410 TRIAL_MOVED carries `error.cloud`.
 * - It keeps what it learned on the trial record (TrialCloudRecord): from then on it never calls the cloud
 *   again (except once to say it kept the key), it is read-only, and the browser café never opens again.
 * - Devices («Подключить устройство») learn it from the cash desk's answers (CLOUD_CODE_HEADER), watching
 *   phones from GET /trial/watch.
 *
 * Also the page's side of the codes for the platform owner (trial-codes.ts: which director's code to report and
 * keep) and of «Купили» (trial-paid.ts: a paid café looks like «Полная версия»).
 */
import type { TrialCloudInfo } from './cloud-cafe.ts';
import { parseTrialCloudInfo } from './cloud-cafe.ts';
import type { TrialReportCodes } from './trial-codes.ts';
import { isDirectorKey, isDirectorSignInKey } from './trial-codes.ts';
import type { TrialPageTerms } from './trial.ts';
import { TRIAL_PAID_ENDED_MESSAGE, trialPageOver } from './trial.ts';

/**
 * What the trial page keeps about its café in the cloud (TrialInfo.cloud, IndexedDB). `origin`: 'move' — this
 * browser was the cash desk and its data moved; 'new' — a request approved straight into the cloud (the browser
 * café was only the welcome form). `managerKey` — the director's key of a new cloud café (shown once, big; then
 * behind «Показать код директора»); `keySeen` — the person pressed «Я записал(а) код»; `keyAcked` — the cloud
 * was told the page kept it (POST /trial/cloud/seen), so it no longer holds the key.
 */
export interface TrialCloudRecord {
  code: string;
  url: string | null;
  at: number;
  origin: 'move' | 'new';
  managerKey?: string;
  keySeen?: boolean;
  keyAcked?: boolean;
}

/** The record for what an answer said: a waiting request becomes a new cloud café, anything else moved there. */
export function trialCloudRecord(cloud: TrialCloudInfo, wasWaiting: boolean, now: number): TrialCloudRecord {
  return {
    code: cloud.code,
    url: cloud.url,
    at: now,
    origin: wasWaiting ? 'new' : 'move',
    ...(cloud.managerKey ? { managerKey: cloud.managerKey } : {}),
  };
}

/** A record read back from storage (or a backup), or null when it is not one. */
export function parseTrialCloudRecord(v: unknown): TrialCloudRecord | null {
  const info = parseTrialCloudInfo(v);
  if (!info) return null;
  const o = v as Record<string, unknown>;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  return {
    code: info.code,
    url: info.url,
    at,
    origin: o.origin === 'new' ? 'new' : 'move',
    ...(info.managerKey ? { managerKey: info.managerKey } : {}),
    ...(o.keySeen === true ? { keySeen: true } : {}),
    ...(o.keyAcked === true ? { keyAcked: true } : {}),
  };
}

/** The cloud should still be told the page kept the director's key (then it forgets it and retires the token). */
export function trialCloudKeyToAck(rec: TrialCloudRecord | null | undefined): boolean {
  return Boolean(rec?.managerKey) && rec?.keyAcked !== true;
}

/**
 * The café in the cloud named by a refused call's body — `{error: {code: 'TRIAL_MOVED', cloud: {code, url}}}` —
 * or null (another error, or the old «moved to another computer» without `cloud`).
 */
export function movedToCloudOf(body: unknown): TrialCloudInfo | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; cloud?: unknown };
  return e.code === 'TRIAL_MOVED' ? parseTrialCloudInfo(e.cloud) : null;
}

/** What stands in front of the cash desk: nothing, the new cloud café («Ваша касса готова»), «Касса переехала» or only its banner. */
export type TrialCloudScreen = 'none' | 'ready' | 'moved' | 'banner';

/**
 * A new cloud café always shows «Ваша касса готова — она в облаке» (there is no browser café behind it: it was
 * only the form). A moved cash desk shows «Касса переехала в облако» until «Посмотреть старые данные» (`dismissed`),
 * then the read-only cash desk with a banner.
 */
export function trialCloudScreen(rec: TrialCloudRecord | null | undefined, dismissed: boolean): TrialCloudScreen {
  if (!rec) return 'none';
  if (rec.origin === 'new') return 'ready';
  return dismissed ? 'banner' : 'moved';
}

/** Headers the cash desk adds to every answer it gives a device once the café is in the cloud. */
export const CLOUD_CODE_HEADER = 'x-ts-cloud';
export const CLOUD_URL_HEADER = 'x-ts-cloud-url';

/** The headers for the café in the cloud (none when there is no café). */
export function cloudHeaders(cloud: Pick<TrialCloudInfo, 'code' | 'url'> | null | undefined): Record<string, string> {
  if (!cloud) return {};
  return { [CLOUD_CODE_HEADER]: cloud.code, ...(cloud.url ? { [CLOUD_URL_HEADER]: cloud.url } : {}) };
}

/** The café in the cloud from an answer's headers (names in any case), or null. */
export function cloudFromHeaders(headers: Readonly<Record<string, string | string[] | undefined>> | null | undefined): TrialCloudInfo | null {
  if (!headers) return null;
  const get = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
    return undefined;
  };
  const code = get(CLOUD_CODE_HEADER);
  if (!code) return null;
  return parseTrialCloudInfo({ code, url: get(CLOUD_URL_HEADER) ?? null });
}


// ---------------------------------------------------------------------------
// The director's code for the platform owner (trial-codes.ts)

/** A director's code the page knows, and whether it signs in the director in this cash desk now. */
export interface DirectorKeyCheck {
  key: string;
  works: boolean;
}

/** Which code the page keeps as the director's («Код директора») and what it reports about it. */
export interface DirectorKeyDecision {
  /** The code to keep as TrialInfo.managerKey (it changes when the known one stopped working and a seen one works). */
  keep: string;
  /** No known code works: the details say «код мог быть изменён в кассе». */
  stale: boolean;
  /** The director part of the report's `codes` (empty: nothing to say — the page never knew a code). */
  report: Pick<TrialReportCodes, 'directorKey' | 'directorKeyStale'>;
}

/**
 * The director's code: the one the page knows (`managerKey`) while it still signs in; else the newest code the page
 * saw issued to the director that works (adopted); else none — stale, when the page knew one. A working code goes to
 * TS whether it is six digits or a long MGR-… key (the director issued one in «Сотрудники»: isDirectorSignInKey).
 */
export function directorKeyDecision(managerKey: DirectorKeyCheck | null, seen: readonly DirectorKeyCheck[]): DirectorKeyDecision {
  const working = managerKey?.works ? managerKey : (seen.find((s) => s.works && s.key !== managerKey?.key) ?? null);
  if (working) {
    return { keep: working.key, stale: false, report: isDirectorSignInKey(working.key) ? { directorKey: working.key } : { directorKeyStale: true } };
  }
  const knew = Boolean(managerKey?.key) || seen.length > 0;
  return { keep: managerKey?.key ?? '', stale: knew, report: knew ? { directorKeyStale: true } : {} };
}

/** What the cloud now knows after a report with `sent` was accepted (the base of the next codesToReport). */
export function mergeReportedCodes(last: TrialReportCodes | null | undefined, sent: TrialReportCodes): TrialReportCodes {
  const out: TrialReportCodes = { ...(last ?? {}), ...sent };
  if (sent.directorKey) delete out.directorKeyStale;
  if (sent.directorKeyStale) delete out.directorKey;
  return out;
}

/** A new director's code from TS in the report's answer (`directorKeyNext`), or null. */
export function directorKeyNextOf(body: unknown): string | null {
  const v = body && typeof body === 'object' ? (body as { directorKeyNext?: unknown }).directorKeyNext : undefined;
  return isDirectorKey(v) ? v : null;
}

/** Keys seen issued to the director, newest first, at most `max`, without repeats. */
export function rememberSeenKey(seen: readonly string[] | undefined, key: string, max = 5): string[] {
  return [key, ...(seen ?? []).filter((k) => k !== key)].slice(0, max);
}

// ---------------------------------------------------------------------------
// «Купили» on the page (trial-paid.ts)

/**
 * The café runs as the full version: permanent, or paid and the paid day has not passed. No countdown, no date,
 * no price — the badge says «Полная версия».
 */
export function trialPageFull(info: TrialPageTerms, now: number): boolean {
  if (info.status === 'permanent') return true;
  return info.status === 'paid' && !trialPageOver(info, now);
}

/**
 * Why a trial that is over is read-only: the cloud's words, else for a paid café whose paid day passed (the page
 * may not have heard from the cloud) TRIAL_PAID_ENDED_MESSAGE; null — the page's own words for a trial.
 */
export function trialOverMessage(info: { status?: TrialPageTerms['status']; message?: string | null; everPaid?: boolean }): string | null {
  const message = info.message?.trim();
  if (message) return message;
  return info.status === 'paid' || info.everPaid ? TRIAL_PAID_ENDED_MESSAGE : null;
}
