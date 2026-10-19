import type {
  ApiError,
  HallLayout,
  HallLayoutView,
  HubState,
  JournalCategory,
  JournalPage,
  LampDetail,
  LoginRequest,
  LoginResponse,
  ManualModeView,
  SessionView,
  TlsStatus,
} from '@bills/domain';

export class HubRequestError extends Error {
  readonly code: string;
  readonly status: number;
  /** 429 LOGIN_LOCKED: how long to wait before the next try, ms. */
  readonly retryAfterMs: number | null;

  constructor(status: number, code: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Russian text for error codes the screens care about. The HUB already answers
 * in Russian; these are used when its message is missing or not in Russian.
 */
export const ERROR_TEXT: Record<string, string> = {
  KEY_INVALID: 'Ключ не подходит. Проверьте цифры или попросите новый ключ у управляющего.',
  KEY_WEAK: 'Слишком простой ключ (одинаковые цифры или подряд). Выберите другие 6 цифр.',
  KEY_TAKEN: 'Такой ключ уже есть у кого-то в этом филиале. Выберите другие 6 цифр.',
  LICENSE_STAFF_LIMIT: 'Лимит сотрудников по лицензии исчерпан. Уволенные не считаются; чтобы добавить ещё, расширьте лицензию.',
  LICENSE_READ_ONLY: 'Лицензия не активна — режим «только чтение». Продлите доступ.',
  LICENSE_MODULE_OFF: 'Этот модуль не входит в лицензию клуба.',
  LICENSE_INVALID: 'Лицензия не подходит: подпись не сходится или она выдана для другого HUB.',
  LOGIN_LOCKED: 'Слишком много попыток входа. Подождите и попробуйте снова.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
};

function errorText(code: string, message: string | undefined): string {
  if (message && /[а-яё]/i.test(message)) return message;
  return ERROR_TEXT[code] ?? message ?? `Ошибка HUB: ${code}`;
}

/**
 * Where the HUB is. Empty (the usual case): the screen is served by the HUB itself or by
 * Vite with a proxy, and requests go to the same origin. The public demo on Firebase Hosting
 * is built with VITE_HUB_URL=https://<demo-hub>.onrender.com and calls it cross-origin (CORS).
 */
export const HUB_URL = (import.meta.env.VITE_HUB_URL ?? '').trim().replace(/\/+$/, '');

/** `/api/...` → absolute URL on the HUB when it lives on another origin. */
export function hubUrl(path: string): string {
  return HUB_URL + path;
}

/** Fired on window when the HUB answers 401 to a request made with the current token. */
export const UNAUTHORIZED_EVENT = 'bills:unauthorized';

/**
 * Session token, kept in memory by auth.ts (which owns localStorage). Every
 * request below sends it as a Bearer header, the hall screen included.
 */
let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

function withAuth(headers: Record<string, string>, token: string | null): Record<string, string> {
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * A 401 means the session is gone (expired, revoked, never existed). Tell the
 * app so it shows the login page — but only if the token that failed is still
 * the current one, so a late reply cannot sign out a session opened meanwhile.
 */
function notifyUnauthorized(sentWith: string | null): void {
  if (sentWith !== authToken) return;
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

/** crypto.randomUUID needs a secure context; tablets reach the HUB over plain http on the LAN. */
function newKey(): string {
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function toError(res: Response): Promise<HubRequestError> {
  try {
    const body = (await res.json()) as ApiError & { error: { retryAfterMs?: unknown } };
    const header = Number(res.headers.get('retry-after'));
    const retry =
      typeof body.error.retryAfterMs === 'number'
        ? body.error.retryAfterMs
        : Number.isFinite(header) && header > 0
          ? header * 1000
          : null;
    return new HubRequestError(res.status, body.error.code, errorText(body.error.code, body.error.message), retry);
  } catch {
    return new HubRequestError(res.status, 'HTTP_ERROR', `HUB ответил ошибкой ${res.status}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a JSON resource from the HUB. */
export async function fetchJson<T>(path: string): Promise<T> {
  const token = authToken;
  let res: Response;
  try {
    res = await fetch(hubUrl(path), { cache: 'no-store', headers: withAuth({}, token) });
  } catch {
    throw new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  }
  if (res.status === 401) notifyUnauthorized(token);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Typed GET for reports and lists (the cash desk's name for fetchJson). */
export const getJson = fetchJson;

export async function fetchState(): Promise<HubState> {
  return fetchJson<HubState>('/api/state');
}

/**
 * Sends a command. On a lost connection or a server error it retries with the
 * same idempotency key, so a command that did reach the HUB is not repeated.
 *
 * The session token names the actor on the HUB; `actor` is sent as X-Actor
 * only for logs and the test server (the HUB ignores it otherwise).
 */
export async function command<T>(path: string, actor: string, body: object = {}, method = 'POST'): Promise<T> {
  const key = newKey();
  const token = authToken;
  let lastError: Error = new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    let res: Response;
    try {
      res = await fetch(hubUrl(path), {
        method,
        headers: withAuth(
          {
            'content-type': 'application/json',
            'idempotency-key': key,
            'x-actor': encodeURIComponent(actor.trim() || 'unknown'),
          },
          token,
        ),
        body: JSON.stringify(body),
      });
    } catch {
      lastError = new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
      continue;
    }
    if (res.status >= 500) {
      lastError = await toError(res);
      continue;
    }
    if (res.status === 401) notifyUnauthorized(token);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }
  throw lastError;
}

/**
 * Signs in with an access key. No token is sent and a 401 here does not fire
 * UNAUTHORIZED_EVENT: it just means the key is wrong.
 */
export async function loginWithKey(body: LoginRequest): Promise<LoginResponse> {
  let res: Response;
  try {
    res = await fetch(hubUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': newKey() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as LoginResponse;
}

// ── Hall and equipment commands ─────────────────────────────────────────────

/** Flashes the lamp of a table: checks that the relay is wired to the right table. */
export function blinkTable(tableId: string, actor: string, times = 3): Promise<{ commandId: string }> {
  return command(`/api/tables/${tableId}/blink`, actor, { times });
}

export function setPowerSettings(
  actor: string,
  patch: { autoPauseOnPowerLoss?: boolean },
): Promise<{ autoPauseOnPowerLoss: boolean }> {
  return command('/api/power/settings', actor, patch);
}

export function setManualMode(actor: string, enabled: boolean, reason?: string): Promise<ManualModeView> {
  return command('/api/lamps/manual', actor, reason === undefined ? { enabled } : { enabled, reason });
}

// Hall screens: all GETs go through fetchJson, so they carry the Bearer token too.
export const fetchHall = () => fetchJson<HallLayoutView>('/api/hall');

export const saveHall = (layout: HallLayout, actor: string) =>
  command<HallLayoutView>('/api/hall', actor, layout, 'PUT');

export function fetchJournal(q: { before?: number; limit?: number; category?: JournalCategory; tableId?: string }) {
  const params = new URLSearchParams();
  if (q.before !== undefined) params.set('before', String(q.before));
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.category) params.set('category', q.category);
  if (q.tableId) params.set('tableId', q.tableId);
  return fetchJson<JournalPage>(`/api/journal?${params}`);
}

export const fetchSessions = (from: number, to: number) =>
  fetchJson<SessionView[]>(`/api/sessions?from=${Math.floor(from)}&to=${Math.ceil(to)}`);

export const fetchLamps = () => fetchJson<LampDetail[]>('/api/lamps');
export const fetchTls = () => fetchJson<TlsStatus>('/api/tls');

// ── Development simulators (/api/dev/*): public routes, absent with real hardware ──

export interface SimulatorStatus {
  latencyMs: number;
  offline: boolean;
  faults: Array<'fail' | 'drop-ack'>;
  /** Channel → relay is on. */
  lamps: Record<string, boolean>;
  /** Channel → the lamp was asked to blink steadily (paused game). */
  blink: Record<string, boolean>;
  /** Current-sensor overrides: true — light on by hand, false — dead bulb. */
  lights: Record<string, boolean>;
  /** Channel → BLINK commands accepted. */
  blinks: Record<string, number>;
}

export interface SimulatorPatch {
  latencyMs?: number;
  offline?: boolean;
  faults?: Array<'fail' | 'drop-ack'>;
  clearFaults?: boolean;
  light?: { channel: string; on: boolean | null };
  /** Poll the sensors right now instead of waiting for the next tick. */
  poll?: boolean;
}

/**
 * The simulated UPS (HUB_UPS=simulator). GET /api/dev/ups answers 200 either way:
 * `{ configured: false }` without a simulated UPS (the state fields are then absent),
 * `{ configured: true, ...state }` with one. Older HUBs omit `configured`.
 */
export interface UpsSimulatorStatus {
  configured?: boolean;
  onBattery: boolean;
  chargePercent: number;
  runtimeSeconds: number;
  unreachable: boolean;
}

export interface UpsSimulatorPatch extends Partial<Omit<UpsSimulatorStatus, 'configured'>> {
  /** false — do not re-read the UPS right away. */
  poll?: boolean;
}

async function devGet<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(hubUrl(path), { cache: 'no-store', headers: withAuth({}, authToken) });
  } catch {
    throw new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

async function devPost<T>(path: string, patch: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(hubUrl(path), {
      method: 'POST',
      headers: withAuth({ 'content-type': 'application/json' }, authToken),
      body: JSON.stringify(patch),
    });
  } catch {
    throw new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Null when the HUB runs a real controller (no simulator route). */
export const fetchSimulator = () => devGet<SimulatorStatus>('/api/dev/lamps');
export const updateSimulator = (patch: SimulatorPatch) => devPost<SimulatorStatus>('/api/dev/lamps', patch);

/** `configured: false` (or null from an older HUB's 404) when the HUB has no simulated UPS. */
export const fetchUpsSimulator = () => devGet<UpsSimulatorStatus>('/api/dev/ups');
export const updateUpsSimulator = (patch: UpsSimulatorPatch) => devPost<UpsSimulatorStatus>('/api/dev/ups', patch);
