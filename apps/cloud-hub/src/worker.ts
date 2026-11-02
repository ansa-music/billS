/**
 * The cloud cash desk Worker («облачная касса», Worker `ts-kassa`): one site for every café.
 *
 *   /c/<café code>/api/…        → that café's Durable Object (CafeHub): the HUB's own API, keys and sessions
 *   /c/<café code>/api/events   → WebSocket upgrade (live updates, hibernating)
 *   /c/<café code>/api/cloud    → the café's name and whether it takes orders (the «Код кофейни» screen)
 *   /c/<café code>/api/cloud/backup[/file] → «Скачать копию» for the director (Bearer of a manager)
 *   /admin/…                    → TS's admin API (below), Bearer ADMIN_TOKEN, never for browsers
 *   everything else             → the TS screens (static assets, free and unlimited on Cloudflare)
 *
 * ── Admin API (Authorization: Bearer <ADMIN_TOKEN>; JSON; errors are {error: {code, message}}) ──────────────
 *
 *   POST /admin/cafes
 *        {venue, managerName, withMenu?, timezone?, terms?}
 *        → 201 {code, codeShown, status: 'ready', venue, managerName, managerKey (6 digits), steps, terms, license}
 *          The schema comes from the build in a few steps (importer.ts startTemplate), driven by this call; should
 *          it answer 202 {code, status: 'importing'}, `…/import/continue` finishes it and hands out managerKey once.
 *
 *   POST /admin/cafes/import
 *        {snapshot (base64 of the trial's SQLite file, as Supabase trials.snapshot), newManagerKey?, managerName?, terms?}
 *        → 201 {code, codeShown, status: 'ready', venue, managerName, rows, steps, fromMigration, terms, license, managerKey?}
 *        → 202 {code, codeShown, status: 'importing', phase, done (0…1), rows, totalRows, bytes, steps}
 *          A big café moves in steps (importer.ts): the call drives up to IMPORT_STEPS_PER_CALL of them; the rest
 *          go on by themselves (the café's alarm). Ask `GET /admin/cafes/<code>` or drive it faster with
 *          `POST /admin/cafes/<code>/import/continue` (same answers). The code is final from the first answer;
 *          until `ready` the café's screens say «Кофейня переезжает в облако».
 *        → 4xx {error} — not a TS café (SNAPSHOT_INVALID), from a newer TS (SNAPSHOT_NEWER), bad terms (TERMS_INVALID)
 *        Lighter on CPU: the SQLite file itself as `Content-Type: application/octet-stream`, the other fields as JSON
 *        in the `X-TS-Import` header (`{"newManagerKey":true,"terms":{…}}`) — no base64 to decode, a quarter smaller.
 *
 *   POST /admin/cafes/<code>/import/continue → as above (201 ready / 202 importing / 422 IMPORT_FAILED)
 *        Both take `?steps=N` (how many steps this call drives, default and max IMPORT_STEPS_PER_CALL).
 *
 *   GET  /admin/cafes/<code>
 *        → {provisioned, status: 'ready'|'importing'|'failed', code, origin, venue, createdAt, terms?, license?,
 *           import?, export?, databaseBytes, sockets, bootCost, sinceBoot, nextWakeAt, newestMigration}
 *
 *   PUT  /admin/cafes/<code>/terms
 *        {status: 'active'|'ended'|'permanent', endsAt: number|null, message?: string|null}
 *        → 200 {code, terms: {status, endsAt, message, setAt}, license: {state, readOnly, message, validUntil, daysLeft}}
 *          active needs endsAt (read-only by itself from then on); ended is read-only at once with `message`;
 *          permanent has no end. Every open screen of the café shows the change at once.
 *
 *   POST /admin/cafes/<code>/director-key   {}
 *        → 200 {code, codeShown, managerKey, managerName} — a new six-digit key for the director; the director's
 *          other keys and their sessions are revoked (the cabinet's «Выдать новый код директора»)
 *
 *   GET  /admin/cafes/<code>/export
 *        → 200 the backup file (the browser trial's «Восстановить из копии» opens it; content-disposition names it)
 *        → 202 {status: 'preparing', done, rows, totalRows} — a big café is copied in steps: call again
 *
 *   Create and import honour `Idempotency-Key` (the platform sends `ts-trial-<id>-<snapshotAt>`): a retry gets the
 *   café the first call made (its status, or the ready answer), never a second café. Keys are kept 30 days
 *   (registry.ts).
 *
 *   `terms` in create and import is optional; without it a café works NEW_CAFE_DAYS (14) days from now.
 *   Compared with the prototype the shapes only grew: import answers carry `status` (and may be 202).
 */
import { cafeCodeFromBytes, formatCafeCode, normalizeCafeCode } from '@bills/domain';
import type { ProvisionRequest } from './cafe-hub.ts';
import type { Env } from './env.ts';
import type { ClaimResponse } from './registry.ts';
import { CloudError, errorResponse, toErrorResponse } from './errors.ts';
import {
  ADMIN_BODY_MAX,
  allowedOrigins,
  API_BODY_MAX,
  cafeRoute,
  corsHeaders,
  deviceIdOf,
  IMPORT_BODY_MAX,
  isBrowserRequest,
  randomCodeBytes,
  readBody,
  streamedBody,
  tokenMatches,
} from './http.ts';

export { CafeHub } from './cafe-hub.ts';
export { AdminRegistry } from './registry.ts';

/** Steps of a move one admin call drives before it answers 202 (the café's alarm goes on with the rest). */
const IMPORT_STEPS_PER_CALL = 24;
/** Steps of a copy one admin call drives before it answers 202. */
const EXPORT_STEPS_PER_CALL = 24;

const ADMIN_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' };

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
  // Only the Worker says who is asking: the IP from Cloudflare, the device id checked here.
  headers.delete('x-ts-ip');
  headers.delete('x-ts-device');
  headers.set('x-ts-ip', request.headers.get('cf-connecting-ip') ?? 'local');
  const device = deviceIdOf(request.headers);
  if (device) headers.set('x-ts-device', device);
  return stub.fetch(`https://cafe${path}${search}`, { method: request.method, headers, ...(body ? { body } : {}) });
}

async function jsonBody<T>(request: Request, max: number): Promise<T> {
  const raw = await readBody(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(raw ?? new ArrayBuffer(0))) as T;
  } catch {
    throw new CloudError(400, 'BAD_JSON', 'Тело запроса — не JSON');
  }
}

function codeOf(raw: string): string {
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // As typed: normalizeCafeCode refuses it.
  }
  const code = normalizeCafeCode(text);
  if (!code) throw new CloudError(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена');
  return code;
}

/** Adds the printable code (K7F3-92QX-M4P8) to an answer about a café. */
async function withCode(res: Response, code: string): Promise<Response> {
  if (!res.ok) return res;
  const body = (await res.json()) as Record<string, unknown>;
  return Response.json({ ...body, code, codeShown: formatCafeCode(code) }, { status: res.status });
}

/** Drives a move until it is ready, failed or the step budget of this call is spent. */
async function driveImport(stub: DurableObjectStub, code: string, first: Record<string, unknown>, steps: number): Promise<Response> {
  let last = first;
  for (let i = 0; i < steps && last.status === 'importing'; i++) {
    const res = await stub.fetch('https://cafe/_ts/import/step', { method: 'POST' });
    if (!res.ok) return res;
    last = (await res.json()) as Record<string, unknown>;
  }
  const status = last.status === 'ready' ? 201 : last.status === 'failed' ? 422 : 202;
  if (status === 422) {
    return Response.json({ error: { code: 'IMPORT_FAILED', message: `Переезд не удался: ${String(last.error ?? 'неизвестная ошибка')}` }, ...last, code }, { status });
  }
  return Response.json({ ...last, code, codeShown: formatCafeCode(code) }, { status });
}

/** `?steps=N` (0…IMPORT_STEPS_PER_CALL): how many steps this call drives — 1 to time each step (scripts/e2e.mjs). */
function stepsOf(url: URL, max: number): number {
  const n = Number(url.searchParams.get('steps') ?? max);
  return Number.isInteger(n) ? Math.min(max, Math.max(0, n)) : max;
}

/**
 * The café code for a create or import call: a new random one, or — with an `Idempotency-Key` the registry has
 * seen — the one the earlier call made.
 */
async function claimCode(env: Env, request: Request, kind: 'create' | 'import'): Promise<ClaimResponse> {
  const code = cafeCodeFromBytes(randomCodeBytes());
  const key = request.headers.get('idempotency-key')?.trim();
  if (!key) return { code, fresh: true };
  if (key.length > 200) throw new CloudError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key длиннее 200 знаков');
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('admin'));
  const res = await registry.fetch('https://registry/claim', { method: 'POST', body: JSON.stringify({ key: `${kind}:${key}`, code }) });
  if (!res.ok) throw new CloudError(500, 'REGISTRY', 'Реестр кофеен не ответил');
  return (await res.json()) as ClaimResponse;
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  // For the TS platform's server only: a browser never gets an admin answer, not even a 401.
  if (isBrowserRequest(request.headers) || request.method === 'OPTIONS') throw new CloudError(403, 'ADMIN_NOT_FOR_BROWSERS', 'Нет доступа');
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
  if (!(await tokenMatches(token, env.ADMIN_TOKEN))) throw new CloudError(401, 'UNAUTHORIZED', 'Нужен ключ администратора TS');
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if ((path === '/admin/cafes' || path === '/admin/cafes/import') && method === 'POST') {
    const importing = path === '/admin/cafes/import';
    // A retry of a call that already made a café (Idempotency-Key) gets that café back, never a second one.
    const claim = await claimCode(env, request, importing ? 'import' : 'create');
    const code = claim.code;
    const stub = cafe(env, code);
    if (!claim.fresh) {
      const stats = (await (await stub.fetch('https://cafe/_ts/stats')).json()) as { status: string | null; import?: { error?: string } };
      if (stats.status !== null) {
        await request.body?.cancel().catch(() => {});
        if (stats.status === 'failed') {
          return Response.json({ error: { code: 'IMPORT_FAILED', message: `Переезд не удался: ${stats.import?.error ?? 'неизвестная ошибка'}` }, code }, { status: 422 });
        }
        return driveImport(stub, code, { status: 'importing' }, IMPORT_STEPS_PER_CALL);
      }
      // The first call never reached the café (lost on the way): start it now under the same code.
    }
    if (!importing) {
      const input = await jsonBody<Omit<ProvisionRequest, 'code'>>(request, ADMIN_BODY_MAX);
      const res = await stub.fetch('https://cafe/_ts/provision', { method: 'POST', body: JSON.stringify({ ...input, code }) });
      if (!res.ok) return res;
      // The schema is created in a few steps (a new café is a move from the build's template): driven here.
      return driveImport(stub, code, (await res.json()) as Record<string, unknown>, IMPORT_STEPS_PER_CALL);
    }
    // The body flows to the café as it came (no copy, no parse of megabytes here); only its size is checked.
    const body = await streamedBody(request, IMPORT_BODY_MAX);
    if (!body) throw new CloudError(400, 'SNAPSHOT_MISSING', 'Нет копии кофейни: поле snapshot (base64 файла SQLite).');
    const headers: Record<string, string> = { 'x-ts-code': code, 'content-type': request.headers.get('content-type') ?? 'application/json' };
    const options = request.headers.get('x-ts-import');
    if (options) headers['x-ts-import'] = options.slice(0, ADMIN_BODY_MAX);
    const res = await stub.fetch('https://cafe/_ts/import/upload', { method: 'POST', body, headers });
    if (!res.ok) return res;
    return driveImport(stub, code, (await res.json()) as Record<string, unknown>, stepsOf(url, IMPORT_STEPS_PER_CALL));
  }
  const m = /^\/admin\/cafes\/([^/]+)(\/terms|\/export|\/import\/continue|\/director-key)?$/.exec(path);
  if (m) {
    const code = codeOf(m[1]!);
    const stub = cafe(env, code);
    const sub = m[2] ?? '';
    if (sub === '' && method === 'GET') {
      const res = await stub.fetch('https://cafe/_ts/stats');
      const stats = (await res.json()) as { status: string | null };
      if (stats.status === null) throw new CloudError(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена');
      return Response.json({ ...stats, code, codeShown: formatCafeCode(code) });
    }
    if (sub === '/terms' && method === 'PUT') {
      const input = await jsonBody<unknown>(request, ADMIN_BODY_MAX);
      return withCode(await stub.fetch('https://cafe/_ts/terms', { method: 'PUT', body: JSON.stringify(input) }), code);
    }
    if (sub === '/director-key' && method === 'POST') {
      return withCode(await stub.fetch('https://cafe/_ts/director-key', { method: 'POST' }), code);
    }
    if (sub === '/import/continue' && method === 'POST') return driveImport(stub, code, { status: 'importing' }, Math.max(1, stepsOf(url, IMPORT_STEPS_PER_CALL)));
    if (sub === '/export' && method === 'GET') {
      let last: Record<string, unknown> = { status: 'preparing' };
      for (let i = 0; i < EXPORT_STEPS_PER_CALL && last.status !== 'ready'; i++) {
        const res = await stub.fetch('https://cafe/_ts/export/step', { method: 'POST' });
        if (!res.ok) return res;
        last = (await res.json()) as Record<string, unknown>;
      }
      if (last.status !== 'ready') return Response.json({ ...last, code }, { status: 202, headers: { 'retry-after': '2' } });
      return stub.fetch('https://cafe/_ts/export/file');
    }
  }
  throw new CloudError(404, 'NOT_FOUND', 'Нет такого адреса');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      try {
        return withHeaders(await admin(request, env, url), ADMIN_HEADERS);
      } catch (err) {
        return withHeaders(toErrorResponse(err), ADMIN_HEADERS);
      }
    }
    const cors = corsHeaders(request.headers.get('origin'), allowedOrigins(env.ALLOWED_ORIGINS));
    try {
      const route = cafeRoute(url.pathname);
      if (route) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        return withHeaders(await toCafe(request, env, route.code, route.path, url.search), cors);
      }
      if (url.pathname.startsWith('/c/')) return errorResponse(404, 'NOT_FOUND', 'Нет такого адреса');
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('TS', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      return withHeaders(toErrorResponse(err), cors);
    }
  },
} satisfies ExportedHandler<Env>;
