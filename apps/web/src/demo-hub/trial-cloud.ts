/**
 * The browser trial's link to the TS cloud (VITE_TRIAL=1). The coffee shop still lives only in
 * this browser. After the welcome form the page sends a request (POST /start with this browser's
 * installId) and waits — read-only — until TS approves it; then the cloud gets a short report of how
 * the trial is used (and, now and then, a backup copy) so TS can see it and extend, end or make it
 * permanent remotely. Every answer carries the terms (status, end), which boot.ts turns into the
 * license of the in-page HUB.
 *
 * Contract (supabase/functions/trial): base `${VITE_SUPABASE_URL}/functions/v1/trial`
 *   POST /start  {venue, managerName, timezone, startedAt, installId} → {id, token, startedAt, endsAt, status: 'pending'}
 *                (the same installId again → the same trial with a new token)
 *   GET  /terms?id=&v=2  Bearer token                         → {status, endsAt, message?}  (while waiting: every 30 s)
 *   POST /report Bearer token, {id, v: 2, stats, snapshot?}    → {status, endsAt, message?, watching?}
 * Without VITE_SUPABASE_URL everything here is off. Nothing waits on the network: a failed
 * call is tried again on the next tick.
 */
import type { TrialReportRequest, TrialStartRequest, TrialStartResponse, TrialStats, TrialTerms } from '@bills/domain';
import { parseTrialTerms, TRIAL_SNAPSHOT_MAX_BYTES, TRIAL_TERMS_VERSION, trialCheckEveryMs, trialGoneTerms, trialWaiting, workingDay } from '@bills/domain';
import type { DatabaseSync } from './shims/sqlite.ts';
import type { TrialInfo } from './trial-store.ts';
import { newInstallId, noteTrialCheck } from './trial-store.ts';
import type { TrialReportAnswer } from '@bills/domain';
import { TRIAL_WATCH, trialReportEveryMs, trialSnapshotDue } from '@bills/domain';

export type { TrialStats, TrialTerms };
type TrialDayStats = TrialStats['days'][number];
type TrialStarted = TrialStartResponse & TrialTerms;

const BASE = String(import.meta.env.VITE_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
/** Where the trial functions answer; '' = no cloud in this build. */
export const TRIAL_CLOUD_URL = BASE ? `${BASE}/functions/v1/trial` : '';

const APP_VERSION = String(import.meta.env.VITE_APP_VERSION ?? 'trial');
/**
 * How often «is a call due?» is asked: a report every 5 minutes, or every minute while a phone watches
 * (TRIAL_WATCH); a waiting request's terms every 30 s on screen (trialCheckEveryMs).
 */
const REPORT_TICK_MS = 5_000;
const FIRST_CHANGE_DELAY_MS = 20_000;
const SNAPSHOT_MAX_BYTES = TRIAL_SNAPSHOT_MAX_BYTES;
const STATS_DAYS = 14;
const TIMEOUT_MS = 20_000;

/** A call the cloud answered with an error: its HTTP status and code (TRIAL_NOT_FOUND after a deletion). */
export class TrialCloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit & { token?: string | undefined }): Promise<unknown> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = rest.keepalive ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : undefined;
  try {
    const res = await fetch(`${TRIAL_CLOUD_URL}${path}`, { ...rest, headers, cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      const code = typeof body?.error?.code === 'string' ? body.error.code : '';
      throw new TrialCloudError(res.status, code, `trial ${path}: HTTP ${res.status}${code ? ` ${code}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function cloudStart(body: TrialStartRequest): Promise<TrialStarted> {
  const o = (await call('/start', { method: 'POST', body: JSON.stringify(body) })) as Record<string, unknown>;
  const terms = parseTrialTerms(o);
  if (!terms || typeof o.id !== 'string' || typeof o.token !== 'string') throw new Error('trial /start: unexpected answer');
  return { ...terms, id: o.id, token: o.token, startedAt: typeof o.startedAt === 'number' ? o.startedAt : Date.now() };
}

export async function cloudReport(id: string, token: string, stats: TrialStats, snapshot?: string): Promise<TrialTerms> {
  return cloudReportWatching(id, token, stats, snapshot);
}

export async function cloudTerms(id: string, token: string): Promise<TrialTerms> {
  const terms = parseTrialTerms(await call(`/terms?id=${encodeURIComponent(id)}&v=${TRIAL_TERMS_VERSION}`, { method: 'GET', token }));
  if (!terms) throw new Error('trial /terms: unexpected answer');
  return terms;
}

/** The YYYY-MM-DD `n` calendar days before `day`. */
function dayBefore(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

/**
 * How the coffee shop is used, straight from the in-page HUB's database. Orders are bar orders
 * that were not cancelled (counter orders carry their working day); revenue is payments minus
 * refunds, bucketed by the working day of the payment.
 */
export function collectStats(db: DatabaseSync, now = Date.now()): TrialStats {
  const one = (sql: string, ...params: unknown[]): Row => db.prepare(sql).get(...params) ?? {};
  const all = (sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params);
  const tz = String(one('SELECT timezone FROM clubs ORDER BY created_at LIMIT 1').timezone ?? '') || 'Asia/Almaty';
  const today = workingDay(now, tz);
  const first = dayBefore(today, STATS_DAYS - 1);
  const byDay = new Map<string, TrialDayStats>();
  for (let i = STATS_DAYS - 1; i >= 0; i--) {
    const day = dayBefore(today, i);
    byDay.set(day, { day, orders: 0, revenue: 0 });
  }

  const orders = one("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM bar_orders WHERE status <> 'CANCELLED'");
  for (const r of all(
    "SELECT business_day AS day, COUNT(*) AS n FROM bar_orders WHERE status <> 'CANCELLED' AND business_day >= ? GROUP BY business_day",
    first,
  )) {
    const d = byDay.get(String(r.day));
    if (d) d.orders = num(r.n);
  }
  // Game orders (a club, not a coffee shop) have no working day of their own.
  for (const r of all("SELECT created_at FROM bar_orders WHERE status <> 'CANCELLED' AND business_day IS NULL AND created_at >= ?", now - (STATS_DAYS + 1) * 86_400_000)) {
    const d = byDay.get(workingDay(num(r.created_at), tz));
    if (d) d.orders++;
  }

  const revenue = one("SELECT COALESCE(SUM(CASE kind WHEN 'REFUND' THEN -amount ELSE amount END), 0) AS total FROM payments");
  for (const r of all(
    "SELECT at, CASE kind WHEN 'REFUND' THEN -amount ELSE amount END AS amount FROM payments WHERE at >= ?",
    now - (STATS_DAYS + 1) * 86_400_000,
  )) {
    const d = byDay.get(workingDay(num(r.at), tz));
    if (d) d.revenue += num(r.amount);
  }

  const days = [...byDay.values()];
  const last = orders.last;
  return {
    ordersTotal: num(orders.n),
    ordersToday: byDay.get(today)?.orders ?? 0,
    revenueTotal: num(revenue.total),
    revenueToday: byDay.get(today)?.revenue ?? 0,
    productsCount: num(one('SELECT COUNT(*) AS n FROM products WHERE is_active = 1').n),
    staffCount: num(one('SELECT COUNT(*) AS n FROM staff WHERE is_active = 1').n),
    shiftOpen: num(one("SELECT COUNT(*) AS n FROM cash_shifts WHERE status = 'OPEN'").n) > 0,
    lastOrderAt: last === null || last === undefined ? null : num(last),
    days,
    appVersion: APP_VERSION,
  };
}

/** FNV-1a over the bytes: enough to tell «the same copy as last time». */
function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** POST /report with the answer's `watching` kept: a phone is looking («Смотреть с телефона»). */
async function cloudReportWatching(id: string, token: string, stats: TrialStats, snapshot?: string): Promise<TrialReportAnswer> {
  const req: TrialReportRequest = { id, v: TRIAL_TERMS_VERSION, stats, ...(snapshot ? { snapshot } : {}) };
  const body = await call('/report', { method: 'POST', token, body: JSON.stringify(req) });
  const terms = parseTrialTerms(body);
  if (!terms) throw new Error('trial /report: unexpected answer');
  return (body as { watching?: unknown }).watching === true ? { ...terms, watching: true } : terms;
}

export interface TrialCloudLink {
  /** Report now (the debug hook and tests); resolves with the cloud's terms or null. */
  reportNow(): Promise<TrialTerms | null>;
  /** A watch link was just made: report at the phone's pace for a while, a fresh copy first. */
  watchSoon(): void;
}

export interface TrialCloudDeps {
  db: DatabaseSync;
  info: TrialInfo;
  timezone: string;
  /** Subscribe to the HUB's change events. */
  onChange(listener: () => void): void;
  /** Store changed cloud facts (into the running trial and IndexedDB); resolves once written. */
  persist(patch: Partial<TrialInfo>): Promise<void> | void;
  /** The cloud's terms changed: re-install the HUB's license. */
  applyTerms(terms: TrialTerms): void;
}

/** A waiting page asks again at most this often when it comes back on screen. */
const REFOCUS_MIN_MS = 5_000;

/**
 * Starts the link. POST /start once with this browser's installId (saved first; retried until it answers),
 * which makes a request. While it is a request the page asks GET /terms every 30 s on screen (every 5 minutes
 * hidden, at once when it comes back) and sends no reports; when TS approves, the terms say so and boot.ts
 * opens the cash desk. Then a report every 5 minutes, 20 s after the first change, and a last one (without
 * the copy) when the page goes away. While a phone watches (the report's answer says `watching`, or a watch
 * link was just made) the reports come every minute and carry the copy whenever it changed; otherwise the
 * copy goes every 30 minutes. Returns null when this build has no cloud or the coffee shop is a local-only copy.
 */
export function startTrialCloud(deps: TrialCloudDeps): TrialCloudLink | null {
  const { db, info } = deps;
  // A copy opened for viewing (no cloud link) must never pose as the trial.
  if (!TRIAL_CLOUD_URL || info.localOnly) return null;
  let running: Promise<TrialTerms | null> | null = null;
  let watchedByCloud = false;
  let watchedUntil = 0;
  const watched = () => watchedByCloud || Date.now() < watchedUntil;
  let lastAttempt = 0;

  const take = (terms: TrialTerms) => {
    const message = terms.message ?? null;
    if (terms.endsAt === info.endsAt && terms.status === info.status && message === (info.message ?? null)) return;
    const licenseChanged = terms.endsAt !== info.endsAt || terms.status !== info.status;
    void deps.persist({ endsAt: terms.endsAt, status: terms.status, message });
    if (licenseChanged) deps.applyTerms(terms);
  };

  const snapshot = (): { data: string; hash: string } | null => {
    if (!trialSnapshotDue(Date.now(), info.snapshotAt, watched()) || db.isTransaction) return null;
    const bytes = db.export();
    if (bytes.length > SNAPSHOT_MAX_BYTES) return null;
    const hash = fingerprint(bytes);
    return hash === info.snapshotHash ? null : { data: toBase64(bytes), hash };
  };

  const tick = async (): Promise<TrialTerms | null> => {
    try {
      if (!info.cloudId || !info.cloudToken) {
        // The installId is saved before the first start, so a lost answer finds the same request again.
        if (!info.installId) await deps.persist({ installId: newInstallId() });
        const started = await cloudStart({
          venue: info.venue,
          managerName: info.managerName,
          timezone: deps.timezone,
          startedAt: info.startedAt,
          installId: info.installId!,
        });
        await deps.persist({ cloudId: started.id, cloudToken: started.token });
        take(started);
        if (trialWaiting(started.status)) {
          noteTrialCheck(true);
          return started;
        }
      }
      if (trialWaiting(info.status)) {
        // A request: no reports until TS approves it, only its terms.
        const terms = await cloudTerms(info.cloudId!, info.cloudToken!);
        noteTrialCheck(true);
        take(terms);
        return terms;
      }
      const snap = snapshot();
      const terms = await cloudReportWatching(info.cloudId!, info.cloudToken!, collectStats(db), snap?.data);
      noteTrialCheck(true);
      watchedByCloud = terms.watching === true;
      if (snap) void deps.persist({ snapshotAt: Date.now(), snapshotHash: snap.hash });
      take(terms);
      return terms;
    } catch (err) {
      noteTrialCheck(false);
      // The platform owner deleted a request that was waiting: «Заявка удалена», and no more asking.
      const gone = err instanceof TrialCloudError && err.status === 404 && err.code === 'TRIAL_NOT_FOUND' ? trialGoneTerms(info, Date.now()) : null;
      if (gone) {
        take(gone);
        return gone;
      }
      console.warn('[trial] the TS cloud did not answer, will try again', err);
      return null;
    }
  };
  const reportNow = () => {
    if (!running) {
      lastAttempt = Date.now();
      running = tick().finally(() => {
        running = null;
      });
    }
    return running;
  };
  const watchSoon = () => {
    watchedUntil = Date.now() + TRIAL_WATCH.watchingMs;
    // After a report already on its way (it may have gone without the copy).
    void (running ?? Promise.resolve()).then(() => reportNow());
  };

  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  // A request asks at once (the waiting screen is up); a running trial reports a few seconds after
  // opening, so the counter draws first.
  setTimeout(() => void reportNow(), trialWaiting(info.status) ? 300 : 3000);
  setInterval(() => {
    if (Date.now() - lastAttempt >= trialCheckEveryMs(info.status, visible(), trialReportEveryMs(watched()))) void reportNow();
  }, REPORT_TICK_MS);
  // Back on screen while waiting: ask now instead of up to half a minute later.
  const refocus = () => {
    if (visible() && trialWaiting(info.status) && Date.now() - lastAttempt >= REFOCUS_MIN_MS) void reportNow();
  };
  window.addEventListener('focus', refocus);
  document.addEventListener('visibilitychange', refocus);
  let firstChange = true;
  deps.onChange(() => {
    if (!firstChange) return;
    firstChange = false;
    setTimeout(() => void reportNow(), FIRST_CHANGE_DELAY_MS);
  });
  window.addEventListener('pagehide', () => {
    if (!info.cloudId || !info.cloudToken || trialWaiting(info.status)) return;
    try {
      void fetch(`${TRIAL_CLOUD_URL}/report`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.cloudToken}` },
        body: JSON.stringify({ id: info.cloudId, stats: collectStats(db) }),
      }).catch(() => undefined);
    } catch {
      // Closing the page: nothing to do if the browser refuses.
    }
  });
  return { reportNow, watchSoon };
}
