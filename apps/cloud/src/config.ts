import { fileURLToPath } from 'node:url';
import { DEFAULT_PUBLIC_ORIGINS, parseOrigins } from '@bills/domain';

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
  /** Origins of cabinets on other domains (Firebase Hosting) allowed to call the API with a Bearer token. */
  corsOrigins: string[];
  /** TLS to PostgreSQL: on for remote hosts (Supabase), off for localhost; CLOUD_DATABASE_SSL=0/1 forces it. */
  databaseSsl: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  // DATABASE_URL is what Render, Supabase and most hosts call it.
  const databaseUrl = env.CLOUD_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || null;
  // With SQLite (development) the demo seed is on unless switched off; with PostgreSQL it must be asked for.
  const demoSeed = env.CLOUD_DEMO_SEED === undefined ? databaseUrl === null : env.CLOUD_DEMO_SEED === '1';
  return {
    host: env.CLOUD_HOST ?? '127.0.0.1',
    // PORT is set by Render and similar hosts.
    port: Number(env.CLOUD_PORT ?? env.PORT ?? 4320),
    dbPath: env.CLOUD_DB_PATH ?? fileURLToPath(new URL('../data/cloud.db', import.meta.url)),
    databaseUrl,
    demoSeed,
    secureCookies: env.CLOUD_SECURE_COOKIES === '1',
    corsOrigins: env.CLOUD_CORS_ORIGINS === undefined ? DEFAULT_PUBLIC_ORIGINS : parseOrigins(env.CLOUD_CORS_ORIGINS),
    databaseSsl:
      env.CLOUD_DATABASE_SSL === undefined || env.CLOUD_DATABASE_SSL === ''
        ? databaseUrl !== null && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(databaseUrl)
        : env.CLOUD_DATABASE_SSL === '1',
  };
}
