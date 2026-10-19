import type { Role } from './permissions.ts';

/**
 * Public deployment: the screens are served from one domain (Firebase Hosting,
 * https://<project>.web.app) and call the HUB or the cloud on another
 * (Render, https://<service>.onrender.com). Both servers then answer CORS for
 * the allowed origins. Requests carry a Bearer token, never cookies, so no
 * credentials are allowed cross-origin and a wildcard such as
 * `https://*.web.app` cannot be used to act as a signed-in user.
 */

/** Firebase Hosting domains: the cloud allows them unless CLOUD_CORS_ORIGINS says otherwise. */
export const DEFAULT_PUBLIC_ORIGINS = ['https://*.web.app', 'https://*.firebaseapp.com'];

/** "a, b ,c" → ["a", "b", "c"]; empty and missing → []. */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Whether `origin` (scheme://host[:port] from the Origin header) matches one of
 * the patterns: an exact origin, `*` (anyone), or `https://*.web.app` — any
 * subdomain, at any depth (preview channels are `project--pr12-abc.web.app`).
 */
export function originAllowed(origin: string | undefined, patterns: readonly string[]): origin is string {
  if (!origin) return false;
  for (const p of patterns) {
    if (p === '*' || p === origin) return true;
    const star = p.indexOf('://*.');
    if (star < 0) continue;
    const scheme = p.slice(0, star + 3);
    const suffix = p.slice(star + 4); // ".web.app"
    if (origin.startsWith(scheme) && origin.endsWith(suffix) && origin.length > scheme.length + suffix.length) {
      const host = origin.slice(scheme.length, origin.length - suffix.length);
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)) return true;
    }
  }
  return false;
}

/**
 * Public demo club (HUB_DEMO=1): fixed, deliberately simple keys shown on the
 * login screen. The demo database is wiped every night, so anything a visitor
 * changes — including these keys — comes back by morning.
 */
export const DEMO_KEYS: ReadonlyArray<{ role: Role; label: string; key: string }> = [
  { role: 'owner', label: 'Владелец', key: 'OWNER-2222-2222-2222-2222' },
  { role: 'manager', label: 'Управляющий', key: 'MGR-3333-3333-3333-3333' },
  { role: 'cashier', label: 'Кассир', key: 'CASH-4444-4444-4444-4444' },
  { role: 'waiter', label: 'Официант', key: 'WTR-5555-5555-5555-5555' },
];

/** GET /api/demo on a demo HUB (404 on a real club). */
export interface DemoInfo {
  demo: true;
  keys: typeof DEMO_KEYS;
  /** When the demo database is wiped next, epoch ms. */
  resetAt: number;
}
