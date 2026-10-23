import { existsSync } from 'node:fs';
import { systemClock } from './clock.ts';
import { openDb, transaction } from './db.ts';
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
import { DEMO_KEYS, HUB_SETUP_PATH, originUrl, standaloneHubId } from '@bills/domain';
import { clubId } from './views.ts';
import { nextDemoReset } from './demo.ts';
import { DEMO_LICENSE_KEYS, installDemoLicense } from './demo-license.ts';
import { lanAddresses } from './tls/ca.ts';
import { record } from './journal.ts';
import { loadHubConfig, SETUP_RESTART_EXIT_CODE, SetupService } from './setup.ts';

// hub.env (process env) plus what the first-boot wizard saved in setup.json next to the database.
const { config, setupPath, setupError } = loadHubConfig();
// CLOUD_URL alone (e.g. preset in the mini-PC image) is not a connection: the HUB runs standalone
// and the wizard at /setup asks for HUB_ID and the key.
const cloudReady = Boolean(config.cloudUrl && config.cloudApiKey && config.hubId);
const db = openDb(config.dbPath);
// HUB_DEMO_BUSINESS=cafe: an empty database becomes a demo coffee shop instead of a billiard club.
const seeded = seedDemo(db, Date.now(), config.demoTimezone, config.demoBusiness);

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
  // A real club checks licenses unless HUB_LICENSE=off; the public demo signs itself a trial one (dev key).
  demo: config.demo,
  license: {
    mode: config.demo ? 'enforce' : config.licenseMode,
    publicKeys: config.demo ? DEMO_LICENSE_KEYS : config.licensePublicKeys,
    hubId: config.hubId || standaloneHubId(clubId(db)),
  },
  ...(cloudReady && config.cloudUrl
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
// First-boot wizard: open from the club LAN while no cloud is connected; saving restarts the HUB.
const setup = new SetupService({
  path: setupPath,
  env: process.env,
  config,
  onSaved: () => {
    app.log.warn({ setupPath }, 'Мастер настройки сохранил подключение — HUB перезапускается, чтобы его применить');
    void shutdown('setup', SETUP_RESTART_EXIT_CODE);
  },
  audit: (data) =>
    transaction(db, () =>
      record(db, Date.now(), { actor: 'setup', action: 'hub.setup_saved', entityType: 'club', entityId: clubId(db), data }),
    ),
});
const app = buildApp(hub, {
  setup,
  tls: { runtime: tls, status },
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

// The stored license is checked against the platform's keys before the first request.
await hub.license.init();
if (config.demo) await installDemoLicense(hub.license, Date.now());
hub.start();

// Public demo: the simple keys shown on the login screen (packages/domain/src/public.ts).
if (config.demo) {
  for (const k of hub.auth.issueFixedKeys(DEMO_KEYS)) app.log.info({ roles: k.roles, name: k.name }, 'Демо-ключ выдан');
}

// Nobody must be locked out: without any working long key (platform, manager) the HUB's own
// managers — or a new installer account (TECH) — get one, written next to the database.
// On a fresh demo club every employee gets one.
const bootstrap = hub.auth.bootstrapKeys(seeded);
if (bootstrap.length) {
  const file = join(dirname(config.dbPath), 'first-run-keys.txt');
  writeBootstrapKeys(file, bootstrap, Date.now());
  for (const k of bootstrap) app.log.warn({ roles: k.roles, name: k.name, key: k.key }, 'Ключ доступа выдан при старте');
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
    cloud: cloudReady ? config.cloudUrl : 'off',
    hubId: config.hubId || undefined,
    license: hub.license.enforced ? hub.license.status().state : 'off',
    https: tls ? true : false,
    mdns: mdnsHost ?? 'off',
    demo: config.demo || undefined,
    cors: config.corsOrigins.length ? config.corsOrigins : undefined,
  },
  'HUB started',
);
if (!webDistServed) {
  app.log.warn('Hall screen is not built: run `npm run build` in the repo root to serve it on /');
}
if (setupError) app.log.error({ setupPath }, `${setupError} — HUB работает без облака, мастер /setup открыт снова`);
if (config.cloudUrl && !cloudReady) app.log.warn('CLOUD_URL задан, но HUB_ID или CLOUD_API_KEY пустые — HUB работает без облака');
if (setup.status().open) {
  const scheme = tls ? 'https' : 'http';
  const hosts = [...lanAddresses(), ...(mdnsHost ? [mdnsHost] : [])];
  const urls = (hosts.length ? hosts : ['<адрес-мини-ПК>']).map((h) => `${originUrl(scheme, h, config.port)}${HUB_SETUP_PATH}`);
  app.log.warn({ urls }, 'HUB не подключён к облаку — откройте мастер настройки с телефона в сети клуба');
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    app.log.warn('HUB_HOST=127.0.0.1: мастер /setup открывается только на этом компьютере (для сети клуба — HUB_HOST=0.0.0.0)');
  }
}

let stopping = false;
async function shutdown(signal: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal, exitCode }, 'HUB stopping');
  await mdns?.close();
  redirect?.close();
  await app.close();
  hub.close();
  lamps.close();
  db.close();
  process.exit(exitCode);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
