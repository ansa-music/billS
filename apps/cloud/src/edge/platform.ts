import type {
  PlatformLoginRequest,
  PlatformLoginResponse,
  PlatformMe,
  PlatformNotifyTestResponse,
  TelegramLinkResponse,
  TelegramStatusView,
  TrialCloudMoveState,
  TrialsListResponse,
  TrialView,
} from '@bills/domain';
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
  markTrialPaid,
  rejectTrial,
  setTrialEndDate,
  trialSnapshot,
  withCloudUrl,
} from '../trial.ts';
import { approveTrialInCloud, cloudMoveState, moveTrialToCloud, retryCloudTerms, startCloudMove, syncCloudTerms } from '../cloud-cafe.ts';
import { issueDirectorKey, trialCodes } from '../trial-codes.ts';
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
 * «Облачная касса» (apps/cloud/src/cloud-cafe.ts; CLOUD_HUB_URL + CLOUD_HUB_ADMIN_TOKEN, else 409 CLOUD_HUB_NOT_CONFIGURED;
 * the Worker's refusals are 424 CLOUD_HUB_* with its words). GET /platform/trials also answers `cloudHub` {configured, url};
 * every TrialView carries `cloud` (the café's code and link) once it is there. Extend, end date, permanent and end of a
 * trial in the cloud also send the terms to its café (a failure stays on `cloud.termsError`, never thrown).
 *   POST /platform/trials/:id/cloud/start        → TrialCloudMoveState (the on-line cash desk is asked for a fresh copy)
 *   GET  /platform/trials/:id/cloud              → TrialCloudMoveState
 *   POST /platform/trials/:id/cloud              { acceptOlder? } → TrialView (moved; 409 CLOUD_NOT_FRESH / CLOUD_BUSY,
 *                                                404 SNAPSHOT_NOT_FOUND; a trial already there answers as it is)
 *   POST /platform/trials/:id/cloud/terms        → TrialView («Повторить»: the terms to the cloud café again)
 *   POST /platform/trials/:id/approve-cloud      → TrialCloudApproved (a request → a new cloud café; the director's key once)
 *
 * «Купили» (apps/cloud/src/trial.ts markTrialPaid, packages/domain/src/trial-paid.ts):
 *   POST /platform/trials/:id/paid               TrialPaidRequest {until, amount?, note?} → TrialView (status 'paid'; the
 *                                                amount and note stay in the cabinet; a cloud café gets active until then)
 * The café's codes (apps/cloud/src/trial-codes.ts; the platform owner only, 403 for the support team; never logged):
 *   GET  /platform/trials/:id/codes              → TrialCodesView (the café code, the director's code)
 *   POST /platform/trials/:id/director-key       → TrialDirectorKeyIssued (a new director code, shown once)
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
      const { trials } = await listTrials(ctx.db, ctx.now(), await requirePlatform(req, ctx));
      const res: TrialsListResponse<TrialView> = {
        trials: trials.map((t) => withCloudUrl(t, ctx.cloudHubUrl)),
        cloudHub: { configured: ctx.cloudHub !== null, url: ctx.cloudHubUrl },
      };
      return json(200, res, { ...cors, 'cache-control': 'no-store' });
    }

    const cloud = /^\/platform\/trials\/([^/]+)\/(cloud|cloud\/start|cloud\/terms|approve-cloud)$/.exec(path);
    if (cloud && (m === 'POST' || (m === 'GET' && cloud[2] === 'cloud'))) {
      const me = await requirePlatform(req, ctx);
      const id = cloud[1]!;
      const now = ctx.now();
      const url = (v: TrialView) => withCloudUrl(v, ctx.cloudHubUrl);
      const stateUrl = (s: TrialCloudMoveState): TrialCloudMoveState => ({ ...s, cloud: withCloudUrl({ cloud: s.cloud }, ctx.cloudHubUrl).cloud });
      const noStore = { ...cors, 'cache-control': 'no-store' };
      if (m === 'GET') {
        return json(200, stateUrl(await cloudMoveState(ctx.db, now, me, id)), noStore);
      }
      if (cloud[2] === 'cloud/start') {
        await readOptionalJson(req);
        return json(200, stateUrl(await startCloudMove(ctx.db, now, me, id, ctx.cloudHub)), noStore);
      }
      if (cloud[2] === 'cloud') {
        const { view, imported } = await moveTrialToCloud(ctx.db, now, me, id, await readOptionalJson(req), ctx.cloudHub);
        if (imported) ctx.log(`platform: ${me.name} (${me.id}) перевёл в облачную кассу пробную версию ${view.id} «${view.venue}»`);
        return json(200, url(view), noStore);
      }
      if (cloud[2] === 'cloud/terms') {
        await readOptionalJson(req);
        return json(200, url(await retryCloudTerms(ctx.db, now, me, id, ctx.cloudHub)), noStore);
      }
      await readOptionalJson(req);
      const res = await approveTrialInCloud(ctx.db, now, me, id, ctx.cloudHub);
      ctx.log(`platform: ${me.name} (${me.id}) подтвердил заявку в облачной кассе: пробная версия ${res.trial.id} «${res.trial.venue}»`);
      return json(200, { ...res, trial: url(res.trial) }, noStore);
    }

    const trialDelete = /^\/platform\/trials\/([^/]+)$/.exec(path);
    if (m === 'DELETE' && trialDelete) {
      const me = await requirePlatform(req, ctx);
      const res = await deleteTrial(ctx.db, ctx.now(), me, trialDelete[1]!);
      ctx.log(`platform: ${me.name} (${me.id}) удалил пробную версию ${res.deleted} «${res.venue}»`);
      return json(200, res, cors);
    }

    const codes = /^\/platform\/trials\/([^/]+)\/(codes|director-key)$/.exec(path);
    if (codes && ((m === 'GET' && codes[2] === 'codes') || (m === 'POST' && codes[2] === 'director-key'))) {
      const me = await requirePlatform(req, ctx);
      const now = ctx.now();
      const noStore = { ...cors, 'cache-control': 'no-store' };
      if (codes[2] === 'codes') {
        const res = await trialCodes(ctx.db, now, me, codes[1]!);
        // Who looked, never what they saw.
        ctx.log(`platform: ${me.name} (${me.id}) посмотрел коды кофейни: пробная версия ${res.view.id} «${res.view.venue}»`);
        return json(200, res.codes, noStore);
      }
      await readOptionalJson(req);
      const res = await issueDirectorKey(ctx.db, now, me, codes[1]!, ctx.cloudHub);
      ctx.log(
        `platform: ${me.name} (${me.id}) выдал новый код директора (${res.applied === 'cloud' ? 'облачная касса' : 'касса получит при следующей связи'}): пробная версия ${res.trial.id} «${res.trial.venue}»`,
      );
      return json(200, { ...res, trial: withCloudUrl(res.trial, ctx.cloudHubUrl) }, noStore);
    }

    const trial = /^\/platform\/trials\/([^/]+)\/(extend|end-date|end|snapshot|approve|reject|permanent|paid)$/.exec(path);
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
        case 'paid':
          view = await markTrialPaid(ctx.db, now, me, id, await readJson(req));
          // The amount and the note are the platform's own: not even in the log.
          did = `отметил «Купили»: оплачено до ${view.paid?.until ?? '?'}`;
          break;
        default:
          view = await endTrial(ctx.db, now, me, id);
          did = `завершил ${new Date(view.endsAt).toISOString()}`;
      }
      // A trial in the cloud cash desk: its café takes the new terms too (a failure shows on view.cloud.termsError).
      if (view.cloud) view = await syncCloudTerms(ctx.db, ctx.now(), view.id, ctx.cloudHub);
      // The platform has no audit table: the action goes to the function's log with who did it.
      ctx.log(`platform: ${me.name} (${me.id}) ${did}: пробная версия ${view.id} «${view.venue}»`);
      return json(200, withCloudUrl(view, ctx.cloudHubUrl), cors);
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
