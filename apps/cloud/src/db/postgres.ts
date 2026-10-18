import type { SqlDriver } from './driver.ts';
import { normalizeParam } from './driver.ts';

/**
 * The subset of `pg.Pool` / `pg.PoolClient` the driver needs. Declared here so
 * tests can pass a fake client and the module does not depend on `pg` itself.
 */
export interface PgQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}

export interface PgClientLike extends PgQueryable {
  release(err?: Error | boolean): void;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

/** Rewrites `?` placeholders to `$1…$n`, leaving string literals untouched. */
export function toPositional(sql: string): string {
  let out = '';
  let n = 0;
  let inString = false;
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) {
      n++;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * PostgreSQL driver over a `pg.Pool`-shaped object. A transaction runs on one
 * dedicated client (BEGIN … COMMIT / ROLLBACK) which is released afterwards.
 * Not yet verified against a live PostgreSQL server — see the README.
 */
export function createPostgresDriver(pool: PgPoolLike): SqlDriver {
  const over = (q: PgQueryable, insideTx: boolean): SqlDriver => {
    const driver: SqlDriver = {
      async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const result = await q.query(toPositional(sql), (params ?? []).map(normalizeParam));
        return result.rows as T[];
      },
      async run(sql: string, params?: unknown[]): Promise<number> {
        const result = await q.query(toPositional(sql), (params ?? []).map(normalizeParam));
        return result.rowCount ?? 0;
      },
      async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
        if (insideTx) return fn(driver);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          try {
            const result = await fn(over(client, true));
            await client.query('COMMIT');
            return result;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        } finally {
          client.release();
        }
      },
      async close(): Promise<void> {
        if (!insideTx && pool.end) await pool.end();
      },
    };
    return driver;
  };
  return over(pool, false);
}
