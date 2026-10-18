import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './http/app.ts';
import { Hub } from './hub.ts';
import { createLampDriver } from './lamps/factory.ts';
import { seedDemo } from './seed.ts';
import { managerMatcher } from './settings.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const seeded = seedDemo(db, Date.now(), config.demoTimezone);

const lamps = createLampDriver(config);
const hub = new Hub({
  db,
  clock: systemClock,
  lampDriver: lamps.driver,
  monitorOptions: { intervalMs: config.lampPollMs, alertAfterMs: config.lampAlertAfterMs },
  isManager: managerMatcher(config.managerActors),
});
const app = buildApp(hub, { simulator: lamps.simulator, logger: true });

hub.start();
await app.listen({ host: config.host, port: config.port });
app.log.info(
  {
    dbPath: config.dbPath,
    seeded,
    lampDriver: config.lampDriver,
    lampPollMs: hub.monitor.supported ? config.lampPollMs : 'unsupported',
  },
  'HUB started',
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'HUB stopping');
  await app.close();
  hub.close();
  lamps.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
