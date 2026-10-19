/**
 * Browser stand-in for `node:crypto` (demo build only): random ids and bytes from
 * Web Crypto, synchronous SHA-256 and scrypt from @noble/hashes (the HUB hashes
 * synchronously inside its transactions, which Web Crypto cannot do).
 */
import { Buffer } from 'buffer';
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The `buffer` package predates Node's base64url; the HUB encodes session tokens with it.
const plainToString = Buffer.prototype.toString;
Buffer.prototype.toString = function toString(this: Buffer, encoding?: string, start?: number, end?: number): string {
  if (encoding === 'base64url') {
    return plainToString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return plainToString.call(this, encoding, start, end);
};
// staff.ts uses the global Buffer (PIN hashes), as in Node.
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data);

export function randomBytes(size: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface Hash {
  update(data: string | Uint8Array): Hash;
  digest(): Buffer;
  digest(encoding: string): string;
}

export function createHash(algorithm: string): Hash {
  if (algorithm.toLowerCase() !== 'sha256') throw new Error(`Hash ${algorithm} is not available in the browser demo`);
  const chunks: Uint8Array[] = [];
  function digest(): Buffer;
  function digest(encoding: string): string;
  function digest(encoding?: string): Buffer | string {
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    const out = Buffer.from(sha256(all));
    return encoding ? out.toString(encoding as BufferEncoding) : out;
  }
  const hash: Hash = {
    update(data) {
      chunks.push(bytesOf(data));
      return hash;
    },
    digest,
  };
  return hash;
}

/** Node's defaults: N = 16384, r = 8, p = 1. */
export function scryptSync(
  password: string | Uint8Array,
  salt: string | Uint8Array,
  keylen: number,
  options: { N?: number; cost?: number; r?: number; blockSize?: number; p?: number; parallelization?: number } = {},
): Buffer {
  const N = options.N ?? options.cost ?? 16384;
  const r = options.r ?? options.blockSize ?? 8;
  const p = options.p ?? options.parallelization ?? 1;
  return Buffer.from(scrypt(bytesOf(password), bytesOf(salt), { N, r, p, dkLen: keylen }));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export default { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual };
