/**
 * The club's own certificate authority: a root certificate installed once on
 * every tablet and PC, and a server certificate for `hub.local` + the mini-PC's
 * IP addresses signed by it. Built on node:crypto (ECDSA P-256) and the tiny
 * DER encoder next door — no OpenSSL binary, no npm dependency.
 *
 * Files in the TLS folder (default: `tls/` next to the database):
 *   ca.key / ca.crt          root key (0600) and certificate (PEM), 10 years
 *   server.key / server.crt  HUB key (0600) and certificate (PEM), 800 days
 *
 * Re-running `ca init` keeps the root (tablets keep trusting the HUB) and
 * re-issues the server certificate only when it is missing, expiring, signed
 * by another root or does not cover the requested names and addresses.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { RENEW_BEFORE_DAYS } from './info.ts';
import type { CertInfo } from './info.ts';
import { bits, bool, explicit, implicit, integer, namedBits, octets, oid, pem, seq, set, subjectOf, time, utf8 } from './der.ts';

const DAY = 24 * 60 * 60 * 1000;
export { RENEW_BEFORE_DAYS } from './info.ts';
export type { CertInfo } from './info.ts';

/** Root lifetime: the tablets install it once. */
export const CA_DAYS = 3650;
/** Apple rejects TLS server certificates valid for more than 825 days, even under a private root. */
export const SERVER_DAYS = 800;
/** Tablet clocks drift: certificates start an hour in the past. */
const BACKDATE_MS = 60 * 60 * 1000;

const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyId: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyId: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

export interface TlsPaths {
  dir: string;
  caKey: string;
  caCert: string;
  serverKey: string;
  serverCert: string;
}

export function tlsPaths(dir: string): TlsPaths {
  return {
    dir,
    caKey: join(dir, 'ca.key'),
    caCert: join(dir, 'ca.crt'),
    serverKey: join(dir, 'server.key'),
    serverCert: join(dir, 'server.crt'),
  };
}

function name(commonName: string): Buffer {
  return seq(
    set(seq(oid(OID.organization), utf8('TS'))),
    set(seq(oid(OID.commonName), utf8(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

/** Key identifier: SHA-1 of the subjectPublicKey bits (RFC 5280 §4.2.1.2, method 1). */
function keyId(spki: Buffer): Buffer {
  // For a P-256 SPKI the BIT STRING is the last 66 bytes: tag, length, unused-bits byte, point.
  return createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

function ipBytes(ip: string): Buffer {
  if (isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  // Expand IPv6 (with ::) to 16 bytes.
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

interface CertSpec {
  subject: string;
  /** Issuer Name as DER; the root passes its own subject. */
  issuer: Buffer | null;
  publicKey: KeyObject;
  signingKey: KeyObject;
  issuerKeyId: Buffer;
  notBefore: number;
  notAfter: number;
  ca: boolean;
  dnsNames?: string[];
  ips?: string[];
}

function buildCert(spec: CertSpec): Buffer {
  const spki = spec.publicKey.export({ type: 'spki', format: 'der' });
  const algorithm = seq(oid(OID.ecdsaSha256));
  const serial = randomBytes(16);
  serial[0]! &= 0x7f; // positive, 16 bytes of randomness as CA/B asks
  const ext: Buffer[] = [
    extension(OID.basicConstraints, true, spec.ca ? seq(bool(true), integer(0)) : seq()),
    // CA: digitalSignature, keyCertSign, cRLSign. Server (ECDSA): digitalSignature.
    extension(OID.keyUsage, true, spec.ca ? namedBits([0, 5, 6]) : namedBits([0])),
    extension(OID.subjectKeyId, false, octets(keyId(spki))),
    extension(OID.authorityKeyId, false, seq(implicit(0, spec.issuerKeyId))),
  ];
  if (!spec.ca) {
    ext.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
    const alt = [
      ...(spec.dnsNames ?? []).map((n) => implicit(2, Buffer.from(n, 'ascii'))),
      ...(spec.ips ?? []).map((ip) => implicit(7, ipBytes(ip))),
    ];
    ext.push(extension(OID.subjectAltName, false, seq(...alt)));
  }
  const tbs = seq(
    explicit(0, integer(2)), // v3
    integer(serial),
    algorithm,
    spec.issuer ?? name(spec.subject),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    spki,
    explicit(3, seq(...ext)),
  );
  const signature = sign('sha256', tbs, spec.signingKey); // ECDSA → DER-encoded (r, s)
  return seq(tbs, algorithm, bits(signature));
}

function newKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function writePrivate(path: string, key: KeyObject): void {
  writeFileSync(path, key.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // an existing file keeps its old mode otherwise
  } catch {
    // Windows: modes are advisory.
  }
}

/** Non-internal IPv4 addresses of this machine — what tablets in the club network dial. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export interface CaInitOptions {
  dir: string;
  /** DNS names for the server certificate; default `hub.local` and `localhost`. */
  dnsNames?: string[];
  /** IP addresses; default this machine's LAN IPv4 plus 127.0.0.1. */
  ips?: string[];
  /** Name shown in the tablet's certificate list. */
  label?: string;
  now?: number;
  /** Re-issue the server certificate even if the current one still fits. */
  forceServer?: boolean;
}

export interface CaInitResult {
  paths: TlsPaths;
  caCreated: boolean;
  serverIssued: boolean;
  /** Why the server certificate was (re)issued, for the operator. */
  reason?: string;
  info: CertInfo;
}

function altNames(cert: X509Certificate): { dnsNames: string[]; ips: string[] } {
  const dnsNames: string[] = [];
  const ips: string[] = [];
  for (const part of (cert.subjectAltName ?? '').split(', ')) {
    if (part.startsWith('DNS:')) dnsNames.push(part.slice(4));
    else if (part.startsWith('IP Address:')) ips.push(part.slice(11));
  }
  return { dnsNames, ips };
}

export function describe(caPem: string | Buffer, serverPem: string | Buffer): CertInfo {
  const ca = new X509Certificate(caPem);
  const server = new X509Certificate(serverPem);
  return {
    caSubject: ca.subject.replace(/\n/g, ', '),
    caFingerprint: ca.fingerprint256,
    caValidTo: Date.parse(ca.validTo),
    serverValidTo: Date.parse(server.validTo),
    ...altNames(server),
  };
}

/** Root certificate as DER — what Android and Windows install from a `.crt` download. */
export function caDer(caPem: string | Buffer): Buffer {
  return Buffer.from(new X509Certificate(caPem).raw);
}

function serverProblem(
  paths: TlsPaths,
  ca: X509Certificate,
  dnsNames: string[],
  ips: string[],
  now: number,
): string | null {
  if (!existsSync(paths.serverCert) || !existsSync(paths.serverKey)) return 'сертификата HUB нет';
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(readFileSync(paths.serverCert));
    if (!cert.checkPrivateKey(createPrivateKey(readFileSync(paths.serverKey)))) return 'ключ не подходит к сертификату';
  } catch {
    return 'сертификат HUB не читается';
  }
  if (!cert.verify(ca.publicKey)) return 'сертификат HUB подписан другим корневым';
  if (Date.parse(cert.validTo) - now < RENEW_BEFORE_DAYS * DAY) return 'сертификат HUB скоро истекает';
  const have = altNames(cert);
  const missing = [
    ...dnsNames.filter((n) => !have.dnsNames.includes(n)),
    ...ips.filter((ip) => !have.ips.includes(ip)),
  ];
  if (missing.length) return `в сертификате нет ${missing.join(', ')}`;
  return null;
}

/**
 * Creates the root (once) and a server certificate signed by it. Idempotent:
 * an existing root is never replaced — that would make every tablet distrust the HUB.
 */
export function initCa(options: CaInitOptions): CaInitResult {
  const now = options.now ?? Date.now();
  const paths = tlsPaths(options.dir);
  const dnsNames = [...new Set((options.dnsNames ?? ['hub.local', 'localhost']).map((n) => n.toLowerCase()))];
  const ips = [...new Set(options.ips ?? [...lanAddresses(), '127.0.0.1'])];
  for (const ip of ips) if (!isIPv4(ip) && !isIPv6(ip)) throw new Error(`Неверный IP-адрес: ${ip}`);
  if (dnsNames.length === 0 && ips.length === 0) throw new Error('Нужно хотя бы одно имя или IP-адрес');
  mkdirSync(paths.dir, { recursive: true });

  let caCreated = false;
  let caKey: KeyObject;
  let caCert: X509Certificate;
  if (existsSync(paths.caKey) && existsSync(paths.caCert)) {
    caKey = createPrivateKey(readFileSync(paths.caKey));
    caCert = new X509Certificate(readFileSync(paths.caCert));
    if (!caCert.checkPrivateKey(caKey)) throw new Error(`${paths.caKey} не подходит к ${paths.caCert}`);
  } else {
    if (existsSync(paths.caKey) || existsSync(paths.caCert)) {
      throw new Error(`В ${paths.dir} только половина корневого сертификата (ca.key / ca.crt) — восстановите файл из бэкапа или удалите оба`);
    }
    const pair = newKey();
    const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
    const subject = `TS ${options.label ?? 'HUB'} — корневой ${new Date(now).toISOString().slice(0, 10)}`;
    const der = buildCert({
      subject,
      issuer: null,
      publicKey: pair.publicKey,
      signingKey: pair.privateKey,
      issuerKeyId: keyId(spki),
      notBefore: now - BACKDATE_MS,
      notAfter: now + CA_DAYS * DAY,
      ca: true,
    });
    writePrivate(paths.caKey, pair.privateKey);
    writeFileSync(paths.caCert, pem('CERTIFICATE', der));
    caKey = pair.privateKey;
    caCert = new X509Certificate(der);
    caCreated = true;
  }

  const problem = options.forceServer ? 'перевыпуск по запросу' : serverProblem(paths, caCert, dnsNames, ips, now);
  if (problem) {
    const pair = newKey();
    const caSpki = caCert.publicKey.export({ type: 'spki', format: 'der' });
    const der = buildCert({
      subject: dnsNames[0] ?? ips[0]!,
      issuer: subjectOf(Buffer.from(caCert.raw)),
      publicKey: pair.publicKey,
      signingKey: caKey,
      issuerKeyId: keyId(caSpki),
      notBefore: now - BACKDATE_MS,
      notAfter: now + SERVER_DAYS * DAY,
      ca: false,
      dnsNames,
      ips,
    });
    writePrivate(paths.serverKey, pair.privateKey);
    writeFileSync(paths.serverCert, pem('CERTIFICATE', der));
  }

  return {
    paths,
    caCreated,
    serverIssued: problem !== null,
    ...(problem ? { reason: problem } : {}),
    info: describe(readFileSync(paths.caCert), readFileSync(paths.serverCert)),
  };
}
