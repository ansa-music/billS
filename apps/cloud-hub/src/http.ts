/**
 * The Worker's own rules, free of Cloudflare imports so Node tests can run them: which café a URL is for,
 * how big a request may be, CORS for screens served from another origin, the admin token and who may call
 * /admin at all.
 */
import { normalizeCafeCode, originAllowed } from '@bills/domain';
import { CloudError } from './errors.ts';

/** HUB commands are small JSON (Fastify's default limit is 1 MiB; nothing the screens send comes close). */
export const API_BODY_MAX = 256 * 1024;
/** A trial snapshot is at most 6 MiB (TRIAL_SNAPSHOT_MAX_BYTES), base64 adds a third, plus the JSON around it. */
export const IMPORT_BODY_MAX = 9 * 1024 * 1024;
/** Other admin calls: a venue, a name, terms. */
export const ADMIN_BODY_MAX = 16 * 1024;

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

/**
 * A big body (an import) passed on as a stream, never held whole by the Worker: its declared length is checked
 * now, and the bytes are counted as they flow (more than `max` breaks the stream). Without a Content-Length it is
 * read with `readBody` instead.
 */
export async function streamedBody(request: Request, max: number): Promise<ReadableStream<Uint8Array> | ArrayBuffer | null> {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared) || !request.body) return readBody(request, max);
  if (declared > max) throw new CloudError(413, 'BODY_TOO_LARGE', `Запрос слишком большой (больше ${Math.round(max / 1024)} КБ).`);
  let size = 0;
  return request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > max) controller.error(new CloudError(413, 'BODY_TOO_LARGE', 'Запрос слишком большой.'));
        else controller.enqueue(chunk);
      },
    }),
  );
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
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-actor, x-ts-device',
    'access-control-expose-headers': 'x-ts-cost',
    // Chrome caps this at 2 h: one preflight per screen per two hours, answered by the Worker alone.
    'access-control-max-age': '7200',
  };
}

/** Random café code bytes (CAFE_CODE_BYTES = 8). */
export function randomCodeBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8));
}

/**
 * The admin token, compared in constant time: both sides are hashed first, so neither the length nor the first
 * differing character shows in the timing. No token configured — nobody is admin.
 */
export async function tokenMatches(given: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * A request a browser made: browsers mark every request with Sec-Fetch-* (Chrome, Firefox, Safari 16.4+) and
 * cross-site ones with Origin. /admin/* answers none of them — it is for the TS platform's server only (a
 * Supabase function), so an admin page can never be opened, framed or scripted from a browser.
 */
export function isBrowserRequest(headers: Headers): boolean {
  return headers.has('origin') || headers.has('sec-fetch-site') || headers.has('sec-fetch-dest') || headers.has('sec-fetch-user');
}

/**
 * This device's own random id (`X-TS-Device`, made once and kept by the screens): with the IP it is what the login
 * throttle counts, so wrong keys typed on one phone never lock the other devices behind the café's shared IP.
 */
export function deviceIdOf(headers: Headers): string | null {
  const raw = headers.get('x-ts-device');
  return raw && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
}

/** Where a login attempt comes from, for the HUB's throttle: the IP and, when the screen sent one, its device. */
export function loginSource(ip: string, device: string | null): string {
  return device ? `${ip.slice(0, 45)}#${device.slice(0, 18)}` : ip.slice(0, 64);
}
