/**
 * The coffee shop's browser trial in the cloud (Supabase only: migration 20261029000000_trials.sql).
 * The rules and types are packages/domain/src/trial.ts; here — storage, the public calls of the Edge
 * Function `trial` (start, report, terms) and the platform's calls of `platform` (list, extend, end,
 * snapshot). Runtime-neutral (node:crypto only). Times are timestamptz in the table, ms in the API.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  PlatformMe,
  TrialPlan,
  TrialPublicView,
  TrialSnapshotEncoding,
  TrialStartResponse,
  TrialStats,
  TrialSummary,
  TrialTerms,
  TrialTransferCode,
  TrialTransferResponse,
  TrialView,
  TrialViewLink,
} from '@bills/domain';
import {
  cleanTrialStats,
  cleanTrialSummary,
  formatTransferCode,
  normalizeTransferCode,
  PAID_FOREVER_AT,
  PAID_MAX_DAYS,
  TRIAL_MOVED_MESSAGE,
  TRIAL_TRANSFER_ALPHABET,
  TRIAL_TRANSFER_LENGTH,
  TRIAL_TRANSFER_TTL_MS,
  validateTrialSummary,
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
  plan: string;
  paid_until: number | string | null;
  summary_at: number | string | null;
  view_link: boolean;
}

const VIEW_COLUMNS = `id::text AS id, venue, manager_name, status, ${ms('started_at')} AS started_at, ${ms('ends_at')} AS ends_at,
  ${ms('last_seen_at')} AS last_seen_at, stats, ${ms('snapshot_at')} AS snapshot_at, snapshot_bytes,
  plan, ${ms('paid_until')} AS paid_until, ${ms('summary_at')} AS summary_at, (view_token_hash IS NOT NULL) AS view_link`;

const planOf = (v: string): TrialPlan => (v === 'paid' ? 'paid' : 'trial');

/** The terms a trial row gives its cash register now. */
function termsOf(r: TrialRow, now: number): TrialTerms {
  return trialTerms({ status: r.status, endsAt: Number(r.ends_at), plan: r.plan, paidUntil: num(r.paid_until), snapshotAt: num(r.snapshot_at) }, now);
}

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
    plan: planOf(r.plan),
    paidUntil: planOf(r.plan) === 'paid' ? num(r.paid_until) : null,
    summaryAt: num(r.summary_at),
    viewLink: r.view_link === true || (r.view_link as unknown) === 't',
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

/**
 * The trial `id` whose token is `token`: 404 for an unknown id, 401 for a missing or wrong token,
 * 409 TRIAL_MOVED for a token a transfer retired (the coffee shop now runs on another device).
 */
async function authorizedTrial(db: SqlDriver, id: unknown, token: string | null): Promise<TrialRow> {
  if (!token) throw badToken();
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw trialNotFound();
  const rows = await db.all<TrialRow & { token_hash: string }>(`SELECT ${VIEW_COLUMNS}, token_hash FROM trials WHERE id = ?::uuid`, [id]);
  const row = rows[0];
  if (!row) throw trialNotFound();
  const hash = sha256(token);
  const given = Buffer.from(hash, 'hex');
  const stored = Buffer.from(row.token_hash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    const moved = await db.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM trial_moved_tokens WHERE token_hash = ? AND trial_id = ?::uuid', [hash, row.id]);
    if (Number(moved[0]?.n ?? 0) > 0) throw new CloudError(409, 'TRIAL_MOVED', TRIAL_MOVED_MESSAGE);
    throw badToken();
  }
  return row;
}

const GZIP_B64 = 'H4sI'; // 1f 8b 08 — a gzip stream with deflate

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

function snapshotEncodingOf(v: unknown): TrialSnapshotEncoding {
  if (v === undefined || v === null || v === 'raw') return 'raw';
  if (v === 'gzip') return 'gzip';
  throw invalid('SNAPSHOT_INVALID', "snapshotEncoding: 'raw' или 'gzip'");
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
  let summary: string | null = null;
  if (raw.summary !== undefined && raw.summary !== null) {
    const bad = validateTrialSummary(raw.summary);
    if (bad.length) throw invalid('SUMMARY_INVALID', bad.slice(0, 5).join('; '));
    summary = JSON.stringify(cleanTrialSummary(raw.summary as TrialSummary));
  }
  const sets = ['last_seen_at = ?::timestamptz', 'stats = ?::jsonb'];
  const params: unknown[] = [iso(now), stats];
  if (summary !== null) {
    sets.push('summary = ?::jsonb', 'summary_at = ?::timestamptz');
    params.push(summary, iso(now));
  }
  let snapshotAt = num(row.snapshot_at);
  if (raw.snapshot !== undefined && raw.snapshot !== null) {
    const encoding = snapshotEncodingOf(raw.snapshotEncoding);
    const bytes = snapshotSize(raw.snapshot);
    if (encoding === 'gzip' && !(raw.snapshot as string).startsWith(GZIP_B64)) throw invalid('SNAPSHOT_INVALID', 'snapshot: это не gzip');
    // One copy per trial: the latest replaces the previous one.
    sets.push("snapshot = decode(?, 'base64')", 'snapshot_at = ?::timestamptz', 'snapshot_bytes = ?', 'snapshot_encoding = ?');
    params.push(raw.snapshot, iso(now), bytes, encoding);
    snapshotAt = now;
  }
  params.push(row.id);
  await db.run(`UPDATE trials SET ${sets.join(', ')} WHERE id = ?::uuid`, params);
  return termsOf({ ...row, snapshot_at: snapshotAt }, now);
}

/** GET /trial/terms?id=: the trial's status and end (a sign of life: last_seen_at is updated). */
export async function trialTermsOf(db: SqlDriver, now: number, token: string | null, id: string | null): Promise<TrialTerms> {
  const row = await authorizedTrial(db, id, token);
  await db.run('UPDATE trials SET last_seen_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), row.id]);
  return termsOf(row, now);
}

/** A random code of TRIAL_TRANSFER_ALPHABET (rejection sampling: every letter equally likely). */
function newTransferCode(): string {
  const n = TRIAL_TRANSFER_ALPHABET.length;
  const limit = Math.floor(256 / n) * n;
  let code = '';
  while (code.length < TRIAL_TRANSFER_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < limit && code.length < TRIAL_TRANSFER_LENGTH) code += TRIAL_TRANSFER_ALPHABET[b % n];
    }
  }
  return code;
}

const transferHash = (code: string): string => sha256(`ts-transfer:${code}`);
const viewHash = (token: string): string => sha256(`ts-trial-view:${token}`);
const noSnapshot = (): CloudError =>
  new CloudError(409, 'NO_SNAPSHOT', 'В облаке ещё нет копии этой кофейни. Откройте её на старом устройстве с интернетом и подождите минуту.');

/**
 * POST /trial/transfer-code {id} (Bearer): a new 8-letter code for «Перенести на другое устройство»,
 * valid TRIAL_TRANSFER_TTL_MS; a new code replaces the previous one. Needs a copy in the cloud.
 */
export async function createTransferCode(db: SqlDriver, now: number, token: string | null, raw: unknown): Promise<TrialTransferCode> {
  const body = isObject(raw) ? raw : {};
  const row = await authorizedTrial(db, body.id, token);
  await countAttempt(db, now, `links:${row.id}`, TRIAL_RATE.linksPerTrialHour, 'Слишком много кодов за час. Попробуйте позже');
  if (row.snapshot_at === null) throw noSnapshot();
  const expiresAt = now + TRIAL_TRANSFER_TTL_MS;
  for (let attempt = 0; ; attempt++) {
    const code = newTransferCode();
    try {
      await db.run('UPDATE trials SET transfer_code_hash = ?, transfer_expires_at = ?::timestamptz WHERE id = ?::uuid', [transferHash(code), iso(expiresAt), row.id]);
      return { code: formatTransferCode(code), expiresAt };
    } catch (e) {
      // The same code at another trial (unique index): try another one.
      if (attempt >= 3) throw e;
    }
  }
}

/**
 * POST /trial/transfer {code}: opens the coffee shop on a new device. Every attempt counts against the
 * address (TRIAL_RATE.transferPerIpHour). The code is used once; the trial gets a new token and the old
 * one goes to trial_moved_tokens, so the old device hears TRIAL_MOVED on its next call.
 */
export async function transferTrial(db: SqlDriver, now: number, raw: unknown, ip: string): Promise<TrialTransferResponse> {
  await countAttempt(db, now, `transfer:ip:${ip}`, TRIAL_RATE.transferPerIpHour, 'Слишком много попыток ввести код. Попробуйте через час');
  const text = isObject(raw) && typeof raw.code === 'string' ? raw.code : '';
  const code = normalizeTransferCode(text);
  const wrong = (): CloudError => new CloudError(404, 'TRANSFER_CODE_INVALID', 'Код не подходит или устарел. Получите новый на старом устройстве');
  if (!code) throw wrong();
  const hash = transferHash(code);
  return db.transaction(async (tx) => {
    const rows = await tx.all<TrialRow & { token_hash: string; snapshot64: string | null; snapshot_encoding: string }>(
      `SELECT ${VIEW_COLUMNS}, token_hash, encode(snapshot, 'base64') AS snapshot64, snapshot_encoding FROM trials
       WHERE transfer_code_hash = ? AND transfer_expires_at > ?::timestamptz`,
      [hash, iso(now)],
    );
    const row = rows[0];
    if (!row) throw wrong();
    if (row.snapshot64 === null || row.snapshot_at === null) throw noSnapshot();
    const token = randomBytes(32).toString('base64url');
    const changed = await tx.run(
      `UPDATE trials SET token_hash = ?, transfer_code_hash = NULL, transfer_expires_at = NULL, last_seen_at = ?::timestamptz
       WHERE id = ?::uuid AND transfer_code_hash = ?`,
      [sha256(token), iso(now), row.id, hash],
    );
    if (changed !== 1) throw wrong();
    await tx.run('INSERT INTO trial_moved_tokens (token_hash, trial_id, moved_at) VALUES (?, ?::uuid, ?::timestamptz) ON CONFLICT (token_hash) DO NOTHING', [
      row.token_hash,
      row.id,
      iso(now),
    ]);
    return {
      id: row.id,
      token,
      venue: row.venue,
      managerName: row.manager_name,
      startedAt: Number(row.started_at),
      terms: termsOf(row, now),
      snapshot: row.snapshot64.replace(/\s+/g, ''),
      snapshotEncoding: row.snapshot_encoding === 'gzip' ? 'gzip' : 'raw',
      snapshotAt: Number(row.snapshot_at),
    };
  });
}

/**
 * POST /trial/view-link {id, off?} (Bearer): a new token of the phone page (the previous one stops
 * working), or {token: null} with `off: true`. The token is returned once and kept as sha256.
 */
export async function trialViewLink(db: SqlDriver, now: number, token: string | null, raw: unknown): Promise<TrialViewLink> {
  const body = isObject(raw) ? raw : {};
  const row = await authorizedTrial(db, body.id, token);
  if (body.off === true) {
    await db.run('UPDATE trials SET view_token_hash = NULL WHERE id = ?::uuid', [row.id]);
    return { token: null };
  }
  await countAttempt(db, now, `links:${row.id}`, TRIAL_RATE.linksPerTrialHour, 'Слишком много новых ссылок за час. Попробуйте позже');
  const view = randomBytes(24).toString('base64url');
  await db.run('UPDATE trials SET view_token_hash = ? WHERE id = ?::uuid', [viewHash(view), row.id]);
  return { token: view };
}

/** GET /trial/view (Bearer: the view token): the latest owner's summary only — nothing else of the trial. */
export async function trialPublicView(db: SqlDriver, now: number, viewToken: string | null, ip: string): Promise<TrialPublicView> {
  await countAttempt(db, now, `view:ip:${ip}`, TRIAL_RATE.viewsPerIpHour, 'Слишком часто. Обновите страницу через несколько минут');
  const gone = (): CloudError => new CloudError(404, 'VIEW_NOT_FOUND', 'Ссылка не работает: её выключили или заменили новой');
  if (!viewToken || viewToken.length > 100) throw gone();
  const rows = await db.all<{ venue: string; summary: TrialSummary | string | null; summary_at: number | string | null; last_seen_at: number | string | null; plan: string; status: string; ends_at: number | string }>(
    `SELECT venue, summary, ${ms('summary_at')} AS summary_at, ${ms('last_seen_at')} AS last_seen_at, plan, status, ${ms('ends_at')} AS ends_at
     FROM trials WHERE view_token_hash = ?`,
    [viewHash(viewToken)],
  );
  const r = rows[0];
  if (!r) throw gone();
  return {
    venue: r.venue,
    summary: typeof r.summary === 'string' ? (JSON.parse(r.summary) as TrialSummary) : r.summary,
    summaryAt: num(r.summary_at),
    lastSeenAt: num(r.last_seen_at),
    plan: planOf(r.plan),
    status: trialStatus({ status: r.status, endsAt: Number(r.ends_at) }, now),
  };
}

// ---------------------------------------------------------------------------
// The platform side (`platform` function, same rights as the clients: view / clients.edit)

export async function listTrials(db: SqlDriver, now: number, me: PlatformMe): Promise<{ trials: TrialView[] }> {
  requirePlatformAction(me, 'platform.view');
  const rows = await db.all<TrialRow>(`SELECT ${VIEW_COLUMNS} FROM trials ORDER BY started_at DESC, id`);
  return { trials: rows.map((r) => viewOf(r, now)) };
}

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * «Продлить»: `{days}` → endsAt = max(endsAt, now) + days; `{until}` → endsAt = until («Продлить до…»).
 * The trial is active again (also after «end»). A paid plan moves paidUntil with it; a paid plan
 * without an end has nothing to extend (409 PAID_NO_END).
 */
export async function extendTrial(db: SqlDriver, now: number, me: PlatformMe, id: string, raw: unknown): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const days = isObject(raw) ? raw.days : undefined;
  const until = isObject(raw) ? raw.until : undefined;
  if (until === undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > TRIAL_EXTEND_MAX_DAYS)) {
    throw invalid('DAYS_INVALID', `Продлить можно на 1–${TRIAL_EXTEND_MAX_DAYS} дней`);
  }
  return db.transaction(async (tx) => {
    const row = await trialRow(tx, id);
    const paid = planOf(row.plan) === 'paid';
    if (paid && row.paid_until === null) throw new CloudError(409, 'PAID_NO_END', 'Постоянная версия без срока: продлевать не нужно');
    let endsAt: number;
    if (until !== undefined) {
      const maxDays = paid ? PAID_MAX_DAYS : TRIAL_EXTEND_MAX_DAYS;
      const max = (paid ? now : Math.max(Number(row.ends_at), now)) + maxDays * DAY_MS;
      if (!isMs(until) || until <= now || until > max) throw invalid('UNTIL_INVALID', `Дата — в будущем и не дальше ${maxDays} дней`);
      endsAt = until;
    } else {
      endsAt = Math.max(Number(row.ends_at), now) + (days as number) * DAY_MS;
    }
    await tx.run(`UPDATE trials SET status = 'active', ends_at = ?::timestamptz, paid_until = ?::timestamptz WHERE id = ?::uuid`, [
      iso(endsAt),
      paid ? iso(endsAt) : null,
      row.id,
    ]);
    return viewOf(await trialRow(tx, row.id), now);
  });
}

/**
 * «Сделать постоянной»: `{plan: 'paid', paidUntil}` — paid until a date, or without an end (null; endsAt
 * becomes PAID_FOREVER_AT). `{plan: 'trial', days}` — back to a trial of `days` from now. Either way active.
 */
export async function setTrialPlan(db: SqlDriver, now: number, me: PlatformMe, id: string, raw: unknown): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const body = isObject(raw) ? raw : {};
  let plan: TrialPlan;
  let endsAt: number;
  let paidUntil: number | null = null;
  if (body.plan === 'paid') {
    plan = 'paid';
    if (body.paidUntil === null || body.paidUntil === undefined) {
      endsAt = PAID_FOREVER_AT;
    } else {
      if (!isMs(body.paidUntil) || body.paidUntil <= now || body.paidUntil > now + PAID_MAX_DAYS * DAY_MS) {
        throw invalid('UNTIL_INVALID', `Дата оплаты — в будущем и не дальше ${PAID_MAX_DAYS} дней`);
      }
      paidUntil = body.paidUntil;
      endsAt = paidUntil;
    }
  } else if (body.plan === 'trial') {
    plan = 'trial';
    const days = body.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > TRIAL_EXTEND_MAX_DAYS) {
      throw invalid('DAYS_INVALID', `Пробный период — на 1–${TRIAL_EXTEND_MAX_DAYS} дней`);
    }
    endsAt = now + days * DAY_MS;
  } else {
    throw invalid('PLAN_INVALID', "plan: 'trial' или 'paid'");
  }
  return db.transaction(async (tx) => {
    const row = await trialRow(tx, id);
    await tx.run(`UPDATE trials SET plan = ?, status = 'active', ends_at = ?::timestamptz, paid_until = ?::timestamptz WHERE id = ?::uuid`, [
      plan,
      iso(endsAt),
      paidUntil === null ? null : iso(paidUntil),
      row.id,
    ]);
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
export async function trialSnapshot(
  db: SqlDriver,
  me: PlatformMe,
  id: string,
): Promise<{ snapshot: string; snapshotAt: number; encoding: TrialSnapshotEncoding }> {
  requirePlatformAction(me, 'platform.view');
  await trialRow(db, id);
  const rows = await db.all<{ snapshot: string | null; snapshot_at: number | string | null; snapshot_encoding: string }>(
    `SELECT encode(snapshot, 'base64') AS snapshot, ${ms('snapshot_at')} AS snapshot_at, snapshot_encoding FROM trials WHERE id = ?::uuid`,
    [id],
  );
  const r = rows[0];
  if (!r || r.snapshot === null || r.snapshot_at === null) throw new CloudError(404, 'SNAPSHOT_NOT_FOUND', 'Снимка базы от этой пробной версии ещё не было');
  return { snapshot: r.snapshot.replace(/\s+/g, ''), snapshotAt: Number(r.snapshot_at), encoding: r.snapshot_encoding === 'gzip' ? 'gzip' : 'raw' };
}
