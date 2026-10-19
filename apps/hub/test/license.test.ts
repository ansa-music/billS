import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { CheckView, HubState, LicensePayload, LicenseResponse, SessionView, StaffView } from '@bills/domain';
import { b64urlDecodeBytes, b64urlEncode, DEV_LICENSE_KEY, signLicense } from '@bills/domain';
import { run } from '../src/db.ts';
import type { HubDeps } from '../src/hub.ts';
import type { TestHub } from './helpers.ts';
import { Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';

/*
 * Licenses on the HUB (enforce mode, dev key): a valid license lets the club
 * work; past its end only reading, finishing and paying for running games and
 * the cash shift are allowed; a changed or foreign license is refused.
 */

const DAY = 86_400_000;
const ENFORCE: Partial<HubDeps> = { license: { mode: 'enforce', publicKeys: { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey } } };

interface ErrorBody {
  error?: { code: string; message: string };
}

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

function payload(hub: TestHub, patch: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    id: randomUUID(),
    companyId: 'co-1',
    companyName: 'Шары и кии',
    plan: 'trial',
    issuedAt: MONDAY_NOON,
    validFrom: MONDAY_NOON,
    validUntil: MONDAY_NOON + 7 * DAY,
    maxClubs: 2,
    maxTables: null,
    maxStaff: null,
    modules: { bar: true, cloud: true, hardware: true },
    hubIds: [hub.hub.license.hubId],
    blocked: false,
    ...patch,
  };
}

const sign = (p: LicensePayload) => signLicense(p, DEV_LICENSE_KEY.privateKey, DEV_LICENSE_KEY.kid);

async function install(hub: TestHub, text: string) {
  const res = await post(hub, '/api/license', { license: text });
  return { status: res.status, body: res.body as unknown as LicenseResponse & ErrorBody };
}

async function getJson<T>(hub: TestHub, url: string): Promise<T> {
  return (await hub.app.inject({ method: 'GET', url })).json() as T;
}

async function openTable(hub: TestHub, name: string) {
  const res = await post(hub, `/api/tables/${tableId(hub, name)}/open`);
  return { status: res.status, body: res.body as SessionView & ErrorBody };
}

test('enforce: without a license the club is read-only; a dev-signed 7-day license opens it', async (t) => {
  const h = harness(t);
  const hub = await h.start(undefined, ENFORCE);
  const before = await getJson<LicenseResponse>(hub, '/api/license');
  assert.equal(before.enforced, true);
  assert.equal(before.status.state, 'missing');
  assert.equal(before.hubId, `club:${hub.hub.state().club.id}`);
  const refused = await openTable(hub, 'Стол 1');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, 'LICENSE_READ_ONLY');

  const res = await install(hub, await sign(payload(hub)));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status.state, 'active');
  assert.equal(res.body.source, 'manual');
  assert.equal(res.body.installedAt, h.clock.now());
  assert.equal((await openTable(hub, 'Стол 1')).status, 201);
  const state = await getJson<HubState>(hub, '/api/state');
  assert.equal(state.license?.state, 'active');
  assert.equal(state.license?.message, null);
  assert.equal(state.license?.daysLeft, 7);
  const me = await getJson<{ license: { state: string } | null }>(hub, '/api/auth/me');
  assert.equal(me.license?.state, 'active');
});

test('after validUntil: no new games, but the running one stops and is paid and the shift closes; winding the clock back does not help', async (t) => {
  const h = harness(t);
  let hub = await h.start(undefined, ENFORCE);
  assert.equal((await install(hub, await sign(payload(hub)))).status, 200);

  const shift = await post(hub, '/api/shifts/open', { openingFloat: 0 });
  assert.equal(shift.status, 201);
  const game = await openTable(hub, 'Стол 1');
  assert.equal(game.status, 201);
  await waitFor(() => sessionStatus(hub, game.body.id) === 'ACTIVE');

  // Three days before the end the banner warns.
  h.clock.set(MONDAY_NOON + 4 * DAY + 60_000);
  const warn = (await getJson<HubState>(hub, '/api/state')).license!;
  assert.equal(warn.state, 'expiring');
  assert.equal(warn.readOnly, false);
  assert.match(warn.message ?? '', /Лицензия заканчивается через 3 дн/);
  h.clock.set(MONDAY_NOON + 7 * DAY - 3_600_000);
  assert.equal((await getJson<HubState>(hub, '/api/state')).license?.state, 'last_day');

  h.clock.set(MONDAY_NOON + 7 * DAY + 60_000);
  const expired = (await getJson<HubState>(hub, '/api/state')).license!;
  assert.equal(expired.state, 'expired');
  assert.equal(expired.readOnly, true);
  const refused = await openTable(hub, 'Стол 2');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, 'LICENSE_READ_ONLY');
  assert.equal(refused.body.error?.message, expired.message);
  const tariff = await post(hub, '/api/tables', { name: 'Стол 9', kind: 'pool', lampChannel: 'relay-9', defaultTariffId: 'x' });
  assert.equal((tariff.body as ErrorBody).error?.code, 'LICENSE_READ_ONLY');

  // The game already running is finished and paid; the shift closes.
  assert.equal((await post(hub, `/api/sessions/${game.body.id}/pause`)).status, 200);
  assert.equal((await post(hub, `/api/sessions/${game.body.id}/resume`)).status, 200);
  const stopped = await post(hub, `/api/sessions/${game.body.id}/stop`);
  assert.equal(stopped.status, 200);
  const check = await post(hub, '/api/checks', { sessionIds: [game.body.id] });
  assert.equal(check.status, 201);
  const due = (check.body as unknown as CheckView).due;
  const paid = await post(hub, `/api/checks/${(check.body as unknown as CheckView).id}/pay`, { parts: [{ method: 'CASH', amount: due }] });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const closed = await post(hub, `/api/shifts/${(shift.body as unknown as { id: string }).id}/close`, { countedCash: due });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  // Clock wound back to the middle of the term: still expired, also after a restart.
  h.clock.set(MONDAY_NOON + 2 * DAY);
  assert.equal((await getJson<HubState>(hub, '/api/state')).license?.state, 'expired');
  assert.equal((await openTable(hub, 'Стол 2')).status, 403);
  await h.crash();
  hub = await h.start(undefined, ENFORCE);
  assert.equal((await getJson<LicenseResponse>(hub, '/api/license')).status.state, 'expired');
  assert.equal((await openTable(hub, 'Стол 2')).body.error?.code, 'LICENSE_READ_ONLY');

  // An extension (a newer license) brings the club back.
  const longer = await install(hub, await sign(payload(hub, { issuedAt: MONDAY_NOON + DAY, validUntil: MONDAY_NOON + 40 * DAY })));
  assert.equal(longer.status, 200);
  assert.equal((await openTable(hub, 'Стол 2')).status, 201);
});

test('forgeries: a changed payload, another signing key, an unknown key id, another HUB, an older license — all refused', async (t) => {
  const h = harness(t);
  const hub = await h.start(undefined, ENFORCE);
  const good = await sign(payload(hub));
  const [prefix, kid, body, sig] = good.split('.') as [string, string, string, string];

  // Extend the term by editing the payload, keeping the signature.
  const edited = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(body))) as LicensePayload;
  edited.validUntil += 365 * DAY;
  const tampered = `${prefix}.${kid}.${b64urlEncode(new TextEncoder().encode(JSON.stringify(edited)))}.${sig}`;
  const r1 = await install(hub, tampered);
  assert.equal(r1.status, 422);
  assert.equal(r1.body.error?.code, 'LICENSE_INVALID');

  // Signed by someone else's key under the dev key id.
  const { privateKey } = generateKeyPairSync('ed25519');
  const foreignPkcs8 = b64urlEncode(new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' })));
  const foreign = await signLicense(payload(hub), foreignPkcs8, DEV_LICENSE_KEY.kid);
  assert.equal((await install(hub, foreign)).body.error?.code, 'LICENSE_INVALID');
  const unknownKid = await signLicense(payload(hub), foreignPkcs8, 'pirate');
  assert.equal((await install(hub, unknownKid)).body.error?.code, 'LICENSE_INVALID');
  assert.equal((await install(hub, 'не лицензия')).body.error?.code, 'LICENSE_INVALID');

  // A genuine license, but for other HUBs.
  const otherHub = await install(hub, await sign(payload(hub, { hubIds: ['club:somewhere-else'] })));
  assert.equal(otherHub.status, 422);
  assert.match(otherHub.body.error?.message ?? '', /другого филиала/);

  // Nothing was installed by any of that.
  assert.equal((await getJson<LicenseResponse>(hub, '/api/license')).status.state, 'missing');

  // An old unblocked license must not undo a newer block.
  assert.equal((await install(hub, await sign(payload(hub, { issuedAt: MONDAY_NOON + 1000, blocked: true })))).status, 200);
  assert.equal((await getJson<LicenseResponse>(hub, '/api/license')).status.state, 'blocked');
  const older = await install(hub, good);
  assert.equal(older.status, 422);
  assert.equal((await openTable(hub, 'Стол 1')).body.error?.code, 'LICENSE_READ_ONLY');
});

test('the stored license is checked on every start: an edited row is invalid, another HUB\'s license is wrong_hub', async (t) => {
  const h = harness(t);
  let hub = await h.start(undefined, ENFORCE);
  const text = await sign(payload(hub, { maxTables: 6 }));
  assert.equal((await install(hub, text)).status, 200);
  assert.equal((await openTable(hub, 'Стол 1')).status, 201);

  // Someone with access to the database widens the license by hand.
  const [prefix, kid, body, sig] = text.split('.') as [string, string, string, string];
  const edited = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(body))) as LicensePayload;
  edited.validUntil += 365 * DAY;
  edited.maxTables = null;
  run(hub.db, 'UPDATE license_state SET signed = ? WHERE id = 1', `${prefix}.${kid}.${b64urlEncode(new TextEncoder().encode(JSON.stringify(edited)))}.${sig}`);
  // The running HUB keeps the verified copy in memory…
  assert.equal((await getJson<LicenseResponse>(hub, '/api/license')).status.state, 'active');
  await h.crash();
  // …and after a restart the row fails the signature: read-only.
  hub = await h.start(undefined, ENFORCE);
  const invalid = (await getJson<LicenseResponse>(hub, '/api/license')).status;
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.readOnly, true);
  assert.equal((await openTable(hub, 'Стол 2')).body.error?.code, 'LICENSE_READ_ONLY');

  // A genuine license copied from another branch's HUB.
  run(hub.db, 'UPDATE license_state SET signed = ? WHERE id = 1', await sign(payload(hub, { hubIds: ['club:another-branch'] })));
  await h.crash();
  hub = await h.start(undefined, ENFORCE);
  assert.equal((await getJson<LicenseResponse>(hub, '/api/license')).status.state, 'wrong_hub');
  assert.equal((await openTable(hub, 'Стол 2')).status, 403);
});

test('license limits: maxTables and maxStaff (managers do not count)', async (t) => {
  const h = harness(t);
  const hub = await h.start(undefined, ENFORCE);
  assert.equal((await install(hub, await sign(payload(hub, { maxTables: 6, maxStaff: 3 })))).status, 200);
  const tariffId = hub.hub.state().tariffs[0]!.id;

  const table = await post(hub, '/api/tables', { name: 'Стол 7', kind: 'pool', lampChannel: 'relay-7', defaultTariffId: tariffId });
  assert.equal(table.status, 409);
  assert.equal((table.body as ErrorBody).error?.code, 'LICENSE_TABLE_LIMIT');
  // Switching one table off frees a place.
  const first = tableId(hub, 'Стол 5');
  assert.equal((await post(hub, `/api/tables/${first}/update`, { isActive: false })).status, 200);
  assert.equal((await post(hub, '/api/tables', { name: 'Стол 7', kind: 'pool', lampChannel: 'relay-7', defaultTariffId: tariffId })).status, 201);
  const back = await post(hub, `/api/tables/${first}/update`, { isActive: true });
  assert.equal((back.body as ErrorBody).error?.code, 'LICENSE_TABLE_LIMIT');

  // Admin, cashier and waiter are three: a fourth employee is over the limit, a manager is not counted.
  const extra = await post(hub, '/api/staff', { name: 'Четвёртый', roles: ['waiter'] });
  assert.equal(extra.status, 409);
  assert.equal((extra.body as ErrorBody).error?.code, 'LICENSE_STAFF_LIMIT');
  assert.equal((await post(hub, '/api/staff', { name: 'Ещё управляющий', roles: ['manager'] })).status, 201);
  // Dismiss one, hire one; the dismissed one cannot come back while the branch is full.
  const waiter = hub.hub.staff.list().find((s) => s.name === 'Данияр Официант')!;
  assert.equal((await post(hub, `/api/staff/${waiter.id}/update`, { isActive: false })).status, 200);
  const hired = await post(hub, '/api/staff', { name: 'Новый официант', roles: ['waiter'] });
  assert.equal(hired.status, 201);
  const rehire = await post(hub, `/api/staff/${waiter.id}/update`, { isActive: true });
  assert.equal((rehire.body as ErrorBody).error?.code, 'LICENSE_STAFF_LIMIT');
  // A manager demoted to staff starts counting too.
  const mgr: StaffView = hub.hub.staff.list().find((s) => s.name === 'Ещё управляющий')!;
  assert.equal(((await post(hub, `/api/staff/${mgr.id}/update`, { roles: ['senior'] })).body as ErrorBody).error?.code, 'LICENSE_STAFF_LIMIT');
});

test('the bar module switched off: orders and the catalog answer LICENSE_MODULE_OFF, games go on', async (t) => {
  const h = harness(t);
  const hub = await h.start(undefined, ENFORCE);
  assert.equal((await install(hub, await sign(payload(hub, { modules: { bar: false, cloud: true, hardware: true } })))).status, 200);
  const game = await openTable(hub, 'Стол 1');
  assert.equal(game.status, 201);
  const product = hub.hub.bar.catalog().products[0]!;
  const order = await post(hub, `/api/sessions/${game.body.id}/orders`, { items: [{ productId: product.id, qty: 1 }] });
  assert.equal(order.status, 403);
  assert.equal((order.body as ErrorBody).error?.code, 'LICENSE_MODULE_OFF');
  assert.match((order.body as ErrorBody).error?.message ?? '', /Бар и меню/);
  const catalog = await hub.app.inject({ method: 'GET', url: '/api/bar/catalog' });
  assert.equal(catalog.statusCode, 403);
  assert.equal((catalog.json() as ErrorBody).error?.code, 'LICENSE_MODULE_OFF');
  assert.equal((await post(hub, `/api/sessions/${game.body.id}/stop`)).status, 200);
});

test('license off (the default): nothing is limited and the state carries no license', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  assert.equal((await getJson<HubState>(hub, '/api/state')).license, null);
  const res = await getJson<LicenseResponse>(hub, '/api/license');
  assert.equal(res.enforced, false);
  assert.equal((await openTable(hub, 'Стол 1')).status, 201);
});
