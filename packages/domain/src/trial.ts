/**
 * The coffee shop's browser trial seen from the cloud. The trial runs the HUB inside the page
 * (apps/web, VITE_TRIAL=1) and keeps the data in the person's browser. After the welcome form it asks
 * the public Edge Function `trial` for a trial (POST /trial/start with the browser's random `installId`):
 * the cloud stores a request ('pending') and tells the platform owner; the page waits on GET /trial/terms
 * until TS approves it (14 days from the approval), rejects it or makes it permanent. Then it reports what
 * happens (POST /trial/report: counters, optionally a SQLite snapshot). The platform owner sees every trial
 * in the cabinet and approves, rejects, extends, sets the end date, ends, makes permanent or deletes it
 * (`platform` function, /platform/trials…). Pure types and rules shared by the cloud and both web apps.
 */
import { isBookingDay, localInstant, shiftDay } from './booking.ts';
import type { TrialCloudInfo, TrialCloudView } from './cloud-cafe.ts';
import type { TrialPaidView } from './trial-paid.ts';
import { isValidTimeZone } from './time.ts';

export interface TrialStats {
  ordersTotal: number;
  ordersToday: number;
  revenueTotal: number;
  revenueToday: number;
  productsCount: number;
  staffCount: number;
  shiftOpen: boolean;
  lastOrderAt: number | null;
  days: Array<{ day: string; orders: number; revenue: number }>;
  appVersion?: string;
}

/**
 * Stored: 'pending' (a request waiting for TS), 'active', 'ended' (ended early by TS), 'rejected' (a request
 * TS turned down), 'permanent' (no end date) and 'paid' (the café bought TS until a date: trial-paid.ts).
 * 'expired' is computed: active or paid, and endsAt has passed.
 * A pending or rejected trial has not started: the cash desk takes no orders (as when it is over).
 */
export type TrialStatus = 'pending' | 'active' | 'ended' | 'expired' | 'rejected' | 'permanent' | 'paid';

export const TRIAL_STATUSES: readonly TrialStatus[] = ['pending', 'active', 'ended', 'expired', 'rejected', 'permanent', 'paid'];

export function isTrialStatus(v: unknown): v is TrialStatus {
  return typeof v === 'string' && (TRIAL_STATUSES as readonly string[]).includes(v);
}

/**
 * The statuses a page from before requests knows (its live `isStatus`): anything else makes it drop the
 * answer as «unexpected» and try again later — /start included, without an installId. Such a page is
 * answered in these words only (legacyTrialTerms, TRIAL_RELOAD_ID).
 */
export const TRIAL_LEGACY_STATUSES: readonly TrialStatus[] = ['active', 'ended', 'expired'];

/** A request not decided yet, or turned down: the trial has not started. */
export function trialWaiting(status: TrialStatus | string | null | undefined): boolean {
  return status === 'pending' || status === 'rejected';
}

export interface TrialTerms {
  status: TrialStatus;
  /** The end; for 'permanent' and 'pending' it means nothing (the page ignores it). */
  endsAt: number;
  message?: string;
  /**
   * The café moved to the cloud cash desk (packages/domain/src/cloud-cafe.ts): its link, and once the director's
   * key of a request approved straight into the cloud. The status is then 'ended' (this browser takes no orders).
   */
  cloud?: TrialCloudInfo;
}

export interface TrialStartRequest {
  venue: string;
  managerName?: string;
  timezone?: string;
  /**
   * When the trial began in the browser (ms). Checked (a broken value is 422) but no longer counted from:
   * the 14 days run from the platform owner's approval.
   */
  startedAt?: number;
  /**
   * The browser's own random id of this trial (isTrialInstallId), made once and saved before the first
   * /start. A second /start with it returns the same trial (a lost answer, a retry) instead of a new one.
   * A page without it is a page from before requests: it gets TRIAL_RELOAD_ID and nothing is stored.
   */
  installId?: string;
  /** «Заполнить меню примером» on the welcome form: a request approved into the cloud gets the sample menu too. */
  withMenu?: boolean;
}

/** The start's answer: the trial's id and token plus its terms ('pending' for a new request). */
export interface TrialStartResponse extends TrialTerms {
  id: string;
  token: string;
  startedAt: number;
}

/**
 * The id /start gives a page that sends no installId (a cached page from before requests), with
 * TRIAL_RELOAD_TOKEN and terms 'ended' + TRIAL_RELOAD_MESSAGE, which that page understands: its counter
 * turns read-only and says to reload. No row is stored, so its later reports are 404 and never start a
 * trial; the current page, finding this id saved, drops it and sends a request with an installId.
 */
export const TRIAL_RELOAD_ID = '00000000-0000-0000-0000-000000000000';
export const TRIAL_RELOAD_TOKEN = 'reload';
export const TRIAL_RELOAD_MESSAGE = 'Обновите страницу TS (F5), чтобы отправить заявку на пробную версию.';

/**
 * The terms' version a current page asks for (`v=3` on /terms, `v: 3` in /report): every status, 'paid' included.
 * `v=2` pages get 'paid' as 'active'; older ones legacyTrialTerms (trialTermsForVersion, trial-paid.ts).
 */
export const TRIAL_TERMS_VERSION = 3;

/** What an old page is told for a permanent trial: «active» until this far date (its license then never runs out). */
export const TRIAL_PERMANENT_LEGACY_ENDS_AT = Date.UTC(2100, 0, 1);

/** The in-page license of a permanent trial lasts until this date: in practice, no end. */
export const TRIAL_PERMANENT_LICENSE_UNTIL = Date.UTC(2100, 0, 1);

/** POST /platform/trials/:id/reject: an optional message the coffee shop sees on its page. */
export interface TrialRejectRequest {
  message?: string;
}

/** The trial a request looks like a repeat of (same venue name, or same manager from the same address). */
export interface TrialDuplicate {
  id: string;
  venue: string;
  managerName: string;
  status: TrialStatus;
  /** When it started (or, while it is a request, when the request came). */
  startedAt: number;
}

/** POST /platform/trials/:id/end-date: the trial runs through this calendar day of its own time zone. */
export interface TrialEndDateRequest {
  /** YYYY-MM-DD, from today to today + TRIAL_EXTEND_MAX_DAYS in the trial's zone. */
  date: string;
}

export interface TrialReportRequest {
  id: string;
  /** TRIAL_TERMS_VERSION: the page reads every status in the answer (without it: legacyTrialTerms). */
  v?: number;
  stats: TrialStats;
  /** base64 of the trial's SQLite database, ≤ TRIAL_SNAPSHOT_MAX_BYTES decoded. */
  snapshot?: string;
}

export interface TrialView {
  id: string;
  venue: string;
  managerName: string;
  /** The IANA zone its days are counted in (the browser's, else TRIAL_DEFAULT_TIMEZONE). */
  timezone: string;
  startedAt: number;
  endsAt: number;
  status: TrialStatus;
  lastSeenAt: number | null;
  stats: TrialStats | null;
  snapshotAt: number | null;
  snapshotBytes: number | null;
  /** When the request came; null for a trial from before requests (it started at once). */
  requestedAt: number | null;
  /** When TS approved, rejected or made it permanent; null before that. */
  decidedAt: number | null;
  /** The platform owner's words to the coffee shop when rejecting (shown on its page). */
  ownerMessage: string | null;
  /** An earlier trial this one looks like a repeat of (trialDuplicates), or null. */
  duplicateOf: TrialDuplicate | null;
  /** Its café in the cloud cash desk (moved there, or approved straight into it); null while it is a browser trial. */
  cloud: TrialCloudView | null;
  /** «Купили»: paid until a date, with the internal amount, note and history (trial-paid.ts); null when it never bought. */
  paid: TrialPaidView | null;
}

export const TRIAL_DEFAULT_DAYS = 14;
/** The platform extends a trial by 1..90 days at a time, or sets its end up to 90 days ahead. */
export const TRIAL_EXTEND_MAX_DAYS = 90;
/** A start may say the trial began at most this many days ago (older is clamped). */
export const TRIAL_BACKDATE_MAX_DAYS = 60;
/** The zone of a trial whose browser did not name a valid one: the coffee shops are in Kazakhstan. */
export const TRIAL_DEFAULT_TIMEZONE = 'Asia/Almaty';
export const TRIAL_VENUE_MAX = 80;
export const TRIAL_NAME_MAX = 80;
export const TRIAL_TIMEZONE_MAX = 64;
/** The platform owner's message on a rejected request. */
export const TRIAL_MESSAGE_MAX = 300;
/** A snapshot (decoded SQLite bytes) may be this big at most. */
export const TRIAL_SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;
/** Days of history a report may carry. */
export const TRIAL_STATS_MAX_DAYS = 400;
/** Rate limits of the public `trial` function. */
export const TRIAL_RATE = { startsPerIpHour: 10, reportsPerTrialHour: 120 } as const;

export const TRIAL_ENDED_MESSAGE = 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.';
export const TRIAL_EXPIRED_MESSAGE = 'Срок пробного периода истёк. Свяжитесь с TS, чтобы продолжить.';

/** An old page whose trial is still a request (it cannot wait for one): read-only, and reload. */
export const TRIAL_PENDING_LEGACY_MESSAGE = 'Заявка на пробную версию ждёт подтверждения TS. Обновите страницу (F5).';
/** An old page whose request was turned down without a message. */
export const TRIAL_REJECTED_MESSAGE = 'TS отклонил заявку на пробную версию. Если это ошибка — напишите TS.';
/** The page's request is gone from the cloud (the platform owner deleted it). */
export const TRIAL_DELETED_MESSAGE = 'Заявка удалена в TS. Если это ошибка — напишите TS.';

/** The status a trial has now: a stored 'active' or 'paid' whose endsAt has come is 'expired'; the others stay as stored. */
export function trialStatus(row: { status: TrialStatus | string; endsAt: number }, now: number): TrialStatus {
  switch (row.status) {
    case 'pending':
    case 'ended':
    case 'expired':
    case 'rejected':
    case 'permanent':
      return row.status;
    case 'paid':
      return row.endsAt <= now ? 'expired' : 'paid';
    default:
      return row.endsAt <= now ? 'expired' : 'active';
  }
}

/** What a café that bought TS («Купили», trial-paid.ts) sees the day after its paid date. */
export const TRIAL_PAID_ENDED_MESSAGE = 'Оплаченный срок закончился — свяжитесь с TS.';

/**
 * What the trial is told: its status, the end and (when it is over) why. A rejected request carries the
 * platform owner's message when there is one (the page has its own words otherwise).
 */
export function trialTerms(row: { status: TrialStatus | string; endsAt: number; ownerMessage?: string | null }, now: number): TrialTerms {
  const status = trialStatus(row, now);
  if (status === 'ended') return { status, endsAt: row.endsAt, message: TRIAL_ENDED_MESSAGE };
  if (status === 'expired') return { status, endsAt: row.endsAt, message: row.status === 'paid' ? TRIAL_PAID_ENDED_MESSAGE : TRIAL_EXPIRED_MESSAGE };
  const message = row.ownerMessage?.trim();
  if (status === 'rejected' && message) return { status, endsAt: row.endsAt, message };
  return { status, endsAt: row.endsAt };
}

/**
 * The terms in the words of a page from before requests (TRIAL_LEGACY_STATUSES only): permanent is
 * «active» until TRIAL_PERMANENT_LEGACY_ENDS_AT; a request (pending or rejected) is «ended» now, with why.
 */
export function legacyTrialTerms(terms: TrialTerms, now: number): TrialTerms {
  switch (terms.status) {
    case 'permanent':
      return { status: 'active', endsAt: TRIAL_PERMANENT_LEGACY_ENDS_AT };
    case 'paid':
      return { status: 'active', endsAt: terms.endsAt };
    case 'pending':
      return { status: 'ended', endsAt: now, message: TRIAL_PENDING_LEGACY_MESSAGE };
    case 'rejected':
      return { status: 'ended', endsAt: now, message: terms.message ?? TRIAL_REJECTED_MESSAGE };
    default:
      return terms;
  }
}

/**
 * The terms in an answer of the cloud as the current page reads them (every TrialStatus); null when the
 * body is not terms (the page then tries again later).
 */
export function parseTrialTerms(body: unknown): TrialTerms | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (!isTrialStatus(o.status) || typeof o.endsAt !== 'number' || !Number.isFinite(o.endsAt)) return null;
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  return { status: o.status, endsAt: o.endsAt, ...(message ? { message } : {}) };
}

/** A browser's installId: 16–64 characters of base64url (the page makes 32 from 24 random bytes). */
export function isTrialInstallId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

/** The platform owner's message on a rejection: trimmed, empty → null; undefined when too long or not text. */
export function trialRejectMessage(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s.length > TRIAL_MESSAGE_MAX) return undefined;
  return s || null;
}

/** «Coffee Book » and «coffee  book» are the same venue: names compared without case and extra spaces. */
export function trialNameKey(name: string): string {
  return name.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}

export interface TrialDuplicateRow {
  id: string;
  venue: string;
  managerName: string;
  /** The address it was requested from (never shown, only compared). */
  ip: string | null;
  status: TrialStatus;
  startedAt: number;
  /** When it came to the cloud: the request, else the start. */
  createdAt: number;
}

/**
 * «Похоже на повтор»: for each trial, the earliest trial that came before it with the same venue name
 * (trialNameKey), or with the same manager name from the same address. One coffee shop that opened the
 * page in three browsers shows up as one trial and two repeats of it. Keyed by id; absent when none.
 */
export function trialDuplicates(rows: readonly TrialDuplicateRow[]): Map<string, TrialDuplicate> {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const out = new Map<string, TrialDuplicate>();
  sorted.forEach((row, i) => {
    const venue = trialNameKey(row.venue);
    const manager = trialNameKey(row.managerName);
    for (let j = 0; j < i; j++) {
      const earlier = sorted[j]!;
      const sameVenue = venue !== '' && trialNameKey(earlier.venue) === venue;
      const sameManager = manager !== '' && !!row.ip && earlier.ip === row.ip && trialNameKey(earlier.managerName) === manager;
      if (sameVenue || sameManager) {
        out.set(row.id, { id: earlier.id, venue: earlier.venue, managerName: earlier.managerName, status: earlier.status, startedAt: earlier.startedAt });
        break;
      }
    }
  });
  return out;
}

/** Zones a coffee shop's browser names, as the city people call it (the first city of that zone). */
const ZONE_CITY: Readonly<Record<string, string>> = {
  'Asia/Almaty': 'Алматы',
  'Asia/Qostanay': 'Костанай',
  'Asia/Aqtobe': 'Актобе',
  'Asia/Aqtau': 'Актау',
  'Asia/Atyrau': 'Атырау',
  'Asia/Oral': 'Уральск',
  'Asia/Qyzylorda': 'Кызылорда',
  'Asia/Bishkek': 'Бишкек',
  'Asia/Tashkent': 'Ташкент',
  'Asia/Samarkand': 'Самарканд',
  'Europe/Moscow': 'Москва',
  'Asia/Yekaterinburg': 'Екатеринбург',
  'Asia/Omsk': 'Омск',
  'Asia/Novosibirsk': 'Новосибирск',
};

/** «Алматы» for Asia/Almaty; null for a zone the list does not know (or none). */
export function trialZoneCity(timezone: string | null | undefined): string | null {
  return (timezone && ZONE_CITY[timezone]) || null;
}

/** «coffee book» · Аиша · Алматы — a request in one line (the notification, the cabinet). */
export function trialRequestLine(t: { venue: string; managerName: string; timezone: string | null }): string {
  return [`«${t.venue}»`, t.managerName.trim(), trialZoneCity(t.timezone) ?? ''].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// The page's side (apps/web demo-hub): pure rules, so they are tested here.

/** What the page keeps about its trial's terms (apps/web trial-store.ts TrialInfo). */
export interface TrialPageTerms {
  startedAt: number;
  endsAt?: number;
  status?: TrialStatus;
}

/** A waiting page asks for its terms this often while it is on screen (and at once when it comes back)… */
export const TRIAL_PENDING_CHECK_MS = 30_000;
/** …and this often when hidden, or when rejected (TS may still approve it after all). */
export const TRIAL_IDLE_CHECK_MS = 5 * 60_000;

/** How long after the last call the page calls the cloud again: a request faster while visible, a trial as reported. */
export function trialCheckEveryMs(status: TrialStatus | undefined, visible: boolean, reportEveryMs: number): number {
  if (status === 'pending') return visible ? TRIAL_PENDING_CHECK_MS : TRIAL_IDLE_CHECK_MS;
  if (status === 'rejected') return TRIAL_IDLE_CHECK_MS;
  return reportEveryMs;
}

/** The trial is over on this page: the cloud ended it, or its end has passed (never a permanent one or a request). */
export function trialPageOver(info: TrialPageTerms, now: number, days = TRIAL_DEFAULT_DAYS): boolean {
  if (info.status === 'ended' || info.status === 'expired') return true;
  if (info.status === 'permanent' || trialWaiting(info.status)) return false;
  return (info.endsAt ?? info.startedAt + days * DAY_MS) <= now;
}

/**
 * The in-page HUB's license for these terms: a permanent trial has no end (TRIAL_PERMANENT_LICENSE_UNTIL,
 * plan «paid»); a request (pending, rejected) and a trial that is over are valid only until now, so the cash
 * desk is read-only; otherwise until its end (startedAt + days before the cloud answered).
 */
export function trialPageLicense(info: TrialPageTerms, now: number, days = TRIAL_DEFAULT_DAYS): { validUntil: number; permanent: boolean } {
  if (info.status === 'permanent') return { validUntil: TRIAL_PERMANENT_LICENSE_UNTIL, permanent: true };
  const end = info.endsAt ?? info.startedAt + days * DAY_MS;
  // «Купили»: the full version until the end of the paid day (then read-only by itself).
  if (info.status === 'paid') return { validUntil: end, permanent: true };
  const locked = trialWaiting(info.status) || info.status === 'ended' || info.status === 'expired';
  return { validUntil: locked ? Math.min(end, now) : end, permanent: false };
}

/**
 * A record that holds TRIAL_RELOAD_ID (an old cached page got it from /start) is not linked to the cloud:
 * the link and the «reload» terms go, and it becomes a request again. Any other record comes back as is.
 */
export function trialWithoutReloadLink<T extends TrialPageTerms & { cloudId?: string; cloudToken?: string; message?: string | null }>(info: T): T {
  if (info.cloudId !== TRIAL_RELOAD_ID) return info;
  const { cloudId: _id, cloudToken: _token, endsAt: _endsAt, message: _message, ...rest } = info;
  return { ...rest, status: 'pending' } as T;
}

/**
 * The cloud no longer knows this trial (404 TRIAL_NOT_FOUND: the platform owner deleted it). A request that
 * was waiting shows «Заявка удалена» and stops asking; a trial that ran stays as it is (read-only once over).
 */
export function trialGoneTerms(info: TrialPageTerms, now: number): TrialTerms | null {
  return info.status === 'pending' ? { status: 'rejected', endsAt: info.endsAt ?? now, message: TRIAL_DELETED_MESSAGE } : null;
}

const DAY_MS = 86_400_000;

/**
 * When a trial began, as the cloud records it: the browser's `startedAt` clamped to
 * [now − TRIAL_BACKDATE_MAX_DAYS, now] (never in the future); `now` when the client sent none
 * (an old page). null when it is not a time in ms.
 */
export function trialStartedAt(startedAt: unknown, now: number): number | null {
  if (startedAt === undefined || startedAt === null) return now;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) return null;
  return Math.min(now, Math.max(now - TRIAL_BACKDATE_MAX_DAYS * DAY_MS, Math.floor(startedAt)));
}

/** The zone a trial's days are counted in: its own when it is a valid IANA zone, else Almaty. */
export function trialTimeZone(timezone: string | null | undefined): string {
  return timezone && isValidTimeZone(timezone) ? timezone : TRIAL_DEFAULT_TIMEZONE;
}

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD: the calendar day of an instant in the zone. */
export function trialCalendarDay(at: number, timeZone: string): string {
  let f = calendarFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    calendarFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The last millisecond of calendar day `day` in the zone: a trial set to end that day runs through all of it. */
export function trialDayEnd(day: string, timeZone: string): number {
  return localInstant(shiftDay(day, 1), 0, timeZone) - 1;
}

/** The days an end date may be set to: today … today + TRIAL_EXTEND_MAX_DAYS, in the trial's zone. */
export function trialEndDateRange(now: number, timeZone: string): { min: string; max: string } {
  const today = trialCalendarDay(now, timeZone);
  return { min: today, max: shiftDay(today, TRIAL_EXTEND_MAX_DAYS) };
}

/** `date` as a valid end day for a trial in `timeZone` (YYYY-MM-DD within trialEndDateRange), else null. */
export function trialEndDate(date: unknown, now: number, timeZone: string): string | null {
  if (!isBookingDay(date)) return null;
  const { min, max } = trialEndDateRange(now, timeZone);
  return date >= min && date <= max ? date : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isAmount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Problems of a reported TrialStats; empty when it is fine. */
export function validateTrialStats(x: unknown): string[] {
  if (!isObject(x)) return ['stats: нужен объект'];
  const problems: string[] = [];
  for (const key of ['ordersTotal', 'ordersToday', 'productsCount', 'staffCount'] as const) {
    if (!isCount(x[key])) problems.push(`stats.${key}: целое число ≥ 0`);
  }
  for (const key of ['revenueTotal', 'revenueToday'] as const) {
    if (!isAmount(x[key])) problems.push(`stats.${key}: число`);
  }
  if (typeof x.shiftOpen !== 'boolean') problems.push('stats.shiftOpen: да или нет');
  if (x.lastOrderAt !== null && !(typeof x.lastOrderAt === 'number' && Number.isFinite(x.lastOrderAt) && x.lastOrderAt >= 0)) {
    problems.push('stats.lastOrderAt: время в мс или null');
  }
  if (!Array.isArray(x.days)) {
    problems.push('stats.days: нужен список');
  } else if (x.days.length > TRIAL_STATS_MAX_DAYS) {
    problems.push(`stats.days: не больше ${TRIAL_STATS_MAX_DAYS} дней`);
  } else {
    x.days.forEach((d: unknown, i: number) => {
      if (!isObject(d)) {
        problems.push(`stats.days[${i}]: нужен объект`);
        return;
      }
      if (typeof d.day !== 'string' || !DAY_RE.test(d.day)) problems.push(`stats.days[${i}].day: дата YYYY-MM-DD`);
      if (!isCount(d.orders)) problems.push(`stats.days[${i}].orders: целое число ≥ 0`);
      if (!isAmount(d.revenue)) problems.push(`stats.days[${i}].revenue: число`);
    });
  }
  if (x.appVersion !== undefined && !(typeof x.appVersion === 'string' && x.appVersion.length <= 40)) {
    problems.push('stats.appVersion: строка до 40 символов');
  }
  return problems;
}

/** Only the known fields of a valid TrialStats (anything extra a client sends is dropped). */
export function cleanTrialStats(x: TrialStats): TrialStats {
  return {
    ordersTotal: x.ordersTotal,
    ordersToday: x.ordersToday,
    revenueTotal: x.revenueTotal,
    revenueToday: x.revenueToday,
    productsCount: x.productsCount,
    staffCount: x.staffCount,
    shiftOpen: x.shiftOpen,
    lastOrderAt: x.lastOrderAt,
    days: x.days.map((d) => ({ day: d.day, orders: d.orders, revenue: d.revenue })),
    ...(x.appVersion !== undefined ? { appVersion: x.appVersion } : {}),
  };
}
