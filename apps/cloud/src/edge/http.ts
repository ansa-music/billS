import { CloudError } from '../errors.ts';
import type { Log } from '../push.ts';

/**
 * Runtime-neutral HTTP plumbing for the Edge Functions: a WHATWG `Request` in,
 * a WHATWG `Response` out (both exist in Node and Deno). Answers are shaped
 * exactly like apps/cloud (Fastify): JSON bodies, `{error:{code,message}}` errors.
 */

/** The part of a `Request` the handlers read. */
export interface EdgeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Same body limit as the Fastify app. */
export const BODY_LIMIT = 8 * 1024 * 1024;

export const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Такого адреса нет' } } as const;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function notFound(headers: Record<string, string> = {}): Response {
  return json(404, NOT_FOUND, headers);
}

/**
 * Path inside the function. Supabase hands a function `/<name>/...`; behind some
 * proxies the `/functions/v1` prefix is still there — both are accepted.
 */
export function routeOf(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, 'http://localhost');
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.startsWith('/functions/v1/')) path = path.slice('/functions/v1'.length);
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return { path, query: u.searchParams };
}

export function bearerToken(req: EdgeRequest): string | null {
  const header = req.headers.get('authorization');
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

const badRequest = (message: string, status = 400): CloudError => new CloudError(status, 'BAD_REQUEST', message);

/** Reads a JSON body the way Fastify does: empty or broken JSON is 400, over the limit is 413. */
export async function readJson(req: EdgeRequest): Promise<unknown> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > BODY_LIMIT) throw badRequest('Request body is too large', 413);
  const text = await req.text();
  if (text.length > BODY_LIMIT) throw badRequest('Request body is too large', 413);
  if (text.trim() === '') throw badRequest("Body cannot be empty when content-type is set to 'application/json'");
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw badRequest((e as Error).message);
  }
}

/** A POST body that may be absent (no content): {} then; broken JSON is still 400. */
export async function readOptionalJson(req: EdgeRequest): Promise<unknown> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > BODY_LIMIT) throw badRequest('Request body is too large', 413);
  const text = await req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw badRequest((e as Error).message);
  }
}

/** Error → response, like the Fastify error handler: CloudError as is, anything else 500 + log. */
export function errorResponse(err: unknown, log: Log, headers: Record<string, string> = {}): Response {
  if (err instanceof CloudError) return json(err.status, { error: { code: err.code, message: err.message } }, headers);
  log(`Внутренняя ошибка: ${(err as Error)?.stack ?? String(err)}`);
  return json(500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка облака' } }, headers);
}

// ---------------------------------------------------------------------------
// Body validation: the JSON-schema subset the Fastify routes use, with Fastify's
// default Ajv behaviour (coerceTypes, removeAdditional) and Ajv-like messages.
// ---------------------------------------------------------------------------

export interface Schema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | ReadonlyArray<'string' | 'null'>;
  required?: readonly string[];
  properties?: Readonly<Record<string, Schema>>;
  additionalProperties?: boolean;
  items?: Schema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maxItems?: number;
  enum?: readonly unknown[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function coerce(value: unknown, type: string): unknown {
  switch (type) {
    case 'string':
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value === null) return '';
      return value;
    case 'integer':
    case 'number':
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === null) return 0;
      return value;
    case 'boolean':
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0 || value === null) return false;
      return value;
    default:
      return value;
  }
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** Validates (and coerces / strips like Ajv in Fastify) `value`; throws 400 BAD_REQUEST. */
export function validate<T>(value: unknown, schema: Schema, path = 'body'): T {
  return check(value, schema, path) as T;
}

function check(input: unknown, schema: Schema, path: string): unknown {
  let value = input;
  if (schema.type !== undefined) {
    const types: readonly string[] = typeof schema.type === 'string' ? [schema.type] : schema.type;
    if (!types.some((t) => typeMatches(value, t))) {
      const i = types.findIndex((t) => typeMatches(coerce(value, t), t));
      if (i < 0) throw badRequest(`${path} must be ${types.join(',')}`);
      value = coerce(value, types[i]!);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) throw badRequest(`${path} must be equal to one of the allowed values`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw badRequest(`${path} must NOT have fewer than ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw badRequest(`${path} must NOT have more than ${schema.maxLength} characters`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    throw badRequest(`${path} must be >= ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw badRequest(`${path} must NOT have more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      const items = schema.items;
      value = value.map((item, i) => check(item, items, `${path}/${i}`));
    }
  }
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw badRequest(`${path} must have required property '${key}'`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const prop = schema.properties?.[key];
      if (prop) out[key] = check(v, prop, `${path}/${key}`);
      else if (schema.additionalProperties !== false) out[key] = v;
    }
    value = out;
  }
  return value;
}
