import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caDer, initCa, SERVER_DAYS } from '../src/tls/ca.ts';
import { namedBits, oid, time } from '../src/tls/der.ts';
import { loadTls, startRedirectServer, tlsStatus } from '../src/tls/serve.ts';
import type { TlsStatus } from '@bills/domain';
import { runCli } from '../src/cli.ts';
import { ManualClock } from '../src/clock.ts';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import { FAST_LAMPS, Harness, MONDAY_NOON } from './helpers.ts';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ts-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('DER helpers encode the tricky cases', () => {
  assert.equal(oid('1.2.840.10045.4.3.2').toString('hex'), '06082a8648ce3d040302');
  // keyUsage digitalSignature + keyCertSign + cRLSign = 1000 0110, one unused bit.
  assert.equal(namedBits([0, 5, 6]).toString('hex'), '03020186');
  assert.equal(namedBits([0]).toString('hex'), '03020780');
  assert.equal(time(Date.UTC(2026, 0, 2, 3, 4, 5)).toString('latin1').slice(2), '260102030405Z');
  assert.equal(time(Date.UTC(2051, 0, 2, 3, 4, 5))[0], 0x18); // GeneralizedTime after 2049
});

test('ca init: root and server certificate that a TLS client accepts for hub.local and the IP', async (t) => {
  const dir = tempDir(t);
  const r = initCa({ dir, ips: ['127.0.0.1', '192.168.1.10'], label: 'Клуб «Тест»', now: Date.now() });
  assert.equal(r.caCreated, true);
  assert.equal(r.serverIssued, true);

  const ca = new X509Certificate(readFileSync(r.paths.caCert));
  const server = new X509Certificate(readFileSync(r.paths.serverCert));
  assert.equal(ca.ca, true);
  assert.equal(server.ca, false);
  assert.ok(server.checkIssued(ca));
  assert.ok(server.verify(ca.publicKey));
  assert.ok(ca.verify(ca.publicKey), 'root is self-signed');
  assert.equal(server.checkHost('hub.local'), 'hub.local');
  assert.equal(server.checkIP('192.168.1.10'), '192.168.1.10');
  assert.equal(server.checkHost('evil.local'), undefined);
  assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']); // extKeyUsage serverAuth
  assert.match(ca.subject, /Клуб «Тест»/);
  assert.deepEqual(r.info.dnsNames, ['hub.local', 'localhost']);
  assert.deepEqual(r.info.ips, ['127.0.0.1', '192.168.1.10']);
  assert.ok(r.info.serverValidTo - Date.now() <= 825 * DAY, 'Apple: no more than 825 days');
  assert.equal(caDer(readFileSync(r.paths.caCert)).equals(Buffer.from(ca.raw)), true);
  if (process.platform !== 'win32') assert.equal(statSync(r.paths.caKey).mode & 0o077, 0, 'key is private');

  // A real handshake: Node's TLS (OpenSSL) validates the chain, SAN and key usage.
  const server2 = https.createServer(
    { key: readFileSync(r.paths.serverKey), cert: readFileSync(r.paths.serverCert) },
    (_req, res) => res.end('ok'),
  );
  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
  t.after(() => server2.close());
  const port = (server2.address() as AddressInfo).port;
  const get = (servername: string) =>
    new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, ca: readFileSync(r.paths.caCert), servername, agent: false }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve(body));
        })
        .on('error', reject);
    });
  assert.equal(await get('hub.local'), 'ok');
  await assert.rejects(get('other.local'), /altnames|Hostname/i);
});

test('ca init is idempotent: keeps the root, re-issues the server certificate only when needed', (t) => {
  const dir = tempDir(t);
  const first = initCa({ dir, ips: ['192.168.1.10'], now: NOW });
  const caBefore = readFileSync(first.paths.caCert, 'utf8');
  const serverBefore = readFileSync(first.paths.serverCert, 'utf8');

  const again = initCa({ dir, ips: ['192.168.1.10'], now: NOW + DAY });
  assert.equal(again.caCreated, false);
  assert.equal(again.serverIssued, false);
  assert.equal(readFileSync(first.paths.serverCert, 'utf8'), serverBefore);

  // The mini-PC got a new address from DHCP → new server certificate, same root.
  const moved = initCa({ dir, ips: ['192.168.1.20'], now: NOW + DAY });
  assert.equal(moved.serverIssued, true);
  assert.match(moved.reason ?? '', /192\.168\.1\.20/);
  assert.equal(readFileSync(first.paths.caCert, 'utf8'), caBefore);

  // Close to expiry → renewed.
  const late = initCa({ dir, ips: ['192.168.1.20'], now: NOW + (SERVER_DAYS - 10) * DAY });
  assert.equal(late.serverIssued, true);
  assert.match(late.reason ?? '', /истекает/);

  // Half a root is an operator mistake, not something to silently overwrite.
  rmSync(first.paths.caKey);
  assert.throws(() => initCa({ dir, ips: ['192.168.1.20'], now: NOW }), /половина/);
});

test('ca init re-issues a server certificate signed by another root', (t) => {
  const dir = tempDir(t);
  const other = tempDir(t);
  initCa({ dir, ips: ['10.0.0.5'], now: NOW });
  const foreign = initCa({ dir: other, ips: ['10.0.0.5'], now: NOW });
  writeFileSync(join(dir, 'server.crt'), readFileSync(foreign.paths.serverCert));
  writeFileSync(join(dir, 'server.key'), readFileSync(foreign.paths.serverKey));
  const r = initCa({ dir, ips: ['10.0.0.5'], now: NOW });
  assert.equal(r.serverIssued, true);
  assert.match(r.reason ?? '', /другим корневым/);
});

test('openssl agrees with the certificate structure (when openssl is installed)', (t) => {
  let has = true;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    has = false;
  }
  if (!has) return t.skip('openssl not installed');
  const dir = tempDir(t);
  const r = initCa({ dir, ips: ['192.168.1.10'], now: Date.now() });
  const out = execFileSync('openssl', ['verify', '-x509_strict', '-purpose', 'sslserver', '-CAfile', r.paths.caCert, r.paths.serverCert], {
    encoding: 'utf8',
  });
  assert.match(out, /OK/);
});

test('HUB over HTTPS: /api/tls, /ca page and the root certificate; plain HTTP redirects except /ca', async (t) => {
  const dir = tempDir(t);
  const r = initCa({ dir, ips: ['127.0.0.1', '192.168.1.10'], now: Date.now() });
  const tls = loadTls({ certPath: r.paths.serverCert, keyPath: r.paths.serverKey });
  assert.ok(tls);

  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  seedDemo(db, clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  let httpsPort = 0;
  let httpPort = 0;
  const status = () => tlsStatus({ tls, httpsPort, httpPort, mdnsName: 'hub.local', now: Date.now() });
  const app = buildApp(hub, { trustActorHeader: true, tls: { runtime: tls, status } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  httpsPort = (app.server.address() as AddressInfo).port;
  const redirect = await startRedirectServer({ tls, status, httpsPort, host: '127.0.0.1', port: 0 });
  httpPort = (redirect.address() as AddressInfo).port;
  t.after(async () => {
    redirect.close();
    await app.close();
    hub.close();
    db.close();
  });

  const ca = readFileSync(r.paths.caCert);
  const res = await httpsGet(httpsPort, '/api/tls', ca);
  assert.equal(res.status, 200);
  const s = JSON.parse(res.body.toString()) as TlsStatus;
  assert.equal(s.enabled, true);
  assert.equal(s.caFingerprint, r.info.caFingerprint);
  assert.deepEqual(s.caPageUrls, [`http://192.168.1.10:${httpPort}/ca`, `http://hub.local:${httpPort}/ca`]);
  assert.deepEqual(s.appUrls, [`https://192.168.1.10:${httpsPort}/`, `https://hub.local:${httpsPort}/`]);
  assert.equal(s.renewSoon, false);

  const der = await httpsGet(httpsPort, '/ca.crt', ca);
  assert.equal(der.headers['content-type'], 'application/x-x509-ca-cert');
  assert.match(String(der.headers['content-disposition']), /TS-root\.crt/);
  assert.equal(new X509Certificate(der.body).fingerprint256, r.info.caFingerprint);

  // Plain HTTP: the tablet fetches the page and the certificate before it trusts the HUB…
  const page = await httpGet(httpPort, '/ca', '192.168.1.10:80');
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Сертификат клуба TS/);
  assert.match(page.body.toString(), new RegExp(`https://192\.168\.1\.10:${httpsPort}/`));
  assert.match(page.body.toString(), /Доверие сертификатам/);
  const plainDer = await httpGet(httpPort, '/ca.crt', 'hub.local');
  assert.equal(new X509Certificate(plainDer.body).fingerprint256, r.info.caFingerprint);
  // …everything else goes to HTTPS on the same host, path and query kept.
  const moved = await httpGet(httpPort, '/#/checks?x=1', 'hub.local');
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.location, `https://hub.local:${httpsPort}/#/checks?x=1`);
  const hostile = await httpGet(httpPort, '/', 'evil.com/<x>');
  assert.equal(hostile.headers.location, `https://192.168.1.10:${httpsPort}/`);
});

test('/api/tls without HTTPS says so; broken TLS settings refuse to start', async (t) => {
  const harness = new Harness();
  t.after(() => harness.dispose());
  const h = await harness.start();
  const res = await h.app.inject({ method: 'GET', url: '/api/tls' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().enabled, false);
  assert.equal((await h.app.inject({ method: 'GET', url: '/ca.crt' })).statusCode, 404);

  assert.equal(loadTls({}), null);
  assert.throws(() => loadTls({ certPath: '/nope/server.crt' }), /обе переменные/);
  assert.throws(() => loadTls({ certPath: '/nope/server.crt', keyPath: '/nope/server.key' }), /bills ca init/);
});

test('cli: ca init prints the env lines, ca show describes the certificates', (t) => {
  const dir = tempDir(t);
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: { HUB_DB_PATH: join(dir, 'hub.db') }, now: () => Date.now() };
  assert.equal(runCli(['ca', 'init', '--ip=192.168.1.10,127.0.0.1', '--label=Клуб'], io), 0);
  assert.deepEqual(out, [
    `HUB_TLS_CERT=${join(dir, 'tls', 'server.crt')}`,
    `HUB_TLS_KEY=${join(dir, 'tls', 'server.key')}`,
    `HUB_TLS_CA=${join(dir, 'tls', 'ca.crt')}`,
  ]);
  assert.match(err.join('\n'), /Создан корневой сертификат/);
  out.length = 0;
  err.length = 0;
  assert.equal(runCli(['ca', 'init', '--ip=192.168.1.10,127.0.0.1'], io), 0);
  assert.match(err.join('\n'), /уже есть/);
  assert.match(err.join('\n'), /не перевыпускался/);
  out.length = 0;
  assert.equal(runCli(['ca', 'show', '--json'], io), 0);
  assert.deepEqual(JSON.parse(out[0]!).info.ips, ['192.168.1.10', '127.0.0.1']);
  assert.equal(runCli(['ca', 'bogus'], io), 2);
});

function httpsGet(port: number, path: string, ca: Buffer) {
  return request(https.get, { host: '127.0.0.1', port, path, ca, servername: 'hub.local', agent: false });
}
function httpGet(port: number, path: string, host: string) {
  return request(http.get, { host: '127.0.0.1', port, path, headers: { host }, agent: false });
}
function request(
  get: typeof http.get,
  opts: https.RequestOptions,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    get(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
