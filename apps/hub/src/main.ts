import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './http/app.ts';
import { Hub } from './hub.ts';
import { SimulatorLampDriver } from './lamps/simulator.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const seeded = seedDemo(db, Date.now(), config.demoTimezone);

// Stage 5 replaces the simulator with a real controller driver.
const simulator = new SimulatorLampDriver({ latencyMs: config.simulatorLatencyMs });
const hub = new Hub({ db, clock: systemClock, lampDriver: simulator });
const app = buildApp(hub, { simulator, logger: true });

hub.start();
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
