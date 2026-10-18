import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ClubAdminView, TableAdminView, TariffAdminView, TariffConfig } from '@bills/domain';
import { all } from '../src/db.ts';
import type { ChangeEvent } from '../src/events.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, Harness, post, sessionStatus, tableId, waitFor } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function getClub(hub: TestHub): Promise<ClubAdminView> {
  const res = await hub.app.inject({ method: 'GET', url: '/api/club' });
  assert.equal(res.statusCode, 200);
  return res.json() as ClubAdminView;
}

/** `post` is typed for games; the settings routes answer with other views. */
async function send<T>(hub: TestHub, url: string, body: object, key?: string) {
  const res = await post(hub, url, body, key);
  return { status: res.status, body: res.body as unknown as T & { error?: { code: string; message: string } }, headers: res.headers };
}

const tariffConfig = (currency = 'KZT'): TariffConfig => ({
  currency,
  basePricePerHour: 2500_00,
  windows: [{ label: 'Ночь', days: [5, 6], from: '22:00', to: '06:00', pricePerHour: 4000_00 }],
  stepMinutes: 5,
  minimumMinutes: 30,
  freeMinutes: 3,
  roundingMinor: 10_00,
});

test('GET /api/club lists the club with all tables and tariffs', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const club = await getClub(hub);
  assert.equal(club.name, 'Клуб «Демо»');
  assert.equal(club.timezone, 'Asia/Almaty');
  assert.equal(club.currency, 'KZT');
  assert.equal(club.companyName, 'Демо компания');
  assert.equal(club.settings.display.theme, 'auto');
  assert.equal(club.tables.length, 6);
  assert.deepEqual(club.tables.map((x) => x.sortOrder), [1, 2, 3, 4, 5, 6]);
  assert.ok(club.tables.every((x) => x.isActive && !x.busy && x.lampChannel.startsWith('relay-')));
  const standard = club.tariffs.find((x) => x.name === 'Стандарт');
  assert.equal(standard?.tableCount, 5);
  assert.equal(club.tariffs.find((x) => x.name === 'Снукер')?.tableCount, 1);

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  assert.equal((await getClub(hub)).tables.find((x) => x.name === 'Стол 2')?.busy, true);
});

test('club name, time zone, currency and settings are updated and read back', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const events: ChangeEvent[] = [];
  hub.hub.events.on('changed', (e) => events.push(e));

  const res = await send<ClubAdminView>(hub, '/api/club', {
    name: '  Клуб «Пирамида»  ',
    timezone: 'Europe/Moscow',
    currency: 'RUB',
    settings: {
      display: { title: 'Пирамида', theme: 'dark', cardSize: 'large', waiterSees: 'time' },
      rules: { freeTableAfterStop: 'after_payment', defaultFreeMinutes: 5 },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Клуб «Пирамида»');
  assert.equal(res.body.timezone, 'Europe/Moscow');
  assert.equal(res.body.currency, 'RUB');
  assert.equal(res.body.settings.display.theme, 'dark');
  assert.equal(res.body.settings.display.title, 'Пирамида');
  assert.equal(res.body.settings.display.logoUrl, null);
  assert.equal(res.body.settings.rules.freeTableAfterStop, 'after_payment');
  assert.equal(res.body.settings.rules.defaultFreeMinutes, 5);
  // Untouched keys keep their values.
  assert.equal(res.body.settings.rules.defaultMinimumMinutes, 30);

  const again = await getClub(hub);
  assert.deepEqual(again.settings, res.body.settings);
  const state = hub.hub.state();
  assert.equal(state.club.name, 'Клуб «Пирамида»');
  assert.equal(state.club.timezone, 'Europe/Moscow');
  assert.equal(state.settings.display.cardSize, 'large');
  assert.ok(events.some((e) => e.kind === 'club'));

  const audit = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'club.updated'");
  assert.equal(audit.length, 1);
  const data = JSON.parse(audit[0]!.data) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ['currency', 'name', 'settings', 'timezone']);

  // A partial patch with a null clears the title.
  const cleared = await send<ClubAdminView>(hub, '/api/club', { settings: { display: { title: null } } });
  assert.equal(cleared.body.settings.display.title, null);
  assert.equal(cleared.body.settings.display.theme, 'dark');
});

test('an unknown time zone, a bad currency and inconsistent rules are rejected', async (t) => {
  const h = harness(t);
  const hub = await h.start();

  const tz = await send(hub, '/api/club', { timezone: 'Mars/Olympus' });
  assert.equal(tz.status, 422);
  assert.equal(tz.body.error?.code, 'TIMEZONE_INVALID');

  const cur = await send(hub, '/api/club', { currency: 'tenge' });
  assert.equal(cur.status, 400);

  const cur2 = await send(hub, '/api/club', { currency: '12$' });
  assert.equal(cur2.status, 422);
  assert.equal(cur2.body.error?.code, 'CURRENCY_INVALID');

  const rules = await send(hub, '/api/club', {
    settings: { rules: { defaultFreeMinutes: 20, defaultMinimumMinutes: 10 } },
  });
  assert.equal(rules.status, 422);
  assert.equal(rules.body.error?.code, 'SETTINGS_INVALID');
  assert.match(rules.body.error?.message ?? '', /Минимальное время/);

  const unknownKey = await send(hub, '/api/club', { settings: { display: { theme: 'neon' } } });
  assert.equal(unknownKey.status, 400);

  const empty = await send(hub, '/api/club', { name: '   ' });
  assert.equal(empty.status, 422);

  // Nothing changed.
  const club = await getClub(hub);
  assert.equal(club.timezone, 'Asia/Almaty');
  assert.equal(club.settings.rules.defaultFreeMinutes, 3);
  assert.ok(!auditActions(hub).includes('club.updated'));
});

test('a table is created with its lamp channel; duplicate channels and names are refused', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const club = await getClub(hub);
  const standard = club.tariffs.find((x) => x.name === 'Стандарт')!;

  const created = await send<TableAdminView>(hub, '/api/tables', {
    name: 'Стол 7',
    kind: 'russian',
    lampChannel: 'relay-7',
    defaultTariffId: standard.id,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.sortOrder, 7);
  assert.equal(created.body.isActive, true);
  assert.equal(created.body.busy, false);
  assert.equal(created.body.kind, 'russian');

  const lamp = all<{ desired: string; reported: string }>(
    hub.db,
    'SELECT desired, reported FROM lamp_states WHERE table_id = ?',
    created.body.id,
  )[0];
  assert.equal(lamp?.desired, 'OFF');
  // The periodic reconcile takes the new table under control: its lamp is brought to OFF.
  assert.equal(hub.hub.lamps.reconcile(), 1);
  await waitFor(() => hub.hub.state().tables.find((x) => x.id === created.body.id)?.lamp.reported === 'OFF');

  const dupChannel = await send(hub, '/api/tables', {
    name: 'Стол 8',
    kind: 'pool',
    lampChannel: 'relay-7',
    defaultTariffId: standard.id,
  });
  assert.equal(dupChannel.status, 409);
  assert.equal(dupChannel.body.error?.code, 'LAMP_CHANNEL_TAKEN');

  const dupName = await send(hub, '/api/tables', {
    name: ' Стол 7 ',
    kind: 'pool',
    lampChannel: 'relay-8',
    defaultTariffId: standard.id,
  });
  assert.equal(dupName.status, 409);
  assert.equal(dupName.body.error?.code, 'TABLE_NAME_TAKEN');

  const badTariff = await send(hub, '/api/tables', {
    name: 'Стол 9',
    kind: 'pool',
    lampChannel: 'relay-9',
    defaultTariffId: randomUUID(),
  });
  assert.equal(badTariff.status, 422);
  assert.equal(badTariff.body.error?.code, 'TARIFF_NOT_AVAILABLE');

  const badKind = await send(hub, '/api/tables', {
    name: 'Стол 9',
    kind: 'carom',
    lampChannel: 'relay-9',
    defaultTariffId: standard.id,
  });
  assert.equal(badKind.status, 400);

  // The new table can be played on right away.
  const opened = await post(hub, `/api/tables/${created.body.id}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  assert.ok(hub.driver.isOn('relay-7'));
  assert.equal(all(hub.db, 'SELECT id FROM billiard_tables').length, 7);
});

test('a table with a running game cannot be switched off; an inactive table leaves the hall screen', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const table = tableId(hub, 'Стол 3');
  const opened = await post(hub, `/api/tables/${table}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  const busy = await send(hub, `/api/tables/${table}/update`, { isActive: false });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error?.code, 'TABLE_BUSY');

  // Other fields can still be edited while the game goes on.
  const renamed = await send<TableAdminView>(hub, `/api/tables/${table}/update`, { name: 'Стол 3 VIP', kind: 'snooker' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Стол 3 VIP');
  assert.equal(renamed.body.busy, true);

  await post(hub, `/api/sessions/${opened.body.id}/stop`);
  const off = await send<TableAdminView>(hub, `/api/tables/${table}/update`, { isActive: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.isActive, false);
  assert.ok(!hub.hub.state().tables.some((x) => x.id === table));
  assert.ok((await getClub(hub)).tables.some((x) => x.id === table && !x.isActive));
  assert.equal((await post(hub, `/api/tables/${table}/open`)).status, 404);

  // Its name is free for another table while it is off, and it cannot come back under a taken name.
  const standard = (await getClub(hub)).tariffs.find((x) => x.name === 'Стандарт')!;
  const twin = await send<TableAdminView>(hub, '/api/tables', {
    name: 'Стол 3 VIP',
    kind: 'pool',
    lampChannel: 'relay-77',
    defaultTariffId: standard.id,
  });
  assert.equal(twin.status, 201);
  const back = await send(hub, `/api/tables/${table}/update`, { isActive: true });
  assert.equal(back.status, 409);
  assert.equal(back.body.error?.code, 'TABLE_NAME_TAKEN');
  const backRenamed = await send<TableAdminView>(hub, `/api/tables/${table}/update`, { isActive: true, name: 'Стол 3' });
  assert.equal(backRenamed.status, 200);
  assert.equal(backRenamed.body.isActive, true);

  const channelClash = await send(hub, `/api/tables/${table}/update`, { lampChannel: 'relay-77' });
  assert.equal(channelClash.status, 409);
  assert.equal(channelClash.body.error?.code, 'LAMP_CHANNEL_TAKEN');
  assert.equal((await send(hub, `/api/tables/${randomUUID()}/update`, { name: 'x' })).status, 404);
});

test('tables are reordered; ids must be the club tables', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const before = (await getClub(hub)).tables;
  const ids = before.map((x) => x.id);
  const reversed = [...ids].reverse();

  const res = await send<{ tables: TableAdminView[] }>(hub, '/api/tables/reorder', { tableIds: reversed });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tables.map((x) => x.id), reversed);
  assert.deepEqual(res.body.tables.map((x) => x.sortOrder), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(hub.hub.state().tables.map((x) => x.id), reversed);

  // A partial list moves the named tables first; the rest keep their order.
  const partial = await send<{ tables: TableAdminView[] }>(hub, '/api/tables/reorder', { tableIds: [ids[0]!] });
  assert.deepEqual(partial.body.tables.map((x) => x.id), [ids[0], ...reversed.filter((x) => x !== ids[0])]);

  const foreign = await send(hub, '/api/tables/reorder', { tableIds: [...ids, randomUUID()] });
  assert.equal(foreign.status, 422);
  assert.equal(foreign.body.error?.code, 'TABLE_IDS_INVALID');
  const dup = await send(hub, '/api/tables/reorder', { tableIds: [ids[0], ids[0]] });
  assert.equal(dup.status, 422);
});

test('a tariff is created; an invalid one is rejected', async (t) => {
  const h = harness(t);
  const hub = await h.start();

  const created = await send<TariffAdminView>(hub, '/api/tariffs', { name: 'VIP', config: tariffConfig() });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'VIP');
  assert.equal(created.body.isActive, true);
  assert.equal(created.body.tableCount, 0);
  assert.equal(created.body.config.basePricePerHour, 2500_00);
  assert.deepEqual(created.body.config.windows[0]?.days, [5, 6]);
  assert.ok(hub.hub.state().tariffs.some((x) => x.id === created.body.id));

  const badClock = await send(hub, '/api/tariffs', {
    name: 'Сломанный',
    config: { ...tariffConfig(), windows: [{ label: 'X', days: [1], from: '25:00', to: '06:00', pricePerHour: 100 }] },
  });
  assert.equal(badClock.status, 422);
  assert.equal(badClock.body.error?.code, 'TARIFF_INVALID');
  assert.match(badClock.body.error?.message ?? '', /windows\[0\]\.from/);

  const badDays = await send(hub, '/api/tariffs', {
    name: 'Сломанный',
    config: { ...tariffConfig(), windows: [{ label: 'X', days: [], from: '10:00', to: '12:00', pricePerHour: 100 }] },
  });
  assert.equal(badDays.status, 422);

  const badStep = await send(hub, '/api/tariffs', { name: 'Сломанный', config: { ...tariffConfig(), stepMinutes: 0 } });
  assert.equal(badStep.status, 400); // the JSON schema stops it before the domain does

  const float = await send(hub, '/api/tariffs', { name: 'Сломанный', config: { ...tariffConfig(), basePricePerHour: 25.5 } });
  assert.equal(float.status, 400);

  const wrongCurrency = await send(hub, '/api/tariffs', { name: 'Доллары', config: tariffConfig('USD') });
  assert.equal(wrongCurrency.status, 422);
  assert.equal(wrongCurrency.body.error?.code, 'TARIFF_INVALID');

  const dupName = await send(hub, '/api/tariffs', { name: 'VIP', config: tariffConfig() });
  assert.equal(dupName.status, 409);
  assert.equal(dupName.body.error?.code, 'TARIFF_NAME_TAKEN');

  const tableCount = all(hub.db, 'SELECT id FROM tariffs').length;
  assert.equal(tableCount, 3);
});

test('a tariff change does not reprice a running game and a default tariff cannot be switched off', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const tariffId = opened.body.tariffId;

  const config = (await getClub(hub)).tariffs.find((x) => x.id === tariffId)!.config;
  const updated = await send<TariffAdminView>(hub, `/api/tariffs/${tariffId}/update`, {
    name: 'Стандарт 2027',
    config: { ...config, basePricePerHour: 9000_00 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Стандарт 2027');
  assert.equal(updated.body.config.basePricePerHour, 9000_00);
  assert.equal(updated.body.tableCount, 5);

  h.clock.advance(HOUR);
  const stopped = await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.body.amount, 2000_00);
  assert.equal(stopped.body.tariffName, 'Стандарт');

  // A new game uses the new price.
  const next = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, next.body.id) === 'ACTIVE');
  h.clock.advance(HOUR);
  assert.equal((await post(hub, `/api/sessions/${next.body.id}/stop`)).body.amount, 9000_00);

  const inUse = await send(hub, `/api/tariffs/${tariffId}/update`, { isActive: false });
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.error?.code, 'TARIFF_IN_USE');

  // Move every table to another tariff, then it can be switched off; an off tariff cannot be chosen.
  const snooker = (await getClub(hub)).tariffs.find((x) => x.name === 'Снукер')!;
  for (const table of (await getClub(hub)).tables.filter((x) => x.defaultTariffId === tariffId)) {
    assert.equal((await send(hub, `/api/tables/${table.id}/update`, { defaultTariffId: snooker.id })).status, 200);
  }
  const off = await send<TariffAdminView>(hub, `/api/tariffs/${tariffId}/update`, { isActive: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.isActive, false);
  assert.ok(!hub.hub.state().tariffs.some((x) => x.id === tariffId));
  assert.ok((await getClub(hub)).tariffs.some((x) => x.id === tariffId && !x.isActive));
  const pick = await send(hub, `/api/tables/${tableId(hub, 'Стол 1')}/update`, { defaultTariffId: tariffId });
  assert.equal(pick.status, 422);
  assert.equal(pick.body.error?.code, 'TARIFF_NOT_AVAILABLE');
  const openWithIt = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`, { tariffId });
  assert.equal(openWithIt.status, 422);
  assert.equal((await send(hub, `/api/tariffs/${randomUUID()}/update`, { name: 'x' })).status, 404);
});

test('a replayed POST /api/tables returns the same table without a duplicate row', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const standard = (await getClub(hub)).tariffs.find((x) => x.name === 'Стандарт')!;
  const key = randomUUID();
  const body = { name: 'Стол 7', kind: 'pool', lampChannel: 'relay-7', defaultTariffId: standard.id };

  const first = await send<TableAdminView>(hub, '/api/tables', body, key);
  const second = await send<TableAdminView>(hub, '/api/tables', body, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(second.body.id, first.body.id);
  assert.equal(all(hub.db, "SELECT id FROM billiard_tables WHERE name = 'Стол 7'").length, 1);
  assert.equal(auditActions(hub).filter((a) => a === 'table.created').length, 1);

  // The same key with another body is refused; a new key with the same body hits the uniqueness rule.
  assert.equal((await send(hub, '/api/tables', { ...body, name: 'Стол 8' }, key)).status, 422);
  assert.equal((await send(hub, '/api/tables', body)).status, 409);
});

test('every settings command is audited with its actor', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const club = await getClub(hub);
  const standard = club.tariffs.find((x) => x.name === 'Стандарт')!;

  await send(hub, '/api/club', { name: 'Клуб' });
  const table = await send<TableAdminView>(hub, '/api/tables', {
    name: 'Стол 7',
    kind: 'pool',
    lampChannel: 'relay-7',
    defaultTariffId: standard.id,
  });
  await send(hub, `/api/tables/${table.body.id}/update`, { kind: 'russian' });
  await send(hub, '/api/tables/reorder', { tableIds: [table.body.id] });
  const tariff = await send<TariffAdminView>(hub, '/api/tariffs', { name: 'VIP', config: tariffConfig() });
  await send(hub, `/api/tariffs/${tariff.body.id}/update`, { name: 'VIP+' });
  // A no-op update writes nothing.
  await send(hub, `/api/tariffs/${tariff.body.id}/update`, { name: 'VIP+' });
  await send(hub, '/api/club', { name: 'Клуб' });

  const actions = auditActions(hub).filter((a) => !a.startsWith('lamp.') && !a.startsWith('hub.'));
  assert.deepEqual(actions, [
    'club.updated',
    'table.created',
    'table.updated',
    'tables.reordered',
    'tariff.created',
    'tariff.updated',
  ]);
  const actors = new Set(all<{ actor: string }>(hub.db, "SELECT actor FROM audit_log WHERE action LIKE 'club.%' OR action LIKE 'table%' OR action LIKE 'tariff.%'").map((r) => r.actor));
  assert.deepEqual([...actors], ['Кассир Айгерим']);
  assert.equal(all(hub.db, 'SELECT id FROM outbox').length, all(hub.db, 'SELECT id FROM audit_log').length);
});
