/**
 * «У меня уже есть TS — войти» in the cloud (Supabase only: migration 20261103200000_trial_move.sql).
 * The rules and types are packages/domain/src/trial-move.ts. Here: «Код кофейни» (issued once per trial, kept
 * only as sha256, regenerable by the cash desk), moving the cash desk to another computer (a right code → a
 * move ticket → optionally a fresh copy from the on-line desk → finish: the snapshot and a new token, the old
 * token retired), and «Касса перенесена» (410) for a retired token. Runtime-neutral (node:crypto only).
 *
 * One cash desk at a time: the trial row has exactly one token_hash. Finishing a move locks the row
 * (SELECT … FOR UPDATE), checks that no other move finished since the ticket was made (desk_gen), swaps the
 * token and bumps desk_gen in one transaction — and hands out the snapshot inside that same transaction, so a
 * report the old desk sends a moment later is refused (its token is retired) and can never overwrite it.
 * Codes and tickets never appear in URLs or logs.
 *
 * A request waiting for TS (pending / rejected, apps/cloud/src/trial.ts) sends no reports, so it has no copy
 * and gets no café code: there is nothing to move until TS approves it. A move keeps whatever status the trial
 * has (active, permanent, ended…). It also forgets the old browser's installId: /trial/start with it can never
 * hand that browser the cash desk back (it would be a new request).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TrialCafeCode, TrialMoveFinish, TrialMoveStart, TrialMoveState, TrialReportMoveAnswer, TrialTerms } from '@bills/domain';
import {
  CAFE_CODE_BYTES,
  cafeCodeFromBytes,
  cafeCodeHashInput,
  CAFE_CODE_WRONG_MESSAGE,
  MOVE_EXPIRED_MESSAGE,
  MOVE_NO_SNAPSHOT_MESSAGE,
  MOVE_SUPERSEDED_MESSAGE,
  moveSnapshotFresh,
  normalizeCafeCode,
  TRIAL_MOVE,
  TRIAL_MOVE_RATE,
  TRIAL_MOVED_MESSAGE,
  trialTerms,
  trialWaiting,
} from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_RE = /^[A-Za-z0-9_-]{40,64}$/;

const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::bigint`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

const trialNotFound = (): CloudError => new CloudError(404, 'TRIAL_NOT_FOUND', 'Пробная версия не найдена');
const badTrialToken = (): CloudError => new CloudError(401, 'UNAUTHORIZED', 'Ключ пробной версии не подходит');
const wrongCode = (): CloudError => new CloudError(401, 'CAFE_CODE_WRONG', CAFE_CODE_WRONG_MESSAGE);
const badTicket = (): CloudError => new CloudError(401, 'MOVE_TICKET_INVALID', MOVE_EXPIRED_MESSAGE);

/** sha256 of a rate-limit key, the same scheme as apps/cloud/src/trial.ts (one table, trial_attempts). */
const attemptHash = (key: string): string => sha256(`ts-trial:${key}`);

async function attemptsWithinHour(db: SqlDriver, now: number, hash: string): Promise<number> {
  const rows = await db.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM trial_attempts WHERE key_hash = ? AND at > ?', [hash, now - HOUR_MS]);
  return Number(rows[0]?.n ?? 0);
}

const noteAttempt = (db: SqlDriver, now: number, hash: string): Promise<number> =>
  db.run('INSERT INTO trial_attempts (id, key_hash, at) VALUES (?, ?, ?)', [randomUUID(), hash, now]);

/** Counts an attempt under `key`; 429 past `perHour` attempts within the last hour. */
async function countAttempt(db: SqlDriver, now: number, key: string, perHour: number, message: string): Promise<void> {
  const hash = attemptHash(key);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM trial_attempts WHERE at < ?', [now - HOUR_MS]);
    if ((await attemptsWithinHour(tx, now, hash)) >= perHour) throw new CloudError(429, 'RATE_LIMITED', message);
    await noteAttempt(tx, now, hash);
  });
}

/** Equal hex hashes, compared in constant time. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const codeHash = (code: string): string => sha256(cafeCodeHashInput(code));

// ---------------------------------------------------------------------------
// The cash desk: its own token

/** The trial `id` whose token is `token`: 404 for an unknown id, 401 for a missing or wrong token. */
async function authorizedTrial(db: SqlDriver, id: unknown, token: string | null): Promise<{ id: string; status: string }> {
  if (!token) throw badTrialToken();
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw trialNotFound();
  const rows = await db.all<{ id: string; token_hash: string; status: string }>(
    'SELECT id::text AS id, token_hash, status FROM trials WHERE id = ?::uuid',
    [id],
  );
  const row = rows[0];
  if (!row) throw trialNotFound();
  if (!sameHash(sha256(token), row.token_hash)) throw badTrialToken();
  return { id: row.id, status: row.status };
}

/** A new café code for the trial: drawn at random, stored as sha256 (a clash with another trial's code is drawn again). */
async function issueCode(db: SqlDriver, now: number, trialId: string): Promise<string> {
  for (let i = 0; ; i++) {
    const code = cafeCodeFromBytes(randomBytes(CAFE_CODE_BYTES));
    try {
      await db.run('UPDATE trials SET code_hash = ?, code_at = ?::timestamptz WHERE id = ?::uuid', [codeHash(code), iso(now), trialId]);
      return code;
    } catch (e) {
      if (i < 3 && (e as { code?: unknown }).code === '23505') continue;
      throw e;
    }
  }
}

/** POST /trial/code {id}: «Сменить код» (or «Получить код») — a new café code, returned once; the old one stops working. */
export async function regenerateCafeCode(db: SqlDriver, now: number, token: string | null, raw: unknown): Promise<TrialCafeCode> {
  const trial = await authorizedTrial(db, isObject(raw) ? raw.id : undefined, token);
  if (trialWaiting(trial.status)) throw new CloudError(409, 'TRIAL_NOT_APPROVED', 'Код кофейни появится, когда TS подтвердит заявку');
  const trialId = trial.id;
  await countAttempt(db, now, `code:${trialId}`, TRIAL_MOVE_RATE.codesPerTrialHour, 'Код кофейни меняли слишком часто. Попробуйте через час');
  return { cafeCode: await issueCode(db, now, trialId) };
}

/**
 * The move part of POST /trial/report's answer, after reportTrial accepted the report (so `raw.id` is the
 * trial the token belongs to): a report with a snapshot answers a pending «send a fresh copy»; a report
 * without one is asked for it (`sendSnapshot`); a desk that has no café code (`needCode`) gets one when the
 * trial has none yet — existing trials get theirs this way. A desk that lost its code uses «Сменить код».
 */
export async function withMove<T extends TrialTerms>(db: SqlDriver, now: number, raw: unknown, answer: T): Promise<T & TrialReportMoveAnswer> {
  const body = isObject(raw) ? raw : {};
  const id = body.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return answer;
  const rows = await db.all<{ code_hash: string | null; status: string; wanted: number | string | null; snapshot_at: number | string | null }>(
    `SELECT code_hash, status, ${ms('snapshot_wanted_at')} AS wanted, ${ms('snapshot_at')} AS snapshot_at FROM trials WHERE id = ?::uuid`,
    [id],
  );
  const row = rows[0];
  if (!row) return answer;
  const out: T & TrialReportMoveAnswer = { ...answer };
  const wanted = num(row.wanted);
  if (wanted !== null) {
    const snapshotAt = num(row.snapshot_at);
    if (snapshotAt !== null && snapshotAt >= wanted) {
      await db.run('UPDATE trials SET snapshot_wanted_at = NULL WHERE id = ?::uuid AND snapshot_wanted_at <= snapshot_at', [id]);
    } else if (now - wanted < TRIAL_MOVE.wantedMs) {
      out.sendSnapshot = true;
    }
  }
  if (body.needCode === true && row.code_hash === null && !trialWaiting(row.status)) {
    const hash = attemptHash(`code:${id}`);
    if ((await attemptsWithinHour(db, now, hash)) < TRIAL_MOVE_RATE.codesPerTrialHour) {
      await noteAttempt(db, now, hash);
      out.cafeCode = await issueCode(db, now, id);
    }
  }
  return out;
}

/**
 * A refused /trial/report or /trial/terms whose token was retired by a move becomes 410 TRIAL_MOVED
 * («Касса перенесена на другой компьютер») instead of «wrong key»; anything else is passed on.
 */
export async function movedError(db: SqlDriver, err: unknown, token: string | null, id: unknown): Promise<unknown> {
  if (!(err instanceof CloudError) || err.status !== 401 || !token || typeof id !== 'string' || !UUID_RE.test(id)) return err;
  const rows = await db.all<{ x: number }>('SELECT 1 AS x FROM trial_retired_tokens WHERE token_hash = ? AND trial_id = ?::uuid', [sha256(token), id]);
  return rows.length ? new CloudError(410, 'TRIAL_MOVED', TRIAL_MOVED_MESSAGE) : err;
}

// ---------------------------------------------------------------------------
// The new computer: the café code, then a move ticket

interface TrialMoveRow {
  id: string;
  venue: string;
  manager_name: string;
  status: string;
  started_at: number | string;
  ends_at: number | string;
  last_seen_at: number | string | null;
  snapshot_at: number | string | null;
  snapshot_wanted_at: number | string | null;
  desk_gen: number | string;
  code_hash: string | null;
  token_hash: string;
  owner_message: string | null;
}

const TRIAL_MOVE_COLUMNS = `id::text AS id, venue, manager_name, status, ${ms('started_at')} AS started_at, ${ms('ends_at')} AS ends_at,
  ${ms('last_seen_at')} AS last_seen_at, ${ms('snapshot_at')} AS snapshot_at, ${ms('snapshot_wanted_at')} AS snapshot_wanted_at,
  desk_gen, code_hash, token_hash, owner_message`;

/**
 * POST /trial/move/start {code}: the café code typed on the new computer. 429 past 30 attempts or 10 wrong
 * codes an hour from one address, or 10 moves an hour of one trial; a wrong or malformed code is 401
 * CAFE_CODE_WRONG and says nothing about which cafés exist. A right code gives a ticket (once, kept as sha256);
 * when the old cash desk was heard from within TRIAL_MOVE.onlineMs it is asked for a fresh copy (its signal or
 * next report says so) and the new computer waits for a snapshot newer than `requestedAt`.
 */
export async function startMove(db: SqlDriver, now: number, raw: unknown, ip: string): Promise<TrialMoveStart> {
  const wrongKey = attemptHash(`move-wrong:ip:${ip}`);
  if ((await attemptsWithinHour(db, now, wrongKey)) >= TRIAL_MOVE_RATE.wrongCodesPerIpHour) {
    throw new CloudError(429, 'RATE_LIMITED', 'Слишком много неверных кодов с этого адреса. Попробуйте через час');
  }
  await countAttempt(db, now, `move-ip:${ip}`, TRIAL_MOVE_RATE.startsPerIpHour, 'Слишком много попыток с этого адреса. Попробуйте через час');
  const code = normalizeCafeCode(isObject(raw) ? raw.code : undefined);
  // A malformed code is hashed and looked up like any other: the same answer, the same path.
  const given = codeHash(code ?? `invalid:${randomUUID()}`);
  const rows = await db.all<TrialMoveRow>(`SELECT ${TRIAL_MOVE_COLUMNS} FROM trials WHERE code_hash = ?`, [given]);
  const row = rows[0];
  if (!code || !row || row.code_hash === null || !sameHash(given, row.code_hash)) {
    await noteAttempt(db, now, wrongKey);
    throw wrongCode();
  }
  await countAttempt(db, now, `move-trial:${row.id}`, TRIAL_MOVE_RATE.startsPerTrialHour, 'Слишком много переносов за час. Попробуйте позже');

  const ticket = randomBytes(TRIAL_MOVE.ticketBytes).toString('base64url');
  const lastSeenAt = num(row.last_seen_at);
  const snapshotAt = num(row.snapshot_at);
  const online = lastSeenAt !== null && now - lastSeenAt < TRIAL_MOVE.onlineMs;
  // Already fresh enough? A copy taken since the desk was last heard from needs no new request.
  const requestedAt = online ? now : null;
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM trial_moves WHERE trial_id = ?::uuid AND created_at < ?::timestamptz', [row.id, iso(now - DAY_MS)]);
    await tx.run(
      `INSERT INTO trial_moves (id, trial_id, token_hash, desk_gen, created_at, requested_at, created_ip)
       VALUES (?::uuid, ?::uuid, ?, ?, ?::timestamptz, ?::timestamptz, ?)`,
      [randomUUID(), row.id, sha256(ticket), Number(row.desk_gen), iso(now), requestedAt === null ? null : iso(requestedAt), ip],
    );
    if (requestedAt !== null) {
      await tx.run('UPDATE trials SET snapshot_wanted_at = ?::timestamptz WHERE id = ?::uuid', [iso(requestedAt), row.id]);
    }
  });
  return { ticket, venue: row.venue, wait: online, requestedAt, snapshotAt, lastSeenAt };
}

interface TicketRow {
  move_id: string;
  trial_id: string;
  desk_gen: number | string;
  created_at: number | string;
  requested_at: number | string | null;
  finished_at: number | string | null;
}

/** The ticket behind `token`: 429 after too many unknown tickets from this address, 401 for an unknown one, 410 for an expired one. */
async function ticketOf(db: SqlDriver, now: number, token: string | null, ip: string): Promise<TicketRow> {
  const failKey = attemptHash(`move-badticket:ip:${ip}`);
  if ((await attemptsWithinHour(db, now, failKey)) >= TRIAL_MOVE_RATE.badTicketsPerIpHour) {
    throw new CloudError(429, 'RATE_LIMITED', 'Слишком много попыток с этого адреса. Попробуйте через час');
  }
  const rows =
    token && TICKET_RE.test(token)
      ? await db.all<TicketRow>(
          `SELECT id::text AS move_id, trial_id::text AS trial_id, desk_gen, ${ms('created_at')} AS created_at,
                  ${ms('requested_at')} AS requested_at, ${ms('finished_at')} AS finished_at
             FROM trial_moves WHERE token_hash = ?`,
          [sha256(token)],
        )
      : [];
  const t = rows[0];
  if (!t) {
    await noteAttempt(db, now, failKey);
    throw badTicket();
  }
  if (num(t.finished_at) !== null || now - Number(t.created_at) > TRIAL_MOVE.ticketMs) {
    throw new CloudError(410, 'MOVE_EXPIRED', MOVE_EXPIRED_MESSAGE);
  }
  return t;
}

/** GET /trial/move (Bearer ticket): has the fresh copy come, did another computer take over? */
export async function moveState(db: SqlDriver, now: number, token: string | null, ip: string): Promise<TrialMoveState> {
  const t = await ticketOf(db, now, token, ip);
  await countAttempt(db, now, `move-check:${t.move_id}`, TRIAL_MOVE_RATE.checksPerTicketHour, 'Слишком частые проверки. Подождите немного');
  const rows = await db.all<TrialMoveRow>(`SELECT ${TRIAL_MOVE_COLUMNS} FROM trials WHERE id = ?::uuid`, [t.trial_id]);
  const row = rows[0];
  if (!row) throw badTicket();
  const requestedAt = num(t.requested_at);
  const snapshotAt = num(row.snapshot_at);
  return {
    venue: row.venue,
    requestedAt,
    snapshotAt,
    lastSeenAt: num(row.last_seen_at),
    fresh: moveSnapshotFresh(snapshotAt, requestedAt),
    superseded: Number(row.desk_gen) !== Number(t.desk_gen),
  };
}

/**
 * POST /trial/move/finish (Bearer ticket) {acceptOlder?}: this computer becomes the cash desk. In one
 * transaction with the trial row locked: 409 MOVE_SUPERSEDED when another move finished since the ticket was
 * made; 404 SNAPSHOT_NOT_FOUND without a copy; 409 MOVE_NOT_FRESH when the desk was asked for a fresh copy,
 * it has not come and the person did not agree to the older one. Then a new token replaces the old (which is
 * retired: that desk is told «Касса перенесена»), desk_gen goes up and the snapshot is handed out.
 */
export async function finishMove(db: SqlDriver, now: number, token: string | null, raw: unknown, ip: string): Promise<TrialMoveFinish> {
  const t = await ticketOf(db, now, token, ip);
  const acceptOlder = isObject(raw) && raw.acceptOlder === true;
  return db.transaction(async (tx) => {
    const rows = await tx.all<TrialMoveRow>(`SELECT ${TRIAL_MOVE_COLUMNS} FROM trials WHERE id = ?::uuid FOR UPDATE`, [t.trial_id]);
    const row = rows[0];
    if (!row) throw badTicket();
    // The ticket again, under the lock: two finishes of one ticket cannot both pass.
    const again = await tx.all<{ finished_at: number | string | null }>(`SELECT ${ms('finished_at')} AS finished_at FROM trial_moves WHERE id = ?::uuid FOR UPDATE`, [
      t.move_id,
    ]);
    if (!again[0] || num(again[0].finished_at) !== null) throw new CloudError(410, 'MOVE_EXPIRED', MOVE_EXPIRED_MESSAGE);
    if (Number(row.desk_gen) !== Number(t.desk_gen)) throw new CloudError(409, 'MOVE_SUPERSEDED', MOVE_SUPERSEDED_MESSAGE);
    const snapshotAt = num(row.snapshot_at);
    if (snapshotAt === null) throw new CloudError(404, 'SNAPSHOT_NOT_FOUND', MOVE_NO_SNAPSHOT_MESSAGE);
    const requestedAt = num(t.requested_at);
    if (requestedAt !== null && !moveSnapshotFresh(snapshotAt, requestedAt) && !acceptOlder) {
      throw new CloudError(409, 'MOVE_NOT_FRESH', 'Свежие данные со старого компьютера ещё не пришли');
    }
    const snap = await tx.all<{ snapshot: string | null }>(`SELECT encode(snapshot, 'base64') AS snapshot FROM trials WHERE id = ?::uuid`, [row.id]);
    const snapshot = snap[0]?.snapshot;
    if (!snapshot) throw new CloudError(404, 'SNAPSHOT_NOT_FOUND', MOVE_NO_SNAPSHOT_MESSAGE);

    const newToken = randomBytes(32).toString('base64url');
    await tx.run(
      `INSERT INTO trial_retired_tokens (token_hash, trial_id, retired_at) VALUES (?, ?::uuid, ?::timestamptz) ON CONFLICT (token_hash) DO NOTHING`,
      [row.token_hash, row.id, iso(now)],
    );
    await tx.run(
      `UPDATE trials SET token_hash = ?, desk_gen = desk_gen + 1, moved_at = ?::timestamptz, snapshot_wanted_at = NULL,
         last_seen_at = ?::timestamptz, install_hash = NULL WHERE id = ?::uuid`,
      [sha256(newToken), iso(now), iso(now), row.id],
    );
    await tx.run('UPDATE trial_moves SET finished_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), t.move_id]);
    return {
      id: row.id,
      token: newToken,
      venue: row.venue,
      managerName: row.manager_name,
      startedAt: Number(row.started_at),
      snapshot: snapshot.replace(/\s+/g, ''),
      snapshotAt,
      // The moving page is a current one: the terms in full (permanent stays permanent).
      ...trialTerms({ status: row.status, endsAt: Number(row.ends_at), ownerMessage: row.owner_message }, now),
    };
  });
}
