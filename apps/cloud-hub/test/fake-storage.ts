/**
 * A stand-in for a Durable Object's SQLite storage on node:sqlite, with the rules that matter: no BEGIN or
 * SAVEPOINT in SQL (transactionSync only, nested ones allowed), no connection pragmas, several statements per
 * exec, blobs as ArrayBuffer, rows read and written counted.
 */
import { DatabaseSync as NodeDb } from 'node:sqlite';
import type { SqlCursorLike, SqlStorageLike } from '../src/shims/sqlite.ts';

export type Value = ArrayBuffer | string | number | null;

export class FakeStorage implements SqlStorageLike {
  readonly db = new NodeDb(':memory:');
  #depth = 0;
  /** Prepared statements by their text, as a Durable Object's storage caches them. */
  readonly #cache = new Map<string, ReturnType<NodeDb['prepare']>>();

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
        let st = this.#cache.get(query);
        if (!st) {
          st = this.db.prepare(query);
          // DDL changes the schema: statements prepared before it would be re-prepared by SQLite anyway.
          if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(query)) this.#cache.set(query, st);
        }
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
