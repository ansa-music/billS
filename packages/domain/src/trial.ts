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

export interface TrialTerms {
  status: TrialStatus;
  endsAt: number;
  message?: string;
}

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
  /** base64 of the trial's SQLite database, ≤ TRIAL_SNAPSHOT_MAX_BYTES decoded. */
  snapshot?: string;
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
}

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
export const TRIAL_RATE = { startsPerIpHour: 10, reportsPerTrialHour: 120 } as const;

export const TRIAL_ENDED_MESSAGE = 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.';
export const TRIAL_EXPIRED_MESSAGE = 'Срок пробного периода истёк. Свяжитесь с TS, чтобы продолжить.';

/** The status a trial has now: a stored 'active' whose endsAt has come is 'expired'. */
export function trialStatus(row: { status: TrialStatus | string; endsAt: number }, now: number): TrialStatus {
  if (row.status === 'ended') return 'ended';
  if (row.status === 'expired') return 'expired';
  return row.endsAt <= now ? 'expired' : 'active';
}

/** What the trial is told: its status, the end and (when it is over) why. */
export function trialTerms(row: { status: TrialStatus | string; endsAt: number }, now: number): TrialTerms {
  const status = trialStatus(row, now);
  if (status === 'ended') return { status, endsAt: row.endsAt, message: TRIAL_ENDED_MESSAGE };
  if (status === 'expired') return { status, endsAt: row.endsAt, message: TRIAL_EXPIRED_MESSAGE };
  return { status, endsAt: row.endsAt };
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
