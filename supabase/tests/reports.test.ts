/**
 * The owner report RPCs of 20261020000100_owner_access.sql must return exactly what
 * apps/cloud's TypeScript reports return for the same data. The same event stream
 * goes into apps/cloud on SQLite (its own code path) and into the Supabase database
 * (acceptEvents on the harness driver); then, for several instants, every RPC
 * answer called as the owner is compared with reports.ts / push.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PushRule } from '@bills/domain';
import { PUSH_KINDS } from '@bills/domain';
import type { SqlDriver } from '../../apps/cloud/src/db/driver.ts';
import { migrate } from '../../apps/cloud/src/db/migrate.ts';
import { openSqlite } from '../../apps/cloud/src/db/sqlite.ts';
import { localDay } from '../../apps/cloud/src/localtime.ts';
import { DisabledSender, PushDispatcher, saveRules } from '../../apps/cloud/src/push.ts';
import { clubDetails, clubSessions, overview } from '../../apps/cloud/src/reports.ts';
import type { ClubRow } from '../../apps/cloud/src/settings.ts';
import {
  alm,
  CLUB_ALMATY,
  CLUB_EMPTY,
  CLUB_MOSCOW,
  CLUB_OTHER,
  COMPANY_A_CLUBS,
  DAY,
  LAST_SYNC,
  loadFixture,
  MIN,
  OWNER_A,
  OWNER_A2,
  OWNER_B,
  ownerView,
} from './fixtures-cloud.ts';
import type { SupabaseTestDb } from './harness.ts';
import { createSupabaseDb } from './harness.ts';

let sqlite: SqlDriver;
let supa: SupabaseTestDb;
let uidA: string;
let uidA2: string;
let uidB: string;

before(async () => {
  sqlite = openSqlite(':memory:');
  await migrate(sqlite, LAST_SYNC);
  await loadFixture(sqlite);
  supa = await createSupabaseDb();
  await loadFixture(supa.db);
  // Sign-up with a differently cased email still finds the owner.
  uidA = await supa.createAuthUser('Owner.A@Example.com');
  uidA2 = await supa.createAuthUser(OWNER_A2.email);
  uidB = await supa.createAuthUser(OWNER_B.email);
});

after(async () => {
  await sqlite?.close();
  await supa?.close();
});

/** Calls `public.<fn>(args…)` as a signed-in user and returns the jsonb. */
async function rpc<T = unknown>(uid: string, fn: string, args: unknown[] = []): Promise<T> {
  const marks = args.map((_, i) => `$${i + 1}`).join(', ');
  return supa.asUser(uid, async (tx) => (await tx.query<{ r: T }>(`SELECT public.${fn}(${marks}) AS r`, args)).rows[0]!.r);
}

/** JSON as an HTTP client would see it (undefined dropped, numbers as numbers). */
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function clubRow(id: string): Promise<ClubRow> {
  return (await sqlite.all<ClubRow>('SELECT * FROM clubs WHERE id = ?', [id]))[0]!;
}

const NOWS: Array<[string, number]> = [
  ['right after the last sync', LAST_SYNC + MIN],
  ['HUB silent for 10 minutes', LAST_SYNC + 10 * MIN],
  ['after midnight in Almaty', alm(1, 0, 30)],
  ['next month in Almaty, still October in Moscow', alm(20, 0, 10)],
  ['before some of the games started', alm(0, 10)],
  ['six weeks later', LAST_SYNC + 42 * DAY],
];

test('the fixture is rich: games, money, alerts and live games in both time zones', async () => {
  const ov = json(await overview(sqlite, LAST_SYNC + MIN, ownerView(OWNER_A)));
  const almaty = ov.clubs.find((c) => c.id === CLUB_ALMATY.id)!;
  const moscow = ov.clubs.find((c) => c.id === CLUB_MOSCOW.id)!;
  assert.deepEqual(
    ov.clubs.map((c) => c.id),
    COMPANY_A_CLUBS,
  );
  assert.ok(almaty.today.paid.total > 0 && almaty.today.refunded > 0 && almaty.today.cancelledGames === 1);
  assert.equal(almaty.liveGames, 3);
  assert.equal(almaty.hub?.pendingSettings, true);
  assert.ok(almaty.openShift && almaty.lastClosedShift);
  assert.ok(moscow.today.paid.total > 0 && moscow.liveGames === 1);
  assert.equal(ov.clubs.find((c) => c.id === CLUB_EMPTY.id)!.hub, null);
  assert.ok(ov.alerts.length >= 3 && ov.recentShifts.length === 2);
  const details = json(await clubDetails(sqlite, LAST_SYNC + MIN, await clubRow(CLUB_ALMATY.id)));
  assert.ok(details.tables.some((t) => t.id === 't-gone') && details.tables.some((t) => t.id === 't-old'));
  assert.ok(details.outages.length === 2 && details.shifts.length === 2);
});

test('owner_me is the OwnerView of the linked owner', async () => {
  assert.deepEqual(await rpc(uidA, 'owner_me'), ownerView(OWNER_A));
  assert.deepEqual(await rpc(uidA2, 'owner_me'), ownerView(OWNER_A2));
  assert.deepEqual(await rpc(uidB, 'owner_me'), ownerView(OWNER_B));
});

for (const [label, now] of NOWS) {
  test(`owner_overview equals reports.overview — ${label}`, async () => {
    for (const [uid, owner] of [
      [uidA, OWNER_A],
      [uidB, OWNER_B],
    ] as const) {
      const expected = json(await overview(sqlite, now, ownerView(owner)));
      assert.deepEqual(await rpc(uid, 'owner_overview', [now]), expected);
    }
  });

  test(`owner_club equals reports.clubDetails — ${label}`, async () => {
    for (const id of COMPANY_A_CLUBS) {
      const expected = json(await clubDetails(sqlite, now, await clubRow(id)));
      assert.deepEqual(await rpc(uidA, 'owner_club', [id, now]), expected, `club ${id}`);
    }
    const other = json(await clubDetails(sqlite, now, await clubRow(CLUB_OTHER.id)));
    assert.deepEqual(await rpc(uidB, 'owner_club', [CLUB_OTHER.id, now]), other);
  });

  test(`owner_club_sessions equals reports.clubSessions — ${label}`, async () => {
    for (const id of [CLUB_ALMATY.id, CLUB_MOSCOW.id]) {
      const club = await clubRow(id);
      const today = localDay(now, club.timezone);
      assert.deepEqual(await rpc(uidA, 'owner_club_sessions', [id, null, now]), json(await clubSessions(sqlite, club, today)), `${id} today`);
      for (const day of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-09-28', '2026-09-02']) {
        assert.deepEqual(await rpc(uidA, 'owner_club_sessions', [id, day, now]), json(await clubSessions(sqlite, club, day)), `${id} ${day}`);
      }
    }
  });
}

test('company B never shows up for company A', async () => {
  for (const [, now] of NOWS) {
    const text = JSON.stringify([
      await rpc(uidA, 'owner_overview', [now]),
      ...(await Promise.all(COMPANY_A_CLUBS.map((id) => rpc(uidA, 'owner_club', [id, now])))),
    ]);
    for (const leak of [CLUB_OTHER.id, 'o-t1', 'o-al-1', 'o-s1', 'o-g1', 'Чужой', 'Чужая']) {
      assert.ok(!text.includes(leak), `${leak} leaked`);
    }
  }
});

test('owner_club refuses a club of another company and owner_club_sessions a bad day', async () => {
  const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
  await assert.rejects(rpc(uidA, 'owner_club', [CLUB_OTHER.id, LAST_SYNC]), code('P0002'));
  await assert.rejects(rpc(uidA, 'owner_club', ['no-such-club', LAST_SYNC]), code('P0002'));
  await assert.rejects(rpc(uidB, 'owner_club_sessions', [CLUB_ALMATY.id, null, LAST_SYNC]), code('P0002'));
  for (const bad of ['2026-02-30', '12.10.2026', '2026-1-1', '0050-01-01', '']) {
    await assert.rejects(rpc(uidA, 'owner_club_sessions', [CLUB_ALMATY.id, bad, LAST_SYNC]), code('22023'), bad);
  }
});

test('the RPCs use now() when p_now is omitted', async () => {
  const ov = await rpc<{ serverNow: number }>(uidA, 'owner_overview');
  assert.ok(Math.abs(ov.serverNow - Date.now()) < 60_000);
  const details = await rpc<{ club: { id: string } }>(uidA, 'owner_club', [CLUB_MOSCOW.id]);
  assert.equal(details.club.id, CLUB_MOSCOW.id);
  assert.ok(Array.isArray(await rpc(uidA, 'owner_club_sessions', [CLUB_MOSCOW.id])));
});

test('owner_push_settings / owner_set_push_rules equal push.ts settings() / saveRules()', async () => {
  const push = new PushDispatcher(sqlite, new DisabledSender(), () => LAST_SYNC);
  for (const [uid, owner] of [
    [uidA, OWNER_A],
    [uidA2, OWNER_A2],
    [uidB, OWNER_B],
  ] as const) {
    assert.deepEqual(await rpc(uid, 'owner_push_settings'), json(await push.settings(owner.id)), owner.id);
  }
  assert.deepEqual((await rpc<{ kinds: unknown }>(uidA, 'owner_push_settings')).kinds, json(PUSH_KINDS));

  const rules: PushRule[] = [
    { kind: 'POWER_ON_BATTERY', clubId: null, enabled: false },
    { kind: 'UPS_UNREACHABLE', clubId: CLUB_MOSCOW.id, enabled: true },
    { kind: 'UPS_UNREACHABLE', clubId: CLUB_ALMATY.id, enabled: true },
    { kind: 'HUB_OFFLINE', clubId: CLUB_ALMATY.id, enabled: false },
    { kind: 'POWER_ON_BATTERY', clubId: null, enabled: true }, // duplicate: the first one wins
    { kind: 'LAMP_FAILED', clubId: null, enabled: true },
  ];
  await saveRules(sqlite, OWNER_A.id, rules);
  const expected = json(await push.settings(OWNER_A.id));
  assert.deepEqual(await rpc(uidA, 'owner_set_push_rules', [JSON.stringify(rules)]), expected);
  assert.deepEqual(await rpc(uidA, 'owner_push_settings'), expected);
  assert.deepEqual(await rpc(uidA, 'owner_set_push_rules', [JSON.stringify({ rules })]), expected);
  // The co-owner's rules are their own.
  assert.deepEqual(await rpc(uidA2, 'owner_push_settings'), json(await push.settings(OWNER_A2.id)));

  const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
  await assert.rejects(rpc(uidA, 'owner_set_push_rules', [JSON.stringify([{ kind: 'NOPE', clubId: null, enabled: true }])]), code('22023'));
  await assert.rejects(
    rpc(uidA, 'owner_set_push_rules', [JSON.stringify([{ kind: 'OTHER', clubId: CLUB_OTHER.id, enabled: true }])]),
    code('P0002'),
  );
  await assert.rejects(rpc(uidA, 'owner_set_push_rules', [JSON.stringify([{ kind: 'OTHER', enabled: 'yes' }])]), code('22023'));
  await assert.rejects(rpc(uidA, 'owner_set_push_rules', [JSON.stringify('rules')]), code('22023'));
  // A refused call changed nothing.
  assert.deepEqual(await rpc(uidA, 'owner_push_settings'), expected);

  // pushEnabled follows the flag the Edge sender writes.
  await supa.db.run("INSERT INTO ts_runtime (key, value, updated_at) VALUES ('push_configured', '1', ?)", [LAST_SYNC]);
  assert.deepEqual(await rpc(uidA, 'owner_push_settings'), { ...expected, pushEnabled: true });
  await supa.db.run("UPDATE ts_runtime SET value = '0' WHERE key = 'push_configured'");
  assert.equal((await rpc<{ pushEnabled: boolean }>(uidA, 'owner_push_settings')).pushEnabled, false);
});
