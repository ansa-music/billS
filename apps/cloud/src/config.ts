import { fileURLToPath } from 'node:url';

export interface CloudConfig {
  host: string;
  port: number;
  /** SQLite file, used when `databaseUrl` is not set. */
  dbPath: string;
  /** PostgreSQL connection string; when set, SQLite is not used. */
  databaseUrl: string | null;
  /** Create the demo company, owner and HUB keys when the database is empty. */
  demoSeed: boolean;
  /** Mark the owner cookie `Secure` (only sent over HTTPS). */
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const databaseUrl = env.CLOUD_DATABASE_URL?.trim() || null;
  // With SQLite (development) the demo seed is on unless switched off; with PostgreSQL it must be asked for.
  const demoSeed = env.CLOUD_DEMO_SEED === undefined ? databaseUrl === null : env.CLOUD_DEMO_SEED === '1';
  return {
    host: env.CLOUD_HOST ?? '127.0.0.1',
    port: Number(env.CLOUD_PORT ?? 4320),
    dbPath: env.CLOUD_DB_PATH ?? fileURLToPath(new URL('../data/cloud.db', import.meta.url)),
    databaseUrl,
    demoSeed,
    secureCookies: env.CLOUD_SECURE_COOKIES === '1',
  };
}
