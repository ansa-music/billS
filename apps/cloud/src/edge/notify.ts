import { CloudError } from '../errors.ts';
import { runWatchdogs } from '../push.ts';
import { runDailySummaries } from '../telegram.ts';
import type { EdgeContext } from './context.ts';
import { reportPushConfigured } from './context.ts';
import type { EdgeRequest } from './http.ts';
import { errorResponse, json, notFound, routeOf } from './http.ts';

/**
 * Edge Function `notify` (verify_jwt = false): the cloud's watchdogs (HUB silent,
 * shift left open) plus a retry of anything still PENDING in push_queue, and — with the Telegram
 * bot configured — the evening summary of the day (21:00 club time, once per chat and day).
 * Called by pg_cron every 5 minutes (supabase/migrations/*_cron.sql) with `x-ts-cron: <NOTIFY_SECRET>`.
 */

/** Compares in time independent of where the strings differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function handleNotify(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  try {
    const { path } = routeOf(req.url);
    if (path !== '/notify' && path !== '/') return notFound();
    if (req.method !== 'POST' && req.method !== 'GET') return notFound();
    if (!ctx.notifySecret || ctx.notifySecret.length < 16) {
      throw new CloudError(503, 'NOTIFY_NOT_CONFIGURED', 'NOTIFY_SECRET не задан (нужно не короче 16 символов)');
    }
    const given = req.headers.get('x-ts-cron') ?? '';
    if (!sameSecret(given, ctx.notifySecret)) throw new CloudError(401, 'UNAUTHORIZED', 'Нужен заголовок x-ts-cron');
    const now = ctx.now();
    const queued = await runWatchdogs(ctx.db, now, ctx.watchdog);
    const flushed = await ctx.push.flush();
    let summaries = 0;
    if (ctx.telegram) {
      try {
        summaries = await runDailySummaries(ctx.db, now, ctx.telegram, ctx.cabinetUrl, ctx.log);
      } catch (e) {
        ctx.log(`Telegram: сводка дня не разослана: ${(e as Error).message}`);
      }
    }
    await reportPushConfigured(ctx);
    return json(200, { ok: true, now, queued, ...flushed, summaries, pushEnabled: ctx.push.enabled });
  } catch (e) {
    return errorResponse(e, ctx.log);
  }
}
