/**
 * The browser trial's link to the TS cloud (VITE_TRIAL=1). The coffee shop still lives only in
 * this browser; the cloud gets a short report of how it is used (and, now and then, a backup
 * copy) so TS can see the trial and extend or end it remotely. Its answer carries the terms
 * (end date, status), which boot.ts turns into the license of the in-page HUB.
 *
 * Contract (supabase/functions/trial): base `${VITE_SUPABASE_URL}/functions/v1/trial`
 *   POST /start  {venue, managerName, timezone}            → {id, token, startedAt, endsAt, status}
 *   POST /report Bearer token, {id, stats, snapshot?}       → {status, endsAt, message?}
 *   GET  /terms?id=  Bearer token                          → {status, endsAt, message?}
 * Without VITE_SUPABASE_URL everything here is off. Nothing waits on the network: a failed
 * call is tried again on the next tick.
 */
import type { TrialReportRequest, TrialStartRequest, TrialStartResponse, TrialStats, TrialTerms } from '@bills/domain';
import { TRIAL_SNAPSHOT_MAX_BYTES, workingDay } from '@bills/domain';
import type { DatabaseSync } from './shims/sqlite.ts';
import type { TrialInfo } from './trial-store.ts';
import { isStatus } from './trial-store.ts';

export type { TrialStats, TrialTerms };
type TrialDayStats = TrialStats['days'][number];
type TrialStarted = TrialStartResponse & TrialTerms;

const BASE = String(import.meta.env.VITE_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
/** Where the trial functions answer; '' = no cloud in this build. */
export const TRIAL_CLOUD_URL = BASE ? `${BASE}/functions/v1/trial` : '';

const APP_VERSION = String(import.meta.env.VITE_APP_VERSION ?? 'trial');
const REPORT_EVERY_MS = 5 * 60_000;
const FIRST_CHANGE_DELAY_MS = 20_000;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
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
    if (!res.ok) throw new Error(`trial ${path}: HTTP ${res.status}`);
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

export interface TrialCloudLink {
  /** Report now (the debug hook and tests); resolves with the cloud's terms or null. */
  reportNow(): Promise<TrialTerms | null>;
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
}

/**
 * Starts the link: POST /start once (retried until it answers), then a report every 5 minutes,
 * 20 s after the first change, and a last one (without the copy) when the page goes away.
 * Returns null when this build has no cloud or the coffee shop is a local-only copy.
 */
export function startTrialCloud(deps: TrialCloudDeps): TrialCloudLink | null {
  const { db, info } = deps;
  // A copy opened for viewing (no cloud link) must never pose as the trial.
  if (!TRIAL_CLOUD_URL || info.localOnly) return null;
  let running: Promise<TrialTerms | null> | null = null;

  const take = (terms: TrialTerms) => {
    const message = terms.message ?? null;
    if (terms.endsAt === info.endsAt && terms.status === info.status && message === (info.message ?? null)) return;
    const licenseChanged = terms.endsAt !== info.endsAt || terms.status !== info.status;
    deps.persist({ endsAt: terms.endsAt, status: terms.status, message });
    if (licenseChanged) deps.applyTerms(terms);
  };

  const snapshot = (): { data: string; hash: string } | null => {
    if (Date.now() - (info.snapshotAt ?? 0) < SNAPSHOT_EVERY_MS || db.isTransaction) return null;
    const bytes = db.export();
    if (bytes.length > SNAPSHOT_MAX_BYTES) return null;
    const hash = fingerprint(bytes);
    return hash === info.snapshotHash ? null : { data: toBase64(bytes), hash };
  };

  const tick = async (): Promise<TrialTerms | null> => {
    try {
      if (!info.cloudId || !info.cloudToken) {
        const started = await cloudStart({ venue: info.venue, managerName: info.managerName, timezone: deps.timezone });
        deps.persist({ cloudId: started.id, cloudToken: started.token });
        take(started);
      }
      const snap = snapshot();
      const terms = await cloudReport(info.cloudId!, info.cloudToken!, collectStats(db), snap?.data);
      if (snap) deps.persist({ snapshotAt: Date.now(), snapshotHash: snap.hash });
      take(terms);
      return terms;
    } catch (err) {
      console.warn('[trial] the TS cloud did not answer, will try again', err);
      return null;
    }
  };
  const reportNow = () => {
    running ??= tick().finally(() => {
      running = null;
    });
    return running;
  };

  // The first report a few seconds after opening, so the counter draws first.
  setTimeout(() => void reportNow(), 3000);
  setInterval(() => void reportNow(), REPORT_EVERY_MS);
  let firstChange = true;
  deps.onChange(() => {
    if (!firstChange) return;
    firstChange = false;
    setTimeout(() => void reportNow(), FIRST_CHANGE_DELAY_MS);
  });
  window.addEventListener('pagehide', () => {
    if (!info.cloudId || !info.cloudToken) return;
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
  return { reportNow };
}
