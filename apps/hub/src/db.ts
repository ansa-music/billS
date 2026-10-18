import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;
export type Param = SQLInputValue;

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

export function openDb(path: string, now = Date.now()): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db, now);
  return db;
}

function migrate(db: Db, now: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(all<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((r) => r.version));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      run(db, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', version, file, now);
    });
  }
}

interface TxState {
  depth: number;
  afterCommit: Array<() => void>;
}
const txStates = new WeakMap<Db, TxState>();

function txState(db: Db): TxState {
  let state = txStates.get(db);
  if (!state) {
    state = { depth: 0, afterCommit: [] };
    txStates.set(db, state);
  }
  return state;
}

/**
 * Runs `fn` in a write transaction. Nested calls join the outer transaction.
 * Keep `fn` synchronous: no awaits inside a transaction.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const state = txState(db);
  if (state.depth > 0) {
    state.depth++;
    try {
      return fn();
    } finally {
      state.depth--;
    }
  }
  state.depth = 1;
  let result: T;
  try {
    db.exec('BEGIN IMMEDIATE');
    result = fn();
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    state.afterCommit = [];
    throw err;
  } finally {
    state.depth = 0;
  }
  const callbacks = state.afterCommit;
  state.afterCommit = [];
  for (const cb of callbacks) cb();
  return result;
}

/** Runs `fn` after the current transaction commits (immediately when there is none). */
export function afterCommit(db: Db, fn: () => void): void {
  const state = txState(db);
  if (state.depth > 0) state.afterCommit.push(fn);
  else fn();
}

const statements = new WeakMap<Db, Map<string, StatementSync>>();

function stmt(db: Db, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function one<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return stmt(db, sql).get(...params) as unknown as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return stmt(db, sql).all(...params) as unknown as T[];
}

export function run(db: Db, sql: string, ...params: Param[]): number {
  return Number(stmt(db, sql).run(...params).changes);
}
