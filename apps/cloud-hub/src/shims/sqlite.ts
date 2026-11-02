/**
 * `node:sqlite` over a Durable Object's own SQLite (`ctx.storage.sql`): the subset of DatabaseSync /
 * StatementSync that apps/hub/src/db.ts uses (build.mjs aliases `node:sqlite` here), so the HUB's code runs
 * unchanged inside the café's Durable Object.
 *
 * Differences from node:sqlite that the HUB must not notice:
 * - No BEGIN/COMMIT in SQL: Durable Objects reject them. db.ts `transaction()` is pointed at
 *   `transactionSync()` below by build.mjs (the storage's own atomic, synchronous transaction).
 * - Only a few PRAGMAs exist (foreign_keys is on by default); the connection pragmas of openDb()
 *   (journal_mode, synchronous, busy_timeout) mean nothing here and are skipped.
 * - No prepared statements: the storage caches statements by their text itself.
 *
 * Every statement adds the rows it read and wrote to `stats` (what Cloudflare bills), per database.
 */

/** The part of DurableObjectStorage this shim needs (also implemented by the Node test double). */
export interface SqlCursorLike extends Iterable<Record<string, SqlValue>> {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  toArray(): Array<Record<string, SqlValue>>;
}

export interface SqlStorageLike {
  sql: { exec(query: string, ...bindings: SqlValue[]): SqlCursorLike };
  transactionSync<T>(fn: () => T): T;
}

type SqlValue = ArrayBuffer | string | number | null;
export type SQLInputValue = null | number | bigint | string | Uint8Array;

let pending: SqlStorageLike | null = null;
/** COST_DEBUG (wrangler var): statements that read or write more rows than this are noted (the SQL text only). */
let costDebug = 0;

export function setCostDebug(rows: number): void {
  costDebug = rows > 0 ? rows : 0;
}

/** Must run right before openDb(): the next `new DatabaseSync()` opens this storage. */
export function provideStorage(storage: SqlStorageLike): void {
  pending = storage;
}

export interface SqlStats {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
}

/** node:sqlite reports every SQLite failure with this code; settings.ts relies on it. */
function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && !(err as { code?: string }).code) {
      (err as Error & { code: string }).code = 'ERR_SQLITE_ERROR';
    }
    throw err;
  }
}

function toBinding(v: unknown): SqlValue {
  if (v === undefined) throw Object.assign(new TypeError('Provided value cannot be bound to SQLite parameter'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('bigint out of range for the cloud HUB');
    return Number(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  if (v instanceof ArrayBuffer) return v;
  throw Object.assign(new TypeError(`Provided value cannot be bound to SQLite parameter: ${typeof v}`), { code: 'ERR_INVALID_ARG_TYPE' });
}

function toBindings(params: unknown[]): SqlValue[] {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array) && !(params[0] instanceof ArrayBuffer)) {
    // The HUB binds positionally only; named parameters would need SQL rewriting here.
    throw new TypeError('Named SQL parameters are not supported by the cloud HUB');
  }
  return params.map(toBinding);
}

/** Blobs come back as ArrayBuffer; node:sqlite gives Uint8Array. */
function toRow(row: Record<string, SqlValue>): Record<string, unknown> {
  for (const k in row) {
    const v = row[k];
    if (v instanceof ArrayBuffer) (row as Record<string, unknown>)[k] = new Uint8Array(v);
  }
  return row;
}

/** Connection pragmas of openDb() that a Durable Object neither has nor needs. */
const SKIPPED_PRAGMA = /^PRAGMA\s+(journal_mode|synchronous|busy_timeout|temp_store|mmap_size|cache_size)\b/i;
const TX_SQL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export class DatabaseSync {
  readonly #storage: SqlStorageLike;
  readonly stats: SqlStats = { rowsRead: 0, rowsWritten: 0, statements: 0 };
  /** COST_DEBUG: the statements above the threshold since the caller last emptied this. */
  readonly costly: string[] = [];
  #inTransaction = false;
  #open = true;

  constructor(_path: string) {
    if (!pending) throw new Error('cloud HUB: provideStorage() was not called before openDb()');
    this.#storage = pending;
    pending = null;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get isTransaction(): boolean {
    return this.#inTransaction;
  }

  /** Runs one SQL text (several statements allowed, no bindings) and counts what it cost. */
  query(sql: string, bindings: SqlValue[] = []): Array<Record<string, unknown>> {
    const cursor = wrap(() => this.#storage.sql.exec(sql, ...bindings));
    const rows = wrap(() => cursor.toArray());
    this.stats.rowsRead += cursor.rowsRead;
    this.stats.rowsWritten += cursor.rowsWritten;
    this.stats.statements++;
    if (costDebug && (cursor.rowsRead > costDebug || cursor.rowsWritten > costDebug)) {
      this.costly.push(`rr=${cursor.rowsRead} rw=${cursor.rowsWritten} ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    return rows.map(toRow);
  }

  exec(sql: string): void {
    if (TX_SQL.test(sql)) {
      throw new Error('cloud HUB: transactions must go through transactionSync() (build.mjs patches db.ts transaction())');
    }
    // openDb() sends its connection pragmas in one text: run the ones that exist here, one by one.
    if (/^\s*PRAGMA\b/i.test(sql) && /^(\s*PRAGMA[^;]*;)*\s*(PRAGMA[^;]*)?$/i.test(sql)) {
      for (const part of sql.split(';')) {
        const p = part.trim();
        if (!p || SKIPPED_PRAGMA.test(p)) continue;
        try {
          this.query(p);
        } catch {
          // A pragma the Durable Object does not allow: the defaults stand (foreign keys are on).
        }
      }
      return;
    }
    this.query(sql);
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this, sql);
  }

  /**
   * The storage's own synchronous transaction: commits when `fn` returns, rolls back when it throws.
   * db.ts `transaction()` calls this instead of BEGIN/COMMIT (see build.mjs).
   */
  transactionSync<T>(fn: () => T): T {
    if (this.#inTransaction) return fn();
    return this.#storage.transactionSync(() => {
      this.#inTransaction = true;
      try {
        return fn();
      } finally {
        this.#inTransaction = false;
      }
    });
  }

  /**
   * A transaction inside the current one (SQLite savepoint): `fn`'s writes are undone when it throws, the outer
   * transaction goes on. guard.ts `safely()` calls this instead of SAVEPOINT (see build.mjs).
   */
  savepointSync(fn: () => void): void {
    if (!this.#inTransaction) {
      this.transactionSync(fn);
      return;
    }
    this.#storage.transactionSync(fn);
  }

  close(): void {
    this.#open = false;
  }
}

export class StatementSync {
  readonly #db: DatabaseSync;
  readonly #sql: string;

  constructor(db: DatabaseSync, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  get sourceSQL(): string {
    return this.#sql;
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.#db.query(this.#sql, toBindings(params))[0];
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    return this.#db.query(this.#sql, toBindings(params));
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.#db.query(this.#sql, toBindings(params));
    // rowsWritten also counts index rows, so the change count comes from SQLite itself.
    const facts = this.#db.query('SELECT changes() AS c, last_insert_rowid() AS id')[0] ?? {};
    return { changes: Number(facts.c ?? 0), lastInsertRowid: Number(facts.id ?? 0) };
  }
}
