import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './http/app.ts';
import { Hub } from './hub.ts';
import { SimulatorLampDriver } from './lamps/simulator.ts';
import { seedDemo } from './seed.ts';

const config = loadConfig();
if (config.cloudUrl && (!config.cloudApiKey || !config.hubId)) {
  throw new Error('CLOUD_URL задан, но CLOUD_API_KEY или HUB_ID пустые');
}
const db = openDb(config.dbPath);
const seeded = seedDemo(db, Date.now(), config.demoTimezone);

// Stage 5 replaces the simulator with a real controller driver.
const simulator = new SimulatorLampDriver({ latencyMs: config.simulatorLatencyMs });
const hub = new Hub({
  db,
  clock: systemClock,
  lampDriver: simulator,
  ...(config.cloudUrl
    ? {
        sync: {
          url: config.cloudUrl,
          apiKey: config.cloudApiKey,
          hubId: config.hubId,
          intervalMs: config.cloudSyncIntervalMs,
          // `app` is created below; the worker only logs after hub.start().
          logger: { info: (m: string) => app.log.info(m), warn: (m: string) => app.log.warn(m) },
        },
      }
    : {}),
});
const app = buildApp(hub, { simulator, logger: true });

hub.start();
await app.listen({ host: config.host, port: config.port });
app.log.info({ dbPath: config.dbPath, seeded, cloud: config.cloudUrl ?? 'off', hubId: config.hubId || undefined }, 'HUB started');

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
