/**
 * Supabase backend: Auth (password, magic link), PostgREST RPC for reports and push settings,
 * the `owner` Edge Function for writes that need server-side validation, Realtime for new alerts.
 * Loaded only in a Supabase build (see api.ts), so the self-hosted bundle has no supabase-js.
 */
import { createClient } from '@supabase/supabase-js';
import type { RealtimeChannel, Session, SupabaseClient } from '@supabase/supabase-js';
import type {
  ApiError,
  ClubDetails,
  CloudSessionView,
  CreateOwnerKeyResponse,
  DeviceView,
  OwnerKeyView,
  OwnerOverview,
  OwnerView,
  PushRule,
  PushSettingsView,
  TestPushResponse,
  UpdateTariffsRequest,
  UpdateTariffsResponse,
} from '@bills/domain';
import { CloudRequestError, emit } from './api-core.ts';
import type { RegisterDeviceBody } from './api-core.ts';
import { supabaseAnonKey, supabaseUrl } from './config.ts';
import { forgetLocalDevices, localDeviceIds } from './localDevices.ts';
import { nativeBridge } from './platform.ts';
import {
  OFFLINE_MESSAGE,
  authErrorFromHash,
  describeAuthError,
  edgeUrl,
  magicLinkRedirect,
  mapRpcError,
} from './supabase-util.ts';
import type { MappedError } from './supabase-util.ts';

let client: SupabaseClient | null = null;
let linkError: string | null = null;

function sb(): SupabaseClient {
  if (client) return client;
  // A failed magic link comes back as `#error=…`: keep the text for the login form and give the
  // hash router a clean route before supabase-js looks at the URL.
  linkError = authErrorFromHash(location.hash);
  if (linkError) history.replaceState(history.state, '', `${location.pathname}${location.search}#/`);
  client = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Implicit flow: the link works even when the mail app opens it in another browser.
      detectSessionInUrl: true,
      flowType: 'implicit',
      storageKey: 'ts.supabase.auth',
    },
  });
  client.auth.onAuthStateChange((event) => {
    // The refresh token died (signed out elsewhere, expired): back to the login form.
    if (event === 'SIGNED_OUT') {
      stopRealtime();
      emit({ type: 'unauthorized' });
    }
  });
  return client;
}

function fail(m: MappedError): never {
  if (m.offline) emit({ type: 'online', online: false });
  else emit({ type: 'online', online: true });
  if (m.unauthorized) emit({ type: 'unauthorized' });
  throw new CloudRequestError(m.status, m.code, m.message);
}

function offline(): never {
  return fail({ status: 0, code: 'OFFLINE', message: OFFLINE_MESSAGE, offline: true, unauthorized: false });
}

function unauthorized(code = 'UNAUTHORIZED', message = 'Нужно войти'): never {
  return fail({ status: 401, code, message, offline: false, unauthorized: true });
}

/** The stored session (refreshed by supabase-js when needed); 401 without one, OFFLINE when the refresh cannot reach Auth. */
async function session(): Promise<Session> {
  let res: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>;
  try {
    res = await sb().auth.getSession();
  } catch {
    return offline();
  }
  if (res.error) {
    const m = describeAuthError(res.error);
    if (m.offline) return offline();
  }
  if (!res.data.session) return unauthorized();
  return res.data.session;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  await session();
  let res: { data: unknown; error: { message: string; code?: string } | null; status: number };
  try {
    res = await sb().rpc(fn, args);
  } catch {
    return offline();
  }
  if (res.error) return fail(mapRpcError(res.error, res.status));
  emit({ type: 'online', online: true });
  return res.data as T;
}

/** The `owner` Edge Function: `${SUPABASE_URL}/functions/v1/owner/owner/...` with the user's JWT. */
async function edge<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = await session();
  const headers: Record<string, string> = {
    authorization: `Bearer ${s.access_token}`,
    apikey: supabaseAnonKey(),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(edgeUrl(supabaseUrl(), path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return offline();
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return offline();
  if (res.status === 401) return unauthorized();
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = `Облако ответило ошибкой ${res.status}`;
    try {
      const data = (await res.json()) as Partial<ApiError> & { message?: string; msg?: string; code?: string };
      if (data.error && typeof data.error === 'object') {
        code = data.error.code ?? code;
        message = data.error.message ?? message;
      } else {
        code = typeof data.code === 'string' ? data.code : code;
        message = data.message ?? data.msg ?? message;
      }
    } catch {
      // not JSON — keep the generic text
    }
    emit({ type: 'online', online: true });
    throw new CloudRequestError(res.status, code, message);
  }
  emit({ type: 'online', online: true });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// --- auth -------------------------------------------------------------------

export async function login(email: string, password: string): Promise<OwnerView> {
  let res: Awaited<ReturnType<SupabaseClient['auth']['signInWithPassword']>>;
  try {
    res = await sb().auth.signInWithPassword({ email, password });
  } catch {
    return offline();
  }
  if (res.error) {
    const m = describeAuthError(res.error);
    emit({ type: 'online', online: !m.offline });
    throw new CloudRequestError(m.status, m.code, m.message);
  }
  emit({ type: 'online', online: true });
  return fetchMe();
}

/** Sends a one-time sign-in link; it brings the owner back to this very page (base path kept). */
export async function sendMagicLink(email: string): Promise<void> {
  let res: Awaited<ReturnType<SupabaseClient['auth']['signInWithOtp']>>;
  try {
    res = await sb().auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: magicLinkRedirect(import.meta.env.BASE_URL, location.href),
        // Owners are created by the platform; the link never makes a new account.
        shouldCreateUser: false,
      },
    });
  } catch {
    return offline();
  }
  if (res.error) {
    const m = describeAuthError(res.error);
    emit({ type: 'online', online: !m.offline });
    throw new CloudRequestError(m.status, m.code, m.message);
  }
  emit({ type: 'online', online: true });
}

/** The error of a failed magic link this page was opened with (shown once on the login form). */
export function takeLinkError(): string | null {
  sb();
  const e = linkError;
  linkError = null;
  return e;
}

export async function loginByKey(_key: string): Promise<OwnerView> {
  throw new CloudRequestError(400, 'NOT_SUPPORTED', 'Вход по ключу владельца в этой версии не используется: войдите по почте');
}

/** This browser/phone leaves the device list first (no pushes to a signed-out device), then the session ends here only. */
export async function logout(): Promise<void> {
  stopRealtime();
  const bridge = nativeBridge();
  const ids = new Set(localDeviceIds());
  const nativeId = bridge?.deviceId();
  if (nativeId) ids.add(nativeId);
  for (const id of ids) {
    try {
      await removeDevice(id);
    } catch {
      // Already gone or offline — signing out must still work.
    }
  }
  forgetLocalDevices();
  if (bridge) await bridge.setDeviceId(null).catch(() => undefined);
  await sb()
    .auth.signOut({ scope: 'local' })
    .catch(() => undefined);
}

export async function fetchMe(): Promise<OwnerView> {
  const me = await rpc<OwnerView | null>('owner_me');
  if (!me) {
    // A Supabase user whose e-mail matches no owner: nothing to show.
    await sb()
      .auth.signOut({ scope: 'local' })
      .catch(() => undefined);
    throw new CloudRequestError(401, 'NOT_OWNER', 'Эта почта не привязана к владельцу клуба');
  }
  return me;
}

// --- reports ----------------------------------------------------------------

export function fetchOverview(): Promise<OwnerOverview> {
  return rpc<OwnerOverview>('owner_overview');
}

export function fetchClub(id: string): Promise<ClubDetails> {
  return rpc<ClubDetails>('owner_club', { p_club_id: id });
}

export async function fetchSessions(id: string, day: string): Promise<CloudSessionView[]> {
  return (await rpc<CloudSessionView[] | null>('owner_club_sessions', { p_club_id: id, p_day: day })) ?? [];
}

export function updateTariffs(id: string, body: UpdateTariffsRequest): Promise<UpdateTariffsResponse> {
  return edge<UpdateTariffsResponse>('PUT', `/owner/clubs/${encodeURIComponent(id)}/tariffs`, body);
}

// --- owner keys: replaced by Supabase Auth ------------------------------------

export async function fetchOwnerKeys(): Promise<OwnerKeyView[]> {
  return [];
}

export async function createOwnerKey(_label?: string): Promise<CreateOwnerKeyResponse> {
  throw new CloudRequestError(400, 'NOT_SUPPORTED', 'Ключи владельца не нужны: на телефоне войдите по почте');
}

export async function revokeOwnerKey(_id: string): Promise<void> {
  throw new CloudRequestError(400, 'NOT_SUPPORTED', 'Ключи владельца не используются');
}

// --- push -------------------------------------------------------------------

export function fetchPushSettings(): Promise<PushSettingsView> {
  return rpc<PushSettingsView>('owner_push_settings');
}

export function updatePushRules(rules: PushRule[]): Promise<PushSettingsView> {
  return rpc<PushSettingsView>('owner_set_push_rules', { p_rules: rules });
}

/** Idempotent by token on the server (a token moves to the owner who registered it last). */
export function registerDevice(body: RegisterDeviceBody): Promise<DeviceView> {
  return edge<DeviceView>('POST', '/owner/devices', body);
}

/** RLS lets an owner delete only their own device rows. */
export async function removeDevice(id: string): Promise<void> {
  await session();
  let res: { error: { message: string; code?: string } | null; status: number };
  try {
    res = await sb().from('owner_devices').delete().eq('id', id);
  } catch {
    return offline();
  }
  if (res.error) return fail(mapRpcError(res.error, res.status));
  emit({ type: 'online', online: true });
}

export function sendTestPush(): Promise<TestPushResponse> {
  return edge<TestPushResponse>('POST', '/owner/push/test');
}

// --- realtime ---------------------------------------------------------------

export interface AlertEvent {
  id: string;
  clubId: string;
  kind: string;
  message: string;
  at: number;
}

let channel: RealtimeChannel | null = null;
const alertListeners = new Set<(alert: AlertEvent) => void>();

function startRealtime(): void {
  if (channel) return;
  channel = sb()
    .channel('ts-alerts')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
      const row = payload.new as Record<string, unknown>;
      const alert: AlertEvent = {
        id: String(row.id ?? ''),
        clubId: String(row.club_id ?? ''),
        kind: String(row.kind ?? ''),
        message: String(row.message ?? ''),
        at: Number(row.at ?? Date.now()),
      };
      for (const l of alertListeners) l(alert);
    })
    .subscribe();
}

function stopRealtime(): void {
  if (!channel || !client) return;
  const c = channel;
  channel = null;
  void client.removeChannel(c);
}

/** New alerts of the owner's clubs (RLS filters them) while someone listens; the channel closes with the last listener. */
export function subscribeAlerts(listener: (alert: AlertEvent) => void): () => void {
  alertListeners.add(listener);
  startRealtime();
  return () => {
    alertListeners.delete(listener);
    if (alertListeners.size === 0) stopRealtime();
  };
}
