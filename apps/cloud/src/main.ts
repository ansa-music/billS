import { existsSync } from 'node:fs';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { buildApp } from './http/app.ts';
import { PushDispatcher, pushSenderFromEnv, runWatchdogs } from './push.ts';
import { licenseSignerFromEnv } from './license.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();

const { db, kind } = await openDatabase(config);

// Push channels from the environment: ntfy (unless NTFY_DISABLED=1) and Web Push (VAPID_* keys).
// With none of them pushes are off: rules and devices are kept, every push is only logged.
let log: (message: string) => void = (message) => console.log(message);
const sender = pushSenderFromEnv(process.env, (m) => log(m));
const licenseSigner = licenseSignerFromEnv(process.env, (m) => log(m));
const push = new PushDispatcher(db, sender, () => systemClock.now(), { maxAgeMs: config.pushMaxAgeMs, log: (m) => log(m) });

const app = buildApp({
  db,
  clock: systemClock,
  logger: true,
  secureCookies: config.secureCookies,
  staticDir: config.webDistPath,
  push,
  publicUrl: config.publicUrl,
  licenseSigner,
});
log = (message) => app.log.info(message);

const applied = await migrate(db, Date.now());
if (applied.length) app.log.info({ applied }, 'Миграции применены');
let seeded = false;
if (config.demoSeed) seeded = await seedDemo(db, Date.now(), (message) => app.log.info(message)); // demo license: always the dev key

await app.listen({ host: config.host, port: config.port });
const webDistServed = existsSync(config.webDistPath);
app.log.info({ database: kind, seeded, webDist: config.webDistPath, webDistServed }, 'Облако запущено');
if (!webDistServed) {
  app.log.warn('Кабинет не собран: выполните `npm run build` в корне репозитория, чтобы облако отдавало его на /');
}
app.log.info(sender.enabled ? `Push включены: ${sender.channels.join(', ')}` : 'Push выключены: ntfy отключён (NTFY_DISABLED=1), ключей Web Push нет');

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
