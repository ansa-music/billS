import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import type { SqlDriver } from './db/driver.ts';
import { migrate } from './db/migrate.ts';
import { openSqlite } from './db/sqlite.ts';
import { buildApp } from './http/app.ts';
import type { PushSender } from './push.ts';
import { DisabledSender, FcmSender, loadServiceAccount, PushDispatcher, runWatchdogs } from './push.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();

async function openDatabase(): Promise<{ db: SqlDriver; kind: string }> {
  if (config.databaseUrl) {
    // Loaded lazily: SQLite installs need no PostgreSQL client at all.
    const [{ default: pg }, { createPostgresDriver }] = await Promise.all([import('pg'), import('./db/postgres.ts')]);
    // BIGINT (int8) and NUMERIC come back as strings by default; the cloud keeps everything in Number range.
    pg.types.setTypeParser(20, Number);
    pg.types.setTypeParser(1700, Number);
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    return { db: createPostgresDriver(pool), kind: 'postgres' };
  }
  return { db: openSqlite(config.dbPath), kind: `sqlite ${config.dbPath}` };
}

const { db, kind } = await openDatabase();

// Without a service account key pushes are off: rules and devices are kept, every push is only logged.
const account = loadServiceAccount();
let log: (message: string) => void = (message) => console.log(message);
const sender: PushSender = account ? new FcmSender(account) : new DisabledSender((m) => log(m));
const push = new PushDispatcher(db, sender, () => systemClock.now(), { maxAgeMs: config.pushMaxAgeMs, log: (m) => log(m) });

const app = buildApp({
  db,
  clock: systemClock,
  logger: true,
  secureCookies: config.secureCookies,
  push,
  publicUrl: config.publicUrl,
});
log = (message) => app.log.info(message);

const applied = await migrate(db, Date.now());
if (applied.length) app.log.info({ applied }, 'Миграции применены');
let seeded = false;
if (config.demoSeed) seeded = await seedDemo(db, Date.now(), (message) => app.log.info(message));

await app.listen({ host: config.host, port: config.port });
app.log.info({ database: kind, seeded }, 'Облако запущено');
app.log.info(account ? `Push включены: FCM, проект ${account.project_id}` : 'Push выключены: нет ключа FCM (CLOUD_FCM_SERVICE_ACCOUNT)');

// Watchdogs (HUB silent, shift left open) and a retry of anything left PENDING, once a minute.
const watchdog = setInterval(() => {
  runWatchdogs(db, systemClock.now(), { hubOfflineMs: config.hubOfflineMs, shiftOpenMs: config.shiftOpenMs })
    .then(() => push.flush())
    .catch((e: unknown) => app.log.error(e, 'Сторож облака'));
}, 60_000);
watchdog.unref();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'Облако останавливается');
  clearInterval(watchdog);
  await app.close();
  await db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
