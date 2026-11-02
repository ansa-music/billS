/**
 * The cloud HUB Worker (prototype): one site for every café.
 *
 *   /c/<café code>/api/…        → that café's Durable Object (CafeHub): the HUB's own API, keys and sessions
 *   /c/<café code>/api/events   → WebSocket upgrade (live updates, hibernating)
 *   POST /admin/cafes           → a new empty café   {venue, managerName, withMenu?, timezone?} → {code, managerKey}
 *   POST /admin/cafes/import    → a trial café moves in {snapshot (base64), newManagerKey?} → {code, rows…}
 *   GET  /admin/cafes/<code>    → size and cost counters of one café
 *   everything else             → the TS screens (static assets, free and unlimited on Cloudflare)
 *
 * The Worker answers CORS preflights and size checks itself, so they never wake a café's object.
 */
import { cafeCodeFromBytes, formatCafeCode, normalizeCafeCode } from '@bills/domain';
import type { ImportRequest, ProvisionRequest } from './cafe-hub.ts';
import type { Env } from './env.ts';
import { CloudError, toErrorResponse } from './errors.ts';
import { allowedOrigins, API_BODY_MAX, cafeRoute, corsHeaders, IMPORT_BODY_MAX, randomCodeBytes, readBody } from './http.ts';

export { CafeHub } from './cafe-hub.ts';

function withHeaders(res: Response, extra: Record<string, string>): Response {
  if (!Object.keys(extra).length || res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

function cafe(env: Env, code: string): DurableObjectStub {
  return env.CAFE.get(env.CAFE.idFromName(code));
}

async function toCafe(request: Request, env: Env, code: string, path: string, search: string): Promise<Response> {
  const stub = cafe(env, code);
  if (path === '/api/events') {
    // The upgrade goes through as it is (the Durable Object accepts the socket).
    return stub.fetch(new Request(`https://cafe${path}`, request));
  }
  const body = await readBody(request, API_BODY_MAX);
  const headers = new Headers(request.headers);
  headers.delete('x-ts-ip');
  headers.set('x-ts-ip', request.headers.get('cf-connecting-ip') ?? 'local');
  return stub.fetch(`https://cafe${path}${search}`, { method: request.method, headers, ...(body ? { body } : {}) });
}

function checkAdmin(request: Request, env: Env): void {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!env.ADMIN_TOKEN || !token || token !== env.ADMIN_TOKEN) throw new CloudError(401, 'UNAUTHORIZED', 'Нужен ключ администратора TS');
}

async function jsonBody<T>(request: Request, max: number): Promise<T> {
  const raw = await readBody(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(raw ?? new ArrayBuffer(0))) as T;
  } catch {
    throw new CloudError(400, 'BAD_JSON', 'Тело запроса — не JSON');
  }
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  checkAdmin(request, env);
  const path = url.pathname;
  if (path === '/admin/cafes' && request.method === 'POST') {
    const input = await jsonBody<Omit<ProvisionRequest, 'code'>>(request, API_BODY_MAX);
    const code = cafeCodeFromBytes(randomCodeBytes());
    const res = await cafe(env, code).fetch('https://cafe/_ts/provision', { method: 'POST', body: JSON.stringify({ ...input, code }) });
    return withCode(res, code);
  }
  if (path === '/admin/cafes/import' && request.method === 'POST') {
    const input = await jsonBody<Omit<ImportRequest, 'code'>>(request, IMPORT_BODY_MAX);
    const code = cafeCodeFromBytes(randomCodeBytes());
    const res = await cafe(env, code).fetch('https://cafe/_ts/import', { method: 'POST', body: JSON.stringify({ ...input, code }) });
    return withCode(res, code);
  }
  const m = /^\/admin\/cafes\/([^/]+)$/.exec(path);
  if (m && request.method === 'GET') {
    const code = normalizeCafeCode(decodeURIComponent(m[1]!));
    if (!code) throw new CloudError(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена');
    return cafe(env, code).fetch('https://cafe/_ts/stats');
  }
  throw new CloudError(404, 'NOT_FOUND', 'Нет такого адреса');
}

/** Adds the printable code (K7F3-92QX-M4P8) to a provisioning answer. */
async function withCode(res: Response, code: string): Promise<Response> {
  if (!res.ok) return res;
  const body = (await res.json()) as Record<string, unknown>;
  return Response.json({ ...body, code, codeShown: formatCafeCode(code) }, { status: res.status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), allowedOrigins(env.ALLOWED_ORIGINS));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname.startsWith('/admin/')) return withHeaders(await admin(request, env, url), cors);
      const route = cafeRoute(url.pathname);
      if (route) return withHeaders(await toCafe(request, env, route.code, route.path, url.search), cors);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('TS', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      return withHeaders(toErrorResponse(err), cors);
    }
  },
} satisfies ExportedHandler<Env>;
