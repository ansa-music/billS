import { PGlite } from '@electric-sql/pglite';
import type { PgClientLike, PgPoolLike, PgQueryResult } from '../src/db/postgres.ts';

/** One PGlite instance is one connection: whoever holds the lock owns it. */
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

/**
 * A `pg.Pool`-shaped wrapper around an in-memory PGlite (real PostgreSQL
 * compiled to WASM). `connect()` hands out the single connection exclusively
 * until `release()`, so a transaction never interleaves with other queries.
 * BIGINT and NUMERIC are parsed to numbers, as `main.ts` does for `pg`.
 */
export async function createPglitePool(): Promise<PgPoolLike> {
  const pg = await PGlite.create({ parsers: { 20: Number, 1700: Number } });
  const mutex = new Mutex();

  const exec = async (text: string, values?: unknown[]): Promise<PgQueryResult> => {
    const result = await pg.query<Record<string, unknown>>(text, values ?? []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  return {
    async query(text, values) {
      const release = await mutex.acquire();
      try {
        return await exec(text, values);
      } finally {
        release();
      }
    },
    async connect(): Promise<PgClientLike> {
      const release = await mutex.acquire();
      let released = false;
      return {
        query: (text, values) => {
          if (released) return Promise.reject(new Error('client already released'));
          return exec(text, values);
        },
        release() {
          if (released) return;
          released = true;
          release();
        },
      };
    },
    async end() {
      const release = await mutex.acquire();
      try {
        await pg.close();
      } finally {
        release();
      }
    },
  };
}
