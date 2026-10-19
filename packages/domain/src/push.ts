import type { OwnerView } from './cloud.ts';

/**
 * Phase 3: the owner's phone app. Push notifications about alerts, device
 * registration, notification rules and sign-in by an owner key (typed or
 * scanned from a QR shown in the cabinet). Shared by apps/cloud (server),
 * apps/cloud-web (cabinet) and apps/mobile (Capacitor shell).
 */

// ---------------------------------------------------------------------------
// What can be pushed
// ---------------------------------------------------------------------------

/**
 * Kinds of push notifications. Most are alert kinds raised by the HUB
 * (`alert.raised`); HUB_OFFLINE and SHIFT_NOT_CLOSED are raised by the cloud
 * itself from what it does not hear from the club.
 */
export type PushKind =
  | 'LIGHT_WITHOUT_GAME'
  | 'LAMP_DARK_DURING_GAME'
  | 'POWER_ON_BATTERY'
  | 'POWER_CRITICAL'
  | 'HUB_OFFLINE'
  | 'SHIFT_NOT_CLOSED'
  | 'UPS_UNREACHABLE'
  | 'LAMP_FAILED'
  | 'PREPAID_NOT_STARTED'
  | 'OTHER';

export interface PushKindInfo {
  kind: PushKind;
  label: string;
  /** Sent unless the owner switched it off. */
  defaultOn: boolean;
}

/** In the order the cabinet lists them. */
export const PUSH_KINDS: readonly PushKindInfo[] = [
  { kind: 'LIGHT_WITHOUT_GAME', label: 'Свет горит без игры', defaultOn: true },
  { kind: 'LAMP_DARK_DURING_GAME', label: 'Игра идёт без света', defaultOn: true },
  { kind: 'POWER_ON_BATTERY', label: 'Нет электричества, клуб на ИБП', defaultOn: true },
  { kind: 'POWER_CRITICAL', label: 'Батарея ИБП почти разряжена', defaultOn: true },
  { kind: 'HUB_OFFLINE', label: 'HUB клуба пропал со связи', defaultOn: true },
  { kind: 'SHIFT_NOT_CLOSED', label: 'Кассовая смена не закрыта', defaultOn: true },
  { kind: 'UPS_UNREACHABLE', label: 'ИБП не отвечает', defaultOn: false },
  { kind: 'LAMP_FAILED', label: 'Лампа не включилась или не выключилась', defaultOn: false },
  { kind: 'PREPAID_NOT_STARTED', label: 'Оплаченная игра не началась', defaultOn: false },
  { kind: 'OTHER', label: 'Прочие тревоги', defaultOn: false },
];

export function isPushKind(value: string): value is PushKind {
  return PUSH_KINDS.some((k) => k.kind === value);
}

/** Alert kind from the HUB (`alert.raised` → data.kind) → push kind. */
export function pushKindOfAlert(alertKind: string): PushKind {
  switch (alertKind) {
    case 'LIGHT_WITHOUT_GAME':
    case 'LAMP_DARK_DURING_GAME':
    case 'POWER_ON_BATTERY':
    case 'POWER_CRITICAL':
    case 'UPS_UNREACHABLE':
    case 'PREPAID_NOT_STARTED':
      return alertKind;
    case 'LAMP_ON_FAILED':
    case 'LAMP_OFF_FAILED':
      return 'LAMP_FAILED';
    default:
      return 'OTHER';
  }
}

// ---------------------------------------------------------------------------
// Devices and rules (cabinet API)
// ---------------------------------------------------------------------------

export type DevicePlatform = 'android' | 'ios' | 'web';

export interface RegisterDeviceRequest {
  /** FCM registration token. */
  token: string;
  platform: DevicePlatform;
  /** "Pixel 8", shown in the device list. */
  name?: string;
}

export interface DeviceView {
  id: string;
  platform: DevicePlatform;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** Last delivery error, null when the last push went through. */
  lastError: string | null;
}

/** One rule: a kind switched on or off, for all clubs (`clubId` null) or for one club. */
export interface PushRule {
  kind: PushKind;
  clubId: string | null;
  enabled: boolean;
}

export interface PushSettingsView {
  /** False when the cloud has no FCM key: rules are kept, nothing is sent. */
  pushEnabled: boolean;
  kinds: PushKindInfo[];
  /** Only the rules the owner set; everything else falls back to `defaultOn`. */
  rules: PushRule[];
  devices: DeviceView[];
}

export interface UpdatePushRulesRequest {
  /** Full list; rules missing here fall back to the defaults. */
  rules: PushRule[];
}

export interface TestPushResponse {
  pushEnabled: boolean;
  sent: number;
  failed: number;
}

/** What the phone gets in `data` of every push: enough to open the right screen. */
export interface PushData {
  kind: PushKind;
  clubId: string;
  alertId?: string;
}

// ---------------------------------------------------------------------------
// Sign-in by an owner key (phone)
// ---------------------------------------------------------------------------

export interface OwnerKeyView {
  id: string;
  /** "OWNER-7K3Q" */
  prefix: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreateOwnerKeyRequest {
  label?: string;
}

export interface CreateOwnerKeyResponse {
  /** Shown once; the cloud keeps only its hash. */
  key: string;
  view: OwnerKeyView;
  /** Text to encode in the QR: `loginQrText(cloudUrl, key)`. */
  qr: string;
}

export interface CloudKeyLoginRequest {
  key: string;
}

/**
 * Sign-in answer. `token` is present only for the app (request header
 * `x-ts-app: 1`): the app sends it as `Authorization: Bearer`, the browser
 * cabinet gets an HttpOnly cookie instead.
 */
export type CloudLoginResponse = OwnerView & { token?: string };

const QR_SCHEME = 'ts://login';

/** `ts://login?cloud=https%3A%2F%2Fcloud.example.kz&key=OWNER-…` */
export function loginQrText(cloudUrl: string, key: string): string {
  return `${QR_SCHEME}?cloud=${encodeURIComponent(cloudUrl)}&key=${encodeURIComponent(key)}`;
}

/** What a scanned QR (or pasted text) says: the key and, if present, the cloud address. */
export function parseLoginQr(text: string): { key: string; cloudUrl: string | null } | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith(QR_SCHEME)) {
    const query = raw.slice(QR_SCHEME.length).replace(/^\?/, '');
    const params = new URLSearchParams(query);
    const key = params.get('key')?.trim();
    if (!key) return null;
    const cloud = params.get('cloud')?.trim();
    return { key, cloudUrl: cloud ? normalizeCloudUrl(cloud) : null };
  }
  // A bare key: "OWNER-XXXX-…".
  if (/^[A-Za-z]{3,5}[-\s_]/.test(raw) && !raw.includes('://')) return { key: raw, cloudUrl: null };
  return null;
}

/** "cloud.example.kz/" → "https://cloud.example.kz"; null when it is not an http(s) address. */
export function normalizeCloudUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}
