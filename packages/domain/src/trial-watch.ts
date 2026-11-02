/**
 * «Смотреть с телефона»: the director of a trial coffee shop watches the cash desk from a phone.
 * The coffee shop lives only in the cash-desk browser (packages/domain/src/trial.ts); the phone gets
 * the latest SQLite snapshot the cash desk sent to the TS cloud and runs it read-only in the page.
 *
 *   cash desk (trial token)  POST /trial/watch/links   {id} → TrialWatchLink (a viewer token, once)
 *                            GET  /trial/watch/links?id=    → TrialWatchStatus
 *                            POST /trial/watch/revoke  {id} → {revoked}
 *   phone (viewer token)     GET  /trial/watch              → TrialWatchState (cheap: no snapshot)
 *                            GET  /trial/watch/snapshot     → TrialWatchSnapshot
 *
 * A viewer token is random (TRIAL_WATCH.tokenBytes), kept by the cloud only as sha256, belongs to one
 * trial and is gone after «Отключить телефоны». While a phone checked within TRIAL_WATCH.watchingMs,
 * the answer to /trial/report carries `watching: true` and the cash desk reports (and sends a changed
 * snapshot) every minute instead of every 5 / 30 minutes. Pure types and rules for the cloud and the web.
 */
import type { TrialStatus, TrialTerms } from './trial.ts';

/** POST /trial/watch/links: the link's secret, shown once as a QR code. */
export interface TrialWatchLink {
  token: string;
  createdAt: number;
}

/** GET /trial/watch/links: what the cash desk shows next to the QR code. */
export interface TrialWatchStatus {
  /** Links that are still on (opened or not). */
  links: number;
  /** Links a phone has opened at least once. */
  phones: number;
  lastViewedAt: number | null;
  /** A phone looked within TRIAL_WATCH.watchingMs. */
  watching: boolean;
}

/** GET /trial/watch: the phone's cheap check — is there a newer snapshot? */
export interface TrialWatchState {
  venue: string;
  startedAt: number;
  endsAt: number;
  status: TrialStatus;
  /** When the cash desk sent its last snapshot; null before the first one. */
  snapshotAt: number | null;
  snapshotBytes: number | null;
}

/** GET /trial/watch/snapshot: the latest snapshot of this trial, base64 SQLite. */
export interface TrialWatchSnapshot {
  snapshot: string;
  snapshotAt: number;
}

/** The answer to POST /trial/report: the terms, plus `watching` while a phone is looking. */
export interface TrialReportAnswer extends TrialTerms {
  watching?: true;
}

export const TRIAL_WATCH = {
  /** A phone counts as watching this long after its last check. */
  watchingMs: 10 * 60_000,
  /** The phone checks for a newer snapshot this often while it is on screen. */
  checkEveryMs: 60_000,
  /** The cash desk reports this often while watched… */
  reportWatchedMs: 60_000,
  /** …and this often otherwise (as before the phone could watch). */
  reportIdleMs: 5 * 60_000,
  /** A changed snapshot goes up at most this often while watched… */
  snapshotWatchedMs: 60_000,
  /** …and this often otherwise. */
  snapshotIdleMs: 30 * 60_000,
  /** Links one trial may have; a new one beyond it drops the longest unused. */
  maxLinks: 10,
  /** Random bytes of a viewer token: 192 bits, 32 characters of base64url. */
  tokenBytes: 24,
} as const;

/** Rate limits of the watch calls (per hour). */
export const TRIAL_WATCH_RATE = {
  /** New links per trial. */
  linksPerTrialHour: 30,
  /** Cheap checks per viewer token (one a minute is 60). */
  checksPerViewerHour: 240,
  /** Snapshot downloads per viewer token (at most one a minute is 60). */
  snapshotsPerViewerHour: 90,
  /** Calls with an unknown viewer token per IP address, before 429. */
  failuresPerIpHour: 30,
} as const;

export const TRIAL_WATCH_REVOKED_MESSAGE = 'Ссылка для просмотра отключена или неверна. Попросите новую на кассе.';
export const TRIAL_WATCH_READ_ONLY_MESSAGE = 'Это телефон для просмотра: менять можно только на кассе.';

/** The shape of a viewer token (base64url, the length tokenBytes gives, with room for longer ones). */
export function isWatchToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{32,86}$/.test(v);
}

const WATCH_PATH = '/watch/';

/** The hash route a phone opens: `#/watch/<token>`. */
export function watchHash(token: string): string {
  return `#${WATCH_PATH}${token}`;
}

/** The viewer token in a `#/watch/<token>` address (a trailing slash or query is ignored), or null. */
export function watchTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = (raw.split('?', 1)[0] ?? '').replace(/\/+$/, '');
  if (!path.startsWith(WATCH_PATH)) return null;
  const token = path.slice(WATCH_PATH.length);
  return isWatchToken(token) ? token : null;
}

/** A phone that checked at `lastViewedAt` still counts as watching at `now`. */
export function isWatching(lastViewedAt: number | null | undefined, now: number): boolean {
  return typeof lastViewedAt === 'number' && now - lastViewedAt < TRIAL_WATCH.watchingMs;
}

/** How long the cash desk waits between reports. */
export function trialReportEveryMs(watched: boolean): number {
  return watched ? TRIAL_WATCH.reportWatchedMs : TRIAL_WATCH.reportIdleMs;
}

/** Is it time to send a snapshot again (whether it changed is checked separately)? */
export function trialSnapshotDue(now: number, lastSnapshotAt: number | null | undefined, watched: boolean): boolean {
  const every = watched ? TRIAL_WATCH.snapshotWatchedMs : TRIAL_WATCH.snapshotIdleMs;
  return now - (lastSnapshotAt ?? 0) >= every;
}

/** The phone has a copy from `have` and the cloud has one from `cloud`: download it? */
export function watchSnapshotNewer(cloud: number | null | undefined, have: number | null | undefined): boolean {
  return typeof cloud === 'number' && (typeof have !== 'number' || cloud > have);
}

const SIGN_IN_PATHS = new Set(['/api/auth/login', '/api/auth/logout']);

/**
 * What the phone's read-only copy lets through: reading anything, signing in and out. Every other
 * write (a sale, a shift, a setting) is refused before it reaches the in-page HUB.
 */
export function watchRequestAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const clean = (path.split('?', 1)[0] ?? '').replace(/\/+$/, '');
  return m === 'POST' && SIGN_IN_PATHS.has(clean);
}
