import type {
  BookingSettingsView,
  OwnerBookingsResponse,
  OwnerBookingView,
  UpdateBookingSettingsRequest,
  BusinessType,
  BlockClientRequest,
  BranchView,
  ClientView,
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
  LicenseView,
  ManagerInviteResponse,
  ManagerTempPasswordResponse,
  PlatformMe,
  UpdateCloudStaffRequest,
  ClubDetails,
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
import * as http from './api-http.ts';
import { CloudRequestError } from './api-core.ts';
import type { RegisterDeviceBody } from './api-core.ts';
import type { AlertEvent } from './api-supabase.ts';
import { SUPABASE_MODE } from './config.ts';
import type { HubCodeResponse } from './onboarding.ts';
import type { SignupRequest, SignupResponse } from './signup.ts';
import type { TrialSnapshot, TrialView } from './trials.ts';

/**
 * One API for the pages, two backends chosen at build time (config.ts):
 * api-http.ts — the self-hosted apps/cloud; api-supabase.ts — Supabase (loaded lazily, and dropped
 * from the self-hosted bundle because SUPABASE_MODE is a literal there).
 */
export { CloudRequestError, subscribeApi } from './api-core.ts';
export type { AnyDevicePlatform, ApiSignal, RegisterDeviceBody } from './api-core.ts';
export type { AlertEvent } from './api-supabase.ts';
export { SUPABASE_MODE } from './config.ts';

type SupabaseApi = typeof import('./api-supabase.ts');
let supabaseApi: Promise<SupabaseApi> | null = null;

function sb(): Promise<SupabaseApi> {
  // The literal condition (vite `define`) keeps the self-hosted build from emitting the Supabase chunk at all.
  supabaseApi ??= __TS_SUPABASE__
    ? import('./api-supabase.ts')
    : Promise.reject(new Error('this build has no Supabase backend'));
  return supabaseApi;
}

export async function login(email: string, password: string): Promise<OwnerView> {
  return SUPABASE_MODE ? (await sb()).login(email, password) : http.login(email, password);
}

/** Supabase only: a one-time sign-in link to the owner's e-mail. */
export async function sendMagicLink(email: string): Promise<void> {
  if (!SUPABASE_MODE) throw new Error('magic link needs the Supabase backend');
  return (await sb()).sendMagicLink(email);
}

/** Supabase only: why the magic link this page was opened with did not work. */
export async function takeLinkError(): Promise<string | null> {
  return SUPABASE_MODE ? (await sb()).takeLinkError() : null;
}

/** Sign-in by an owner key «OWNER-XXXX-XXXX-XXXX-XXXX» (self-hosted only). */
export async function loginByKey(key: string): Promise<OwnerView> {
  return SUPABASE_MODE ? (await sb()).loginByKey(key) : http.loginByKey(key);
}

export async function logout(): Promise<void> {
  return SUPABASE_MODE ? (await sb()).logout() : http.logout();
}

export async function fetchMe(): Promise<OwnerView> {
  return SUPABASE_MODE ? (await sb()).fetchMe() : http.fetchMe();
}

export async function fetchOverview(): Promise<OwnerOverview> {
  return SUPABASE_MODE ? (await sb()).fetchOverview() : http.fetchOverview();
}

export async function fetchClub(id: string): Promise<ClubDetails> {
  return SUPABASE_MODE ? (await sb()).fetchClub(id) : http.fetchClub(id);
}

/** `day` is a local calendar date of the club, YYYY-MM-DD. */
export async function fetchSessions(id: string, day: string): Promise<CloudSessionView[]> {
  return SUPABASE_MODE ? (await sb()).fetchSessions(id, day) : http.fetchSessions(id, day);
}

export async function updateTariffs(id: string, body: UpdateTariffsRequest): Promise<UpdateTariffsResponse> {
  return SUPABASE_MODE ? (await sb()).updateTariffs(id, body) : http.updateTariffs(id, body);
}

// --- phone: keys, devices, push rules ---------------------------------------

export async function fetchOwnerKeys(): Promise<OwnerKeyView[]> {
  return SUPABASE_MODE ? (await sb()).fetchOwnerKeys() : http.fetchOwnerKeys();
}

export async function createOwnerKey(label?: string): Promise<CreateOwnerKeyResponse> {
  return SUPABASE_MODE ? (await sb()).createOwnerKey(label) : http.createOwnerKey(label);
}

export async function revokeOwnerKey(id: string): Promise<void> {
  return SUPABASE_MODE ? (await sb()).revokeOwnerKey(id) : http.revokeOwnerKey(id);
}

export async function fetchPushSettings(): Promise<PushSettingsView> {
  return SUPABASE_MODE ? (await sb()).fetchPushSettings() : http.fetchPushSettings();
}

export async function updatePushRules(rules: PushRule[]): Promise<PushSettingsView> {
  return SUPABASE_MODE ? (await sb()).updatePushRules(rules) : http.updatePushRules(rules);
}

/** Idempotent by the token: the same device keeps its id. */
export async function registerDevice(body: RegisterDeviceBody): Promise<DeviceView> {
  return SUPABASE_MODE ? (await sb()).registerDevice(body) : http.registerDevice(body);
}

export async function removeDevice(id: string): Promise<void> {
  return SUPABASE_MODE ? (await sb()).removeDevice(id) : http.removeDevice(id);
}

export async function sendTestPush(): Promise<TestPushResponse> {
  return SUPABASE_MODE ? (await sb()).sendTestPush() : http.sendTestPush();
}

// --- «TS в Telegram» (Supabase only: the self-hosted cloud has no bot) --------

export async function fetchTelegram(): Promise<TelegramStatusView> {
  return SUPABASE_MODE ? (await sb()).fetchTelegram() : { configured: false, botUsername: null, chats: [] };
}

export async function linkTelegram(): Promise<TelegramLinkResponse> {
  if (!SUPABASE_MODE) throw new CloudRequestError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram пока не подключён к TS');
  return (await sb()).linkTelegram();
}

export async function unlinkTelegram(chatId: string): Promise<void> {
  if (!SUPABASE_MODE) return;
  return (await sb()).unlinkTelegram(chatId);
}

/** Supabase only: new alerts via Realtime. The self-hosted cabinet just polls. */
export function subscribeAlerts(listener: (alert: AlertEvent) => void): () => void {
  if (!SUPABASE_MODE) return () => undefined;
  let stop: (() => void) | null = null;
  let cancelled = false;
  void sb().then((api) => {
    if (!cancelled) stop = api.subscribeAlerts(listener);
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

// --- platform cabinet (owner / tech of TS) ------------------------------------

const PLATFORM_HINT_KEY = 'ts.cabinet.platform';

function setPlatformHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(PLATFORM_HINT_KEY, '1');
    else localStorage.removeItem(PLATFORM_HINT_KEY);
  } catch {
    // storage blocked: after a reload the cabinet asks the manager session first
  }
}

/**
 * Was the last sign-in here a platform one? The self-hosted cookie is HttpOnly, so the shell
 * remembers which cabinet to restore; with Supabase — a platform token or any Supabase session
 * (the platform owner may sign in by e-mail).
 */
export async function platformSessionLikely(): Promise<boolean> {
  if (SUPABASE_MODE) return (await sb()).hasPlatformSession();
  try {
    return localStorage.getItem(PLATFORM_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export async function platformLogin(key: string): Promise<PlatformMe> {
  const res = SUPABASE_MODE ? await (await sb()).platformLogin(key) : await http.platformLogin(key);
  setPlatformHint(true);
  return res.me;
}

export async function platformMe(): Promise<PlatformMe> {
  try {
    return SUPABASE_MODE ? await (await sb()).platformMe() : await http.platformMe();
  } catch (e) {
    if ((e as CloudRequestError).status === 401) setPlatformHint(false);
    throw e;
  }
}

export async function platformLogout(): Promise<void> {
  try {
    return SUPABASE_MODE ? await (await sb()).platformLogout() : await http.platformLogout();
  } finally {
    setPlatformHint(false);
  }
}

export async function listClients(): Promise<ClientView[]> {
  return SUPABASE_MODE ? (await sb()).listClients() : http.listClients();
}

export async function createClient(body: CreateClientRequest): Promise<CreateClientResponse> {
  return SUPABASE_MODE ? (await sb()).createClient(body) : http.createClient(body);
}

/** Extend or change the terms; the cloud re-signs the license. */
export async function setLicense(companyId: string, terms: LicenseTermsRequest): Promise<ClientView> {
  return SUPABASE_MODE ? (await sb()).setLicense(companyId, terms) : http.setLicense(companyId, terms);
}

export async function blockClient(companyId: string, blocked: boolean, reason?: string): Promise<ClientView> {
  const body: BlockClientRequest = reason ? { blocked, reason } : { blocked };
  return SUPABASE_MODE ? (await sb()).blockClient(companyId, body) : http.blockClient(companyId, body);
}

export async function issueManagerKey(companyId: string): Promise<IssuedLongKey> {
  return SUPABASE_MODE ? (await sb()).issueManagerKey(companyId) : http.issueManagerKey(companyId);
}

const SUPABASE_ONLY = () => new CloudRequestError(400, 'NOT_SUPPORTED', 'Только для облака на Supabase: здесь пароль управляющего задаётся при создании клиента');

/** Supabase: the manager gets an invitation letter (an existing account — a password-reset letter). */
export async function inviteManager(companyId: string): Promise<ManagerInviteResponse> {
  if (!SUPABASE_MODE) throw SUPABASE_ONLY();
  return (await sb()).inviteManager(companyId);
}

/** Supabase: a temporary password for the manager, shown once; changed on first sign-in. */
export async function managerTempPassword(companyId: string): Promise<ManagerTempPasswordResponse> {
  if (!SUPABASE_MODE) throw SUPABASE_ONLY();
  return (await sb()).managerTempPassword(companyId);
}

/** «Забыли пароль?» (Supabase): a reset letter leading to «Задать пароль». */
export async function sendPasswordReset(email: string): Promise<void> {
  if (!SUPABASE_MODE) throw SUPABASE_ONLY();
  return (await sb()).sendPasswordReset(email);
}

/** «Задать пароль» (Supabase): the signed-in user's new password. */
export async function setNewPassword(password: string): Promise<void> {
  if (!SUPABASE_MODE) throw SUPABASE_ONLY();
  return (await sb()).setNewPassword(password);
}

// --- manager cabinet: license, branches, staff ------------------------------------

export async function companyLicense(): Promise<LicenseView | null> {
  return SUPABASE_MODE ? (await sb()).companyLicense() : http.companyLicense();
}

export async function listBranches(): Promise<BranchView[]> {
  return SUPABASE_MODE ? (await sb()).listBranches() : http.listBranches();
}

export async function createBranch(body: CreateBranchRequest): Promise<CreateBranchResponse> {
  return SUPABASE_MODE ? (await sb()).createBranch(body) : http.createBranch(body);
}

export async function listStaff(clubId?: string): Promise<CloudStaffView[]> {
  return SUPABASE_MODE ? (await sb()).listStaff(clubId) : http.listStaff(clubId);
}

export async function createStaff(body: CreateCloudStaffRequest): Promise<CloudStaffView> {
  return SUPABASE_MODE ? (await sb()).createStaff(body) : http.createStaff(body);
}

export async function updateStaff(id: string, body: UpdateCloudStaffRequest): Promise<CloudStaffView> {
  return SUPABASE_MODE ? (await sb()).updateStaff(id, body) : http.updateStaff(id, body);
}

export async function issueStaffKey(staffId: string, body: IssueCloudKeyRequest): Promise<IssueCloudKeyResponse> {
  return SUPABASE_MODE ? (await sb()).issueStaffKey(staffId, body) : http.issueStaffKey(staffId, body);
}

export async function revokeKey(keyId: string): Promise<CloudKeyView> {
  return SUPABASE_MODE ? (await sb()).revokeKey(keyId) : http.revokeKey(keyId);
}

// --- who is signed in: the manager, the platform, or (Supabase) both --------------

export interface Identity {
  owner: OwnerView | null;
  platform: PlatformMe | null;
  /** Supabase: opened from an invitation / reset letter or signed in with a temporary password — «Задать пароль» first. */
  mustSetPassword?: boolean;
}

/**
 * E-mail and password. With Supabase one account may be a manager, a member of the platform
 * team, or both; the self-hosted cloud signs in managers only (the platform uses a key).
 */
export async function loginEmail(email: string, password: string): Promise<Identity> {
  if (SUPABASE_MODE) return (await sb()).loginEmail(email, password);
  return { owner: await http.login(email, password), platform: null };
}

/** The stored session on start. Throws 401 when nobody is signed in, anything else to retry. */
export async function restoreSession(): Promise<Identity> {
  if (SUPABASE_MODE) {
    const api = await sb();
    const platform = await api.platformMeOrNull();
    const owner = await api.ownerMeOrNull();
    if (!owner && !platform) {
      // A Supabase account matching nobody: fetchMe signs it out and words the error.
      return { owner: await api.fetchMe(), platform: null };
    }
    return { owner, platform, mustSetPassword: await api.mustSetPassword() };
  }
  if (await platformSessionLikely()) {
    try {
      return { owner: null, platform: await platformMe() };
    } catch (e) {
      if ((e as CloudRequestError).status !== 401) throw e;
    }
  }
  return { owner: await http.fetchMe(), platform: null };
}

// --- «Начать бесплатно» and «Первые шаги» ------------------------------------------------

/** Self-sign-up exists only in the TS cloud (Supabase); a self-hosted cloud adds clients by hand. */
export const SIGNUP_AVAILABLE: boolean = SUPABASE_MODE;

/** Creates the company, the first venue and the trial; the caller then signs in with the same e-mail. */
export async function signup(body: SignupRequest): Promise<SignupResponse> {
  if (!SUPABASE_MODE) throw new CloudRequestError(404, 'NOT_AVAILABLE', 'Регистрация есть только в облаке TS');
  return (await sb()).signup(body);
}

/** A new connection code for the venue's cash register; the previous code stops working. */
export async function issueHubCode(clubId: string): Promise<HubCodeResponse> {
  return SUPABASE_MODE ? (await sb()).issueHubCode(clubId) : http.issueHubCode(clubId);
}

/** GET /owner/onboarding as the cloud sent it (onboarding.ts parses it); 404 on an older cloud. */
export async function fetchOnboarding(): Promise<unknown> {
  return SUPABASE_MODE ? (await sb()).fetchOnboarding() : http.fetchOnboarding();
}

export async function setBusinessType(clubId: string, type: BusinessType): Promise<void> {
  return SUPABASE_MODE ? (await sb()).setBusinessType(clubId, type) : http.setBusinessType(clubId, type);
}

// --- «Онлайн-бронь столов» (Supabase only; the guest's page is book.ts) -------------------

/** Online booking lives in the TS cloud (Supabase): the self-hosted cloud has no public page. */
export const BOOKING_AVAILABLE: boolean = SUPABASE_MODE;

const noBooking = (): never => {
  throw new CloudRequestError(404, 'NOT_AVAILABLE', 'Онлайн-бронь есть только в облаке TS');
};

export async function fetchBookings(clubId: string, from: string | null, days: number): Promise<OwnerBookingsResponse> {
  return SUPABASE_MODE ? (await sb()).fetchBookings(clubId, from, days) : noBooking();
}

export async function setBookingStatus(clubId: string, bookingId: string, action: 'confirm' | 'cancel'): Promise<OwnerBookingView> {
  return SUPABASE_MODE ? (await sb()).setBookingStatus(clubId, bookingId, action) : noBooking();
}

export async function saveBookingSettings(clubId: string, patch: UpdateBookingSettingsRequest): Promise<BookingSettingsView> {
  return SUPABASE_MODE ? (await sb()).saveBookingSettings(clubId, patch) : noBooking();
}

// --- «Пробные версии» of the platform (Supabase only: browser trials report to the TS cloud) ---

/** Browser trials report to the TS cloud (Supabase); a self-hosted cloud never sees them. */
export const TRIALS_AVAILABLE: boolean = SUPABASE_MODE;

const noTrials = (): never => {
  throw new CloudRequestError(404, 'NOT_AVAILABLE', 'Доступно только в облачной версии');
};

/** Newest first. */
export async function listTrials(): Promise<TrialView[]> {
  return SUPABASE_MODE ? (await sb()).listTrials() : noTrials();
}

/** Adds `days` (1..90) to the trial; the cloud answers with the updated trial. */
export async function extendTrial(id: string, days: number): Promise<TrialView> {
  return SUPABASE_MODE ? (await sb()).extendTrial(id, days) : noTrials();
}

export async function endTrial(id: string): Promise<TrialView> {
  return SUPABASE_MODE ? (await sb()).endTrial(id) : noTrials();
}

/** The trial's last SQLite copy as base64; CloudRequestError 404 when there is none. */
export async function fetchTrialSnapshot(id: string): Promise<TrialSnapshot> {
  return SUPABASE_MODE ? (await sb()).fetchTrialSnapshot(id) : noTrials();
}
