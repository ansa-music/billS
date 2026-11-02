/**
 * «Облачная касса»: a coffee shop's cash desk in the TS cloud (apps/cloud-hub — a Cloudflare Worker with one
 * Durable Object per café, the same TS screens on any phone or computer at once). The platform cabinet moves a
 * browser trial there («Перевести в облако»: the trial's fresh copy is imported, the browser cash desk stops
 * taking orders) or approves a request straight into it («Подтвердить в облаке»: a new empty café). The café
 * opens at `{CLOUD_HUB_URL}/#/cafe/<code>`; people sign in with their staff keys.
 *
 *   platform (Bearer)  POST /platform/trials/:id/cloud/start → TrialCloudMoveState (asks the cash desk for a fresh copy)
 *                      GET  /platform/trials/:id/cloud       → TrialCloudMoveState (has it come?)
 *                      POST /platform/trials/:id/cloud       {acceptOlder?} → TrialView (imported; the token retired)
 *                      POST /platform/trials/:id/cloud/terms → TrialView (the terms sent to the cloud café again)
 *                      POST /platform/trials/:id/approve-cloud → TrialCloudApproved (a request → a new cloud café)
 *   trial page         terms / report answers carry `cloud` (TrialCloudInfo); a retired token gets 410 TRIAL_MOVED
 *                      with `error.cloud`; POST /trial/cloud/seen {id} — the page kept the director's key
 *   watch phone        GET /trial/watch carries `cloud`
 *
 * The Worker's admin API (apps/cloud/src/cloud-hub.ts) is called only by the platform function, with
 * CLOUD_HUB_URL + CLOUD_HUB_ADMIN_TOKEN; without them everything here is off («Облачная касса ещё не подключена»).
 * Pure types and rules shared by the cloud, the cabinet and the trial page.
 */
import type { TrialTerms } from './trial.ts';

export const CLOUD_HUB_NOT_CONFIGURED_MESSAGE = 'Облачная касса ещё не подключена';

/** What the old browser cash desk, its devices and watching phones are told after the move. */
export const TRIAL_IN_CLOUD_MESSAGE = 'Касса переехала в облако — теперь она работает на любом телефоне и компьютере.';

/** The terms the cloud café keeps: PUT {CLOUD_HUB_URL}/admin/cafes/<code>/terms. */
export interface CloudCafeTerms {
  status: 'active' | 'ended' | 'permanent';
  /** The end (ms); null for a permanent café. */
  endsAt: number | null;
  message?: string | null;
}

/** How the trial got its cloud café: its browser cash desk moved in, or a request approved straight into the cloud. */
export type TrialCloudOrigin = 'move' | 'new';

/** TrialView.cloud: the trial's café in the cloud, as the cabinet shows it. */
export interface TrialCloudView {
  /** The café code the Worker gave (12 Crockford characters; shown as K7F3-92QX-M4P8). */
  code: string;
  /** `{CLOUD_HUB_URL}/#/cafe/<code>`; null while CLOUD_HUB_URL is not set. */
  url: string | null;
  /** When the café was made in the cloud. */
  at: number;
  origin: TrialCloudOrigin;
  /**
   * The last change of the terms did not reach the cloud café (its words): the café may run on other terms than
   * the cabinet shows until «Повторить» succeeds. null when they match.
   */
  termsError: string | null;
  /** When the cloud café last took the terms; null before that. */
  termsSyncedAt: number | null;
}

/** GET /platform/trials adds whether the cloud cash desk is connected (CLOUD_HUB_URL + CLOUD_HUB_ADMIN_TOKEN). */
export interface CloudHubStatus {
  configured: boolean;
  /** CLOUD_HUB_URL without a trailing slash; null when not set. */
  url: string | null;
}

/** The answer of GET /platform/trials. */
export interface TrialsListResponse<T> {
  trials: T[];
  cloudHub: CloudHubStatus;
}

/**
 * «Перевести в облако»: the fresh copy the move waits for (the same «send a fresh copy» mechanism as moving the
 * cash desk to another computer, packages/domain/src/trial-move.ts).
 */
export interface TrialCloudMoveState {
  /** The cash desk was asked for a fresh copy at this time; null when it is off line (not asked). */
  requestedAt: number | null;
  /** The latest copy the cloud has (null: none — nothing to move yet). */
  snapshotAt: number | null;
  /** When the cash desk was last heard from. */
  lastSeenAt: number | null;
  /** The copy is newer than the request. */
  fresh: boolean;
  /** Already in the cloud (a second click, another person): its link. */
  cloud: TrialCloudView | null;
}

/** POST /platform/trials/:id/cloud: `acceptOlder` — move the copy the cloud has even though it is older than the request. */
export interface TrialCloudMoveRequest {
  acceptOlder?: boolean;
}

/** POST /platform/trials/:id/approve-cloud: the trial (now in the cloud) and the director's key — null when it was made earlier. */
export interface TrialCloudApproved<T> {
  trial: T;
  managerKey: string | null;
}

/** What the trial page is told about its café in the cloud. `managerKey` once, for a request approved into the cloud. */
export interface TrialCloudInfo {
  code: string;
  url: string | null;
  managerKey?: string;
}

/** How long the cabinet waits for the cash desk's fresh copy (it signals every 30 s), and how often it looks. */
export const TRIAL_CLOUD_MOVE = {
  waitFreshMs: 75_000,
  pollEveryMs: 3000,
  /** A move or a creation that started this long ago and did not finish no longer blocks another try. */
  busyMs: 5 * 60_000,
  /** The director's key of a request approved into the cloud waits for its page at most this long. */
  keyKeepMs: 7 * 24 * 3_600_000,
} as const;

/** `https://hub.example/#/cafe/K7F392QXM4P8` — the address a café opens at. */
export function cloudCafeUrl(base: string, code: string): string {
  return `${base.trim().replace(/\/+$/, '')}/#/cafe/${encodeURIComponent(code)}`;
}

/**
 * The cloud café's terms for a trial's terms: permanent → no end; ended or expired → ended (with why); active →
 * active until its end. A request never has a cloud café (approving into the cloud makes it active first).
 */
export function cloudTermsOf(terms: Pick<TrialTerms, 'status' | 'endsAt' | 'message'>): CloudCafeTerms {
  switch (terms.status) {
    case 'permanent':
      return { status: 'permanent', endsAt: null, message: null };
    case 'ended':
    case 'expired':
    case 'pending':
    case 'rejected':
      return { status: 'ended', endsAt: terms.endsAt, message: terms.message ?? null };
    default:
      return { status: 'active', endsAt: terms.endsAt, message: null };
  }
}

/** A `cloud` field of the cloud's answer as the page reads it, or null. */
export function parseTrialCloudInfo(v: unknown): TrialCloudInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== 'string' || !/^[0-9A-Za-z-]{4,40}$/.test(o.code)) return null;
  const url = typeof o.url === 'string' && /^https?:\/\//.test(o.url) ? o.url : null;
  const key = typeof o.managerKey === 'string' && /^\d{4,12}$/.test(o.managerKey) ? o.managerKey : null;
  return { code: o.code, url, ...(key ? { managerKey: key } : {}) };
}
