import { TRIAL_SNAPSHOT_MAX_BYTES } from '@bills/domain';
import { reportTrial, startTrial, trialTermsOf } from '../trial.ts';
import { createWatchLink, revokeWatchLinks, watchLinksStatus, watchSnapshot, watchState, withWatching } from '../trial-watch.ts';
import type { EdgeContext } from './context.ts';
import type { EdgeRequest } from './http.ts';
import { bearerToken, errorResponse, json, notFound, readJson, routeOf } from './http.ts';
import { clientIp } from './signup.ts';

/**
 * Edge Function `trial` (verify_jwt = false): the coffee shop's browser trial talks to the cloud.
 * Anyone on the internet may start a trial (10 starts an hour per IP, trial_attempts); after that
 * every call carries the trial's own token (`Authorization: Bearer`, stored as sha256).
 * The trial runs on any origin (pages.dev previews, a custom domain), so CORS is `*` on every
 * answer, errors and the preflight included; the token, not the origin, is the guard.
 *
 *   POST /trial/start   TrialStartRequest → 201 TrialStartResponse (14 days from the browser's startedAt; 422 VENUE_INVALID / STARTED_AT_INVALID, 429 RATE_LIMITED)
 *   POST /trial/report  TrialReportRequest (Bearer) → TrialTerms
 *                       (401 UNAUTHORIZED, 404 TRIAL_NOT_FOUND, 422 STATS_INVALID / SNAPSHOT_INVALID,
 *                        413 SNAPSHOT_TOO_LARGE, 429 RATE_LIMITED past 120 reports an hour)
 *   GET  /trial/terms?id=<id> (Bearer) → TrialTerms
 *
 * «Смотреть с телефона» (apps/cloud/src/trial-watch.ts); the report's answer also carries
 * `watching: true` while a phone is looking.
 *   POST /trial/watch/links   {id} (Bearer trial)  → 201 TrialWatchLink (429 past 30 an hour)
 *   GET  /trial/watch/links?id=<id> (Bearer trial) → TrialWatchStatus
 *   POST /trial/watch/revoke  {id} (Bearer trial)  → {revoked}
 *   GET  /trial/watch          (Bearer viewer)     → TrialWatchState (401 WATCH_LINK_REVOKED, 429 RATE_LIMITED)
 *   GET  /trial/watch/snapshot (Bearer viewer)     → TrialWatchSnapshot (404 SNAPSHOT_NOT_FOUND)
 */
export const TRIAL_CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '600',
};

/** The report's body: a snapshot of TRIAL_SNAPSHOT_MAX_BYTES in base64 plus the counters. */
const REPORT_BODY_LIMIT = Math.ceil((TRIAL_SNAPSHOT_MAX_BYTES * 4) / 3) + 512 * 1024;

export async function handleTrial(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  const cors = { ...TRIAL_CORS };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const headers = { ...cors, 'cache-control': 'no-store' };
  try {
    // The trial calls `/functions/v1/trial/trial/...`: the function name may come twice.
    const { path, query } = routeOf(req.url);
    const clean = path.replace(/^\/trial(?=\/trial(\/|$))/, '');
    const m = req.method;
    if (m === 'POST' && clean === '/trial/start') {
      const res = await startTrial(ctx.db, ctx.now(), await readJson(req), clientIp(req));
      ctx.log(`trial: новая пробная версия ${res.id}`);
      return json(201, res, headers);
    }
    if (m === 'POST' && clean === '/trial/report') {
      const token = bearerToken(req);
      const body = await readJson(req, REPORT_BODY_LIMIT);
      const terms = await reportTrial(ctx.db, ctx.now(), token, body);
      return json(200, await withWatching(ctx.db, ctx.now(), body, terms), headers);
    }
    if (m === 'GET' && clean === '/trial/terms') {
      return json(200, await trialTermsOf(ctx.db, ctx.now(), bearerToken(req), query.get('id')), headers);
    }
    if (m === 'POST' && clean === '/trial/watch/links') {
      return json(201, await createWatchLink(ctx.db, ctx.now(), bearerToken(req), await readJson(req)), headers);
    }
    if (m === 'GET' && clean === '/trial/watch/links') {
      return json(200, await watchLinksStatus(ctx.db, ctx.now(), bearerToken(req), query.get('id')), headers);
    }
    if (m === 'POST' && clean === '/trial/watch/revoke') {
      return json(200, await revokeWatchLinks(ctx.db, bearerToken(req), await readJson(req)), headers);
    }
    if (m === 'GET' && clean === '/trial/watch') {
      return json(200, await watchState(ctx.db, ctx.now(), bearerToken(req), clientIp(req)), headers);
    }
    if (m === 'GET' && clean === '/trial/watch/snapshot') {
      return json(200, await watchSnapshot(ctx.db, ctx.now(), bearerToken(req), clientIp(req)), headers);
    }
    return notFound(headers);
  } catch (e) {
    return errorResponse(e, ctx.log, headers);
  }
}
