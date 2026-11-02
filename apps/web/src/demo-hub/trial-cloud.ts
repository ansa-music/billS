/**
 * The browser coffee shop's link to the TS cloud (VITE_TRIAL=1). The coffee shop lives in this
 * browser; the cloud gets a short report of how it is used, the owner's summary for the phone
 * page, and — every 10 minutes when something changed, and when the page is hidden — a compressed
 * copy of the data (the cloud keeps the latest one). Its answer carries the terms (plan, end,
 * status), which boot.ts turns into the license of the in-page HUB.
 *
 * Contract (supabase/functions/trial): base `${VITE_SUPABASE_URL}/functions/v1/trial`
 *   POST /start  {venue, managerName, timezone}                      → {id, token, startedAt, endsAt, status}
 *   POST /report Bearer, {id, stats, summary?, snapshot?, snapshotEncoding?} → TrialTerms
 *   GET  /terms?id=  Bearer                                          → TrialTerms
 *   POST /transfer-code {id} Bearer → {code, expiresAt};  POST /transfer {code} → copy + new token
 *   POST /view-link {id, off?} Bearer → {token}
 * A token retired by a transfer gets 409 TRIAL_MOVED: the coffee shop runs on another device now.
 * Without VITE_SUPABASE_URL everything here is off. Nothing waits on the network: a failed
 * call is tried again on the next tick.
 */
import type {
  TrialReportRequest,
  TrialSnapshotEncoding,
  TrialStartRequest,
  TrialStartResponse,
  TrialStats,
  TrialSummary,
  TrialTerms,
  TrialTransferCode,
  TrialTransferResponse,
} from '@bills/domain';
import { TRIAL_MOVED_MESSAGE, TRIAL_SNAPSHOT_MAX_BYTES, workingDay } from '@bills/domain';
import type { DatabaseSync } from './shims/sqlite.ts';
import type { TrialInfo, TrialRecord } from './trial-store.ts';
import { fromBase64, isStatus, saveTrial } from './trial-store.ts';

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
/** A copy goes up at most this often while the coffee shop is being used… */
export const SNAPSHOT_EVERY_MS = 10 * 60_000;
/** …and when the page is hidden, if the last one is at least this old. */
const SNAPSHOT_ON_HIDE_MIN_MS = 60_000;
/** While a transfer code is valid, ask the cloud this often whether the coffee shop moved. */
const MOVED_CHECK_MS = 30_000;
/** A keepalive request (survives closing the tab) may carry about 64 KB. */
const KEEPALIVE_MAX = 60 * 1024;
const STATS_DAYS = 14;
const TIMEOUT_MS = 30_000;

/** The cloud's refusal with its code (TRIAL_MOVED, NO_SNAPSHOT, TRANSFER_CODE_INVALID, RATE_LIMITED…). */
export class TrialCloudError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseTerms(body: unknown): TrialTerms | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (!isStatus(o.status) || typeof o.endsAt !== 'number' || !Number.isFinite(o.endsAt)) return null;
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  return {
    status: o.status,
    endsAt: o.endsAt,
    ...(message ? { message } : {}),
    plan: o.plan === 'paid' ? 'paid' : 'trial',
    paidUntil: typeof o.paidUntil === 'number' ? o.paidUntil : null,
    ...(typeof o.snapshotAt === 'number' || o.snapshotAt === null ? { snapshotAt: o.snapshotAt as number | null } : {}),
  };
}

async function call(path: string, init: RequestInit & { token?: string | undefined }): Promise<unknown> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = rest.keepalive ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : undefined;
  try {
    let res: Response;
    try {
      res = await fetch(`${TRIAL_CLOUD_URL}${path}`, { ...rest, headers, cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
    } catch {
      throw new TrialCloudError(0, 'OFFLINE', 'Нет связи с интернетом. Проверьте подключение и попробуйте ещё раз.');
    }
    if (!res.ok) {
      let code = 'HTTP_ERROR';
      let message = `Облако TS не ответило (HTTP ${res.status}). Попробуйте ещё раз.`;
      try {
        const data = (await res.json()) as { error?: { code?: string; message?: string } };
        code = data.error?.code ?? code;
        message = data.error?.message ?? message;
      } catch {
        // not JSON
      }
      throw new TrialCloudError(res.status, code, message);
    }
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

export async function cloudReport(id: string, token: string, req: Omit<TrialReportRequest, 'id'>): Promise<TrialTerms> {
  const terms = parseTerms(await call('/report', { method: 'POST', token, body: JSON.stringify({ id, ...req }) }));
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

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** gzip in the browser (CompressionStream); without it the copy goes as it is. */
export async function compressCopy(bytes: Uint8Array): Promise<{ data: Uint8Array; encoding: TrialSnapshotEncoding }> {
  if (typeof CompressionStream !== 'function') return { data: bytes, encoding: 'raw' };
  try {
    return { data: await pipeThrough(bytes, new CompressionStream('gzip')), encoding: 'gzip' };
  } catch {
    return { data: bytes, encoding: 'raw' };
  }
}

export async function decompressCopy(bytes: Uint8Array, encoding: TrialSnapshotEncoding): Promise<Uint8Array> {
  if (encoding !== 'gzip') return bytes;
  if (typeof DecompressionStream !== 'function') throw new Error('Этот браузер не умеет распаковывать копию. Откройте TS в Chrome, Edge или Яндекс Браузере.');
  return pipeThrough(bytes, new DecompressionStream('gzip'));
}

/**
 * «Открыть по коду переноса» on a new device: the cloud gives the latest copy and a new token (the
 * old device stops writing). The coffee shop is saved into this browser; the caller reloads.
 */
export async function openByTransferCode(code: string): Promise<{ venue: string }> {
  if (!TRIAL_CLOUD_URL) throw new TrialCloudError(0, 'NO_CLOUD', 'Перенос работает только с облаком TS.');
  const res = (await call('/transfer', { method: 'POST', body: JSON.stringify({ code }) })) as TrialTransferResponse;
  const terms = parseTerms(res.terms);
  if (typeof res.id !== 'string' || typeof res.token !== 'string' || typeof res.snapshot !== 'string' || !terms) throw new Error('trial /transfer: unexpected answer');
  const db = await decompressCopy(fromBase64(res.snapshot), res.snapshotEncoding === 'gzip' ? 'gzip' : 'raw');
  const rec: TrialRecord = {
    db,
    savedAt: Date.now(),
    startedAt: res.startedAt,
    venue: res.venue,
    managerName: res.managerName,
    // The code stays with the person; the HUB gives the manager an extra one at the first start.
    managerKey: '',
    cloudId: res.id,
    cloudToken: res.token,
    endsAt: terms.endsAt,
    status: terms.status,
    message: terms.message ?? null,
    plan: terms.plan ?? 'trial',
    paidUntil: terms.paidUntil ?? null,
    cloudSnapshotAt: res.snapshotAt,
    // The copy that came is the cloud's one: nothing new to send until something changes.
    snapshotAt: Date.now(),
    snapshotHash: fingerprint(db),
  };
  await saveTrial(rec);
  return { venue: res.venue };
}

export interface TrialCloudLink {
  /** Report now (the debug hook and tests); resolves with the cloud's terms or null. */
  reportNow(options?: { snapshot?: 'force' }): Promise<TrialTerms | null>;
  transferCode(): Promise<TrialTransferCode>;
  viewLink(off?: boolean): Promise<string | null>;
}

export interface TrialCloudDeps {
  db: DatabaseSync;
  info: TrialInfo;
  timezone: string;
  /** Subscribe to the HUB's change events. */
  onChange(listener: () => void): void;
  /** The owner's summary for the phone page (trial-summary.ts); null when there is none. */
  summary(): TrialSummary | null;
  /** Store changed cloud facts (into the running trial and IndexedDB). */
  persist(patch: Partial<TrialInfo>): void;
  /** The cloud's terms changed: re-install the HUB's license. */
  applyTerms(terms: TrialTerms): void;
}

/**
 * Starts the link: POST /start once (retried until it answers), then a report every 5 minutes,
 * 20 s after the first change, and a last one when the page goes away. A copy goes with a report
 * every 10 minutes while something changed, and when the page is hidden. Returns null when this
 * build has no cloud or the coffee shop is a local-only copy.
 */
export function startTrialCloud(deps: TrialCloudDeps): TrialCloudLink | null {
  const { db, info } = deps;
  // A copy opened for viewing (no cloud link) must never pose as the trial; a moved one is done.
  if (!TRIAL_CLOUD_URL || info.localOnly || info.moved) return null;
  let running: Promise<TrialTerms | null> | null = null;
  // Something changed since the last copy (a fresh start has never sent one).
  let dirty = !info.snapshotAt;
  let stopped = false;

  const take = (terms: TrialTerms) => {
    const message = terms.message ?? null;
    const plan = terms.plan ?? 'trial';
    const paidUntil = terms.paidUntil ?? null;
    const cloudSnapshotAt = terms.snapshotAt === undefined ? (info.cloudSnapshotAt ?? null) : terms.snapshotAt;
    if (
      terms.endsAt === info.endsAt &&
      terms.status === info.status &&
      message === (info.message ?? null) &&
      plan === (info.plan ?? 'trial') &&
      paidUntil === (info.paidUntil ?? null) &&
      cloudSnapshotAt === (info.cloudSnapshotAt ?? null)
    ) {
      return;
    }
    const licenseChanged = terms.endsAt !== info.endsAt || terms.status !== info.status;
    deps.persist({ endsAt: terms.endsAt, status: terms.status, message, plan, paidUntil, cloudSnapshotAt });
    if (licenseChanged) deps.applyTerms(terms);
  };

  /** The coffee shop was opened on another device: read-only here, and no more calls. */
  const movedAway = () => {
    stopped = true;
    deps.persist({ moved: true, status: 'ended', message: TRIAL_MOVED_MESSAGE, endsAt: Math.min(info.endsAt ?? Date.now(), Date.now()) });
    deps.applyTerms({ status: 'ended', endsAt: Date.now(), message: TRIAL_MOVED_MESSAGE });
  };

  const failed = (err: unknown) => {
    if (err instanceof TrialCloudError && err.code === 'TRIAL_MOVED') movedAway();
    else console.warn('[trial] the TS cloud did not answer, will try again', err);
  };

  /** A compressed copy when one is due (or forced): null when nothing changed or it is too big. */
  const snapshot = async (force: boolean): Promise<{ data: string; encoding: TrialSnapshotEncoding; hash: string; size: number } | null> => {
    if (db.isTransaction) return null;
    if (!force && (!dirty || Date.now() - (info.snapshotAt ?? 0) < SNAPSHOT_EVERY_MS)) return null;
    const bytes = db.export();
    const hash = fingerprint(bytes);
    if (hash === info.snapshotHash && info.cloudSnapshotAt) {
      dirty = false;
      return null;
    }
    const packed = await compressCopy(bytes);
    if (packed.data.length > TRIAL_SNAPSHOT_MAX_BYTES) {
      if (!info.snapshotTooBig) deps.persist({ snapshotTooBig: true });
      return null;
    }
    return { data: toBase64(packed.data), encoding: packed.encoding, hash, size: packed.data.length };
  };

  const ensureStarted = async () => {
    if (!info.cloudId || !info.cloudToken) {
      const started = await cloudStart({ venue: info.venue, managerName: info.managerName, timezone: deps.timezone });
      deps.persist({ cloudId: started.id, cloudToken: started.token });
      take(started);
    }
  };

  const summary = (): TrialSummary | undefined => {
    try {
      return deps.summary() ?? undefined;
    } catch (err) {
      console.warn('[trial] the owner summary could not be counted', err);
      return undefined;
    }
  };

  const tick = async (force: boolean, keepalive = false): Promise<TrialTerms | null> => {
    if (stopped) return null;
    try {
      await ensureStarted();
      const snap = await snapshot(force);
      const sentAt = Date.now();
      const changedSince = dirty;
      dirty = false;
      const owner = summary();
      const body: Omit<TrialReportRequest, 'id'> = {
        stats: collectStats(db),
        ...(owner ? { summary: owner } : {}),
        ...(snap ? { snapshot: snap.data, snapshotEncoding: snap.encoding } : {}),
      };
      let terms: TrialTerms;
      try {
        const small = keepalive && JSON.stringify(body).length < KEEPALIVE_MAX;
        const parsed = parseTerms(
          await call('/report', { method: 'POST', token: info.cloudToken, keepalive: small, body: JSON.stringify({ id: info.cloudId, ...body }) }),
        );
        if (!parsed) throw new Error('trial /report: unexpected answer');
        terms = parsed;
      } catch (err) {
        // Not sent: the changes still need a copy.
        if (snap || changedSince) dirty = true;
        throw err;
      }
      if (snap) deps.persist({ snapshotAt: sentAt, snapshotHash: snap.hash, snapshotTooBig: false, cloudSnapshotAt: terms.snapshotAt ?? sentAt });
      take(terms);
      return terms;
    } catch (err) {
      failed(err);
      return null;
    }
  };
  const reportNow = (options?: { snapshot?: 'force' }, keepalive = false) => {
    if (running) return options?.snapshot ? running.then(() => tick(true, keepalive)) : running;
    running = tick(options?.snapshot === 'force', keepalive).finally(() => {
      running = null;
    });
    return running;
  };

  const checkMoved = async () => {
    if (stopped || !info.cloudId || !info.cloudToken) return;
    try {
      take(await cloudTerms(info.cloudId, info.cloudToken));
    } catch (err) {
      failed(err);
    }
  };

  // The first report a few seconds after opening, so the counter draws first.
  setTimeout(() => void reportNow(), 3000);
  setInterval(() => void reportNow(), REPORT_EVERY_MS);
  setInterval(() => {
    if (info.transferExpiresAt && info.transferExpiresAt > Date.now()) void checkMoved();
  }, MOVED_CHECK_MS);
  let firstChange = true;
  deps.onChange(() => {
    dirty = true;
    if (!firstChange) return;
    firstChange = false;
    setTimeout(() => void reportNow(), FIRST_CHANGE_DELAY_MS);
  });
  // Hidden (another tab, the lid closed, the tab closing): send the copy if something changed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !dirty || stopped) return;
    if (Date.now() - (info.snapshotAt ?? 0) < SNAPSHOT_ON_HIDE_MIN_MS) return;
    void reportNow({ snapshot: 'force' }, true);
  });
  window.addEventListener('pagehide', () => {
    if (stopped || !info.cloudId || !info.cloudToken) return;
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

  const authed = async (): Promise<{ id: string; token: string }> => {
    if (stopped) throw new TrialCloudError(409, 'TRIAL_MOVED', TRIAL_MOVED_MESSAGE);
    await ensureStarted();
    return { id: info.cloudId!, token: info.cloudToken! };
  };

  return {
    reportNow,
    async transferCode() {
      // The copy the new device opens must be this minute's one.
      const terms = await reportNow({ snapshot: 'force' });
      if (stopped) throw new TrialCloudError(409, 'TRIAL_MOVED', TRIAL_MOVED_MESSAGE);
      if (!terms) throw new TrialCloudError(0, 'OFFLINE', 'Не удалось отправить копию в облако. Проверьте интернет и попробуйте ещё раз.');
      const { id, token } = await authed();
      try {
        const res = (await call('/transfer-code', { method: 'POST', token, body: JSON.stringify({ id }) })) as TrialTransferCode;
        deps.persist({ transferExpiresAt: res.expiresAt });
        return res;
      } catch (err) {
        failed(err);
        throw err;
      }
    },
    async viewLink(off = false) {
      const { id, token } = await authed();
      try {
        const res = (await call('/view-link', { method: 'POST', token, body: JSON.stringify({ id, ...(off ? { off: true } : {}) }) })) as { token: string | null };
        deps.persist({ viewToken: res.token ?? undefined });
        // The phone page has numbers at once.
        if (res.token) void reportNow();
        return res.token;
      } catch (err) {
        failed(err);
        throw err;
      }
    },
  };
}
