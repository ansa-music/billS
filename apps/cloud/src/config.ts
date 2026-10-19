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
  /** Built owner cabinet (apps/cloud-web/dist), served on `/` when the folder exists. */
  webDistPath: string;
  /** Address of the cloud for phones (the login QR); null → taken from each request. */
  publicUrl: string | null;
  /** A HUB not heard this long gets a HUB_OFFLINE push. */
  hubOfflineMs: number;
  /** A cash shift open this long gets a SHIFT_NOT_CLOSED push. */
  shiftOpenMs: number;
  /** Alerts older than this when they reach the cloud are not pushed. */
  pushMaxAgeMs: number;
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
    webDistPath: env.CLOUD_WEB_DIST ?? fileURLToPath(new URL('../../cloud-web/dist', import.meta.url)),
    publicUrl: env.CLOUD_PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
    hubOfflineMs: Number(env.CLOUD_HUB_OFFLINE_MINUTES ?? 10) * 60_000,
    shiftOpenMs: Number(env.CLOUD_SHIFT_OPEN_HOURS ?? 20) * 3_600_000,
    pushMaxAgeMs: Number(env.CLOUD_PUSH_MAX_AGE_MINUTES ?? 120) * 60_000,
  };
}
