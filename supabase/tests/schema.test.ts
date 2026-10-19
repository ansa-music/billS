import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createSupabaseDb, readMigration } from './harness.ts';

const CLOUD_MIGRATIONS = new URL('../../apps/cloud/src/migrations/', import.meta.url);

test('the Supabase schema is the cloud migrations, verbatim and in order', () => {
  // Line endings are normalized: a Windows checkout (core.autocrlf) turns both files into CRLF.
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  // 001–003 are the base migration; every later one has its own Supabase migration (plus RLS).
  const base = lf(readMigration('20261020000000_cloud_schema.sql'));
  const later: Record<string, string> = { '004_roles_license.sql': '20261021000000_roles_license.sql' };
  const order: string[] = [];
  for (const f of readdirSync(CLOUD_MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = lf(readFileSync(new URL(f, CLOUD_MIGRATIONS), 'utf8'));
    const target = later[f];
    const text = target ? lf(readMigration(target)) : base;
    assert.ok(text.includes(`-- ===== apps/cloud/src/migrations/${f} =====\n${sql}`), `${f} is not copied verbatim into ${target ?? 'the base migration'}`);
    order.push(target ?? '20261020000000_cloud_schema.sql');
  }
  assert.deepEqual(order, [...order].sort(), 'cloud migrations must map to Supabase migrations in the same order');
});

test('all Supabase migrations apply on PostgreSQL with Supabase stubs', async () => {
  const s = await createSupabaseDb();
  try {
    const tables = await s.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'");
    assert.ok(tables[0]!.n >= 15);
    const uid = await s.createAuthUser('owner@example.com');
    const seen = await s.asUser(uid, async (tx) => (await tx.query<{ u: string }>('SELECT auth.uid()::text AS u')).rows[0]!.u);
    assert.equal(seen, uid);
  } finally {
    await s.close();
  }
});

test('ts_ping: the keep-alive call works for anon and reveals nothing', async () => {
  const s = await createSupabaseDb();
  try {
    const r = await s.pg.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE anon');
      return (await tx.query<{ ok: boolean }>('SELECT public.ts_ping() AS ok')).rows[0]!.ok;
    });
    assert.equal(r, true);
  } finally {
    await s.close();
  }
});
