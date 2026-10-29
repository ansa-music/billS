/**
 * The coffee shop's browser trial in the cloud (Supabase only: migration 20261029000000_trials.sql).
 * The rules and types are packages/domain/src/trial.ts; here — storage, the public calls of the Edge
 * Function `trial` (start, report, terms) and the platform's calls of `platform` (list, extend, end,
 * snapshot). Runtime-neutral (node:crypto only). Times are timestamptz in the table, ms in the API.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PlatformMe, TrialStartResponse, TrialStats, TrialTerms, TrialView } from '@bills/domain';
import {
  cleanTrialStats,
  TRIAL_DEFAULT_DAYS,
  TRIAL_EXTEND_MAX_DAYS,
  TRIAL_NAME_MAX,
  TRIAL_RATE,
  TRIAL_SNAPSHOT_MAX_BYTES,
  TRIAL_TIMEZONE_MAX,
  TRIAL_VENUE_MAX,
  trialStatus,
  trialTerms,
  validateTrialStats,
} from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import { requirePlatformAction } from './platform.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A flat character class: a grouped repetition over megabytes overflows the regexp backtracking stack.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::bigint`;

const invalid = (code: string, message: string): CloudError => new CloudError(422, code, message);
const trialNotFound = (): CloudError => new CloudError(404, 'TRIAL_NOT_FOUND', 'Пробная версия не найдена');
const badToken = (): CloudError => new CloudError(401, 'UNAUTHORIZED', 'Ключ пробной версии не подходит');

interface TrialRow {
  id: string;
  venue: string;
  manager_name: string;
  status: string;
  started_at: number | string;
  ends_at: number | string;
  last_seen_at: number | string | null;
  stats: TrialStats | string | null;
  snapshot_at: number | string | null;
  snapshot_bytes: number | string | null;
}

const VIEW_COLUMNS = `id::text AS id, venue, manager_name, status, ${ms('started_at')} AS started_at, ${ms('ends_at')} AS ends_at,
  ${ms('last_seen_at')} AS last_seen_at, stats, ${ms('snapshot_at')} AS snapshot_at, snapshot_bytes`;

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function viewOf(r: TrialRow, now: number): TrialView {
  const endsAt = Number(r.ends_at);
  return {
    id: r.id,
    venue: r.venue,
    managerName: r.manager_name,
    startedAt: Number(r.started_at),
    endsAt,
    status: trialStatus({ status: r.status, endsAt }, now),
    lastSeenAt: num(r.last_seen_at),
    stats: typeof r.stats === 'string' ? (JSON.parse(r.stats) as TrialStats) : r.stats,
    snapshotAt: num(r.snapshot_at),
    snapshotBytes: num(r.snapshot_bytes),
  };
}

async function trialRow(db: SqlDriver, id: string): Promise<TrialRow> {
  if (!UUID_RE.test(id)) throw trialNotFound();
  const rows = await db.all<TrialRow>(`SELECT ${VIEW_COLUMNS} FROM trials WHERE id = ?::uuid`, [id]);
  if (!rows[0]) throw trialNotFound();
  return rows[0];
}

/** Counts an attempt under `key`; 429 past `perHour` attempts within the last hour. */
async function countAttempt(db: SqlDriver, now: number, key: string, perHour: number, message: string): Promise<void> {
  const hash = sha256(`ts-trial:${key}`);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM trial_attempts WHERE at < ?', [now - HOUR_MS]);
    const rows = await tx.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM trial_attempts WHERE key_hash = ? AND at > ?', [hash, now - HOUR_MS]);
    if (Number(rows[0]?.n ?? 0) >= perHour) throw new CloudError(429, 'RATE_LIMITED', message);
    await tx.run('INSERT INTO trial_attempts (id, key_hash, at) VALUES (?, ?, ?)', [randomUUID(), hash, now]);
  });
}

const optionalText = (v: unknown, max: number, field: string): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw invalid('TRIAL_INVALID', `${field}: нужна строка`);
  const s = v.trim();
  if (s.length > max) throw invalid('TRIAL_INVALID', `${field}: не больше ${max} символов`);
  return s;
};

// ---------------------------------------------------------------------------
// The public side: the trial itself

/** POST /trial/start: a new trial for TRIAL_DEFAULT_DAYS; the token is returned once and kept as sha256. */
export async function startTrial(db: SqlDriver, now: number, raw: unknown, ip: string): Promise<TrialStartResponse> {
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужно название заведения');
  const venue = typeof raw.venue === 'string' ? raw.venue.trim() : '';
  if (!venue || venue.length > TRIAL_VENUE_MAX) throw invalid('VENUE_INVALID', `Название заведения: от 1 до ${TRIAL_VENUE_MAX} символов`);
  const managerName = optionalText(raw.managerName, TRIAL_NAME_MAX, 'managerName');
  const timezone = optionalText(raw.timezone, TRIAL_TIMEZONE_MAX, 'timezone') || null;
  await countAttempt(db, now, `start:ip:${ip}`, TRIAL_RATE.startsPerIpHour, 'Слишком много пробных версий с этого адреса. Попробуйте через час');

  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const endsAt = now + TRIAL_DEFAULT_DAYS * DAY_MS;
  await db.run(
    `INSERT INTO trials (id, venue, manager_name, timezone, token_hash, status, started_at, ends_at, last_seen_at, created_ip)
     VALUES (?::uuid, ?, ?, ?, ?, 'active', ?::timestamptz, ?::timestamptz, ?::timestamptz, ?)`,
    [id, venue, managerName, timezone, sha256(token), iso(now), iso(endsAt), iso(now), ip],
  );
  return { id, token, startedAt: now, endsAt, status: 'active' };
}

/** The trial `id` whose token is `token`: 404 for an unknown id, 401 for a missing or wrong token. */
async function authorizedTrial(db: SqlDriver, id: unknown, token: string | null): Promise<TrialRow> {
  if (!token) throw badToken();
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw trialNotFound();
  const rows = await db.all<TrialRow & { token_hash: string }>(`SELECT ${VIEW_COLUMNS}, token_hash FROM trials WHERE id = ?::uuid`, [id]);
  const row = rows[0];
  if (!row) throw trialNotFound();
  const given = Buffer.from(sha256(token), 'hex');
  const stored = Buffer.from(row.token_hash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw badToken();
  return row;
}

/** Decoded size of a snapshot; 422 when it is not base64, 413 when it is too big. */
function snapshotSize(v: unknown): number {
  const badSnapshot = (): CloudError => invalid('SNAPSHOT_INVALID', 'snapshot: base64 базы SQLite');
  if (typeof v !== 'string' || v.length === 0 || v.length % 4 !== 0) throw badSnapshot();
  const bytes = (v.length / 4) * 3 - (v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0);
  if (bytes > TRIAL_SNAPSHOT_MAX_BYTES) {
    throw new CloudError(413, 'SNAPSHOT_TOO_LARGE', `Снимок базы больше ${Math.round(TRIAL_SNAPSHOT_MAX_BYTES / 1024 / 1024)} МБ`);
  }
  if (!BASE64_RE.test(v)) throw badSnapshot();
  return bytes;
}

/** POST /trial/report: stores the counters (and the snapshot, when given); answers the terms. */
export async function reportTrial(db: SqlDriver, now: number, token: string | null, raw: unknown): Promise<TrialTerms> {
  const body = isObject(raw) ? raw : {};
  const row = await authorizedTrial(db, body.id, token);
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужны id и stats');
  await countAttempt(db, now, `report:${row.id}`, TRIAL_RATE.reportsPerTrialHour, 'Слишком частые отчёты пробной версии. Попробуйте позже');
  const problems = validateTrialStats(raw.stats);
  if (problems.length) throw invalid('STATS_INVALID', problems.slice(0, 5).join('; '));
  const stats = JSON.stringify(cleanTrialStats(raw.stats as TrialStats));
  if (raw.snapshot !== undefined && raw.snapshot !== null) {
    const bytes = snapshotSize(raw.snapshot);
    await db.run(
      `UPDATE trials SET last_seen_at = ?::timestamptz, stats = ?::jsonb, snapshot = decode(?, 'base64'),
         snapshot_at = ?::timestamptz, snapshot_bytes = ? WHERE id = ?::uuid`,
      [iso(now), stats, raw.snapshot, iso(now), bytes, row.id],
    );
  } else {
    await db.run('UPDATE trials SET last_seen_at = ?::timestamptz, stats = ?::jsonb WHERE id = ?::uuid', [iso(now), stats, row.id]);
  }
  return trialTerms({ status: row.status, endsAt: Number(row.ends_at) }, now);
}

/** GET /trial/terms?id=: the trial's status and end (a sign of life: last_seen_at is updated). */
export async function trialTermsOf(db: SqlDriver, now: number, token: string | null, id: string | null): Promise<TrialTerms> {
  const row = await authorizedTrial(db, id, token);
  await db.run('UPDATE trials SET last_seen_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), row.id]);
  return trialTerms({ status: row.status, endsAt: Number(row.ends_at) }, now);
}

// ---------------------------------------------------------------------------
// The platform side (`platform` function, same rights as the clients: view / clients.edit)

export async function listTrials(db: SqlDriver, now: number, me: PlatformMe): Promise<{ trials: TrialView[] }> {
  requirePlatformAction(me, 'platform.view');
  const rows = await db.all<TrialRow>(`SELECT ${VIEW_COLUMNS} FROM trials ORDER BY started_at DESC, id`);
  return { trials: rows.map((r) => viewOf(r, now)) };
}

/** endsAt = max(endsAt, now) + days; the trial is active again (also after «end»). */
export async function extendTrial(db: SqlDriver, now: number, me: PlatformMe, id: string, raw: unknown): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const days = isObject(raw) ? raw.days : undefined;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > TRIAL_EXTEND_MAX_DAYS) {
    throw invalid('DAYS_INVALID', `Продлить можно на 1–${TRIAL_EXTEND_MAX_DAYS} дней`);
  }
  return db.transaction(async (tx) => {
    const row = await trialRow(tx, id);
    const endsAt = Math.max(Number(row.ends_at), now) + days * DAY_MS;
    await tx.run(`UPDATE trials SET status = 'active', ends_at = ?::timestamptz WHERE id = ?::uuid`, [iso(endsAt), row.id]);
    return viewOf(await trialRow(tx, row.id), now);
  });
}

/** Ends the trial now: status 'ended', endsAt = now. */
export async function endTrial(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  return db.transaction(async (tx) => {
    const row = await trialRow(tx, id);
    await tx.run(`UPDATE trials SET status = 'ended', ends_at = ?::timestamptz WHERE id = ?::uuid`, [iso(now), row.id]);
    return viewOf(await trialRow(tx, row.id), now);
  });
}

/** The last SQLite snapshot the trial sent, base64; 404 when it never sent one. */
export async function trialSnapshot(db: SqlDriver, me: PlatformMe, id: string): Promise<{ snapshot: string; snapshotAt: number }> {
  requirePlatformAction(me, 'platform.view');
  await trialRow(db, id);
  const rows = await db.all<{ snapshot: string | null; snapshot_at: number | string | null }>(
    `SELECT encode(snapshot, 'base64') AS snapshot, ${ms('snapshot_at')} AS snapshot_at FROM trials WHERE id = ?::uuid`,
    [id],
  );
  const r = rows[0];
  if (!r || r.snapshot === null || r.snapshot_at === null) throw new CloudError(404, 'SNAPSHOT_NOT_FOUND', 'Снимка базы от этой пробной версии ещё не было');
  return { snapshot: r.snapshot.replace(/\s+/g, ''), snapshotAt: Number(r.snapshot_at) };
}
