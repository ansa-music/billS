/**
 * Updating the HUB must never lose a running game: the new version applies its
 * migrations to the old database, then `recover` picks the games up again.
 * These tests take the current migrations as the "old schema" and add fresh
 * ones on top, the way a future release will.
 */
import { test } from 'node:test';
import { createHash } from 'node:crypto';
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

test('013: old single roles become role sets, keys and sessions survive the staff rebuild', async (t) => {
  const h = harness(t);
  // The database as the previous release left it: migrations up to 012 only.
  const oldDir = join(h.dir, 'migrations-012');
  mkdirSync(oldDir);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (Number.parseInt(f, 10) <= 12) copyFileSync(new URL(f, MIGRATIONS_DIR), join(oldDir, f));
  const old = openDb(h.dbPath, h.clock.now(), { migrationsDir: pathToFileURL(oldDir + '/') });
  const now = h.clock.now();
  old.prepare("INSERT INTO companies (id, name, created_at) VALUES ('co', 'Старая компания', ?)").run(now);
  old.prepare("INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES ('club', 'co', 'Старый клуб', 'Asia/Almaty', 'KZT', ?)").run(now);
  const people = [
    ['s-super', 'Платформа', 'superadmin'],
    ['s-owner', 'Владелец', 'owner'],
    ['s-manager', 'Управляющий', 'manager'],
    ['s-cashier', 'Кассир', 'cashier'],
    ['s-waiter', 'Официант', 'waiter'],
  ];
  for (const [id, name, role] of people) {
    old.prepare("INSERT INTO staff (id, club_id, name, role, pin_hash, is_active, table_ids, created_at, updated_at) VALUES (?, 'club', ?, ?, NULL, 1, '[]', ?, ?)").run(id!, name!, role!, now, now);
  }
  const ownerKey = 'OWNER-ABCD-EFGH-JKMN-PQRS';
  old
    .prepare("INSERT INTO access_keys (id, club_id, staff_id, key_hash, prefix, created_at, created_by) VALUES ('k1', 'club', 's-owner', ?, 'OWNER-ABCD', ?, 'system')")
    .run(createHash('sha256').update(ownerKey).digest('hex'), now);
  old
    .prepare("INSERT INTO auth_sessions (token_hash, staff_id, key_id, created_at, last_seen_at, expires_at) VALUES ('tok', 's-owner', 'k1', ?, ?, ?)")
    .run(now, now, now + HOUR);
  old.close();

  const hub = await h.start(undefined, { secure: true });
  const rows = all<{ id: string; role: string; roles: string; scope: string; origin: string }>(
    hub.db,
    'SELECT id, role, roles, scope, origin FROM staff ORDER BY id',
  ).map((r) => ({ ...r, roles: JSON.parse(r.roles) as string[] }));
  assert.deepEqual(rows, [
    { id: 's-cashier', role: 'cashier', roles: ['cashier'], scope: 'club', origin: 'hub' },
    { id: 's-manager', role: 'admin', roles: ['admin', 'senior'], scope: 'club', origin: 'hub' },
    { id: 's-owner', role: 'manager', roles: ['manager'], scope: 'company', origin: 'hub' },
    { id: 's-super', role: 'tech', roles: ['tech'], scope: 'platform', origin: 'hub' },
    { id: 's-waiter', role: 'waiter', roles: ['waiter'], scope: 'club', origin: 'hub' },
  ]);
  const key = all<{ kind: string; origin: string }>(hub.db, "SELECT kind, origin FROM access_keys WHERE id = 'k1'")[0];
  assert.deepEqual({ ...key }, { kind: 'long', origin: 'hub' });
  assert.equal(all(hub.db, "SELECT token_hash FROM auth_sessions WHERE token_hash = 'tok'").length, 1);
  assert.deepEqual(all(hub.db, 'PRAGMA foreign_key_check'), []);
  // The FK to staff still holds after the rename.
  assert.throws(() => hub.db.prepare("INSERT INTO access_keys (id, club_id, staff_id, kind, key_hash, prefix, created_at, created_by) VALUES ('x', 'club', 'nobody', 'long', 'h', 'p', 0, 's')").run(), /FOREIGN KEY/);

  // The old owner's key still logs in — now as the client's manager.
  const login = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: ownerKey } });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.json().staff.roles, ['manager']);
});
