import { createHash, randomUUID } from 'node:crypto';
import type { LicensePayload, SignupRequest, SignupResponse } from '@bills/domain';
import { LICENSE_MODULES } from '@bills/domain';
import { insertClubWithHub, isValidTimezone } from '../admin.ts';
import { normalizeEmail } from '../auth.ts';
import { isBusinessType, issueStaffKey } from '../company.ts';
import { CloudError } from '../errors.ts';
import { storeLicense } from '../license.ts';
import { initialSettings } from '../settings.ts';
import { EMAIL_TAKEN_MESSAGE } from './auth-admin.ts';
import type { EdgeContext } from './context.ts';
import type { EdgeRequest } from './http.ts';
import { errorResponse, json, notFound, readJson, routeOf } from './http.ts';
import { corsHeaders } from './owner.ts';

/**
 * Edge Function `signup` (verify_jwt = false): a venue signs itself up from the cabinet —
 * no letter, no platform owner in the loop.
 *
 *   POST /signup  SignupRequest → 201 SignupResponse
 *
 * 1. Checks: TS_SIGNUP_DISABLED, the fields, TS_SIGNUP_PER_HOUR attempts per IP (signup_attempts),
 *    one account per e-mail (owners and auth.users).
 * 2. The Supabase Auth user through the admin API (email_confirm: true — no SMTP needed).
 * 3. One transaction: the company, its manager (`owners`, linked to the Auth user), the first
 *    branch with its HUB (KZT, the time zone from the form, the business type), a signed
 *    trial licence for SIGNUP_TRIAL_DAYS days (1 branch, every module), and the first staff
 *    member (role manager) with a six-digit key returned once.
 * If step 3 fails, the Auth user is deleted again: no half-created accounts.
 */

/** Length of the trial a sign-up gets. */
export const SIGNUP_TRIAL_DAYS = 14;
export const SIGNUP_MIN_PASSWORD = 8;
/** bcrypt (Supabase Auth) reads at most 72 bytes. */
export const SIGNUP_MAX_PASSWORD = 72;
export const DEFAULT_STAFF_NAME = 'Управляющий';
export const DEFAULT_TIMEZONE = 'Asia/Almaty';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const invalid = (code: string, message: string): CloudError => new CloudError(422, code, message);

interface SignupInput {
  email: string;
  password: string;
  venueName: string;
  businessType: SignupRequest['businessType'];
  timezone: string;
  staffName: string;
}

export function readSignup(raw: unknown): SignupInput {
  if (!isObject(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Заполните форму регистрации');
  const email = normalizeEmail(text(raw.email));
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid('INVALID_EMAIL', 'Проверьте почту: она пишется как name@example.kz');
  }
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (password.length < SIGNUP_MIN_PASSWORD) {
    throw invalid('WEAK_PASSWORD', `Пароль слишком короткий: нужно не меньше ${SIGNUP_MIN_PASSWORD} символов`);
  }
  if (new TextEncoder().encode(password).length > SIGNUP_MAX_PASSWORD) {
    throw invalid('WEAK_PASSWORD', `Пароль слишком длинный: не больше ${SIGNUP_MAX_PASSWORD} символов`);
  }
  const venueName = text(raw.venueName).slice(0, 120);
  if (!venueName) throw invalid('NAME_REQUIRED', 'Напишите название заведения');
  if (!isBusinessType(raw.businessType)) throw invalid('INVALID_BUSINESS_TYPE', 'Выберите тип заведения: бильярдный клуб или кофейня');
  const timezone = text(raw.timezone) || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) throw invalid('INVALID_TIMEZONE', 'Не удалось определить часовой пояс — выберите город из списка');
  const staffName = text(raw.ownerName).slice(0, 120) || DEFAULT_STAFF_NAME;
  return { email, password, venueName, businessType: raw.businessType, timezone, staffName };
}

/** The caller's address as the Supabase gateway / Cloudflare pass it; 'unknown' without one. */
export function clientIp(req: EdgeRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return req.headers.get('cf-connecting-ip')?.trim() || forwarded || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Counts the attempt; 429 RATE_LIMITED past `perHour` attempts of this IP within the last hour. */
async function countAttempt(ctx: EdgeContext, ip: string): Promise<void> {
  const now = ctx.now();
  const ipHash = createHash('sha256').update(`ts-signup:${ip}`).digest('hex');
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM signup_attempts WHERE at < ?', [now - DAY_MS]);
    const rows = await tx.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM signup_attempts WHERE ip_hash = ? AND at > ?', [ipHash, now - HOUR_MS]);
    if (Number(rows[0]?.n ?? 0) >= ctx.signup.perHour) {
      throw new CloudError(429, 'RATE_LIMITED', 'Слишком много попыток регистрации. Попробуйте через час');
    }
    await tx.run('INSERT INTO signup_attempts (id, ip_hash, at) VALUES (?, ?, ?)', [randomUUID(), ipHash, now]);
  });
}

async function emailTaken(ctx: EdgeContext, email: string): Promise<boolean> {
  const rows = await ctx.db.all<{ id: string }>(
    `SELECT id FROM owners WHERE lower(email) = ?
     UNION ALL SELECT id::text AS id FROM auth.users WHERE lower(email) = ?
     LIMIT 1`,
    [email, email],
  );
  return rows.length > 0;
}

/** Supabase Auth's own refusals in the words of the form. */
function signupAuthError(e: unknown): unknown {
  if (!(e instanceof CloudError)) return e;
  if (e.code === 'EMAIL_TAKEN') return new CloudError(409, 'EMAIL_TAKEN', EMAIL_TAKEN_MESSAGE);
  if (e.code === 'WEAK_PASSWORD') return invalid('WEAK_PASSWORD', 'Пароль слишком простой: добавьте буквы разного размера и цифры');
  if (e.code === 'EMAIL_INVALID') return invalid('INVALID_EMAIL', 'Проверьте почту: она пишется как name@example.kz');
  if (e.code === 'RATE_LIMIT') return new CloudError(429, 'RATE_LIMITED', 'Слишком много попыток регистрации. Попробуйте через час');
  return e;
}

/** Everything in the database for a new Auth user; one transaction. */
async function createVenue(ctx: EdgeContext, input: SignupInput, authUserId: string): Promise<SignupResponse> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const companyId = randomUUID();
    const ownerId = randomUUID();
    await tx.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [companyId, input.venueName, now]);
    // No password here ('!' never verifies): the manager signs in through Supabase Auth.
    await tx.run(
      `INSERT INTO owners (id, company_id, email, name, password_hash, created_at, auth_user_id)
       VALUES (?, ?, ?, ?, '!', ?, CAST(? AS uuid))`,
      [ownerId, companyId, input.email, input.staffName, now, authUserId],
    );
    const clubInput = { name: input.venueName, timezone: input.timezone, currency: 'KZT' };
    const club = await insertClubWithHub(tx, now, companyId, clubInput);
    // Version 1: a fresh HUB pulls the venue's name before its own snapshot can replace it.
    await initialSettings(tx, club.clubId, clubInput, now);
    await tx.run('UPDATE clubs SET business_type = ? WHERE id = ?', [input.businessType, club.clubId]);

    const payload: LicensePayload = {
      v: 1,
      id: randomUUID(),
      companyId,
      companyName: input.venueName,
      plan: 'trial',
      issuedAt: now,
      validFrom: now,
      validUntil: now + SIGNUP_TRIAL_DAYS * DAY_MS,
      maxClubs: 1,
      maxTables: null,
      maxStaff: null,
      modules: Object.fromEntries(LICENSE_MODULES.map((m) => [m, true])) as LicensePayload['modules'],
      hubIds: [club.hubId],
      blocked: false,
    };
    // Without LICENSE_SIGNING_KEY the context's signer is the dev key, as for clients the platform creates.
    await storeLicense(tx, ctx.licenseSigner, payload, 'signup');

    const staffId = randomUUID();
    await tx.run(
      'INSERT INTO club_staff (id, club_id, company_id, name, roles, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [staffId, club.clubId, companyId, input.staffName, JSON.stringify(['manager']), now, now],
    );
    const issued = await issueStaffKey(tx, now, { id: ownerId, companyId }, staffId, { label: 'Регистрация' });
    return {
      ok: true,
      companyId,
      clubId: club.clubId,
      hubId: club.hubId,
      managerKey: issued.key,
      trialDays: SIGNUP_TRIAL_DAYS,
      trialUntil: payload.validUntil,
    };
  });
}

export async function signup(ctx: EdgeContext, req: EdgeRequest): Promise<SignupResponse> {
  if (ctx.signup.disabled) throw new CloudError(403, 'SIGNUP_DISABLED', 'Регистрация сейчас закрыта. Напишите в поддержку TS');
  const input = readSignup(await readJson(req));
  await countAttempt(ctx, clientIp(req));
  if (await emailTaken(ctx, input.email)) throw new CloudError(409, 'EMAIL_TAKEN', EMAIL_TAKEN_MESSAGE);
  const auth = ctx.authAdmin;
  if (!auth) throw new CloudError(503, 'AUTH_ADMIN_OFF', 'Регистрация не настроена: функции не видят SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');

  let userId: string;
  try {
    userId = await auth.createUser(input.email, input.password, { name: input.staffName, ts_signup: true });
  } catch (e) {
    throw signupAuthError(e);
  }
  try {
    return await createVenue(ctx, input, userId);
  } catch (e) {
    try {
      await auth.deleteUser(userId);
    } catch (cleanup) {
      ctx.log(`signup: не удалось удалить пользователя ${userId} после ошибки: ${(cleanup as Error).message}`);
    }
    throw e;
  }
}

export async function handleSignup(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  const cors = corsHeaders(req, ctx);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    // Supabase hands the function `/signup`; behind a proxy `/functions/v1/signup` (routeOf strips it).
    const path = routeOf(req.url).path.replace(/^\/signup(?=\/signup(\/|$))/, '');
    if (req.method !== 'POST' || path !== '/signup') return notFound(cors);
    const res = await signup(ctx, req);
    ctx.log(`signup: новое заведение ${res.companyId} (${res.hubId})`);
    return json(201, res, { ...cors, 'cache-control': 'no-store' });
  } catch (e) {
    return errorResponse(e, ctx.log, cors);
  }
}
