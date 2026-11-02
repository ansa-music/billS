/**
 * The browser trial's link to the TS cloud (VITE_TRIAL=1). The coffee shop still lives only in
 * this browser; the cloud gets a short report of how it is used (and, now and then, a backup
 * copy) so TS can see the trial and extend or end it remotely. Its answer carries the terms
 * (end date, status), which boot.ts turns into the license of the in-page HUB.
 *
 * Contract (supabase/functions/trial): base `${VITE_SUPABASE_URL}/functions/v1/trial`
 *   POST /start  {venue, managerName, timezone, startedAt}  → {id, token, startedAt, endsAt, status}
 *                (the cloud counts the 14 days from this browser's startedAt, not from the call)
 *   POST /report Bearer token, {id, stats, snapshot?, needCode?} → {status, endsAt, message?, watching?, cafeCode?, sendSnapshot?}
 *   GET  /terms?id=  Bearer token                          → {status, endsAt, message?}
 * Without VITE_SUPABASE_URL everything here is off. Nothing waits on the network: a failed
 * call is tried again on the next tick.
 */
import type { TrialReportRequest, TrialStartRequest, TrialStartResponse, TrialStats, TrialTerms } from '@bills/domain';
import { TRIAL_SNAPSHOT_MAX_BYTES, workingDay } from '@bills/domain';
import type { DatabaseSync } from './shims/sqlite.ts';
import type { TrialInfo } from './trial-store.ts';
import { isStatus } from './trial-store.ts';
import type { TrialReportAnswer, TrialReportMoveFields } from '@bills/domain';
import { TRIAL_SNAPSHOT, TRIAL_WATCH, trialReportEveryMs, trialSnapshotDueNow } from '@bills/domain';
import type { ForcedCopy } from './trial-move.ts';
import { deskMove, httpError } from './trial-move.ts';

export type { TrialStats, TrialTerms };
type TrialDayStats = TrialStats['days'][number];
type TrialStarted = TrialStartResponse & TrialTerms;

const BASE = String(import.meta.env.VITE_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
/** Where the trial functions answer; '' = no cloud in this build. */
export const TRIAL_CLOUD_URL = BASE ? `${BASE}/functions/v1/trial` : '';

const APP_VERSION = String(import.meta.env.VITE_APP_VERSION ?? 'trial');
/** How often «is a report due?» is asked: every 5 minutes, or every minute while a phone watches (TRIAL_WATCH). */
const REPORT_TICK_MS = 15_000;
const FIRST_CHANGE_DELAY_MS = 20_000;
const SNAPSHOT_MAX_BYTES = TRIAL_SNAPSHOT_MAX_BYTES;
const STATS_DAYS = 14;
const TIMEOUT_MS = 20_000;

function parseTerms(body: unknown): TrialTerms | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (!isStatus(o.status) || typeof o.endsAt !== 'number' || !Number.isFinite(o.endsAt)) return null;
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  return { status: o.status, endsAt: o.endsAt, ...(message ? { message } : {}) };
}

async function call(path: string, init: RequestInit & { token?: string | undefined }): Promise<unknown> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = rest.keepalive ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : undefined;
  try {
    const res = await fetch(`${TRIAL_CLOUD_URL}${path}`, { ...rest, headers, cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
    // With the cloud's code (trial-move.ts reads 410 TRIAL_MOVED: «Касса перенесена»).
    if (!res.ok) throw await httpError(path, res);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function cloudStart(body: TrialStartRequest): Promise<TrialStarted> {
  const o = (await call('/start', { method: 'POST', body: JSON.stringify(body) })) as Record<string, unknown>;
  const terms = parseTerms(o);
  if (!terms || typeof o.id !== 'string' || typeof o.token !== 'string') throw new Error('trial /start: unexpected answer');
  return { ...terms, id: o.id, token: o.token, startedAt: typeof o.startedAt === 'number' ? o.startedAt : Date.now() };
}

export async function cloudReport(id: string, token: string, stats: TrialStats, snapshot?: string): Promise<TrialTerms> {
  const req: TrialReportRequest = { id, stats, ...(snapshot ? { snapshot } : {}) };
  const terms = parseTerms(await call('/report', { method: 'POST', token, body: JSON.stringify(req) }));
  if (!terms) throw new Error('trial /report: unexpected answer');
  return terms;
}

export async function cloudTerms(id: string, token: string): Promise<TrialTerms> {
  const terms = parseTerms(await call(`/terms?id=${encodeURIComponent(id)}`, { method: 'GET', token }));
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

/**
 * POST /report with the answer's `watching` kept: a phone is looking («Смотреть с телефона»). `extra` and
 * `onBody`: the move fields of the request and the whole answer (trial-move.ts: café code, «send a fresh copy»).
 */
async function cloudReportWatching(
  id: string,
  token: string,
  stats: TrialStats,
  snapshot?: string,
  extra: TrialReportMoveFields = {},
  onBody?: (body: unknown) => void,
): Promise<TrialReportAnswer> {
  const req: TrialReportRequest & TrialReportMoveFields = { id, stats, ...(snapshot ? { snapshot } : {}), ...extra };
  const body = await call('/report', { method: 'POST', token, body: JSON.stringify(req) });
  onBody?.(body);
  const terms = parseTerms(body);
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
  /** Store changed cloud facts (into the running trial and IndexedDB). */
  persist(patch: Partial<TrialInfo>): void;
  /** The cloud's terms changed: re-install the HUB's license. */
  applyTerms(terms: TrialTerms): void;
  /** Another computer took the cash desk over (trial-move.ts): lock this one read-only. */
  onMoved?(): void;
}

/**
 * Starts the link: POST /start once (retried until it answers), then a report every 5 minutes,
 * 20 s after the first change, and a last one (without the copy) when the page goes away.
 * While a phone watches (the report's answer says `watching`, or a watch link was just made) the
 * reports come every minute and carry the copy whenever it changed; otherwise a changed copy goes 2 minutes
 * after the last change (with the 5-minute report while busy).
 * Returns null when this build has no cloud or the coffee shop is a local-only copy.
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
    deps.persist({ endsAt: terms.endsAt, status: terms.status, message });
    if (licenseChanged) deps.applyTerms(terms);
  };

  // The copy goes 2 minutes after the last change (or with the 5-minute report while busy), not every
  // 30 minutes (TRIAL_SNAPSHOT: why that fits Supabase Free); `force` — a move asked for it, changed or not.
  let lastChangeAt: number | null = null;
  let forceCopy = false;
  let tooBig = false;
  const snapshot = (force = false): { data: string; hash: string } | null => {
    if (db.isTransaction) return null;
    if (!force && !trialSnapshotDueNow(Date.now(), { lastSnapshotAt: info.snapshotAt, lastChangeAt, watched: watched() })) return null;
    const bytes = db.export();
    tooBig = bytes.length > SNAPSHOT_MAX_BYTES;
    if (tooBig) return null;
    const hash = fingerprint(bytes);
    return hash === info.snapshotHash && !force ? null : { data: toBase64(bytes), hash };
  };
  // «У меня уже есть TS — войти» (trial-move.ts): the café code, a fresh copy when a move asks, «Касса перенесена».
  const move = deskMove({
    info,
    persist: deps.persist,
    reportWithCopy: () => reportWithCopy(),
    unsynced: () => !db.isTransaction && fingerprint(db.export()) !== info.snapshotHash,
    onMoved: () => deps.onMoved?.(),
  });

  const tick = async (): Promise<TrialTerms | null> => {
    // Moved away: this computer is no longer the cash desk and never reports again.
    if (move.stopped) return null;
    try {
      if (!info.cloudId || !info.cloudToken) {
        // startedAt: a trial that registers late (offline at first, opened after an update) keeps its own term.
        const started = await cloudStart({ venue: info.venue, managerName: info.managerName, timezone: deps.timezone, startedAt: info.startedAt });
        deps.persist({ cloudId: started.id, cloudToken: started.token });
        take(started);
      }
      const force = forceCopy;
      forceCopy = false;
      const snap = snapshot(force);
      const terms = await cloudReportWatching(info.cloudId!, info.cloudToken!, collectStats(db), snap?.data, move.fields(), (body) => move.onAnswer(body));
      watchedByCloud = terms.watching === true;
      if (snap) deps.persist({ snapshotAt: Date.now(), snapshotHash: snap.hash });
      take(terms);
      return terms;
    } catch (err) {
      if (move.onError(err)) return null;
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
  /** A report with the copy right now, after one already on its way (trial-move.ts: a move waits for it). */
  const reportWithCopy = async (): Promise<ForcedCopy> => {
    while (running) await running;
    forceCopy = true;
    const before = info.snapshotAt;
    const terms = await reportNow();
    if (tooBig) return 'too-big';
    return terms && info.snapshotAt !== before ? 'sent' : 'failed';
  };
  const watchSoon = () => {
    watchedUntil = Date.now() + TRIAL_WATCH.watchingMs;
    // After a report already on its way (it may have gone without the copy).
    void (running ?? Promise.resolve()).then(() => reportNow());
  };

  // The first report a few seconds after opening, so the counter draws first.
  setTimeout(() => void reportNow(), 3000);
  setInterval(() => {
    if (Date.now() - lastAttempt >= trialReportEveryMs(watched())) void reportNow();
  }, REPORT_TICK_MS);
  let firstChange = true;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  deps.onChange(() => {
    lastChangeAt = Date.now();
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (lastChangeAt !== null && lastChangeAt > (info.snapshotAt ?? 0)) void reportNow();
    }, TRIAL_SNAPSHOT.quietMs + 1000);
    if (!firstChange) return;
    firstChange = false;
    setTimeout(() => void reportNow(), FIRST_CHANGE_DELAY_MS);
  });
  window.addEventListener('pagehide', () => {
    if (!info.cloudId || !info.cloudToken || move.stopped) return;
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
