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
import { MdnsResponder, normalizeHostName } from './mdns.ts';
import { loadTls, startRedirectServer, tlsStatus } from './tls/serve.ts';

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
// HTTPS with the club's own root (`bills ca init`); broken TLS settings stop the start instead of falling back to HTTP.
const tls = loadTls({ certPath: config.tlsCert, keyPath: config.tlsKey, caPath: config.tlsCa });
const mdnsHost = config.mdnsName ? normalizeHostName(config.mdnsName) : null;
const status = () =>
  tlsStatus({
    tls,
    httpsPort: tls ? config.port : null,
    httpPort: tls ? config.httpPort : null,
    mdnsName: mdnsHost,
    now: Date.now(),
  });
const app = buildApp(hub, {
  tls: { runtime: tls, status },
  simulator: lamps.simulator,
  upsSimulator: ups instanceof SimulatorUps ? ups : undefined,
  logger: true,
  dbPath: config.dbPath,
  startedAt: Date.now(),
  version: versionInfo(),
  staticDir: config.webDistPath,
});

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
const redirect =
  tls && config.httpPort !== null
    ? await startRedirectServer({ tls, status, httpsPort: config.port, host: config.host, port: config.httpPort })
    : null;
const mdns = config.mdnsName
  ? new MdnsResponder({
      name: config.mdnsName,
      logger: { info: (m: string) => app.log.info(m), warn: (m: string) => app.log.warn(m) },
    })
  : null;
await mdns?.start();
if (tls) {
  const s = status();
  app.log.info({ https: s.appUrls, caPage: s.caPageUrls, serverValidTo: new Date(s.serverValidTo!).toISOString() }, 'HTTPS on');
  if (s.renewSoon) app.log.warn('Сертификат HUB скоро истекает — выполните `bills ca init`');
}
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
    https: tls ? true : false,
    mdns: mdnsHost ?? 'off',
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
  await mdns?.close();
  redirect?.close();
  await app.close();
  hub.close();
  lamps.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
