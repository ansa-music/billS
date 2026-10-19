import type { CloudConfig } from '../config.ts';
import type { SqlDriver } from './driver.ts';
import { openSqlite } from './sqlite.ts';

export interface OpenedDatabase {
  db: SqlDriver;
  /** `postgres` or `sqlite <path>`, for logs. */
  kind: string;
}

/** Opens the database the config points at: PostgreSQL when `databaseUrl` is set, SQLite otherwise. */
export async function openDatabase(config: Pick<CloudConfig, 'databaseUrl' | 'dbPath'>): Promise<OpenedDatabase> {
  if (config.databaseUrl) {
    // Loaded lazily: SQLite installs need no PostgreSQL client at all.
    const [{ default: pg }, { createPostgresDriver }] = await Promise.all([import('pg'), import('./postgres.ts')]);
    // BIGINT (int8) and NUMERIC come back as strings by default; the cloud keeps everything in Number range.
    pg.types.setTypeParser(20, Number);
    pg.types.setTypeParser(1700, Number);
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    return { db: createPostgresDriver(pool), kind: 'postgres' };
  }
  return { db: openSqlite(config.dbPath), kind: `sqlite ${config.dbPath}` };
}
