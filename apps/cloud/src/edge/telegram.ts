import { CloudError } from '../errors.ts';
import type { TelegramUpdate } from '../telegram.ts';
import { handleTelegramUpdate } from '../telegram.ts';
import type { EdgeContext } from './context.ts';
import type { EdgeRequest } from './http.ts';
import { errorResponse, json, notFound, readJson, routeOf } from './http.ts';
import { sameSecret } from './notify.ts';

/**
 * Edge Function `telegram` (verify_jwt = false): the webhook of the TS bot.
 * Telegram POSTs every update with `X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>`
 * (set once by setWebhook, see docs/PUBLIC_DEPLOY_RU.md); anything without it is refused.
 *
 *   POST /telegram   Update → 200 { ok: true }   (always 200 for a valid call: Telegram retries others)
 *
 * Commands: /start <code> links the chat, /stop unlinks, /today — summary so far, /mute, /unmute.
 */
export async function handleTelegram(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  try {
    const { path } = routeOf(req.url);
    if (path !== '/telegram' && path !== '/') return notFound();
    if (req.method !== 'POST') return notFound();
    if (!ctx.telegram || !ctx.telegramWebhookSecret || ctx.telegramWebhookSecret.length < 16) {
      throw new CloudError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram-бот TS не настроен (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET)');
    }
    const given = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!sameSecret(given, ctx.telegramWebhookSecret)) throw new CloudError(401, 'UNAUTHORIZED', 'Неверный секрет вебхука');
    const update = (await readJson(req)) as TelegramUpdate;
    try {
      await handleTelegramUpdate({ db: ctx.db, now: ctx.now(), bot: ctx.telegram, cabinetUrl: ctx.cabinetUrl, log: ctx.log }, update ?? {});
    } catch (e) {
      // Answered 200 anyway: a retry of the same update would fail the same way.
      ctx.log(`Telegram: ошибка обработки сообщения: ${(e as Error).message}`);
    }
    return json(200, { ok: true });
  } catch (e) {
    return errorResponse(e, ctx.log);
  }
}
