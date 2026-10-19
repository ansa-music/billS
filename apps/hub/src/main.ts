import { existsSync } from 'node:fs';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './http/app.ts';
import { Hub } from './hub.ts';
import { createLampDriver } from './lamps/factory.ts';
import { createUpsSource, parseUpsUrl, SimulatorUps } from './power/ups.ts';
import { seedDemo } from './seed.ts';
import { managerMatcher } from './manual-mode.ts';
import { versionInfo, versionString } from './version.ts';
import { writeBootstrapKeys } from './auth.ts';
import { dirname, join } from 'node:path';
import { DEMO_KEYS } from '@bills/domain';
import { nextDemoReset } from './demo.ts';

const config = loadConfig();
if (config.cloudUrl && (!config.cloudApiKey || !config.hubId)) {
  throw new Error('CLOUD_URL задан, но CLOUD_API_KEY или HUB_ID пустые');
}
const db = openDb(config.dbPath);
const seeded = seedDemo(db, Date.now(), config.demoTimezone);

// The relay controller comes from HUB_LAMP_DRIVER: simulator, esp32-http or modbus-tcp.
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
const app = buildApp(hub, {
  simulator: lamps.simulator,
  upsSimulator: ups instanceof SimulatorUps ? ups : undefined,
  logger: true,
  dbPath: config.dbPath,
  startedAt: Date.now(),
  version: versionInfo(),
  staticDir: config.webDistPath,
  corsOrigins: config.corsOrigins,
  ...(config.demo
    ? { demo: { resetAt: () => config.demoResetAt ?? nextDemoReset(Date.now(), config.demoTimezone, 4) } }
    : {}),
});

hub.start();

// Public demo: the simple keys shown on the login screen (packages/domain/src/public.ts).
if (config.demo) {
  for (const k of hub.auth.issueFixedKeys(DEMO_KEYS)) app.log.info({ role: k.role, name: k.name }, 'Демо-ключ выдан');
}

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
const webDistServed = existsSync(config.webDistPath);
app.log.info(
  {
    dbPath: config.dbPath,
    seeded,
    version: versionString(),
    lampDriver: config.lampDriver,
    lampPollMs: hub.monitor.supported ? config.lampPollMs : 'unsupported',
    ups: ups?.label ?? 'off',
    webDist: config.webDistPath,
    webDistServed,
    cloud: config.cloudUrl ?? 'off',
    hubId: config.hubId || undefined,
    demo: config.demo || undefined,
    cors: config.corsOrigins.length ? config.corsOrigins : undefined,
  },
  'HUB started',
);
if (!webDistServed) {
  app.log.warn('Hall screen is not built: run `npm run build` in the repo root to serve it on /');
}

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
