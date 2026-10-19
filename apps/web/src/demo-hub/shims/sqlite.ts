/**
 * Browser stand-in for `node:sqlite` (demo build only, see vite.config.ts): the
 * subset of DatabaseSync / StatementSync that apps/hub/src/db.ts uses, on top of
 * sql.js (SQLite compiled to WebAssembly). The HUB code runs unchanged.
 */
import type initSqlJs from 'sql.js';

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJs['Database']>;
type SqlStatement = ReturnType<SqlDatabase['prepare']>;
type Bindable = initSqlJs.BindParams;

export type SQLInputValue = null | number | bigint | string | Uint8Array;

let sqlJs: SqlJs | null = null;
let pendingBytes: Uint8Array | null = null;

/** Must run before the HUB opens its database; `bytes` restores a saved demo club. */
export function provideSqlJs(sql: SqlJs, bytes: Uint8Array | null): void {
  sqlJs = sql;
  pendingBytes = bytes;
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

function toBind(params: unknown[]): Bindable {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)) {
    // Named parameters: node:sqlite accepts bare names, sql.js wants the prefix.
    const named: Record<string, initSqlJs.SqlValue> = {};
    for (const [k, v] of Object.entries(params[0] as Record<string, unknown>)) {
      const value = toValue(v);
      if (/^[:$@]/.test(k)) named[k] = value;
      else for (const p of [':', '$', '@']) named[p + k] = value;
    }
    return named;
  }
  return params.map(toValue);
}

function toValue(v: unknown): initSqlJs.SqlValue {
  if (v === undefined) throw Object.assign(new TypeError('Provided value cannot be bound to SQLite parameter'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as initSqlJs.SqlValue;
}

export class DatabaseSync {
  readonly #db: SqlDatabase;
  /** Bumped by export(): sql.js frees every prepared statement when it serialises. */
  generation = 0;
  #inTransaction = false;
  #open = true;

  constructor(_path: string) {
    if (!sqlJs) throw new Error('sql.js is not loaded');
    this.#db = pendingBytes ? new sqlJs.Database(pendingBytes) : new sqlJs.Database();
    pendingBytes = null;
  }

  get raw(): SqlDatabase {
    return this.#db;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get isTransaction(): boolean {
    return this.#inTransaction;
  }

  exec(sql: string): void {
    wrap(() => this.#db.exec(sql));
    if (/^\s*BEGIN\b/i.test(sql)) this.#inTransaction = true;
    else if (/^\s*(COMMIT|END)\b/i.test(sql) || /^\s*ROLLBACK\s*;?\s*$/i.test(sql)) this.#inTransaction = false;
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this, sql);
  }

  close(): void {
    this.#open = false;
    this.#db.close();
  }

  /** The whole database file (for localStorage). Never call it inside a transaction. */
  export(): Uint8Array {
    const bytes = this.#db.export();
    this.generation++;
    // sql.js closes and reopens the database to serialise it: connection pragmas are reset.
    this.#db.exec('PRAGMA foreign_keys = ON');
    return bytes;
  }
}

export class StatementSync {
  readonly #owner: DatabaseSync;
  readonly #sql: string;
  #stmt: SqlStatement;
  #generation: number;

  constructor(owner: DatabaseSync, sql: string) {
    this.#owner = owner;
    this.#sql = sql;
    this.#stmt = wrap(() => owner.raw.prepare(sql));
    this.#generation = owner.generation;
  }

  #prepared(): SqlStatement {
    if (this.#generation !== this.#owner.generation) {
      this.#stmt = wrap(() => this.#owner.raw.prepare(this.#sql));
      this.#generation = this.#owner.generation;
    }
    return this.#stmt;
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const s = this.#prepared();
    return wrap(() => {
      try {
        s.bind(toBind(params));
        return s.step() ? (s.getAsObject() as Record<string, unknown>) : undefined;
      } finally {
        s.reset();
      }
    });
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    const s = this.#prepared();
    return wrap(() => {
      try {
        s.bind(toBind(params));
        const rows: Array<Record<string, unknown>> = [];
        while (s.step()) rows.push(s.getAsObject() as Record<string, unknown>);
        return rows;
      } finally {
        s.reset();
      }
    });
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const s = this.#prepared();
    const db = this.#owner.raw;
    wrap(() => {
      try {
        s.bind(toBind(params));
        s.step();
      } finally {
        s.reset();
      }
    });
    const changes = db.getRowsModified();
    return {
      changes,
      get lastInsertRowid() {
        return Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0);
      },
    };
  }
}
