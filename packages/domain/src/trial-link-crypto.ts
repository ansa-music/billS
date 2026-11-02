/**
 * «Подключить устройство»: the end-to-end envelope (WebCrypto only — browsers and Node alike). Supabase
 * relays the messages but never sees a request, a staff key or the venue's data in clear text, and cannot
 * forge or replay one:
 *
 *   link secret (256 bits, only in the QR/link and on paired devices)
 *     └ HKDF-SHA-256 (salt "ts-link/v1")
 *         ├ info "room"    → 96 bits → the Realtime room name (public; one-way, it does not reveal the secret)
 *         ├ info "control" → AES-256-GCM key for hello / welcome / up / bye / revoked
 *         └ base key       → HKDF again with salt = device nonce ‖ cash-desk nonce, info "session"
 *                             → AES-256-GCM key of that session only
 *
 * Every message is sealed as random 96-bit IV ‖ ciphertext ‖ tag, with additional data binding it to its
 * topic and sender (control) or to its session, direction and sequence number (data) — moving a message to
 * another topic, session or position makes it fail to open. Data messages are compressed (deflate-raw)
 * before sealing when both sides can.
 */
import { b64urlDecodeBytes, b64urlEncode } from './license.ts';
import { TRIAL_LINK } from './trial-link.ts';

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const SALT = utf8.encode('ts-link/v1');
const IV_BYTES = 12;

/** WebCrypto's types without naming globals that differ between the DOM and Node typings. */
type Subtle = NonNullable<typeof globalThis.crypto>['subtle'];
/** A WebCrypto key (CryptoKey in the browser, webcrypto.CryptoKey in Node). */
export type LinkCryptoKey = Awaited<ReturnType<Subtle['importKey']>>;

function subtle(): Subtle {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto недоступен: откройте TS по адресу https://');
  return s;
}

/** WebCrypto's BufferSource without the SharedArrayBuffer variants TypeScript worries about. */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => (bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes));

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** A random id in base64url (`bytes` random bytes). */
export function randomLinkId(bytes: number): string {
  return b64urlEncode(randomBytes(bytes));
}

/** A new link secret: TRIAL_LINK.secretBytes random bytes, base64url (43 characters). */
export function newLinkSecret(): string {
  return randomLinkId(TRIAL_LINK.secretBytes);
}

export interface LinkKeys {
  /** The Realtime room: `tsl-<room>` is the lobby, `tsl-<room>-<deviceId>` a device's pair topic. */
  room: string;
  /** Seals control messages. */
  control: LinkCryptoKey;
  /** Derives session keys. */
  base: LinkCryptoKey;
}

export async function deriveLinkKeys(secret: string): Promise<LinkKeys> {
  const raw = b64urlDecodeBytes(secret);
  if (raw.length < 16) throw new Error('link secret too short');
  const s = subtle();
  const ikm = await s.importKey('raw', buf(raw), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: utf8.encode(info) });
  const room = new Uint8Array(await s.deriveBits(hkdf('room'), ikm, 96));
  const control = await s.deriveKey(hkdf('control'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const baseBits = new Uint8Array(await s.deriveBits(hkdf('base'), ikm, 256));
  const base = await s.importKey('raw', baseBits, 'HKDF', false, ['deriveKey']);
  return { room: b64urlEncode(room), control, base };
}

/** The key of one session: both nonces go in, so neither side alone picks it and every session differs. */
export async function deriveSessionKey(base: LinkCryptoKey, deviceNonce: string, hostNonce: string): Promise<LinkCryptoKey> {
  const salt = utf8.encode(`${deviceNonce}.${hostNonce}`);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode('session') }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** IV ‖ AES-GCM(plain) with `aad` bound in. */
export async function seal(key: LinkCryptoKey, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: utf8.encode(aad) }, key, buf(plain)));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return out;
}

/** Opens what seal() made; throws when the key, the additional data or a single bit differs. */
export async function unseal(key: LinkCryptoKey, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (sealed.length < IV_BYTES + 16) throw new Error('sealed message too short');
  const iv = sealed.subarray(0, IV_BYTES);
  const ct = sealed.subarray(IV_BYTES);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv.slice()), additionalData: utf8.encode(aad) }, key, buf(ct.slice())));
}

/** The additional data of a control message: its topic and its sender. */
export const controlAad = (topic: string, from: string): string => `c|${topic}|${from}`;
/** The additional data of a data message: its session, direction and sequence number. */
export const dataAad = (sessionId: string, dir: 'd2h' | 'h2d', seq: number): string => `d|${sessionId}|${dir}|${seq}`;

export async function sealControl(key: LinkCryptoKey, message: object, aad: string): Promise<string> {
  return b64urlEncode(await seal(key, utf8.encode(JSON.stringify(message)), aad));
}

/** The control message inside `text`, or null when it does not open (another link, tampered, garbage). */
export async function openControl(key: LinkCryptoKey, text: unknown, aad: string): Promise<unknown> {
  if (typeof text !== 'string' || text.length > 64 * 1024) return null;
  try {
    return JSON.parse(fromUtf8.decode(await unseal(key, b64urlDecodeBytes(text), aad))) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Packing a data message: JSON → UTF-8 → (deflate-raw) with a one-byte flag in front

const RAW = 0;
const DEFLATE = 1;

/** Can this browser compress and decompress (both sides say so in hello / welcome)? */
export function linkCompression(): boolean {
  return typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(buf(data)).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw new Error('message too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A data message as bytes, compressed when `compress` and worth it. */
export async function packFrame(frame: object, compress: boolean): Promise<Uint8Array> {
  const json = utf8.encode(JSON.stringify(frame));
  if (compress && json.length > TRIAL_LINK.compressAboveBytes && linkCompression()) {
    const z = await through(json, new CompressionStream('deflate-raw'), TRIAL_LINK.maxMessageBytes);
    if (z.length < json.length) {
      const out = new Uint8Array(1 + z.length);
      out[0] = DEFLATE;
      out.set(z, 1);
      return out;
    }
  }
  const out = new Uint8Array(1 + json.length);
  out[0] = RAW;
  out.set(json, 1);
  return out;
}

/** What packFrame() packed (not yet checked: parseLinkFrame does that). */
export async function unpackFrame(bytes: Uint8Array): Promise<unknown> {
  const flag = bytes[0];
  const body = bytes.subarray(1);
  if (flag === RAW) return JSON.parse(fromUtf8.decode(body)) as unknown;
  if (flag === DEFLATE) {
    if (!linkCompression()) throw new Error('compressed message, but this browser cannot decompress');
    return JSON.parse(fromUtf8.decode(await through(body, new DecompressionStream('deflate-raw'), TRIAL_LINK.maxMessageBytes))) as unknown;
  }
  throw new Error('unknown message format');
}
