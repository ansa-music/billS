/**
 * «Облачная касса» (VITE_CLOUD_HUB=1, prototype — apps/cloud-hub): every phone and computer of a café opens
 * the same site; the café's HUB runs in the TS cloud, one per café, addressed by the café code:
 *
 *   <VITE_CLOUD_HUB_URL or this site>/c/<café code>/api/…
 *
 * The code is typed once on «Код кофейни» (or arrives in a link `#/cafe/<code>`) and remembered on this
 * device. Small and free of React: api.ts reads it while its module loads, before anything renders.
 */
import { formatCafeCode, normalizeCafeCode } from '@bills/domain';

export const CLOUD = import.meta.env.VITE_CLOUD_HUB === '1';
const CAFE_KEY = 'ts.cloud.cafe';
/** Where the cloud HUB Worker is; empty — the same site (screens served by the Worker itself). */
const CLOUD_URL = (import.meta.env.VITE_CLOUD_HUB_URL ?? '').trim().replace(/\/+$/, '');

/** A link `#/cafe/K7F3-92QX-M4P8` remembers that café on this device (then the address goes back to the app). */
function fromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /^#\/cafe\/([^/?#]+)/.exec(window.location.hash);
  return m ? normalizeCafeCode(decodeURIComponent(m[1]!)) : null;
}

export function cloudCafeCode(): string | null {
  if (!CLOUD) return null;
  const linked = fromHash();
  if (linked) {
    rememberCafe(linked);
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/login`);
    return linked;
  }
  try {
    return normalizeCafeCode(localStorage.getItem(CAFE_KEY) ?? '');
  } catch {
    return null;
  }
}

export function rememberCafe(code: string): void {
  try {
    localStorage.setItem(CAFE_KEY, code);
  } catch {
    // Private mode: works until the page is closed.
  }
}

/** «Другая кофейня»: forget the code (and this device's session there) and ask again. */
export function forgetCafe(): void {
  try {
    localStorage.removeItem(CAFE_KEY);
  } catch {
    // Nothing remembered.
  }
}

/** The café's HUB as api.ts's HUB_URL: `/c/K7F392QXM4P8` on this site, or on VITE_CLOUD_HUB_URL. */
export function cloudHubUrl(code: string | null = cloudCafeCode()): string {
  return code ? `${CLOUD_URL}/c/${code}` : '';
}

export function shownCafeCode(code: string): string {
  return formatCafeCode(code);
}

/** Is there such a café? The public roster answers 200 for a provisioned one, 404 CAFE_NOT_FOUND otherwise. */
export async function checkCafe(code: string): Promise<'ok' | 'unknown' | 'offline'> {
  try {
    const res = await fetch(`${cloudHubUrl(code)}/api/auth/roster`, { cache: 'no-store' });
    if (res.ok) return 'ok';
    return res.status === 404 ? 'unknown' : 'offline';
  } catch {
    return 'offline';
  }
}
