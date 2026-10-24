import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClubSnapshot, LoginResponse, RosterResponse } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import type { Db } from '../src/db.ts';
import { all, one, openDb, run } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { INSTALLER_NAME, SYSTEM_ACTOR } from '../src/auth.ts';
import { NEW_CLUB_NAME, prepareClub } from '../src/seed.ts';
import { applyBusinessType, applySettings, SyncWorker } from '../src/sync.ts';
import { HubEvents } from '../src/events.ts';
import { clubId, loadSettings } from '../src/views.ts';
import { FAST_LAMPS, MONDAY_NOON } from './helpers.ts';

type T = { after: (fn: () => unknown) => void };

const count = (db: Db, table: string) => one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;

/** A HUB built like main.ts (tokens only, no X-Actor fallback) on a database prepared like main.ts. */
async function startHub(t: T, options: { demo: boolean; business?: 'billiards' | 'cafe' }) {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  const prepared = prepareClub(db, clock.now(), { demo: options.demo, timezone: 'Asia/Almaty', business: options.business });
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  const app = buildApp(hub, {});
  await app.ready();
  await hub.license.init();
  hub.start();
  t.after(async () => {
    await app.close();
    hub.close();
    db.close();
  });
  return { clock, db, hub, app, prepared };
}

async function roster(app: Awaited<ReturnType<typeof startHub>>['app']): Promise<RosterResponse> {
  const res = await app.inject({ method: 'GET', url: '/api/auth/roster' });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<RosterResponse>();
}

test('a real HUB starts clean: one empty club, no demo data, only a support key', async (t) => {
  const { db, hub, app, prepared } = await startHub(t, { demo: false });
  assert.deepEqual(prepared, { created: true, keyEveryone: false });

  const club = one<{ name: string; timezone: string; currency: string; settings: string | null }>(
    db,
    'SELECT name, timezone, currency, settings FROM clubs',
  )!;
  assert.deepEqual({ name: club.name, timezone: club.timezone, currency: club.currency }, {
    name: NEW_CLUB_NAME,
    timezone: 'Asia/Almaty',
    currency: 'KZT',
  });
  assert.equal(count(db, 'companies'), 1);
  for (const table of ['billiard_tables', 'tariffs', 'product_categories', 'products', 'staff']) {
    assert.equal(count(db, table), 0, `${table} stays empty`);
  }

  // The only starting key: support (TECH), the way main.ts writes it to first-run-keys.txt.
  const keys = hub.auth.bootstrapKeys(prepared.keyEveryone);
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.name, INSTALLER_NAME);
  assert.deepEqual(keys[0]!.roles, ['tech']);
  assert.match(keys[0]!.key, /^TECH-/);
  assert.deepEqual(hub.auth.bootstrapKeys(false), []);

  // Nobody to pick on «Кто на смене?» yet, and the support key signs in.
  assert.deepEqual(await roster(app), { people: [] });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: keys[0]!.key } });
  assert.equal(login.statusCode, 200);
  const state = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${login.json<LoginResponse>().token}` },
  });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json<{ club: { name: string }; tables: unknown[] }>().club.name, NEW_CLUB_NAME);
  assert.deepEqual(state.json<{ tables: unknown[] }>().tables, []);

  // A restart on the same database creates nothing new.
  assert.deepEqual(prepareClub(db, MONDAY_NOON, { demo: false }), { created: false, keyEveryone: false });
  assert.equal(count(db, 'clubs'), 1);
});

test('HUB_DEMO=1 still seeds the demo club and keys every demo employee once', async (t) => {
  const { db, prepared } = await startHub(t, { demo: true });
  assert.deepEqual(prepared, { created: true, keyEveryone: true });
  assert.equal(count(db, 'billiard_tables'), 6);
  assert.ok(count(db, 'staff') >= 4);
  assert.deepEqual(prepareClub(db, MONDAY_NOON, { demo: true }), { created: false, keyEveryone: false });

  const cafe = await startHub(t, { demo: true, business: 'cafe' });
  assert.equal(loadSettings(cafe.db, clubId(cafe.db)).business.type, 'cafe');
  assert.ok(count(cafe.db, 'products') > 0);
});

test('«Кто на смене?»: public names and roles of people with a working six-digit key', async (t) => {
  const { db, hub, app } = await startHub(t, { demo: true });
  const issued = hub.auth.bootstrapKeys(true);
  const byName = (name: string) => one<{ id: string }>(db, 'SELECT id FROM staff WHERE name = ?', name)!.id;
  assert.ok(issued.length >= 4);

  const first = await roster(app);
  const names = first.people.map((p) => p.name);
  // Short-key staff only: the manager signs in with a long key and is not listed.
  assert.deepEqual(names, ['Айгерим Кассир', 'Асель Администратор', 'Данияр Официант']);
  assert.deepEqual(first.people.find((p) => p.name === 'Данияр Официант')!.roles, ['waiter']);
  const text = JSON.stringify(first);
  for (const k of issued) assert.ok(!text.includes(k.key), 'no key ever leaves the HUB');
  assert.deepEqual(Object.keys(first.people[0]!).sort(), ['id', 'name', 'roles']);

  // A revoked key, a dismissed person: gone from the list.
  for (const k of hub.auth.listKeys(byName('Айгерим Кассир'))) hub.auth.revokeKey(k.id, SYSTEM_ACTOR);
  run(db, 'UPDATE staff SET is_active = 0 WHERE name = ?', 'Асель Администратор');
  assert.deepEqual((await roster(app)).people.map((p) => p.name), ['Данияр Официант']);

  // The club may switch the list off (Настройки → экран входа): then only the keypad is shown.
  const manager = issued.find((k) => k.role === 'manager')!;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: manager.key } });
  const token = login.json<LoginResponse>().token;
  const off = await app.inject({
    method: 'POST',
    url: '/api/club',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'roster-off' },
    payload: { settings: { display: { showRoster: false } } },
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(loadSettings(db, clubId(db)).display.showRoster, false);
  assert.deepEqual(await roster(app), { people: [] });
});

test('settings from the cloud carry the business type chosen at sign-up', async (t) => {
  const { db, clock } = await startHub(t, { demo: false });
  const base: ClubSnapshot = {
    version: 1,
    club: { name: 'Кофейня у парка', timezone: 'Asia/Almaty', currency: 'KZT' },
    tariffs: [],
    tables: [],
    staff: [],
  };
  applySettings(db, clock.now(), { ...base, business: { type: 'cafe' } } as ClubSnapshot);
  const club = one<{ name: string }>(db, 'SELECT name FROM clubs')!;
  assert.equal(club.name, 'Кофейня у парка');
  assert.equal(loadSettings(db, clubId(db)).business.type, 'cafe');
  const audit = all<{ data: string }>(db, "SELECT data FROM audit_log WHERE action = 'cloud.settings_applied'");
  assert.equal(JSON.parse(audit.at(-1)!.data).businessType, 'cafe');

  // An older cloud (no `business`) or an unknown type leaves the choice as it is.
  applySettings(db, clock.now(), { ...base, version: 2 });
  applySettings(db, clock.now(), { ...base, version: 3, business: { type: 'casino' } } as unknown as ClubSnapshot);
  assert.equal(loadSettings(db, clubId(db)).business.type, 'cafe');
  // Other settings of the club survive the switch.
  run(db, 'UPDATE clubs SET settings = ?', JSON.stringify({ ...loadSettings(db, clubId(db)), display: { ...loadSettings(db, clubId(db)).display, title: 'Парк' } }));
  applySettings(db, clock.now(), { ...base, version: 4, business: { type: 'billiards' } } as ClubSnapshot);
  assert.equal(loadSettings(db, clubId(db)).business.type, 'billiards');
  assert.equal(loadSettings(db, clubId(db)).display.title, 'Парк');
});

test('a freshly connected HUB takes the business type from the access package (the cloud may stay at settings version 0)', async (t) => {
  const { db, clock } = await startHub(t, { demo: false });
  const fetchFake: typeof fetch = async (input) => {
    const url = String(input);
    assert.ok(url.includes('/sync/access'), url);
    return new Response(
      JSON.stringify({ version: 1, license: null, clubId: 'cloud-club', people: [], keys: [], business: { type: 'cafe' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const events = new HubEvents();
  const changed: string[] = [];
  events.on('changed', (e) => changed.push(e.kind));
  const worker = new SyncWorker({ db, clock, events, url: 'http://cloud.test', apiKey: 'k'.repeat(43), hubId: 'hub-1', fetch: fetchFake });
  await worker.pullAccess();
  assert.equal(loadSettings(db, clubId(db)).business.type, 'cafe');
  assert.ok(changed.includes('club'), 'screens hear about the switch');
  assert.equal(all(db, "SELECT id FROM audit_log WHERE action = 'cloud.business_applied'").length, 1);
  // The same type again (every pull, or an unchanged settings answer) writes nothing; garbage is ignored.
  assert.equal(applyBusinessType(db, clock.now(), { changed: false, version: 0, business: { type: 'cafe' } }), false);
  assert.equal(applyBusinessType(db, clock.now(), { business: null }), false);
  assert.equal(applyBusinessType(db, clock.now(), { business: { type: 'casino' } }), false);
  assert.equal(all(db, "SELECT id FROM audit_log WHERE action = 'cloud.business_applied'").length, 1);
  assert.equal(applyBusinessType(db, clock.now(), { changed: false, version: 0, business: { type: 'billiards' } }), true);
  assert.equal(loadSettings(db, clubId(db)).business.type, 'billiards');
});
