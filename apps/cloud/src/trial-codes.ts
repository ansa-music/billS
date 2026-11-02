/**
 * The café's codes for the platform owner (Supabase only: migration 20261104000000_trial_cloud.sql). The rules and
 * types are packages/domain/src/trial-codes.ts. The browser cash desk reports «Код кофейни» and the director's code
 * that works now (only when they change); the platform owner sees them behind «Показать» and can issue the director a
 * new code («Выдать новый код директора»): a browser cash desk installs it with the answer to its next report, a cloud
 * café gets it at once through the Worker (apps/cloud/src/cloud-hub.ts).
 *
 * Only the platform owner (role 'owner', not the support team) may see or issue codes. The codes live in service-only
 * columns of `trials` (RLS on, no grants), are never put in a URL and never logged. Runtime-neutral.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PlatformMe, TrialCodesView, TrialDirectorKeyIssued, TrialReportCodeAnswer, TrialView } from '@bills/domain';
import { cafeCodeHashInput, directorKeyFrom, parseReportCodes, trialWaiting } from '@bills/domain';
import type { CloudHub } from './cloud-hub.ts';
import { cloudHubNotConfigured } from './cloud-hub.ts';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import { trialCloudFacts } from './trial.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::bigint`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** Codes are for the platform owner only: the support team helps without them. */
export function requirePlatformOwner(me: PlatformMe): void {
  if (me.role !== 'owner') throw new CloudError(403, 'FORBIDDEN', 'Коды кофейни видит и меняет только владелец платформы');
}

interface CodesRow {
  status: string;
  code_hash: string | null;
  cafe_code: string | null;
  cloud_code: string | null;
  director_key: string | null;
  director_key_at: number | string | null;
  director_key_stale: boolean;
  director_key_next: string | null;
  director_key_refused: boolean;
}

const CODES_COLUMNS = `status, code_hash, cafe_code, cloud_code, director_key, ${ms('director_key_at')} AS director_key_at,
  director_key_stale, director_key_next, director_key_refused`;

/**
 * The codes part of POST /trial/report, after reportTrial accepted it (so `raw.id` is the token's trial; a café in
 * the cloud reports nothing here). Stores what the cash desk said — the café code only when it matches the hash the
 * cloud keeps, the director's code that works now (it clears TS's new code once that is what the desk reports), «the
 * code I knew stopped working», «TS's new code could not be installed» — and adds TS's new code to the answer while
 * it waits to be installed.
 */
export async function withCodes<T extends object>(db: SqlDriver, now: number, raw: unknown, answer: T): Promise<T & TrialReportCodeAnswer> {
  const body = isObject(raw) ? raw : {};
  const id = body.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return answer;
  const rows = await db.all<CodesRow>(`SELECT ${CODES_COLUMNS} FROM trials WHERE id = ?::uuid`, [id]);
  const row = rows[0];
  if (!row || row.cloud_code) return answer;
  const codes = parseReportCodes(body.codes);
  let next = row.director_key_next;
  if (codes) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (codes.cafeCode && row.code_hash && sha256(cafeCodeHashInput(codes.cafeCode)) === row.code_hash && codes.cafeCode !== row.cafe_code) {
      sets.push('cafe_code = ?');
      params.push(codes.cafeCode);
    }
    if (codes.directorKey) {
      sets.push('director_key = ?', 'director_key_at = ?::timestamptz', 'director_key_stale = false');
      params.push(codes.directorKey, iso(now));
      if (next && codes.directorKey === next) {
        sets.push('director_key_next = NULL', 'director_key_refused = false');
        next = null;
      }
    } else if (codes.directorKeyStale) {
      sets.push('director_key_stale = true');
    }
    if (codes.directorKeyRefused && next && codes.directorKeyRefused === next) {
      sets.push('director_key_next = NULL', 'director_key_refused = true');
      next = null;
    }
    if (sets.length) await db.run(`UPDATE trials SET ${sets.join(', ')} WHERE id = ?::uuid`, [...params, id]);
  }
  return next ? { ...answer, directorKeyNext: next } : answer;
}

/** GET /platform/trials/:id/codes: the café code and the director's code (the platform owner only). */
export async function trialCodes(db: SqlDriver, now: number, me: PlatformMe, id: string): Promise<{ codes: TrialCodesView; view: TrialView }> {
  requirePlatformOwner(me);
  const { view } = await trialCloudFacts(db, now, id);
  const rows = await db.all<CodesRow>(`SELECT ${CODES_COLUMNS} FROM trials WHERE id = ?::uuid`, [view.id]);
  const r = rows[0]!;
  return {
    view,
    codes: {
      cafeCode: r.cloud_code ?? r.cafe_code,
      cafeCodeKind: r.cloud_code ? 'cloud' : 'trial',
      directorKey: r.director_key,
      directorKeyAt: num(r.director_key_at),
      directorKeyStale: r.director_key_stale === true,
      directorKeyPending: r.director_key_next,
      directorKeyRefused: r.director_key_refused === true,
    },
  };
}

/**
 * POST /platform/trials/:id/director-key: «Выдать новый код директора» (the platform owner only). A cloud café gets
 * it now through the Worker (the director's other keys stop working there); a browser cash desk is sent it with the
 * answer to its next report and installs it in place of the director's keys. The code is answered once here.
 * 409 for a request (no café yet); 409 CLOUD_HUB_NOT_CONFIGURED for a cloud café without the Worker's secrets.
 */
export async function issueDirectorKey(
  db: SqlDriver,
  now: number,
  me: PlatformMe,
  id: string,
  hub: CloudHub | null,
): Promise<TrialDirectorKeyIssued<TrialView>> {
  requirePlatformOwner(me);
  const { view } = await trialCloudFacts(db, now, id);
  if (trialWaiting(view.status)) throw new CloudError(409, 'TRIAL_NOT_APPROVED', 'Это заявка: кассы ещё нет — сначала подтвердите её');
  if (view.cloud) {
    if (!hub) throw cloudHubNotConfigured();
    const { managerKey } = await hub.newDirectorKey(view.cloud.code);
    await db.run(
      `UPDATE trials SET director_key = ?, director_key_at = ?::timestamptz, director_key_stale = false, director_key_next = NULL,
         director_key_refused = false WHERE id = ?::uuid`,
      [managerKey, iso(now), view.id],
    );
    return { managerKey, applied: 'cloud', trial: view };
  }
  let managerKey: string | null = null;
  while (managerKey === null) managerKey = directorKeyFrom(randomBytes(48));
  await db.run(
    'UPDATE trials SET director_key_next = ?, director_key_next_at = ?::timestamptz, director_key_refused = false WHERE id = ?::uuid',
    [managerKey, iso(now), view.id],
  );
  return { managerKey, applied: 'next-report', trial: view };
}
