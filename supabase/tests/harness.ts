import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import type { SqlDriver } from '../../apps/cloud/src/db/driver.ts';
import { createPostgresDriver } from '../../apps/cloud/src/db/postgres.ts';
import type { PgClientLike, PgPoolLike, PgQueryResult } from '../../apps/cloud/src/db/postgres.ts';

/**
 * Supabase in a test: PGlite (real PostgreSQL in WASM) with the pieces of a Supabase
 * project the migrations rely on — roles anon/authenticated/service_role, the `auth`
 * schema with `auth.users` and `auth.uid()`, the `supabase_realtime` publication and
 * Supabase's default grants — then every file of supabase/migrations applied in order.
 *
 * Migrations named `*_cron.sql` (pg_cron, pg_net: not available in PGlite) are skipped.
 * Nothing here was run against a live Supabase project.
 */

const MIGRATIONS = new URL('../migrations/', import.meta.url);

const SUPABASE_STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text UNIQUE,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE SCHEMA extensions;
CREATE PUBLICATION supabase_realtime;
`;

/** File names of supabase/migrations in the order Supabase applies them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS), 'utf8');
}

export interface SupabaseTestDb {
  pg: PGlite;
  /** As the service role / postgres (what Edge Functions use through SUPABASE_DB_URL). */
  db: SqlDriver;
  /** The same connection as a `pg.Pool`, e.g. for code that builds its own driver. */
  pool: PgPoolLike;
  /** Runs `fn` as an end user signed in through Supabase Auth: role `authenticated`, `auth.uid() = userId`, RLS on. */
  asUser<T>(userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Adds a Supabase Auth user (what sign-up does) and returns its id. */
  createAuthUser(email: string, id?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createSupabaseDb(options: { skip?: (file: string) => boolean } = {}): Promise<SupabaseTestDb> {
  const pg = await PGlite.create({ parsers: { 20: Number, 1700: Number } });
  await pg.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    if (file.endsWith('_cron.sql') || options.skip?.(file)) continue;
    try {
      await pg.exec(readMigration(file));
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }

  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  const exec = async (text: string, values?: unknown[]): Promise<PgQueryResult> => {
    const r = await pg.query<Record<string, unknown>>(text, values ?? []);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const pool: PgPoolLike = {
    query: (text, values) => exclusive(() => exec(text, values)),
    connect: () =>
      new Promise<PgClientLike>((resolveClient) => {
        void exclusive(
          () =>
            new Promise<void>((done) => {
              resolveClient({ query: exec, release: () => done() });
            }),
        );
      }),
  };

  return {
    pg,
    pool,
    db: createPostgresDriver(pool),
    asUser: (userId, fn) =>
      exclusive(() =>
        pg.transaction(async (tx) => {
          await tx.query('SET LOCAL ROLE authenticated');
          await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [
            userId ?? '',
          ]);
          return fn(tx);
        }),
      ),
    async createAuthUser(email, id = crypto.randomUUID()) {
      await exclusive(() => exec('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]));
      return id;
    },
    close: () => pg.close(),
  };
}
