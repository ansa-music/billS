import type {
  ApiError,
  ClubDetails,
  CloudSessionView,
  CloudLoginRequest,
  OwnerOverview,
  OwnerView,
  UpdateTariffsRequest,
  UpdateTariffsResponse,
} from '@bills/domain';

export class CloudRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Where the cloud API is. Empty: the same origin (Vite proxy in development, nginx in a club
 * or on a KZ server). The public cabinet on Firebase Hosting is built with
 * VITE_CLOUD_URL=https://<service>.onrender.com and calls it cross-origin.
 */
export const CLOUD_URL = (import.meta.env.VITE_CLOUD_URL ?? '').trim().replace(/\/+$/, '');

/**
 * Cross-origin the session cookie would be a third-party cookie (blocked by Safari), so the
 * cabinet keeps the token from the login reply (X-Owner-Token) and sends it as Bearer.
 */
const TOKEN_KEY = 'ts.cloud.token';

function readToken(): string | null {
  if (!CLOUD_URL) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the session lasts until the tab is closed.
  }
}

let memoryToken: string | null = readToken();

/** Connectivity and auth signals from every request, so the shell can show a banner or the login form. */
export type ApiSignal = { type: 'online'; online: boolean } | { type: 'unauthorized' };

const listeners = new Set<(signal: ApiSignal) => void>();

export function subscribeApi(listener: (signal: ApiSignal) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(signal: ApiSignal): void {
  for (const l of listeners) l(signal);
}

async function toError(res: Response): Promise<CloudRequestError> {
  try {
    const body = (await res.json()) as ApiError;
    return new CloudRequestError(res.status, body.error.code, body.error.message);
  } catch {
    return new CloudRequestError(res.status, 'HTTP_ERROR', `Облако ответило ошибкой ${res.status}`);
  }
}

/** The session cookie is HttpOnly and set by the server; the cabinet only has to send it back. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    const headers = new Headers(init.headers);
    if (CLOUD_URL && memoryToken) headers.set('authorization', `Bearer ${memoryToken}`);
    res = await fetch(CLOUD_URL + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers });
  } catch {
    emit({ type: 'online', online: false });
    throw new CloudRequestError(0, 'OFFLINE', 'Нет связи с облаком');
  }
  // A reverse proxy (vite dev, nginx) answers for a cloud that is down — that is "offline" too.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    emit({ type: 'online', online: false });
    throw new CloudRequestError(res.status, 'OFFLINE', 'Нет связи с облаком');
  }
  emit({ type: 'online', online: true });
  if (CLOUD_URL) {
    const issued = res.headers.get('x-owner-token');
    if (issued) writeToken(issued);
  }
  if (res.status === 401) {
    if (CLOUD_URL && path !== '/api/auth/login') writeToken(null);
    emit({ type: 'unauthorized' });
    throw await toError(res);
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function login(email: string, password: string): Promise<OwnerView> {
  const body: CloudLoginRequest = { email, password };
  return request<OwnerView>('/api/auth/login', json('POST', body));
}

export async function logout(): Promise<void> {
  try {
    await request<unknown>('/api/auth/logout', { method: 'POST' });
  } finally {
    writeToken(null);
  }
}

export function fetchMe(): Promise<OwnerView> {
  return request<OwnerView>('/api/auth/me');
}

export function fetchOverview(): Promise<OwnerOverview> {
  return request<OwnerOverview>('/api/owner/overview');
}

export function fetchClub(id: string): Promise<ClubDetails> {
  return request<ClubDetails>(`/api/owner/clubs/${encodeURIComponent(id)}`);
}

/** `day` is a local calendar date of the club, YYYY-MM-DD. */
export function fetchSessions(id: string, day: string): Promise<CloudSessionView[]> {
  return request<CloudSessionView[]>(
    `/api/owner/clubs/${encodeURIComponent(id)}/sessions?day=${encodeURIComponent(day)}`,
  );
}

export function updateTariffs(id: string, body: UpdateTariffsRequest): Promise<UpdateTariffsResponse> {
  return request<UpdateTariffsResponse>(`/api/owner/clubs/${encodeURIComponent(id)}/tariffs`, json('PUT', body));
}
