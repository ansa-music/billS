/**
 * «Подключить устройство»: one session between the cash desk and a device, the same on both sides. A
 * message (packages/domain trial-link.ts LinkFrame) is packed (JSON, deflate-raw when worth it), sealed with
 * the session key (AES-GCM, bound to session / direction / sequence number), cut into numbered chunks and
 * sent over the data channel when it is open — else over the relay (Realtime broadcast, several chunks of
 * one moment in one broadcast). Received chunks are put back together, opened, checked against the replay
 * window and handed on in arrival order.
 */
import type { LinkCryptoKey, LinkFrame } from '@bills/domain';
import { base64ToBytes, bytesToBase64, ChunkAssembler, dataAad, packFrame, parseLinkFrame, ReplayWindow, seal, splitChunks, TRIAL_LINK, unpackFrame, unseal } from '@bills/domain';

/** One relayed broadcast carries chunks of up to this many base64 characters together (under Realtime's 256 KB). */
const RELAY_BATCH_CHARS = 180_000;
/** The data channel's send buffer: wait above the high mark until it drains to the low one. */
const DC_HIGH = 1024 * 1024;
const DC_LOW = 256 * 1024;

export interface LinkSessionOptions {
  id: string;
  key: LinkCryptoKey;
  /** This side's sending direction (the other side receives the opposite). */
  out: 'd2h' | 'h2d';
  /** Both sides can (de)compress. */
  compress: boolean;
  /** Relay these base64 chunks as one broadcast on the pair topic. */
  relay(chunks: string[]): void;
  onFrame(frame: LinkFrame): void;
}

export class LinkSession {
  readonly id: string;
  /** When a valid message last came from the other side. */
  lastHeard = Date.now();
  closed = false;
  readonly #opts: LinkSessionOptions;
  readonly #in: 'd2h' | 'h2d';
  #seq = 0;
  readonly #window = new ReplayWindow();
  readonly #asm = new ChunkAssembler();
  #dc: RTCDataChannel | null = null;
  #chain: Promise<void> = Promise.resolve();
  readonly #relayQueue: string[] = [];
  #relayScheduled = false;

  constructor(opts: LinkSessionOptions) {
    this.#opts = opts;
    this.id = opts.id;
    this.#in = opts.out === 'd2h' ? 'h2d' : 'd2h';
  }

  /** Messages go peer to peer right now. */
  get direct(): boolean {
    return this.#dc?.readyState === 'open';
  }

  get channel(): RTCDataChannel | null {
    return this.#dc;
  }

  /** Use this open data channel (null: back to the relay). */
  setChannel(dc: RTCDataChannel | null): void {
    if (this.#dc && this.#dc !== dc) this.#dc.onmessage = null;
    this.#dc = dc;
    if (!dc) return;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = DC_LOW;
    dc.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.receive(new Uint8Array(e.data));
    };
  }

  async send(frame: LinkFrame): Promise<void> {
    if (this.closed) return;
    const seq = ++this.#seq;
    const sealed = await seal(this.#opts.key, await packFrame(frame, this.#opts.compress), dataAad(this.id, this.#opts.out, seq));
    if (this.closed) return;
    const dc = this.#dc;
    if (dc && dc.readyState === 'open') {
      try {
        await sendDirect(dc, splitChunks(seq, sealed, TRIAL_LINK.directChunkBytes));
        return;
      } catch {
        // The channel closed half-way: the whole message goes over the relay (same number, bigger chunks).
      }
    }
    if (this.closed) return;
    for (const c of splitChunks(seq, sealed, TRIAL_LINK.relayChunkBytes)) this.#relayQueue.push(bytesToBase64(c));
    if (!this.#relayScheduled) {
      this.#relayScheduled = true;
      setTimeout(() => this.#flushRelay(), 0);
    }
  }

  #flushRelay(): void {
    this.#relayScheduled = false;
    let batch: string[] = [];
    let chars = 0;
    for (const c of this.#relayQueue.splice(0)) {
      if (batch.length > 0 && chars + c.length > RELAY_BATCH_CHARS) {
        this.#opts.relay(batch);
        batch = [];
        chars = 0;
      }
      batch.push(c);
      chars += c.length;
    }
    if (batch.length > 0) this.#opts.relay(batch);
  }

  /** Chunks that came over the relay (`x` of the broadcast). */
  receiveRelay(x: unknown): void {
    if (!Array.isArray(x)) return;
    for (const c of x) {
      if (typeof c !== 'string') continue;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(c);
      } catch {
        continue;
      }
      this.receive(bytes);
    }
  }

  /** One chunk from either path; complete messages are handled one after another, in arrival order. */
  receive(chunk: Uint8Array): void {
    if (this.closed) return;
    const whole = this.#asm.push(chunk, Date.now());
    if (!whole) return;
    this.#chain = this.#chain.then(() => this.#open(whole.seq, whole.data)).catch(() => undefined);
  }

  async #open(seq: number, data: Uint8Array): Promise<void> {
    if (this.closed) return;
    let plain: Uint8Array;
    try {
      plain = await unseal(this.#opts.key, data, dataAad(this.id, this.#in, seq));
    } catch {
      return; // Not from the other side of this session (or damaged): dropped without a trace.
    }
    // Only after it opened: forged chunks cannot use up sequence numbers.
    if (!this.#window.accept(seq)) return;
    this.lastHeard = Date.now();
    let frame: LinkFrame | null;
    try {
      frame = parseLinkFrame(await unpackFrame(plain));
    } catch {
      return;
    }
    if (frame && !this.closed) this.#opts.onFrame(frame);
  }

  close(): void {
    this.closed = true;
    this.#relayQueue.length = 0;
    if (this.#dc) this.#dc.onmessage = null;
    this.#dc = null;
  }
}

function drained(dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', fail);
      resolve();
    };
    const fail = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', fail);
      reject(new Error('data channel closed'));
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', fail);
  });
}

async function sendDirect(dc: RTCDataChannel, chunks: Uint8Array[]): Promise<void> {
  for (const c of chunks) {
    if (dc.readyState !== 'open') throw new Error('data channel closed');
    if (dc.bufferedAmount > DC_HIGH) await drained(dc);
    dc.send(c.buffer instanceof ArrayBuffer && c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c.buffer : c.slice().buffer);
  }
}
