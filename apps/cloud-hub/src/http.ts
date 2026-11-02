/**
 * The Worker's own rules, free of Cloudflare imports so Node tests can run them: which café a URL is for,
 * how big a request may be, and CORS for screens served from another origin.
 */
import { normalizeCafeCode, originAllowed } from '@bills/domain';
import { CloudError } from './errors.ts';

/** HUB commands are small JSON (Fastify's default limit is 1 MiB; nothing the screens send comes close). */
export const API_BODY_MAX = 256 * 1024;
/** A trial snapshot is at most 6 MiB (TRIAL_SNAPSHOT_MAX_BYTES), base64 adds a third, plus the JSON around it. */
export const IMPORT_BODY_MAX = 9 * 1024 * 1024;

export interface CafeRoute {
  /** Normalised café code (12 Crockford characters), the Durable Object's name. */
  code: string;
  /** The HUB path: `/api/state`, `/api/events`, `/metrics`. */
  path: string;
}

/**
 * `/c/<café code>/api/…` → the café and its HUB path. A code may be typed with dashes or in lower case
 * (`k7f3-92qx-m4p8`). Throws 404 for a malformed code (no Durable Object is touched for it) and null for
 * URLs that are not café API calls at all.
 */
export function cafeRoute(pathname: string): CafeRoute | null {
  const m = /^\/c\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  let raw = m[1]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Left as typed: normalizeCafeCode refuses it.
  }
  const code = normalizeCafeCode(raw);
  if (!code) throw new CloudError(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена. Проверьте код кофейни.');
  const path = m[2] ?? '/';
  if (!path.startsWith('/api/') && path !== '/metrics') throw new CloudError(404, 'NOT_FOUND', 'Нет такого адреса');
  return { code, path };
}

/**
 * Reads the body, refusing more than `max` bytes — from Content-Length at once, and while reading for a
 * chunked body that has none. 413 with a Russian message, like the HUB's own errors.
 */
export async function readBody(request: Request, max: number): Promise<ArrayBuffer | null> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return null;
  const tooBig = () => new CloudError(413, 'BODY_TOO_LARGE', `Запрос слишком большой (больше ${Math.round(max / 1024)} КБ).`);
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw tooBig();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export function allowedOrigins(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** CORS headers for an allowed origin (screens on Pages calling the Worker); none for same-origin screens. */
export function corsHeaders(origin: string | null, patterns: readonly string[]): Record<string, string> {
  if (!origin || !originAllowed(origin, patterns)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-actor',
    'access-control-expose-headers': 'x-ts-cost',
    // Chrome caps this at 2 h: one preflight per screen per two hours, answered by the Worker alone.
    'access-control-max-age': '7200',
  };
}

/** Random café code bytes (CAFE_CODE_BYTES = 8). */
export function randomCodeBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8));
}
