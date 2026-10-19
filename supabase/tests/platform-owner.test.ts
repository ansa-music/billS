/**
 * 20261022000000_platform_owner.sql: the first platform owner by e-mail (Supabase Auth user),
 * the Supabase JWT sign-in of the `platform` function, and the demo client seeded in SQL whose
 * license the Edge Functions sign on their next request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEV_LICENSE_KEY, shortKeyHashInput, verifyLicense } from '@bills/domain';
import type { AuthUserLookup } from '../../apps/cloud/src/edge/context.ts';
import { authApiLookup } from '../../apps/cloud/src/edge/context.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, userJwt } from './edge-helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DEV_KEYS = { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey };

/** Stands in for the Auth API: a token is valid when its `sub` is a user in auth.users and it is not "forged". */
function fakeAuthApi(e: EdgeTest): AuthUserLookup {
  return async (token) => {
    if (token.endsWith('.forged')) return null;
    const sub = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub as string;
    const rows = await e.s.db.all<{ id: string; email: string }>('SELECT id::text AS id, email FROM auth.users WHERE id::text = ?', [sub]);
    return rows[0] ?? null;
  };
}

const privileges = (e: EdgeTest, fn: string) =>
  e.s.db.all<{ anon: boolean; auth: boolean; service: boolean }>(
    `SELECT has_function_privilege('anon', 'public.${fn}', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') AS auth,
            has_function_privilege('service_role', 'public.${fn}', 'EXECUTE') AS service`,
  );

test('ts_make_platform_owner: idempotent, service_role only; the owner signs into `platform` with the Supabase JWT', async (t) => {
  const e = await edgeTest(t);
  e.ctx.authUser = fakeAuthApi(e);
  for (const fn of ['ts_make_platform_owner(text)', 'ts_make_platform_tech(text)', 'ts_seed_demo_cloud(text)']) {
    assert.deepEqual((await privileges(e, fn))[0], { anon: false, auth: false, service: true }, fn);
  }

  const uid = await e.s.createAuthUser('Boss@TS.kz');
  const [first] = await e.s.db.all<{ id: string }>("SELECT public.ts_make_platform_owner('  boss@ts.kz ') AS id");
  const [again] = await e.s.db.all<{ id: string }>("SELECT public.ts_make_platform_owner('BOSS@ts.kz') AS id");
  assert.equal(again!.id, first!.id);
  const rows = await e.s.db.all<{ role: string; email: string; name: string; auth_user_id: string }>(
    'SELECT role, email, name, auth_user_id::text AS auth_user_id FROM platform_staff WHERE id = ?',
    [first!.id],
  );
  assert.deepEqual(rows, [{ role: 'owner', email: 'boss@ts.kz', name: 'boss', auth_user_id: uid }]);
  await assert.rejects(e.s.db.all("SELECT public.ts_make_platform_owner('not-an-email')"), /e-mail/);

  const h = { authorization: `Bearer ${userJwt(uid)}` };
  const me = await e.call(handlePlatform, 'GET', '/platform/me', { headers: h });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual(me.body, { id: first!.id, name: 'boss', role: 'owner' });
  const clients = await e.call(handlePlatform, 'GET', '/platform/clients', { headers: h });
  assert.equal(clients.status, 200);
  assert.equal(clients.body.clients.length, 1);

  // An Auth user who is not on the platform: 403; a token the Auth API rejects: 401.
  const stranger = await e.s.createAuthUser('someone@ts.kz');
  const denied = await e.call(handlePlatform, 'GET', '/platform/me', { headers: { authorization: `Bearer ${userJwt(stranger)}` } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'NOT_PLATFORM');
  const forged = `${userJwt(uid).split('.').slice(0, 2).join('.')}.forged`;
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/me', { headers: { authorization: `Bearer ${forged}` } })).status, 401);

  // Without a way to check the signature, a JWT is never trusted.
  e.ctx.authUser = null;
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/me', { headers: h })).status, 401);

  // ts_make_platform_tech demotes; a deactivated row stops working, the owner function brings it back.
  e.ctx.authUser = fakeAuthApi(e);
  await e.s.db.all("SELECT public.ts_make_platform_tech('boss@ts.kz')");
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/me', { headers: h })).body.role, 'tech');
  await e.s.db.run('UPDATE platform_staff SET is_active = 0 WHERE id = ?', [first!.id]);
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/me', { headers: h })).status, 403);
  await e.s.db.all("SELECT public.ts_make_platform_owner('boss@ts.kz')");
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/me', { headers: h })).body.role, 'owner');
});

test('a platform row made before the user signs up links on first sign-in', async (t) => {
  const e = await edgeTest(t);
  e.ctx.authUser = fakeAuthApi(e);
  await e.s.db.all("SELECT public.ts_make_platform_owner('later@ts.kz')");
  const uid = await e.s.createAuthUser('later@ts.kz');
  const me = await e.call(handlePlatform, 'GET', '/platform/me', { headers: { authorization: `Bearer ${userJwt(uid)}` } });
  assert.equal(me.status, 200);
  const [row] = await e.s.db.all<{ u: string }>("SELECT auth_user_id::text AS u FROM platform_staff WHERE email = 'later@ts.kz'");
  assert.equal(row!.u, uid);
});

test('ts_seed_demo_cloud: idempotent demo client; the license is signed by the next Edge request', async (t) => {
  const e = await edgeTest(t);
  e.clock.now = Date.now(); // the SQL takes the real clock
  const [r] = await e.s.db.all<{ r: any }>("SELECT public.ts_seed_demo_cloud('') AS r");
  const seeded = r!.r;
  assert.equal(seeded.created, true);
  assert.equal(seeded.managerEmail, 'demo-manager@ts.demo');
  assert.match(seeded.managerKey, /^MGR-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(seeded.hubs.length, 2);
  const [again] = await e.s.db.all<{ r: any }>("SELECT public.ts_seed_demo_cloud('DEMO-manager@ts.demo') AS r");
  assert.deepEqual(again!.r, { created: false, companyId: seeded.companyId, managerEmail: 'demo-manager@ts.demo' });

  const pending = await e.s.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM licenses WHERE signed = ''");
  assert.equal(pending[0]!.n, 1);

  // Any request of an Edge Function signs it (here: the HUB of the first demo branch).
  const hub = seeded.hubs[0];
  const access = await e.call(handleSync, 'GET', '/sync/access', { headers: { authorization: `Bearer ${hub.apiKey}` } });
  assert.equal(access.status, 200, JSON.stringify(access.body));
  assert.equal(access.body.clubId, hub.clubId);
  const check = await verifyLicense(access.body.license, DEV_KEYS);
  assert.equal(check.ok, true);
  const lic = check.ok ? check.license : null;
  assert.equal(lic!.plan, 'trial');
  assert.equal(lic!.maxClubs, 2);
  assert.equal(lic!.validUntil - lic!.validFrom, 7 * 86_400_000);
  assert.deepEqual(lic!.modules, { bar: true, cloud: true, hardware: true });
  assert.deepEqual(lic!.hubIds, seeded.hubs.map((h: { hubId: string }) => h.hubId));
  assert.equal(lic!.companyName, 'Демо-сеть');
  assert.ok(access.body.keys.some((k: { keyHash: string }) => k.keyHash === sha(seeded.managerKey)));
  assert.ok(access.body.keys.some((k: { keyHash: string }) => k.keyHash === sha(shortKeyHashInput(hub.clubId, '260417'))));
  assert.equal(access.body.people.filter((p: { scope: string }) => p.scope === 'club').length, 4);

  // The other branch sees only its own staff key.
  const other = seeded.hubs[1];
  const b = await e.call(handleSync, 'GET', '/sync/access', { headers: { authorization: `Bearer ${other.apiKey}` } });
  assert.deepEqual(
    b.body.keys.filter((k: { kind: string }) => k.kind === 'short').map((k: { keyHash: string }) => k.keyHash),
    [sha(shortKeyHashInput(other.clubId, '640285'))],
  );

  // The demo manager signs up with that e-mail and sees two branches and the license.
  const uid = await e.s.createAuthUser('demo-manager@ts.demo');
  const h = { authorization: `Bearer ${userJwt(uid)}` };
  const branches = await e.call(handleOwner, 'GET', '/owner/company/branches', { headers: h });
  assert.deepEqual(branches.body.branches.map((x: { name: string }) => x.name), ['Демо: Центр', 'Демо: Север']);
  const license = await e.call(handleOwner, 'GET', '/owner/company/license', { headers: h });
  assert.equal(license.body.license.status.state, 'active');
  assert.equal(license.body.license.signed, access.body.license);
  // Third branch: over the license.
  assert.equal((await e.call(handleOwner, 'POST', '/owner/company/branches', { headers: h, body: { name: 'Ещё' } })).body.error.code, 'LICENSE_CLUB_LIMIT');
});

test('authApiLookup asks GET /auth/v1/user with the token and the anon key', async () => {
  const seen: Array<{ url: string; auth: string | null; apikey: string | null }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get('authorization'), apikey: headers.get('apikey') });
    return headers.get('authorization') === 'Bearer good'
      ? new Response(JSON.stringify({ id: 'u-1', email: 'a@b.kz' }), { status: 200 })
      : new Response('{"msg":"invalid JWT"}', { status: 401 });
  }) as typeof fetch;
  const lookup = authApiLookup('https://ref.supabase.co/', 'anon-key', fakeFetch);
  assert.deepEqual(await lookup('good'), { id: 'u-1', email: 'a@b.kz' });
  assert.equal(await lookup('bad'), null);
  assert.deepEqual(seen[0], { url: 'https://ref.supabase.co/auth/v1/user', auth: 'Bearer good', apikey: 'anon-key' });
});
