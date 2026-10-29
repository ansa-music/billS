import type { PlatformLoginRequest, PlatformLoginResponse, PlatformMe } from '@bills/domain';
import { authenticatePlatformKey, createPlatformSession, deletePlatformSession, platformByToken } from '../access.ts';
import { CloudError } from '../errors.ts';
import {
  blockClient,
  createClient,
  hirePlatformStaff,
  listClients,
  newClientManagerKey,
  platformStaff,
  updateClientLicense,
} from '../platform.ts';
import { endTrial, extendTrial, listTrials, trialSnapshot } from '../trial.ts';
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
 *   GET  /platform/trials                        → { trials: TrialView[] } (coffee shop browser trials, newest first)
 *   POST /platform/trials/:id/extend             { days: 1..90 } → TrialView
 *   POST /platform/trials/:id/end                → TrialView (ended now)
 *   GET  /platform/trials/:id/snapshot           → { snapshot: base64 SQLite, snapshotAt } (404 SNAPSHOT_NOT_FOUND)
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

    const trial = /^\/platform\/trials\/([^/]+)\/(extend|end|snapshot)$/.exec(path);
    if (trial && ((m === 'POST' && trial[2] !== 'snapshot') || (m === 'GET' && trial[2] === 'snapshot'))) {
      const me = await requirePlatform(req, ctx);
      const id = decodeURIComponent(trial[1]!);
      if (trial[2] === 'snapshot') return json(200, await trialSnapshot(ctx.db, me, id), { ...cors, 'cache-control': 'no-store' });
      const view = trial[2] === 'extend' ? await extendTrial(ctx.db, ctx.now(), me, id, await readJson(req)) : await endTrial(ctx.db, ctx.now(), me, id);
      // The platform has no audit table: the action goes to the function's log with who did it.
      ctx.log(`platform: ${me.name} (${me.id}) ${trial[2] === 'extend' ? 'продлил' : 'завершил'} пробную версию ${view.id} «${view.venue}» до ${new Date(view.endsAt).toISOString()}`);
      return json(200, view, cors);
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
