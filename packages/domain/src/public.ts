import type { Role } from './permissions.ts';

/**
 * Screens served from one domain (Cloudflare Pages https://<project>.pages.dev,
 * GitHub Pages https://<owner>.github.io) may call a HUB on another (a server
 * demo HUB, HUB_CORS_ORIGINS). The HUB then answers CORS for the allowed origins. Requests carry a Bearer token, never cookies, so no
 * credentials are allowed cross-origin and a wildcard such as
 * `https://*.web.app` cannot be used to act as a signed-in user.
 */

/** Static hosting domains of the public sites (Cloudflare Pages, GitHub Pages). */
export const DEFAULT_PUBLIC_ORIGINS = ['https://*.pages.dev', 'https://*.github.io'];

/** "a, b ,c" → ["a", "b", "c"]; empty and missing → []. */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Whether `origin` (scheme://host[:port] from the Origin header) matches one of
 * the patterns: an exact origin, `*` (anyone), or `https://*.pages.dev` — any
 * subdomain, at any depth (previews are `<hash>.<project>.pages.dev`).
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
 * changes — including these keys — comes back by morning. Long keys for the
 * platform and the manager, six-digit keys for staff (they work only in the
 * demo branch). `name` is the demo person the key belongs to.
 */
export const DEMO_KEYS: ReadonlyArray<{ roles: readonly Role[]; label: string; name: string; key: string }> = [
  { roles: ['owner'], label: 'Владелец платформы', name: 'Владелец TS', key: 'OWNER-2222-2222-2222-2222' },
  { roles: ['tech'], label: 'Техподдержка', name: 'Поддержка TS', key: 'TECH-7777-7777-7777-7777' },
  { roles: ['manager'], label: 'Управляющий', name: 'Управляющий', key: 'MGR-3333-3333-3333-3333' },
  { roles: ['senior'], label: 'Старший смены', name: 'Старший смены', key: '260417' },
  { roles: ['cashier'], label: 'Кассир', name: 'Кассир', key: '318540' },
  { roles: ['waiter'], label: 'Официант', name: 'Официант', key: '527193' },
  { roles: ['waiter', 'cashier'], label: 'Официант + кассир', name: 'Официант-кассир', key: '640285' },
];

/** GET /api/demo on a demo HUB (404 on a real club). */
export interface DemoInfo {
  demo: true;
  keys: typeof DEMO_KEYS;
  /** When the demo database is wiped next, epoch ms. */
  resetAt: number;
}
