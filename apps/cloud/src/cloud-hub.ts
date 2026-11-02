/**
 * The cloud cash desk's admin API (apps/cloud-hub: a Cloudflare Worker, one Durable Object per café), as the
 * platform function calls it. Everything the platform knows about the Worker is in this one file: its address and
 * token (CLOUD_HUB_URL, CLOUD_HUB_ADMIN_TOKEN — function secrets set by CI), the four calls and how their answers
 * and refusals become CloudErrors people can read. Runtime-neutral (fetch, AbortController).
 *
 *   POST {url}/admin/cafes                {venue, managerName, withMenu?, timezone?} → {code, managerKey}
 *   POST {url}/admin/cafes/import         {snapshot: base64 SQLite}                 → {code, …}
 *   GET  {url}/admin/cafes/<code>                                                    → the café's counters
 *   PUT  {url}/admin/cafes/<code>/terms   CloudCafeTerms                              → anything 2xx
 *   POST {url}/admin/cafes/<code>/director-key  {}                                     → {managerKey}
 *        («Выдать новый код директора»: the director's other keys stop working; proposed to the Worker)
 *
 * importCafe hides how the snapshot travels: today one request; if the Worker takes it in parts
 * (start / continue / finish), only importCafe changes.
 */
import type { CloudCafeTerms } from '@bills/domain';
import { CLOUD_HUB_NOT_CONFIGURED_MESSAGE, normalizeCafeCode } from '@bills/domain';
import { CloudError } from './errors.ts';

export interface CloudHubConfig {
  /** CLOUD_HUB_URL without a trailing slash. */
  url: string;
  /** CLOUD_HUB_ADMIN_TOKEN (Bearer). */
  token: string;
}

/** CLOUD_HUB_URL as a base address (http/https, no trailing slash), or null when missing or not an address. */
export function cloudHubUrlOf(env: Record<string, string | undefined>): string | null {
  const raw = env.CLOUD_HUB_URL?.trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

/** Both secrets, or null: without them the cloud cash desk is «ещё не подключена». */
export function cloudHubConfigOf(env: Record<string, string | undefined>): CloudHubConfig | null {
  const url = cloudHubUrlOf(env);
  const token = env.CLOUD_HUB_ADMIN_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export interface CloudCafeCreate {
  venue: string;
  managerName: string;
  withMenu?: boolean;
  timezone?: string;
}

export interface CloudCafeCreated {
  /** Normalised (12 Crockford characters). */
  code: string;
  /** The director's key, shown once. */
  managerKey: string;
}

export interface CloudCafeImported {
  code: string;
}

export interface CloudHub {
  readonly url: string;
  /** A new empty café (with the sample menu when asked). */
  createCafe(input: CloudCafeCreate): Promise<CloudCafeCreated>;
  /**
   * A trial's café moves in: its SQLite copy (base64, as trials.snapshot holds it). `idempotencyKey` goes along as
   * the Idempotency-Key header: a Worker that honours it never makes a second café for the same copy.
   */
  importCafe(snapshot: string, options?: { idempotencyKey?: string }): Promise<CloudCafeImported>;
  getCafe(code: string): Promise<Record<string, unknown>>;
  putTerms(code: string, terms: CloudCafeTerms): Promise<void>;
  /** «Выдать новый код директора»: the Worker sets a new 6-digit director key (the old ones stop working) and answers it. */
  newDirectorKey(code: string): Promise<{ managerKey: string }>;
}

/** How long one call may take: an import carries up to 8 MB of base64. */
export const CLOUD_HUB_TIMEOUT_MS = 20_000;
export const CLOUD_HUB_IMPORT_TIMEOUT_MS = 90_000;

/** 409: no CLOUD_HUB_URL / CLOUD_HUB_ADMIN_TOKEN in this project. */
export const cloudHubNotConfigured = (): CloudError => new CloudError(409, 'CLOUD_HUB_NOT_CONFIGURED', CLOUD_HUB_NOT_CONFIGURED_MESSAGE);

/**
 * The Worker's refusals and silences: 424 (never 502/503/504 — the cabinet takes those for «no internet» and would
 * hide what the Worker said).
 */
const hubOffline = (): CloudError => new CloudError(424, 'CLOUD_HUB_OFFLINE', 'Облачная касса не отвечает. Попробуйте ещё раз через минуту.');
const hubBadAnswer = (what: string): CloudError => new CloudError(424, 'CLOUD_HUB_BAD_ANSWER', `Облачная касса ответила непонятно (${what}). Попробуйте ещё раз.`);

async function hubRefused(res: Response): Promise<CloudError> {
  let message = '';
  let code = '';
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message.trim().slice(0, 300);
    if (typeof body.error?.code === 'string') code = body.error.code.slice(0, 60);
  } catch {
    // Not JSON: the status says enough.
  }
  if (res.status === 401 || res.status === 403) {
    return new CloudError(424, 'CLOUD_HUB_UNAUTHORIZED', 'Облачная касса не приняла ключ TS (CLOUD_HUB_ADMIN_TOKEN). Проверьте настройки облака.');
  }
  if (res.status === 413) return new CloudError(424, 'CLOUD_HUB_TOO_LARGE', 'Данных кассы слишком много для облачной кассы. Напишите разработчикам TS.');
  const why = message || 'без пояснения';
  return new CloudError(424, 'CLOUD_HUB_ERROR', `Облачная касса ответила ошибкой: ${why} (HTTP ${res.status}${code ? `, ${code}` : ''}).`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The client over `fetchFn` (tests pass a fake Worker). */
export function cloudHub(config: CloudHubConfig, fetchFn: typeof fetch = fetch): CloudHub {
  const call = async (method: string, path: string, body: unknown, options: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CLOUD_HUB_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(`${config.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch {
      throw hubOffline();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw await hubRefused(res);
    const text = await res.text().catch(() => '');
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw hubBadAnswer('не JSON');
    }
  };

  const codeOf = (answer: unknown): string => {
    const code = isObject(answer) ? normalizeCafeCode(answer.code) : null;
    if (!code) throw hubBadAnswer('нет кода кофейни');
    return code;
  };

  const path = (code: string): string => `/admin/cafes/${encodeURIComponent(code)}`;

  return {
    url: config.url,
    async createCafe(input) {
      const answer = await call('POST', '/admin/cafes', {
        venue: input.venue,
        managerName: input.managerName,
        ...(input.withMenu !== undefined ? { withMenu: input.withMenu } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
      });
      const managerKey = isObject(answer) && typeof answer.managerKey === 'string' ? answer.managerKey.trim() : '';
      if (!/^\d{4,12}$/.test(managerKey)) throw hubBadAnswer('нет ключа директора');
      return { code: codeOf(answer), managerKey };
    },
    async importCafe(snapshot, options = {}) {
      const answer = await call('POST', '/admin/cafes/import', { snapshot }, {
        timeoutMs: CLOUD_HUB_IMPORT_TIMEOUT_MS,
        ...(options.idempotencyKey ? { headers: { 'idempotency-key': options.idempotencyKey } } : {}),
      });
      return { code: codeOf(answer) };
    },
    async getCafe(code) {
      const answer = await call('GET', path(code), undefined);
      return isObject(answer) ? answer : {};
    },
    async putTerms(code, terms) {
      await call('PUT', `${path(code)}/terms`, { status: terms.status, endsAt: terms.endsAt, ...(terms.message !== undefined ? { message: terms.message } : {}) });
    },
    async newDirectorKey(code) {
      const answer = await call('POST', `${path(code)}/director-key`, {});
      const managerKey = isObject(answer) && typeof answer.managerKey === 'string' ? answer.managerKey.trim() : '';
      if (!/^\d{4,12}$/.test(managerKey)) throw hubBadAnswer('нет ключа директора');
      return { managerKey };
    },
  };
}
