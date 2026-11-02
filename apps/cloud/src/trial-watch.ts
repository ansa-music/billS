/**
 * «Смотреть с телефона» in the cloud (Supabase only: migration 20261102100000_trial_watch.sql).
 * The rules and types are packages/domain/src/trial-watch.ts. The cash desk (the trial's own token)
 * issues and revokes viewer links; a phone (a viewer token) reads the trial's latest snapshot, the one
 * POST /trial/report stores in `trials.snapshot`. A viewer token is random, stored only as sha256 and
 * belongs to one trial; it never opens /trial/report or another trial. Runtime-neutral (node:crypto only).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TrialReportAnswer, TrialTerms, TrialWatchLink, TrialWatchSnapshot, TrialWatchState, TrialWatchStatus } from '@bills/domain';
import { cloudCafeUrl, isWatching, isWatchToken, TRIAL_WATCH, TRIAL_WATCH_RATE, TRIAL_WATCH_REVOKED_MESSAGE, trialStatus } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';

const HOUR_MS = 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::bigint`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

const trialNotFound = (): CloudError => new CloudError(404, 'TRIAL_NOT_FOUND', 'Пробная версия не найдена');
const badTrialToken = (): CloudError => new CloudError(401, 'UNAUTHORIZED', 'Ключ пробной версии не подходит');
const badViewer = (): CloudError => new CloudError(401, 'WATCH_LINK_REVOKED', TRIAL_WATCH_REVOKED_MESSAGE);

/** sha256 of a rate-limit key, the same scheme as apps/cloud/src/trial.ts (one table, trial_attempts). */
const attemptHash = (key: string): string => sha256(`ts-trial:${key}`);

async function attemptsWithinHour(db: SqlDriver, now: number, hash: string): Promise<number> {
  const rows = await db.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM trial_attempts WHERE key_hash = ? AND at > ?', [hash, now - HOUR_MS]);
  return Number(rows[0]?.n ?? 0);
}

/** Counts an attempt under `key`; 429 past `perHour` attempts within the last hour. */
async function countAttempt(db: SqlDriver, now: number, key: string, perHour: number, message: string): Promise<void> {
  const hash = attemptHash(key);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM trial_attempts WHERE at < ?', [now - HOUR_MS]);
    if ((await attemptsWithinHour(tx, now, hash)) >= perHour) throw new CloudError(429, 'RATE_LIMITED', message);
    await tx.run('INSERT INTO trial_attempts (id, key_hash, at) VALUES (?, ?, ?)', [randomUUID(), hash, now]);
  });
}

// ---------------------------------------------------------------------------
// The cash desk: the trial's own token

interface TrialAuthRow {
  id: string;
  token_hash: string;
}

/** The trial `id` whose token is `token`: 404 for an unknown id, 401 for a missing or wrong token. */
async function authorizedTrial(db: SqlDriver, id: unknown, token: string | null): Promise<string> {
  if (!token) throw badTrialToken();
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw trialNotFound();
  const rows = await db.all<TrialAuthRow>('SELECT id::text AS id, token_hash FROM trials WHERE id = ?::uuid', [id]);
  const row = rows[0];
  if (!row) throw trialNotFound();
  const given = Buffer.from(sha256(token), 'hex');
  const stored = Buffer.from(row.token_hash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw badTrialToken();
  return row.id;
}

const trialIdOf = (raw: unknown): unknown => (isObject(raw) ? raw.id : undefined);

/**
 * POST /trial/watch/links {id}: a new viewer link for this trial. The token is returned once and kept
 * as sha256; past TRIAL_WATCH.maxLinks the links unused for longest are dropped.
 */
export async function createWatchLink(db: SqlDriver, now: number, token: string | null, raw: unknown): Promise<TrialWatchLink> {
  const trialId = await authorizedTrial(db, trialIdOf(raw), token);
  await countAttempt(db, now, `watch-link:${trialId}`, TRIAL_WATCH_RATE.linksPerTrialHour, 'Слишком много ссылок для просмотра. Попробуйте через час');
  const viewerToken = randomBytes(TRIAL_WATCH.tokenBytes).toString('base64url');
  await db.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO trial_viewers (id, trial_id, token_hash, created_at) VALUES (?::uuid, ?::uuid, ?, ?::timestamptz)',
      [randomUUID(), trialId, sha256(viewerToken), iso(now)],
    );
    await tx.run(
      `DELETE FROM trial_viewers WHERE id IN (
         SELECT id FROM trial_viewers WHERE trial_id = ?::uuid
         ORDER BY COALESCE(last_viewed_at, created_at) DESC, created_at DESC OFFSET ?::int)`,
      [trialId, TRIAL_WATCH.maxLinks],
    );
  });
  return { token: viewerToken, createdAt: now };
}

/** GET /trial/watch/links?id=: how many links and phones there are, and whether one is watching now. */
export async function watchLinksStatus(db: SqlDriver, now: number, token: string | null, id: string | null): Promise<TrialWatchStatus> {
  const trialId = await authorizedTrial(db, id, token);
  const rows = await db.all<{ links: number | string; phones: number | string; last: number | string | null }>(
    `SELECT COUNT(*) AS links, COUNT(last_viewed_at) AS phones, ${ms('MAX(last_viewed_at)')} AS last
       FROM trial_viewers WHERE trial_id = ?::uuid`,
    [trialId],
  );
  const r = rows[0];
  const lastViewedAt = r ? num(r.last) : null;
  return { links: Number(r?.links ?? 0), phones: Number(r?.phones ?? 0), lastViewedAt, watching: isWatching(lastViewedAt, now) };
}

/** POST /trial/watch/revoke {id}: «Отключить телефоны» — every link of this trial stops working. */
export async function revokeWatchLinks(db: SqlDriver, token: string | null, raw: unknown): Promise<{ revoked: number }> {
  const trialId = await authorizedTrial(db, trialIdOf(raw), token);
  const revoked = await db.run('DELETE FROM trial_viewers WHERE trial_id = ?::uuid', [trialId]);
  return { revoked };
}

/** Is a phone watching trial `trialId` (checked within TRIAL_WATCH.watchingMs)? */
export async function trialWatching(db: SqlDriver, now: number, trialId: string): Promise<boolean> {
  if (!UUID_RE.test(trialId)) return false;
  const rows = await db.all<{ x: number }>(
    'SELECT 1 AS x FROM trial_viewers WHERE trial_id = ?::uuid AND last_viewed_at > ?::timestamptz LIMIT 1',
    [trialId, iso(now - TRIAL_WATCH.watchingMs)],
  );
  return rows.length > 0;
}

/**
 * The answer of POST /trial/report with `watching: true` added while a phone is looking. Called after
 * reportTrial accepted the report, so `raw.id` is the trial the token belongs to.
 */
export async function withWatching(db: SqlDriver, now: number, raw: unknown, terms: TrialTerms): Promise<TrialReportAnswer> {
  const id = trialIdOf(raw);
  return typeof id === 'string' && (await trialWatching(db, now, id)) ? { ...terms, watching: true } : terms;
}

// ---------------------------------------------------------------------------
// The phone: a viewer token

interface ViewerRow {
  id: string;
  trial_id: string;
}

/**
 * The viewer behind `token`: 429 after too many unknown tokens from this address, 401 for an unknown,
 * malformed or revoked token (counted against the address), then the per-viewer limit of `kind`.
 * The phone's last check is written down — that is what makes the cash desk send fresher copies.
 */
async function viewerOf(db: SqlDriver, now: number, token: string | null, ip: string, kind: 'check' | 'snapshot'): Promise<ViewerRow> {
  const failKey = attemptHash(`watch-fail:ip:${ip}`);
  if ((await attemptsWithinHour(db, now, failKey)) >= TRIAL_WATCH_RATE.failuresPerIpHour) {
    throw new CloudError(429, 'RATE_LIMITED', 'Слишком много неверных ссылок с этого адреса. Попробуйте через час');
  }
  const rows = isWatchToken(token)
    ? await db.all<ViewerRow>('SELECT id::text AS id, trial_id::text AS trial_id FROM trial_viewers WHERE token_hash = ?', [sha256(token)])
    : [];
  const viewer = rows[0];
  if (!viewer) {
    await db.run('INSERT INTO trial_attempts (id, key_hash, at) VALUES (?, ?, ?)', [randomUUID(), failKey, now]);
    throw badViewer();
  }
  const perHour = kind === 'check' ? TRIAL_WATCH_RATE.checksPerViewerHour : TRIAL_WATCH_RATE.snapshotsPerViewerHour;
  await countAttempt(db, now, `watch-${kind}:${viewer.id}`, perHour, 'Слишком частые проверки. Подождите немного');
  await db.run('UPDATE trial_viewers SET last_viewed_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), viewer.id]);
  return viewer;
}

/**
 * GET /trial/watch (viewer token): the venue, the terms and when the latest snapshot came — no snapshot. Once the café
 * is in the cloud cash desk, `cloud` says where (the phone shows «Касса переехала в облако» with the link).
 */
export async function watchState(db: SqlDriver, now: number, token: string | null, ip: string, cloudBase: string | null = null): Promise<TrialWatchState> {
  const viewer = await viewerOf(db, now, token, ip, 'check');
  const rows = await db.all<{
    venue: string;
    status: string;
    started_at: number | string;
    ends_at: number | string;
    snapshot_at: number | string | null;
    snapshot_bytes: number | string | null;
    cloud_code: string | null;
  }>(
    `SELECT venue, status, ${ms('started_at')} AS started_at, ${ms('ends_at')} AS ends_at, ${ms('snapshot_at')} AS snapshot_at, snapshot_bytes, cloud_code
       FROM trials WHERE id = ?::uuid`,
    [viewer.trial_id],
  );
  const r = rows[0];
  if (!r) throw badViewer();
  const endsAt = Number(r.ends_at);
  return {
    venue: r.venue,
    startedAt: Number(r.started_at),
    endsAt,
    status: trialStatus({ status: r.status, endsAt }, now),
    snapshotAt: num(r.snapshot_at),
    snapshotBytes: num(r.snapshot_bytes),
    ...(r.cloud_code ? { cloud: { code: r.cloud_code, url: cloudBase ? cloudCafeUrl(cloudBase, r.cloud_code) : null } } : {}),
  };
}

/** GET /trial/watch/snapshot (viewer token): this trial's latest snapshot, base64; 404 before the first one. */
export async function watchSnapshot(db: SqlDriver, now: number, token: string | null, ip: string): Promise<TrialWatchSnapshot> {
  const viewer = await viewerOf(db, now, token, ip, 'snapshot');
  const rows = await db.all<{ snapshot: string | null; snapshot_at: number | string | null }>(
    `SELECT encode(snapshot, 'base64') AS snapshot, ${ms('snapshot_at')} AS snapshot_at FROM trials WHERE id = ?::uuid`,
    [viewer.trial_id],
  );
  const r = rows[0];
  if (!r || r.snapshot === null || r.snapshot_at === null) {
    throw new CloudError(404, 'SNAPSHOT_NOT_FOUND', 'Касса ещё не прислала данные. Откройте TS на кассе с интернетом и подождите минуту');
  }
  return { snapshot: r.snapshot.replace(/\s+/g, ''), snapshotAt: Number(r.snapshot_at) };
}
