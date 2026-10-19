import type {
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
import * as http from './api-http.ts';
import type { RegisterDeviceBody } from './api-core.ts';
import type { AlertEvent } from './api-supabase.ts';
import { SUPABASE_MODE } from './config.ts';

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
