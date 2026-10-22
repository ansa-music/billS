/**
 * Connection code of a club HUB. The cabinet shows it (text and QR) once a branch is
 * created; the HUB's first-boot wizard (`/setup` in apps/hub) reads it. One string carries
 * the three values a HUB needs to reach the cloud — HUB_ID, CLOUD_API_KEY and CLOUD_URL —
 * so the manager never types a URL or a 43-character key.
 *
 *   TS1.<base64url(UTF-8 JSON {"h": hubId, "k": apiKey, "u": cloudUrl})>
 *
 * `TS1` is the format version: a later format gets a new prefix and an older HUB says
 * «обновите HUB» instead of misreading it. Unknown JSON fields are ignored, so v1 can grow
 * optional extras. The QR carries `http://hub.local:4310/setup#code=TS1.…`: the code sits in
 * the URL fragment, which browsers never send to the server, so it stays out of logs.
 *
 * Runs in browsers and Node: no Buffer, no node:*.
 */
import { b64urlDecodeBytes, b64urlEncode } from './license.ts';
import { normalizeCloudUrl } from './push.ts';
import { originUrl } from './tls.ts';

export const HUB_SETUP_CODE_VERSION = 1;
const PREFIX = `TS${HUB_SETUP_CODE_VERSION}.`;

/** Where a fresh HUB answers in the club network: mDNS name and port (HUB_MDNS_NAME=hub, HUB_PORT). */
export const HUB_SETUP_HOST = 'hub.local';
export const HUB_SETUP_PORT = 4310;
export const HUB_SETUP_PATH = '/setup';
/** Name of the file the wizard writes next to the HUB database (`/var/lib/bills/setup.json`). */
export const HUB_SETUP_FILE_NAME = 'setup.json';

export interface HubSetupCode {
  hubId: string;
  apiKey: string;
  /** CLOUD_URL of the HUB: `https://<ref>.supabase.co/functions/v1` or the self-hosted cloud's address. */
  cloudUrl: string;
}

export type HubSetupCodeProblem = 'empty' | 'not_a_code' | 'newer_version' | 'damaged';

export type HubSetupCodeResult =
  | { ok: true; value: HubSetupCode }
  | { ok: false; problem: HubSetupCodeProblem; message: string };

export const HUB_SETUP_CODE_MESSAGES: Readonly<Record<HubSetupCodeProblem, string>> = {
  empty: 'Вставьте код подключения из кабинета',
  not_a_code: 'Это не код подключения TS. Скопируйте код из кабинета целиком — он начинается с «TS1.»',
  newer_version: 'Код создан более новой версией TS. Обновите HUB или введите HUB_ID и ключ вручную',
  damaged: 'Код повреждён или скопирован не полностью — скопируйте его из кабинета ещё раз',
};

// `hub-<slug>`, `hub-<uuid>`, `hub-demo-1`: latin letters, digits and . _ : -
const HUB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The cloud issues 32 random bytes in base64url; dev/demo keys are shorter. Printable ASCII, no spaces.
const API_KEY_RE = /^[\x21-\x7e]{8,512}$/;

/** null when the HUB_ID looks right, otherwise what to tell the person. */
export function hubIdProblem(hubId: string): string | null {
  if (!hubId.trim()) return 'Укажите HUB_ID из кабинета';
  return HUB_ID_RE.test(hubId.trim()) ? null : 'HUB_ID скопирован неточно: в нём только латинские буквы, цифры и дефисы, без пробелов';
}

/** null when the key looks right, otherwise what to tell the person. */
export function hubApiKeyProblem(apiKey: string): string | null {
  if (!apiKey.trim()) return 'Укажите ключ HUB (CLOUD_API_KEY) из кабинета';
  return API_KEY_RE.test(apiKey.trim()) ? null : 'Ключ HUB скопирован неточно: он длинный, без пробелов — скопируйте его ещё раз';
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The code for a branch; throws on values the cloud never issues (the cabinet passes them as is). */
export function encodeHubSetupCode(input: HubSetupCode): string {
  const hubId = input.hubId.trim();
  const apiKey = input.apiKey.trim();
  const cloudUrl = normalizeCloudUrl(input.cloudUrl);
  const problem = hubIdProblem(hubId) ?? hubApiKeyProblem(apiKey) ?? (cloudUrl ? null : 'cloud URL must be http(s)');
  if (problem) throw new Error(`encodeHubSetupCode: ${problem}`);
  return PREFIX + b64urlEncode(utf8.encode(JSON.stringify({ h: hubId, k: apiKey, u: cloudUrl })));
}

/**
 * The bare code out of whatever was pasted or scanned: whitespace and line breaks are
 * dropped (a code wrapped in an e-mail), a setup link gives its `#code=` / `?code=`.
 */
export function extractHubSetupCode(text: string): string {
  let s = text.replace(/\s+/g, '');
  const link = /[#?&]code=([^&#]*)/i.exec(s);
  if (link) {
    s = link[1] ?? '';
    try {
      s = decodeURIComponent(s);
    } catch {
      // Not percent-encoded after all: keep it as is, the checks below decide.
    }
  }
  return s;
}

function fail(problem: HubSetupCodeProblem): HubSetupCodeResult {
  return { ok: false, problem, message: HUB_SETUP_CODE_MESSAGES[problem] };
}

/** Reads a connection code (or a setup link with one); never throws. */
export function parseHubSetupCode(text: string): HubSetupCodeResult {
  const s = extractHubSetupCode(text);
  if (!s) return fail('empty');
  const dot = s.indexOf('.');
  const version = /^TS(\d{1,3})$/i.exec(dot > 0 ? s.slice(0, dot) : '');
  if (!version) return fail('not_a_code');
  const v = Number(version[1]);
  if (v !== HUB_SETUP_CODE_VERSION) return fail(v > HUB_SETUP_CODE_VERSION ? 'newer_version' : 'not_a_code');
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8.decode(b64urlDecodeBytes(s.slice(dot + 1))));
  } catch {
    return fail('damaged');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return fail('damaged');
  const o = json as Record<string, unknown>;
  const hubId = typeof o.h === 'string' ? o.h.trim() : '';
  const apiKey = typeof o.k === 'string' ? o.k.trim() : '';
  const cloudUrl = typeof o.u === 'string' && /^https?:\/\//i.test(o.u.trim()) ? normalizeCloudUrl(o.u) : null;
  if (hubIdProblem(hubId) || hubApiKeyProblem(apiKey) || !cloudUrl) return fail('damaged');
  return { ok: true, value: { hubId, apiKey, cloudUrl } };
}

/** `http://hub.local:4310/setup#code=TS1.…` — what the cabinet's QR opens on a phone in the club Wi-Fi. */
export function hubSetupUrl(code: string, host: string = HUB_SETUP_HOST, port: number = HUB_SETUP_PORT): string {
  return `${originUrl('http', host, port)}${HUB_SETUP_PATH}#code=${code}`;
}

/**
 * The CLOUD_URL a HUB must use, as the cabinet knows it:
 * - Supabase: the `sync` Edge Function answers under `<project>/functions/v1`
 *   (the HUB calls `${CLOUD_URL}/sync/events` → function `sync`, path `/sync/events`);
 * - self-hosted apps/cloud: the cloud's own address — the cabinet is served from it
 *   (in the phone app: the cloud address from the app settings).
 */
export function hubCloudUrl(where: { supabaseUrl?: string | null; cloudOrigin?: string | null }): string | null {
  if (where.supabaseUrl) {
    const base = normalizeCloudUrl(where.supabaseUrl);
    return base ? `${base.replace(/\/functions\/v1$/i, '')}/functions/v1` : null;
  }
  return where.cloudOrigin ? normalizeCloudUrl(where.cloudOrigin) : null;
}

// ---------------------------------------------------------------------------
// HUB wizard API (apps/hub, LAN only, while the HUB is not connected to a cloud):
//   GET  /setup               the wizard page (or «HUB уже настроен»)
//   GET  /api/setup/status    → HubSetupStatus
//   POST /api/setup           HubSetupRequest → HubSetupResponse; 422 SETUP_INVALID (with `field`),
//                             CLOUD_KEY_INVALID, CLOUD_HUB_MISMATCH, CLOUD_NOT_TS; 502 CLOUD_UNREACHABLE
//                             (`canSkip: true` — resend with skipCheck); 409 SETUP_DONE; 410 SETUP_DISABLED;
//                             403 SETUP_LAN_ONLY
// ---------------------------------------------------------------------------

export type HubSetupLampDriver = 'simulator' | 'esp32-http' | 'modbus-tcp';

export interface HubSetupStatus {
  open: boolean;
  /**
   * `configured` — connected to a cloud (hub.env or setup.json), `saved` — just saved, restarting,
   * `demo` — a demo HUB, `off` — closed by HUB_SETUP=off (a club that runs without a cloud on purpose).
   */
  state: 'open' | 'configured' | 'saved' | 'demo' | 'off';
  /** HUB_ID in effect when configured. */
  hubId: string | null;
  /** CLOUD_URL already set in hub.env: manual entry does not ask for it. */
  cloudUrlPreset: string | null;
  /** HUB_LAMP_DRIVER already set in hub.env: the wizard does not choose the controller. */
  lampsPreset: HubSetupLampDriver | null;
}

export interface HubSetupRequest {
  /** Connection code (or a setup link with it); takes precedence over the manual fields. */
  code?: string;
  hubId?: string;
  apiKey?: string;
  /** Manual entry only; defaults to `cloudUrlPreset`. */
  cloudUrl?: string;
  lamps?: { driver: HubSetupLampDriver; esp32Host?: string; esp32Token?: string; modbusHost?: string };
  /** Save without the cloud check (no internet yet); the HUB connects by itself later. */
  skipCheck?: boolean;
}

export interface HubSetupResponse {
  ok: true;
  hubId: string;
  cloudUrl: string;
  /** Whether the cloud accepted the key before saving. */
  checked: boolean;
  /** The HUB restarts this soon to apply the settings. */
  restartInMs: number;
  warning: string | null;
}

/** A cloud address only this very computer can reach (the cabinet was opened as localhost). */
export function isLocalOnlyCloudUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || host === '::1';
}
