import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogView, ClubSnapshot, LoginResponse, RosterResponse } from '@bills/domain';
import { isWeakShortKey } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import { one, openDb } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { setupTrialClub, trialKey } from '../src/trial.ts';
import { FAST_LAMPS, MONDAY_NOON } from './helpers.ts';

type T = { after: (fn: () => unknown) => void };

/** An empty database and a HUB built like the browser trial (apps/web demo-hub/boot.ts). */
async function startHub(t: T) {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  const app = buildApp(hub, {});
  await app.ready();
  await hub.license.init();
  t.after(async () => {
    await app.close();
    hub.close();
    db.close();
  });
  return { clock, db, hub, app };
}

test('trialKey: six digits, never a weak key', () => {
  for (let i = 0; i < 200; i++) {
    const key = trialKey();
    assert.match(key, /^\d{6}$/);
    assert.ok(!isWeakShortKey(key), key);
  }
  // A random source that first gives 000000 has to try again.
  let n = 0;
  const seq = [0, 0, 0, 0, 0, 0, 0.41, 0.82, 0.29, 0.13, 0.95, 0.67];
  assert.equal(trialKey(() => seq[n++ % seq.length]!), '482196');
});

test('trial: the coffee shop named on the welcome screen, its manager signs in with the six digits', async (t) => {
  const { hub, app, clock } = await startHub(t);
  const key = '482913';
  assert.equal(setupTrialClub(hub, { venue: '  Кофейня «Утро»  ', managerName: 'Айгерим', key, timezone: 'Asia/Almaty', withMenu: true, now: clock.now() }), true);
  hub.start();

  const club = one<{ name: string; settings: string }>(hub.db, 'SELECT name, settings FROM clubs')!;
  assert.equal(club.name, 'Кофейня «Утро»');
  assert.equal(JSON.parse(club.settings).business.type, 'cafe');
  assert.equal(one<{ name: string }>(hub.db, 'SELECT name FROM companies')!.name, 'Кофейня «Утро»');

  // A manager is not on «Кто на смене?» (that list is for staff): the login screen opens on the keypad.
  const roster = (await app.inject({ method: 'GET', url: '/api/auth/roster' })).json() as RosterResponse;
  assert.deepEqual(roster.people, []);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'Касса' } });
  assert.equal(login.statusCode, 200, login.body);
  const { token } = login.json() as LoginResponse;
  const auth = { authorization: `Bearer ${token}` };

  const catalog = (await app.inject({ method: 'GET', url: '/api/bar/catalog', headers: auth })).json() as CatalogView;
  assert.ok(catalog.products.some((p) => p.name === 'Латте'), 'sample menu is there');
  const state = (await app.inject({ method: 'GET', url: '/api/state', headers: auth })).json() as ClubSnapshot;
  assert.equal(state.tables.length, 0, 'no billiard tables in a coffee shop');

  // Second start of the same database: nothing is created twice.
  assert.equal(setupTrialClub(hub, { venue: 'Другое', managerName: 'X', key: '730514', timezone: 'Asia/Almaty', withMenu: true, now: clock.now() }), false);
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM staff')!.n, 1);
});

test('trial: without the sample menu the catalog stays empty, blank names get defaults', async (t) => {
  const { hub, clock } = await startHub(t);
  setupTrialClub(hub, { venue: ' ', managerName: '', key: '730514', timezone: 'Asia/Almaty', withMenu: false, now: clock.now() });
  assert.equal(one<{ name: string }>(hub.db, 'SELECT name FROM clubs')!.name, 'Моя кофейня');
  assert.equal(one<{ name: string }>(hub.db, 'SELECT name FROM staff')!.name, 'Управляющий');
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM products')!.n, 0);
});
