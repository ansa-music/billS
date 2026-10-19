import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as http from '../src/api-http.ts';
import { CloudRequestError } from '../src/api-core.ts';

interface Call {
  url: string;
  method: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function mockFetch(respond: (url: string) => { status?: number; body?: unknown }) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init.credentials,
    });
    const r = respond(url);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('platform cabinet: paths, methods, bodies, cookie credentials', async () => {
  mockFetch((url) => {
    if (url.endsWith('/clients')) return { body: { clients: [] } };
    return { body: { ok: true } };
  });
  await http.platformLogin('OWNER-2222-2222-2222-2222');
  await http.platformMe();
  await http.platformLogout();
  assert.deepEqual(await http.listClients(), []);
  await http.createClient({
    companyName: 'A',
    managerName: 'B',
    managerEmail: 'b@example.kz',
    license: { term: { kind: 'trial', days: 7 }, maxClubs: 1, modules: { bar: true, cloud: true, hardware: false } },
  });
  await http.setLicense('c/1', { term: { kind: 'months', months: 3 }, maxClubs: 2, modules: { bar: true, cloud: true, hardware: true }, fromCurrentEnd: true });
  await http.blockClient('c1', { blocked: true, reason: 'не оплачено' });
  await http.issueManagerKey('c1');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      'POST /api/platform/login',
      'GET /api/platform/me',
      'POST /api/platform/logout',
      'GET /api/platform/clients',
      'POST /api/platform/clients',
      'POST /api/platform/clients/c%2F1/license',
      'POST /api/platform/clients/c1/block',
      'POST /api/platform/clients/c1/manager-key',
    ],
  );
  assert.deepEqual(calls[0]!.body, { key: 'OWNER-2222-2222-2222-2222' });
  assert.deepEqual(calls[6]!.body, { blocked: true, reason: 'не оплачено' });
  assert.equal((calls[5]!.body as { fromCurrentEnd: boolean }).fromCurrentEnd, true);
  assert.ok(calls.every((c) => c.credentials === 'same-origin'));
});

test('manager cabinet: /api/company paths', async () => {
  mockFetch((url) => {
    if (url.endsWith('/license')) return { body: { license: null } };
    if (url.endsWith('/branches')) return { body: { branches: [] } };
    if (url.includes('/staff?') || url.endsWith('/staff')) return { body: { staff: [] } };
    return { body: {} };
  });
  assert.equal(await http.companyLicense(), null);
  assert.deepEqual(await http.listBranches(), []);
  await http.createBranch({ name: 'Абая', timezone: 'Asia/Almaty', currency: 'KZT' });
  assert.deepEqual(await http.listStaff('club 1'), []);
  assert.deepEqual(await http.listStaff(), []);
  await http.createStaff({ clubId: 'k1', name: 'Айгерим', roles: ['waiter', 'cashier'] });
  await http.updateStaff('s1', { isActive: false });
  await http.issueStaffKey('s1', { key: '527193', expiresInDays: 30 });
  await http.revokeKey('key1');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET /api/company/license',
      'GET /api/company/branches',
      'POST /api/company/branches',
      'GET /api/company/staff?clubId=club%201',
      'GET /api/company/staff',
      'POST /api/company/staff',
      'POST /api/company/staff/s1/update',
      'POST /api/company/staff/s1/keys',
      'POST /api/company/keys/key1/revoke',
    ],
  );
  assert.deepEqual(calls[5]!.body, { clubId: 'k1', name: 'Айгерим', roles: ['waiter', 'cashier'] });
  assert.deepEqual(calls[7]!.body, { key: '527193', expiresInDays: 30 });
});

test('error codes reach the page: 409 LICENSE_CLUB_LIMIT, 422 KEY_WEAK', async () => {
  mockFetch((url) =>
    url.endsWith('/branches')
      ? { status: 409, body: { error: { code: 'LICENSE_CLUB_LIMIT', message: 'limit' } } }
      : { status: 422, body: { error: { code: 'KEY_WEAK', message: 'weak' } } },
  );
  await assert.rejects(http.createBranch({ name: 'X' }), (e: unknown) => {
    assert.ok(e instanceof CloudRequestError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'LICENSE_CLUB_LIMIT');
    return true;
  });
  await assert.rejects(http.issueStaffKey('s1', { key: '111111' }), (e: unknown) => (e as CloudRequestError).code === 'KEY_WEAK');
});
