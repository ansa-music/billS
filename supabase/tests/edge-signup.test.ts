/**
 * Self sign-up (Edge Function `signup`) and the first steps of the manager cabinet:
 * a new connection code for the HUB, the business type of a branch, the onboarding facts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LicensePayload } from '@bills/domain';
import { DEV_LICENSE_KEY, parseHubSetupCode, shortKeyHashInput, verifyLicense } from '@bills/domain';
import { hashApiKey } from '../../apps/cloud/src/auth.ts';
import type { AuthAdmin } from '../../apps/cloud/src/edge/auth-admin.ts';
import { cloudUrlOf, edgeContext } from '../../apps/cloud/src/edge/context.ts';
import { CloudError } from '../../apps/cloud/src/errors.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { handleSignup, SIGNUP_TRIAL_DAYS } from '../../apps/cloud/src/edge/signup.ts';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import { licenseSignerFromEnv } from '../../apps/cloud/src/license.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, userJwt } from './edge-helpers.ts';

const DAY = 86_400_000;
const CLOUD_URL = 'https://ref.supabase.co/functions/v1';

type Call = { op: string; args: unknown[] };

/** Supabase Auth admin API over auth.users of the test database. */
function fakeAuthAdmin(e: EdgeTest, calls: Call[]): AuthAdmin {
  return {
    async invite() {
      throw new Error('not used');
    },
    async recover() {
      throw new Error('not used');
    },
    async createUser(email, password, meta) {
      calls.push({ op: 'createUser', args: [email, password, meta] });
      return e.s.createAuthUser(email);
    },
    async updateUser() {
      throw new Error('not used');
    },
    async deleteUser(id) {
      calls.push({ op: 'deleteUser', args: [id] });
      await e.s.db.run('DELETE FROM auth.users WHERE id = CAST(? AS uuid)', [id]);
    },
  };
}

async function signupTest(t: { after(fn: () => Promise<void>): void }) {
  const e = await edgeTest(t);
  const calls: Call[] = [];
  e.ctx.authAdmin = fakeAuthAdmin(e, calls);
  e.ctx.cloudUrl = CLOUD_URL;
  return { e, calls };
}

const FORM = {
  email: 'Cafe@Test.kz',
  password: 'kofe-2026',
  venueName: 'Кофейня Тест',
  businessType: 'cafe',
  timezone: 'Asia/Almaty',
  ownerName: 'Айгерим',
};

const post = (e: EdgeTest, body: unknown, ip = '203.0.113.7') =>
  e.call(handleSignup, 'POST', '/signup', { body, headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });

async function authIdOf(e: EdgeTest, email: string): Promise<string | null> {
  const rows = await e.s.db.all<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE lower(email) = lower(?)', [email]);
  return rows[0]?.id ?? null;
}

const count = async (e: EdgeTest, table: string): Promise<number> =>
  (await e.s.db.all<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;

test('signup: creates the account, company, branch with HUB, a 14-day trial and a manager with a six-digit key', async (t) => {
  const { e, calls } = await signupTest(t);
  const r = await post(e, FORM);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.ok, true);
  assert.match(r.body.managerKey, /^\d{6}$/);
  assert.equal(r.body.trialDays, SIGNUP_TRIAL_DAYS);
  assert.equal(SIGNUP_TRIAL_DAYS, 14);
  assert.equal(r.body.trialUntil, e.clock.now + 14 * DAY);
  const { companyId, clubId, hubId } = r.body as { companyId: string; clubId: string; hubId: string };
  assert.deepEqual(calls, [{ op: 'createUser', args: ['cafe@test.kz', 'kofe-2026', { name: 'Айгерим', ts_signup: true }] }]);

  const uid = await authIdOf(e, 'cafe@test.kz');
  const owner = await e.s.db.all<{ email: string; name: string; company_id: string; auth_user_id: string }>(
    'SELECT email, name, company_id, auth_user_id::text AS auth_user_id FROM owners WHERE company_id = ?',
    [companyId],
  );
  assert.deepEqual(owner, [{ email: 'cafe@test.kz', name: 'Айгерим', company_id: companyId, auth_user_id: uid }]);
  const club = await e.s.db.all('SELECT name, timezone, currency, business_type FROM clubs WHERE id = ? AND company_id = ?', [clubId, companyId]);
  assert.deepEqual(club, [{ name: 'Кофейня Тест', timezone: 'Asia/Almaty', currency: 'KZT', business_type: 'cafe' }]);
  assert.equal((await e.s.db.all('SELECT id FROM hubs WHERE id = ? AND club_id = ?', [hubId, clubId])).length, 1);

  // The licence: signed (dev key without LICENSE_SIGNING_KEY), trial, 14 days, 1 branch, every module, this HUB.
  const lic = await e.s.db.all<{ signed: string; issued_by: string }>('SELECT signed, issued_by FROM licenses WHERE company_id = ?', [companyId]);
  assert.equal(lic.length, 1);
  assert.equal(lic[0]!.issued_by, 'signup');
  const checked = await verifyLicense(lic[0]!.signed, { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.ok(checked.ok);
  const p: LicensePayload = checked.license;
  assert.equal(p.plan, 'trial');
  assert.equal(p.validUntil - p.validFrom, 14 * DAY);
  assert.equal(p.maxClubs, 1);
  assert.deepEqual(p.modules, { bar: true, cloud: true, hardware: true });
  assert.deepEqual(p.hubIds, [hubId]);
  assert.equal(p.companyName, 'Кофейня Тест');

  // The first staff member: role manager, the returned key works in this branch only.
  const staff = await e.s.db.all<{ id: string; name: string; roles: string }>('SELECT id, name, roles FROM club_staff WHERE club_id = ?', [clubId]);
  assert.equal(staff.length, 1);
  assert.equal(staff[0]!.name, 'Айгерим');
  assert.deepEqual(JSON.parse(staff[0]!.roles), ['manager']);
  const key = await e.s.db.all('SELECT kind FROM club_keys WHERE staff_id = ? AND key_hash = ?', [
    staff[0]!.id,
    hashApiKey(shortKeyHashInput(clubId, r.body.managerKey)),
  ]);
  assert.deepEqual(key, [{ kind: 'short' }]);

  // The cabinet signs in with the new account right away.
  const h = { authorization: `Bearer ${userJwt(uid!)}` };
  const license = await e.call(handleOwner, 'GET', '/owner/company/license', { headers: h });
  assert.equal(license.status, 200, JSON.stringify(license.body));
  assert.equal(license.body.license.status.state, 'active');
  const branches = await e.call(handleOwner, 'GET', '/owner/company/branches', { headers: h });
  assert.equal(branches.body.branches[0].businessType, 'cafe');

  // No owner name → «Управляющий»; no time zone → Asia/Almaty; billiards.
  const plain = await post(e, { email: 'club@test.kz', password: '12345678', venueName: ' Бильярд ', businessType: 'billiards' });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  const plainStaff = await e.s.db.all<{ name: string }>('SELECT name FROM club_staff WHERE club_id = ?', [plain.body.clubId]);
  assert.deepEqual(plainStaff, [{ name: 'Управляющий' }]);
  const plainClub = await e.s.db.all('SELECT name, timezone, business_type FROM clubs WHERE id = ?', [plain.body.clubId]);
  assert.deepEqual(plainClub, [{ name: 'Бильярд', timezone: 'Asia/Almaty', business_type: 'billiards' }]);
});

test('signup: one account per e-mail — EMAIL_TAKEN in simple words', async (t) => {
  const { e, calls } = await signupTest(t);
  assert.equal((await post(e, FORM)).status, 201);
  calls.length = 0;
  const again = await post(e, { ...FORM, email: ' CAFE@test.KZ ', venueName: 'Вторая' });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { error: { code: 'EMAIL_TAKEN', message: 'Эта почта уже зарегистрирована — войдите' } });
  assert.deepEqual(calls, [], 'Supabase Auth is not called');

  // An Auth account without a venue (a platform person, an invitation) is taken too.
  await e.s.createAuthUser('team@ts.kz');
  assert.equal((await post(e, { ...FORM, email: 'team@ts.kz' })).body.error.code, 'EMAIL_TAKEN');

  // Supabase Auth says «exists» (a race): the same answer, nothing created.
  e.ctx.authAdmin = { ...fakeAuthAdmin(e, calls), createUser: async () => Promise.reject(new CloudError(409, 'EMAIL_TAKEN', 'x')) };
  const companies = await count(e, 'companies');
  const race = await post(e, { ...FORM, email: 'race@test.kz' });
  assert.equal(race.status, 409);
  assert.equal(race.body.error.message, 'Эта почта уже зарегистрирована — войдите');
  assert.equal(await count(e, 'companies'), companies);
});

test('signup: form checks — e-mail, password, name, business type, time zone', async (t) => {
  const { e, calls } = await signupTest(t);
  const code = async (body: unknown) => {
    const r = await post(e, body);
    return [r.status, r.body.error?.code];
  };
  assert.deepEqual(await code({ ...FORM, password: 'short' }), [422, 'WEAK_PASSWORD']);
  assert.deepEqual(await code({ ...FORM, password: 'x'.repeat(73) }), [422, 'WEAK_PASSWORD']);
  assert.deepEqual(await code({ ...FORM, password: undefined }), [422, 'WEAK_PASSWORD']);
  assert.deepEqual(await code({ ...FORM, email: 'not-an-email' }), [422, 'INVALID_EMAIL']);
  assert.deepEqual(await code({ ...FORM, email: 'a@b' }), [422, 'INVALID_EMAIL']);
  assert.deepEqual(await code({ ...FORM, venueName: '   ' }), [422, 'NAME_REQUIRED']);
  assert.deepEqual(await code({ ...FORM, businessType: 'bar' }), [422, 'INVALID_BUSINESS_TYPE']);
  assert.deepEqual(await code({ ...FORM, timezone: 'Mars/Olympus' }), [422, 'INVALID_TIMEZONE']);
  assert.deepEqual(await code([1, 2]), [400, 'BAD_REQUEST']);
  const weak = await post(e, { ...FORM, password: '1234567' });
  assert.equal(weak.body.error.message, 'Пароль слишком короткий: нужно не меньше 8 символов');
  assert.deepEqual(calls, []);
  assert.equal(await count(e, 'signup_attempts'), 0, 'a broken form is not an attempt');

  // Supabase Auth's own password rules: the form's words, not GoTrue's.
  e.ctx.authAdmin = {
    ...fakeAuthAdmin(e, calls),
    createUser: async () => {
      throw new CloudError(422, 'WEAK_PASSWORD', 'Supabase не принял пароль: Password should contain symbols');
    },
  };
  const gotrue = await post(e, FORM);
  assert.equal(gotrue.status, 422);
  assert.equal(gotrue.body.error.code, 'WEAK_PASSWORD');
  assert.doesNotMatch(gotrue.body.error.message, /Supabase/);
});

test('signup: at most 5 attempts per IP an hour, TS_SIGNUP_DISABLED, no admin API, CORS', async (t) => {
  const { e } = await signupTest(t);
  for (let i = 0; i < 5; i++) {
    const r = await post(e, { ...FORM, email: `v${i}@test.kz` }, '198.51.100.1');
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // Taken e-mails count too (no free guessing of addresses).
  const limited = await post(e, { ...FORM, email: 'v9@test.kz' }, '198.51.100.1');
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body.error, { code: 'RATE_LIMITED', message: 'Слишком много попыток регистрации. Попробуйте через час' });
  assert.equal(await authIdOf(e, 'v9@test.kz'), null);
  // Another address is not limited; an hour later the first one may try again.
  assert.equal((await post(e, { ...FORM, email: 'other@test.kz' }, '198.51.100.2')).status, 201);
  e.clock.now += 3_600_001;
  assert.equal((await post(e, { ...FORM, email: 'v9@test.kz' }, '198.51.100.1')).status, 201);
  // The stored address is a hash.
  const stored = await e.s.db.all<{ ip_hash: string }>('SELECT ip_hash FROM signup_attempts');
  assert.ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash)));

  e.ctx.signup.disabled = true;
  const off = await post(e, { ...FORM, email: 'closed@test.kz' }, '192.0.2.9');
  assert.equal(off.status, 403);
  assert.equal(off.body.error.code, 'SIGNUP_DISABLED');
  e.ctx.signup.disabled = false;

  e.ctx.authAdmin = null;
  const noAdmin = await post(e, { ...FORM, email: 'noadmin@test.kz' }, '192.0.2.10');
  assert.equal(noAdmin.status, 503);
  assert.equal(noAdmin.body.error.code, 'AUTH_ADMIN_OFF');

  const options = await e.call(handleSignup, 'OPTIONS', '/signup');
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  assert.equal((await e.call(handleSignup, 'GET', '/signup')).status, 404);
  assert.equal((await e.call(handleSignup, 'POST', '/functions/v1/signup', { body: {} })).body.error.code, 'INVALID_EMAIL');

  const db = {} as Parameters<typeof edgeContext>[0];
  const ctx = (env: Record<string, string>) => edgeContext(db, env, { log: () => {} });
  assert.deepEqual(ctx({}).signup, { disabled: false, perHour: 5 });
  assert.deepEqual(ctx({ TS_SIGNUP_DISABLED: '1', TS_SIGNUP_PER_HOUR: '20' }).signup, { disabled: true, perHour: 20 });
  assert.equal(ctx({}).cloudUrl, null);
  assert.equal(cloudUrlOf({ SUPABASE_URL: 'https://ref.supabase.co/' }), CLOUD_URL);
  assert.equal(cloudUrlOf({ SUPABASE_URL: 'https://ref.supabase.co', TS_CLOUD_URL: 'https://cloud.example.kz/' }), 'https://cloud.example.kz');
});

test('signup: a failure after the Auth user is created deletes it — no half-created accounts', async (t) => {
  const { e, calls } = await signupTest(t);
  const before = { companies: await count(e, 'companies'), clubs: await count(e, 'clubs'), hubs: await count(e, 'hubs'), owners: await count(e, 'owners') };
  e.ctx.licenseSigner = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: 'not a key' });
  const r = await post(e, FORM);
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'LICENSE_SIGN_FAILED');
  assert.deepEqual(
    calls.map((c) => c.op),
    ['createUser', 'deleteUser'],
  );
  assert.equal(await authIdOf(e, FORM.email), null);
  assert.deepEqual(
    { companies: await count(e, 'companies'), clubs: await count(e, 'clubs'), hubs: await count(e, 'hubs'), owners: await count(e, 'owners') },
    before,
  );

  // A failing cleanup is logged, the original error still answers.
  e.ctx.authAdmin = { ...fakeAuthAdmin(e, calls), deleteUser: async () => Promise.reject(new Error('Auth down')) };
  const again = await post(e, { ...FORM, email: 'second@test.kz' });
  assert.equal(again.body.error.code, 'LICENSE_SIGN_FAILED');
  assert.ok(e.log.some((l) => l.includes('не удалось удалить пользователя') && l.includes('Auth down')));

  // The signer fixed: the same e-mail signs up fine.
  e.ctx.licenseSigner = licenseSignerFromEnv({});
  e.ctx.authAdmin = fakeAuthAdmin(e, calls);
  assert.equal((await post(e, FORM)).status, 201);
});

async function signedUp(t: { after(fn: () => Promise<void>): void }) {
  const { e } = await signupTest(t);
  const r = await post(e, FORM);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const uid = (await authIdOf(e, FORM.email))!;
  return { e, h: { authorization: `Bearer ${userJwt(uid)}` }, clubId: r.body.clubId as string, hubId: r.body.hubId as string };
}

test('hub-code: a new HUB key and connection code; the old key stops working', async (t) => {
  const { e, h, clubId, hubId } = await signedUp(t);
  const first = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/hub-code`, { headers: h });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.body.hubId, hubId);
  assert.equal(first.body.cloudUrl, CLOUD_URL);
  assert.deepEqual(parseHubSetupCode(first.body.code), { ok: true, value: { hubId, apiKey: first.body.apiKey, cloudUrl: CLOUD_URL } });

  // The HUB connects with it: GET /sync/settings carries the business type even when nothing changed.
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const check = await e.call(handleSync, 'GET', `/sync/settings?since=999999&hubId=${hubId}`, { headers: auth(first.body.apiKey) });
  assert.equal(check.status, 200);
  assert.deepEqual(check.body, { changed: false, version: 0, business: { type: 'cafe' } });
  const access = await e.call(handleSync, 'GET', '/sync/access', { headers: auth(first.body.apiKey) });
  assert.equal(access.status, 200);
  assert.deepEqual(access.body.business, { type: 'cafe' });

  const second = await e.call(handleOwner, 'POST', `/functions/v1/owner/owner/clubs/${clubId}/hub-code`, { headers: h });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.apiKey, first.body.apiKey);
  const old = await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: auth(first.body.apiKey) });
  assert.equal(old.status, 401);
  assert.equal((await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: auth(second.body.apiKey) })).status, 200);

  // Someone else's branch, no address of the cloud, an expired trial.
  const demoClub = (await e.s.db.all<{ id: string }>("SELECT id FROM clubs WHERE id <> ? ORDER BY created_at LIMIT 1", [clubId]))[0]!.id;
  const foreign = await e.call(handleOwner, 'POST', `/owner/clubs/${demoClub}/hub-code`, { headers: h });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'CLUB_NOT_FOUND');
  e.ctx.cloudUrl = null;
  const noUrl = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/hub-code`, { headers: h });
  assert.equal(noUrl.status, 503);
  assert.equal(noUrl.body.error.code, 'CLOUD_URL_MISSING');
  assert.equal((await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: auth(second.body.apiKey) })).status, 200, 'key kept');
  e.ctx.cloudUrl = CLOUD_URL;
  e.clock.now += 15 * DAY;
  const expired = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/hub-code`, { headers: h });
  assert.equal(expired.status, 403);
  assert.equal(expired.body.error.code, 'LICENSE_READ_ONLY');
  assert.equal((await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/hub-code`)).status, 401);
});

test('business type: the manager switches it, the HUB sees it in settings and access', async (t) => {
  const { e, h, clubId, hubId } = await signedUp(t);
  const code = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/hub-code`, { headers: h });
  const auth = { authorization: `Bearer ${code.body.apiKey}` };
  const before = (await e.call(handleSync, 'GET', '/sync/access', { headers: auth })).body.version as number;

  const r = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/business`, { headers: h, body: { type: 'billiards' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, clubId);
  assert.equal(r.body.businessType, 'billiards');
  const access = await e.call(handleSync, 'GET', `/sync/access?hubId=${hubId}`, { headers: auth });
  assert.ok(access.body.version > before, 'access version bumped: the HUB pulls it');
  assert.deepEqual(access.body.business, { type: 'billiards' });
  assert.deepEqual((await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: auth })).body.business, { type: 'billiards' });

  const bad = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/business`, { headers: h, body: { type: 'bar' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'INVALID_BUSINESS_TYPE');
});

test('onboarding: per branch — HUB connected, staff, tariffs, shifts; menu unknown (null)', async (t) => {
  const { e, h, clubId, hubId } = await signedUp(t);
  const get = async () => {
    const r = await e.call(handleOwner, 'GET', '/owner/onboarding', { headers: h });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  assert.deepEqual(await get(), {
    clubs: [
      {
        clubId,
        name: 'Кофейня Тест',
        businessType: 'cafe',
        hubId,
        hubConnected: false,
        lastSeenAt: null,
        staff: 1,
        tariffs: 0,
        shifts: 0,
        menu: null,
      },
    ],
  });

  const code = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/hub-code`, { headers: h });
  e.clock.now += 60_000;
  await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: { authorization: `Bearer ${code.body.apiKey}` } });
  await e.s.db.run(
    `INSERT INTO club_settings (club_id, version, club_json, tariffs_json, tables_json, staff_json, updated_at, source)
     VALUES (?, 0, '{}', '[{"id":"t1"},{"id":"t2"}]', '[]', '[]', ?, 'hub')`,
    [clubId, e.clock.now],
  );
  await e.s.db.run("INSERT INTO shifts (id, club_id, number, status, opened_at, opened_by) VALUES ('s1', ?, 1, 'OPEN', ?, 'x')", [clubId, e.clock.now]);
  const after = (await get()).clubs[0];
  assert.equal(after.hubConnected, true);
  assert.equal(after.lastSeenAt, e.clock.now);
  assert.equal(after.tariffs, 2);
  assert.equal(after.shifts, 1);
  assert.equal(after.menu, null);
  assert.equal((await e.call(handleOwner, 'GET', '/owner/onboarding')).status, 401);
});
