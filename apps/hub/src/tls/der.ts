/**
 * Minimal DER (ASN.1) encoder — just enough to build X.509 v3 certificates
 * with node:crypto doing the keys and signatures. No parsing: certificates are
 * read back with crypto.X509Certificate.
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

export const seq = (...items: Buffer[]): Buffer => tlv(0x30, ...items);
export const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const octets = (b: Buffer): Buffer => tlv(0x04, b);
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
/** EXPLICIT context tag [n] (constructed). */
export const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);
/** IMPLICIT context tag [n] on a primitive value. */
export const implicit = (n: number, raw: Buffer): Buffer => tlv(0x80 | n, raw);

/** Non-negative INTEGER from a number or big-endian bytes. */
export function integer(v: number | Buffer): Buffer {
  let bytes: Buffer;
  if (typeof v === 'number') {
    const out: number[] = [];
    for (let x = v; x > 0; x = Math.floor(x / 256)) out.unshift(x & 0xff);
    bytes = Buffer.from(out.length ? out : [0]);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    bytes = v.subarray(i);
  }
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** BIT STRING from whole bytes (no unused bits). */
export const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.from([0]), b);

/** BIT STRING for a named-bit list (keyUsage): bit 0 is the most significant bit of the first byte. */
export function namedBits(set: number[]): Buffer {
  const max = Math.max(...set);
  const bytes = Buffer.alloc(Math.floor(max / 8) + 1);
  for (const bit of set) bytes[Math.floor(bit / 8)]! |= 0x80 >> bit % 8;
  // DER: trailing zero bits of the last byte are declared unused.
  const unused = 7 - (max % 8);
  return tlv(0x03, Buffer.from([unused]), bytes);
}

/** UTCTime before 2050, GeneralizedTime after (RFC 5280 §4.1.2.5). */
export function time(ms: number): Buffer {
  const iso = new Date(Math.floor(ms / 1000) * 1000).toISOString(); // 2026-10-19T12:00:00.000Z
  const digits = iso.slice(0, 19).replace(/[-T:]/g, ''); // 20261019120000
  const year = Number(iso.slice(0, 4));
  return year < 2050 ? tlv(0x17, Buffer.from(digits.slice(2) + 'Z')) : tlv(0x18, Buffer.from(digits + 'Z'));
}

export function pem(label: string, der: Buffer): string {
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** One TLV inside `buf` at `offset`: the whole element is buf[offset, end). */
export function readTlv(buf: Buffer, offset = 0): { tag: number; contentStart: number; end: number } {
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let p = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    p += n;
  }
  return { tag, contentStart: p, end: p + len };
}

/** Raw DER of the subject Name of a certificate — issuer of everything it signs must match byte for byte. */
export function subjectOf(certDer: Buffer): Buffer {
  const cert = readTlv(certDer);
  const tbs = readTlv(certDer, cert.contentStart);
  let p = tbs.contentStart;
  const fields: Buffer[] = [];
  while (p < tbs.end && fields.length < 6) {
    const el = readTlv(certDer, p);
    fields.push(certDer.subarray(p, el.end));
    p = el.end;
  }
  // [0] version, serial, signature, issuer, validity, subject
  return fields[5]!;
}
