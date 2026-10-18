import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDriver } from './driver.ts';
import { normalizeParam } from './driver.ts';

/**
 * Serialises access to one synchronous connection. Fastify handles requests
 * concurrently, and a second transaction on the same connection while the
 * first one awaits would corrupt both.
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => held);
    return previous.then(() => release);
  }
}

/** Opens (and creates) a SQLite database file; `:memory:` for tests. */
export function openSqlite(path: string): SqlDriver {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const mutex = new Mutex();
  const statements = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };
  const params = (values: unknown[] | undefined): SQLInputValue[] =>
    (values ?? []).map((v) => normalizeParam(v) as SQLInputValue);

  // Used inside a transaction: the caller already holds the lock.
  const inner: SqlDriver = {
    async all<T>(sql: string, values?: unknown[]): Promise<T[]> {
      // node:sqlite returns null-prototype rows; plain objects compare and serialise like pg rows.
      return (stmt(sql).all(...params(values)) as object[]).map((row) => ({ ...row })) as T[];
    },
    async run(sql: string, values?: unknown[]): Promise<number> {
      return Number(stmt(sql).run(...params(values)).changes);
    },
    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      return fn(inner);
    },
    async close(): Promise<void> {},
  };

  return {
    async all<T>(sql: string, values?: unknown[]): Promise<T[]> {
      const release = await mutex.acquire();
      try {
        return await inner.all<T>(sql, values);
      } finally {
        release();
      }
    },
    async run(sql: string, values?: unknown[]): Promise<number> {
      const release = await mutex.acquire();
      try {
        return await inner.run(sql, values);
      } finally {
        release();
      }
    },
    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      const release = await mutex.acquire();
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(inner);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw err;
        }
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      const release = await mutex.acquire();
      try {
        statements.clear();
        db.close();
      } finally {
        release();
      }
    },
  };
}
