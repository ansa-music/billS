/**
 * A tiny in-memory stand-in for Fastify (demo build only: `fastify` is aliased
 * here in vite.config.ts). It implements exactly what apps/hub/src/http uses —
 * routes with :params, onRequest hooks, preHandler, JSON-schema checks with
 * Fastify's defaults (coerce types, strip extra properties), an error handler —
 * and answers through inject(), so the real HUB routes run inside the page.
 */

type Json = unknown;
type Headers = Record<string, string>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

interface RouteOptions {
  schema?: { body?: Schema; querystring?: Schema; params?: Schema };
  preHandler?: AnyFn | AnyFn[];
}

interface Route {
  method: string;
  parts: string[];
  options: RouteOptions;
  handler: AnyFn;
}

export interface InjectOptions {
  method?: string;
  url: string;
  headers?: Headers;
  payload?: string | object;
}

export interface InjectResponse {
  statusCode: number;
  headers: Headers;
  body: string;
  payload: string;
  json<T = unknown>(): T;
}

const log = {
  info: () => {},
  debug: () => {},
  trace: () => {},
  warn: (...a: unknown[]) => console.warn('[demo hub]', ...a),
  error: (...a: unknown[]) => console.error('[demo hub]', ...a),
  fatal: (...a: unknown[]) => console.error('[demo hub]', ...a),
  child: () => log,
};

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ── JSON schema (the keywords the HUB uses), with Fastify's ajv defaults ─────

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matches(type: string, value: unknown): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return typeOf(value) === 'object';
    default:
      return typeOf(value) === type;
  }
}

const NO = Symbol('no coercion');

/** ajv `coerceTypes: 'array'`: query strings become numbers/booleans, scalars become one-item arrays. */
function coerce(type: string, value: unknown): unknown {
  if (Array.isArray(value) && type !== 'array') return value.length === 1 ? coerce(type, value[0]) : NO;
  switch (type) {
    case 'integer':
    case 'number': {
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === null) return 0;
      if (typeof value !== 'string' || value.trim() === '') return NO;
      const n = Number(value);
      if (!Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) return NO;
      return n;
    }
    case 'boolean':
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0 || value === null) return false;
      return NO;
    case 'string':
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value === null) return '';
      return NO;
    case 'null':
      return value === '' || value === 0 || value === false ? null : NO;
    case 'array':
      return [value];
    default:
      return NO;
  }
}

function validate(schema: Schema, input: unknown, path: string): unknown {
  let value = input;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matches(t, value))) {
      let fixed: unknown = NO;
      for (const t of types) {
        fixed = coerce(t, value);
        if (fixed !== NO) break;
      }
      if (fixed === NO) throw invalid(`${path} must be ${types.join(',')}`);
      value = fixed;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) throw invalid(`${path} must be equal to one of the allowed values`);
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) throw invalid(`${path} must NOT have fewer than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) throw invalid(`${path} must NOT have more than ${schema.maxLength} characters`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw invalid(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw invalid(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw invalid(`${path} must NOT have fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw invalid(`${path} must NOT have more than ${schema.maxItems} items`);
    const items = schema.items;
    if (items) value = value.map((v, i) => validate(items, v, `${path}/${i}`));
    if (schema.uniqueItems && new Set((value as unknown[]).map((v) => JSON.stringify(v))).size !== (value as unknown[]).length) {
      throw invalid(`${path} must NOT have duplicate items`);
    }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) throw invalid(`${path} must have required property '${key}'`);
    }
    const props = schema.properties ?? {};
    for (const key of Object.keys(obj)) {
      const prop = props[key];
      if (prop) obj[key] = validate(prop, obj[key], `${path}/${key}`);
      else if (schema.additionalProperties === false) delete obj[key]; // removeAdditional
      else if (typeof schema.additionalProperties === 'object') obj[key] = validate(schema.additionalProperties, obj[key], `${path}/${key}`);
    }
  }
  return value;
}

function invalid(message: string): HttpError {
  return Object.assign(new HttpError(400, 'FST_ERR_VALIDATION', message), { validation: [{ message }] });
}

// ── Request / reply ─────────────────────────────────────────────────────────

class MiniReply {
  statusCode = 200;
  sent = false;
  payload: unknown = undefined;
  readonly #headers: Headers = {};
  readonly raw = {
    writeHead: () => {},
    write: () => true,
    end: () => {},
    on: () => {},
  };

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    return this.status(code);
  }

  header(name: string, value: unknown): this {
    this.#headers[name.toLowerCase()] = String(value);
    return this;
  }

  headers(values: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(values)) this.header(k, v);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.#headers[name.toLowerCase()];
  }

  getHeaders(): Headers {
    return { ...this.#headers };
  }

  removeHeader(name: string): this {
    delete this.#headers[name.toLowerCase()];
    return this;
  }

  type(contentType: string): this {
    return this.header('content-type', contentType);
  }

  send(payload?: unknown): this {
    this.sent = true;
    this.payload = payload;
    return this;
  }

  hijack(): this {
    this.sent = true;
    return this;
  }

  sendFile(): this {
    return this.status(404).send({ message: 'Not Found', error: 'Not Found', statusCode: 404 });
  }
}

// ── The app ─────────────────────────────────────────────────────────────────

export class MiniFastify {
  readonly log = log;
  readonly #routes: Route[] = [];
  readonly #onRequest: AnyFn[] = [];
  #errorHandler: AnyFn | null = null;
  #notFoundHandler: AnyFn | null = null;

  addHook(name: string, fn: AnyFn): this {
    if (name === 'onRequest') this.#onRequest.push(fn);
    return this;
  }

  setErrorHandler(fn: AnyFn): this {
    this.#errorHandler = fn;
    return this;
  }

  setNotFoundHandler(fn: AnyFn): this {
    this.#notFoundHandler = fn;
    return this;
  }

  register(plugin: AnyFn, options?: unknown): this {
    void plugin(this, options ?? {}, () => {});
    return this;
  }

  decorateRequest(): this {
    return this;
  }

  decorate(name: string, value: unknown): this {
    (this as unknown as Record<string, unknown>)[name] = value;
    return this;
  }

  #add(method: string, url: string, a: RouteOptions | AnyFn, b?: AnyFn): this {
    const handler = typeof a === 'function' ? a : b;
    if (!handler) throw new Error(`Route ${method} ${url} has no handler`);
    this.#routes.push({ method, parts: split(url), options: typeof a === 'function' ? {} : a, handler });
    return this;
  }

  get(url: string, a: RouteOptions | AnyFn, b?: AnyFn): this {
    return this.#add('GET', url, a, b);
  }

  post(url: string, a: RouteOptions | AnyFn, b?: AnyFn): this {
    return this.#add('POST', url, a, b);
  }

  put(url: string, a: RouteOptions | AnyFn, b?: AnyFn): this {
    return this.#add('PUT', url, a, b);
  }

  delete(url: string, a: RouteOptions | AnyFn, b?: AnyFn): this {
    return this.#add('DELETE', url, a, b);
  }

  patch(url: string, a: RouteOptions | AnyFn, b?: AnyFn): this {
    return this.#add('PATCH', url, a, b);
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}
  async listen(): Promise<string> {
    return 'in-browser';
  }

  #match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = split(path);
    let best: { route: Route; params: Record<string, string>; score: number } | null = null;
    for (const route of this.#routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let score = 0;
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!;
        const got = parts[i]!;
        if (want.startsWith(':')) {
          params[want.slice(1)] = safeDecode(got);
        } else if (want === got) {
          score++;
        } else {
          ok = false;
          break;
        }
      }
      if (ok && (!best || score > best.score)) best = { route, params, score };
    }
    return best;
  }

  async inject(options: InjectOptions): Promise<InjectResponse> {
    const method = (options.method ?? 'GET').toUpperCase();
    const headers: Headers = {};
    for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const url = options.url;
    const [path = '/', search = ''] = url.split('?', 2);
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(search)) {
      const prev = query[k];
      query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const req: Record<string, unknown> = {
      id: `req-${++requestCounter}`,
      method,
      url,
      headers,
      query,
      params: {},
      body: undefined,
      log,
      raw: { method, url, headers, on: () => {} },
    };
    const reply = new MiniReply();
    try {
      for (const hook of this.#onRequest) {
        await hook(req, reply);
        if (reply.sent) return finish(reply);
      }
      const found = this.#match(method, path);
      if (!found) {
        if (this.#notFoundHandler) await this.#notFoundHandler(req, reply);
        else reply.status(404).send({ message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 });
        return finish(reply);
      }
      const { route, params } = found;
      req.params = params;
      req.routeOptions = { url: route.parts.join('/') };
      // Body: JSON only, like the HUB's clients send.
      const raw = options.payload;
      if (raw !== undefined && raw !== '') {
        if (typeof raw === 'string') {
          try {
            req.body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'FST_ERR_CTP_INVALID_JSON_BODY', "Body is not valid JSON but content-type is set to 'application/json'");
          }
        } else {
          req.body = raw;
        }
      }
      const schema = route.options.schema;
      if (schema?.params) req.params = validate(schema.params, req.params, 'params');
      if (schema?.querystring) req.query = validate(schema.querystring, req.query, 'querystring');
      if (schema?.body && req.body !== undefined) req.body = validate(schema.body, req.body, 'body');
      const pre = route.options.preHandler;
      for (const fn of pre ? (Array.isArray(pre) ? pre : [pre]) : []) {
        await fn(req, reply);
        if (reply.sent) return finish(reply);
      }
      const result = await route.handler(req, reply);
      if (!reply.sent && result !== undefined && result !== reply) reply.send(result);
      if (!reply.sent) throw new Error(`Route ${method} ${path} sent nothing`);
      return finish(reply);
    } catch (err) {
      return this.#fail(err, req, reply);
    }
  }

  async #fail(err: unknown, req: Record<string, unknown>, reply: MiniReply): Promise<InjectResponse> {
    const fresh = new MiniReply();
    for (const [k, v] of Object.entries(reply.getHeaders())) fresh.header(k, v);
    if (this.#errorHandler) {
      try {
        const result = await this.#errorHandler(err, req, fresh);
        if (!fresh.sent && result !== undefined && result !== fresh) fresh.send(result);
        if (fresh.sent) return finish(fresh);
      } catch (inner) {
        console.error('[demo hub] error handler failed', inner);
      }
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return finish(fresh.status(status).send({ statusCode: status, error: 'Error', message: (err as Error).message }));
  }
}

let requestCounter = 0;

function split(url: string): string[] {
  return url.split('?', 1)[0]!.split('/').filter(Boolean);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function finish(reply: MiniReply): InjectResponse {
  const headers = reply.getHeaders();
  const payload = reply.payload as Json;
  let body = '';
  if (payload === undefined || payload === null) {
    body = '';
  } else if (typeof payload === 'string') {
    body = payload;
    headers['content-type'] ??= 'text/plain; charset=utf-8';
  } else if (payload instanceof Uint8Array) {
    body = new TextDecoder().decode(payload);
  } else {
    body = JSON.stringify(payload);
    headers['content-type'] ??= 'application/json; charset=utf-8';
  }
  return {
    statusCode: reply.statusCode,
    headers,
    body,
    payload: body,
    json<T>() {
      return JSON.parse(body) as T;
    },
  };
}

/** `Fastify(options)`: the options (logger, timeouts) mean nothing in the page. */
export default function Fastify(_options?: unknown): MiniFastify {
  return new MiniFastify();
}
