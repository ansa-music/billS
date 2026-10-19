import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type {
  ClientView,
  CloudStaffView,
  CreateBranchResponse,
  CreateClientResponse,
  IssueCloudKeyResponse,
  LicenseTermsRequest,
  SyncAccessResponse,
} from '@bills/domain';
import { DEV_LICENSE_KEY, shortKeyHashInput, verifyLicense } from '@bills/domain';
import { DEMO_MANAGER_KEY, DEMO_PLATFORM } from '../src/seed.ts';
import type { TestCloud } from './helpers.ts';
import { clubIdOf, cloud, HUB1, HUB2, hubGet, login, MONDAY_NOON, sendEvents } from './helpers.ts';

const DAY = 86_400_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DEV_KEYS = { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey };
const OWNER_KEY = DEMO_PLATFORM[0].key;
const TECH_KEY = DEMO_PLATFORM[1].key;

const TRIAL_7: LicenseTermsRequest = {
  term: { kind: 'trial', days: 7 },
  maxClubs: 1,
  maxStaff: 2,
  modules: { bar: true, cloud: true, hardware: false },
};

interface Res<T = any> {
  status: number;
  body: T;
  cookie: string | null;
}

async function call<T = any>(c: TestCloud, method: 'GET' | 'POST', url: string, cookie?: string | null, payload?: unknown): Promise<Res<T>> {
  const res = await c.app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  const set = res.headers['set-cookie'];
  const raw = Array.isArray(set) ? set[0] : set;
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (null as T), cookie: raw ? raw.split(';')[0]! : null };
}

async function platformLogin(c: TestCloud, key: string): Promise<string> {
  const r = await call(c, 'POST', '/api/platform/login', null, { key });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.cookie ?? '', /^ts_platform=/);
  return r.cookie!;
}

async function newClient(c: TestCloud, platform: string, terms = TRIAL_7, email = 'boss@club.kz'): Promise<CreateClientResponse & { manager: string }> {
  const r = await call<CreateClientResponse>(c, 'POST', '/api/platform/clients', platform, {
    companyName: 'Клуб «Новый»',
    managerName: 'Айдар',
    managerEmail: email,
    license: terms,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const manager = await login(c, email, r.body.managerPassword!);
  return { ...r.body, manager };
}

test('platform sign-in: OWNER and TECH keys only; manager and staff keys are refused', async (t) => {
  const c = await cloud(t);
  const owner = await platformLogin(c, OWNER_KEY.toLowerCase());
  const me = await call(c, 'GET', '/api/platform/me', owner);
  assert.deepEqual({ name: me.body.name, role: me.body.role }, { name: 'Владелец TS', role: 'owner' });
  assert.equal((await call(c, 'GET', '/api/platform/me', `ts_platform=${'0'.repeat(64)}`)).status, 401);

  const tech = await platformLogin(c, TECH_KEY);
  assert.equal((await call(c, 'GET', '/api/platform/me', tech)).body.role, 'tech');

  for (const key of [DEMO_MANAGER_KEY, '260417', 'OWNER-AAAA-BBBB-CCCC-DDDD']) {
    const r = await call(c, 'POST', '/api/platform/login', null, { key });
    assert.equal(r.status, 401, key);
    assert.equal(r.body.error.code, 'INVALID_KEY');
  }

  // The manager's cabinet session does not open the platform, the platform session not the company.
  const manager = await login(c);
  assert.equal((await call(c, 'GET', '/api/platform/clients', manager)).status, 401);
  assert.equal((await call(c, 'GET', '/api/company/branches', owner)).status, 401);
  // Staff have no cloud sign-in at all.
  assert.equal((await call(c, 'POST', '/api/auth/key', null, { key: '260417' })).status, 401);
  // The MGR key signs the manager in (cabinet / phone).
  const byKey = await call(c, 'POST', '/api/auth/key', null, { key: DEMO_MANAGER_KEY });
  assert.equal(byKey.status, 200);
  assert.equal(byKey.body.email, 'owner@demo.kz');

  const out = await call(c, 'POST', '/api/platform/logout', owner);
  assert.equal(out.status, 200);
  assert.equal((await call(c, 'GET', '/api/platform/me', owner)).status, 401);
});

test('a new client: 7-day trial, one branch, signed with the dev key; tampering breaks the signature', async (t) => {
  const c = await cloud(t);
  const platform = await platformLogin(c, OWNER_KEY);
  const r = await newClient(c, platform);
  assert.match(r.managerKey.key, /^MGR-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(r.managerKey.prefix, r.managerKey.key.split('-').slice(0, 2).join('-'));
  assert.equal(r.managerPassword!.length, 16);
  const lic = r.client.license!;
  assert.equal(lic.payload.plan, 'trial');
  assert.equal(lic.payload.validFrom, MONDAY_NOON);
  assert.equal(lic.payload.validUntil, MONDAY_NOON + 7 * DAY);
  assert.equal(lic.payload.maxClubs, 1);
  assert.deepEqual(lic.payload.hubIds, []);
  assert.equal(lic.payload.blocked, false);
  assert.equal(lic.status.state, 'active');
  assert.deepEqual(r.client.managers.map((m) => m.email), ['boss@club.kz']);

  const ok = await verifyLicense(lic.signed, DEV_KEYS);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.license, lic.payload);
  // Change one field of the payload and keep the signature: refused.
  const [p, kid, body, sig] = lic.signed.split('.');
  const forged = Buffer.from(JSON.stringify({ ...lic.payload, maxClubs: 50 })).toString('base64url');
  const bad = await verifyLicense([p, kid, forged, sig].join('.'), DEV_KEYS);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, 'signature');
  assert.ok(body);

  // The same e-mail again: 409. Bad terms: 422.
  const again = await call(c, 'POST', '/api/platform/clients', platform, {
    companyName: 'X',
    managerName: 'Y',
    managerEmail: 'BOSS@club.kz',
    license: TRIAL_7,
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'EMAIL_TAKEN');
  const badTerms = await call(c, 'POST', '/api/platform/clients', platform, {
    companyName: 'X',
    managerName: 'Y',
    managerEmail: 'x@y.kz',
    license: { ...TRIAL_7, term: { kind: 'trial', days: 5 } },
  });
  assert.equal(badTerms.status, 422);

  // The manager sees the license; the client list has it.
  const mine = await call(c, 'GET', '/api/company/license', r.manager);
  assert.equal(mine.body.license.signed, lic.signed);
  const list = await call<{ clients: ClientView[] }>(c, 'GET', '/api/platform/clients', platform);
  assert.deepEqual(list.body.clients.map((x) => x.companyName).sort(), ['Демо сеть', 'Клуб «Новый»']);
  assert.ok(list.body.clients.find((x) => x.companyName === 'Демо сеть')!.license!.payload.hubIds.includes(HUB1.id));
});

test('branches: the first within maxClubs, the second is 409 LICENSE_CLUB_LIMIT; the license names the new HUB', async (t) => {
  const c = await cloud(t);
  const platform = await platformLogin(c, OWNER_KEY);
  const r = await newClient(c, platform);

  const first = await call<CreateBranchResponse>(c, 'POST', '/api/company/branches', r.manager, { name: 'Центр', timezone: 'Asia/Almaty' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.hubId, /^hub-tsentr/);
  assert.ok(first.body.hubApiKey.length >= 40);
  assert.deepEqual(first.body.branch.hubs.map((h) => h.id), [first.body.hubId]);

  const second = await call(c, 'POST', '/api/company/branches', r.manager, { name: 'Север' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'LICENSE_CLUB_LIMIT');

  const lic = (await call(c, 'GET', '/api/company/license', r.manager)).body.license;
  assert.deepEqual(lic.payload.hubIds, [first.body.hubId]);
  assert.notEqual(lic.payload.id, r.client.license!.payload.id);

  // The new HUB pulls its package with the license and the manager's key.
  const access = await hubGet<SyncAccessResponse>(c, first.body.hubApiKey, '/sync/access');
  assert.equal(access.status, 200);
  assert.equal(access.body.license, lic.signed);
  assert.equal(access.body.clubId, first.body.branch.id);
  assert.ok(access.body.keys.some((k) => k.keyHash === sha(r.managerKey.key)));

  const branches = await call(c, 'GET', '/api/company/branches', r.manager);
  assert.deepEqual(branches.body.branches.map((b: { name: string }) => b.name), ['Центр']);
});

test('extension by the platform owner: from the current end, new signature; fromCurrentEnd=false starts now', async (t) => {
  const c = await cloud(t);
  const platform = await platformLogin(c, OWNER_KEY);
  const r = await newClient(c, platform);
  const before = r.client.license!;
  c.clock.advance(2 * DAY);

  const ext = await call<ClientView>(c, 'POST', `/api/platform/clients/${r.client.companyId}/license`, platform, {
    term: { kind: 'months', months: 1 },
    maxClubs: 2,
    modules: { bar: true, cloud: true, hardware: true },
  });
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  const after = ext.body.license!;
  assert.equal(after.payload.validUntil, Date.UTC(2026, 10, 19, 7, 0)); // 19.10 + 1 month
  assert.ok(after.payload.validUntil > before.payload.validUntil);
  assert.equal(after.payload.validFrom, before.payload.validFrom);
  assert.equal(after.payload.plan, 'paid');
  assert.equal(after.payload.maxClubs, 2);
  assert.notEqual(after.signed, before.signed);
  assert.equal((await verifyLicense(after.signed, DEV_KEYS)).ok, true);

  const now = await call<ClientView>(c, 'POST', `/api/platform/clients/${r.client.companyId}/license`, platform, {
    term: { kind: 'trial', days: 3 },
    fromCurrentEnd: false,
    maxClubs: 2,
    modules: { bar: true, cloud: true, hardware: true },
  });
  assert.equal(now.body.license!.payload.validUntil, c.clock.now() + 3 * DAY);
  assert.equal(now.body.license!.status.state, 'expiring');

  // Tech may change clients too; the manager may not.
  const tech = await platformLogin(c, TECH_KEY);
  assert.equal((await call(c, 'POST', `/api/platform/clients/${r.client.companyId}/manager-key`, tech)).status, 200);
  assert.equal((await call(c, 'POST', `/api/platform/clients/${r.client.companyId}/license`, r.manager, { term: { kind: 'trial', days: 7 } })).status, 401);
  assert.equal((await call(c, 'POST', '/api/platform/clients/nope/license', platform, TRIAL_7)).status, 404);
});

test('block: the license is re-signed blocked, the manager is read-only; unblock gives it back; expiry is read-only too', async (t) => {
  const c = await cloud(t);
  const platform = await platformLogin(c, OWNER_KEY);
  const r = await newClient(c, platform, { ...TRIAL_7, maxClubs: 3 });

  const blocked = await call<ClientView>(c, 'POST', `/api/platform/clients/${r.client.companyId}/block`, platform, { blocked: true, reason: 'Не оплачено' });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.blocked, true);
  assert.equal(blocked.body.blockedReason, 'Не оплачено');
  assert.equal(blocked.body.license!.payload.blocked, true);
  assert.equal(blocked.body.license!.status.state, 'blocked');
  const check = await verifyLicense(blocked.body.license!.signed, DEV_KEYS);
  assert.equal(check.ok && check.license.blocked, true);

  const refused = await call(c, 'POST', '/api/company/branches', r.manager, { name: 'Центр' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'LICENSE_READ_ONLY');

  const unblocked = await call<ClientView>(c, 'POST', `/api/platform/clients/${r.client.companyId}/block`, platform, { blocked: false });
  assert.equal(unblocked.body.license!.payload.blocked, false);
  assert.equal(unblocked.body.blockedReason, null);
  assert.equal((await call(c, 'POST', '/api/company/branches', r.manager, { name: 'Центр' })).status, 200);

  c.clock.advance(8 * DAY);
  const expired = await call(c, 'POST', '/api/company/branches', r.manager, { name: 'Север' });
  assert.equal(expired.status, 403);
  assert.equal(expired.body.error.code, 'LICENSE_READ_ONLY');
});

test('staff: a set of staff roles, the maxStaff limit, own and random six-digit keys unique within the branch', async (t) => {
  const c = await cloud(t);
  const platform = await platformLogin(c, OWNER_KEY);
  const r = await newClient(c, platform, { ...TRIAL_7, maxClubs: 2 });
  const a = (await call<CreateBranchResponse>(c, 'POST', '/api/company/branches', r.manager, { name: 'Альфа' })).body;
  const b = (await call<CreateBranchResponse>(c, 'POST', '/api/company/branches', r.manager, { name: 'Бета' })).body;

  const ann = await call<CloudStaffView>(c, 'POST', '/api/company/staff', r.manager, { clubId: a.branch.id, name: 'Анна', roles: ['waiter', 'cashier'] });
  assert.equal(ann.status, 200, JSON.stringify(ann.body));
  assert.deepEqual(ann.body.roles, ['cashier', 'waiter']);
  assert.equal(ann.body.isActive, true);

  for (const roles of [['manager'], ['owner'], [], ['waiter', 'tech'], ['chef']]) {
    const bad = await call(c, 'POST', '/api/company/staff', r.manager, { clubId: a.branch.id, name: 'X', roles });
    assert.equal(bad.status, 422, JSON.stringify(roles));
    assert.equal(bad.body.error.code, 'ROLES_INVALID');
  }

  await call(c, 'POST', '/api/company/staff', r.manager, { clubId: a.branch.id, name: 'Борис', roles: ['senior'] });
  const third = await call(c, 'POST', '/api/company/staff', r.manager, { clubId: a.branch.id, name: 'Вера', roles: ['bartender'] });
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'LICENSE_STAFF_LIMIT');

  // Keys.
  const weak = await call(c, 'POST', `/api/company/staff/${ann.body.id}/keys`, r.manager, { key: '123456' });
  assert.equal(weak.status, 422);
  assert.equal(weak.body.error.code, 'KEY_WEAK');
  assert.equal((await call(c, 'POST', `/api/company/staff/${ann.body.id}/keys`, r.manager, { key: '12a' })).body.error.code, 'KEY_WEAK');
  const own = await call<IssueCloudKeyResponse>(c, 'POST', `/api/company/staff/${ann.body.id}/keys`, r.manager, {
    key: '483 920',
    label: 'Планшет',
    expiresInDays: 30,
  });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.key, '483920');
  assert.equal(own.body.view.prefix, '••••20');
  assert.equal(own.body.view.kind, 'short');
  assert.equal(own.body.view.expiresAt, c.clock.now() + 30 * DAY);
  const taken = await call(c, 'POST', `/api/company/staff/${ann.body.id}/keys`, r.manager, { key: '483920' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'KEY_TAKEN');
  const random = await call<IssueCloudKeyResponse>(c, 'POST', `/api/company/staff/${ann.body.id}/keys`, r.manager);
  assert.equal(random.status, 200);
  assert.match(random.body.key, /^\d{6}$/);
  assert.notEqual(random.body.key, '483920');

  // The same digits in another branch are a different key.
  const bob = await call<CloudStaffView>(c, 'POST', '/api/company/staff', r.manager, { clubId: b.branch.id, name: 'Боб', roles: ['waiter'] });
  assert.equal((await call(c, 'POST', `/api/company/staff/${bob.body.id}/keys`, r.manager, { key: '483920' })).status, 200);

  // Update, list, revoke.
  const upd = await call<CloudStaffView>(c, 'POST', `/api/company/staff/${ann.body.id}/update`, r.manager, { roles: ['admin'], name: 'Анна К.' });
  assert.deepEqual([upd.body.name, upd.body.roles], ['Анна К.', ['admin']]);
  assert.equal(upd.body.keys.length, 2);
  const list = await call<{ staff: CloudStaffView[] }>(c, 'GET', `/api/company/staff?clubId=${a.branch.id}`, r.manager);
  // Listed by creation time; both were created in the same millisecond here, so compare as a set.
  assert.deepEqual(list.body.staff.map((s) => s.name).sort(), ['Анна К.', 'Борис']);
  const revoked = await call(c, 'POST', `/api/company/keys/${own.body.view.id}/revoke`, r.manager);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revokedAt, c.clock.now());

  // Another company cannot see or touch them.
  const demoManager = await login(c);
  assert.equal((await call(c, 'GET', `/api/company/staff?clubId=${a.branch.id}`, demoManager)).status, 404);
  assert.equal((await call(c, 'POST', `/api/company/staff/${ann.body.id}/update`, demoManager, { name: 'X' })).status, 404);
  assert.equal((await call(c, 'POST', `/api/company/keys/${random.body.view.id}/revoke`, demoManager)).status, 404);
});

test('/sync/access: only this branch\'s staff keys, plus the managers and the platform; accessVersion follows changes', async (t) => {
  const c = await cloud(t);
  const manager = await login(c);
  const clubA = await clubIdOf(c, HUB1.id);
  const clubB = await clubIdOf(c, HUB2.id);
  const before = (await sendEvents(c, HUB2, [])).body.accessVersion!;

  const bStaff = await call<CloudStaffView>(c, 'POST', '/api/company/staff', manager, { clubId: clubB, name: 'Сотрудник Б', roles: ['waiter', 'cashier'] });
  const bKey = await call<IssueCloudKeyResponse>(c, 'POST', `/api/company/staff/${bStaff.body.id}/keys`, manager, { key: '739281' });
  assert.equal(bKey.status, 200);
  const afterB = (await sendEvents(c, HUB2, [])).body.accessVersion!;
  assert.ok(afterB > before);

  const a = await hubGet<SyncAccessResponse>(c, HUB1.key, '/sync/access');
  const b = await hubGet<SyncAccessResponse>(c, HUB2.key, `/sync/access?hubId=${HUB2.id}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.clubId, clubA);
  assert.equal(b.body.clubId, clubB);
  assert.equal(b.body.version, afterB);

  // A: the demo staff of club A, never B's person or key.
  const aClub = a.body.people.filter((p) => p.scope === 'club');
  assert.deepEqual(aClub.map((p) => p.name).sort(), ['Кассир', 'Официант', 'Официант-кассир', 'Старший смены'].sort());
  assert.ok(!a.body.people.some((p) => p.id === bStaff.body.id));
  assert.ok(!a.body.keys.some((k) => k.personId === bStaff.body.id));
  assert.ok(a.body.keys.some((k) => k.keyHash === sha(shortKeyHashInput(clubA, '260417'))));
  assert.ok(!a.body.keys.some((k) => k.keyHash === sha(shortKeyHashInput(clubB, '739281'))));

  // B: its own person with both roles and the key, none of A's.
  const bClub = b.body.people.filter((p) => p.scope === 'club');
  assert.deepEqual(bClub.map((p) => [p.name, p.roles]), [['Сотрудник Б', ['cashier', 'waiter']]]);
  const bClubKeys = b.body.keys.filter((k) => k.kind === 'short');
  assert.deepEqual(bClubKeys.map((k) => [k.personId, k.keyHash, k.prefix]), [[bStaff.body.id, sha(shortKeyHashInput(clubB, '739281')), '••••81']]);
  assert.ok(!b.body.keys.some((k) => k.keyHash === sha(shortKeyHashInput(clubA, '260417'))));

  // Both: the manager (company) with the MGR key, the platform with OWNER/TECH keys, the same license.
  for (const pkg of [a.body, b.body]) {
    assert.deepEqual(
      pkg.people.filter((p) => p.scope !== 'club').map((p) => [p.scope, p.roles]),
      [
        ['platform', ['owner']],
        ['platform', ['tech']],
        ['company', ['manager']],
      ],
    );
    const hashes = pkg.keys.filter((k) => k.kind === 'long').map((k) => k.keyHash);
    assert.deepEqual(hashes, [sha(OWNER_KEY), sha(TECH_KEY), sha(DEMO_MANAGER_KEY)]);
    assert.ok(pkg.license?.startsWith('TS1.dev.'));
    assert.equal(pkg.license, a.body.license);
  }

  // A change in B moves only B's version; a license change moves both.
  const aVersion = a.body.version;
  await call(c, 'POST', `/api/company/keys/${bKey.body.view.id}/revoke`, manager);
  assert.equal((await sendEvents(c, HUB1, [])).body.accessVersion, aVersion);
  assert.ok((await sendEvents(c, HUB2, [])).body.accessVersion! > afterB);
  const revokedPkg = await hubGet<SyncAccessResponse>(c, HUB2.key, '/sync/access');
  assert.equal(revokedPkg.body.keys.filter((k) => k.kind === 'short').length, 0);

  const platform = await platformLogin(c, OWNER_KEY);
  const companyId = (await call(c, 'GET', '/api/company/license', manager)).body.license.payload.companyId;
  await call(c, 'POST', `/api/platform/clients/${companyId}/block`, platform, { blocked: true });
  assert.ok((await sendEvents(c, HUB1, [])).body.accessVersion! > aVersion);

  // Auth: unknown key 401, other HUB's id 403.
  assert.equal((await hubGet(c, 'nope', '/sync/access')).status, 401);
  assert.equal((await hubGet(c, HUB1.key, `/sync/access?hubId=${HUB2.id}`)).status, 403);
});

test('the support team: the owner hires tech, tech cannot hire (platform.staff)', async (t) => {
  const c = await cloud(t);
  const owner = await platformLogin(c, OWNER_KEY);
  const tech = await platformLogin(c, TECH_KEY);

  const denied = await call(c, 'POST', '/api/platform/staff', tech, { name: 'Новый', role: 'tech' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');

  c.clock.advance(1000);
  const hired = await call(c, 'POST', '/api/platform/staff', owner, { name: 'Дана', role: 'tech' });
  assert.equal(hired.status, 200);
  assert.match(hired.body.key.key, /^TECH-/);
  await platformLogin(c, hired.body.key.key);
  const list = await call(c, 'GET', '/api/platform/staff', tech);
  assert.deepEqual(list.body.staff.map((s: { name: string }) => s.name), ['Владелец TS', 'Поддержка TS', 'Дана']);
  assert.equal((await call(c, 'POST', '/api/platform/staff', owner, { name: 'X', role: 'manager' })).status, 422);
});
