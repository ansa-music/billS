/**
 * Updating the HUB must never lose a running game: the new version applies its
 * migrations to the old database, then `recover` picks the games up again.
 * These tests take the current migrations as the "old schema" and add fresh
 * ones on top, the way a future release will.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { all, MIGRATIONS_DIR, openDb } from '../src/db.ts';
import { auditActions, Harness, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

/** A copy of the shipped migrations the test can add files to. */
function migrationsCopy(h: Harness): { dir: string; url: URL } {
  const dir = join(h.dir, 'migrations');
  mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(new URL(f, MIGRATIONS_DIR), join(dir, f));
  return { dir, url: pathToFileURL(dir + '/') };
}

function appliedVersions(dbPath: string): number[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(
      (r) => r.version,
    );
  } finally {
    db.close();
  }
}

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

test('old database + new migration = running games are still there after the update', async (t) => {
  const h = harness(t);
  const migrations = migrationsCopy(h);
  h.migrationsDir = migrations.url;

  // Old version: a game is running when the operator stops the HUB for an update.
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(20 * 60 * 1000);
  const unpaid = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  await waitFor(() => sessionStatus(hub, unpaid.body.id) === 'ACTIVE');
  await post(hub, `/api/sessions/${unpaid.body.id}/stop`);
  const versionsBefore = appliedVersions(h.dbPath);
  await h.crash();

  // New version ships two more migrations: a column with a default and a new table.
  writeFileSync(
    join(migrations.dir, '900_guest_notes.sql'),
    `ALTER TABLE table_sessions ADD COLUMN guest_note TEXT;
     CREATE TABLE reservations (
       id TEXT PRIMARY KEY,
       table_id TEXT NOT NULL REFERENCES billiard_tables(id),
       starts_at INTEGER NOT NULL
     );
     CREATE INDEX ix_reservations_table ON reservations (table_id, starts_at);`,
  );
  writeFileSync(
    join(migrations.dir, '901_alert_priority.sql'),
    `ALTER TABLE alerts ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
     UPDATE alerts SET priority = 1 WHERE kind LIKE 'LAMP_%';`,
  );

  const updated = await h.start();
  assert.deepEqual(appliedVersions(h.dbPath), [...versionsBefore, 900, 901]);

  // The game is still running, counts from its real start and its lamp is on.
  await waitFor(() => tableState(updated, 'Стол 1').lamp.reported === 'ON');
  const table = tableState(updated, 'Стол 1');
  assert.equal(table.session?.id, opened.body.id);
  assert.equal(table.session?.status, 'ACTIVE');
  h.clock.advance(HOUR - 20 * 60 * 1000);
  assert.equal(tableState(updated, 'Стол 1').session?.amount, 2000_00);
  assert.ok(auditActions(updated).includes('hub.recovered'));

  // The unpaid bill survived too, and the new column is usable.
  assert.deepEqual(updated.hub.state().unpaid.map((s) => s.id), [unpaid.body.id]);
  const note = all<{ guest_note: string | null }>(updated.db, 'SELECT guest_note FROM table_sessions WHERE id = ?', opened.body.id)[0];
  assert.equal(note?.guest_note, null);

  // Stopping the recovered game works as before the update.
  const stopped = await post(updated, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.billedSeconds, 3600);
  assert.equal(stopped.body.amount, 2000_00);
});

test('migrations are idempotent: restarting applies nothing twice', async (t) => {
  const h = harness(t);
  const migrations = migrationsCopy(h);
  h.migrationsDir = migrations.url;
  writeFileSync(join(migrations.dir, '900_once.sql'), 'CREATE TABLE once_only (id INTEGER PRIMARY KEY);');

  const first = await h.start();
  const opened = await post(first, `/api/tables/${tableId(first, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(first, opened.body.id) === 'ACTIVE');
  await h.crash();

  // Three more restarts, like a flapping power supply: the CREATE TABLE would fail if it ran again.
  for (let i = 0; i < 3; i++) {
    const again = await h.start();
    assert.equal(sessionStatus(again, opened.body.id), 'ACTIVE');
    await h.crash();
  }
  const versions = appliedVersions(h.dbPath);
  assert.equal(versions.filter((v) => v === 900).length, 1);
  assert.equal(new Set(versions).size, versions.length);
});

test('a failing migration is rolled back whole and the old data stays usable', async (t) => {
  const h = harness(t);
  const migrations = migrationsCopy(h);
  h.migrationsDir = migrations.url;

  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const versionsBefore = appliedVersions(h.dbPath);
  await h.crash();

  // The first statement succeeds, the second is broken: nothing of the file may stick.
  const broken = join(migrations.dir, '900_broken.sql');
  writeFileSync(
    broken,
    `CREATE TABLE half_done (id INTEGER PRIMARY KEY);
     ALTER TABLE table_sessions ADD COLUMN broken_column TEXT;
     INSERT INTO no_such_table VALUES (1);`,
  );
  assert.throws(() => openDb(h.dbPath, h.clock.now(), { migrationsDir: migrations.url }), /no such table/);
  assert.deepEqual(appliedVersions(h.dbPath), versionsBefore);

  const inspect = new DatabaseSync(h.dbPath, { readOnly: true });
  try {
    const half = inspect.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get() as { n: number };
    assert.equal(half.n, 0);
    const columns = (inspect.prepare('PRAGMA table_info(table_sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!columns.includes('broken_column'));
  } finally {
    inspect.close();
  }

  // The previous release (without the broken file) starts and the game is still running.
  rmSync(broken);
  const rolledBack = await h.start();
  assert.equal(sessionStatus(rolledBack, opened.body.id), 'ACTIVE');
  await waitFor(() => tableState(rolledBack, 'Стол 1').lamp.reported === 'ON');
});
