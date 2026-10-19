import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import type { SqlDriver } from './db/driver.ts';
import { migrate } from './db/migrate.ts';
import { openSqlite } from './db/sqlite.ts';
import { buildApp } from './http/app.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();

async function openDatabase(): Promise<{ db: SqlDriver; kind: string }> {
  if (config.databaseUrl) {
    // Loaded lazily: SQLite installs need no PostgreSQL client at all.
    const [{ default: pg }, { createPostgresDriver }] = await Promise.all([import('pg'), import('./db/postgres.ts')]);
    // BIGINT (int8) and NUMERIC come back as strings by default; the cloud keeps everything in Number range.
    pg.types.setTypeParser(20, Number);
    pg.types.setTypeParser(1700, Number);
    // Supabase and other hosted PostgreSQL need TLS; their certificate chain is not in Node's store,
    // so the channel is encrypted without verifying the CA (leave `sslmode` out of the URL — it overrides this).
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 5,
    });
    return { db: createPostgresDriver(pool), kind: 'postgres' };
  }
  return { db: openSqlite(config.dbPath), kind: `sqlite ${config.dbPath}` };
}

const { db, kind } = await openDatabase();
const app = buildApp({
  db,
  clock: systemClock,
  logger: true,
  secureCookies: config.secureCookies,
  corsOrigins: config.corsOrigins,
});

const applied = await migrate(db, Date.now());
if (applied.length) app.log.info({ applied }, 'Миграции применены');
let seeded = false;
if (config.demoSeed) seeded = await seedDemo(db, Date.now(), (message) => app.log.info(message));

await app.listen({ host: config.host, port: config.port });
app.log.info({ database: kind, seeded }, 'Облако запущено');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'Облако останавливается');
  await app.close();
  await db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
