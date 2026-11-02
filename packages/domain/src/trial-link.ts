/**
 * «Подключить устройство» (browser trial): staff work from their own phones and tablets while the coffee
 * shop still lives in ONE browser tab — the cash desk, whose in-page HUB answers every device. Nothing of
 * the venue's database is kept on a device: its `fetch('/api/…')` and its live-updates stream are carried
 * to the cash desk and answered there exactly as for the cash desk's own screens (same staff keys, same
 * rights). Pure rules and data shapes; the WebCrypto envelope is trial-link-crypto.ts, the Supabase Realtime
 * client trial-link-realtime.ts, the browser parts apps/web/src/demo-hub/link-*.ts.
 *
 * Pairing: the cash desk makes a link secret (TRIAL_LINK.secretBytes random bytes, base64url) and shows it
 * once as a QR code / link `#/link/<secret>` (a hash: never sent to any server). Everything else is derived
 * from it: the Realtime room name (a hash, so Supabase cannot work back to the secret) and the keys that
 * encrypt every message end to end. A new secret («Отключить все устройства») cuts every device off.
 *
 * Transport: a WebRTC data channel peer to peer (inside the café Wi-Fi, free and fast) with the signalling —
 * and, when P2P cannot connect (a phone on 4G behind a strict NAT), the same encrypted chunks — relayed over
 * Supabase Realtime broadcast. Topics:
 *   lobby  `tsl-<room>`            devices say hello, the cash desk says «up» / «bye» (rare messages);
 *   pair   `tsl-<room>-<deviceId>` one per device: welcome, WebRTC offer/answer, relayed data (2 members,
 *                                   so a message costs 2 of the free plan's Realtime messages, not 1 + N).
 *
 * Session: hello (device nonce) → welcome (cash-desk nonce, session id) → both derive a session key from the
 * link secret and both nonces. Data messages carry a per-direction sequence number checked by a replay
 * window, so a message recorded on the wire cannot be played again, neither in its session nor in another.
 */

export const TRIAL_LINK = {
  /** Random bytes of a link secret: 256 bits, 43 characters of base64url. */
  secretBytes: 32,
  /** Random bytes of a device id (12 base64url characters) and of a handshake nonce. */
  deviceIdBytes: 9,
  nonceBytes: 16,
  /** Bytes of one chunk on the data channel (16 KiB is safe between every browser pair). */
  directChunkBytes: 16 * 1024,
  /** Bytes of one chunk relayed over Realtime: 96 KiB → 128 KiB of base64, under the 256 KB broadcast limit. */
  relayChunkBytes: 96 * 1024,
  /** A message is compressed (deflate-raw) above this size, when both sides can. */
  compressAboveBytes: 1024,
  /** Largest message either side accepts (a menu with photos, a big report). */
  maxMessageBytes: 32 * 1024 * 1024,
  /** Incomplete chunked messages are dropped after this long. */
  assembleTtlMs: 60_000,
  /** Relayed messages one browser sends per second at most (the free plan allows 100 per second per project). */
  relayPerSecond: 10,
  /** No welcome this long after a hello: the cash desk is not answering. */
  helloTimeoutMs: 6000,
  /** Hello again after a failure: 2 s doubling to 2 minutes (the cash desk also says «up» when it opens). */
  helloRetryMinMs: 2000,
  helloRetryMaxMs: 120_000,
  /** A request unanswered this long: ask the cash desk whether it is still there… */
  pingAfterMs: 6000,
  /** …and give the session up when nothing came back within this long. */
  pingTimeoutMs: 5000,
  /** A device that heard nothing from the cash desk this long checks the session when it needs it. */
  idlePingMs: 25_000,
  /** While the cash desk is being reached, a request waits this long before it fails like a lost network. */
  queueWaitMs: 8000,
  /** A request that may be resent (idempotent) is given up this long after its first try. */
  requestDeadlineMs: 45_000,
  /** WebRTC: ICE candidates are gathered at most this long before the offer/answer goes. */
  iceGatherMs: 2500,
  /** WebRTC: the data channel must open within this long, else the device stays on the relay… */
  directTimeoutMs: 10_000,
  /** …and tries peer to peer again after this long (doubling up to the maximum). */
  directRetryMs: 30_000,
  directRetryMaxMs: 10 * 60_000,
  /** Sequence numbers remembered by the replay window. */
  replayWindow: 2048,
  /** Answers the cash desk keeps per device for a resent request (same id → same answer, never run twice). */
  dedupeEntries: 300,
  dedupeTtlMs: 10 * 60_000,
  /**
   * A hello older or newer than this (by the cash desk's clock) is ignored: an old hello played again after the
   * cash desk restarted (its memory of nonces is gone) opens nothing. Generous, for tablets with a wrong clock.
   */
  helloMaxSkewMs: 24 * 60 * 60_000,
  /** The cash desk closes a session it heard nothing from this long (the device says hello again). */
  sessionIdleMs: 3 * 60_000,
  /** Change events within this long go to the devices as one message. */
  eventBatchMs: 25,
  /** Devices the cash desk remembers in its list. */
  maxDevices: 30,
} as const;

// ---------------------------------------------------------------------------
// The link address

/** What the link opens on the device: the staff sign-in, or the guest order board for a TV. */
export type LinkView = 'staff' | 'board';

const LINK_PATH = '/link/';

/** The shape of a link secret: base64url of TRIAL_LINK.secretBytes bytes (43 characters, no padding). */
export function isLinkSecret(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
}

/** The hash route a device opens: `#/link/<secret>` or `#/link/<secret>/board`. */
export function linkHash(secret: string, view: LinkView = 'staff'): string {
  return `#${LINK_PATH}${secret}${view === 'board' ? '/board' : ''}`;
}

/** The secret (and what to open) in a `#/link/<secret>[/board]` address, or null. */
export function linkFromHash(hash: string): { secret: string; view: LinkView } | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = (raw.split('?', 1)[0] ?? '').replace(/\/+$/, '');
  if (!path.startsWith(LINK_PATH)) return null;
  const [secret, view, ...rest] = path.slice(LINK_PATH.length).split('/');
  if (!isLinkSecret(secret) || rest.length > 0) return null;
  if (view === undefined) return { secret, view: 'staff' };
  return view === 'board' ? { secret, view: 'board' } : null;
}

/** A device id as the device makes it (base64url, TRIAL_LINK.deviceIdBytes bytes). */
export function isLinkDeviceId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,24}$/.test(v);
}

// ---------------------------------------------------------------------------
// Messages

export type LinkHeaders = Record<string, string>;

/** What a device tells the cash desk about itself (the list in «Подключить устройство»). */
export interface LinkDeviceInfo {
  /** «iPad · Safari», or the name typed on the sign-in page. */
  name: string;
  /** Who is signed in there right now (a name), null when nobody. */
  who: string | null;
  view: LinkView;
}

/** Control messages: encrypted with the link key (no session yet), on the lobby or a pair topic. */
export type LinkControl =
  /** Device → lobby: let us start a session (a fresh nonce for every hello). */
  | { t: 'hello'; d: string; n: string; at: number; z: boolean; info: LinkDeviceInfo }
  /** Cash desk → pair: the session (its nonce `n`, the device's nonce echoed as `nd`, session id `s`, cash-desk instance `hi`). */
  | { t: 'welcome'; d: string; nd: string; n: string; s: string; hi: string; at: number; z: boolean }
  /** Cash desk → lobby: it has just opened (devices say hello again at once). */
  | { t: 'up'; hi: string; at: number }
  /** Cash desk → lobby: the tab is closing. */
  | { t: 'bye'; hi: string }
  /** Cash desk → pair: «Отключить все устройства» — forget this link. */
  | { t: 'revoked'; d: string };

/** Data messages: inside a session, encrypted with the session key, over the data channel or the relay. */
export type LinkFrame =
  | { t: 'req'; id: string; m: string; u: string; h: LinkHeaders; b?: string }
  | { t: 'res'; id: string; s: number; h: LinkHeaders; b: string }
  /** Change events of the HUB (the `data` of each `changed` event). */
  | { t: 'ev'; e: string[] }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }
  | { t: 'sdp'; d: { type: 'offer' | 'answer'; sdp: string } }
  | { t: 'info'; info: LinkDeviceInfo }
  | { t: 'bye' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseHeaders(v: unknown): LinkHeaders | null {
  if (!isObj(v)) return null;
  const out: LinkHeaders = {};
  let n = 0;
  for (const [k, value] of Object.entries(v)) {
    if (++n > 64 || !isStr(k, 128) || !isStr(value, 8192)) return null;
    out[k.toLowerCase()] = value;
  }
  return out;
}

export function parseDeviceInfo(v: unknown): LinkDeviceInfo | null {
  if (!isObj(v)) return null;
  const name = isStr(v.name, 200) ? v.name.trim().slice(0, 120) : '';
  const who = isStr(v.who, 200) && v.who.trim() ? v.who.trim().slice(0, 120) : null;
  return { name: name || 'Устройство', who, view: v.view === 'board' ? 'board' : 'staff' };
}

/** A control message as received (after decryption), or null when it is not one. */
export function parseLinkControl(v: unknown): LinkControl | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'hello': {
      const info = parseDeviceInfo(v.info);
      if (!isLinkDeviceId(v.d) || !isStr(v.n, 64) || !isNum(v.at) || !info) return null;
      return { t: 'hello', d: v.d, n: v.n, at: v.at, z: v.z === true, info };
    }
    case 'welcome':
      if (!isLinkDeviceId(v.d) || !isStr(v.nd, 64) || !isStr(v.n, 64) || !isStr(v.s, 64) || !isStr(v.hi, 64) || !isNum(v.at)) return null;
      return { t: 'welcome', d: v.d, nd: v.nd, n: v.n, s: v.s, hi: v.hi, at: v.at, z: v.z === true };
    case 'up':
      return isStr(v.hi, 64) && isNum(v.at) ? { t: 'up', hi: v.hi, at: v.at } : null;
    case 'bye':
      return isStr(v.hi, 64) ? { t: 'bye', hi: v.hi } : null;
    case 'revoked':
      return isLinkDeviceId(v.d) ? { t: 'revoked', d: v.d } : null;
    default:
      return null;
  }
}

/** Largest request body a device may send (a photo for the menu is the big one). */
const MAX_BODY = 12 * 1024 * 1024;

/** A data message as received (after decryption), or null when it is not one. */
export function parseLinkFrame(v: unknown): LinkFrame | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'req': {
      const h = parseHeaders(v.h);
      if (!isStr(v.id, 64) || !isStr(v.m, 10) || !isStr(v.u, 4096) || !h) return null;
      if (v.b !== undefined && !isStr(v.b, MAX_BODY)) return null;
      return { t: 'req', id: v.id, m: v.m.toUpperCase(), u: v.u, h, ...(v.b !== undefined ? { b: v.b as string } : {}) };
    }
    case 'res': {
      const h = parseHeaders(v.h);
      if (!isStr(v.id, 64) || !isNum(v.s) || !h || typeof v.b !== 'string') return null;
      return { t: 'res', id: v.id, s: v.s, h, b: v.b };
    }
    case 'ev':
      return Array.isArray(v.e) && v.e.length <= 1000 && v.e.every((x) => isStr(x, 65536)) ? { t: 'ev', e: v.e as string[] } : null;
    case 'ping':
    case 'pong':
      return isNum(v.at) ? { t: v.t, at: v.at } : null;
    case 'sdp': {
      const d = v.d;
      if (!isObj(d) || (d.type !== 'offer' && d.type !== 'answer') || !isStr(d.sdp, 64 * 1024)) return null;
      return { t: 'sdp', d: { type: d.type, sdp: d.sdp } };
    }
    case 'info': {
      const info = parseDeviceInfo(v.info);
      return info ? { t: 'info', info } : null;
    }
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

/** Only the HUB's API goes over the link — never another site, never the cash desk's own pages. */
export function linkPathAllowed(url: string): boolean {
  if (!url.startsWith('/api/') || url.length > 4096) return false;
  const path = url.split('?', 1)[0] ?? '';
  return !path.includes('..') && !path.includes('\\');
}

// ---------------------------------------------------------------------------
// Chunks: one sealed message → numbered pieces that fit the transport, and back

/** Chunk header: kind (1 byte), message sequence (uint32), index (uint16), count (uint16). */
export const LINK_CHUNK_HEADER = 9;
const CHUNK_KIND = 1;

export function splitChunks(seq: number, data: Uint8Array, maxChunkBytes: number): Uint8Array[] {
  const room = maxChunkBytes - LINK_CHUNK_HEADER;
  if (room < 1) throw new Error('chunk size too small');
  const count = Math.max(1, Math.ceil(data.length / room));
  if (count > 0xffff) throw new Error('message too large');
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = data.subarray(i * room, Math.min(data.length, (i + 1) * room));
    const chunk = new Uint8Array(LINK_CHUNK_HEADER + part.length);
    const view = new DataView(chunk.buffer);
    view.setUint8(0, CHUNK_KIND);
    view.setUint32(1, seq >>> 0);
    view.setUint16(5, i);
    view.setUint16(7, count);
    chunk.set(part, LINK_CHUNK_HEADER);
    out.push(chunk);
  }
  return out;
}

export function readChunkHeader(chunk: Uint8Array): { seq: number; index: number; count: number } | null {
  if (chunk.length < LINK_CHUNK_HEADER) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (view.getUint8(0) !== CHUNK_KIND) return null;
  const seq = view.getUint32(1);
  const index = view.getUint16(5);
  const count = view.getUint16(7);
  if (count === 0 || index >= count) return null;
  return { seq, index, count };
}

interface Assembling {
  parts: Array<Uint8Array | undefined>;
  have: number;
  bytes: number;
  startedAt: number;
}

/**
 * Puts chunks back together. Chunks of one message may come in any order and twice (a resend over the other
 * path); a message is returned once, when its last missing piece arrives. Oversized and stale messages are dropped.
 */
export class ChunkAssembler {
  readonly #open = new Map<number, Assembling>();
  readonly #maxBytes: number;
  readonly #ttlMs: number;

  constructor(opts: { maxBytes?: number; ttlMs?: number } = {}) {
    this.#maxBytes = opts.maxBytes ?? TRIAL_LINK.maxMessageBytes;
    this.#ttlMs = opts.ttlMs ?? TRIAL_LINK.assembleTtlMs;
  }

  push(chunk: Uint8Array, now: number): { seq: number; data: Uint8Array } | null {
    const head = readChunkHeader(chunk);
    if (!head) return null;
    const body = chunk.subarray(LINK_CHUNK_HEADER);
    if (head.count === 1) return { seq: head.seq, data: body.slice() };
    this.#sweep(now);
    let p = this.#open.get(head.seq);
    // The same message resent with another chunk size (the data channel closed mid-way, now the relay): start over.
    if (p && p.parts.length !== head.count) {
      this.#open.delete(head.seq);
      p = undefined;
    }
    if (!p) {
      p = { parts: new Array<Uint8Array | undefined>(head.count), have: 0, bytes: 0, startedAt: now };
      this.#open.set(head.seq, p);
    }
    if (p.parts[head.index]) return null;
    p.bytes += body.length;
    if (p.bytes > this.#maxBytes) {
      this.#open.delete(head.seq);
      return null;
    }
    p.parts[head.index] = body.slice();
    p.have++;
    if (p.have < head.count) return null;
    this.#open.delete(head.seq);
    const data = new Uint8Array(p.bytes);
    let at = 0;
    for (const part of p.parts) {
      data.set(part!, at);
      at += part!.length;
    }
    return { seq: head.seq, data };
  }

  /** Messages still waiting for pieces. */
  get pending(): number {
    return this.#open.size;
  }

  #sweep(now: number): void {
    for (const [seq, p] of this.#open) if (now - p.startedAt > this.#ttlMs) this.#open.delete(seq);
  }
}

// ---------------------------------------------------------------------------
// Replay window: each sequence number of a direction is accepted once

export class ReplayWindow {
  #max = 0;
  readonly #seen = new Set<number>();
  readonly #size: number;

  constructor(size: number = TRIAL_LINK.replayWindow) {
    this.#size = size;
  }

  /** True the first time `seq` (≥ 1) is seen, unless it is older than the window. */
  accept(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 1) return false;
    if (seq <= this.#max - this.#size) return false;
    if (this.#seen.has(seq)) return false;
    this.#seen.add(seq);
    if (seq > this.#max) {
      this.#max = seq;
      if (this.#seen.size > this.#size * 2) for (const s of this.#seen) if (s <= this.#max - this.#size) this.#seen.delete(s);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Requests: matching answers, waiting for the cash desk, resending only what is safe to resend

/**
 * May a request that was lost on the way be sent again? Anything not sent yet may. Reads may. A write may
 * only with its Idempotency-Key: the HUB runs a key once and replays the answer (apps/hub/src/idempotency.ts),
 * and the cash desk also answers a repeated request id from its own memory (LinkDedupe). A write without a
 * key that may have reached the cash desk fails instead — it is never silently run twice.
 */
export function linkResendable(method: string, headers: LinkHeaders, sent: boolean): boolean {
  if (!sent) return true;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const key = headers['idempotency-key'];
  return typeof key === 'string' && key.length >= 8;
}

export type LinkRequestFrame = Extract<LinkFrame, { t: 'req' }>;
export type LinkResponseFrame = Extract<LinkFrame, { t: 'res' }>;

/** Why a request failed: the cash desk could not be reached, the session broke after it was sent, or too late. */
export type LinkFailure = 'offline' | 'lost' | 'timeout';

interface Pending {
  frame: LinkRequestFrame;
  firstAt: number;
  /** When it (last) joined the queue. */
  queuedAt: number;
  /** When it went out in the current session; null while queued. */
  sentAt: number | null;
  /** Ever sent (in any session): a write without a key is then never resent. */
  everSent: boolean;
  resolve: (res: LinkResponseFrame) => void;
  reject: (why: LinkFailure) => void;
}

/** The device's open requests: queued until a session is up, sent, answered once. */
export class LinkRequests {
  readonly #open = new Map<string, Pending>();

  add(frame: LinkRequestFrame, now: number, resolve: (res: LinkResponseFrame) => void, reject: (why: LinkFailure) => void): void {
    this.#open.set(frame.id, { frame, firstAt: now, queuedAt: now, sentAt: null, everSent: false, resolve, reject });
  }

  /** Requests waiting to go out, oldest first. */
  queued(): LinkRequestFrame[] {
    return [...this.#open.values()].filter((p) => p.sentAt === null).map((p) => p.frame);
  }

  markSent(id: string, now: number): void {
    const p = this.#open.get(id);
    if (!p) return;
    p.sentAt = now;
    p.everSent = true;
  }

  /** An answer: resolves its request once; a late or repeated answer is ignored (false). */
  settle(res: LinkResponseFrame): boolean {
    const p = this.#open.get(res.id);
    if (!p) return false;
    this.#open.delete(res.id);
    p.resolve(res);
    return true;
  }

  /** The request was given up by the page (an aborted fetch). */
  drop(id: string): void {
    this.#open.delete(id);
  }

  /**
   * The session broke: what may be resent goes back to the queue (same id, so the cash desk answers it from
   * memory if it already ran), a write without a key that may have arrived fails with 'lost'.
   */
  sessionLost(now: number): number {
    let failed = 0;
    for (const [id, p] of this.#open) {
      if (p.sentAt === null) continue;
      if (linkResendable(p.frame.m, p.frame.h, p.everSent)) {
        p.sentAt = null;
        p.queuedAt = now;
      } else {
        this.#open.delete(id);
        failed++;
        p.reject('lost');
      }
    }
    return failed;
  }

  /**
   * The data channel closed but the session lives on the relay: answers in flight over it may be lost, so what
   * may be resent goes again (the cash desk answers a repeated id from memory); a keyless write keeps waiting.
   */
  resendSent(now: number): number {
    let n = 0;
    for (const p of this.#open.values()) {
      if (p.sentAt === null || !linkResendable(p.frame.m, p.frame.h, true)) continue;
      p.sentAt = null;
      p.queuedAt = now;
      n++;
    }
    return n;
  }

  /**
   * Gives up what waited too long: queued requests after `queueWaitMs` while the cash desk is not reached
   * (immediately when it is known to be away: `queueWaitMs` 0), anything after the overall deadline.
   */
  expire(now: number, queueWaitMs: number, deadlineMs: number = TRIAL_LINK.requestDeadlineMs): number {
    let n = 0;
    for (const [id, p] of this.#open) {
      const queuedTooLong = p.sentAt === null && now - p.queuedAt >= queueWaitMs;
      const tooLate = now - p.firstAt >= deadlineMs;
      if (!queuedTooLong && !tooLate) continue;
      this.#open.delete(id);
      n++;
      p.reject(tooLate ? 'timeout' : 'offline');
    }
    return n;
  }

  /** How long the oldest request sent in this session has waited for its answer (0 when none). */
  oldestWaitMs(now: number): number {
    let oldest = 0;
    for (const p of this.#open.values()) if (p.sentAt !== null) oldest = Math.max(oldest, now - p.sentAt);
    return oldest;
  }

  get size(): number {
    return this.#open.size;
  }

  /** Everything fails (the link was switched off). */
  failAll(why: LinkFailure): void {
    const all = [...this.#open.values()];
    this.#open.clear();
    for (const p of all) p.reject(why);
  }
}

/**
 * The cash desk's memory of answers per device and request id: a request resent after a lost answer gets
 * the same answer (or waits for the one in progress) instead of running again. Least recently used goes first.
 */
export class LinkDedupe<V> {
  readonly #map = new Map<string, { value: V; at: number }>();
  readonly #max: number;
  readonly #ttlMs: number;

  constructor(max: number = TRIAL_LINK.dedupeEntries, ttlMs: number = TRIAL_LINK.dedupeTtlMs) {
    this.#max = max;
    this.#ttlMs = ttlMs;
  }

  get(key: string, now: number): V | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.#ttlMs) {
      this.#map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now: number): void {
    this.#map.delete(key);
    this.#map.set(key, { value, at: now });
    while (this.#map.size > this.#max) {
      const first = this.#map.keys().next().value as string;
      this.#map.delete(first);
    }
  }

  get size(): number {
    return this.#map.size;
  }
}

// ---------------------------------------------------------------------------
// The device's connection: a small state machine (no timers inside — it says what to schedule)

/**
 * connecting — a hello is out (first try, or right after a session broke);
 * up         — a session works (over the relay, or `direct` peer to peer);
 * down       — the cash desk did not answer: «Касса не отвечает», a hello again later;
 * revoked    — the link was switched off at the cash desk.
 */
export type LinkPhase = 'connecting' | 'up' | 'down' | 'revoked';

export interface LinkMachine {
  phase: LinkPhase;
  /** Failed hellos in a row (backoff). */
  attempt: number;
  /** A hello is out and its welcome is awaited (else, in 'down', the next hello is scheduled). */
  waiting: boolean;
  /** The session runs over the data channel. */
  direct: boolean;
  /** When the phase last changed. */
  since: number;
}

export type LinkInput =
  | 'start'
  | 'welcome'
  /** The scheduled timer fired (a hello timed out, or the backoff is over). */
  | 'timer'
  /** The session broke (no answer to a ping, the cash desk forgot it). */
  | 'lost'
  /** The cash desk opened (its «up» on the lobby). */
  | 'host-up'
  /** The cash desk tab is closing (its «bye»). */
  | 'host-bye'
  /** «Повторить», the page came back on screen, the network came back. */
  | 'retry'
  | 'revoked'
  | 'direct-up'
  | 'direct-down';

export interface LinkEffects {
  /** Send a hello now (with a fresh nonce). */
  hello?: true;
  /** (Re)arm the one timer: fire 'timer' after this long; null — cancel it. */
  timer?: number | null;
  /** A session is up: send the queued requests, start peer to peer. */
  flush?: true;
  /** The session is gone: put resendable requests back in the queue, fail the rest. */
  lost?: true;
  /** The cash desk is away: queued requests fail now instead of waiting. */
  failQueued?: true;
}

export const LINK_START: LinkMachine = { phase: 'connecting', attempt: 0, waiting: false, direct: false, since: 0 };

/** The pause before the next hello after `attempt` failures, with ±20 % jitter (`rand` in [0, 1)). */
export function helloRetryMs(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(TRIAL_LINK.helloRetryMaxMs, TRIAL_LINK.helloRetryMinMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * rand));
}

export function linkStep(m: LinkMachine, input: LinkInput, now: number, rand: number = Math.random()): { m: LinkMachine; fx: LinkEffects } {
  if (m.phase === 'revoked') return { m, fx: {} };
  const hello = (phase: LinkPhase, attempt: number): { m: LinkMachine; fx: LinkEffects } => ({
    m: { phase, attempt, waiting: true, direct: false, since: phase === m.phase ? m.since : now },
    fx: { hello: true, timer: TRIAL_LINK.helloTimeoutMs },
  });
  switch (input) {
    case 'start':
      return hello('connecting', 0);
    case 'welcome':
      return { m: { phase: 'up', attempt: 0, waiting: false, direct: false, since: now }, fx: { flush: true, timer: null } };
    case 'timer': {
      if (m.phase === 'up') return { m, fx: {} };
      if (m.waiting) {
        // No welcome: the cash desk is not answering. Hello again after a pause.
        const attempt = m.attempt + 1;
        return {
          m: { phase: 'down', attempt, waiting: false, direct: false, since: m.phase === 'down' ? m.since : now },
          fx: { timer: helloRetryMs(attempt, rand), failQueued: true },
        };
      }
      return hello('down', m.attempt);
    }
    case 'lost': {
      if (m.phase !== 'up') return { m, fx: {} };
      const next = hello('connecting', 0);
      return { m: next.m, fx: { ...next.fx, lost: true } };
    }
    case 'host-bye': {
      if (m.phase !== 'up') return { m, fx: {} };
      // The cash desk says «up» when it opens again; until then a slow hello now and then.
      return {
        m: { phase: 'down', attempt: 1, waiting: false, direct: false, since: now },
        fx: { lost: true, failQueued: true, timer: helloRetryMs(4, rand) },
      };
    }
    case 'host-up': {
      // A new cash-desk instance: an old session is dead even if it looked up.
      if (m.phase !== 'up') return hello(m.phase, 0);
      const next = hello('connecting', 0);
      return { m: next.m, fx: { ...next.fx, lost: true } };
    }
    case 'retry':
      if (m.phase === 'up' || m.waiting) return { m, fx: {} };
      return hello(m.phase, m.attempt);
    case 'revoked':
      return { m: { ...m, phase: 'revoked', waiting: false, direct: false, since: now }, fx: { timer: null, failQueued: true, lost: true } };
    case 'direct-up':
      return m.phase === 'up' ? { m: { ...m, direct: true }, fx: {} } : { m, fx: {} };
    case 'direct-down':
      return { m: { ...m, direct: false }, fx: {} };
  }
}

/** What the device's status line says. */
export type LinkStatus = 'connecting' | 'online' | 'offline' | 'revoked';

export function linkStatus(m: LinkMachine): LinkStatus {
  switch (m.phase) {
    case 'up':
      return 'online';
    case 'connecting':
      return 'connecting';
    case 'down':
      return 'offline';
    case 'revoked':
      return 'revoked';
  }
}

// ---------------------------------------------------------------------------
// Base64 for relayed chunks (fast for big pieces; base64url for ids lives in license.ts)

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
