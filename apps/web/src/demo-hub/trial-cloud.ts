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
 *   POST /report Bearer token, {id, v: 2, stats, snapshot?, needCode?} → {status, endsAt, message?, watching?, cafeCode?, sendSnapshot?}
 *                (needCode / cafeCode / sendSnapshot and 410 TRIAL_MOVED: moving the cash desk, trial-move.ts)
 *   POST /cloud/seen Bearer token, {id}                       → {ok}  (the page kept the director's key of its cloud café)
 * The report also carries `codes` (packages/domain/src/trial-codes.ts: the café code and the director's code for the
 * platform owner, only when one changed since the cloud last accepted them) and its answer may carry
 * `directorKeyNext` (TS's new director's code: installed here, trial-director.ts).
 * «Облачная касса» (packages/domain/src/cloud-cafe.ts): an answer's `cloud` (or a retired token's 410 TRIAL_MOVED
 * with `error.cloud`) means the café now lives in the TS cloud — kept on the record (TrialInfo.cloud), this browser
 * turns read-only and never calls again (except once, POST /cloud/seen, after keeping a new café's director's key).
 * Without VITE_SUPABASE_URL everything here is off. Nothing waits on the network: a failed
 * call is tried again on the next tick.
 */
import type { TrialCloudInfo, TrialReportRequest, TrialStartRequest, TrialStartResponse, TrialStats, TrialTerms } from '@bills/domain';
import {
  codesToReport,
  directorKeyNextOf,
  mergeReportedCodes,
  movedToCloudOf,
  parseTrialCloudInfo,
  parseTrialTerms,
  TRIAL_SNAPSHOT_MAX_BYTES,
  TRIAL_TERMS_VERSION,
  trialCheckEveryMs,
  trialCloudKeyToAck,
  trialCloudRecord,
  trialGoneTerms,
  trialWaiting,
  workingDay,
} from '@bills/domain';
import type { DatabaseSync } from './shims/sqlite.ts';
import type { TrialInfo } from './trial-store.ts';
import { newInstallId, noteTrialCheck } from './trial-store.ts';
import type { TrialReportAnswer, TrialReportCodeFields, TrialReportCodes, TrialReportMoveFields } from '@bills/domain';
import { TRIAL_SNAPSHOT, TRIAL_WATCH, trialReportEveryMs, trialSnapshotDueNow } from '@bills/domain';
import type { ForcedCopy } from './trial-move.ts';
import { deskMove } from './trial-move.ts';

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

/**
 * A call the cloud answered with an error: its HTTP status and code (TRIAL_NOT_FOUND after a deletion), and the
 * café in the cloud a retired token's 410 TRIAL_MOVED names (null: moved to another computer, or another error).
 */
export class TrialCloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly cloud: TrialCloudInfo | null = null,
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
    // The cloud's status and code: 404 TRIAL_NOT_FOUND after a deletion, 410 TRIAL_MOVED (trial-move.ts).
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      const code = typeof body?.error?.code === 'string' ? body.error.code : '';
      throw new TrialCloudError(res.status, code, `trial ${path}: HTTP ${res.status}${code ? ` ${code}` : ''}`, movedToCloudOf(body));
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The terms with the answer's `cloud` (the café now lives in the TS cloud), when it carries one. */
function withCloud<T extends TrialTerms>(terms: T, body: unknown): T {
  const cloud = parseTrialCloudInfo((body as { cloud?: unknown } | null)?.cloud);
  return cloud ? { ...terms, cloud } : terms;
}

export async function cloudStart(body: TrialStartRequest): Promise<TrialStarted> {
  const o = (await call('/start', { method: 'POST', body: JSON.stringify(body) })) as Record<string, unknown>;
  const terms = parseTrialTerms(o);
  if (!terms || typeof o.id !== 'string' || typeof o.token !== 'string') throw new Error('trial /start: unexpected answer');
  return withCloud({ ...terms, id: o.id, token: o.token, startedAt: typeof o.startedAt === 'number' ? o.startedAt : Date.now() }, o);
}

export async function cloudReport(id: string, token: string, stats: TrialStats, snapshot?: string): Promise<TrialTerms> {
  return cloudReportWatching(id, token, stats, snapshot);
}

export async function cloudTerms(id: string, token: string): Promise<TrialTerms> {
  const body = await call(`/terms?id=${encodeURIComponent(id)}&v=${TRIAL_TERMS_VERSION}`, { method: 'GET', token });
  const terms = parseTrialTerms(body);
  if (!terms) throw new Error('trial /terms: unexpected answer');
  return withCloud(terms, body);
}

/** POST /cloud/seen: the page kept its cloud café's director's key — the cloud forgets it (and retires this token). */
export async function cloudSeen(id: string, token: string): Promise<void> {
  await call('/cloud/seen', { method: 'POST', token, body: JSON.stringify({ id }) });
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
  extra: TrialReportMoveFields & TrialReportCodeFields = {},
  onBody?: (body: unknown) => void,
): Promise<TrialReportAnswer> {
  const req: TrialReportRequest & TrialReportMoveFields & TrialReportCodeFields = { id, v: TRIAL_TERMS_VERSION, stats, ...(snapshot ? { snapshot } : {}), ...extra };
  const body = await call('/report', { method: 'POST', token, body: JSON.stringify(req) });
  onBody?.(body);
  const terms = parseTrialTerms(body);
  if (!terms) throw new Error('trial /report: unexpected answer');
  const answer: TrialReportAnswer = (body as { watching?: unknown }).watching === true ? { ...terms, watching: true } : terms;
  return withCloud(answer, body);
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
  /** Another computer took the cash desk over (trial-move.ts): lock this one read-only. */
  onMoved?(): void;
  /** The café moved to the TS cloud (TrialInfo.cloud is set): lock this one read-only. */
  onCloud?(): void;
  /** The café's codes as they are now (trial-director.ts): only what changed since the last accepted report is sent. */
  codes?(): TrialReportCodes;
  /** TS's new director's code (the report's `directorKeyNext`): install it in the in-page HUB. */
  installDirectorKey?(key: string): 'installed' | 'refused';
}

/** A waiting page asks again at most this often when it comes back on screen. */
const REFOCUS_MIN_MS = 5_000;

/**
 * Starts the link. POST /start once with this browser's installId (saved first; retried until it answers),
 * which makes a request. While it is a request the page asks GET /terms every 30 s on screen (every 5 minutes
 * hidden, at once when it comes back) and sends no reports; when TS approves, the terms say so and boot.ts
 * opens the cash desk. Then a report every 5 minutes, 20 s after the first change, and a last one (without
 * the copy) when the page goes away. While a phone watches (the report's answer says `watching`, or a watch
 * link was just made) the reports come every minute and carry the copy whenever it changed; otherwise a changed
 * copy goes 2 minutes after the last change (with the 5-minute report while busy). Returns null when this build
 * has no cloud or the coffee shop is a local-only copy.
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
    // In the cloud: this browser's terms no longer change.
    if (info.cloud) return;
    const message = terms.message ?? null;
    if (terms.endsAt === info.endsAt && terms.status === info.status && message === (info.message ?? null)) return;
    const licenseChanged = terms.endsAt !== info.endsAt || terms.status !== info.status;
    // «Купили»: remembered, so a paid term that ran out says so even when the cloud's words are not here.
    const everPaid = terms.status === 'paid' ? true : terms.status === 'expired' ? info.everPaid : undefined;
    void deps.persist({ endsAt: terms.endsAt, status: terms.status, message, everPaid });
    if (licenseChanged) deps.applyTerms(terms);
  };

  // The copy goes 2 minutes after the last change (or with the 5-minute report while busy), not every
  // 30 minutes (TRIAL_SNAPSHOT: why that fits Supabase Free); `force` — a move asked for it, changed or not.
  // The HUB's last change of the café's data (orders, menu, staff…; a sign-in is none), saved with the café.
  let lastChangeAt: number | null = info.changedAt ?? null;
  let forceCopy = false;
  let tooBig = false;
  const snapshot = (force = false): { data: string; hash: string; takenAt: number } | null => {
    if (db.isTransaction) return null;
    if (!force && !trialSnapshotDueNow(Date.now(), { lastSnapshotAt: info.snapshotAt, lastChangeAt, watched: watched() })) return null;
    const bytes = db.export();
    tooBig = bytes.length > SNAPSHOT_MAX_BYTES;
    if (tooBig) return null;
    const hash = fingerprint(bytes);
    return hash === info.snapshotHash && !force ? null : { data: toBase64(bytes), hash, takenAt: Date.now() };
  };
  // «У меня уже есть TS — войти» (trial-move.ts): the café code, a fresh copy when a move asks, «Касса перенесена».
  const move = deskMove({
    info,
    persist: deps.persist,
    reportWithCopy: () => reportWithCopy(),
    // Changed after the last copy was taken (not mere background writes such as sessions).
    unsynced: () => (info.changedAt ?? 0) > (info.snapshotAt ?? 0),
    onMoved: () => deps.onMoved?.(),
    // The signal said «this token was retired»: by a move to another computer, or to the cloud? One terms call tells.
    whyMoved: async () => {
      if (!info.cloudId || !info.cloudToken) return 'moved';
      try {
        await cloudTerms(info.cloudId, info.cloudToken);
      } catch (err) {
        if (err instanceof TrialCloudError && err.cloud) {
          await toCloud(err.cloud, null);
          return 'cloud';
        }
      }
      return 'moved';
    },
  });

  /** Tells the cloud the director's key of the new cloud café is kept here (then the cloud forgets it). */
  let acking = false;
  const ackKey = async (): Promise<void> => {
    if (acking || !trialCloudKeyToAck(info.cloud) || !info.cloudId || !info.cloudToken) return;
    acking = true;
    try {
      await cloudSeen(info.cloudId, info.cloudToken);
      await deps.persist({ cloud: { ...info.cloud!, keyAcked: true } });
    } catch (err) {
      // Already retired (or gone): the cloud does not hold the key for this page any more.
      if (err instanceof TrialCloudError && (err.status === 401 || err.status === 404 || err.status === 410)) {
        await deps.persist({ cloud: { ...info.cloud!, keyAcked: true } });
      }
      // Off line: the next tick tries again.
    } finally {
      acking = false;
    }
  };

  /**
   * The café lives in the TS cloud now: where it is (and a new café's director's key) is kept first — the key on
   * disk before the cloud is told it may forget it — then this browser locks read-only and stops calling.
   */
  const toCloud = async (cloud: TrialCloudInfo, terms: TrialTerms | null): Promise<void> => {
    if (info.cloud) return;
    move.stop();
    const record = trialCloudRecord(cloud, trialWaiting(info.status), Date.now());
    await deps.persist({ cloud: record, ...(terms ? { status: terms.status, endsAt: terms.endsAt, message: terms.message ?? null } : {}) });
    deps.onCloud?.();
    await ackKey();
  };

  /**
   * TS issued a new director's code («Выдать новый код директора»): installed once (it comes with every answer
   * until the cloud sees it reported); the next report, a few seconds later, says it works — or that it could not
   * be installed here (another person has those digits), and TS issues another.
   */
  const takeDirectorKey = (key: string) => {
    if (!deps.installDirectorKey || key === info.managerKey || key === info.directorKeyRefused) return;
    const result = deps.installDirectorKey(key);
    if (result === 'refused') void deps.persist({ directorKeyRefused: key });
    setTimeout(() => void reportNow(), 2000);
  };

  const tick = async (): Promise<TrialTerms | null> => {
    // In the cloud: nothing more to say, except (once) that the director's key is kept.
    if (info.cloud) {
      await ackKey();
      return null;
    }
    // Moved away: this computer is no longer the cash desk and never reports again.
    if (move.stopped) return null;
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
          ...(info.withMenu !== undefined ? { withMenu: info.withMenu } : {}),
        });
        await deps.persist({ cloudId: started.id, cloudToken: started.token });
        if (started.cloud) {
          noteTrialCheck(true);
          await toCloud(started.cloud, started);
          return started;
        }
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
        // Approved straight into the TS cloud: «Ваша касса готова — она в облаке» instead of this browser's café.
        if (terms.cloud) {
          await toCloud(terms.cloud, terms);
          return terms;
        }
        take(terms);
        // Approved: the first report (with it the café code, trial-move.ts) in a few seconds, not 5 minutes later.
        if (!trialWaiting(terms.status)) setTimeout(() => void reportNow(), 3000);
        return terms;
      }
      const force = forceCopy;
      forceCopy = false;
      const snap = snapshot(force);
      // The codes for the platform owner: only what changed since the cloud last accepted them.
      const codes = deps.codes ? codesToReport(deps.codes(), info.codesReported) : null;
      let nextKey: string | null = null;
      const terms = await cloudReportWatching(
        info.cloudId!,
        info.cloudToken!,
        collectStats(db),
        snap?.data,
        { ...move.fields(), ...(codes ? { codes } : {}) },
        (body) => {
          move.onAnswer(body);
          nextKey = directorKeyNextOf(body);
        },
      );
      noteTrialCheck(true);
      watchedByCloud = terms.watching === true;
      if (snap) void deps.persist({ snapshotAt: snap.takenAt, snapshotHash: snap.hash });
      if (codes) void deps.persist({ codesReported: mergeReportedCodes(info.codesReported, codes) });
      if (nextKey) takeDirectorKey(nextKey);
      if (terms.cloud) {
        await toCloud(terms.cloud, terms);
        return terms;
      }
      take(terms);
      return terms;
    } catch (err) {
      noteTrialCheck(false);
      // The café moved to the TS cloud (410 TRIAL_MOVED with `cloud`): «Касса переехала в облако», no more calls.
      if (err instanceof TrialCloudError && err.cloud) {
        await toCloud(err.cloud, null).catch((e: unknown) => console.warn('[trial] could not keep the cloud link', e));
        return null;
      }
      // Another computer took the cash desk over (410 TRIAL_MOVED): «Касса перенесена», no more calls.
      if (move.onError(err)) return null;
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
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  deps.onChange(() => {
    lastChangeAt = Date.now();
    // Kept on the record itself: the saver writes it with this change (no extra save).
    info.changedAt = lastChangeAt;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (lastChangeAt !== null && lastChangeAt > (info.snapshotAt ?? 0)) void reportNow();
    }, TRIAL_SNAPSHOT.quietMs + 1000);
    if (!firstChange) return;
    firstChange = false;
    setTimeout(() => void reportNow(), FIRST_CHANGE_DELAY_MS);
  });
  window.addEventListener('pagehide', () => {
    if (!info.cloudId || !info.cloudToken || trialWaiting(info.status) || move.stopped || info.cloud) return;
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
