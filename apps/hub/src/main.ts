import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './http/app.ts';
import { Hub } from './hub.ts';
import { createLampDriver } from './lamps/factory.ts';
import { createUpsSource, parseUpsUrl, SimulatorUps } from './power/ups.ts';
import { seedDemo } from './seed.ts';
import { managerMatcher } from './settings.ts';
import { versionInfo, versionString } from './version.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const seeded = seedDemo(db, Date.now(), config.demoTimezone);

const lamps = createLampDriver(config);
const upsConfig = parseUpsUrl(config.ups);
const ups = upsConfig ? createUpsSource(upsConfig) : null;
const hub = new Hub({
  db,
  clock: systemClock,
  lampDriver: lamps.driver,
  monitorOptions: { intervalMs: config.lampPollMs, alertAfterMs: config.lampAlertAfterMs },
  isManager: managerMatcher(config.managerActors),
  ups,
  powerOptions: { intervalMs: config.upsPollMs, criticalPercent: config.upsCriticalPercent },
});
const app = buildApp(hub, {
  simulator: lamps.simulator,
  upsSimulator: ups instanceof SimulatorUps ? ups : undefined,
  logger: true,
  dbPath: config.dbPath,
  startedAt: Date.now(),
  version: versionInfo(),
});

hub.start();
await app.listen({ host: config.host, port: config.port });
app.log.info(
  {
    dbPath: config.dbPath,
    seeded,
    version: versionString(),
    lampDriver: config.lampDriver,
    lampPollMs: hub.monitor.supported ? config.lampPollMs : 'unsupported',
    ups: ups?.label ?? 'off',
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
