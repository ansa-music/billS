/**
 * «Облачная касса» for the coffee shop's browser trial (Supabase only: migration 20261104000000_trial_cloud.sql).
 * The rules and types are packages/domain/src/cloud-cafe.ts; the Worker's admin API is ./cloud-hub.ts.
 *
 * «Перевести в облако» (a trial TS approved: active, expired, ended or permanent):
 *   1. start  — the on-line cash desk is asked for a fresh copy (snapshot_wanted_at: its 30-second signal and its next
 *               report say «send it», the same mechanism as moving the cash desk to another computer);
 *   2. state  — the cabinet looks every 3 s for up to 75 s whether it came; an off-line desk is not waited for and the
 *               cabinet shows the time of the last copy;
 *   3. finish — the copy is imported (importCafe), the link is stored on the trial, the browser's token is retired
 *               (it is told «Касса переехала в облако» with the link, 410 TRIAL_MOVED + `cloud`) and the cloud café
 *               gets the trial's terms.
 * «Подтвердить в облаке» (a request): a new empty café with the request's venue, manager and sample menu; the
 *   request becomes an active trial of 14 days in the cloud; its waiting page gets the link and the director's key.
 * The terms (extend, end date, permanent, end) follow to the cloud café; a failure is kept and shown with «Повторить».
 *
 * One trial — one cloud café, never two: a claim (cloud_busy_at, in a transaction with the row locked) stops a second
 * click while the first talks to the Worker; a trial already in the cloud answers its existing link. Runtime-neutral.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CloudCafeTerms, PlatformMe, TrialCloudApproved, TrialCloudMoveState, TrialView } from '@bills/domain';
import {
  CLOUD_HUB_NOT_CONFIGURED_MESSAGE,
  cloudTermsOf,
  moveSnapshotFresh,
  TRIAL_DEFAULT_DAYS,
  TRIAL_MOVE,
  trialTimeZone,
  trialWaiting,
} from '@bills/domain';
import type { CloudHub } from './cloud-hub.ts';
import { cloudHubNotConfigured } from './cloud-hub.ts';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import { requirePlatformAction } from './platform.ts';
import { cloudBusyError, trialCloudFacts } from './trial.ts';

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::bigint`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Equal hex hashes, compared in constant time. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const notApproved = (): CloudError =>
  new CloudError(409, 'TRIAL_NOT_APPROVED', 'Это заявка: для неё — «Подтвердить в облаке». Переводят в облако пробную версию, которая уже работала');
const noCopy = (): CloudError =>
  new CloudError(
    404,
    'SNAPSHOT_NOT_FOUND',
    'Касса ещё не присылала данные — переводить нечего. Попросите открыть TS на кассе с интернетом и подождите пару минут.',
  );

/** The hub, or 409 «Облачная касса ещё не подключена». */
function hubOf(hub: CloudHub | null): CloudHub {
  if (!hub) throw cloudHubNotConfigured();
  return hub;
}

async function stateOf(db: SqlDriver, now: number, id: string): Promise<TrialCloudMoveState> {
  const f = await trialCloudFacts(db, now, id);
  return {
    requestedAt: f.cloudWantedAt,
    snapshotAt: f.view.snapshotAt,
    lastSeenAt: f.view.lastSeenAt,
    fresh: moveSnapshotFresh(f.view.snapshotAt, f.cloudWantedAt),
    cloud: f.view.cloud,
  };
}

/**
 * POST /platform/trials/:id/cloud/start: a cash desk heard from within TRIAL_MOVE.onlineMs is asked for a fresh copy
 * now (requestedAt); an off-line one is not (requestedAt null — the cabinet offers the last copy). A trial already in
 * the cloud answers its link (`cloud`); a request is 409 (it is approved into the cloud instead).
 */
export async function startCloudMove(db: SqlDriver, now: number, me: PlatformMe, id: string, hub: CloudHub | null): Promise<TrialCloudMoveState> {
  requirePlatformAction(me, 'clients.edit');
  const f = await trialCloudFacts(db, now, id);
  if (f.view.cloud) return stateOf(db, now, id);
  hubOf(hub);
  if (trialWaiting(f.view.status)) throw notApproved();
  if (f.busy) throw cloudBusyError();
  const online = f.view.lastSeenAt !== null && now - f.view.lastSeenAt < TRIAL_MOVE.onlineMs;
  await db.run(
    online
      ? 'UPDATE trials SET cloud_wanted_at = ?::timestamptz, snapshot_wanted_at = ?::timestamptz WHERE id = ?::uuid'
      : 'UPDATE trials SET cloud_wanted_at = NULL WHERE id = ?::uuid',
    online ? [iso(now), iso(now), f.view.id] : [f.view.id],
  );
  return stateOf(db, now, f.view.id);
}

/** GET /platform/trials/:id/cloud: has the fresh copy come (and is the trial in the cloud already)? */
export async function cloudMoveState(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<TrialCloudMoveState> {
  requirePlatformAction(me, 'platform.view');
  return stateOf(db, now, id);
}

/** Claims the trial for a talk with the Worker (cloud_busy_at); `check` refuses inside the same locked transaction. */
async function claim(db: SqlDriver, now: number, id: string, check: (f: Awaited<ReturnType<typeof trialCloudFacts>>) => void): Promise<Awaited<ReturnType<typeof trialCloudFacts>> | null> {
  return db.transaction(async (tx) => {
    const f = await trialCloudFacts(tx, now, id, true);
    if (f.view.cloud) return null;
    if (f.busy) throw cloudBusyError();
    check(f);
    await tx.run('UPDATE trials SET cloud_busy_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), f.view.id]);
    return f;
  });
}

const release = (db: SqlDriver, id: string): Promise<number> => db.run('UPDATE trials SET cloud_busy_at = NULL WHERE id = ?::uuid', [id]);

/**
 * POST /platform/trials/:id/cloud {acceptOlder?}: the move itself. The trial's latest copy goes to the Worker
 * (409 CLOUD_NOT_FRESH when the cash desk was asked for a fresh one, it has not come and the person did not agree to
 * the older one; 404 SNAPSHOT_NOT_FOUND without any copy). Then, in one transaction: the link is stored, the browser's
 * token is retired (and its café code, install id and move tickets stop working), so it takes no more orders and is
 * told where the café went. The terms follow (a failure is kept on the trial, not thrown). A trial already in the
 * cloud answers as it is (`imported: false`).
 */
export async function moveTrialToCloud(
  db: SqlDriver,
  now: number,
  me: PlatformMe,
  id: string,
  raw: unknown,
  hub: CloudHub | null,
): Promise<{ view: TrialView; imported: boolean }> {
  requirePlatformAction(me, 'clients.edit');
  const acceptOlder = isObject(raw) && raw.acceptOlder === true;
  const already = await trialCloudFacts(db, now, id);
  if (already.view.cloud) return { view: already.view, imported: false };
  const worker = hubOf(hub);
  const f = await claim(db, now, id, (x) => {
    if (trialWaiting(x.view.status)) throw notApproved();
    if (x.view.snapshotAt === null) throw noCopy();
    if (x.cloudWantedAt !== null && !moveSnapshotFresh(x.view.snapshotAt, x.cloudWantedAt) && !acceptOlder) {
      throw new CloudError(409, 'CLOUD_NOT_FRESH', 'Свежие данные с кассы ещё не пришли');
    }
  });
  if (!f) return { view: (await trialCloudFacts(db, now, id)).view, imported: false };
  const trialId = f.view.id;
  let code: string;
  try {
    const rows = await db.all<{ snapshot: string | null; snapshot_at: number | string | null }>(
      `SELECT encode(snapshot, 'base64') AS snapshot, ${ms('snapshot_at')} AS snapshot_at FROM trials WHERE id = ?::uuid`,
      [trialId],
    );
    const snapshot = rows[0]?.snapshot?.replace(/\s+/g, '');
    if (!snapshot) throw noCopy();
    ({ code } = await worker.importCafe(snapshot, { idempotencyKey: `ts-trial-${trialId}-${Number(rows[0]!.snapshot_at)}` }));
  } catch (err) {
    await release(db, trialId);
    throw err;
  }
  await db.transaction(async (tx) => {
    const rows = await tx.all<{ token_hash: string }>('SELECT token_hash FROM trials WHERE id = ?::uuid FOR UPDATE', [trialId]);
    const tokenHash = rows[0]?.token_hash;
    if (tokenHash) {
      await tx.run(
        'INSERT INTO trial_retired_tokens (token_hash, trial_id, retired_at) VALUES (?, ?::uuid, ?::timestamptz) ON CONFLICT (token_hash) DO NOTHING',
        [tokenHash, trialId, iso(now)],
      );
    }
    await tx.run(
      `UPDATE trials SET cloud_code = ?, cloud_at = ?::timestamptz, cloud_origin = 'move', cloud_busy_at = NULL, cloud_wanted_at = NULL,
         cloud_terms_error = NULL, cloud_terms_at = NULL, token_hash = ?, desk_gen = desk_gen + 1, moved_at = ?::timestamptz,
         snapshot_wanted_at = NULL, install_hash = NULL, code_hash = NULL, cafe_code = NULL, director_key_next = NULL
       WHERE id = ?::uuid`,
      [code, iso(now), sha256(`ts-retired:${randomBytes(32).toString('base64url')}`), iso(now), trialId],
    );
    // A move to another computer half-way through can never finish now.
    await tx.run('UPDATE trial_moves SET finished_at = ?::timestamptz WHERE trial_id = ?::uuid AND finished_at IS NULL', [iso(now), trialId]);
  });
  return { view: await syncCloudTerms(db, now, trialId, worker), imported: true };
}

/**
 * POST /platform/trials/:id/approve-cloud: a request (pending, or rejected after all) becomes a new café in the cloud
 * cash desk — the request's venue and manager, the sample menu when the welcome form asked for it (yes for requests
 * from before that was sent), the request's zone — and an active trial of TRIAL_DEFAULT_DAYS from now. The browser
 * café on the waiting page was only the form: nothing of it moves. The director's key is answered once here and kept
 * for the waiting page (cloud_key) until it says it saved it. A trial already in the cloud answers its link (and the
 * key while its page has not fetched it).
 */
export async function approveTrialInCloud(db: SqlDriver, now: number, me: PlatformMe, id: string, hub: CloudHub | null): Promise<TrialCloudApproved<TrialView>> {
  requirePlatformAction(me, 'clients.edit');
  const already = await trialCloudFacts(db, now, id);
  if (already.view.cloud) return { trial: already.view, managerKey: await keptKey(db, already.view.id) };
  const worker = hubOf(hub);
  const f = await claim(db, now, id, (x) => {
    if (!trialWaiting(x.view.status)) throw new CloudError(409, 'TRIAL_NOT_PENDING', 'Заявка уже подтверждена: эту пробную версию переводят в облако кнопкой «Перевести в облако»');
  });
  if (!f) {
    const view = (await trialCloudFacts(db, now, id)).view;
    return { trial: view, managerKey: await keptKey(db, view.id) };
  }
  const trialId = f.view.id;
  let created: { code: string; managerKey: string };
  try {
    created = await worker.createCafe({
      venue: f.view.venue,
      managerName: f.view.managerName.trim() || 'Директор',
      withMenu: f.withMenu ?? true,
      timezone: trialTimeZone(f.view.timezone),
    });
  } catch (err) {
    await release(db, trialId);
    throw err;
  }
  await db.run(
    `UPDATE trials SET status = 'active', started_at = ?::timestamptz, ends_at = ?::timestamptz, decided_at = ?::timestamptz, owner_message = NULL,
       cloud_code = ?, cloud_at = ?::timestamptz, cloud_origin = 'new', cloud_key = ?, cloud_busy_at = NULL, cloud_wanted_at = NULL,
       cloud_terms_error = NULL, cloud_terms_at = NULL, code_hash = NULL, cafe_code = NULL, snapshot_wanted_at = NULL,
       director_key = ?, director_key_at = ?::timestamptz, director_key_stale = false, director_key_next = NULL, director_key_refused = false
     WHERE id = ?::uuid`,
    [iso(now), iso(now + TRIAL_DEFAULT_DAYS * DAY_MS), iso(now), created.code, iso(now), created.managerKey, created.managerKey, iso(now), trialId],
  );
  return { trial: await syncCloudTerms(db, now, trialId, worker), managerKey: created.managerKey };
}

async function keptKey(db: SqlDriver, id: string): Promise<string | null> {
  const rows = await db.all<{ cloud_key: string | null }>('SELECT cloud_key FROM trials WHERE id = ?::uuid', [id]);
  return rows[0]?.cloud_key ?? null;
}

/**
 * Sends the trial's terms to its cloud café (PUT …/terms) and notes how it went: cloud_terms_at on success,
 * cloud_terms_error (the Worker's words, or «ещё не подключена») on failure — the cabinet then shows a warning and
 * «Повторить». Never throws for the Worker: the change in the cabinet stands either way. A trial not in the cloud is
 * answered as it is.
 */
export async function syncCloudTerms(db: SqlDriver, now: number, id: string, hub: CloudHub | null): Promise<TrialView> {
  const f = await trialCloudFacts(db, now, id);
  if (!f.view.cloud) return f.view;
  const terms: CloudCafeTerms = cloudTermsOf(f.terms);
  let error: string | null = null;
  if (!hub) {
    error = CLOUD_HUB_NOT_CONFIGURED_MESSAGE;
  } else {
    try {
      await hub.putTerms(f.view.cloud.code, terms);
    } catch (err) {
      error = err instanceof CloudError ? err.message : `Облачная касса: ${(err as Error)?.message ?? String(err)}`;
    }
  }
  if (error === null) {
    await db.run('UPDATE trials SET cloud_terms_error = NULL, cloud_terms_at = ?::timestamptz WHERE id = ?::uuid', [iso(now), f.view.id]);
  } else {
    await db.run('UPDATE trials SET cloud_terms_error = ? WHERE id = ?::uuid', [error.slice(0, 500), f.view.id]);
  }
  return (await trialCloudFacts(db, now, f.view.id)).view;
}

/** POST /platform/trials/:id/cloud/terms: «Повторить» — the terms go to the cloud café again; 409 for a trial not in the cloud. */
export async function retryCloudTerms(db: SqlDriver, now: number, me: PlatformMe, id: string, hub: CloudHub | null): Promise<TrialView> {
  requirePlatformAction(me, 'clients.edit');
  const f = await trialCloudFacts(db, now, id);
  if (!f.view.cloud) throw new CloudError(409, 'TRIAL_NOT_IN_CLOUD', 'Эта пробная версия не в облачной кассе');
  return syncCloudTerms(db, now, f.view.id, hub);
}

/**
 * POST /trial/cloud/seen {id} (Bearer trial token): the waiting page of a request approved into the cloud saved the
 * director's key. The cloud forgets the key and retires the token: from now on the page is told only where the café
 * is (410 TRIAL_MOVED with `cloud`). 401 for a wrong token, 409 for a trial not in the cloud.
 */
export async function trialCloudSeen(db: SqlDriver, now: number, token: string | null, raw: unknown): Promise<{ ok: true }> {
  const id = isObject(raw) ? raw.id : undefined;
  if (!token) throw new CloudError(401, 'UNAUTHORIZED', 'Ключ пробной версии не подходит');
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new CloudError(404, 'TRIAL_NOT_FOUND', 'Пробная версия не найдена');
  return db.transaction(async (tx) => {
    const rows = await tx.all<{ token_hash: string; cloud_code: string | null }>('SELECT token_hash, cloud_code FROM trials WHERE id = ?::uuid FOR UPDATE', [id]);
    const row = rows[0];
    if (!row) throw new CloudError(404, 'TRIAL_NOT_FOUND', 'Пробная версия не найдена');
    if (!sameHash(row.token_hash, sha256(token))) throw new CloudError(401, 'UNAUTHORIZED', 'Ключ пробной версии не подходит');
    if (!row.cloud_code) throw new CloudError(409, 'TRIAL_NOT_IN_CLOUD', 'Эта пробная версия не в облачной кассе');
    await tx.run(
      'INSERT INTO trial_retired_tokens (token_hash, trial_id, retired_at) VALUES (?, ?::uuid, ?::timestamptz) ON CONFLICT (token_hash) DO NOTHING',
      [row.token_hash, id, iso(now)],
    );
    await tx.run(
      'UPDATE trials SET cloud_key = NULL, token_hash = ?, desk_gen = desk_gen + 1, install_hash = NULL, code_hash = NULL, cafe_code = NULL WHERE id = ?::uuid',
      [sha256(`ts-retired:${randomBytes(32).toString('base64url')}`), id],
    );
    return { ok: true as const };
  });
}
