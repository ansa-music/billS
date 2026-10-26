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
  | GuardAlertKind
  /** «Онлайн-бронь столов»: a guest booked a table on the public page (raised by the cloud). */
  | 'BOOKING_NEW'
  | 'OTHER';

export interface PushKindInfo {
  kind: PushKind;
  label: string;
  /** Sent unless the owner switched it off. */
  defaultOn: boolean;
  /** Raised by «Сторож» (suspicious operations at the till): the cabinet marks these. */
  guard?: true;
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
  { kind: 'REFUND_SUSPICIOUS', label: 'Крупный или поздний возврат', defaultOn: true, guard: true },
  { kind: 'CANCELS_ABOVE_NORMAL', label: 'Много отмен за смену', defaultOn: true, guard: true },
  { kind: 'CASH_DISCREPANCY', label: 'Расхождение кассы при закрытии смены', defaultOn: true, guard: true },
  { kind: 'MANUAL_MODE_LONG', label: 'Ручной режим ламп включён давно', defaultOn: true, guard: true },
  { kind: 'DISCOUNTS_ABOVE_NORMAL', label: 'Большая скидка или много скидок', defaultOn: true, guard: true },
  { kind: 'TABLE_REOPENED_QUICKLY', label: 'Стол закрыли и сразу открыли снова', defaultOn: true, guard: true },
  { kind: 'BOOKING_NEW', label: 'Новая онлайн-бронь', defaultOn: true },
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
    case 'REFUND_SUSPICIOUS':
    case 'CANCELS_ABOVE_NORMAL':
    case 'CASH_DISCREPANCY':
    case 'MANUAL_MODE_LONG':
    case 'DISCOUNTS_ABOVE_NORMAL':
    case 'TABLE_REOPENED_QUICKLY':
      return alertKind;
    case 'LAMP_ON_FAILED':
    case 'LAMP_OFF_FAILED':
      return 'LAMP_FAILED';
    default:
      return 'OTHER';
  }
}

// ---------------------------------------------------------------------------
// «Сторож»: rules on the HUB about suspicious operations and lost money
// ---------------------------------------------------------------------------

/**
 * Alert kinds raised by «Сторож» (apps/hub/src/guard.ts). They are counted offline on the
 * HUB and reach the owner through the outbox → cloud → push / Telegram like any alert.
 * Texts never accuse and never name a person: «проверьте», «возможно, ошибка при вводе».
 */
export type GuardAlertKind =
  | 'REFUND_SUSPICIOUS'
  | 'CANCELS_ABOVE_NORMAL'
  | 'CASH_DISCREPANCY'
  | 'MANUAL_MODE_LONG'
  | 'DISCOUNTS_ABOVE_NORMAL'
  | 'TABLE_REOPENED_QUICKLY';

export const GUARD_ALERT_KINDS: readonly GuardAlertKind[] = [
  'REFUND_SUSPICIOUS',
  'CANCELS_ABOVE_NORMAL',
  'CASH_DISCREPANCY',
  'MANUAL_MODE_LONG',
  'DISCOUNTS_ABOVE_NORMAL',
  'TABLE_REOPENED_QUICKLY',
];

export function isGuardAlertKind(value: string): value is GuardAlertKind {
  return (GUARD_ALERT_KINDS as readonly string[]).includes(value);
}

/** Club thresholds of «Сторож» (manager-only, «Настройки» → «Сторож»). Money in minor units. */
export interface GuardSettings {
  /** Refund after payment: at least `minAmount`, or at least `minPercent` % of what was paid, or `lateMinutes` after the payment. */
  refund: { enabled: boolean; minAmount: number; minPercent: number; lateMinutes: number };
  /** Cancelled orders and games by one employee in a shift: at least `minCount` and at least `minPercent` % of their orders. */
  cancels: { enabled: boolean; minCount: number; minPercent: number };
  /** Cash counted at shift close differs from the expected by at least `minDifference`. */
  cash: { enabled: boolean; minDifference: number };
  /** Emergency manual lamp mode stays on longer than `minutes` (lamps are not checked meanwhile). */
  manualMode: { enabled: boolean; minutes: number };
  /** A manual discount of at least `maxPercent` % of the check, or `perShift` manual discounts by one person in a shift. */
  discounts: { enabled: boolean; maxPercent: number; perShift: number };
  /** A table stopped and opened again within `minutes` (billiards): time may have been reset. */
  reopen: { enabled: boolean; minutes: number };
}

export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  refund: { enabled: true, minAmount: 5_000_00, minPercent: 30, lateMinutes: 30 },
  cancels: { enabled: true, minCount: 3, minPercent: 10 },
  cash: { enabled: true, minDifference: 1_000_00 },
  manualMode: { enabled: true, minutes: 15 },
  discounts: { enabled: true, maxPercent: 30, perShift: 3 },
  reopen: { enabled: true, minutes: 2 },
};

/** Allowed ranges of the numbers (the HUB rejects anything outside, the form shows them). */
export const GUARD_LIMITS = {
  minAmount: [0, 100_000_000_00],
  percent: [1, 100],
  lateMinutes: [1, 24 * 60],
  minCount: [1, 100],
  minDifference: [0, 100_000_000_00],
  manualMinutes: [1, 24 * 60],
  perShift: [1, 100],
  reopenMinutes: [1, 60],
} as const satisfies Record<string, readonly [number, number]>;

const intIn = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** Fills gaps and drops bad values with the defaults (stored JSON may be old or hand-edited). */
export function normalizeGuardSettings(raw: unknown, base: GuardSettings = DEFAULT_GUARD_SETTINGS): GuardSettings {
  const r = obj(raw);
  const refund = obj(r.refund);
  const cancels = obj(r.cancels);
  const cash = obj(r.cash);
  const manual = obj(r.manualMode);
  const discounts = obj(r.discounts);
  const reopen = obj(r.reopen);
  const L = GUARD_LIMITS;
  return {
    refund: {
      enabled: bool(refund.enabled, base.refund.enabled),
      minAmount: intIn(refund.minAmount, L.minAmount, base.refund.minAmount),
      minPercent: intIn(refund.minPercent, L.percent, base.refund.minPercent),
      lateMinutes: intIn(refund.lateMinutes, L.lateMinutes, base.refund.lateMinutes),
    },
    cancels: {
      enabled: bool(cancels.enabled, base.cancels.enabled),
      minCount: intIn(cancels.minCount, L.minCount, base.cancels.minCount),
      minPercent: intIn(cancels.minPercent, L.percent, base.cancels.minPercent),
    },
    cash: {
      enabled: bool(cash.enabled, base.cash.enabled),
      minDifference: intIn(cash.minDifference, L.minDifference, base.cash.minDifference),
    },
    manualMode: {
      enabled: bool(manual.enabled, base.manualMode.enabled),
      minutes: intIn(manual.minutes, L.manualMinutes, base.manualMode.minutes),
    },
    discounts: {
      enabled: bool(discounts.enabled, base.discounts.enabled),
      maxPercent: intIn(discounts.maxPercent, L.percent, base.discounts.maxPercent),
      perShift: intIn(discounts.perShift, L.perShift, base.discounts.perShift),
    },
    reopen: {
      enabled: bool(reopen.enabled, base.reopen.enabled),
      minutes: intIn(reopen.minutes, L.reopenMinutes, base.reopen.minutes),
    },
  };
}

/** Deep partial for PUT /api/guard/settings. */
export type GuardSettingsPatch = { [K in keyof GuardSettings]?: Partial<GuardSettings[K]> };

/** Why a refund looks unusual; empty when it does not. `paid` = money taken on the check, `paidAt` = last payment. */
export function refundReasons(
  s: GuardSettings['refund'],
  refund: { amount: number; paid: number; paidAt: number | null; at: number },
): Array<'amount' | 'share' | 'late'> {
  if (!s.enabled || refund.amount <= 0) return [];
  const out: Array<'amount' | 'share' | 'late'> = [];
  if (refund.amount >= s.minAmount) out.push('amount');
  if (refund.paid > 0 && refund.amount * 100 >= s.minPercent * refund.paid) out.push('share');
  if (refund.paidAt !== null && refund.at - refund.paidAt > s.lateMinutes * 60_000) out.push('late');
  return out;
}

/** Cancellations by one person in a shift are above normal: both the count and the share of their own orders. */
export function cancelsAboveNormal(s: GuardSettings['cancels'], c: { cancelled: number; created: number }): boolean {
  if (!s.enabled || c.cancelled < s.minCount) return false;
  return c.cancelled * 100 >= s.minPercent * Math.max(c.created, c.cancelled);
}

/** Cash discrepancy at shift close is at or above the threshold (shortage or surplus). */
export function cashDiscrepancyAlert(s: GuardSettings['cash'], difference: number | null): boolean {
  return s.enabled && difference !== null && difference !== 0 && Math.abs(difference) >= s.minDifference;
}

/** A manual discount is large: its amount is at least `maxPercent` % of the check before the discount. */
export function discountTooLarge(s: GuardSettings['discounts'], d: { amount: number; subtotal: number }): boolean {
  if (!s.enabled || d.amount <= 0 || d.subtotal <= 0) return false;
  return d.amount * 100 >= s.maxPercent * d.subtotal;
}

// ---------------------------------------------------------------------------
// Devices and rules (cabinet API)
// ---------------------------------------------------------------------------

/**
 * How a device gets pushes:
 * - `webpush`: Web Push with VAPID (cabinet PWA); token = JSON of the browser's PushSubscription;
 * - `ntfy`: ntfy topic (the phone app, no Google services); token = topic URL `https://ntfy.sh/ts-…`;
 * - `android` / `ios` / `web`: legacy FCM tokens. FCM is gone, nothing is sent to them; the values
 *   stay valid because databases still hold such rows (the cabinet shows them with an error).
 */
export type DevicePlatform = 'android' | 'ios' | 'web' | 'webpush' | 'ntfy';

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['android', 'ios', 'web', 'webpush', 'ntfy'];

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && (DEVICE_PLATFORMS as readonly string[]).includes(value);
}

/** What a `webpush` device token holds: `JSON.stringify(pushSubscription)` (only these fields are used). */
export interface WebPushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Parses a `webpush` token; null when it is not a usable https subscription. */
export function parseWebPushToken(token: string): WebPushSubscriptionJson | null {
  let raw: unknown;
  try {
    raw = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (typeof r.endpoint !== 'string' || !/^https:\/\/[^\s/]+\//.test(r.endpoint)) return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth) return null;
  return { endpoint: r.endpoint, keys: { p256dh, auth } };
}

/** An ntfy topic URL: https, no credentials/query, one path segment of 24-64 safe chars (topics are public: the name is the secret). */
export function isNtfyTopicUrl(token: string): boolean {
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
  return /^\/[A-Za-z0-9_-]{24,64}$/.test(url.pathname);
}

/** Deep link to a club page of the cabinet (hash routing): `https://cabinet.example/#/clubs/<id>`. */
export function cabinetClubUrl(cabinetUrl: string, clubId: string): string {
  return `${cabinetUrl.replace(/\/+$/, '')}/#/clubs/${encodeURIComponent(clubId)}`;
}

/** JSON a Web Push message carries to the cabinet's service worker. */
export interface WebPushPayload {
  title: string;
  body: string;
  data: PushData & { url?: string };
}

export interface RegisterDeviceRequest {
  /** PushSubscription JSON (`webpush`) or ntfy topic URL (`ntfy`); a legacy FCM token for the old platforms. */
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
  /** False when the cloud has no push channel configured: rules are kept, nothing is sent. */
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
// «TS в Telegram»: alerts and the evening summary in a Telegram chat (Supabase cloud)
// ---------------------------------------------------------------------------

/** A Telegram chat linked to the owner. */
export interface TelegramChatView {
  /** Telegram chat id as text (group ids do not fit in 32 bits). */
  chatId: string;
  /** "@username", the group title or the person's first name. */
  name: string;
  linkedAt: number;
  /** Paused from the chat with /mute: nothing is sent until /unmute. */
  muted: boolean;
}

/** GET /owner/telegram. */
export interface TelegramStatusView {
  /** False when the cloud has no bot (TELEGRAM_BOT_TOKEN missing): the cabinet hides the button. */
  configured: boolean;
  /** Bot username without "@", null when unknown. */
  botUsername: string | null;
  chats: TelegramChatView[];
}

/** POST /owner/telegram/link: open `url` on the phone, Telegram sends `/start <code>` to the bot. */
export interface TelegramLinkResponse {
  url: string;
  expiresAt: number;
}

/** How long a link code from the cabinet works. */
export const TELEGRAM_LINK_TTL_MS = 15 * 60_000;

/** Telegram allows 1–64 characters A–Z a–z 0–9 _ - in a start parameter. */
export function isTelegramStartCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(code);
}

/** "@TS_bot" / "TS_bot" → "TS_bot"; null when it is not a valid bot username. */
export function normalizeBotUsername(input: string | null | undefined): string | null {
  const name = (input ?? '').trim().replace(/^@/, '').replace(/^https:\/\/t\.me\//, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? name : null;
}

/** Deep link that opens the bot and sends `/start <code>`: `https://t.me/<bot>?start=<code>`. */
export function telegramStartLink(botUsername: string, code: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`;
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

/** Whether a push of `kind` about `clubId` goes out: a club rule beats an all-clubs rule, which beats the default. */
export function pushRuleAllows(rules: ReadonlyArray<PushRule>, kind: PushKind, clubId: string): boolean {
  const forClub = rules.find((r) => r.kind === kind && r.clubId === clubId);
  if (forClub) return forClub.enabled;
  const forAll = rules.find((r) => r.kind === kind && r.clubId === null);
  if (forAll) return forAll.enabled;
  return PUSH_KINDS.find((k) => k.kind === kind)?.defaultOn ?? false;
}
