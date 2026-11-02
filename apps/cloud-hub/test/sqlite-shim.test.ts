/**
 * shims/sqlite.ts against a stand-in for Durable Object storage built on node:sqlite, with the rules that
 * matter: no BEGIN/SAVEPOINT in SQL (transactionSync only), no connection pragmas, several statements per
 * exec, blobs as ArrayBuffer. The HUB's own migrate() and transaction() run on it through the same db.ts
 * patch the cloud build applies (scripts/db-adapter.mjs).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync as NodeDb } from 'node:sqlite';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { patchDbSource } from '../scripts/db-adapter.mjs';
import type { SqlCursorLike, SqlStorageLike } from '../src/shims/sqlite.ts';
import { DatabaseSync, provideStorage } from '../src/shims/sqlite.ts';

type Value = ArrayBuffer | string | number | null;

class FakeStorage implements SqlStorageLike {
  readonly db = new NodeDb(':memory:');
  #depth = 0;

  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  readonly sql = {
    exec: (query: string, ...bindings: Value[]): SqlCursorLike => {
      if (/^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) throw new Error('To execute a transaction, please use the state.storage.transactionSync() API');
      if (/^\s*PRAGMA\s+(journal_mode|synchronous|busy_timeout)\b/i.test(query)) throw new Error('not authorized: SQLITE_AUTH');
      const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
      let rows: Array<Record<string, Value>> = [];
      let written = 0;
      // Several statements (a migration file): run them all, no rows back — like the storage's exec.
      if (args.length === 0 && query.trim().replace(/;+$/, '').includes(';')) {
        this.db.exec(query);
      } else {
        const st = this.db.prepare(query);
        if (st.columns().length > 0) {
          rows = (st.all(...(args as never[])) as Array<Record<string, unknown>>).map((r) => {
            for (const k in r) if (r[k] instanceof Uint8Array) r[k] = (r[k] as Uint8Array).slice().buffer;
            return r as Record<string, Value>;
          });
        } else {
          written = Number(st.run(...(args as never[])).changes);
        }
      }
      return {
        rowsRead: rows.length,
        rowsWritten: written,
        toArray: () => rows,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };

  transactionSync<T>(fn: () => T): T {
    const name = `t${++this.#depth}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.#depth--;
    }
  }
}

function open(): { db: DatabaseSync; storage: FakeStorage } {
  const storage = new FakeStorage();
  provideStorage(storage);
  return { db: new DatabaseSync(':memory:'), storage };
}

// The HUB's db.ts, patched exactly like the cloud bundle, loaded from a temp copy.
const dir = mkdtempSync(join(tmpdir(), 'cloud-hub-db-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'db.ts'), patchDbSource(readFileSync(new URL('../../hub/src/db.ts', import.meta.url), 'utf8')));
const hubDb = (await import(pathToFileURL(join(dir, 'db.ts')).href)) as {
  migrate(db: unknown, now: number, dir?: URL): void;
  transaction<T>(db: unknown, fn: () => T): T;
  afterCommit(db: unknown, fn: () => void): void;
  run(db: unknown, sql: string, ...params: unknown[]): number;
  one<T>(db: unknown, sql: string, ...params: unknown[]): T | undefined;
};
const MIGRATIONS = new URL('../../hub/src/migrations/', import.meta.url);

test('the HUB migrations run on Durable Object rules through the shim', () => {
  const { db } = open();
  // openDb()'s connection pragmas: the ones a Durable Object lacks are skipped, foreign keys stay on.
  db.exec('PRAGMA journal_mode = WAL;\n    PRAGMA synchronous = NORMAL;\n    PRAGMA foreign_keys = ON;\n    PRAGMA busy_timeout = 5000;');
  hubDb.migrate(db, 1_000, MIGRATIONS);
  const versions = db.prepare('SELECT count(*) AS n, max(version) AS v FROM schema_migrations').get()!;
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d+_.+\.sql$/.test(f));
  assert.equal(Number(versions.n), files.length);
  assert.ok(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'bar_orders'").get());
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  // A second run applies nothing twice.
  hubDb.migrate(db, 2_000, MIGRATIONS);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, versions.n);
});

test('a HUB transaction rolls back on a throw and runs afterCommit only after commit', () => {
  const { db } = open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  const done: string[] = [];
  assert.throws(() =>
    hubDb.transaction(db, () => {
      hubDb.run(db, 'INSERT INTO t (name) VALUES (?)', 'a');
      hubDb.afterCommit(db, () => done.push('lost'));
      hubDb.transaction(db, () => hubDb.run(db, 'INSERT INTO t (name) VALUES (?)', 'b'));
      throw new Error('boom');
    }),
  );
  assert.equal(hubDb.one<{ n: number }>(db, 'SELECT count(*) AS n FROM t')?.n, 0);
  assert.deepEqual(done, []);
  assert.equal(db.isTransaction, false);
  hubDb.transaction(db, () => {
    hubDb.run(db, 'INSERT INTO t (name) VALUES (?)', 'c');
    hubDb.afterCommit(db, () => done.push('after'));
    assert.equal(db.isTransaction, true);
  });
  assert.deepEqual(done, ['after']);
  assert.equal(hubDb.one<{ n: number }>(db, 'SELECT count(*) AS n FROM t')?.n, 1);
});

test('statements behave like node:sqlite: changes, last id, errors, values', () => {
  const { db } = open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, flag INTEGER, data BLOB)');
  const ins = db.prepare('INSERT INTO t (name, flag, data) VALUES (?, ?, ?)');
  const r1 = ins.run('a', true, new Uint8Array([1, 2, 3]));
  assert.deepEqual(r1, { changes: 1, lastInsertRowid: 1 });
  assert.equal(ins.run('b', 10n, null).lastInsertRowid, 2);
  assert.equal(db.prepare('UPDATE t SET flag = 0 WHERE id > ?').run(0).changes, 2);
  assert.equal(db.prepare('UPDATE t SET flag = 0 WHERE id = ?').run(99).changes, 0);
  const row = db.prepare('SELECT * FROM t WHERE name = ?').get('a')!;
  assert.ok(row.data instanceof Uint8Array);
  assert.deepEqual([...(row.data as Uint8Array)], [1, 2, 3]);
  assert.equal(db.prepare('SELECT * FROM t WHERE name = ?').get('zzz'), undefined);
  assert.equal(db.prepare('SELECT name FROM t ORDER BY id').all().length, 2);
  // settings.ts tells a duplicate name by code + message.
  assert.throws(() => ins.run('a', 0, null), (e: Error & { code?: string }) => e.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(e.message));
  assert.throws(() => db.prepare('SELECT ?').get(undefined), (e: Error & { code?: string }) => e.code === 'ERR_INVALID_ARG_TYPE');
  assert.throws(() => db.prepare('SELECT :x').get({ x: 1 }), /Named SQL parameters/);
});

test('BEGIN in SQL is refused with a pointer to the adapter', () => {
  const { db } = open();
  assert.throws(() => db.exec('BEGIN IMMEDIATE'), /transactionSync/);
});

test('every statement adds what it read and wrote to the stats', () => {
  const { db } = open();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const before = { ...db.stats };
  db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
  db.prepare('SELECT * FROM t').all();
  assert.equal(db.stats.rowsWritten - before.rowsWritten, 1);
  assert.equal(db.stats.rowsRead - before.rowsRead, 2); // the row + SELECT changes()
  assert.equal(db.stats.statements - before.statements, 3);
});
