import type {
  ApiError,
  ClubDetails,
  CloudSessionView,
  LoginRequest,
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
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
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
  if (res.status === 401) {
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
  const body: LoginRequest = { email, password };
  return request<OwnerView>('/api/auth/login', json('POST', body));
}

export async function logout(): Promise<void> {
  await request<unknown>('/api/auth/logout', { method: 'POST' });
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
