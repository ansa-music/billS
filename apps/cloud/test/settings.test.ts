import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ClubDetails,
  OwnerOverview,
  SyncSettingsResponse,
  SyncSnapshotRequest,
  SyncSnapshotResponse,
  TariffConfig,
  UpdateTariffsResponse,
} from '@bills/domain';
import { clubIdOf, cloud, HUB1, hubGet, hubPost, login, ownerGet, ownerPut, sendEvents } from './helpers.ts';

const CONFIG: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2500_00,
  windows: [{ label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3500_00 }],
  stepMinutes: 1,
  minimumMinutes: 30,
  freeMinutes: 3,
  roundingMinor: 10_00,
};

function snapshot(settingsVersion: number): SyncSnapshotRequest {
  return {
    hubId: HUB1.id,
    settingsVersion,
    club: { name: 'Клуб «Демо»', timezone: 'Asia/Almaty', currency: 'KZT' },
    tariffs: [{ id: 'hub-tariff-1', name: 'Из HUB', config: CONFIG, isActive: true }],
    tables: [
      { id: 'hub-table-1', name: 'Стол A', kind: 'pool', lampChannel: 'relay-1', defaultTariffId: 'hub-tariff-1', sortOrder: 1, isActive: true },
    ],
  };
}

test('owner edits tariffs: version +1, HUB pulls by version, stale snapshot is 409', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);

  // The HUB reports its settings first (version 0 on both sides).
  const snap0 = await hubPost<SyncSnapshotResponse>(c, HUB1.key, '/sync/snapshot', snapshot(0));
  assert.equal(snap0.status, 200);
  assert.deepEqual(snap0.body, { accepted: true, settingsVersion: 0 });

  const before = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(before.body.settings.version, 0);
  assert.equal(before.body.settings.tariffs[0]?.name, 'Из HUB');
  assert.equal(before.body.settings.tables[0]?.name, 'Стол A');
  assert.equal(before.body.club.hub?.pendingSettings, false);

  // Owner: renames the HUB tariff, adds a new one, drops nothing.
  const put = await ownerPut<UpdateTariffsResponse>(c, cookie, `/api/owner/clubs/${clubId}/tariffs`, {
    tariffs: [
      { id: 'hub-tariff-1', name: 'Стандарт+', config: { ...CONFIG, basePricePerHour: 3000_00 }, isActive: true },
      { name: 'VIP', config: { ...CONFIG, basePricePerHour: 9000_00, junk: 'ignored' }, isActive: true },
    ],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.settings.version, 1);
  assert.equal(put.body.settings.tariffs.length, 2);
  assert.equal(put.body.settings.tariffs[0]?.name, 'Стандарт+');
  assert.equal(put.body.settings.tariffs[0]?.config.basePricePerHour, 3000_00);
  assert.ok(put.body.settings.tariffs[1]?.id);
  assert.ok(!('junk' in (put.body.settings.tariffs[1]?.config ?? {})));
  assert.equal(put.body.settings.tables[0]?.name, 'Стол A'); // tables untouched

  // The HUB has not pulled yet.
  const ov = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(ov.body.clubs.find((x) => x.id === clubId)?.hub?.pendingSettings, true);

  // The next batch tells the HUB the cloud is ahead.
  const batch = await sendEvents(c, HUB1, [], 0);
  assert.equal(batch.body.settingsVersion, 1);

  const changed = await hubGet<SyncSettingsResponse>(c, HUB1.key, '/sync/settings?since=0');
  assert.equal(changed.status, 200);
  assert.equal(changed.body.changed, true);
  if (changed.body.changed) {
    assert.equal(changed.body.version, 1);
    assert.deepEqual(changed.body.tariffs.map((x) => x.name), ['Стандарт+', 'VIP']);
    assert.equal(changed.body.tables.length, 1);
    assert.deepEqual(changed.body.club, { name: 'Клуб «Демо»', timezone: 'Asia/Almaty', currency: 'KZT' });
  }
  const same = await hubGet<SyncSettingsResponse>(c, HUB1.key, '/sync/settings?since=1');
  assert.deepEqual(same.body, { changed: false, version: 1, business: { type: 'billiards' } });

  // A snapshot from a HUB still on version 0 is refused; on version 1 it is accepted and the version stays 1.
  const stale = await hubPost<SyncSnapshotResponse>(c, HUB1.key, '/sync/snapshot', snapshot(0));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { accepted: false, settingsVersion: 1 });
  const current = await hubPost<SyncSnapshotResponse>(c, HUB1.key, '/sync/snapshot', snapshot(1));
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, { accepted: true, settingsVersion: 1 });

  // HUB reports version 1 applied: no longer pending.
  await sendEvents(c, HUB1, [], 1);
  const after = await ownerGet<OwnerOverview>(c, cookie, '/api/owner/overview');
  assert.equal(after.body.clubs.find((x) => x.id === clubId)?.hub?.pendingSettings, false);
  assert.equal(after.body.clubs.find((x) => x.id === clubId)?.hub?.settingsVersion, 1);

  // A tariff missing from the next edit is deactivated, not deleted.
  const put2 = await ownerPut<UpdateTariffsResponse>(c, cookie, `/api/owner/clubs/${clubId}/tariffs`, {
    tariffs: [{ id: 'hub-tariff-1', name: 'Только один', config: CONFIG, isActive: true }],
  });
  assert.equal(put2.body.settings.version, 2);
  assert.deepEqual(put2.body.settings.tariffs.map((x) => x.isActive), [true]);
});

test('invalid tariffs are refused with 400 TARIFF_INVALID', async (t) => {
  const c = await cloud(t);
  const cookie = await login(c);
  const clubId = await clubIdOf(c, HUB1.id);
  const url = `/api/owner/clubs/${clubId}/tariffs`;

  const cases: Array<[string, unknown]> = [
    ['negative price', { tariffs: [{ name: 'X', config: { ...CONFIG, basePricePerHour: -1 }, isActive: true }] }],
    ['bad window time', { tariffs: [{ name: 'X', config: { ...CONFIG, windows: [{ ...CONFIG.windows[0]!, to: '25:00' }] }, isActive: true }] }],
    ['bad weekday', { tariffs: [{ name: 'X', config: { ...CONFIG, windows: [{ ...CONFIG.windows[0]!, days: [0] }] }, isActive: true }] }],
    ['no name', { tariffs: [{ name: '  ', config: CONFIG, isActive: true }] }],
    ['no config', { tariffs: [{ name: 'X', isActive: true }] }],
    ['windows not a list', { tariffs: [{ name: 'X', config: { ...CONFIG, windows: 'none' }, isActive: true }] }],
    ['all inactive', { tariffs: [{ name: 'X', config: CONFIG, isActive: false }] }],
    ['duplicate ids', { tariffs: [{ id: 'a', name: 'X', config: CONFIG, isActive: true }, { id: 'a', name: 'Y', config: CONFIG, isActive: true }] }],
  ];
  for (const [label, body] of cases) {
    const res = await ownerPut<{ error: { code: string; message: string } }>(c, cookie, url, body);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error.code, 'TARIFF_INVALID', label);
  }
  const notList = await ownerPut<{ error: { code: string } }>(c, cookie, url, { tariffs: 'x' });
  assert.equal(notList.status, 400);

  const details = await ownerGet<ClubDetails>(c, cookie, `/api/owner/clubs/${clubId}`);
  assert.equal(details.body.settings.version, 0);

  const anonymous = await c.app.inject({ method: 'PUT', url, payload: { tariffs: [] } });
  assert.equal(anonymous.statusCode, 401);
});
