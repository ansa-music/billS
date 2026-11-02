/**
 * The coffee shop's browser trial in the cloud (Supabase only: migrations 20261029000000_trials.sql,
 * 20261103100000_trial_requests.sql). The rules and types are packages/domain/src/trial.ts; here — storage,
 * the public calls of the Edge Function `trial` (start, report, terms) and the platform's calls of `platform`
 * (list, approve, reject, permanent, extend, end date, end, delete, snapshot). Runtime-neutral (node:crypto
 * only). Times are timestamptz in the table, ms in the API.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PlatformMe, TrialStartResponse, TrialStats, TrialStatus, TrialTerms, TrialView } from '@bills/domain';
import {
  cleanTrialStats,
  isTrialInstallId,
  isValidTimeZone,
  legacyTrialTerms,
  TRIAL_DEFAULT_DAYS,
  TRIAL_EXTEND_MAX_DAYS,
  TRIAL_MESSAGE_MAX,
  TRIAL_NAME_MAX,
  TRIAL_RATE,
  TRIAL_RELOAD_ID,
  TRIAL_RELOAD_MESSAGE,
  TRIAL_RELOAD_TOKEN,
  TRIAL_SNAPSHOT_MAX_BYTES,
  TRIAL_TERMS_VERSION,
  TRIAL_TIMEZONE_MAX,
  TRIAL_VENUE_MAX,
  trialDayEnd,
  trialDuplicates,
  trialEndDate,
  trialRejectMessage,
  trialStartedAt,
  trialStatus,
  trialTerms,
  trialTimeZone,
  trialWaiting,
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
const conflict = (code: string, message: string): CloudError => new CloudError(409, code, message);
const stillRequest = (): CloudError => conflict('TRIAL_NOT_APPROVED', 'Это заявка: сначала подтвердите её (или сделайте постоянной)');

interface TrialRow {
  id: string;
  venue: string;
  manager_name: string;
  timezone: string | null;
  status: string;
  started_at: number | string;
  ends_at: number | string;
  last_seen_at: number | string | null;
  stats: TrialStats | string | null;
  snapshot_at: number | string | null;
  snapshot_bytes: number | string | null;
  requested_at: number | string | null;
  decided_at: number | string | null;
  owner_message: string | null;
}

const VIEW_COLUMNS = `id::text AS id, venue, manager_name, timezone, status, ${ms('started_at')} AS started_at, ${ms('ends_at')} AS ends_at,
  ${ms('last_seen_at')} AS last_seen_at, stats, ${ms('snapshot_at')} AS snapshot_at, snapshot_bytes,
  ${ms('requested_at')} AS requested_at, ${ms('decided_at')} AS decided_at, owner_message`;

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function viewOf(r: TrialRow, now: number): TrialView {
  const endsAt = Number(r.ends_at);
  return {
    id: r.id,
    venue: r.venue,
    managerName: r.manager_name,
    timezone: trialTimeZone(r.timezone),
    startedAt: Number(r.started_at),
    endsAt,
    status: trialStatus({ status: r.status, endsAt }, now),
    lastSeenAt: num(r.last_seen_at),
    stats: typeof r.stats === 'string' ? (JSON.parse(r.stats) as TrialStats) : r.stats,
    snapshotAt: num(r.snapshot_at),
    snapshotBytes: num(r.snapshot_bytes),
    requestedAt: num(r.requested_at),
    decidedAt: num(r.decided_at),
    ownerMessage: r.owner_message,
    duplicateOf: null,
  };
}

const termsOfRow = (r: TrialRow, now: number): TrialTerms =>
  trialTerms({ status: r.status, endsAt: Number(r.ends_at), ownerMessage: r.owner_message }, now);

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

const newToken = (): string => randomBytes(32).toString('base64url');
const installHash = (installId: string): string => sha256(`ts-trial-install:${installId}`);

// ---------------------------------------------------------------------------
// The public side: the trial itself

/** What startTrial did: a new request (tell the platform owner), the same trial again, or an old page. */
export interface TrialStartOutcome {
  answer: TrialStartResponse;
  /** The new request (201, notify the platform owner); null when nothing new was stored. */
  created: TrialView | null;
  /** A page from before requests (no installId): answered TRIAL_RELOAD_ID, nothing stored. */
  legacy: boolean;
}

/**
 * POST /trial/start: a request for a trial ('pending'), keyed by the browser's installId. The token is
 * returned once and kept as sha256. The same installId again (the answer was lost, the page retried)
 * returns that trial with a new token — the installId is the browser's secret, like the token — and
 * stores nothing new. A page without an installId is one from before requests (its `parseTerms` drops
 * 'pending' and it would start again and again): it is told TRIAL_RELOAD_ID «ended, reload» and nothing
 * is stored. The 14 days count from the approval; `startedAt` is only checked.
 */
export async function startTrial(db: SqlDriver, now: number, raw: unknown, ip: string): Promise<TrialStartOutcome> {
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужно название заведения');
  const venue = typeof raw.venue === 'string' ? raw.venue.trim() : '';
  if (!venue || venue.length > TRIAL_VENUE_MAX) throw invalid('VENUE_INVALID', `Название заведения: от 1 до ${TRIAL_VENUE_MAX} символов`);
  const managerName = optionalText(raw.managerName, TRIAL_NAME_MAX, 'managerName');
  // An unknown zone is not worth refusing the start over: the trial's days are then Almaty's.
  const zone = optionalText(raw.timezone, TRIAL_TIMEZONE_MAX, 'timezone');
  const timezone = zone && isValidTimeZone(zone) ? zone : null;
  if (trialStartedAt(raw.startedAt, now) === null) throw invalid('STARTED_AT_INVALID', 'startedAt: время начала пробного периода в мс');

  if (raw.installId === undefined || raw.installId === null) {
    return {
      answer: { id: TRIAL_RELOAD_ID, token: TRIAL_RELOAD_TOKEN, startedAt: now, status: 'ended', endsAt: now, message: TRIAL_RELOAD_MESSAGE },
      created: null,
      legacy: true,
    };
  }
  if (!isTrialInstallId(raw.installId)) throw invalid('INSTALL_ID_INVALID', 'installId: 16–64 символа A–Z a–z 0–9 _ -');
  const hash = installHash(raw.installId);
  const again = await sameInstall(db, now, hash);
  if (again) return { answer: again, created: null, legacy: false };

  await countAttempt(db, now, `start:ip:${ip}`, TRIAL_RATE.startsPerIpHour, 'Слишком много заявок с этого адреса. Попробуйте через час');
  const id = randomUUID();
  const token = newToken();
  // Placeholders until the approval: the term starts then.
  const endsAt = now + TRIAL_DEFAULT_DAYS * DAY_MS;
  const added = await db.run(
    `INSERT INTO trials (id, venue, manager_name, timezone, token_hash, status, started_at, ends_at, last_seen_at, created_ip, install_hash, requested_at)
     VALUES (?::uuid, ?, ?, ?, ?, 'pending', ?::timestamptz, ?::timestamptz, ?::timestamptz, ?, ?, ?::timestamptz)
     ON CONFLICT (install_hash) WHERE install_hash IS NOT NULL DO NOTHING`,
    [id, venue, managerName, timezone, sha256(token), iso(now), iso(endsAt), iso(now), ip, hash, iso(now)],
  );
  if (added === 0) {
    // The same browser's start that raced this one stored it first.
    const raced = await sameInstall(db, now, hash);
    if (raced) return { answer: raced, created: null, legacy: false };
    throw new CloudError(409, 'TRIAL_CONFLICT', 'Заявка уже отправляется. Попробуйте ещё раз');
  }
  const row = await trialRow(db, id);
  return { answer: { id, token, startedAt: now, ...termsOfRow(row, now) }, created: viewOf(row, now), legacy: false };
}

/** The trial of this installId with a fresh token (the old one stops working), or null. */
async function sameInstall(db: SqlDriver, now: number, hash: string): Promise<TrialStartResponse | null> {
  const rows = await db.all<TrialRow>(`SELECT ${VIEW_COLUMNS} FROM trials WHERE install_hash = ?`, [hash]);
  const row = rows[0];
  if (!row) return null;
  const token = newToken();
  await db.run('UPDATE trials SET token_hash = ?, last_seen_at = ?::timestamptz WHERE id = ?::uuid', [sha256(token), iso(now), row.id]);
  return { id: row.id, token, startedAt: Number(row.started_at), ...termsOfRow(row, now) };
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

/** The terms for this page: in full for a current one (`v: 2`), in the old three words for an older one. */
function termsFor(row: TrialRow, now: number, version: unknown): TrialTerms {
  const terms = termsOfRow(row, now);
  return Number(version) === TRIAL_TERMS_VERSION ? terms : legacyTrialTerms(terms, now);
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

/** POST /trial/report: stores the counters (and the snapshot, when given); answers the terms (`v: 2` → all of them). */
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
  return termsFor(row, now, raw.v);
}

/**
 * GET /trial/terms?id=&v=2: the trial's status and end (a sign of life: last_seen_at is updated). A waiting
 * page asks it every half a minute; without `v=2` the answer is in the old words (legacyTrialTerms).
 */
export async function trialTermsOf(db: SqlDriver, now: number, token: string | null, id: string | null, version: string | null = null): Promise<TrialTerms> {
  const row = await authorizedTrial(db, id, token);
  await db.run('UPDATE trials SET last_seen_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), row.id]);
  return termsFor(row, now, version);
}

// ---------------------------------------------------------------------------
// The platform side (`platform` function, same rights as the clients: view / clients.edit)

/** Every trial (requests first, newest first; then by start, newest first), each with its «похоже на повтор». */
async function allTrials(db: SqlDriver, now: number): Promise<TrialView[]> {
  const rows = await db.all<TrialRow & { created_ip: string | null }>(
    `SELECT ${VIEW_COLUMNS}, created_ip FROM trials
     ORDER BY (status = 'pending') DESC, COALESCE(requested_at, started_at) DESC, id`,
  );
  const views = rows.map((r) => viewOf(r, now));
  const repeats = trialDuplicates(
    rows.map((r, i) => ({
      id: r.id,
      venue: r.venue,
      managerName: r.manager_name,
      ip: r.created_ip,
      status: views[i]!.status,
      startedAt: Number(r.started_at),
      createdAt: Number(r.requested_at ?? r.started_at),
    })),
  );
  return views.map((v) => ({ ...v, duplicateOf: repeats.get(v.id) ?? null }));
}

export async function listTrials(db: SqlDriver, now: number, me: PlatformMe): Promise<{ trials: TrialView[] }> {
  requirePlatformAction(me, 'platform.view');
  return { trials: await allTrials(db, now) };
}

/** One trial as the list shows it (with its «похоже на повтор»): for the notification of a new request. */
export async function trialWithDuplicate(db: SqlDriver, now: number, id: string): Promise<TrialView> {
  const view = (await allTrials(db, now)).find((v) => v.id === id);
  if (!view) throw trialNotFound();
  return view;
}

/** Changes one trial in a transaction and answers its new view; `change` throws to refuse. */
async function changeTrial(db: SqlDriver, now: number, id: string, change: (row: TrialRow, tx: SqlDriver) => Promise<void>): Promise<TrialView> {
  return db.transaction(async (tx) => {
    const row = await trialRow(tx, id);
    await change(row, tx);
    return viewOf(await trialRow(tx, row.id), now);
  });
}

/**
 * «Подтвердить»: a request (pending, or rejected after all) becomes an active trial of TRIAL_DEFAULT_DAYS
 * counted from now. 409 for a trial that already runs or ran.
 */
export async function approveTrial(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  return changeTrial(db, now, id, async (row, tx) => {
    if (!trialWaiting(row.status)) throw conflict('TRIAL_NOT_PENDING', 'Заявка уже подтверждена: срок меняют продлением или датой окончания');
    await tx.run(
      `UPDATE trials SET status = 'active', started_at = ?::timestamptz, ends_at = ?::timestamptz, decided_at = ?::timestamptz, owner_message = NULL
       WHERE id = ?::uuid`,
      [iso(now), iso(now + TRIAL_DEFAULT_DAYS * DAY_MS), iso(now), row.id],
    );
  });
}

/** «Отклонить» { message? }: a pending request is turned down; the page shows the message (≤ TRIAL_MESSAGE_MAX). */
export async function rejectTrial(db: SqlDriver, now: number, me: PlatformMe, id: string, raw: unknown): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const message = trialRejectMessage(isObject(raw) ? raw.message : undefined);
  if (message === undefined) throw invalid('MESSAGE_INVALID', `Сообщение клиенту: текст до ${TRIAL_MESSAGE_MAX} символов`);
  return changeTrial(db, now, id, async (row, tx) => {
    if (row.status !== 'pending') throw conflict('TRIAL_NOT_PENDING', 'Отклонить можно только новую заявку; идущую пробную версию — завершить');
    await tx.run(`UPDATE trials SET status = 'rejected', decided_at = ?::timestamptz, owner_message = ? WHERE id = ?::uuid`, [iso(now), message, row.id]);
  });
}

/**
 * «Сделать постоянной»: any trial (a request included) runs without an end date. A request starts now.
 * «Дата окончания» puts it back on a date (active), «Завершить» ends it.
 */
export async function makeTrialPermanent(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  return changeTrial(db, now, id, async (row, tx) => {
    if (row.status === 'permanent') return;
    const starts = trialWaiting(row.status);
    await tx.run(
      `UPDATE trials SET status = 'permanent', owner_message = NULL, decided_at = ?::timestamptz${starts ? ', started_at = ?::timestamptz' : ''}
       WHERE id = ?::uuid`,
      starts ? [iso(now), iso(now), row.id] : [iso(now), row.id],
    );
  });
}

/** endsAt = max(endsAt, now) + days (a permanent one: now + days); the trial is active again (also after «end»). */
export async function extendTrial(db: SqlDriver, now: number, me: PlatformMe, id: string, raw: unknown): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const days = isObject(raw) ? raw.days : undefined;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > TRIAL_EXTEND_MAX_DAYS) {
    throw invalid('DAYS_INVALID', `Продлить можно на 1–${TRIAL_EXTEND_MAX_DAYS} дней`);
  }
  return changeTrial(db, now, id, async (row, tx) => {
    if (trialWaiting(row.status)) throw stillRequest();
    const base = row.status === 'permanent' ? now : Math.max(Number(row.ends_at), now);
    await tx.run(`UPDATE trials SET status = 'active', ends_at = ?::timestamptz WHERE id = ?::uuid`, [iso(base + days * DAY_MS), row.id]);
  });
}

/**
 * { date: YYYY-MM-DD }: the trial runs through that calendar day of its own zone (endsAt = the day's
 * last millisecond there). Today … today + TRIAL_EXTEND_MAX_DAYS, so it may shorten as well as extend;
 * the end is always ahead, so an ended, expired or permanent trial is active (on a date) again.
 */
export async function setTrialEndDate(db: SqlDriver, now: number, me: PlatformMe, id: string, raw: unknown): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const date = isObject(raw) ? raw.date : undefined;
  return changeTrial(db, now, id, async (row, tx) => {
    if (trialWaiting(row.status)) throw stillRequest();
    const zone = trialTimeZone(row.timezone);
    const day = trialEndDate(date, now, zone);
    if (day === null) {
      throw invalid('DATE_INVALID', `Дата окончания: с сегодняшнего дня и не дальше чем на ${TRIAL_EXTEND_MAX_DAYS} дней вперёд`);
    }
    await tx.run(`UPDATE trials SET status = 'active', ends_at = ?::timestamptz WHERE id = ?::uuid`, [iso(trialDayEnd(day, zone)), row.id]);
  });
}

/** Ends the trial now: status 'ended', endsAt = now (a permanent one too). A request is rejected instead. */
export async function endTrial(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  return changeTrial(db, now, id, async (row, tx) => {
    if (trialWaiting(row.status)) throw conflict('TRIAL_NOT_APPROVED', 'Это заявка: её можно отклонить или удалить');
    await tx.run(`UPDATE trials SET status = 'ended', ends_at = ?::timestamptz WHERE id = ?::uuid`, [iso(now), row.id]);
  });
}

/** Statuses a trial may be deleted in: it does not run (a running one is ended first). */
const DELETABLE: ReadonlySet<TrialStatus> = new Set<TrialStatus>(['pending', 'rejected', 'ended', 'expired']);

/**
 * «Удалить»: the row goes with its snapshot and its watch links (trial_viewers cascade). Only a trial that
 * does not run — a request, a rejected one, an ended or expired one; 409 TRIAL_RUNNING for active / permanent.
 * The page of a deleted request then shows «Заявка удалена»; an ended one stays read-only.
 */
export async function deleteTrial(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<{ deleted: string; venue: string }> {
  requirePlatformAction(me, 'clients.edit');
  return db.transaction(async (tx) => {
    const row = await trialRow(tx, id);
    const status = trialStatus({ status: row.status, endsAt: Number(row.ends_at) }, now);
    if (!DELETABLE.has(status)) throw conflict('TRIAL_RUNNING', 'Пробная версия идёт: сначала завершите её, потом удаляйте');
    await tx.run('DELETE FROM trials WHERE id = ?::uuid', [row.id]);
    return { deleted: row.id, venue: row.venue };
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
