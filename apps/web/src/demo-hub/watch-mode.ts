/**
 * «Смотреть с телефона» on the phone (VITE_TRIAL=1): is this page the read-only copy of a cash desk,
 * and what its banner shows. The link is `…/#/watch/<viewer token>` (a hash: never sent to the web
 * server, works behind the service worker); the token is remembered in localStorage so a reload, or the
 * site added to the home screen, opens the copy again until «Перестать смотреть» — but only in a browser
 * without a trial of its own (trial-store.ts TRIAL_HERE_KEY), so a cash desk never reopens as a copy. Small and free of the
 * HUB, so auth.ts, license.tsx and the banner can import it. The copy itself is demo-hub/watch-hub.ts.
 */
import { isWatchToken, watchTokenFromHash } from '@bills/domain';
import { TRIAL, TRIAL_HERE_KEY } from './trial-store.ts';

const LINK_KEY = 'ts.watch.link';
const DEMO_LOCAL = import.meta.env.VITE_DEMO_LOCAL === '1';

let token: string | null | undefined;

/** The remembered link — never in a browser that runs its own trial (a cash desk that once opened the link). */
function stored(): string | null {
  try {
    if (localStorage.getItem(TRIAL_HERE_KEY)) return null;
    const v = localStorage.getItem(LINK_KEY);
    return isWatchToken(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The viewer token of this page, decided once: the address `#/watch/<token>` (then remembered), else the
 * remembered one unless this browser has a trial of its own. null when this page is not a watching copy
 * (always null outside the trial build).
 */
export function watchToken(): string | null {
  if (token !== undefined) return token;
  token = null;
  if (!DEMO_LOCAL || !TRIAL || typeof window === 'undefined') return token;
  const fromHash = watchTokenFromHash(window.location.hash);
  if (fromHash) {
    try {
      localStorage.setItem(LINK_KEY, fromHash);
    } catch {
      // Not remembered: the copy still opens, only a reload without the link will not.
    }
    token = fromHash;
    return token;
  }
  token = stored();
  return token;
}

export function isWatchMode(): boolean {
  return watchToken() !== null;
}

/** «Перестать смотреть»: forget the link and open the site as usual (this phone's own trial, if any). */
export function stopWatching(): void {
  try {
    localStorage.removeItem(LINK_KEY);
  } catch {
    // Nothing remembered.
  }
  token = null;
  window.location.replace(window.location.pathname + window.location.search);
}

// ---------------------------------------------------------------------------
// What the banner shows (set by watch-hub.ts)

/** Why the copy is not shown: the link is off, the cash desk sent nothing yet, no internet, a broken copy. */
export type WatchProblemKind = 'revoked' | 'empty' | 'offline' | 'broken';

export interface WatchView {
  venue: string;
  /** When the cash desk sent the copy on screen. */
  snapshotAt: number | null;
  /** The last check that reached the TS cloud. */
  checkedAt: number | null;
  checking: boolean;
  /** The last check did not reach the TS cloud (no internet): the copy on screen stays. */
  offline: boolean;
  /** The link was switched off at the cash desk: the copy is closed. */
  revoked: boolean;
}

let view: WatchView = { venue: '', snapshotAt: null, checkedAt: null, checking: false, offline: false, revoked: false };
let version = 0;
const listeners = new Set<() => void>();
let refresh: (() => void) | null = null;

export function watchView(): WatchView {
  return view;
}

export function updateWatchView(patch: Partial<WatchView>): void {
  view = { ...view, ...patch };
  version++;
  for (const l of listeners) l();
}

export function subscribeWatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function watchVersion(): number {
  return version;
}

/** watch-hub.ts registers its «check now»; the banner's «Обновить» calls it. */
export function setWatchRefresh(fn: () => void): void {
  refresh = fn;
}

export function refreshWatch(): void {
  refresh?.();
}
