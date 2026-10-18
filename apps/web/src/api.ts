import type { ApiError, HubState, LoginRequest, LoginResponse } from '@bills/domain';

export class HubRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
    const body = (await res.json()) as ApiError;
    return new HubRequestError(res.status, body.error.code, body.error.message);
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
    res = await fetch(path, { cache: 'no-store', headers: withAuth({}, token) });
  } catch {
    throw new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  }
  if (res.status === 401) notifyUnauthorized(token);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export async function fetchState(): Promise<HubState> {
  return fetchJson<HubState>('/api/state');
}

/**
 * Sends a command. On a lost connection or a server error it retries with the
 * same idempotency key, so a command that did reach the HUB is not repeated.
 */
export async function command<T>(path: string, actor: string, body: object = {}): Promise<T> {
  const key = newKey();
  const token = authToken;
  let lastError: Error = new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
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
    res = await fetch('/api/auth/login', {
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

export interface SimulatorStatus {
  latencyMs: number;
  offline: boolean;
  faults: Array<'fail' | 'drop-ack'>;
  lamps: Record<string, boolean>;
}

export async function fetchSimulator(): Promise<SimulatorStatus | null> {
  const res = await fetch('/api/dev/lamps', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as SimulatorStatus;
}

export async function updateSimulator(patch: {
  latencyMs?: number;
  offline?: boolean;
  faults?: Array<'fail' | 'drop-ack'>;
  clearFaults?: boolean;
}): Promise<SimulatorStatus> {
  const res = await fetch('/api/dev/lamps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as SimulatorStatus;
}
