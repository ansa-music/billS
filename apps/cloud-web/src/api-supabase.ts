/**
 * Supabase backend: Auth (password, magic link), PostgREST RPC for reports and push settings,
 * the `owner` Edge Function for writes that need server-side validation, Realtime for new alerts.
 * Loaded only in a Supabase build (see api.ts), so the self-hosted bundle has no supabase-js.
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { RealtimeChannel, Session, SupabaseClient } from '@supabase/supabase-js';
import type {
  BookingSettingsView,
  OwnerBookingsResponse,
  OwnerBookingView,
  UpdateBookingSettingsRequest,
  BusinessType,
  BlockClientRequest,
  BranchView,
  ClientView,
  ClubDetails,
  CloudKeyView,
  CloudStaffView,
  CreateBranchRequest,
  CreateBranchResponse,
  CreateClientRequest,
  CreateClientResponse,
  CreateCloudStaffRequest,
  IssueCloudKeyRequest,
  IssueCloudKeyResponse,
  IssuedLongKey,
  LicenseTermsRequest,
  ManagerInviteResponse,
  ManagerTempPasswordResponse,
  LicenseView,
  PlatformLoginRequest,
  PlatformLoginResponse,
  PlatformMe,
  UpdateCloudStaffRequest,
  CloudSessionView,
  CreateOwnerKeyResponse,
  DeviceView,
  OwnerKeyView,
  OwnerOverview,
  OwnerView,
  PushRule,
  PushSettingsView,
  TelegramLinkResponse,
  TelegramStatusView,
  TestPushResponse,
  UpdateTariffsRequest,
  UpdateTariffsResponse,
} from '@bills/domain';
import { CloudRequestError, emit } from './api-core.ts';
import type { RegisterDeviceBody } from './api-core.ts';
import { supabaseAnonKey, supabaseUrl } from './config.ts';
import { forgetLocalDevices, localDeviceIds } from './localDevices.ts';
import { nativeBridge } from './platform.ts';
import type { TrialSnapshot, TrialView } from './trials.ts';
import {
  OFFLINE_MESSAGE,
  edgeErrorOf,
  edgeFunctionUrl,
  parsePlatformSession,
  authErrorFromHash,
  describeAuthError,
  edgeUrl,
  magicLinkRedirect,
  mapRpcError,
  MUST_CHANGE_PASSWORD,
  mustChangePassword,
  SET_PASSWORD_HASH,
  setPasswordLink,
} from './supabase-util.ts';
import type { MappedError } from './supabase-util.ts';
import type { HubCodeResponse } from './onboarding.ts';
import type { SignupRequest, SignupResponse } from './signup.ts';

let client: SupabaseClient | null = null;
let linkError: string | null = null;
/** Opened from an invitation / password-reset letter: the password is set before the cabinet opens. */
let linkSetPassword = false;

function sb(): SupabaseClient {
  if (client) return client;
  // A failed magic link comes back as `#error=…`: keep the text for the login form and give the
  // hash router a clean route before supabase-js looks at the URL.
  const link = setPasswordLink(location.hash);
  linkSetPassword = link.setPassword;
  if (link.hash !== location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${link.hash}`);
  linkError = authErrorFromHash(location.hash);
  if (linkError) linkSetPassword = false;
  if (linkError) history.replaceState(history.state, '', `${location.pathname}${location.search}#/`);
  client = createSupabaseClient(supabaseUrl(), supabaseAnonKey(), {
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

async function edgeError(res: Response): Promise<CloudRequestError> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // not JSON — keep the generic text
  }
  const { code, message } = edgeErrorOf(res.status, data);
  emit({ type: 'online', online: true });
  return new CloudRequestError(res.status, code, message);
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
  if (!res.ok) throw await edgeError(res);
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

/**
 * E-mail sign-in for both cabinets: the same Supabase account may be a manager (owner_me),
 * a member of the platform team (Edge Function `platform` accepts the JWT), or both.
 */
export async function loginEmail(email: string, password: string): Promise<{ owner: OwnerView | null; platform: PlatformMe | null }> {
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
  return whoAmI();
}

/** Who the stored Supabase session belongs to; signs out and throws NOT_OWNER when it is nobody. */
export async function whoAmI(): Promise<{ owner: OwnerView | null; platform: PlatformMe | null; mustSetPassword: boolean }> {
  const platform = await platformMeOrNull();
  const owner = await rpc<OwnerView | null>('owner_me');
  if (!owner && !platform) {
    await sb()
      .auth.signOut({ scope: 'local' })
      .catch(() => undefined);
    throw new CloudRequestError(401, 'NOT_OWNER', 'Эта почта не привязана ни к управляющему, ни к команде TS');
  }
  return { owner: owner ?? null, platform, mustSetPassword: await mustSetPassword() };
}

/**
 * The signed-in user must set a password first: opened from an invitation / reset letter, or
 * signed in with a temporary password (user_metadata ts_must_change_password).
 */
export async function mustSetPassword(): Promise<boolean> {
  try {
    const user = (await sb().auth.getSession()).data.session?.user;
    if (!user) return false;
    return linkSetPassword || mustChangePassword(user.user_metadata);
  } catch {
    return false;
  }
}

/** «Задать пароль»: the new password for the signed-in user; the temporary-password flag is cleared. */
export async function setNewPassword(password: string): Promise<void> {
  await session();
  let res: Awaited<ReturnType<SupabaseClient['auth']['updateUser']>>;
  try {
    res = await sb().auth.updateUser({ password, data: { [MUST_CHANGE_PASSWORD]: false } });
  } catch {
    return offline();
  }
  if (res.error) {
    const m = describeAuthError(res.error);
    emit({ type: 'online', online: !m.offline });
    throw new CloudRequestError(m.status, m.code, m.message);
  }
  linkSetPassword = false;
  emit({ type: 'online', online: true });
}

/** «Забыли пароль?»: Supabase sends a reset letter whose link leads to «Задать пароль» on this page. */
export async function sendPasswordReset(email: string): Promise<void> {
  let res: Awaited<ReturnType<SupabaseClient['auth']['resetPasswordForEmail']>>;
  try {
    res = await sb().auth.resetPasswordForEmail(email, {
      redirectTo: `${magicLinkRedirect(import.meta.env.BASE_URL, location.href)}${SET_PASSWORD_HASH}`,
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

/** The manager of this session, or null (no sign-out, unlike fetchMe). */
export async function ownerMeOrNull(): Promise<OwnerView | null> {
  try {
    // No Supabase session (a platform key sign-in): nothing to ask, and no "unauthorized" signal.
    if (!(await sb().auth.getSession()).data.session) return null;
    return (await rpc<OwnerView | null>('owner_me')) ?? null;
  } catch {
    return null;
  }
}

/** platformMe, with 403 NOT_PLATFORM (an ordinary manager) and 401 quietly as null. */
export async function platformMeOrNull(): Promise<PlatformMe | null> {
  try {
    return await platformEdge<PlatformMe>('GET', '/platform/me', undefined, true, true);
  } catch (e) {
    const err = e as CloudRequestError;
    if (err.status === 403 || err.status === 401) return null;
    throw e;
  }
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
  throw new CloudRequestError(400, 'NOT_SUPPORTED', 'Вход по ключу телефона в этой версии не используется: войдите по почте');
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
    throw new CloudRequestError(401, 'NOT_OWNER', 'Эта почта не привязана ни к управляющему, ни к команде TS');
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
  throw new CloudRequestError(400, 'NOT_SUPPORTED', 'Ключи телефона не нужны: на телефоне войдите по почте');
}

export async function revokeOwnerKey(_id: string): Promise<void> {
  throw new CloudRequestError(400, 'NOT_SUPPORTED', 'Ключи телефона не используются');
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

// --- «TS в Telegram» ----------------------------------------------------------

export function fetchTelegram(): Promise<TelegramStatusView> {
  return edge<TelegramStatusView>('GET', '/owner/telegram');
}

export function linkTelegram(): Promise<TelegramLinkResponse> {
  return edge<TelegramLinkResponse>('POST', '/owner/telegram/link');
}

export async function unlinkTelegram(chatId: string): Promise<void> {
  await edge<{ ok: true }>('DELETE', `/owner/telegram/chats/${encodeURIComponent(chatId)}`);
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

// --- platform cabinet: Edge Function `platform`, own Bearer session token ----

const PLATFORM_SESSION_KEY = 'ts.platform.session';
type PlatformSession = { token: string; expiresAt: number };
/** Fallback when storage is blocked: the session lives until the page is closed. */
let memoryPlatformSession: PlatformSession | null = null;

function readPlatformSession(): PlatformSession | null {
  try {
    return parsePlatformSession(localStorage.getItem(PLATFORM_SESSION_KEY), Date.now());
  } catch {
    return memoryPlatformSession && memoryPlatformSession.expiresAt > Date.now() ? memoryPlatformSession : null;
  }
}

function writePlatformSession(value: PlatformSession | null): void {
  memoryPlatformSession = value;
  try {
    if (value) localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(PLATFORM_SESSION_KEY);
  } catch {
    // storage blocked — memoryPlatformSession keeps it
  }
}

/** A platform key session, or a Supabase Auth session (the platform owner may sign in by e-mail). */
export async function hasPlatformSession(): Promise<boolean> {
  if (readPlatformSession()) return true;
  try {
    return (await sb().auth.getSession()).data.session !== null;
  } catch {
    return false;
  }
}

/**
 * The `platform` Edge Function. Bearer = the platform key session token, or else the Supabase
 * Auth JWT (accepted when the e-mail is in platform_staff; 403 NOT_PLATFORM otherwise).
 * `quiet`: a 401 does not send the shell to the login form (probing who is signed in).
 * `fn`: another function that checks the caller the same way (`invite-manager`).
 */
async function platformEdge<T>(method: string, path: string, body?: unknown, auth = true, quiet = false, fn = 'platform'): Promise<T> {
  const headers: Record<string, string> = { apikey: supabaseAnonKey() };
  let keySession = false;
  if (auth) {
    const s = readPlatformSession();
    if (s) {
      headers.authorization = `Bearer ${s.token}`;
      keySession = true;
    } else {
      let jwt: string | null = null;
      try {
        jwt = (await sb().auth.getSession()).data.session?.access_token ?? null;
      } catch {
        return offline();
      }
      if (!jwt) {
        if (quiet) throw new CloudRequestError(401, 'UNAUTHORIZED', 'Нужно войти');
        return unauthorized();
      }
      headers.authorization = `Bearer ${jwt}`;
    }
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(edgeFunctionUrl(supabaseUrl(), fn, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return offline();
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return offline();
  if (res.status === 401 && auth) {
    if (keySession) writePlatformSession(null);
    const err = await edgeError(res);
    if (!quiet) emit({ type: 'unauthorized' });
    throw err;
  }
  if (!res.ok) throw await edgeError(res);
  emit({ type: 'online', online: true });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export async function platformLogin(key: string): Promise<PlatformLoginResponse> {
  const body: PlatformLoginRequest = { key };
  const res = await platformEdge<PlatformLoginResponse>('POST', '/platform/login', body, false);
  if (!res.token) throw new CloudRequestError(500, 'NO_TOKEN', 'Облако не выдало сессию платформы');
  writePlatformSession({ token: res.token, expiresAt: res.expiresAt });
  return res;
}

export function platformMe(): Promise<PlatformMe> {
  return platformEdge<PlatformMe>('GET', '/platform/me');
}

export async function platformLogout(): Promise<void> {
  try {
    if (readPlatformSession()) await platformEdge<unknown>('POST', '/platform/logout');
  } finally {
    writePlatformSession(null);
    // Signed in by e-mail: end the Supabase session too.
    await logout().catch(() => undefined);
  }
}

export async function listClients(): Promise<ClientView[]> {
  return (await platformEdge<{ clients: ClientView[] }>('GET', '/platform/clients')).clients;
}

export function createClient(body: CreateClientRequest): Promise<CreateClientResponse> {
  return platformEdge<CreateClientResponse>('POST', '/platform/clients', body);
}

export function setLicense(companyId: string, terms: LicenseTermsRequest): Promise<ClientView> {
  return platformEdge<ClientView>('POST', `/platform/clients/${enc(companyId)}/license`, terms);
}

export function blockClient(companyId: string, body: BlockClientRequest): Promise<ClientView> {
  return platformEdge<ClientView>('POST', `/platform/clients/${enc(companyId)}/block`, body);
}

export function issueManagerKey(companyId: string): Promise<IssuedLongKey> {
  return platformEdge<IssuedLongKey>('POST', `/platform/clients/${enc(companyId)}/manager-key`);
}

// «Пробные версии»: browser trials of coffee shops that report to the cloud.

export async function listTrials(): Promise<TrialView[]> {
  return (await platformEdge<{ trials: TrialView[] }>('GET', '/platform/trials')).trials;
}

export function extendTrial(id: string, days: number): Promise<TrialView> {
  return platformEdge<TrialView>('POST', `/platform/trials/${enc(id)}/extend`, { days });
}

export function endTrial(id: string): Promise<TrialView> {
  return platformEdge<TrialView>('POST', `/platform/trials/${enc(id)}/end`, {});
}

/** The last SQLite copy the trial sent (base64); 404 when it has sent none yet. */
export function fetchTrialSnapshot(id: string): Promise<TrialSnapshot> {
  return platformEdge<TrialSnapshot>('GET', `/platform/trials/${enc(id)}/snapshot`);
}

/** Edge Function `invite-manager`: Supabase mails the manager an invitation (or a reset letter for an existing account). */
export function inviteManager(companyId: string): Promise<ManagerInviteResponse> {
  return platformEdge<ManagerInviteResponse>('POST', `/invite-manager/clients/${enc(companyId)}/invite`, {}, true, true, 'invite-manager');
}

/** Edge Function `invite-manager`: a temporary password, shown once; the manager changes it on first sign-in. */
export function managerTempPassword(companyId: string): Promise<ManagerTempPasswordResponse> {
  return platformEdge<ManagerTempPasswordResponse>('POST', `/invite-manager/clients/${enc(companyId)}/temp-password`, {}, true, true, 'invite-manager');
}

// --- manager cabinet: Edge Function `owner`, /owner/company/… -----------------

export async function companyLicense(): Promise<LicenseView | null> {
  return (await edge<{ license: LicenseView | null }>('GET', '/owner/company/license')).license;
}

export async function listBranches(): Promise<BranchView[]> {
  return (await edge<{ branches: BranchView[] }>('GET', '/owner/company/branches')).branches;
}

export function createBranch(body: CreateBranchRequest): Promise<CreateBranchResponse> {
  return edge<CreateBranchResponse>('POST', '/owner/company/branches', body);
}

export async function listStaff(clubId?: string): Promise<CloudStaffView[]> {
  const q = clubId ? `?clubId=${enc(clubId)}` : '';
  return (await edge<{ staff: CloudStaffView[] }>('GET', `/owner/company/staff${q}`)).staff;
}

export function createStaff(body: CreateCloudStaffRequest): Promise<CloudStaffView> {
  return edge<CloudStaffView>('POST', '/owner/company/staff', body);
}

export function updateStaff(id: string, body: UpdateCloudStaffRequest): Promise<CloudStaffView> {
  return edge<CloudStaffView>('POST', `/owner/company/staff/${enc(id)}/update`, body);
}

export function issueStaffKey(staffId: string, body: IssueCloudKeyRequest): Promise<IssueCloudKeyResponse> {
  return edge<IssueCloudKeyResponse>('POST', `/owner/company/staff/${enc(staffId)}/keys`, body);
}

export function revokeKey(keyId: string): Promise<CloudKeyView> {
  return edge<CloudKeyView>('POST', `/owner/company/keys/${enc(keyId)}/revoke`);
}

// --- «Начать бесплатно» and «Первые шаги» ------------------------------------------------

/** POST functions/v1/signup — no session yet: the anon key only. */
export async function signup(body: SignupRequest): Promise<SignupResponse> {
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl()}/functions/v1/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: supabaseAnonKey(),
        authorization: `Bearer ${supabaseAnonKey()}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new CloudRequestError(0, 'OFFLINE', OFFLINE_MESSAGE);
  }
  if (res.status === 404) throw new CloudRequestError(404, 'NOT_AVAILABLE', 'Регистрация пока не работает');
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new CloudRequestError(res.status, 'OFFLINE', OFFLINE_MESSAGE);
  if (!res.ok) throw await edgeError(res);
  return (await res.json()) as SignupResponse;
}

export function issueHubCode(clubId: string): Promise<HubCodeResponse> {
  return edge<HubCodeResponse>('POST', `/owner/clubs/${enc(clubId)}/hub-code`);
}

export function fetchOnboarding(): Promise<unknown> {
  return edge<unknown>('GET', '/owner/onboarding');
}

export async function setBusinessType(clubId: string, type: BusinessType): Promise<void> {
  await edge<unknown>('POST', `/owner/clubs/${enc(clubId)}/business`, { type });
}

// --- «Онлайн-бронь столов» --------------------------------------------------------------

export function fetchBookings(clubId: string, from: string | null, days: number): Promise<OwnerBookingsResponse> {
  const q = new URLSearchParams({ days: String(days), ...(from ? { from } : {}) });
  return edge<OwnerBookingsResponse>('GET', `/owner/clubs/${enc(clubId)}/bookings?${q}`);
}

export function setBookingStatus(clubId: string, bookingId: string, action: 'confirm' | 'cancel'): Promise<OwnerBookingView> {
  return edge<OwnerBookingView>('POST', `/owner/clubs/${enc(clubId)}/bookings/${enc(bookingId)}/${action}`);
}

export function saveBookingSettings(clubId: string, patch: UpdateBookingSettingsRequest): Promise<BookingSettingsView> {
  return edge<BookingSettingsView>('PUT', `/owner/clubs/${enc(clubId)}/booking-settings`, patch);
}
