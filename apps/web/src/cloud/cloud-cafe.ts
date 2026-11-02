/**
 * «Облачная касса» (VITE_CLOUD_HUB=1, apps/cloud-hub): every phone and computer of a café opens the same site;
 * the café's HUB runs in the TS cloud, one per café, addressed by the café code:
 *
 *   <VITE_CLOUD_HUB_URL or this site>/c/<café code>/api/…
 *
 * The code is typed once on «Код кофейни» (or arrives in a link `#/cafe/<code>` from the cabinet or the old trial
 * page) and remembered on this device, with the café's name. Small and free of React: api.ts reads it while its
 * module loads, before anything renders. Other builds never run any of it (CLOUD is false there).
 */
import { formatCafeCode, normalizeCafeCode } from '@bills/domain';

export const CLOUD = import.meta.env.VITE_CLOUD_HUB === '1';
const CAFE_KEY = 'ts.cloud.cafe';
const VENUE_KEY = 'ts.cloud.venue';
const DEVICE_ID_KEY = 'ts.cloud.device';
/** The session of the signed-in person (auth.ts owns it): it belongs to one café, so it goes with the code. */
const AUTH_KEY = 'bills.auth';
/** Where the cloud HUB Worker is; empty — the same site (screens served by the Worker itself). */
const CLOUD_URL = (import.meta.env.VITE_CLOUD_HUB_URL ?? '').trim().replace(/\/+$/, '');

/**
 * How often screens re-read the café by themselves in the cloud. Every change reaches them at once over the
 * WebSocket (cloud-events.ts), and a reconnect re-reads everything; this is only a safety net. Every poll is a
 * billed request that wakes the café's Durable Object, so it is rare.
 */
export const CLOUD_SAFETY_POLL_MS = 10 * 60_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: works until the page is closed.
  }
}

/** A link `#/cafe/K7F3-92QX-M4P8` remembers that café on this device (then the address goes back to the app). */
function fromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /^#\/cafe\/([^/?#]+)/.exec(window.location.hash);
  if (!m) return null;
  try {
    return normalizeCafeCode(decodeURIComponent(m[1]!));
  } catch {
    return null;
  }
}

export function cloudCafeCode(): string | null {
  if (!CLOUD) return null;
  const linked = fromHash();
  if (linked) {
    rememberCafe(linked);
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/login`);
    return linked;
  }
  return normalizeCafeCode(read(CAFE_KEY) ?? '');
}

/** This device now works for `code`; a session of another café is dropped. */
export function rememberCafe(code: string, venue?: string | null): void {
  const before = normalizeCafeCode(read(CAFE_KEY) ?? '');
  if (before !== code) {
    write(AUTH_KEY, null);
    write(VENUE_KEY, null);
  }
  write(CAFE_KEY, code);
  if (venue) write(VENUE_KEY, venue);
}

/** «Сменить кофейню»: forget the code, the café's name and this device's session there; ask again. */
export function forgetCafe(): void {
  write(CAFE_KEY, null);
  write(VENUE_KEY, null);
  write(AUTH_KEY, null);
}

/** The café's name as it was last seen (for the line «Кофейня «Тюльпан» · K7F3-…» before sign-in). */
export function rememberedVenue(): string | null {
  return read(VENUE_KEY);
}

/** The café's HUB as api.ts's HUB_URL: `/c/K7F392QXM4P8` on this site, or on VITE_CLOUD_HUB_URL. */
export function cloudHubUrl(code: string | null = cloudCafeCode()): string {
  return code ? `${CLOUD_URL}/c/${code}` : '';
}

export function shownCafeCode(code: string): string {
  return formatCafeCode(code);
}

/** A link that opens this café on another device (`#/cafe/<code>`). */
export function cafeLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}#/cafe/${formatCafeCode(code)}`;
}

/**
 * This device's own random id, made once: the login throttle counts wrong keys per device and IP, so one phone
 * typing wrong keys never locks out the other devices behind the café's shared internet address.
 */
export function cloudDeviceId(): string {
  let id = read(DEVICE_ID_KEY);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = `d_${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('')}`.slice(0, 26);
    write(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Headers every request to the cloud café carries (none in other builds). */
export function cloudHeaders(): Record<string, string> {
  return CLOUD ? { 'x-ts-device': cloudDeviceId() } : {};
}

export interface CafeHello {
  venue: string | null;
  readOnly: boolean;
  message: string | null;
}

export type CafeCheck = { ok: true; hello: CafeHello } | { ok: false; problem: 'unknown' | 'moving' | 'offline' };

/** Is there such a café, and what is it called? 200 for a café, 404 for an unknown code, 503 while it moves in. */
export async function checkCafe(code: string): Promise<CafeCheck> {
  try {
    const res = await fetch(`${cloudHubUrl(code)}/api/cloud`, { cache: 'no-store', headers: cloudHeaders() });
    if (res.ok) return { ok: true, hello: (await res.json()) as CafeHello };
    if (res.status === 404) return { ok: false, problem: 'unknown' };
    if (res.status === 503) return { ok: false, problem: 'moving' };
    return { ok: false, problem: 'offline' };
  } catch {
    return { ok: false, problem: 'offline' };
  }
}
