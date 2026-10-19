import { webcrypto } from 'node:crypto';
import type { ManagerInviteResponse, ManagerTempPasswordResponse } from '@bills/domain';
import { CloudError } from '../errors.ts';
import { requirePlatformAction } from '../platform.ts';
import type { EdgeContext } from './context.ts';
import type { EdgeRequest, Schema } from './http.ts';
import { errorResponse, json, notFound, readOptionalJson, routeOf, validate } from './http.ts';
import { corsHeaders } from './owner.ts';
import { requirePlatform } from './platform.ts';

/**
 * Edge Function `invite-manager` (verify_jwt = false; the caller is checked like in `platform`:
 * a platform key session or the Supabase JWT of an owner/tech of TS, action clients.edit).
 * Gives a client's manager a Supabase Auth account — the cabinet signs managers in through it;
 * the account is linked to `owners` by e-mail (trigger ts_link_owner, once the e-mail is confirmed).
 *
 *   POST /invite-manager/clients/:companyId/invite         {managerId?} → ManagerInviteResponse
 *        Supabase sends an invitation letter; if the account already exists — a password-reset letter.
 *        The link leads to <TS_CABINET_URL>/#/set-password.
 *   POST /invite-manager/clients/:companyId/temp-password  {managerId?} → ManagerTempPasswordResponse
 *        No mail needed: the account is created (or updated) with a random password, the e-mail
 *        confirmed; the password is returned once, the cabinet makes the manager change it.
 */

/** user_metadata flag: the cabinet sends the user to «Задать пароль» until it is cleared. */
export const MUST_CHANGE_PASSWORD = 'ts_must_change_password';

export const SET_PASSWORD_PATH = '/#/set-password';

const bodySchema: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: { managerId: { type: 'string', minLength: 1, maxLength: 100 } },
};

/** Where the letter's link leads. */
export function setPasswordUrl(cabinetUrl: string): string {
  return `${cabinetUrl.replace(/\/+$/, '')}${SET_PASSWORD_PATH}`;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** «Abc4-xYz7-…»: 12 characters without look-alikes, upper + lower + digit always present (Supabase password rules). */
export function tempPassword(random: (n: number) => Uint8Array = (n) => webcrypto.getRandomValues(new Uint8Array(n))): string {
  for (;;) {
    const bytes = random(12);
    let s = '';
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) s += '-';
      s += ALPHABET[bytes[i]! % ALPHABET.length];
    }
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}

interface Manager {
  id: string;
  name: string;
  email: string;
}

async function managerOf(ctx: EdgeContext, companyId: string, managerId: string | undefined): Promise<Manager> {
  const companies = await ctx.db.all<{ id: string }>('SELECT id FROM companies WHERE id = ?', [companyId]);
  if (!companies[0]) throw new CloudError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
  const rows = managerId
    ? await ctx.db.all<Manager>('SELECT id, name, email FROM owners WHERE company_id = ? AND id = ?', [companyId, managerId])
    : await ctx.db.all<Manager>('SELECT id, name, email FROM owners WHERE company_id = ? ORDER BY created_at, id LIMIT 1', [companyId]);
  if (!rows[0]) throw new CloudError(404, 'MANAGER_NOT_FOUND', 'У клиента нет управляющего');
  return { ...rows[0], email: rows[0].email.trim().toLowerCase() };
}

function admin(ctx: EdgeContext) {
  if (!ctx.authAdmin) {
    throw new CloudError(503, 'AUTH_ADMIN_OFF', 'Функции не видят SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY — приглашения недоступны');
  }
  return ctx.authAdmin;
}

async function invite(ctx: EdgeContext, m: Manager): Promise<ManagerInviteResponse> {
  const auth = admin(ctx);
  const redirectTo = setPasswordUrl(ctx.cabinetUrl);
  const result = await auth.invite(m.email, redirectTo, { name: m.name });
  if (result === 'invited') return { status: 'invited', email: m.email, redirectTo };
  await auth.recover(m.email, redirectTo);
  return { status: 'reset-sent', email: m.email, redirectTo };
}

async function setTempPassword(ctx: EdgeContext, m: Manager): Promise<ManagerTempPasswordResponse> {
  const auth = admin(ctx);
  // A platform account is never taken over through a client's card.
  const staff = await ctx.db.all<{ id: string }>(
    `SELECT s.id FROM platform_staff s LEFT JOIN auth.users u ON u.id = s.auth_user_id
     WHERE s.is_active = 1 AND (lower(s.email) = ? OR lower(u.email) = ?)`,
    [m.email, m.email],
  );
  if (staff[0]) throw new CloudError(403, 'PLATFORM_ACCOUNT', 'Это учётная запись команды TS: временный пароль для неё не выдаётся');
  const password = tempPassword();
  const meta = { name: m.name, [MUST_CHANGE_PASSWORD]: true };
  const users = await ctx.db.all<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE lower(email) = ? LIMIT 1', [m.email]);
  if (users[0]) {
    await auth.updateUser(users[0].id, password, meta);
    return { email: m.email, password, created: false };
  }
  await auth.createUser(m.email, password, meta);
  return { email: m.email, password, created: true };
}

export async function handleInviteManager(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  const cors = corsHeaders(req, ctx);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const path = routeOf(req.url).path.replace(/^\/invite-manager(?=\/invite-manager(\/|$))/, '');
    const route = /^\/invite-manager\/clients\/([^/]+)\/(invite|temp-password)$/.exec(path);
    if (req.method !== 'POST' || !route) return notFound(cors);
    const me = await requirePlatform(req, ctx);
    requirePlatformAction(me, 'clients.edit');
    const body = validate<{ managerId?: string }>(await readOptionalJson(req), bodySchema);
    const m = await managerOf(ctx, decodeURIComponent(route[1]!), body.managerId);
    if (route[2] === 'invite') {
      const res = await invite(ctx, m);
      ctx.log(`invite-manager: ${me.name} → ${res.status} ${m.email}`);
      return json(200, res, cors);
    }
    const res = await setTempPassword(ctx, m);
    ctx.log(`invite-manager: ${me.name} → временный пароль ${m.email}`);
    return json(200, res, { ...cors, 'cache-control': 'no-store' });
  } catch (e) {
    return errorResponse(e, ctx.log, cors);
  }
}
