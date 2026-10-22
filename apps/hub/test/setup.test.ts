import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { encodeHubSetupCode } from '@bills/domain';
import type { HubSetupResponse, HubSetupStatus } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { isLocalHostHeader, isPrivateAddress } from '../src/http/routes/setup.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import { loadHubConfig, mergeSetupEnv, readSetupFile, SetupService } from '../src/setup.ts';
import type { HubSetupFile } from '../src/setup.ts';
import { FAST_LAMPS, MONDAY_NOON } from './helpers.ts';

const KEY = 'q2V9sJ0xY7c3pV8tM1rB6nK4wZ5aL0dH9fG2jE7uR3i';
const HUB_ID = 'hub-ts-na-abaya';

type T = { after: (fn: () => unknown) => void };

function tempDir(t: T): string {
  const dir = mkdtempSync(join(tmpdir(), 'bills-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A cloud that answers GET /sync/settings like apps/cloud and the `sync` Edge Function. */
class FakeCloud {
  requests: Array<{ url: string; auth: string | undefined }> = [];
  /** null: a real answer; otherwise every request gets this status (and a TS-style error body). */
  status: number | null = null;
  /** Answer with an HTML page instead of JSON (not a TS cloud). */
  html = false;
  url = '';
  #server: Server | undefined;

  async start(t: T): Promise<this> {
    this.#server = createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    t.after(() => new Promise<void>((r) => this.#server?.close(() => r())));
    return this;
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    this.requests.push({ url: req.url ?? '', auth: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.html) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>router</title>');
      return;
    }
    if (this.status !== null) return send(this.status, { error: { code: 'X', message: 'no' } });
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/sync/settings') return send(404, { error: { code: 'NOT_FOUND', message: 'Не найдено' } });
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: 'UNAUTHORIZED', message: 'Неизвестный ключ HUB' } });
    if (u.searchParams.get('hubId') !== HUB_ID) return send(403, { error: { code: 'HUB_MISMATCH', message: 'Ключ выдан другому HUB' } });
    send(200, { changed: false, version: 3 });
  }
}

interface SetupHub {
  app: FastifyInstance;
  service: SetupService;
  dir: string;
  file: string;
  saved: HubSetupFile[];
  audit: Array<Record<string, unknown>>;
}

/** A HUB assembled like main.ts: config from env + setup.json, tokens only (no X-Actor fallback). */
async function startSetupHub(t: T, opts: { env?: NodeJS.ProcessEnv; dir?: string; staticDir?: string } = {}): Promise<SetupHub> {
  const dir = opts.dir ?? tempDir(t);
  const env: NodeJS.ProcessEnv = { HUB_DB_PATH: join(dir, 'hub.db'), ...opts.env };
  const loaded = loadHubConfig(env);
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  seedDemo(db, clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  const saved: HubSetupFile[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const service = new SetupService({
    path: loaded.setupPath,
    env,
    config: loaded.config,
    restartDelayMs: 0,
    onSaved: (f) => saved.push(f),
    audit: (d) => audit.push(d),
  });
  const app = buildApp(hub, { setup: service, staticDir: opts.staticDir });
  await app.ready();
  t.after(async () => {
    await app.close();
    hub.close();
    db.close();
  });
  return { app, service, dir, file: loaded.setupPath, saved, audit };
}

function postSetup(h: SetupHub, body: object, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}) {
  return h.app.inject({ method: 'POST', url: '/api/setup', payload: body, ...extra });
}

async function status(h: SetupHub): Promise<HubSetupStatus> {
  const res = await h.app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal(res.statusCode, 200);
  return res.json<HubSetupStatus>();
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('open → save with a connection code → closed; the restarted HUB is connected', async (t) => {
  const cloud = await new FakeCloud().start(t);
  const h = await startSetupHub(t);

  assert.deepEqual(await status(h), { open: true, state: 'open', hubId: null, cloudUrlPreset: null, lampsPreset: null });
  const page = await h.app.inject({ method: 'GET', url: '/setup' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  assert.match(page.body, /Код подключения/);
  assert.match(page.body, /ESP32 по Wi-Fi/);
  assert.match(page.body, /Modbus TCP/);

  const code = encodeHubSetupCode({ hubId: HUB_ID, apiKey: KEY, cloudUrl: cloud.url });
  const res = await postSetup(h, { code: `  ${code}\n`, lamps: { driver: 'esp32-http', esp32Host: '192.168.1.50', esp32Token: 'tok-1' } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<HubSetupResponse>();
  assert.deepEqual(body, { ok: true, hubId: HUB_ID, cloudUrl: cloud.url, checked: true, restartInMs: 0, warning: null });
  // The key was checked against the cloud with a read-only call, never sent in the URL.
  assert.equal(cloud.requests.length, 1);
  assert.match(cloud.requests[0]!.url, /^\/sync\/settings\?since=\d+&hubId=hub-ts-na-abaya$/);
  assert.equal(cloud.requests[0]!.auth, `Bearer ${KEY}`);

  // setup.json next to the database, readable by the HUB user only.
  assert.equal(h.file, join(h.dir, 'setup.json'));
  const file = JSON.parse(readFileSync(h.file, 'utf8')) as HubSetupFile;
  assert.equal(file.version, 1);
  assert.deepEqual(file.cloud, { url: cloud.url, hubId: HUB_ID, apiKey: KEY });
  assert.deepEqual(file.lamps, { driver: 'esp32-http', esp32Host: '192.168.1.50', esp32Token: 'tok-1' });
  if (process.platform !== 'win32') assert.equal(statSync(h.file).mode & 0o777, 0o600);
  await tick();
  assert.equal(h.saved.length, 1, 'main.ts is told to restart');
  assert.equal(h.audit.length, 1);
  assert.equal(h.audit[0]!.hubId, HUB_ID);
  assert.ok(!JSON.stringify(h.audit).includes(KEY), 'the key never reaches the audit log');

  // Closed right away, before the restart.
  assert.equal((await status(h)).state, 'saved');
  const again = await postSetup(h, { code, lamps: { driver: 'simulator' } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json<{ error: { code: string } }>().error.code, 'SETUP_DONE');
  assert.doesNotMatch((await h.app.inject({ method: 'GET', url: '/setup' })).body, /<form/);

  // After the restart the config has the cloud, the wizard says «already set up».
  const restarted = await startSetupHub(t, { dir: h.dir });
  const loaded = loadHubConfig({ HUB_DB_PATH: join(h.dir, 'hub.db') }).config;
  assert.equal(loaded.cloudUrl, cloud.url);
  assert.equal(loaded.hubId, HUB_ID);
  assert.equal(loaded.cloudApiKey, KEY);
  assert.equal(loaded.lampDriver, 'esp32-http');
  assert.deepEqual(loaded.esp32, { host: '192.168.1.50', token: 'tok-1' });
  assert.deepEqual(await status(restarted), { open: false, state: 'configured', hubId: HUB_ID, cloudUrlPreset: null, lampsPreset: null });
  const closedPage = await restarted.app.inject({ method: 'GET', url: '/setup' });
  assert.equal(closedPage.statusCode, 200);
  assert.match(closedPage.body, /HUB уже настроен/);
  assert.doesNotMatch(closedPage.body, /<form/);
  assert.ok(!closedPage.body.includes(KEY));
  const closedPost = await postSetup(restarted, { code, lamps: { driver: 'simulator' } });
  assert.equal(closedPost.statusCode, 409);
});

test('validation errors name the field and save nothing', async (t) => {
  const cloud = await new FakeCloud().start(t);
  const h = await startSetupHub(t);
  const cases: Array<[object, string, RegExp]> = [
    [{ code: 'hello', lamps: { driver: 'simulator' } }, 'code', /не код подключения/],
    [{ code: 'TS1.abc', lamps: { driver: 'simulator' } }, 'code', /повреждён/],
    [{ apiKey: KEY, cloudUrl: cloud.url, lamps: { driver: 'simulator' } }, 'hubId', /HUB_ID/],
    [{ hubId: 'hub 1', apiKey: KEY, cloudUrl: cloud.url }, 'hubId', /HUB_ID/],
    [{ hubId: HUB_ID, apiKey: 'short', cloudUrl: cloud.url }, 'apiKey', /[Кк]люч/],
    [{ hubId: HUB_ID, apiKey: KEY }, 'cloudUrl', /адрес облака/i],
    [{ hubId: HUB_ID, apiKey: KEY, cloudUrl: 'ftp://cloud' }, 'cloudUrl', /адрес облака/i],
    [{ hubId: HUB_ID, apiKey: KEY, cloudUrl: cloud.url, lamps: { driver: 'esp32-http' } }, 'esp32Host', /адрес/i],
    [{ hubId: HUB_ID, apiKey: KEY, cloudUrl: cloud.url, lamps: { driver: 'modbus-tcp', modbusHost: 'not a host!' } }, 'modbusHost', /адрес/i],
    [{ hubId: HUB_ID, apiKey: KEY, cloudUrl: cloud.url, lamps: { driver: 'esp32-http', esp32Host: '192.168.1.50:99999' } }, 'esp32Host', /адрес|порт/i],
  ];
  for (const [body, field, message] of cases) {
    const res = await postSetup(h, body);
    assert.equal(res.statusCode, 422, `${JSON.stringify(body)} → ${res.body}`);
    const err = res.json<{ error: { code: string; field: string; message: string } }>().error;
    assert.equal(err.code, 'SETUP_INVALID');
    assert.equal(err.field, field, JSON.stringify(body));
    assert.match(err.message, message);
  }
  assert.equal(cloud.requests.length, 0, 'nothing reaches the cloud before the form is valid');
  assert.equal(existsSync(h.file), false);
  assert.equal((await status(h)).open, true);
  // Unknown driver and a non-JSON body are plain 400s.
  assert.equal((await postSetup(h, { code: 'x', lamps: { driver: 'arduino' } })).statusCode, 400);
  const text = await h.app.inject({ method: 'POST', url: '/api/setup', payload: 'code=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.ok(text.statusCode >= 400 && text.statusCode < 500);
});

test('the cloud check: wrong key, another HUB, not a TS cloud, no internet (save anyway)', async (t) => {
  const cloud = await new FakeCloud().start(t);
  const h = await startSetupHub(t);
  const manual = (over: object = {}) => ({ hubId: HUB_ID, apiKey: KEY, cloudUrl: cloud.url, lamps: { driver: 'simulator' }, ...over });
  const errorOf = async (body: object) => {
    const res = await postSetup(h, body);
    return { status: res.statusCode, ...res.json<{ error: { code: string; message: string; canSkip?: boolean } }>().error };
  };

  let e = await errorOf(manual({ apiKey: 'wrong-key-123456' }));
  assert.equal(e.status, 422);
  assert.equal(e.code, 'CLOUD_KEY_INVALID');
  assert.match(e.message, /ключ не подходит/i);

  e = await errorOf(manual({ hubId: 'hub-other' }));
  assert.equal(e.code, 'CLOUD_HUB_MISMATCH');
  assert.match(e.message, /другому HUB/);

  e = await errorOf(manual({ cloudUrl: `${cloud.url}/nothing-here` }));
  assert.equal(e.code, 'CLOUD_NOT_TS');
  cloud.html = true;
  e = await errorOf(manual());
  assert.equal(e.code, 'CLOUD_NOT_TS');
  cloud.html = false;

  cloud.status = 503;
  e = await errorOf(manual());
  assert.equal(e.status, 502);
  assert.equal(e.code, 'CLOUD_UNREACHABLE');
  assert.equal(e.canSkip, true);
  cloud.status = null;

  // Nothing listens there: no internet / wrong address.
  const dead = 'http://127.0.0.1:9';
  e = await errorOf(manual({ cloudUrl: dead }));
  assert.equal(e.status, 502);
  assert.equal(e.code, 'CLOUD_UNREACHABLE');
  assert.match(e.message, /интернет/);
  assert.equal(existsSync(h.file), false);

  const res = await postSetup(h, manual({ cloudUrl: dead, skipCheck: true }));
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<HubSetupResponse>();
  assert.equal(body.checked, false);
  assert.match(body.warning ?? '', /интернет/);
  assert.equal((JSON.parse(readFileSync(h.file, 'utf8')) as HubSetupFile).cloud.url, dead);
});

test('only from the club LAN: public addresses, proxies and foreign host names are refused', async (t) => {
  const h = await startSetupHub(t);
  for (const remoteAddress of ['8.8.8.8', '100.64.1.2', '2001:db8::1', '::ffff:8.8.8.8']) {
    const page = await h.app.inject({ method: 'GET', url: '/setup', remoteAddress });
    assert.equal(page.statusCode, 403, remoteAddress);
    assert.match(page.body, /сети клуба/);
    assert.doesNotMatch(page.body, /<form/);
    const st = await h.app.inject({ method: 'GET', url: '/api/setup/status', remoteAddress });
    assert.equal(st.statusCode, 403);
    const post = await postSetup(h, { code: 'x' }, { remoteAddress });
    assert.equal(post.statusCode, 403);
    assert.equal(post.json<{ error: { code: string } }>().error.code, 'SETUP_LAN_ONLY');
  }
  for (const remoteAddress of ['192.168.1.23', '10.0.0.5', '172.20.1.1', '::ffff:192.168.0.10', 'fe80::1%eth0', 'fd12::5', '::1']) {
    const st = await h.app.inject({ method: 'GET', url: '/api/setup/status', remoteAddress });
    assert.equal(st.statusCode, 200, remoteAddress);
  }
  // A tunnel or reverse proxy on the mini-PC connects from 127.0.0.1 but says who is really asking.
  const proxied = await h.app.inject({ method: 'GET', url: '/setup', headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(proxied.statusCode, 403);
  const cf = await postSetup(h, { code: 'x' }, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  assert.equal(cf.statusCode, 403);
  // DNS rebinding: a foreign site name pointing at the HUB.
  const rebound = await h.app.inject({ method: 'GET', url: '/api/setup/status', headers: { host: 'evil.example.com:4310' } });
  assert.equal(rebound.statusCode, 403);
  const crossSite = await postSetup(h, { code: 'x' }, { headers: { origin: 'http://evil.example.com' } });
  assert.equal(crossSite.statusCode, 403);
  for (const host of ['hub.local:4310', '192.168.1.20:4310', '[fe80::1]:4310', 'localhost', 'ts-club']) {
    const ok = await h.app.inject({ method: 'GET', url: '/api/setup/status', headers: { host } });
    assert.equal(ok.statusCode, 200, host);
  }
  const sameOrigin = await postSetup(h, { code: 'hello' }, { headers: { host: 'hub.local:4310', origin: 'http://hub.local:4310' } });
  assert.equal(sameOrigin.statusCode, 422, 'same-origin POST reaches validation');
});

test('private address and host name checks', () => {
  for (const ip of ['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.100.1', '169.254.1.1', '::1', 'fc00::1', 'fdab::1', 'fe80::1', 'febf::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.100.100.100', '2001:db8::1', 'fec0::1', '::ffff:1.1.1.1', '', undefined, 'garbage']) {
    assert.equal(isPrivateAddress(ip), false, String(ip));
  }
  for (const host of ['hub.local', 'hub.local:4310', 'HUB.LOCAL', '192.168.1.2:4310', '[::1]:4310', 'localhost:4310', 'mini-pc', 'router.lan', 'hub.home.arpa']) {
    assert.equal(isLocalHostHeader(host), true, host);
  }
  for (const host of ['evil.example.com', 'hub.local.evil.com', 'x.supabase.co:443', '', undefined]) {
    assert.equal(isLocalHostHeader(host), false, String(host));
  }
});

test('a demo HUB does not expose the wizard', async (t) => {
  const h = await startSetupHub(t, { env: { HUB_DEMO: '1' } });
  assert.deepEqual(await status(h), { open: false, state: 'demo', hubId: null, cloudUrlPreset: null, lampsPreset: null });
  const page = await h.app.inject({ method: 'GET', url: '/setup' });
  assert.doesNotMatch(page.body, /<form/);
  assert.match(page.body, /демо/i);
  const res = await postSetup(h, { code: 'x', lamps: { driver: 'simulator' } });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json<{ error: { code: string } }>().error.code, 'SETUP_DISABLED');
});

test('HUB_SETUP=off closes the wizard of a club that runs without a cloud', async (t) => {
  const h = await startSetupHub(t, { env: { HUB_SETUP: 'off' } });
  const st = await status(h);
  assert.equal(st.open, false);
  assert.equal(st.state, 'off');
  assert.match((await h.app.inject({ method: 'GET', url: '/setup' })).body, /HUB_SETUP=off/);
  const res = await postSetup(h, { code: 'x', lamps: { driver: 'simulator' } });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json<{ error: { code: string } }>().error.code, 'SETUP_DISABLED');
});

test('a HUB connected through hub.env keeps the wizard closed', async (t) => {
  const h = await startSetupHub(t, { env: { CLOUD_URL: 'http://127.0.0.1:4320', HUB_ID: 'hub-demo-1', CLOUD_API_KEY: 'demo-hub-key-1' } });
  const st = await status(h);
  assert.equal(st.open, false);
  assert.equal(st.state, 'configured');
  assert.equal(st.hubId, 'hub-demo-1');
});

test('presets from hub.env: the cloud address and the lamp controller are not asked again', async (t) => {
  const cloud = await new FakeCloud().start(t);
  const h = await startSetupHub(t, { env: { CLOUD_URL: `${cloud.url}/`, HUB_LAMP_DRIVER: 'modbus-tcp', HUB_MODBUS_HOST: '192.168.1.60' } });
  const st = await status(h);
  assert.equal(st.open, true, 'CLOUD_URL without HUB_ID and key is not a connection');
  assert.equal(st.cloudUrlPreset, cloud.url);
  assert.equal(st.lampsPreset, 'modbus-tcp');
  const page = await h.app.inject({ method: 'GET', url: '/setup' });
  assert.match(page.body, /hub\.env/);
  const res = await postSetup(h, { hubId: HUB_ID, apiKey: KEY, lamps: { driver: 'esp32-http', esp32Host: '10.0.0.9' } });
  assert.equal(res.statusCode, 200, res.body);
  const file = JSON.parse(readFileSync(h.file, 'utf8')) as HubSetupFile;
  assert.equal(file.cloud.url, cloud.url);
  assert.equal(file.lamps, null, 'hub.env decides the controller');
});

test('setup.json fills what hub.env leaves empty; hub.env wins where it is set', (t) => {
  const dir = tempDir(t);
  const file: HubSetupFile = {
    version: 1,
    savedAt: '2026-10-21T10:00:00.000Z',
    checked: true,
    cloud: { url: 'https://abc.supabase.co/functions/v1', hubId: 'hub-wizard', apiKey: KEY },
    lamps: { driver: 'esp32-http', esp32Host: '192.168.1.50', esp32Token: 'tok' },
  };
  writeFileSync(join(dir, 'setup.json'), JSON.stringify(file));
  const base = { HUB_DB_PATH: join(dir, 'hub.db') };

  let c = loadHubConfig(base).config;
  assert.equal(c.cloudUrl, 'https://abc.supabase.co/functions/v1');
  assert.equal(c.hubId, 'hub-wizard');
  assert.equal(c.cloudApiKey, KEY);
  assert.equal(c.lampDriver, 'esp32-http');
  assert.deepEqual(c.esp32, { host: '192.168.1.50', token: 'tok' });

  // The cloud connection is one unit: hub.env with its own HUB_ID and key wins entirely.
  c = loadHubConfig({ ...base, CLOUD_URL: 'http://10.0.0.1:4320', HUB_ID: 'hub-env', CLOUD_API_KEY: 'env-key-123' }).config;
  assert.deepEqual([c.cloudUrl, c.hubId, c.cloudApiKey], ['http://10.0.0.1:4320', 'hub-env', 'env-key-123']);
  assert.equal(c.lampDriver, 'esp32-http', 'lamps still come from the wizard');
  // CLOUD_URL alone (an image preset) does not beat the address the key was issued for.
  c = loadHubConfig({ ...base, CLOUD_URL: 'http://10.0.0.1:4320' }).config;
  assert.equal(c.cloudUrl, 'https://abc.supabase.co/functions/v1');
  // Empty values in hub.env count as unset.
  c = loadHubConfig({ ...base, HUB_ID: '', CLOUD_API_KEY: '', HUB_LAMP_DRIVER: '' }).config;
  assert.equal(c.hubId, 'hub-wizard');
  assert.equal(c.lampDriver, 'esp32-http');
  // HUB_LAMP_DRIVER in hub.env decides the controller.
  c = loadHubConfig({ ...base, HUB_LAMP_DRIVER: 'simulator' }).config;
  assert.equal(c.lampDriver, 'simulator');
  assert.equal(c.esp32.host, undefined);

  // HUB_SETUP_FILE moves the file; a missing file changes nothing.
  const other = join(dir, 'conf', 'wizard.json');
  mkdirSync(join(dir, 'conf'));
  writeFileSync(other, JSON.stringify({ ...file, cloud: { ...file.cloud, hubId: 'hub-moved' } }));
  assert.equal(loadHubConfig({ ...base, HUB_SETUP_FILE: other }).config.hubId, 'hub-moved');
  const none = loadHubConfig({ HUB_DB_PATH: join(dir, 'nowhere', 'hub.db') });
  assert.equal(none.config.cloudUrl, null);
  assert.equal(none.setupError, null);

  // A damaged file is reported and ignored: the HUB starts standalone with the wizard open.
  writeFileSync(join(dir, 'setup.json'), '{"version":1,"cloud":');
  const broken = loadHubConfig(base);
  assert.equal(broken.config.cloudUrl, null);
  assert.match(broken.setupError ?? '', /setup\.json/);
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ ...file, cloud: { ...file.cloud, apiKey: 'a b' } }));
  assert.match(readSetupFile(join(dir, 'setup.json')).error ?? '', /setup\.json/);
  assert.equal(mergeSetupEnv(base, null), base);
});

test('the auth hook and the hall screen fallback do not shadow /setup', async (t) => {
  const dist = tempDir(t);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root">hall</div>');
  const h = await startSetupHub(t, { staticDir: dist });
  const page = await h.app.inject({ method: 'GET', url: '/setup' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Код подключения/);
  assert.doesNotMatch(page.body, /id="root"/);
  // No token needed for the wizard API, while the rest of /api still is behind login.
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/setup/status' })).statusCode, 200);
  assert.equal((await postSetup(h, { code: 'nope' })).statusCode, 422);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/state' })).statusCode, 401);
  assert.match((await h.app.inject({ method: 'GET', url: '/tables' })).body, /id="root"/);
});
