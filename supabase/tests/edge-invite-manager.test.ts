/**
 * Edge Function `invite-manager`: the manager of a new client gets a Supabase Auth account —
 * an invitation letter (or a reset letter for an existing account) or a temporary password —
 * and the account is linked to the client's manager by e-mail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LicenseTermsRequest } from '@bills/domain';
import { DEV_LICENSE_KEY, verifyLicense } from '@bills/domain';
import type { AuthAdmin } from '../../apps/cloud/src/edge/auth-admin.ts';
import { authAdminApi } from '../../apps/cloud/src/edge/auth-admin.ts';
import { DEFAULT_CABINET_URL, edgeContext } from '../../apps/cloud/src/edge/context.ts';
import { MUST_CHANGE_PASSWORD, handleInviteManager, setPasswordUrl, tempPassword } from '../../apps/cloud/src/edge/invite-manager.ts';
import { internalMessage } from '../../apps/cloud/src/edge/http.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { licenseSignerFromEnv, normalizeSigningKey } from '../../apps/cloud/src/license.ts';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, userJwt } from './edge-helpers.ts';

const TRIAL_7: LicenseTermsRequest = { term: { kind: 'trial', days: 7 }, maxClubs: 1, modules: { bar: true, cloud: true, hardware: true } };

type Call = { op: string; args: unknown[] };

/** Stands in for Supabase Auth: users live in auth.users of the test database. */
function fakeAuthAdmin(e: EdgeTest, calls: Call[]): AuthAdmin {
  const exists = async (email: string) =>
    (await e.s.db.all<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE lower(email) = lower(?)', [email]))[0]?.id ?? null;
  return {
    async invite(email, redirectTo, data) {
      calls.push({ op: 'invite', args: [email, redirectTo, data] });
      return (await exists(email)) ? 'exists' : 'invited';
    },
    async recover(email, redirectTo) {
      calls.push({ op: 'recover', args: [email, redirectTo] });
    },
    async createUser(email, password, meta) {
      calls.push({ op: 'createUser', args: [email, password, meta] });
      return e.s.createAuthUser(email);
    },
    async updateUser(id, password, meta) {
      calls.push({ op: 'updateUser', args: [id, password, meta] });
    },
  };
}

async function platformToken(e: EdgeTest, key: string): Promise<Record<string, string>> {
  const r = await e.call(handlePlatform, 'POST', '/platform/login', { body: { key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { authorization: `Bearer ${r.body.token}` };
}

async function newClient(e: EdgeTest, owner: Record<string, string>, email: string): Promise<string> {
  const r = await e.call(handlePlatform, 'POST', '/platform/clients', {
    headers: owner,
    body: { companyName: 'Сеть И', managerName: 'Ирина', managerEmail: email, license: TRIAL_7 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.client.companyId as string;
}

test('invite-manager: an invitation to <cabinet>/#/set-password; the confirmed account becomes the manager', async (t) => {
  const e = await edgeTest(t);
  const calls: Call[] = [];
  e.ctx.authAdmin = fakeAuthAdmin(e, calls);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const companyId = await newClient(e, owner, 'Irina@I.kz');

  const r = await e.call(handleInviteManager, 'POST', `/invite-manager/clients/${companyId}/invite`, { headers: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { status: 'invited', email: 'irina@i.kz', redirectTo: 'https://ts-cabinet.pages.dev/#/set-password' });
  assert.deepEqual(calls, [{ op: 'invite', args: ['irina@i.kz', 'https://ts-cabinet.pages.dev/#/set-password', { name: 'Ирина' }] }]);

  // The manager opens the letter: Supabase confirms the account → linked by e-mail → the manager cabinet works.
  const uid = await e.s.createAuthUser('irina@i.kz');
  const linked = await e.s.db.all<{ auth_user_id: string }>('SELECT auth_user_id::text AS auth_user_id FROM owners WHERE company_id = ?', [companyId]);
  assert.equal(linked[0]!.auth_user_id, uid);
  const lic = await e.call(handleOwner, 'GET', '/owner/company/license', { headers: { authorization: `Bearer ${userJwt(uid)}` } });
  assert.equal(lic.status, 200, JSON.stringify(lic.body));
  assert.equal(lic.body.license.payload.companyId, companyId);

  // «Отправить приглашение ещё раз» for an existing account: a password-reset letter instead.
  calls.length = 0;
  const again = await e.call(handleInviteManager, 'POST', `/functions/v1/invite-manager/clients/${companyId}/invite`, { headers: owner, body: {} });
  assert.equal(again.body.status, 'reset-sent');
  assert.deepEqual(
    calls.map((c) => c.op),
    ['invite', 'recover'],
  );
  assert.deepEqual(calls[1]!.args, ['irina@i.kz', 'https://ts-cabinet.pages.dev/#/set-password']);

  // TS_CABINET_URL decides where the link leads.
  e.ctx.cabinetUrl = 'https://ansa-music.github.io/billS/cabinet';
  const gh = await e.call(handleInviteManager, 'POST', `/invite-manager/clients/${companyId}/invite`, { headers: owner });
  assert.equal(gh.body.redirectTo, 'https://ansa-music.github.io/billS/cabinet/#/set-password');
});

test('invite-manager temp-password: created once with a must-change flag, then updated; shown to the platform only', async (t) => {
  const e = await edgeTest(t);
  const calls: Call[] = [];
  e.ctx.authAdmin = fakeAuthAdmin(e, calls);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const tech = await platformToken(e, DEMO_PLATFORM[1].key);
  const companyId = await newClient(e, owner, 'oleg@o.kz');

  const first = await e.call(handleInviteManager, 'POST', `/invite-manager/clients/${companyId}/temp-password`, { headers: tech });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.body.email, 'oleg@o.kz');
  assert.equal(first.body.created, true);
  assert.match(first.body.password, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
  assert.deepEqual(calls[0], { op: 'createUser', args: ['oleg@o.kz', first.body.password, { name: 'Ирина', [MUST_CHANGE_PASSWORD]: true }] });
  const [link] = await e.s.db.all<{ linked: boolean }>('SELECT auth_user_id IS NOT NULL AS linked FROM owners WHERE company_id = ?', [companyId]);
  assert.equal(link!.linked, true);
  // The password is never logged.
  assert.ok(!e.log.some((l) => l.includes(first.body.password)));

  const second = await e.call(handleInviteManager, 'POST', `/invite-manager/clients/${companyId}/temp-password`, { headers: owner });
  assert.equal(second.body.created, false);
  assert.notEqual(second.body.password, first.body.password);
  assert.equal(calls[1]!.op, 'updateUser');
  assert.equal(calls[1]!.args[1], second.body.password);
});

test('invite-manager: platform only, a platform account is never reset, errors are words', async (t) => {
  const e = await edgeTest(t);
  const calls: Call[] = [];
  e.ctx.authAdmin = fakeAuthAdmin(e, calls);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const companyId = await newClient(e, owner, 'boss@ts.kz');
  const url = (op: string, id = companyId) => `/invite-manager/clients/${id}/${op}`;

  assert.equal((await e.call(handleInviteManager, 'POST', url('invite'))).status, 401);
  const manager = await e.s.createAuthUser('boss@ts.kz');
  assert.equal((await e.call(handleInviteManager, 'POST', url('invite'), { headers: { authorization: `Bearer ${userJwt(manager)}` } })).status, 401);
  assert.equal((await e.call(handleInviteManager, 'GET', url('invite'), { headers: owner })).status, 404);
  assert.equal((await e.call(handleInviteManager, 'POST', url('nope'), { headers: owner })).status, 404);
  const missing = await e.call(handleInviteManager, 'POST', url('invite', 'no-such-company'), { headers: owner });
  assert.equal(missing.body.error.code, 'CLIENT_NOT_FOUND');
  const wrongManager = await e.call(handleInviteManager, 'POST', url('invite'), { headers: owner, body: { managerId: 'x' } });
  assert.equal(wrongManager.body.error.code, 'MANAGER_NOT_FOUND');

  // The manager's e-mail is also a platform owner's: no temporary password for it.
  await e.s.db.all("SELECT public.ts_make_platform_owner('boss@ts.kz')");
  const denied = await e.call(handleInviteManager, 'POST', url('temp-password'), { headers: owner });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PLATFORM_ACCOUNT');
  assert.ok(!calls.some((c) => c.op === 'updateUser' || c.op === 'createUser'));

  e.ctx.authAdmin = null;
  const off = await e.call(handleInviteManager, 'POST', url('invite'), { headers: owner });
  assert.equal(off.status, 503);
  assert.equal(off.body.error.code, 'AUTH_ADMIN_OFF');
});

test('authAdminApi: GoTrue admin calls with the service key; exists / rate limit / mail errors', async () => {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let answer: () => Response = () => new Response('{}', { status: 200 });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return answer();
  }) as unknown as typeof fetch;
  const api = authAdminApi('https://ref.supabase.co/', 'service-key', fakeFetch);

  assert.equal(await api.invite('a@b.kz', 'https://ts-cabinet.pages.dev/#/set-password', { name: 'A' }), 'invited');
  assert.equal(seen[0]!.url, 'https://ref.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fts-cabinet.pages.dev%2F%23%2Fset-password');
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.headers.apikey, 'service-key');
  assert.equal(seen[0]!.headers.authorization, 'Bearer service-key');
  assert.deepEqual(seen[0]!.body, { email: 'a@b.kz', data: { name: 'A' } });

  answer = () => Response.json({ code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }, { status: 422 });
  assert.equal(await api.invite('a@b.kz', 'x', {}), 'exists');
  answer = () => Response.json({ code: 422, msg: 'A user with this email address has already been registered' }, { status: 422 });
  assert.equal(await api.invite('a@b.kz', 'x', {}), 'exists');

  answer = () => Response.json({ code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, { status: 429 });
  await assert.rejects(api.recover('a@b.kz', 'x'), { code: 'RATE_LIMIT', status: 429 });
  assert.equal(seen.at(-1)!.url, 'https://ref.supabase.co/auth/v1/recover?redirect_to=x');
  answer = () => Response.json({ code: 500, error_code: 'unexpected_failure', msg: 'Error sending invite email' }, { status: 500 });
  await assert.rejects(api.invite('a@b.kz', 'x', {}), { code: 'EMAIL_FAILED' });

  answer = () => Response.json({ id: 'u-1', email: 'a@b.kz' });
  assert.equal(await api.createUser('a@b.kz', 'Pw12-abcd-EFGH', { f: true }), 'u-1');
  assert.deepEqual(seen.at(-1)!.body, { email: 'a@b.kz', password: 'Pw12-abcd-EFGH', email_confirm: true, user_metadata: { f: true } });
  await api.updateUser('u-1', 'Pw12-abcd-EFGH', { f: true });
  assert.equal(seen.at(-1)!.method, 'PUT');
  assert.equal(seen.at(-1)!.url, 'https://ref.supabase.co/auth/v1/admin/users/u-1');
  answer = () => Response.json({ error_code: 'weak_password', msg: 'Password should contain symbols' }, { status: 422 });
  await assert.rejects(api.updateUser('u-1', 'x', {}), { code: 'WEAK_PASSWORD' });
});

test('tempPassword, setPasswordUrl and TS_CABINET_URL', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = tempPassword();
    assert.match(p, /^[A-HJ-NP-Za-hjkm-np-z2-9]{4}(-[A-HJ-NP-Za-hjkm-np-z2-9]{4}){2}$/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /[0-9]/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
  // A generator without a digit is retried until all three classes are there.
  let n = 0;
  const p = tempPassword((len) => (n++ === 0 ? new Uint8Array(len) : Uint8Array.from({ length: len }, (_, i) => i * 5)));
  assert.equal(n, 2);
  assert.match(p, /[0-9]/);

  assert.equal(setPasswordUrl('https://ts-cabinet.pages.dev/'), 'https://ts-cabinet.pages.dev/#/set-password');
  const db = {} as Parameters<typeof edgeContext>[0];
  assert.equal(edgeContext(db, {}, { log: () => {} }).cabinetUrl, DEFAULT_CABINET_URL);
  assert.equal(edgeContext(db, { TS_CABINET_URL: ' https://c.example.kz/ ' }, { log: () => {} }).cabinetUrl, 'https://c.example.kz');
  assert.equal(edgeContext(db, {}, { log: () => {} }).authAdmin, null);
  assert.notEqual(edgeContext(db, { SUPABASE_URL: 'https://r.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { log: () => {} }).authAdmin, null);
});

test('platform: a broken signing key is named, not «Внутренняя ошибка облака»; a PEM key works', async (t) => {
  const e = await edgeTest(t);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const body = { companyName: 'Сеть К', managerName: 'drg', managerEmail: 'drg@k.kz', license: TRIAL_7 };
  const companies = async () => (await e.s.db.all<{ n: number }>('SELECT count(*)::int AS n FROM companies'))[0]!.n;
  const before = await companies();

  e.ctx.licenseSigner = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: 'not a key', LICENSE_KEY_ID: 'TS-2026' });
  const bad = await e.call(handlePlatform, 'POST', '/platform/clients', { headers: owner, body });
  assert.equal(bad.status, 500);
  assert.equal(bad.body.error.code, 'LICENSE_SIGN_FAILED');
  assert.match(bad.body.error.message, /LICENSE_SIGNING_KEY/);
  assert.equal(await companies(), before, 'nothing half-created');

  // The dev key pasted as PEM (base64 with padding, line breaks, armor) signs fine.
  const b64 = Buffer.from(DEV_LICENSE_KEY.privateKey, 'base64url').toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,40}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  assert.equal(normalizeSigningKey(pem), DEV_LICENSE_KEY.privateKey);
  assert.equal(normalizeSigningKey(pem.replace(/\n/g, '\n')), DEV_LICENSE_KEY.privateKey);
  e.ctx.licenseSigner = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: pem, LICENSE_KEY_ID: 'dev' });
  const ok = await e.call(handlePlatform, 'POST', '/platform/clients', { headers: owner, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await verifyLicense(ok.body.client.license.signed, { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey })).ok, true);
});

test('internalMessage: the cause is in the text, Postgres errors with their SQLSTATE', () => {
  assert.equal(internalMessage(new Error('boom')), 'Внутренняя ошибка облака: boom');
  assert.equal(
    internalMessage(Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' })),
    'Внутренняя ошибка облака: база данных (23505): duplicate key value violates unique constraint "x"',
  );
  assert.equal(internalMessage(null), 'Внутренняя ошибка облака');
  assert.equal(internalMessage('x'), 'Внутренняя ошибка облака');
});
