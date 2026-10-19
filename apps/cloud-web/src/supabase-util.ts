/**
 * Pure helpers of the Supabase mode: error mapping, URLs, ntfy topics, VAPID key decoding.
 * No browser globals and no imports, so `node --test apps/cloud-web/test` runs them as is.
 */

/** What PostgREST / supabase-js report for a failed call. */
export interface PgErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
  /** Network failure or a gateway answering for a dead backend: the shell shows the offline banner. */
  offline: boolean;
  /** No session / expired JWT: the shell shows the login form. */
  unauthorized: boolean;
}

export const OFFLINE_MESSAGE = 'Нет связи с облаком';

const CODE_LIKE = /^[A-Z][A-Z0-9_]{2,}$/;

/** A PostgREST error (and its HTTP status, 0 when fetch itself failed) → the cabinet's error shape. */
export function mapRpcError(error: PgErrorLike, httpStatus: number): MappedError {
  const message = (error.message ?? '').trim();
  const pgCode = error.code ?? '';
  if (httpStatus === 0 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return { status: httpStatus, code: 'OFFLINE', message: OFFLINE_MESSAGE, offline: true, unauthorized: false };
  }
  if (pgCode === 'P0002') {
    const code = CODE_LIKE.test(message) ? message : 'CLUB_NOT_FOUND';
    return { status: 404, code, message: 'Клуб не найден', offline: false, unauthorized: false };
  }
  if (httpStatus === 401 || pgCode === 'PGRST301' || pgCode === 'PGRST302' || pgCode === 'PGRST303') {
    return { status: 401, code: 'UNAUTHORIZED', message: 'Нужно войти заново', offline: false, unauthorized: true };
  }
  if (pgCode === '42501' || httpStatus === 403) {
    return { status: 403, code: 'FORBIDDEN', message: 'Нет доступа', offline: false, unauthorized: false };
  }
  // RAISE EXCEPTION 'SOME_CODE' (P0001 or a custom 22xxx) — the message is the domain code.
  if (CODE_LIKE.test(message)) {
    return { status: httpStatus >= 400 ? httpStatus : 400, code: message, message, offline: false, unauthorized: false };
  }
  return {
    status: httpStatus >= 400 ? httpStatus : 500,
    code: 'HTTP_ERROR',
    message: message || `Облако ответило ошибкой ${httpStatus}`,
    offline: false,
    unauthorized: false,
  };
}

/** Auth errors (signInWithPassword / signInWithOtp) → text for the login form. */
export function describeAuthError(err: { status?: number; code?: string; message?: string; name?: string }): MappedError {
  const status = err.status ?? 0;
  const message = err.message ?? '';
  if (status === 0 || err.name === 'AuthRetryableFetchError' || /fetch/i.test(message)) {
    return { status: 0, code: 'OFFLINE', message: OFFLINE_MESSAGE, offline: true, unauthorized: false };
  }
  if (err.code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return { status: 401, code: 'INVALID_CREDENTIALS', message: 'Неверный e-mail или пароль', offline: false, unauthorized: false };
  }
  if (err.code === 'email_not_confirmed') {
    return { status: 401, code: 'EMAIL_NOT_CONFIRMED', message: 'Почта не подтверждена: откройте письмо от TS', offline: false, unauthorized: false };
  }
  if (err.code === 'over_email_send_rate_limit' || err.code === 'over_request_rate_limit' || status === 429) {
    return { status: 429, code: 'RATE_LIMIT', message: 'Слишком часто. Подождите минуту и попробуйте снова', offline: false, unauthorized: false };
  }
  if (err.code === 'otp_disabled' || err.code === 'signup_disabled' || err.code === 'user_not_found') {
    return { status: 403, code: 'NOT_OWNER', message: 'Эта почта не зарегистрирована как владелец', offline: false, unauthorized: false };
  }
  return { status, code: err.code || 'AUTH_ERROR', message: message || 'Не удалось войти', offline: false, unauthorized: false };
}

/** `https://<ref>.supabase.co` + `/owner/clubs/1/tariffs` → the `owner` Edge Function URL. */
export function edgeUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/owner${path.startsWith('/') ? path : `/${path}`}`;
}

/** Where a magic link returns: the cabinet's own page (respecting the base path), no query, no hash. */
export function magicLinkRedirect(base: string, href: string): string {
  const url = new URL(base || './', href);
  url.search = '';
  url.hash = '';
  return url.href;
}

/** `#error=access_denied&error_code=otp_expired&error_description=…` left by a failed magic link → text, or null. */
export function authErrorFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  if (!raw.includes('error')) return null;
  const params = new URLSearchParams(raw);
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (!code && !description && !params.get('error')) return null;
  if (code === 'otp_expired') return 'Ссылка для входа устарела или уже использована. Запросите новую.';
  return description ? `Не удалось войти по ссылке: ${description}` : 'Не удалось войти по ссылке';
}

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `ts-` + 24 base32 characters from 24 random bytes (5 bits of each): ~120 bits, unguessable. */
export function ntfyTopicName(random: Uint8Array): string {
  if (random.length < 24) throw new Error('need 24 random bytes');
  let s = 'ts-';
  for (let i = 0; i < 24; i++) s += BASE32[(random[i] ?? 0) & 31];
  return s;
}

/** "ntfy.example.kz/" → "https://ntfy.example.kz"; null when it is not an http(s) address. Empty → ntfy.sh. */
export function normalizeNtfyServer(input: string): string | null {
  let s = input.trim();
  if (!s) return DEFAULT_NTFY_SERVER;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function ntfyTopicUrl(server: string, topic: string): string {
  return `${server.replace(/\/+$/, '')}/${topic}`;
}

export interface NtfyLinks {
  server: string;
  host: string;
  topic: string;
  /** Opens the topic page; the ntfy web app and the Android app both handle it. */
  https: string;
  /** `ntfy://host/topic` — the Android app subscribes on tap (`?secure=false` for plain http servers). */
  deepLink: string;
}

/** Links for a topic URL `https://ntfy.sh/ts-…`; null when it is not one. */
export function ntfyLinks(topicUrl: string): NtfyLinks | null {
  let url: URL;
  try {
    url = new URL(topicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return null;
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  const server = `${url.protocol}//${url.host}${prefix}`;
  const secure = url.protocol === 'https:' ? '' : '?secure=false';
  return {
    server,
    host: url.host,
    topic,
    https: `${server}/${topic}`,
    deepLink: `ntfy://${url.host}${prefix}/${topic}${secure}`,
  };
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

/** VAPID public key (base64url, 65 bytes uncompressed P-256 point) → bytes for pushManager.subscribe. */
export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isVapidPublicKey(input: string | undefined): boolean {
  if (!input) return false;
  try {
    const bytes = base64UrlToBytes(input);
    return bytes.length === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}

/** iPhone/iPad Safari gets Web Push only from the home-screen app (iOS 16.4+). */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}
