import { randomBytes } from 'node:crypto';
import { cafeCodeFromBytes } from '@bills/domain';

export const HUB_URL = 'https://hub.ts.test';
export const HUB_TOKEN = 'hub-admin-token-0123456789';
export const HUB_ENV = { CLOUD_HUB_URL: `${HUB_URL}/`, CLOUD_HUB_ADMIN_TOKEN: HUB_TOKEN };

export interface HubCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export interface FakeCafe {
  origin: 'import' | 'new';
  snapshot?: string;
  input?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  managerKey: string;
}

/** What the next matching call answers instead of the normal answer. */
type Failure = { status: number; body?: unknown } | 'offline';

/**
 * A fake cloud cash desk Worker (the admin API apps/cloud/src/cloud-hub.ts calls): cafés in memory, every call
 * recorded, failures on demand. An import can be held open (`hold()`) to race two moves.
 */
export function fakeHub() {
  const calls: HubCall[] = [];
  const cafes = new Map<string, FakeCafe>();
  const failures: Array<{ match: RegExp; failure: Failure }> = [];
  let held: { promise: Promise<void>; release: () => void } | null = null;
  let keySeq = 0;
  const newKey = () => String(482_913 + ++keySeq * 7_919).slice(0, 6);

  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const path = url.pathname;
    calls.push({ method, path, body, headers });
    const i = failures.findIndex((f) => f.match.test(`${method} ${path}`));
    if (i >= 0) {
      const { failure } = failures.splice(i, 1)[0]!;
      if (failure === 'offline') throw new TypeError('fetch failed');
      return answer(failure.status, failure.body ?? {});
    }
    if (headers.authorization !== `Bearer ${HUB_TOKEN}`) return answer(401, { error: { code: 'UNAUTHORIZED', message: 'Нужен ключ администратора TS' } });
    if (method === 'POST' && path === '/admin/cafes') {
      const code = cafeCodeFromBytes(randomBytes(8));
      const managerKey = newKey();
      cafes.set(code, { origin: 'new', input: body ?? {}, managerKey });
      return answer(201, { code, codeShown: code, venue: body?.venue, managerName: body?.managerName, managerKey });
    }
    if (method === 'POST' && path === '/admin/cafes/import') {
      if (held) await held.promise;
      const code = cafeCodeFromBytes(randomBytes(8));
      cafes.set(code, { origin: 'import', snapshot: String(body?.snapshot ?? ''), managerKey: '' });
      return answer(201, { code, tables: 48, rows: 770 });
    }
    const terms = /^\/admin\/cafes\/([^/]+)\/terms$/.exec(path);
    if (method === 'PUT' && terms) {
      const cafe = cafes.get(decodeURIComponent(terms[1]!));
      if (!cafe) return answer(404, { error: { code: 'CAFE_NOT_FOUND', message: 'Кофейня не найдена' } });
      cafe.terms = body ?? {};
      return answer(200, { ok: true });
    }
    const key = /^\/admin\/cafes\/([^/]+)\/director-key$/.exec(path);
    if (method === 'POST' && key) {
      const cafe = cafes.get(decodeURIComponent(key[1]!));
      if (!cafe) return answer(404, { error: { code: 'CAFE_NOT_FOUND', message: 'Кофейня не найдена' } });
      cafe.managerKey = newKey();
      return answer(200, { managerKey: cafe.managerKey });
    }
    return answer(404, { error: { code: 'NOT_FOUND', message: 'Нет такого адреса' } });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    cafes,
    /** The next call matching `match` ("METHOD /path") answers `failure`. */
    failNext(match: RegExp, failure: Failure) {
      failures.push({ match, failure });
    },
    /** Imports wait until `release()`. */
    hold() {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      held = { promise, release: () => {
        held = null;
        release();
      } };
      return held.release;
    },
    count(method: string, path: RegExp) {
      return calls.filter((c) => c.method === method && path.test(c.path)).length;
    },
  };
}
