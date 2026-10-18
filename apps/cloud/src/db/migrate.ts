import { readdirSync, readFileSync } from 'node:fs';
import type { SqlDriver } from './driver.ts';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/**
 * Splits a migration file into single statements: drivers prepare one
 * statement at a time. Line comments are dropped; `;` must not appear inside
 * string literals in migrations.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function listMigrations(dir: URL = MIGRATIONS_DIR): Array<{ version: number; file: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: Number.parseInt(file, 10), file, sql: readFileSync(new URL(file, dir), 'utf8') }));
}

/** Applies pending migrations through any driver. Returns the file names applied now. */
export async function migrate(db: SqlDriver, now: number, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await db.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)',
  );
  const rows = await db.all<{ version: number | string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  const done: string[] = [];
  for (const m of listMigrations(dir)) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(m.sql)) await tx.run(statement);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.file, now]);
    });
    done.push(m.file);
  }
  return done;
}
