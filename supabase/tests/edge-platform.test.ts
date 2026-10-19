import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { LicenseTermsRequest } from '@bills/domain';
import { DEV_LICENSE_KEY, shortKeyHashInput, verifyLicense } from '@bills/domain';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import { DEMO_HUBS, DEMO_MANAGER_KEY, DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { clubIdOf, edgeTest, linkOwner, MONDAY_NOON, userJwt } from './edge-helpers.ts';

const DAY = 86_400_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DEV_KEYS = { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey };
const TRIAL_7: LicenseTermsRequest = { term: { kind: 'trial', days: 7 }, maxClubs: 1, modules: { bar: true, cloud: true, hardware: true } };

async function platformToken(e: EdgeTest, key: string): Promise<Record<string, string>> {
  const r = await e.call(handlePlatform, 'POST', '/platform/login', { body: { key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(typeof r.body.token, 'string');
  return { authorization: `Bearer ${r.body.token}` };
}

test('platform (Edge): long-key sign-in, a client with a 7-day license, extension, block; tech cannot hire', async (t) => {
  const e = await edgeTest(t);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const me = await e.call(handlePlatform, 'GET', '/platform/platform/me', { headers: owner });
  assert.deepEqual([me.body.name, me.body.role], ['Владелец TS', 'owner']);
  // The token is stored only as a hash.
  const stored = await e.s.db.all<{ token_hash: string }>('SELECT token_hash FROM platform_sessions');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.token_hash, sha(owner.authorization!.slice('Bearer '.length)));

  for (const key of [DEMO_MANAGER_KEY, '260417']) {
    assert.equal((await e.call(handlePlatform, 'POST', '/platform/login', { body: { key } })).status, 401, key);
  }
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/clients')).status, 401);
  // A manager's Supabase JWT is not a platform session.
  const uid = await linkOwner(e.s);
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/clients', { headers: { authorization: `Bearer ${userJwt(uid)}` } })).status, 401);

  const created = await e.call(handlePlatform, 'POST', '/platform/clients', {
    headers: owner,
    body: { companyName: 'Сеть Е', managerName: 'Ерлан', managerEmail: 'Erlan@E.kz', license: TRIAL_7 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.managerPassword, undefined);
  assert.match(created.body.managerKey.key, /^MGR-/);
  const lic = created.body.client.license;
  assert.equal(lic.payload.validUntil, MONDAY_NOON + 7 * DAY);
  assert.equal((await verifyLicense(lic.signed, DEV_KEYS)).ok, true);
  const companyId = created.body.client.companyId as string;

  e.clock.now += DAY;
  const ext = await e.call(handlePlatform, 'POST', `/platform/clients/${companyId}/license`, {
    headers: owner,
    body: { ...TRIAL_7, term: { kind: 'months', months: 1 } },
  });
  assert.equal(ext.status, 200);
  assert.ok(ext.body.license.payload.validUntil > lic.payload.validUntil);
  assert.notEqual(ext.body.license.signed, lic.signed);

  const blocked = await e.call(handlePlatform, 'POST', `/platform/clients/${companyId}/block`, { headers: owner, body: { blocked: true } });
  assert.equal(blocked.body.license.payload.blocked, true);
  assert.equal(blocked.body.license.status.state, 'blocked');

  const key = await e.call(handlePlatform, 'POST', `/platform/clients/${companyId}/manager-key`, { headers: owner });
  assert.equal(key.status, 200);
  assert.match(key.body.key, /^MGR-/);

  const tech = await platformToken(e, DEMO_PLATFORM[1].key);
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/clients', { headers: tech })).body.clients.length, 2);
  const hire = await e.call(handlePlatform, 'POST', '/platform/staff', { headers: tech, body: { name: 'X', role: 'tech' } });
  assert.equal(hire.status, 403);
  assert.equal((await e.call(handlePlatform, 'POST', '/platform/staff', { headers: owner, body: { name: 'X', role: 'tech' } })).status, 200);

  await e.call(handlePlatform, 'POST', '/platform/logout', { headers: owner });
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/me', { headers: owner })).status, 401);
});

test('owner (Edge) /owner/company: the new manager signs up, opens one branch (the second is 409), hires staff with keys', async (t) => {
  const e = await edgeTest(t);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const created = await e.call(handlePlatform, 'POST', '/platform/clients', {
    headers: owner,
    body: { companyName: 'Сеть Е', managerName: 'Ерлан', managerEmail: 'erlan@e.kz', license: { ...TRIAL_7, maxStaff: 5 } },
  });
  // The manager signs up through Supabase Auth with the same e-mail: linked by the trigger.
  const uid = await e.s.createAuthUser('erlan@e.kz');
  const h = { authorization: `Bearer ${userJwt(uid)}` };

  const license = await e.call(handleOwner, 'GET', '/owner/owner/company/license', { headers: h });
  assert.equal(license.status, 200, JSON.stringify(license.body));
  assert.equal(license.body.license.payload.companyId, created.body.client.companyId);

  const branch = await e.call(handleOwner, 'POST', '/owner/company/branches', { headers: h, body: { name: 'Центр' } });
  assert.equal(branch.status, 200, JSON.stringify(branch.body));
  const second = await e.call(handleOwner, 'POST', '/owner/company/branches', { headers: h, body: { name: 'Север' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'LICENSE_CLUB_LIMIT');
  const clubId = branch.body.branch.id as string;

  const staff = await e.call(handleOwner, 'POST', '/owner/company/staff', { headers: h, body: { clubId, name: 'Анна', roles: ['waiter', 'cashier'] } });
  assert.deepEqual(staff.body.roles, ['cashier', 'waiter']);
  const key = await e.call(handleOwner, 'POST', `/owner/company/staff/${staff.body.id}/keys`, { headers: h, body: { key: '583920' } });
  assert.equal(key.status, 200, JSON.stringify(key.body));
  assert.equal((await e.call(handleOwner, 'POST', `/owner/company/staff/${staff.body.id}/keys`, { headers: h, body: { key: '583920' } })).body.error.code, 'KEY_TAKEN');
  assert.equal((await e.call(handleOwner, 'POST', `/owner/company/staff/${staff.body.id}/keys`, { headers: h, body: { key: '111111' } })).body.error.code, 'KEY_WEAK');
  const random = await e.call(handleOwner, 'POST', `/owner/company/staff/${staff.body.id}/keys`, { headers: h });
  assert.match(random.body.key, /^\d{6}$/);
  const upd = await e.call(handleOwner, 'POST', `/owner/company/staff/${staff.body.id}/update`, { headers: h, body: { isActive: false } });
  assert.equal(upd.body.isActive, false);
  const list = await e.call(handleOwner, 'GET', `/owner/company/staff?clubId=${clubId}`, { headers: h });
  assert.equal(list.body.staff.length, 1);
  const revoked = await e.call(handleOwner, 'POST', `/owner/company/keys/${key.body.view.id}/revoke`, { headers: h });
  assert.equal(typeof revoked.body.revokedAt, 'number');

  // The new HUB gets the license, the manager key and the staff of its branch.
  const access = await e.call(handleSync, 'GET', '/sync/access', { headers: { authorization: `Bearer ${branch.body.hubApiKey}` } });
  assert.equal(access.status, 200);
  assert.equal(access.body.clubId, clubId);
  assert.deepEqual(JSON.parse(Buffer.from(access.body.license.split('.')[2], 'base64url').toString()).hubIds, [branch.body.hubId]);
  assert.ok(access.body.keys.some((k: { keyHash: string }) => k.keyHash === sha(created.body.managerKey.key)));
  assert.ok(access.body.keys.some((k: { keyHash: string }) => k.keyHash === sha(shortKeyHashInput(clubId, random.body.key))));

  // No route for a stranger; unknown paths are 404.
  const stranger = await e.s.createAuthUser('nobody@e.kz');
  assert.equal((await e.call(handleOwner, 'GET', '/owner/company/branches', { headers: { authorization: `Bearer ${userJwt(stranger)}` } })).status, 403);
  assert.equal((await e.call(handleOwner, 'GET', '/owner/company/nope', { headers: h })).status, 404);
});

test('sync (Edge) /sync/access: branch A never receives branch B\'s staff keys', async (t) => {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const h = { authorization: `Bearer ${userJwt(uid)}` };
  const clubA = await clubIdOf(e.s, DEMO_HUBS[0].id);
  const clubB = await clubIdOf(e.s, DEMO_HUBS[1].id);
  const staffB = await e.call(handleOwner, 'POST', '/owner/company/staff', { headers: h, body: { clubId: clubB, name: 'Б', roles: ['waiter'] } });
  assert.equal(staffB.status, 200, JSON.stringify(staffB.body));
  await e.call(handleOwner, 'POST', `/owner/company/staff/${staffB.body.id}/keys`, { headers: h, body: { key: '739281' } });

  const a = await e.call(handleSync, 'GET', '/sync/access', { headers: { authorization: `Bearer ${DEMO_HUBS[0].key}` } });
  const b = await e.call(handleSync, 'GET', `/functions/v1/sync/access?hubId=${DEMO_HUBS[1].id}`, { headers: { authorization: `Bearer ${DEMO_HUBS[1].key}` } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const hashesA = a.body.keys.map((k: { keyHash: string }) => k.keyHash);
  const hashesB = b.body.keys.map((k: { keyHash: string }) => k.keyHash);
  assert.ok(!hashesA.includes(sha(shortKeyHashInput(clubB, '739281'))));
  assert.ok(hashesB.includes(sha(shortKeyHashInput(clubB, '739281'))));
  assert.ok(hashesA.includes(sha(shortKeyHashInput(clubA, '260417'))));
  assert.ok(!hashesB.includes(sha(shortKeyHashInput(clubA, '260417'))));
  for (const hashes of [hashesA, hashesB]) {
    for (const long of [DEMO_PLATFORM[0].key, DEMO_PLATFORM[1].key, DEMO_MANAGER_KEY]) assert.ok(hashes.includes(sha(long)));
  }
  assert.ok(!a.body.people.some((p: { id: string }) => p.id === staffB.body.id));
  assert.equal((await e.call(handleSync, 'GET', `/sync/access?hubId=${DEMO_HUBS[1].id}`, { headers: { authorization: `Bearer ${DEMO_HUBS[0].key}` } })).status, 403);
  assert.equal((await e.call(handleSync, 'GET', '/sync/access')).status, 401);
});
