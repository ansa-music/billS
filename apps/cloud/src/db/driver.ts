/**
 * One SQL interface for two engines. Code writes `?` placeholders and portable
 * SQL (see migrations/); the driver adapts it to SQLite or PostgreSQL.
 */
export interface SqlDriver {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Returns the number of changed rows. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** Runs `fn` in one transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Shared parameter normalisation: booleans are stored as 0/1, undefined as NULL. */
export function normalizeParam(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`Unsupported SQL parameter of type ${typeof value}`);
}
