/**
 * The coffee shop's browser trial seen from the cloud. The trial runs the HUB inside the page
 * (apps/web, VITE_TRIAL=1) and keeps the data in the person's browser; it registers itself with
 * the public Edge Function `trial` (POST /trial/start), then reports what happens (POST /trial/report:
 * counters, optionally a SQLite snapshot) and asks for its terms (GET /trial/terms). The platform
 * owner sees every trial in the cabinet and extends or ends it early (`platform` function,
 * /platform/trials…). Pure types and rules shared by the cloud and both web apps.
 */

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

/** 'active' / 'ended' are stored; 'expired' is computed (active and endsAt has passed). */
export type TrialStatus = 'active' | 'ended' | 'expired';

/**
 * 'trial': the two-week trial (extended by the platform now and then).
 * 'paid': «Постоянная версия» — the coffee shop keeps working in the browser, paid until
 * `paidUntil` or without an end (paidUntil null). The cloud keeps endsAt = paidUntil (or
 * PAID_FOREVER_AT), so every client, old builds included, sees the right end.
 */
export type TrialPlan = 'trial' | 'paid';

export interface TrialTerms {
  status: TrialStatus;
  endsAt: number;
  message?: string;
  /** Absent in answers of an older cloud: read as 'trial'. */
  plan?: TrialPlan;
  /** plan 'paid': the end of the paid period, null = without an end. */
  paidUntil?: number | null;
  /** When the cloud got the last backup copy of this coffee shop (null: none yet). */
  snapshotAt?: number | null;
}

/** «Смотреть с телефона»: what the coffee shop's owner sees on the phone (POST /trial/report → GET /trial/view). */
export interface TrialSummary {
  /** When the cash register counted it (ms). */
  at: number;
  currency: string;
  timezone: string;
  /** Local calendar day of the coffee shop, YYYY-MM-DD. */
  date: string;
  revenueToday: number;
  revenue7: number;
  revenue30: number;
  checksToday: number;
  avgCheckToday: number;
  /** Best sellers today by quantity, at most TRIAL_SUMMARY_TOP. */
  topToday: Array<{ name: string; qty: number; revenue: number }>;
  /** Payments minus refunds today by method. */
  methodsToday: { cash: number; card: number; qr: number };
  shiftOpen: boolean;
  /** The last order or payment (ms), null when there were none. */
  lastActivityAt: number | null;
  /** Revenue of the last 7 days, oldest first (the last one is today). */
  days: Array<{ day: string; revenue: number }>;
}

/** GET /trial/view (Bearer: the view token) — the public read-only page of the cabinet, #/v/<token>. */
export interface TrialPublicView {
  venue: string;
  summary: TrialSummary | null;
  summaryAt: number | null;
  /** The last time the cash register talked to the cloud. */
  lastSeenAt: number | null;
  plan: TrialPlan;
  status: TrialStatus;
}

/** POST /trial/transfer-code (Bearer) → a short code another device opens the coffee shop with. */
export interface TrialTransferCode {
  /** «7K3M-Q9TX». */
  code: string;
  expiresAt: number;
}

/** POST /trial/transfer {code} → everything a new device needs; the old token stops working. */
export interface TrialTransferResponse {
  id: string;
  token: string;
  venue: string;
  managerName: string;
  startedAt: number;
  terms: TrialTerms;
  /** base64 of the last copy (gzip when snapshotEncoding is 'gzip'). */
  snapshot: string;
  snapshotEncoding: TrialSnapshotEncoding;
  snapshotAt: number;
}

/** POST /trial/view-link (Bearer) {id, off?} → a new view token (the old one stops working), or null when switched off. */
export interface TrialViewLink {
  token: string | null;
}

export type TrialSnapshotEncoding = 'raw' | 'gzip';

export interface TrialStartRequest {
  venue: string;
  managerName?: string;
  timezone?: string;
}

export interface TrialStartResponse {
  id: string;
  token: string;
  startedAt: number;
  endsAt: number;
  status: TrialStatus;
}

export interface TrialReportRequest {
  id: string;
  stats: TrialStats;
  /** base64 of the trial's SQLite database (gzip-compressed when snapshotEncoding is 'gzip'), ≤ TRIAL_SNAPSHOT_MAX_BYTES decoded. */
  snapshot?: string;
  snapshotEncoding?: TrialSnapshotEncoding;
  /** «Смотреть с телефона»: the owner's summary, kept by the cloud (the latest one). */
  summary?: TrialSummary;
}

export interface TrialView {
  id: string;
  venue: string;
  managerName: string;
  startedAt: number;
  endsAt: number;
  status: TrialStatus;
  lastSeenAt: number | null;
  stats: TrialStats | null;
  snapshotAt: number | null;
  snapshotBytes: number | null;
  plan: TrialPlan;
  paidUntil: number | null;
  /** When the owner's summary last came; whether the phone link is switched on. */
  summaryAt: number | null;
  viewLink: boolean;
}

/** POST /platform/trials/:id/plan */
export type TrialPlanRequest = { plan: 'paid'; paidUntil: number | null } | { plan: 'trial'; days: number };

export const TRIAL_DEFAULT_DAYS = 14;
/** The platform extends a trial by 1..90 days at a time. */
export const TRIAL_EXTEND_MAX_DAYS = 90;
export const TRIAL_VENUE_MAX = 80;
export const TRIAL_NAME_MAX = 80;
export const TRIAL_TIMEZONE_MAX = 64;
/** A snapshot (decoded SQLite bytes) may be this big at most. */
export const TRIAL_SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;
/** Days of history a report may carry. */
export const TRIAL_STATS_MAX_DAYS = 400;
/** Rate limits of the public `trial` function. */
export const TRIAL_RATE = {
  startsPerIpHour: 10,
  reportsPerTrialHour: 120,
  /** New transfer codes / view links a trial may ask for in an hour. */
  linksPerTrialHour: 20,
  /** Attempts to open a coffee shop by a transfer code, per address an hour (right or wrong). */
  transferPerIpHour: 10,
  /** Openings of the phone page per address an hour (it refreshes every minute). */
  viewsPerIpHour: 600,
} as const;

/** A paid period «without an end» is kept as this endsAt (1 January 2100 UTC). */
export const PAID_FOREVER_AT = Date.UTC(2100, 0, 1);
/** «Сделать постоянной … до»: at most this far ahead. */
export const PAID_MAX_DAYS = 3660;
/** A transfer code lives this long. */
export const TRIAL_TRANSFER_TTL_MS = 24 * 3_600_000;
/** Alphabet of transfer codes: no 0/O, 1/I/L — easy to read aloud and to type. */
export const TRIAL_TRANSFER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const TRIAL_TRANSFER_LENGTH = 8;
export const TRIAL_SUMMARY_TOP = 5;

export const TRIAL_ENDED_MESSAGE = 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.';
export const TRIAL_EXPIRED_MESSAGE = 'Срок пробного периода истёк. Свяжитесь с TS, чтобы продолжить.';
export const PAID_ENDED_MESSAGE = 'Оплаченный период закончился — свяжитесь с TS.';
export const TRIAL_MOVED_MESSAGE = 'Эта кофейня открыта на другом устройстве. Здесь данные можно только смотреть.';

/** The status a trial has now: a stored 'active' whose endsAt has come is 'expired'. */
export function trialStatus(row: { status: TrialStatus | string; endsAt: number }, now: number): TrialStatus {
  if (row.status === 'ended') return 'ended';
  if (row.status === 'expired') return 'expired';
  return row.endsAt <= now ? 'expired' : 'active';
}

interface TermsRow {
  status: TrialStatus | string;
  endsAt: number;
  plan?: TrialPlan | string | null;
  paidUntil?: number | null;
  snapshotAt?: number | null;
}

/** What the trial is told: its status, the end, the plan and (when it is over) why. */
export function trialTerms(row: TermsRow, now: number): TrialTerms {
  const status = trialStatus(row, now);
  const paid = row.plan === 'paid';
  const extra: Pick<TrialTerms, 'plan' | 'paidUntil' | 'snapshotAt'> = {
    plan: paid ? 'paid' : 'trial',
    paidUntil: paid ? (row.paidUntil ?? null) : null,
    snapshotAt: row.snapshotAt ?? null,
  };
  if (status === 'active') return { status, endsAt: row.endsAt, ...extra };
  const message = paid ? PAID_ENDED_MESSAGE : status === 'ended' ? TRIAL_ENDED_MESSAGE : TRIAL_EXPIRED_MESSAGE;
  return { status, endsAt: row.endsAt, message, ...extra };
}

/** «7k3m q9tx» / «7K3M-Q9TX» → «7K3MQ9TX»; null when it cannot be a transfer code. */
export function normalizeTransferCode(text: string): string | null {
  const s = text.toUpperCase().replace(/[\s\-–—_.]/g, '');
  if (s.length !== TRIAL_TRANSFER_LENGTH) return null;
  for (const c of s) if (!TRIAL_TRANSFER_ALPHABET.includes(c)) return null;
  return s;
}

/** «7K3MQ9TX» → «7K3M-Q9TX». */
export function formatTransferCode(code: string): string {
  return code.length === TRIAL_TRANSFER_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
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

const isText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max;

/** Problems of a reported TrialSummary; empty when it is fine. */
export function validateTrialSummary(x: unknown): string[] {
  if (!isObject(x)) return ['summary: нужен объект'];
  const problems: string[] = [];
  if (!(typeof x.at === 'number' && Number.isFinite(x.at) && x.at >= 0)) problems.push('summary.at: время в мс');
  if (!isText(x.currency, 8)) problems.push('summary.currency: строка');
  if (!isText(x.timezone, TRIAL_TIMEZONE_MAX)) problems.push('summary.timezone: строка');
  if (typeof x.date !== 'string' || !DAY_RE.test(x.date)) problems.push('summary.date: дата YYYY-MM-DD');
  for (const key of ['revenueToday', 'revenue7', 'revenue30', 'avgCheckToday'] as const) {
    if (!isAmount(x[key])) problems.push(`summary.${key}: число`);
  }
  if (!isCount(x.checksToday)) problems.push('summary.checksToday: целое число ≥ 0');
  if (typeof x.shiftOpen !== 'boolean') problems.push('summary.shiftOpen: да или нет');
  if (x.lastActivityAt !== null && !(typeof x.lastActivityAt === 'number' && Number.isFinite(x.lastActivityAt) && x.lastActivityAt >= 0)) {
    problems.push('summary.lastActivityAt: время в мс или null');
  }
  if (!Array.isArray(x.topToday) || x.topToday.length > TRIAL_SUMMARY_TOP) {
    problems.push(`summary.topToday: список до ${TRIAL_SUMMARY_TOP}`);
  } else {
    x.topToday.forEach((p: unknown, i: number) => {
      if (!isObject(p) || !isText(p.name, 120) || !isCount(p.qty) || !isAmount(p.revenue)) problems.push(`summary.topToday[${i}]: name, qty, revenue`);
    });
  }
  const m = x.methodsToday;
  if (!isObject(m) || !isAmount(m.cash) || !isAmount(m.card) || !isAmount(m.qr)) problems.push('summary.methodsToday: cash, card, qr');
  if (!Array.isArray(x.days) || x.days.length > 31) {
    problems.push('summary.days: список до 31 дня');
  } else {
    x.days.forEach((d: unknown, i: number) => {
      if (!isObject(d) || typeof d.day !== 'string' || !DAY_RE.test(d.day) || !isAmount(d.revenue)) problems.push(`summary.days[${i}]: day, revenue`);
    });
  }
  return problems;
}

/** Only the known fields of a valid TrialSummary. */
export function cleanTrialSummary(x: TrialSummary): TrialSummary {
  return {
    at: x.at,
    currency: x.currency,
    timezone: x.timezone,
    date: x.date,
    revenueToday: x.revenueToday,
    revenue7: x.revenue7,
    revenue30: x.revenue30,
    checksToday: x.checksToday,
    avgCheckToday: x.avgCheckToday,
    topToday: x.topToday.map((p) => ({ name: p.name, qty: p.qty, revenue: p.revenue })),
    methodsToday: { cash: x.methodsToday.cash, card: x.methodsToday.card, qr: x.methodsToday.qr },
    shiftOpen: x.shiftOpen,
    lastActivityAt: x.lastActivityAt,
    days: x.days.map((d) => ({ day: d.day, revenue: d.revenue })),
  };
}
