/**
 * Row level security and privileges of 20261020000100_owner_access.sql: an owner
 * signed in through Supabase Auth sees only the rows of their company, never the
 * raw journal, sessions, push queue or key hashes, and can write only their own
 * phones and notification rules; anon and unlinked users see nothing.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '@electric-sql/pglite';
import {
  CLUB_ALMATY,
  CLUB_OTHER,
  COMPANY_A,
  COMPANY_A_CLUBS,
  LAST_SYNC,
  loadFixture,
  OWNER_A,
  OWNER_A2,
  OWNER_B,
} from './fixtures-cloud.ts';
import type { SupabaseTestDb } from './harness.ts';
import { createSupabaseDb } from './harness.ts';

let s: SupabaseTestDb;
let uidA: string;
let uidB: string;
let uidStranger: string;

before(async () => {
  s = await createSupabaseDb();
  await loadFixture(s.db);
  uidA = await s.createAuthUser('OWNER.A@example.com');
  uidB = await s.createAuthUser(OWNER_B.email);
  uidStranger = await s.createAuthUser('stranger@example.com');
});

after(async () => {
  await s?.close();
});

const denied = (e: unknown) => (e as { code?: string }).code === '42501';

async function rows<T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return s.asUser(uid, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function asAnon<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return s.pg.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE anon');
    return fn(tx);
  });
}

/** Tables the owner reads, and how a row of company A is recognised. */
const COMPANY_TABLES: Record<string, { cols: string; mine: (r: Record<string, unknown>) => boolean; where: string }> = {
  companies: { cols: 'id', mine: (r) => r.id === COMPANY_A.id, where: `id = '${COMPANY_A.id}'` },
  clubs: { cols: 'id, company_id', mine: (r) => r.company_id === COMPANY_A.id, where: `company_id = '${COMPANY_A.id}'` },
  owners: { cols: 'id', mine: (r) => r.id === OWNER_A.id, where: `id = '${OWNER_A.id}'` },
  owner_devices: { cols: 'id, owner_id', mine: (r) => r.owner_id === OWNER_A.id, where: `owner_id = '${OWNER_A.id}'` },
  push_rules: { cols: 'owner_id, kind', mine: (r) => r.owner_id === OWNER_A.id, where: `owner_id = '${OWNER_A.id}'` },
  owner_keys: { cols: 'id, owner_id', mine: (r) => r.owner_id === OWNER_A.id, where: `owner_id = '${OWNER_A.id}'` },
};
const clubScoped = (cols = 'club_id') => ({
  cols,
  mine: (r: Record<string, unknown>) => COMPANY_A_CLUBS.includes(r.club_id as string),
  where: `club_id IN (${COMPANY_A_CLUBS.map((c) => `'${c}'`).join(', ')})`,
});
for (const t of ['club_settings', 'sessions', 'checks', 'payments', 'shifts', 'cash_movements', 'power_outages', 'alerts', 'daily_stats']) {
  COMPANY_TABLES[t] = clubScoped();
}
COMPANY_TABLES.hubs = clubScoped('id, club_id, name, last_seen_at, settings_version');

const HIDDEN_TABLES = ['events', 'owner_sessions', 'push_queue', 'ts_runtime'];

test('signing up links the owner by lower(email); current_owner_id / my_company_id follow auth.uid()', async () => {
  const linked = await s.db.all<{ id: string; auth_user_id: string | null }>('SELECT id, auth_user_id FROM owners ORDER BY id');
  assert.deepEqual(
    linked.map((r) => [r.id, r.auth_user_id]),
    [
      [OWNER_A.id, uidA],
      [OWNER_A2.id, null],
      [OWNER_B.id, uidB],
    ],
  );
  const [me] = await rows<{ o: string; c: string }>(uidA, 'SELECT public.current_owner_id() AS o, public.my_company_id() AS c');
  assert.deepEqual(me, { o: OWNER_A.id, c: COMPANY_A.id });
  const [none] = await rows<{ o: string | null; c: string | null }>(uidStranger, 'SELECT public.current_owner_id() AS o, public.my_company_id() AS c');
  assert.deepEqual(none, { o: null, c: null });
});

test('an owner created after the auth user is linked at insert; deleting the auth user unlinks', async () => {
  const uid = await s.createAuthUser('late@example.com');
  await s.db.run("INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES ('owner-late', ?, 'Late@Example.com', 'Поздний', '-', 1)", [
    COMPANY_A.id,
  ]);
  assert.equal((await s.db.all<{ u: string }>("SELECT auth_user_id AS u FROM owners WHERE id = 'owner-late'"))[0]!.u, uid);
  await s.db.run('DELETE FROM auth.users WHERE id = ?', [uid]);
  assert.equal((await s.db.all<{ u: string | null }>("SELECT auth_user_id AS u FROM owners WHERE id = 'owner-late'"))[0]!.u, null);
  await s.db.run("DELETE FROM owners WHERE id = 'owner-late'");
});

test('with email confirmation, only a confirmed email links the owner', async () => {
  const t = await createSupabaseDb();
  try {
    await t.pg.exec('ALTER TABLE auth.users ADD COLUMN email_confirmed_at timestamptz');
    await loadFixture(t.db);
    const uid = await t.createAuthUser(OWNER_A2.email);
    const link = async () => (await t.db.all<{ u: string | null }>('SELECT auth_user_id AS u FROM owners WHERE id = ?', [OWNER_A2.id]))[0]!.u;
    assert.equal(await link(), null);
    await t.db.run('UPDATE auth.users SET email_confirmed_at = now() WHERE id = ?', [uid]);
    assert.equal(await link(), uid);
  } finally {
    await t.close();
  }
});

test('RLS is enabled on every public table', async () => {
  const off = await s.db.all<{ relname: string }>(
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity",
  );
  assert.deepEqual(off, []);
});

test('an owner reads exactly the rows of their company in every table', async () => {
  for (const [table, spec] of Object.entries(COMPANY_TABLES)) {
    const seen = await rows(uidA, `SELECT ${spec.cols} FROM public.${table}`);
    const all = await s.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM public.${table} WHERE ${spec.where}`);
    assert.ok(seen.every(spec.mine), `${table}: a foreign row is visible`);
    assert.equal(seen.length, all[0]!.n, `${table}: own rows missing`);
    assert.ok(seen.length > 0, `${table}: the fixture has no own rows`);
  }
  // Company B sees only its own club.
  const clubsB = await rows<{ id: string }>(uidB, 'SELECT id FROM public.clubs');
  assert.deepEqual(clubsB.map((r) => r.id), [CLUB_OTHER.id]);
});

test('events, owner sessions, the push queue and runtime flags are closed to owners', async () => {
  for (const table of HIDDEN_TABLES) {
    await assert.rejects(rows(uidA, `SELECT * FROM public.${table}`), denied, table);
  }
});

test('roles and licenses: platform, licenses, branch staff and every key table are closed to owners and anon', async () => {
  const tables = ['platform_staff', 'platform_keys', 'platform_sessions', 'licenses', 'club_staff', 'club_keys', 'manager_keys'];
  for (const table of tables) {
    await assert.rejects(rows(uidA, `SELECT * FROM public.${table}`), denied, table);
    const col = table === 'platform_sessions' ? 'token_hash' : 'id';
    await assert.rejects(rows(uidA, `INSERT INTO public.${table} (${col}) VALUES ('x')`), denied, `${table} insert`);
    await assert.rejects(asAnon((tx) => tx.query(`SELECT * FROM public.${table}`)), denied, `anon ${table}`);
  }
  // The new company columns are plain reads of the own company.
  const own = await rows<{ blocked: number; access_version: number }>(uidA, 'SELECT blocked, access_version FROM public.companies');
  assert.equal(own.length, 1);
});

test('key and password hashes are not readable, other columns are', async () => {
  await assert.rejects(rows(uidA, 'SELECT api_key_hash FROM public.hubs'), denied);
  await assert.rejects(rows(uidA, 'SELECT * FROM public.hubs'), denied);
  await assert.rejects(rows(uidA, 'SELECT password_hash FROM public.owners'), denied);
  await assert.rejects(rows(uidA, 'SELECT key_hash FROM public.owner_keys'), denied);
  assert.equal((await rows(uidA, 'SELECT id, name, last_seen_at FROM public.hubs')).length, 2);
  assert.deepEqual(await rows(uidA, 'SELECT id, email, name, company_id FROM public.owners'), [
    { id: OWNER_A.id, email: OWNER_A.email, name: OWNER_A.name, company_id: COMPANY_A.id },
  ]);
});

test('owners cannot change report tables, not even of their own company', async () => {
  for (const sql of [
    `UPDATE public.clubs SET name = 'x' WHERE id = '${CLUB_OTHER.id}'`,
    `UPDATE public.clubs SET name = 'x' WHERE id = '${CLUB_ALMATY.id}'`,
    `DELETE FROM public.alerts`,
    `INSERT INTO public.sessions (id, club_id, table_id, status, opened_by, requested_at, updated_at) VALUES ('x', '${CLUB_ALMATY.id}', 't', 'OPENING', 'x', 1, 1)`,
    `UPDATE public.owners SET company_id = '${COMPANY_A.id}' WHERE id = '${OWNER_B.id}'`,
    `UPDATE public.club_settings SET version = 99`,
  ]) {
    await assert.rejects(rows(uidA, sql), denied, sql);
  }
  assert.equal((await s.db.all<{ name: string }>('SELECT name FROM clubs WHERE id = ?', [CLUB_OTHER.id]))[0]!.name, CLUB_OTHER.name);
});

test('owner devices: own rows can be added, renamed and deleted; foreign rows cannot be touched', async () => {
  await rows(
    uidA,
    `INSERT INTO public.owner_devices (id, owner_id, platform, token, name, created_at, last_seen_at)
     VALUES ('dev-new', '${OWNER_A.id}', 'web', 'tok-new', 'Новый', 1, 1)`,
  );
  await assert.rejects(
    rows(
      uidA,
      `INSERT INTO public.owner_devices (id, owner_id, platform, token, name, created_at, last_seen_at)
       VALUES ('dev-evil', '${OWNER_B.id}', 'web', 'tok-evil', 'x', 1, 1)`,
    ),
    denied,
  );
  assert.equal((await rows(uidA, "UPDATE public.owner_devices SET name = 'Ноутбук' WHERE id = 'dev-new' RETURNING id")).length, 1);
  await assert.rejects(rows(uidA, `UPDATE public.owner_devices SET owner_id = '${OWNER_B.id}' WHERE id = 'dev-new'`), denied);
  // Foreign rows are invisible: update and delete hit nothing.
  assert.equal((await rows(uidA, "UPDATE public.owner_devices SET name = 'x' WHERE id = 'dev-b-1' RETURNING id")).length, 0);
  assert.equal((await rows(uidA, "DELETE FROM public.owner_devices WHERE id IN ('dev-b-1', 'dev-a2-1') RETURNING id")).length, 0);
  // What the cabinet does: from('owner_devices').delete().eq('id', …).
  assert.deepEqual(await rows(uidA, "DELETE FROM public.owner_devices WHERE id = 'dev-new' RETURNING id"), [{ id: 'dev-new' }]);
  const left = await s.db.all<{ id: string }>('SELECT id FROM owner_devices ORDER BY id');
  assert.deepEqual(left.map((r) => r.id), ['dev-a-1', 'dev-a-2', 'dev-a2-1', 'dev-b-1']);
});

test('push rules: own rows for own clubs only', async () => {
  await rows(uidA, `INSERT INTO public.push_rules (owner_id, club_id, kind, enabled) VALUES ('${OWNER_A.id}', '${CLUB_ALMATY.id}', 'OTHER', 1)`);
  await rows(uidA, `INSERT INTO public.push_rules (owner_id, club_id, kind, enabled) VALUES ('${OWNER_A.id}', '', 'OTHER', 0)`);
  await assert.rejects(
    rows(uidA, `INSERT INTO public.push_rules (owner_id, club_id, kind, enabled) VALUES ('${OWNER_A.id}', '${CLUB_OTHER.id}', 'OTHER', 1)`),
    denied,
  );
  await assert.rejects(rows(uidA, `INSERT INTO public.push_rules (owner_id, club_id, kind, enabled) VALUES ('${OWNER_B.id}', '', 'LAMP_FAILED', 1)`), denied);
  assert.equal((await rows(uidA, `DELETE FROM public.push_rules WHERE owner_id = '${OWNER_B.id}' RETURNING kind`)).length, 0);
  // The two rules above plus the two of the fixture.
  assert.equal((await rows(uidA, `DELETE FROM public.push_rules RETURNING kind`)).length, 4);
});

test('an authenticated user without an owner row sees nothing and cannot call the reports', async () => {
  for (const [table, spec] of Object.entries(COMPANY_TABLES)) {
    assert.deepEqual(await rows(uidStranger, `SELECT ${spec.cols} FROM public.${table}`), [], table);
  }
  for (const call of ['owner_me()', 'owner_overview()', `owner_club('${CLUB_ALMATY.id}')`, `owner_club_sessions('${CLUB_ALMATY.id}')`, 'owner_push_settings()', `owner_set_push_rules('[]')`]) {
    await assert.rejects(rows(uidStranger, `SELECT public.${call}`), (e: unknown) => denied(e) && /UNAUTHORIZED/.test(String(e)), call);
  }
  // A request without a user at all (role authenticated, no sub).
  await assert.rejects(rows(null, 'SELECT public.owner_me()'), denied);
});

test('anon sees no table and cannot call any owner function', async () => {
  const tables = await s.db.all<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  for (const { tablename } of tables) {
    await assert.rejects(asAnon((tx) => tx.query(`SELECT 1 FROM public.${tablename} LIMIT 1`)), denied, tablename);
  }
  for (const call of ['owner_me()', 'owner_overview()', `owner_club('${CLUB_ALMATY.id}')`, 'owner_push_settings()', 'current_owner_id()', 'my_company_id()']) {
    await assert.rejects(asAnon((tx) => tx.query(`SELECT public.${call}`)), denied, call);
  }
  await assert.rejects(asAnon((tx) => tx.query('SELECT ts_internal.now_ms()')), denied);
});

test('function privileges: owner RPCs for authenticated only, helpers for nobody', async () => {
  const fns = [
    'current_owner_id()',
    'my_company_id()',
    'owner_me()',
    'owner_overview(bigint)',
    'owner_club(text,bigint)',
    'owner_club_sessions(text,text,bigint)',
    'owner_push_settings()',
    'owner_set_push_rules(jsonb)',
  ];
  for (const f of fns) {
    const [r] = await s.db.all<{ anon: boolean; auth: boolean; pub: boolean }>(
      `SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') AS auth,
              EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                      WHERE p.oid = 'public.${f}'::regprocedure AND a.grantee = 0) AS pub`,
    );
    assert.deepEqual(r, { anon: false, auth: true, pub: false }, f);
  }
  const helpers = await s.db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ts_internal' AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
       AND has_schema_privilege('authenticated', 'ts_internal', 'USAGE')`,
  );
  assert.equal(helpers[0]!.n, 0);
  const [usage] = await s.db.all<{ a: boolean; b: boolean }>(
    "SELECT has_schema_privilege('anon', 'ts_internal', 'USAGE') AS a, has_schema_privilege('authenticated', 'ts_internal', 'USAGE') AS b",
  );
  assert.deepEqual(usage, { a: false, b: false });
});

test('alerts are in the supabase_realtime publication and an owner gets only own new alerts', async () => {
  const pub = await s.db.all<{ tablename: string }>("SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'");
  assert.ok(pub.some((r) => r.tablename === 'alerts'));
  await s.db.run("INSERT INTO alerts (id, club_id, at, kind, message) VALUES ('rt-a', ?, ?, 'OTHER', 'a'), ('rt-b', ?, ?, 'OTHER', 'b')", [
    CLUB_ALMATY.id,
    LAST_SYNC,
    CLUB_OTHER.id,
    LAST_SYNC,
  ]);
  const seen = await rows<{ id: string }>(uidA, "SELECT id FROM public.alerts WHERE id LIKE 'rt-%'");
  assert.deepEqual(seen, [{ id: 'rt-a' }]);
});
