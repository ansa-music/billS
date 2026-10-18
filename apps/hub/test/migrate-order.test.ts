import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { all, openDb } from '../src/db.ts';

/** Hooks run in registration order, so the directory is removed after the database is closed. */
function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'bills-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test('a migration numbered below the newest applied one is refused instead of applied late', (t) => {
  const dir = tempDir(t);
  const migrations = join(dir, 'migrations');
  const migrationsDir = pathToFileURL(`${migrations}/`);
  const dbPath = join(dir, 'club.db');

  // Build A shipped 001 and 003.
  mkdirSync(migrations);
  writeFileSync(join(migrations, '001_init.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  writeFileSync(join(migrations, '003_later.sql'), 'ALTER TABLE a ADD COLUMN added_by_003 INTEGER;');
  openDb(dbPath, 1, { migrationsDir }).close();

  // Build B inserts 002, which rebuilds the table and would drop 003's column.
  writeFileSync(
    join(migrations, '002_rebuild.sql'),
    'CREATE TABLE a2 (id INTEGER PRIMARY KEY); INSERT INTO a2 SELECT id FROM a; DROP TABLE a; ALTER TABLE a2 RENAME TO a;',
  );
  assert.throws(() => openDb(dbPath, 2, { migrationsDir }), /002_rebuild\.sql is older than the newest applied migration \(3\)/);

  // Nothing was applied: the column from 003 is still there.
  rmSync(join(migrations, '002_rebuild.sql'));
  const db = openDb(dbPath, 3, { migrationsDir });
  const columns = all<{ name: string }>(db, 'PRAGMA table_info(a)').map((c) => c.name);
  db.close();
  assert.deepEqual(columns, ['id', 'added_by_003']);
});

test('in-order migrations still apply one by one and only once', (t) => {
  const dir = tempDir(t);
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations);
  const migrationsDir = pathToFileURL(`${migrations}/`);
  writeFileSync(join(migrations, '001_init.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  const dbPath = join(dir, 'club.db');
  openDb(dbPath, 1, { migrationsDir }).close();
  writeFileSync(join(migrations, '002_more.sql'), 'ALTER TABLE a ADD COLUMN b INTEGER;');
  const db = openDb(dbPath, 2, { migrationsDir });
  const versions = all<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map(
    (r) => r.version,
  );
  db.close();
  assert.deepEqual(versions, [1, 2]);
});
