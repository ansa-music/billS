import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

/**
 * Minimal mDNS responder (RFC 6762) so tablets on the club network can reach
 * the HUB as `hub.local` without typing an IP. It answers only A/ANY (and
 * AAAA with a negative NSEC) for one host name; everything else is ignored.
 *
 * No external dependencies: a single udp4 socket with SO_REUSEADDR so it can
 * share port 5353 with Bonjour/Avahi when they allow it. Every failure is
 * logged and swallowed — a missing `hub.local` must never take the HUB down.
 */

export const MDNS_PORT = 5353;
export const MDNS_GROUP = '224.0.0.251';

export const TYPE_A = 1;
export const TYPE_AAAA = 28;
export const TYPE_NSEC = 47;
export const TYPE_ANY = 255;
export const CLASS_IN = 1;
export const CLASS_ANY = 255;
/** Top bit of the class: cache-flush in answers, unicast-response (QU) in questions. */
export const CLASS_TOP_BIT = 0x8000;

const FLAG_QR = 0x8000;
const FLAG_AA = 0x0400;
const OPCODE_MASK = 0x7800;
/** RFC 6762 §6.7: legacy unicast answers should carry a TTL of at most 10 s. */
const LEGACY_MAX_TTL = 10;
const ANNOUNCE_INTERVAL_MS = 1000;

export interface MdnsOptions {
  /** 'hub' → answers 'hub.local' (case-insensitive); 'hub.local' is accepted too. */
  name: string;
  /** IPv4 addresses to answer with; asked on every query because DHCP may move us. */
  addresses?: () => string[];
  ttl?: number;
  port?: number;
  group?: string;
  logger?: { info(m: string): void; warn(m: string): void };
}

export interface DnsQuestion {
  name: string;
  type: number;
  /** Class without the QU bit. */
  class: number;
  /** QU bit: the querier asks for a unicast answer. */
  unicast: boolean;
}

export interface DnsRecord {
  name: string;
  type: number;
  /** Class without the cache-flush bit. */
  class: number;
  cacheFlush: boolean;
  ttl: number;
  data: Buffer;
}

export interface DnsMessage {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

export class DnsFormatError extends Error {}

// ---------------------------------------------------------------- decoding

function readName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new DnsFormatError('name runs past the end of the packet');
    const len = buf[pos]!;
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new DnsFormatError('truncated compression pointer');
      if (++jumps > 32) throw new DnsFormatError('compression pointer loop');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1]!;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new DnsFormatError(`unsupported label type 0x${len.toString(16)}`);
    if (pos + 1 + len > buf.length) throw new DnsFormatError('label runs past the end of the packet');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next };
}

function need(buf: Buffer, pos: number, bytes: number): void {
  if (pos + bytes > buf.length) throw new DnsFormatError('truncated packet');
}

function readRecord(buf: Buffer, pos: number): { record: DnsRecord; next: number } {
  const { name, next } = readName(buf, pos);
  need(buf, next, 10);
  const type = buf.readUInt16BE(next);
  const cls = buf.readUInt16BE(next + 2);
  const ttl = buf.readUInt32BE(next + 4);
  const rdlen = buf.readUInt16BE(next + 8);
  need(buf, next + 10, rdlen);
  const data = Buffer.from(buf.subarray(next + 10, next + 10 + rdlen));
  return {
    record: { name, type, class: cls & ~CLASS_TOP_BIT, cacheFlush: (cls & CLASS_TOP_BIT) !== 0, ttl, data },
    next: next + 10 + rdlen,
  };
}

/** Parses a DNS message (names may be compressed). Throws DnsFormatError on garbage. */
export function decodeMessage(buf: Buffer): DnsMessage {
  need(buf, 0, 12);
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)] as const;
  let pos = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(buf, pos);
    need(buf, next, 4);
    const cls = buf.readUInt16BE(next + 2);
    questions.push({ name, type: buf.readUInt16BE(next), class: cls & ~CLASS_TOP_BIT, unicast: (cls & CLASS_TOP_BIT) !== 0 });
    pos = next + 4;
  }
  const sections: DnsRecord[][] = [[], [], []];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]!; i++) {
      const { record, next } = readRecord(buf, pos);
      sections[s]!.push(record);
      pos = next;
    }
  }
  return { id, flags, questions, answers: sections[0]!, authorities: sections[1]!, additionals: sections[2]! };
}

// ---------------------------------------------------------------- encoding

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    if (label === '') continue;
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new DnsFormatError(`label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeQuestion(q: DnsQuestion): Buffer {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(q.type, 0);
  tail.writeUInt16BE((q.class & 0x7fff) | (q.unicast ? CLASS_TOP_BIT : 0), 2);
  return Buffer.concat([encodeName(q.name), tail]);
}

function encodeRecord(r: DnsRecord): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(r.type, 0);
  head.writeUInt16BE((r.class & 0x7fff) | (r.cacheFlush ? CLASS_TOP_BIT : 0), 2);
  head.writeUInt32BE(r.ttl >>> 0, 4);
  head.writeUInt16BE(r.data.length, 8);
  return Buffer.concat([encodeName(r.name), head, r.data]);
}

export function encodeMessage(msg: Partial<DnsMessage> & { flags: number }): Buffer {
  const questions = msg.questions ?? [];
  const answers = msg.answers ?? [];
  const authorities = msg.authorities ?? [];
  const additionals = msg.additionals ?? [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msg.id ?? 0, 0);
  header.writeUInt16BE(msg.flags, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([
    header,
    ...questions.map(encodeQuestion),
    ...answers.map(encodeRecord),
    ...authorities.map(encodeRecord),
    ...additionals.map(encodeRecord),
  ]);
}

/** A standard query (flags 0) — used by tests and handy for manual probing. */
export function encodeQuery(
  questions: Array<{ name: string; type?: number; unicast?: boolean }>,
  id = 0,
): Buffer {
  return encodeMessage({
    id,
    flags: 0,
    questions: questions.map((q) => ({ name: q.name, type: q.type ?? TYPE_A, class: CLASS_IN, unicast: q.unicast ?? false })),
  });
}

function ipv4Bytes(ip: string): Buffer | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (bytes.some((b) => !(b >= 0 && b <= 255))) return null;
  return Buffer.from(bytes);
}

export function aRecords(name: string, addresses: string[], ttl: number, cacheFlush = true): DnsRecord[] {
  const out: DnsRecord[] = [];
  for (const ip of new Set(addresses)) {
    const data = ipv4Bytes(ip);
    if (data) out.push({ name, type: TYPE_A, class: CLASS_IN, cacheFlush, ttl, data });
  }
  return out;
}

/** NSEC asserting that only an A record exists for `name` (RFC 6762 §6.1). */
export function nsecRecord(name: string, ttl: number, cacheFlush = true): DnsRecord {
  // Window block 0, bitmap length 1, bit for type 1 (A) = 0x40.
  const data = Buffer.concat([encodeName(name), Buffer.from([0, 1, 0x40])]);
  return { name, type: TYPE_NSEC, class: CLASS_IN, cacheFlush, ttl, data };
}

export interface EncodeResponseOptions {
  name: string;
  addresses: string[];
  ttl: number;
  /** Legacy unicast: echo id and questions, no cache-flush bit, TTL ≤ 10 s. */
  id?: number;
  questions?: DnsQuestion[];
  legacy?: boolean;
  /** Answer with the NSEC only (AAAA asked, we have none). */
  negativeOnly?: boolean;
}

/** Builds an authoritative response (QR+AA) with our A records and a trailing NSEC. */
export function encodeResponse(opts: EncodeResponseOptions): Buffer {
  const legacy = opts.legacy ?? false;
  const ttl = legacy ? Math.min(opts.ttl, LEGACY_MAX_TTL) : opts.ttl;
  const cacheFlush = !legacy;
  const a = aRecords(opts.name, opts.addresses, ttl, cacheFlush);
  const nsec = nsecRecord(opts.name, ttl, cacheFlush);
  return encodeMessage({
    id: legacy ? (opts.id ?? 0) : 0,
    flags: FLAG_QR | FLAG_AA,
    questions: legacy ? (opts.questions ?? []) : [],
    answers: opts.negativeOnly ? [nsec] : a,
    additionals: opts.negativeOnly ? [] : [nsec],
  });
}

// ---------------------------------------------------------------- answering

export function normalizeHostName(name: string): string {
  const n = name.trim().toLowerCase().replace(/\.+$/, '');
  return n.endsWith('.local') ? n : `${n}.local`;
}

export interface PlannedReply {
  packet: Buffer;
  /** Send back to the querier instead of the multicast group. */
  unicast: boolean;
}

/**
 * Decides what to send for an incoming packet, or null to stay silent.
 * `sourcePort` ≠ 5353 marks a legacy (one-shot) resolver that only listens
 * for a unicast reply with its own id.
 */
export function planReply(
  msg: DnsMessage,
  sourcePort: number,
  hostName: string,
  addresses: string[],
  ttl: number,
): PlannedReply | null {
  if ((msg.flags & FLAG_QR) !== 0 || (msg.flags & OPCODE_MASK) !== 0) return null;
  const host = normalizeHostName(hostName);
  const ours = msg.questions.filter(
    (q) => q.name.toLowerCase().replace(/\.$/, '') === host && (q.class === CLASS_IN || q.class === CLASS_ANY),
  );
  const wantsA = ours.some((q) => q.type === TYPE_A || q.type === TYPE_ANY);
  const wantsAAAA = ours.some((q) => q.type === TYPE_AAAA);
  if (!wantsA && !wantsAAAA) return null;
  const legacy = sourcePort !== MDNS_PORT;
  const unicast = legacy || ours.some((q) => q.unicast);
  const name = ours[0]!.name.replace(/\.$/, '');
  const hasA = aRecords(name, addresses, ttl).length > 0;
  if (wantsA && !hasA) return null;
  const packet = encodeResponse({
    name,
    addresses,
    ttl,
    id: msg.id,
    questions: ours.map((q) => ({ ...q, unicast: false })),
    legacy,
    negativeOnly: !wantsA,
  });
  return { packet, unicast };
}

/** Non-internal IPv4 addresses of this machine. */
export function localIPv4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const silentLogger = { info() {}, warn() {} };

export class MdnsResponder {
  private readonly host: string;
  private readonly addresses: () => string[];
  private readonly ttl: number;
  private readonly port: number;
  private readonly group: string;
  private readonly log: { info(m: string): void; warn(m: string): void };
  private socket: Socket | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(opts: MdnsOptions) {
    this.host = normalizeHostName(opts.name);
    this.addresses = opts.addresses ?? localIPv4;
    this.ttl = opts.ttl ?? 120;
    this.port = opts.port ?? MDNS_PORT;
    this.group = opts.group ?? MDNS_GROUP;
    this.log = opts.logger ?? silentLogger;
  }

  /** Never throws: if the port is unavailable the HUB just runs without `.local`. */
  async start(): Promise<void> {
    if (this.socket || this.closed) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(this.port, () => {
          socket.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.log.warn(`mDNS: не удалось занять UDP-порт ${this.port} (${(err as Error).message}) — ${this.host} работать не будет`);
      this.socket = null;
      try { socket.close(); } catch { /* already closed */ }
      return;
    }
    socket.on('error', (err) => this.log.warn(`mDNS: ошибка сокета: ${err.message}`));
    this.joinGroup(socket);
    try {
      socket.setMulticastTTL(255);
    } catch (err) {
      this.log.warn(`mDNS: setMulticastTTL: ${(err as Error).message}`);
    }
    this.log.info(`mDNS: отвечаем на ${this.host} (порт ${this.port})`);
    this.announce();
    this.later(ANNOUNCE_INTERVAL_MS, () => this.announce());
  }

  /** Sends a goodbye (TTL 0), cancels pending announcements and closes the socket. */
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    const addresses = this.safeAddresses();
    if (addresses.length > 0) {
      const packet = encodeResponse({ name: this.host, addresses, ttl: 0 });
      await new Promise<void>((resolve) => {
        try {
          socket.send(packet, this.port, this.group, () => resolve());
        } catch {
          resolve();
        }
      });
    }
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private joinGroup(socket: Socket): void {
    let joined = 0;
    for (const ip of localIPv4()) {
      try {
        socket.addMembership(this.group, ip);
        joined++;
      } catch (err) {
        this.log.warn(`mDNS: не удалось подписаться на ${this.group} через ${ip}: ${(err as Error).message}`);
      }
    }
    if (joined === 0) {
      try {
        socket.addMembership(this.group);
      } catch (err) {
        this.log.warn(`mDNS: multicast недоступен (${(err as Error).message}) — отвечаем только на unicast-запросы`);
      }
    }
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  private safeAddresses(): string[] {
    try {
      return this.addresses();
    } catch (err) {
      this.log.warn(`mDNS: не удалось получить адреса: ${(err as Error).message}`);
      return [];
    }
  }

  private announce(): void {
    const addresses = this.safeAddresses();
    if (addresses.length === 0) return;
    this.send(encodeResponse({ name: this.host, addresses, ttl: this.ttl }), this.port, this.group);
  }

  private send(packet: Buffer, port: number, address: string): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(packet, port, address, (err) => {
        if (err) this.log.warn(`mDNS: не удалось отправить ответ на ${address}:${port}: ${err.message}`);
      });
    } catch (err) {
      this.log.warn(`mDNS: не удалось отправить ответ на ${address}:${port}: ${(err as Error).message}`);
    }
  }

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    let msg: DnsMessage;
    try {
      msg = decodeMessage(buf);
    } catch {
      return; // Not ours to fix: malformed packets are simply dropped.
    }
    if ((msg.flags & FLAG_QR) !== 0) return;
    const reply = planReply(msg, rinfo.port, this.host, this.safeAddresses(), this.ttl);
    if (!reply) return;
    if (reply.unicast) this.send(reply.packet, rinfo.port, rinfo.address);
    else this.send(reply.packet, this.port, this.group);
  }
}
