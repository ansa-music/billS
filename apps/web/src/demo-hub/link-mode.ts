/**
 * «Подключить устройство» on the device (VITE_TRIAL=1): is this page a phone or tablet working through the
 * cash desk, and what its status line says. The link is `…/#/link/<secret>[/board]` (a hash: never sent to
 * the web server). It is remembered for this tab (a reload keeps working) and, in a browser without a trial
 * of its own, for the browser too — so the site on the home screen opens the device again; a cash-desk browser
 * never turns into a device by itself. Small and free of the HUB: auth.ts, license.tsx and the banner import it.
 * The device itself is demo-hub/link-device.ts.
 */
import type { LinkStatus, LinkView } from '@bills/domain';
import { isLinkSecret, linkFromHash } from '@bills/domain';
import { TRIAL, TRIAL_HERE_KEY } from './trial-store.ts';

const LINK_KEY = 'ts.link.secret';
const VIEW_KEY = 'ts.link.view';
export const LINK_DEVICE_KEY = 'ts.link.device';
/** The device's own sign-in (auth.ts): never the cash desk's or a watching phone's. */
export const LINK_AUTH_KEY = 'bills.link.auth';
const DEMO_LOCAL = import.meta.env.VITE_DEMO_LOCAL === '1';

export interface LinkTarget {
  secret: string;
  view: LinkView;
}

let target: LinkTarget | null | undefined;

function read(storage: Storage, guardTrial: boolean): LinkTarget | null {
  try {
    if (guardTrial && storage.getItem(TRIAL_HERE_KEY)) return null;
    const secret = storage.getItem(LINK_KEY);
    return isLinkSecret(secret) ? { secret, view: storage.getItem(VIEW_KEY) === 'board' ? 'board' : 'staff' } : null;
  } catch {
    return null;
  }
}

function write(storage: Storage, t: LinkTarget): void {
  try {
    storage.setItem(LINK_KEY, t.secret);
    storage.setItem(VIEW_KEY, t.view);
  } catch {
    // Not remembered: works until the page is closed.
  }
}

/**
 * The link of this page, decided once: the address `#/link/…` (then remembered), else this tab's, else the
 * browser's — unless this browser runs its own trial. null outside the trial build or when not linked.
 */
export function linkTarget(): LinkTarget | null {
  if (target !== undefined) return target;
  target = null;
  if (!DEMO_LOCAL || !TRIAL || typeof window === 'undefined') return target;
  const fromHash = linkFromHash(window.location.hash);
  if (fromHash) {
    write(sessionStorage, fromHash);
    let ownTrial = false;
    try {
      ownTrial = Boolean(localStorage.getItem(TRIAL_HERE_KEY));
    } catch {
      ownTrial = false;
    }
    if (!ownTrial) write(localStorage, fromHash);
    target = fromHash;
    return target;
  }
  target = read(sessionStorage, false) ?? read(localStorage, true);
  return target;
}

export function isLinkMode(): boolean {
  return linkTarget() !== null;
}

/** Forget the link on this device (switched off at the cash desk, or «Отключить это устройство»). */
export function clearLinkStorage(): void {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      for (const k of [LINK_KEY, VIEW_KEY, LINK_DEVICE_KEY, LINK_AUTH_KEY]) storage.removeItem(k);
    } catch {
      // Nothing remembered.
    }
  }
}

/** «Отключить это устройство»: forget the link and open the site as usual. */
export function forgetLink(): void {
  clearLinkStorage();
  target = null;
  window.location.replace(window.location.pathname + window.location.search);
}

// ---------------------------------------------------------------------------
// The status line (set by link-device.ts)

export interface LinkViewState {
  status: LinkStatus;
  /** Peer to peer inside the Wi-Fi (else through the TS cloud). */
  direct: boolean;
  /** The device reaches the TS cloud at all (else: no internet here). */
  cloud: boolean;
  /** When the status last changed. */
  since: number;
  /** Something that stops the device for good (no WebCrypto on http://). */
  problem: string | null;
}

let view: LinkViewState = { status: 'connecting', direct: false, cloud: false, since: Date.now(), problem: null };
let version = 0;
const listeners = new Set<() => void>();
let retry: (() => void) | null = null;

export function linkViewState(): LinkViewState {
  return view;
}

export function updateLinkView(patch: Partial<LinkViewState>): void {
  const next = { ...view, ...patch };
  if (next.status !== view.status) next.since = Date.now();
  view = next;
  version++;
  for (const l of listeners) l();
}

export function subscribeLinkView(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function linkViewVersion(): number {
  return version;
}

/** link-device.ts registers its «try now»; the banner's «Повторить» calls it. */
export function setLinkRetry(fn: () => void): void {
  retry = fn;
}

export function retryLink(): void {
  retry?.();
}
