import { TRIAL_SNAPSHOT_MAX_BYTES } from '@bills/domain';
import { notifyTrialRequest } from '../platform-notify.ts';
import { reportTrial, startTrial, trialTermsOf, trialWithDuplicate } from '../trial.ts';
import { createWatchLink, revokeWatchLinks, watchLinksStatus, watchSnapshot, watchState, withWatching } from '../trial-watch.ts';
import { finishMove, movedError, moveState, regenerateCafeCode, startMove, withMove } from '../trial-move.ts';
import type { EdgeContext } from './context.ts';
import type { EdgeRequest } from './http.ts';
import { bearerToken, errorResponse, json, notFound, readJson, readOptionalJson, routeOf } from './http.ts';
import { clientIp } from './signup.ts';

/**
 * Edge Function `trial` (verify_jwt = false): the coffee shop's browser trial talks to the cloud.
 * Anyone on the internet may ask for a trial (10 new requests an hour per IP, trial_attempts); after
 * that every call carries the trial's own token (`Authorization: Bearer`, stored as sha256).
 * The trial runs on any origin (pages.dev previews, a custom domain), so CORS is `*` on every
 * answer, errors and the preflight included; the token, not the origin, is the guard.
 *
 *   POST /trial/start   TrialStartRequest with installId → 201 TrialStartResponse 'pending' (a new request; the
 *                       platform team is told: platform-notify.ts) | 200 the same trial again (same installId, new token);
 *                       without installId (a page from before requests) → 201 TRIAL_RELOAD_ID «ended, reload», nothing stored
 *                       (422 VENUE_INVALID / STARTED_AT_INVALID / INSTALL_ID_INVALID, 429 RATE_LIMITED)
 *   POST /trial/report  TrialReportRequest (Bearer; `v: 2` → every status, else legacyTrialTerms) → TrialTerms
 *                       (401 UNAUTHORIZED, 404 TRIAL_NOT_FOUND, 422 STATS_INVALID / SNAPSHOT_INVALID,
 *                        413 SNAPSHOT_TOO_LARGE, 429 RATE_LIMITED past 120 reports an hour)
 *   GET  /trial/terms?id=<id>&v=2 (Bearer) → TrialTerms (the waiting page asks every 30 s)
 *
 * «Смотреть с телефона» (apps/cloud/src/trial-watch.ts); the report's answer also carries
 * `watching: true` while a phone is looking.
 *   POST /trial/watch/links   {id} (Bearer trial)  → 201 TrialWatchLink (429 past 30 an hour)
 *   GET  /trial/watch/links?id=<id> (Bearer trial) → TrialWatchStatus
 *   POST /trial/watch/revoke  {id} (Bearer trial)  → {revoked}
 *   GET  /trial/watch          (Bearer viewer)     → TrialWatchState (401 WATCH_LINK_REVOKED, 429 RATE_LIMITED)
 *   GET  /trial/watch/snapshot (Bearer viewer)     → TrialWatchSnapshot (404 SNAPSHOT_NOT_FOUND)
 *
 * «У меня уже есть TS — войти» (apps/cloud/src/trial-move.ts): the report's body may carry `needCode`, its
 * answer `cafeCode` (once) and `sendSnapshot`; a token retired by a move gets 410 TRIAL_MOVED on report/terms.
 *   POST /trial/code          {id} (Bearer trial)  → TrialCafeCode («Сменить код»; 429 past 10 an hour)
 *   POST /trial/move/start    {code}               → TrialMoveStart (401 CAFE_CODE_WRONG, 429 RATE_LIMITED)
 *   GET  /trial/move          (Bearer ticket)      → TrialMoveState (401 MOVE_TICKET_INVALID, 410 MOVE_EXPIRED)
 *   POST /trial/move/finish   {acceptOlder?} (Bearer ticket) → TrialMoveFinish
 *                             (409 MOVE_SUPERSEDED / MOVE_NOT_FRESH, 404 SNAPSHOT_NOT_FOUND)
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
      const out = await startTrial(ctx.db, ctx.now(), await readJson(req), clientIp(req));
      if (out.legacy) {
        ctx.log('trial: старая страница без installId — попросили обновить, ничего не записано');
        return json(201, out.answer, headers);
      }
      if (!out.created) return json(200, out.answer, headers);
      ctx.log(`trial: новая заявка ${out.created.id} «${out.created.venue}»`);
      // Never in the way of the start: notifyTrialRequest does not throw and waits a few seconds at most.
      const view = await trialWithDuplicate(ctx.db, ctx.now(), out.created.id).catch(() => out.created!);
      await notifyTrialRequest({ db: ctx.db, sender: ctx.sender, telegram: ctx.telegram, cabinetUrl: ctx.cabinetUrl, log: ctx.log }, view);
      return json(201, out.answer, headers);
    }
    if (m === 'POST' && clean === '/trial/report') {
      const token = bearerToken(req);
      const body = await readJson(req, REPORT_BODY_LIMIT);
      const terms = await reportTrial(ctx.db, ctx.now(), token, body).catch(rethrowMoved(ctx, token, body));
      return json(200, await withMove(ctx.db, ctx.now(), body, await withWatching(ctx.db, ctx.now(), body, terms)), headers);
    }
    if (m === 'GET' && clean === '/trial/terms') {
      const token = bearerToken(req);
      const terms = await trialTermsOf(ctx.db, ctx.now(), token, query.get('id'), query.get('v')).catch(rethrowMoved(ctx, token, { id: query.get('id') }));
      return json(200, terms, headers);
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
    const move = await moveRoute(req, clean, m, ctx);
    if (move) return json(move.status, move.body, headers);
    return notFound(headers);
  } catch (e) {
    return errorResponse(e, ctx.log, headers);
  }
}

/** A refused report or terms call of a cash desk that was moved away: 410 TRIAL_MOVED instead of 401. */
function rethrowMoved(ctx: EdgeContext, token: string | null, body: unknown): (e: unknown) => Promise<never> {
  return async (e) => {
    throw await movedError(ctx.db, e, token, typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined);
  };
}

/** «Код кофейни» and moving the cash desk (apps/cloud/src/trial-move.ts); null when the path is not one of them. */
async function moveRoute(req: EdgeRequest, path: string, m: string, ctx: EdgeContext): Promise<{ status: number; body: unknown } | null> {
  if (m === 'POST' && path === '/trial/code') {
    return { status: 200, body: await regenerateCafeCode(ctx.db, ctx.now(), bearerToken(req), await readJson(req)) };
  }
  if (m === 'POST' && path === '/trial/move/start') {
    return { status: 201, body: await startMove(ctx.db, ctx.now(), await readJson(req), clientIp(req)) };
  }
  if (m === 'GET' && path === '/trial/move') {
    return { status: 200, body: await moveState(ctx.db, ctx.now(), bearerToken(req), clientIp(req)) };
  }
  if (m === 'POST' && path === '/trial/move/finish') {
    const res = await finishMove(ctx.db, ctx.now(), bearerToken(req), await readOptionalJson(req), clientIp(req));
    ctx.log(`trial: касса пробной версии ${res.id} перенесена на другой компьютер`);
    return { status: 200, body: res };
  }
  return null;
}
