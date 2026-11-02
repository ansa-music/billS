import type { PlatformLoginRequest, PlatformLoginResponse, PlatformMe, PlatformNotifyTestResponse, TelegramLinkResponse, TelegramStatusView, TrialView } from '@bills/domain';
import { telegramStartLink } from '@bills/domain';
import { authenticatePlatformKey, createPlatformSession, deletePlatformSession, platformByToken } from '../access.ts';
import { CloudError } from '../errors.ts';
import { notifyPlatform, platformDevices, registerPlatformDevice, removePlatformDevice, TRIALS_PATH } from '../platform-notify.ts';
import { createPlatformLinkCode, listPlatformChats, unlinkPlatformChat } from '../telegram.ts';
import {
  blockClient,
  createClient,
  hirePlatformStaff,
  listClients,
  newClientManagerKey,
  platformStaff,
  updateClientLicense,
} from '../platform.ts';
import {
  approveTrial,
  deleteTrial,
  endTrial,
  extendTrial,
  listTrials,
  makeTrialPermanent,
  rejectTrial,
  setTrialEndDate,
  trialSnapshot,
} from '../trial.ts';
import type { EdgeContext } from './context.ts';
import { signPendingQuietly } from './context.ts';
import type { EdgeRequest, Schema } from './http.ts';
import { bearerToken, errorResponse, json, notFound, readJson, readOptionalJson, routeOf, validate } from './http.ts';
import { authUserId, corsHeaders } from './owner.ts';

/**
 * Edge Function `platform` (verify_jwt = false): the platform cabinet of apps/cloud
 * (/api/platform/…) for the owner and the support team of TS. Sign-in by a long key
 * OWNER-… / TECH-… gives an opaque session token (stored as sha256 in platform_sessions),
 * sent back as `Authorization: Bearer`. A Supabase Auth access token (JWT) works too: its user's
 * e-mail (or linked auth_user_id) must be an active platform_staff row (public.ts_make_platform_owner),
 * otherwise 403 NOT_PLATFORM. The function runs with verify_jwt = false, so the token is checked here:
 * HS256 with SUPABASE_JWT_SECRET, else by the Auth API (SUPABASE_URL + SUPABASE_ANON_KEY). Paths are accepted as `/platform/...` and
 * `/platform/platform/...` (base `/functions/v1/platform` + `/platform/...`).
 *
 *   POST /platform/login                         PlatformLoginRequest → PlatformLoginResponse (with token)
 *   GET  /platform/me                            → PlatformMe
 *   POST /platform/logout
 *   GET  /platform/clients                       → { clients: ClientView[] }
 *   POST /platform/clients                       CreateClientRequest → CreateClientResponse (no password: Supabase Auth)
 *   POST /platform/clients/:companyId/license    LicenseTermsRequest → ClientView
 *   POST /platform/clients/:companyId/block      BlockClientRequest → ClientView
 *   POST /platform/clients/:companyId/manager-key → IssuedLongKey
 *   GET  /platform/staff, POST /platform/staff   the support team (hiring: owner only)
 *   GET  /platform/trials                        → { trials: TrialView[] } (coffee shop browser trials: requests first,
 *                                                then newest first; each with duplicateOf, «похоже на повтор»)
 *   POST /platform/trials/:id/approve            → TrialView (a request → active, 14 days from now; 409 TRIAL_NOT_PENDING)
 *   POST /platform/trials/:id/reject             { message? ≤ 300 } → TrialView (pending → rejected; 409 TRIAL_NOT_PENDING)
 *   POST /platform/trials/:id/permanent          → TrialView (any trial → permanent, no end date)
 *   POST /platform/trials/:id/extend             { days: 1..90 } → TrialView (409 TRIAL_NOT_APPROVED for a request)
 *   POST /platform/trials/:id/end-date           { date: YYYY-MM-DD, today..today+90 } → TrialView
 *                                                (active through that day of the trial's zone; 422 DATE_INVALID)
 *   POST /platform/trials/:id/end                → TrialView (ended now)
 *   DELETE /platform/trials/:id                  → { deleted, venue } (pending / rejected / ended / expired; 409 TRIAL_RUNNING)
 *   GET  /platform/trials/:id/snapshot           → { snapshot: base64 SQLite, snapshotAt } (404 SNAPSHOT_NOT_FOUND)
 *
 * «Уведомления о заявках» (platform-notify.ts) — the signed-in person's own chats and devices:
 *   GET    /platform/telegram                    → TelegramStatusView (configured: false without TELEGRAM_BOT_TOKEN)
 *   POST   /platform/telegram/link               → TelegramLinkResponse (t.me link, one-time code, 15 minutes; 503 TELEGRAM_NOT_CONFIGURED)
 *   DELETE /platform/telegram/chats/:chatId      → { ok: true } (404 TELEGRAM_CHAT_NOT_FOUND)
 *   GET    /platform/devices                     → PlatformDevicesView
 *   POST   /platform/devices                     RegisterDeviceRequest (webpush) → DeviceView
 *   DELETE /platform/devices/:id                 → { ok: true } (404 DEVICE_NOT_FOUND)
 *   POST   /platform/notify/test                 → PlatformNotifyTestResponse (a test message to those chats and devices)
 */

const loginSchema: Schema = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 200 } },
};

const isJwt = (token: string): boolean => token.split('.').length === 3;

function jwtAlg(token: string): unknown {
  try {
    return (JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { alg?: unknown }).alg;
  } catch {
    return null;
  }
}

/** Platform person of a Supabase Auth user: linked by auth_user_id, or by a trusted (confirmed) e-mail. */
async function platformByAuthUser(req: EdgeRequest, ctx: EdgeContext, token: string): Promise<PlatformMe> {
  let userId: string;
  if (ctx.jwtSecret && jwtAlg(token) === 'HS256') {
    userId = await authUserId(req, ctx);
  } else if (ctx.authUser) {
    const user = await ctx.authUser(token);
    if (!user) throw new CloudError(401, 'UNAUTHORIZED', 'Сессия истекла, войдите снова');
    userId = user.id;
  } else {
    throw new CloudError(401, 'UNAUTHORIZED', 'Вход по учётной записи не настроен (нужны SUPABASE_URL и SUPABASE_ANON_KEY)');
  }
  const rows = await ctx.db.all<PlatformMe & { linked: boolean }>(
    `SELECT s.id, s.name, s.role, (s.auth_user_id IS NOT NULL) AS linked
     FROM auth.users u JOIN public.platform_staff s
       ON s.auth_user_id = u.id
       OR (s.auth_user_id IS NULL AND s.email IS NOT NULL AND lower(s.email) = lower(u.email)
           AND ts_internal.auth_email_trusted(to_jsonb(u)))
     WHERE u.id::text = ? AND s.is_active = 1
     ORDER BY (s.auth_user_id IS NOT NULL) DESC LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new CloudError(403, 'NOT_PLATFORM', 'Эта учётная запись не входит в команду платформы TS');
  if (!row.linked) await ctx.db.run('UPDATE platform_staff SET auth_user_id = ?::uuid WHERE id = ? AND auth_user_id IS NULL', [userId, row.id]);
  return { id: row.id, name: row.name, role: row.role };
}

export async function requirePlatform(req: EdgeRequest, ctx: EdgeContext): Promise<PlatformMe> {
  const token = bearerToken(req);
  if (token && isJwt(token)) return platformByAuthUser(req, ctx, token);
  const me = token ? await platformByToken(ctx.db, token, ctx.now()) : null;
  if (!me) throw new CloudError(401, 'UNAUTHORIZED', 'Войдите в кабинет платформы');
  return me;
}

export async function handlePlatform(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  const cors = corsHeaders(req, ctx);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    await signPendingQuietly(ctx);
    const path = routeOf(req.url).path.replace(/^\/platform(?=\/platform(\/|$))/, '');
    const m = req.method;
    const client = /^\/platform\/clients\/([^/]+)\/(license|block|manager-key)$/.exec(path);

    if (m === 'POST' && path === '/platform/login') {
      const body = validate<PlatformLoginRequest>(await readJson(req), loginSchema);
      const me = await authenticatePlatformKey(ctx.db, ctx.now(), body.key);
      if (!me) throw new CloudError(401, 'INVALID_KEY', 'Ключ не подходит: неверный, отозван или это не ключ платформы');
      const { token, expiresAt } = await createPlatformSession(ctx.db, me.id, ctx.now());
      const res: PlatformLoginResponse = { me, token, expiresAt };
      return json(200, res, cors);
    }

    if (m === 'GET' && path === '/platform/me') return json(200, await requirePlatform(req, ctx), cors);

    if (m === 'POST' && path === '/platform/logout') {
      const token = bearerToken(req);
      if (token) await deletePlatformSession(ctx.db, token);
      return json(200, { ok: true }, cors);
    }

    if (m === 'GET' && path === '/platform/clients') {
      return json(200, await listClients(ctx.db, ctx.now(), await requirePlatform(req, ctx)), cors);
    }

    if (m === 'POST' && path === '/platform/clients') {
      const me = await requirePlatform(req, ctx);
      return json(200, await createClient(ctx.db, ctx.licenseSigner, ctx.now(), me, await readJson(req), { passwords: false }), cors);
    }

    if (m === 'POST' && client) {
      const me = await requirePlatform(req, ctx);
      const companyId = decodeURIComponent(client[1]!);
      if (client[2] === 'license') {
        return json(200, await updateClientLicense(ctx.db, ctx.licenseSigner, ctx.now(), me, companyId, await readJson(req)), cors);
      }
      if (client[2] === 'block') {
        return json(200, await blockClient(ctx.db, ctx.licenseSigner, ctx.now(), me, companyId, await readJson(req)), cors);
      }
      await readOptionalJson(req);
      return json(200, await newClientManagerKey(ctx.db, ctx.now(), me, companyId), cors);
    }

    if (m === 'GET' && path === '/platform/trials') {
      return json(200, await listTrials(ctx.db, ctx.now(), await requirePlatform(req, ctx)), { ...cors, 'cache-control': 'no-store' });
    }

    const trialDelete = /^\/platform\/trials\/([^/]+)$/.exec(path);
    if (m === 'DELETE' && trialDelete) {
      const me = await requirePlatform(req, ctx);
      const res = await deleteTrial(ctx.db, ctx.now(), me, trialDelete[1]!);
      ctx.log(`platform: ${me.name} (${me.id}) удалил пробную версию ${res.deleted} «${res.venue}»`);
      return json(200, res, cors);
    }

    const trial = /^\/platform\/trials\/([^/]+)\/(extend|end-date|end|snapshot|approve|reject|permanent)$/.exec(path);
    if (trial && ((m === 'POST' && trial[2] !== 'snapshot') || (m === 'GET' && trial[2] === 'snapshot'))) {
      const me = await requirePlatform(req, ctx);
      // A uuid needs no decoding; anything else is not a trial (404 from the lookup).
      const id = trial[1]!;
      if (trial[2] === 'snapshot') return json(200, await trialSnapshot(ctx.db, me, id), { ...cors, 'cache-control': 'no-store' });
      const now = ctx.now();
      let view: TrialView;
      let did: string;
      switch (trial[2]) {
        case 'extend':
          view = await extendTrial(ctx.db, now, me, id, await readJson(req));
          did = `продлил до ${new Date(view.endsAt).toISOString()}`;
          break;
        case 'end-date':
          view = await setTrialEndDate(ctx.db, now, me, id, await readJson(req));
          did = `назначил дату окончания ${new Date(view.endsAt).toISOString()}`;
          break;
        case 'approve':
          await readOptionalJson(req);
          view = await approveTrial(ctx.db, now, me, id);
          did = `подтвердил заявку до ${new Date(view.endsAt).toISOString()}`;
          break;
        case 'reject':
          view = await rejectTrial(ctx.db, now, me, id, await readOptionalJson(req));
          did = 'отклонил заявку';
          break;
        case 'permanent':
          await readOptionalJson(req);
          view = await makeTrialPermanent(ctx.db, now, me, id);
          did = 'сделал постоянной';
          break;
        default:
          view = await endTrial(ctx.db, now, me, id);
          did = `завершил ${new Date(view.endsAt).toISOString()}`;
      }
      // The platform has no audit table: the action goes to the function's log with who did it.
      ctx.log(`platform: ${me.name} (${me.id}) ${did}: пробная версия ${view.id} «${view.venue}»`);
      return json(200, view, cors);
    }

    // «Уведомления о заявках»: the signed-in person's own Telegram chats and Web Push devices.
    if (m === 'GET' && path === '/platform/telegram') {
      const me = await requirePlatform(req, ctx);
      const view: TelegramStatusView = ctx.telegram
        ? { configured: true, botUsername: await ctx.telegram.username(), chats: await listPlatformChats(ctx.db, me.id) }
        : { configured: false, botUsername: null, chats: [] };
      return json(200, view, { ...cors, 'cache-control': 'no-store' });
    }

    if (m === 'POST' && path === '/platform/telegram/link') {
      const me = await requirePlatform(req, ctx);
      await readOptionalJson(req);
      const bot = ctx.telegram;
      const username = bot ? await bot.username() : null;
      if (!bot || !username) throw new CloudError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram пока не подключён к TS');
      const { code, expiresAt } = await createPlatformLinkCode(ctx.db, ctx.now(), me.id);
      const res: TelegramLinkResponse = { url: telegramStartLink(username, code), expiresAt };
      return json(200, res, { ...cors, 'cache-control': 'no-store' });
    }

    const platformChat = /^\/platform\/telegram\/chats\/([^/]+)$/.exec(path);
    if (m === 'DELETE' && platformChat) {
      const me = await requirePlatform(req, ctx);
      const chatId = decodeURIComponent(platformChat[1]!);
      if (!(await unlinkPlatformChat(ctx.db, chatId, me.id))) throw new CloudError(404, 'TELEGRAM_CHAT_NOT_FOUND', 'Этот чат не подключён');
      if (ctx.telegram) {
        const bye = await ctx.telegram.sendMessage(chatId, 'Этот чат отключён от заявок TS в кабинете платформы.');
        if (!bye.ok) ctx.log(`Telegram: ${bye.description}`);
      }
      return json(200, { ok: true }, cors);
    }

    if (m === 'GET' && path === '/platform/devices') {
      const me = await requirePlatform(req, ctx);
      return json(200, await platformDevices(ctx.db, me.id, ctx.pushChannels.includes('webpush')), { ...cors, 'cache-control': 'no-store' });
    }

    if (m === 'POST' && path === '/platform/devices') {
      const me = await requirePlatform(req, ctx);
      return json(200, await registerPlatformDevice(ctx.db, ctx.now(), me.id, await readJson(req)), cors);
    }

    const platformDevice = /^\/platform\/devices\/([^/]+)$/.exec(path);
    if (m === 'DELETE' && platformDevice) {
      const me = await requirePlatform(req, ctx);
      if (!(await removePlatformDevice(ctx.db, me.id, decodeURIComponent(platformDevice[1]!)))) {
        throw new CloudError(404, 'DEVICE_NOT_FOUND', 'Устройство не найдено');
      }
      return json(200, { ok: true }, cors);
    }

    if (m === 'POST' && path === '/platform/notify/test') {
      const me = await requirePlatform(req, ctx);
      await readOptionalJson(req);
      const res: PlatformNotifyTestResponse = await notifyPlatform(
        { db: ctx.db, sender: ctx.sender, telegram: ctx.telegram, cabinetUrl: ctx.cabinetUrl, log: ctx.log },
        { title: 'TS: проверка уведомлений', body: 'Если вы это видите — новые заявки на пробные версии будут приходить сюда.', url: TRIALS_PATH },
        me.id,
      );
      return json(200, res, cors);
    }

    if (m === 'GET' && path === '/platform/staff') return json(200, await platformStaff(ctx.db, await requirePlatform(req, ctx)), cors);

    if (m === 'POST' && path === '/platform/staff') {
      const me = await requirePlatform(req, ctx);
      return json(200, await hirePlatformStaff(ctx.db, ctx.now(), me, await readJson(req)), cors);
    }

    return notFound(cors);
  } catch (e) {
    return errorResponse(e, ctx.log, cors);
  }
}
