import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './http/app.ts';
import { Hub } from './hub.ts';
import { SimulatorLampDriver } from './lamps/simulator.ts';
import { seedDemo } from './seed.ts';
import { writeBootstrapKeys } from './auth.ts';
import { dirname, join } from 'node:path';

const config = loadConfig();
const db = openDb(config.dbPath);
const seeded = seedDemo(db, Date.now(), config.demoTimezone);

// Stage 5 replaces the simulator with a real controller driver.
const simulator = new SimulatorLampDriver({ latencyMs: config.simulatorLatencyMs });
const hub = new Hub({ db, clock: systemClock, lampDriver: simulator });
const app = buildApp(hub, { simulator, logger: true });

hub.start();

// Nobody must be locked out: owners and tech without a working key get one,
// written next to the database. On a fresh demo club every employee gets one.
const bootstrap = hub.auth.bootstrapKeys(seeded);
if (bootstrap.length) {
  const file = join(dirname(config.dbPath), 'first-run-keys.txt');
  writeBootstrapKeys(file, bootstrap, Date.now());
  for (const k of bootstrap) app.log.warn({ role: k.role, name: k.name, key: k.key }, 'Ключ доступа выдан при старте');
  app.log.warn({ file }, 'Ключи сохранены в файл — передайте их и удалите файл');
}

await app.listen({ host: config.host, port: config.port });
app.log.info({ dbPath: config.dbPath, seeded }, 'HUB started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'HUB stopping');
  await app.close();
  hub.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
