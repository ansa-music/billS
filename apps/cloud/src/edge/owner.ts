import type { RegisterDeviceRequest, UpdatePushRulesRequest, UpdateTariffsRequest } from '@bills/domain';
import { DEVICE_PLATFORMS, isNtfyTopicUrl, isPushKind, parseWebPushToken } from '@bills/domain';
import { companyLicense, createBranch, createStaff, issueStaffKey, listBranches, listStaff, revokeStaffKey, updateStaff } from '../company.ts';
import type { ManagerRef } from '../company.ts';
import { CloudError } from '../errors.ts';
import { b64urlDecode, registerDevice, removeDevice, saveRules } from '../push.ts';
import { clubOfCompany } from '../reports.ts';
import type { ClubRow } from '../settings.ts';
import { updateTariffs } from '../sync.ts';
import type { EdgeContext } from './context.ts';
import { reportPushConfigured, signPendingQuietly } from './context.ts';
import type { EdgeRequest, Schema } from './http.ts';
import { bearerToken, errorResponse, json, notFound, readJson, readOptionalJson, routeOf, validate } from './http.ts';

/**
 * Edge Function `owner` (verify_jwt = true): what the cabinet cannot do through
 * PostgREST/RLS alone — tariff edits (validated by the domain), the test push and
 * device registration (FCM/Web Push/ntfy tokens), push rules. Paths are accepted as
 * `/owner/...` and `/owner/owner/...` (cabinet base `/functions/v1/owner` + `/owner/...`).
 *
 *   PUT    /owner/clubs/:id/tariffs   UpdateTariffsRequest → UpdateTariffsResponse
 *   POST   /owner/push/test           → TestPushResponse
 *   GET    /owner/push                → PushSettingsView + channels: ['webpush' when VAPID set, 'ntfy', 'fcm']
 *   PUT    /owner/push/rules          UpdatePushRulesRequest → PushSettingsView
 *   POST   /owner/devices             RegisterDeviceRequest → DeviceView
 *   DELETE /owner/devices/:id         → { ok: true }
 *
 * The manager cabinet (owners rows are the client's managers), as /api/company/… of apps/cloud:
 *   GET  /owner/company/license                → { license: LicenseView | null }
 *   GET  /owner/company/branches               → { branches: BranchView[] }
 *   POST /owner/company/branches               CreateBranchRequest → CreateBranchResponse (409 LICENSE_CLUB_LIMIT, 403 LICENSE_READ_ONLY)
 *   GET  /owner/company/staff?clubId=          → { staff: CloudStaffView[] }
 *   POST /owner/company/staff                  CreateCloudStaffRequest → CloudStaffView (409 LICENSE_STAFF_LIMIT)
 *   POST /owner/company/staff/:id/update       UpdateCloudStaffRequest → CloudStaffView
 *   POST /owner/company/staff/:id/keys         IssueCloudKeyRequest → IssueCloudKeyResponse (422 KEY_WEAK, 409 KEY_TAKEN)
 *   POST /owner/company/keys/:id/revoke        → CloudKeyView
 */

const tariffsSchema: Schema = {
  type: 'object',
  required: ['tariffs'],
  properties: { tariffs: { type: 'array', items: { type: 'object' } } },
};

const deviceSchema: Schema = {
  type: 'object',
  required: ['token', 'platform'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 4096 },
    platform: { type: 'string', enum: DEVICE_PLATFORMS },
    name: { type: 'string', maxLength: 200 },
  },
};

const rulesSchema: Schema = {
  type: 'object',
  required: ['rules'],
  additionalProperties: false,
  properties: {
    rules: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['kind', 'clubId', 'enabled'],
        properties: { kind: { type: 'string' }, clubId: { type: ['string', 'null'] }, enabled: { type: 'boolean' } },
      },
    },
  },
};

export interface OwnerRow {
  id: string;
  company_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unauthorized = (message = 'Войдите в кабинет'): CloudError => new CloudError(401, 'UNAUTHORIZED', message);

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(segment))) as unknown;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  return parsed as Record<string, unknown>;
}

async function hs256Valid(token: string, secret: string): Promise<boolean> {
  const [h, p, s] = token.split('.') as [string, string, string];
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return globalThis.crypto.subtle.verify('HMAC', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
}

/**
 * The Supabase Auth user of the request: `sub` of the bearer JWT. The signature is checked
 * by the platform (verify_jwt = true); with SUPABASE_JWT_SECRET set, HS256 tokens are checked
 * here too. Expired tokens and non-user roles (anon, service_role) are refused.
 */
export async function authUserId(req: EdgeRequest, ctx: Pick<EdgeContext, 'now' | 'jwtSecret'>): Promise<string> {
  const token = bearerToken(req);
  if (!token) throw unauthorized();
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized();
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]!);
    claims = decodeSegment(parts[1]!);
  } catch {
    throw unauthorized();
  }
  if (ctx.jwtSecret && header.alg === 'HS256' && !(await hs256Valid(token, ctx.jwtSecret))) throw unauthorized();
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= ctx.now()) throw unauthorized('Сессия истекла, войдите снова');
  if (claims.role !== undefined && claims.role !== 'authenticated') throw unauthorized();
  if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) throw unauthorized();
  return claims.sub;
}

/** Owner linked to the Auth user (owners.auth_user_id), checked against auth.users. */
export async function requireOwner(req: EdgeRequest, ctx: EdgeContext): Promise<OwnerRow> {
  const userId = await authUserId(req, ctx);
  const rows = await ctx.db.all<OwnerRow>(
    'SELECT o.id, o.company_id FROM owners o JOIN auth.users u ON u.id = o.auth_user_id WHERE u.id = ?',
    [userId],
  );
  const owner = rows[0];
  await reportPushConfigured(ctx);
  if (!owner) throw new CloudError(403, 'NOT_OWNER', 'Этот вход не привязан к владельцу клубов');
  return owner;
}

async function requireClub(ctx: EdgeContext, owner: OwnerRow, clubId: string): Promise<ClubRow> {
  const club = await clubOfCompany(ctx.db, owner.company_id, clubId);
  if (!club) throw new CloudError(404, 'CLUB_NOT_FOUND', 'Клуб не найден');
  return club;
}

function checkDeviceToken(req: RegisterDeviceRequest): void {
  if (req.platform === 'webpush' && !parseWebPushToken(req.token)) {
    throw new CloudError(400, 'DEVICE_TOKEN', 'Подписка браузера на уведомления повреждена');
  }
  if (req.platform === 'ntfy' && !isNtfyTopicUrl(req.token)) {
    throw new CloudError(400, 'DEVICE_TOKEN', 'Адрес темы ntfy должен быть https://…/ts-… (24–64 символа)');
  }
}

export function corsHeaders(req: EdgeRequest, ctx: Pick<EdgeContext, 'corsOrigins'>): Record<string, string> {
  const origin = req.headers.get('origin');
  const allowed = ctx.corsOrigins.length === 0 ? '*' : origin && ctx.corsOrigins.includes(origin) ? origin : null;
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-max-age': '600',
    ...(allowed === '*' ? {} : { vary: 'Origin' }),
  };
}

const companyNotFound = (): CloudError => new CloudError(404, 'NOT_FOUND', 'Такого адреса нет');

/** /owner/company/<rest>: the manager cabinet. */
async function handleCompany(req: EdgeRequest, ctx: EdgeContext, rest: string): Promise<unknown> {
  const m = req.method;
  const staffAction = /^\/staff\/([^/]+)\/(update|keys)$/.exec(rest);
  const revoke = /^\/keys\/([^/]+)\/revoke$/.exec(rest);
  const known = (m === 'GET' && ['/license', '/branches', '/staff'].includes(rest)) || (m === 'POST' && (['/branches', '/staff'].includes(rest) || staffAction || revoke));
  if (!known) throw companyNotFound();
  const owner = await requireOwner(req, ctx);
  const me: ManagerRef = { id: owner.id, companyId: owner.company_id };
  const now = ctx.now();
  if (m === 'GET' && rest === '/license') return companyLicense(ctx.db, now, me);
  if (m === 'GET' && rest === '/branches') return listBranches(ctx.db, me);
  if (m === 'GET' && rest === '/staff') return listStaff(ctx.db, me, routeOf(req.url).query.get('clubId') || null);
  if (rest === '/branches') return createBranch(ctx.db, ctx.licenseSigner, now, me, await readJson(req));
  if (rest === '/staff') return createStaff(ctx.db, now, me, await readJson(req));
  if (staffAction) {
    const id = decodeURIComponent(staffAction[1]!);
    if (staffAction[2] === 'update') return updateStaff(ctx.db, now, me, id, await readJson(req));
    return issueStaffKey(ctx.db, now, me, id, await readOptionalJson(req));
  }
  return revokeStaffKey(ctx.db, now, me, decodeURIComponent(revoke![1]!));
}

export async function handleOwner(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  const cors = corsHeaders(req, ctx);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    await signPendingQuietly(ctx);
    // The cabinet calls `/functions/v1/owner/owner/...`: the function name may come twice.
    const path = routeOf(req.url).path.replace(/^\/owner(?=\/owner(\/|$))/, '');
    const m = req.method;
    const tariffs = /^\/owner\/clubs\/([^/]+)\/tariffs$/.exec(path);

    if (path.startsWith('/owner/company/')) return json(200, await handleCompany(req, ctx, path.slice('/owner/company'.length)), cors);
    const device = /^\/owner\/devices\/([^/]+)$/.exec(path);

    if (m === 'PUT' && tariffs) {
      const owner = await requireOwner(req, ctx);
      const club = await requireClub(ctx, owner, decodeURIComponent(tariffs[1]!));
      const body = validate<UpdateTariffsRequest>(await readJson(req), tariffsSchema);
      return json(200, await updateTariffs(ctx.db, ctx.now(), club, body), cors);
    }

    if (m === 'POST' && path === '/owner/push/test') {
      const owner = await requireOwner(req, ctx);
      const clubs = await ctx.db.all<{ id: string }>('SELECT id FROM clubs WHERE company_id = ? ORDER BY created_at LIMIT 1', [
        owner.company_id,
      ]);
      return json(200, await ctx.push.test(owner.id, clubs[0]?.id ?? ''), cors);
    }

    if (m === 'GET' && path === '/owner/push') {
      const owner = await requireOwner(req, ctx);
      return json(200, { ...(await ctx.push.settings(owner.id)), channels: ctx.pushChannels }, cors);
    }

    if (m === 'PUT' && path === '/owner/push/rules') {
      const owner = await requireOwner(req, ctx);
      const body = validate<UpdatePushRulesRequest>(await readJson(req), rulesSchema);
      for (const r of body.rules) {
        if (!isPushKind(r.kind)) throw new CloudError(400, 'PUSH_KIND', `Неизвестный вид уведомления: ${r.kind}`);
        if (r.clubId !== null) await requireClub(ctx, owner, r.clubId);
      }
      await saveRules(ctx.db, owner.id, body.rules);
      return json(200, await ctx.push.settings(owner.id), cors);
    }

    if (m === 'POST' && path === '/owner/devices') {
      const owner = await requireOwner(req, ctx);
      const body = validate<RegisterDeviceRequest>(await readJson(req), deviceSchema);
      checkDeviceToken(body);
      return json(200, await registerDevice(ctx.db, ctx.now(), owner.id, body), cors);
    }

    if (m === 'DELETE' && device) {
      const owner = await requireOwner(req, ctx);
      if (!(await removeDevice(ctx.db, owner.id, decodeURIComponent(device[1]!)))) {
        throw new CloudError(404, 'DEVICE_NOT_FOUND', 'Устройство не найдено');
      }
      return json(200, { ok: true }, cors);
    }

    return notFound(cors);
  } catch (e) {
    return errorResponse(e, ctx.log, cors);
  }
}
