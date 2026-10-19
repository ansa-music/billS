import { existsSync } from 'node:fs';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { buildApp } from './http/app.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();

const { db, kind } = await openDatabase(config);
const app = buildApp({
  db,
  clock: systemClock,
  logger: true,
  secureCookies: config.secureCookies,
  staticDir: config.webDistPath,
});

const applied = await migrate(db, Date.now());
if (applied.length) app.log.info({ applied }, 'Миграции применены');
let seeded = false;
if (config.demoSeed) seeded = await seedDemo(db, Date.now(), (message) => app.log.info(message));

await app.listen({ host: config.host, port: config.port });
const webDistServed = existsSync(config.webDistPath);
app.log.info({ database: kind, seeded, webDist: config.webDistPath, webDistServed }, 'Облако запущено');
if (!webDistServed) {
  app.log.warn('Кабинет не собран: выполните `npm run build` в корне репозитория, чтобы облако отдавало его на /');
}

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
