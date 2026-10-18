import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMigrations, migrate, splitStatements } from '../src/db/migrate.ts';
import type { PgClientLike, PgPoolLike, PgQueryResult } from '../src/db/postgres.ts';
import { createPostgresDriver, toPositional } from '../src/db/postgres.ts';

interface Recorded {
  via: 'pool' | 'client';
  text: string;
  values: unknown[] | undefined;
}

/** A `pg.Pool` stand-in that records every query and answers with canned rows. */
function fakePool(answer: (text: string) => PgQueryResult = () => ({ rows: [], rowCount: 0 })) {
  const log: Recorded[] = [];
  const released: Array<Error | boolean | undefined> = [];
  let clientsOut = 0;
  const pool: PgPoolLike = {
    async query(text, values) {
      log.push({ via: 'pool', text, values });
      return answer(text);
    },
    async connect() {
      clientsOut++;
      const client: PgClientLike = {
        async query(text, values) {
          log.push({ via: 'client', text, values });
          if (text.startsWith('FAIL')) throw new Error('boom');
          return answer(text);
        },
        release(err) {
          clientsOut--;
          released.push(err);
        },
      };
      return client;
    },
  };
  return { pool, log, released, clients: () => clientsOut };
}

test('? placeholders become $1..$n, string literals are left alone', () => {
  assert.equal(toPositional('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(toPositional("SELECT '?' AS q, ? AS p FROM t WHERE s = 'it''s ?' AND x = ?"), "SELECT '?' AS q, $1 AS p FROM t WHERE s = 'it''s ?' AND x = $2");
  assert.equal(toPositional('SELECT 1'), 'SELECT 1');
});

test('all/run go through the pool; booleans become 0/1, undefined becomes NULL', async () => {
  const f = fakePool((text) => (text.startsWith('SELECT') ? { rows: [{ id: 'a' }], rowCount: 1 } : { rows: [], rowCount: 2 }));
  const db = createPostgresDriver(f.pool);
  const rows = await db.all<{ id: string }>('SELECT id FROM hubs WHERE club_id = ? AND is_active = ?', ['c1', true]);
  assert.deepEqual(rows, [{ id: 'a' }]);
  const changes = await db.run('UPDATE hubs SET last_seen_at = ? WHERE id = ?', [undefined, 'h1']);
  assert.equal(changes, 2);
  assert.deepEqual(f.log, [
    { via: 'pool', text: 'SELECT id FROM hubs WHERE club_id = $1 AND is_active = $2', values: ['c1', 1] },
    { via: 'pool', text: 'UPDATE hubs SET last_seen_at = $1 WHERE id = $2', values: [null, 'h1'] },
  ]);
});

test('a transaction runs BEGIN/COMMIT on one dedicated client and releases it', async () => {
  const f = fakePool();
  const db = createPostgresDriver(f.pool);
  const result = await db.transaction(async (tx) => {
    await tx.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', ['c', 'n', 1]);
    // nested transaction joins the outer one: no second BEGIN
    await tx.transaction(async (inner) => inner.run('UPDATE companies SET name = ? WHERE id = ?', ['m', 'c']));
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(
    f.log.map((r) => `${r.via}:${r.text}`),
    [
      'client:BEGIN',
      'client:INSERT INTO companies (id, name, created_at) VALUES ($1, $2, $3)',
      'client:UPDATE companies SET name = $1 WHERE id = $2',
      'client:COMMIT',
    ],
  );
  assert.deepEqual(f.released, [undefined]);
  assert.equal(f.clients(), 0);
});

test('a failing transaction rolls back and still releases the client', async () => {
  const f = fakePool();
  const db = createPostgresDriver(f.pool);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('FAIL please');
    }),
    /boom/,
  );
  assert.deepEqual(
    f.log.map((r) => r.text),
    ['BEGIN', 'FAIL please', 'ROLLBACK'],
  );
  assert.equal(f.released.length, 1);
  assert.equal(f.clients(), 0);
});

test('migrations are portable SQL and migrate() applies every CREATE through the fake client', async () => {
  const forbidden = /\b(AUTOINCREMENT|SERIAL|PRAGMA|WITHOUT ROWID|ILIKE|datetime\(|now\()|::/i;
  const migrations = listMigrations();
  assert.ok(migrations.length >= 1);
  for (const m of migrations) {
    assert.doesNotMatch(m.sql, forbidden, m.file);
    for (const s of splitStatements(m.sql)) assert.match(s, /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /, `${m.file}: ${s.slice(0, 40)}`);
  }

  const f = fakePool();
  const db = createPostgresDriver(f.pool);
  const applied = await migrate(db, 123);
  assert.deepEqual(applied, migrations.map((m) => m.file));

  const texts = f.log.map((r) => r.text);
  assert.equal(texts[0], 'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
  assert.equal(texts[1], 'SELECT version FROM schema_migrations');
  const creates = f.log.filter((r) => r.via === 'client' && r.text.startsWith('CREATE'));
  const expected = migrations.flatMap((m) => splitStatements(m.sql));
  assert.equal(creates.length, expected.length);
  for (const table of ['companies', 'clubs', 'owners', 'owner_sessions', 'hubs', 'club_settings', 'events', 'sessions', 'alerts', 'daily_stats']) {
    assert.ok(creates.some((r) => r.text.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)), table);
  }
  const inserts = f.log.filter((r) => r.text.startsWith('INSERT INTO schema_migrations'));
  assert.equal(inserts.length, migrations.length);
  assert.deepEqual(inserts[0]?.values, [1, '001_init.sql', 123]);
  assert.equal(texts.filter((x) => x === 'BEGIN').length, migrations.length);
  assert.equal(texts.filter((x) => x === 'COMMIT').length, migrations.length);
  assert.equal(f.clients(), 0);
});
