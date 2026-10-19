/** Self-hosted backend: the apps/cloud HTTP API (same origin in the browser, bearer token in the phone app). */
import type {
  ApiError,
  ClubDetails,
  CloudKeyLoginRequest,
  CloudLoginResponse,
  CloudSessionView,
  CloudLoginRequest,
  CreateOwnerKeyRequest,
  CreateOwnerKeyResponse,
  DeviceView,
  OwnerKeyView,
  OwnerOverview,
  OwnerView,
  PushRule,
  PushSettingsView,
  TestPushResponse,
  UpdatePushRulesRequest,
  UpdateTariffsRequest,
  UpdateTariffsResponse,
} from '@bills/domain';
import { CloudRequestError, emit } from './api-core.ts';
import { nativeBridge } from './platform.ts';
import type { RegisterDeviceBody } from './api-core.ts';

async function toError(res: Response): Promise<CloudRequestError> {
  try {
    const body = (await res.json()) as ApiError;
    return new CloudRequestError(res.status, body.error.code, body.error.message);
  } catch {
    return new CloudRequestError(res.status, 'HTTP_ERROR', `Облако ответило ошибкой ${res.status}`);
  }
}

/**
 * In the browser the session cookie is HttpOnly and set by the server; the cabinet only has to send it back.
 * Inside the phone app every request goes to the cloud address from the app settings with the bearer token.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const bridge = nativeBridge();
  let url = path;
  let options: RequestInit = { credentials: 'same-origin', cache: 'no-store', ...init };
  if (bridge) {
    const cloud = bridge.cloudUrl();
    if (!cloud) throw new CloudRequestError(0, 'NO_CLOUD', 'Укажите адрес облака');
    url = `${cloud}${path}`;
    const headers = new Headers(init.headers);
    headers.set('x-ts-app', '1');
    const token = bridge.token();
    if (token) headers.set('authorization', `Bearer ${token}`);
    options = { cache: 'no-store', ...init, credentials: 'omit', headers };
  }
  const offlineMessage = bridge ? `Нет связи с облаком по адресу ${bridge.cloudUrl()}` : 'Нет связи с облаком';
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch {
    emit({ type: 'online', online: false });
    throw new CloudRequestError(0, 'OFFLINE', offlineMessage);
  }
  // A reverse proxy (vite dev, nginx) answers for a cloud that is down — that is "offline" too.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    emit({ type: 'online', online: false });
    throw new CloudRequestError(res.status, 'OFFLINE', offlineMessage);
  }
  emit({ type: 'online', online: true });
  if (res.status === 401) {
    const error = await toError(res);
    // The phone's token is dead (expired, signed out elsewhere): forget it, the shell shows the login form.
    if (bridge && bridge.token() && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/key')) {
      await bridge.setToken(null).catch(() => undefined);
    }
    emit({ type: 'unauthorized' });
    throw error;
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The app keeps the session token from the answer; the browser got a cookie instead. */
async function startSession(res: CloudLoginResponse): Promise<OwnerView> {
  const { token, ...owner } = res;
  const bridge = nativeBridge();
  if (bridge && token) await bridge.setToken(token);
  return owner;
}

export async function login(email: string, password: string): Promise<OwnerView> {
  const body: CloudLoginRequest = { email, password };
  return startSession(await request<CloudLoginResponse>('/api/auth/login', json('POST', body)));
}

/** Sign-in by an owner key «OWNER-XXXX-XXXX-XXXX-XXXX» (typed or scanned from the cabinet's QR). */
export async function loginByKey(key: string): Promise<OwnerView> {
  const body: CloudKeyLoginRequest = { key };
  return startSession(await request<CloudLoginResponse>('/api/auth/key', json('POST', body)));
}

/** In the app the phone first leaves the device list (no pushes to a signed-out phone), then the session ends. */
export async function logout(): Promise<void> {
  const bridge = nativeBridge();
  if (!bridge) {
    await request<unknown>('/api/auth/logout', { method: 'POST' });
    return;
  }
  try {
    const deviceId = bridge.deviceId();
    if (deviceId) {
      try {
        await removeDevice(deviceId);
      } catch {
        // Already gone or the cloud is unreachable — signing out must still work.
      }
    }
    if (bridge.token()) await request<unknown>('/api/auth/logout', { method: 'POST' });
  } finally {
    await bridge.setToken(null).catch(() => undefined);
    await bridge.setDeviceId(null).catch(() => undefined);
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

// --- phone: keys, devices, push rules ---------------------------------------

export function fetchOwnerKeys(): Promise<OwnerKeyView[]> {
  return request<OwnerKeyView[]>('/api/owner/keys');
}

export function createOwnerKey(label?: string): Promise<CreateOwnerKeyResponse> {
  const body: CreateOwnerKeyRequest = label ? { label } : {};
  return request<CreateOwnerKeyResponse>('/api/owner/keys', json('POST', body));
}

export async function revokeOwnerKey(id: string): Promise<void> {
  await request<unknown>(`/api/owner/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchPushSettings(): Promise<PushSettingsView> {
  return request<PushSettingsView>('/api/owner/push');
}

export function updatePushRules(rules: PushRule[]): Promise<PushSettingsView> {
  const body: UpdatePushRulesRequest = { rules };
  return request<PushSettingsView>('/api/owner/push/rules', json('PUT', body));
}

/** Idempotent by the FCM token: the same phone keeps its id. */
export function registerDevice(body: RegisterDeviceBody): Promise<DeviceView> {
  return request<DeviceView>('/api/owner/devices', json('POST', body));
}

export async function removeDevice(id: string): Promise<void> {
  await request<unknown>(`/api/owner/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function sendTestPush(): Promise<TestPushResponse> {
  return request<TestPushResponse>('/api/owner/push/test', { method: 'POST' });
}
