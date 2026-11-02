/**
 * «Подключить устройство»: a minimal Supabase Realtime client — broadcast only, over the Phoenix protocol
 * (`vsn=1.0.0`, JSON frames), the same wire supabase-js speaks:
 *
 *   wss://<project>.supabase.co/realtime/v1/websocket?apikey=<anon key>&vsn=1.0.0
 *   → {topic:"realtime:<name>", event:"phx_join", payload:{config:{broadcast:{self:false,ack:false},
 *        presence:{key:"",enabled:false}, postgres_changes:[], private:false}, access_token:<anon key>}, ref, join_ref}
 *   ← {topic, event:"phx_reply", payload:{status:"ok"|"error", response}, ref}
 *   ↔ {topic, event:"broadcast", payload:{type:"broadcast", event, payload}, ref, join_ref}
 *   → {topic:"phoenix", event:"heartbeat", payload:{}, ref} every 25 s (an unanswered one drops the socket)
 *
 * Public channels (no Realtime Authorization policies needed): the room name and the end-to-end encryption
 * (trial-link-crypto.ts), not the channel, keep a café's messages to itself. It reconnects and rejoins on
 * its own, buffers sends briefly while a topic is (re)joining, and paces broadcasts (TRIAL_LINK.relayPerSecond)
 * to stay well inside the free plan's 100 messages per second per project. The socket is injected, so the
 * protocol is tested in Node without a server (packages/domain/test/trial-link-realtime.test.ts).
 */
import { TRIAL_LINK } from './trial-link.ts';

/** The part of a browser WebSocket this client uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const HEARTBEAT_MS = 25_000;
const JOIN_TIMEOUT_MS = 10_000;
const REJOIN_MS = 3000;
const RECONNECT_MS = [1000, 2000, 5000, 10_000, 15_000] as const;
/** Sends kept while a topic is not joined, and for how long. */
const BUFFER_MAX = 100;
const BUFFER_TTL_MS = 20_000;

/** `https://x.supabase.co` → the Realtime WebSocket address with the public key and protocol version. */
export function realtimeSocketUrl(base: string, apikey: string): string {
  const root = base.trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
  return `${root}/realtime/v1/websocket?apikey=${encodeURIComponent(apikey)}&vsn=1.0.0`;
}

export interface RealtimeOptions {
  /** The project address (https://<project>.supabase.co). */
  url: string;
  /** The public anon / publishable key. */
  apikey: string;
  socket: SocketFactory;
  /** The socket went up (true) or down (false). */
  onStatus?: (up: boolean) => void;
  /** Broadcast pushes per second at most. */
  perSecond?: number;
  heartbeatMs?: number;
}

export type BroadcastHandler = (event: string, payload: unknown) => void;

export interface RealtimeTopic {
  readonly name: string;
  readonly joined: boolean;
  /**
   * Queues a broadcast: sent at once when joined (paced), else when the join succeeds (dropped after 20 s).
   * `urgent` skips the pacing (a «bye» while the page closes cannot wait for its turn).
   */
  send(event: string, payload: unknown, urgent?: boolean): void;
  /** Resolves when the topic is joined (now, or after the next successful join). */
  ready(): Promise<void>;
  leave(): void;
}

interface Topic {
  name: string;
  handler: BroadcastHandler;
  onJoined: ((joined: boolean) => void) | undefined;
  joined: boolean;
  joinRef: string | null;
  joinTimer: ReturnType<typeof setTimeout> | undefined;
  rejoinTimer: ReturnType<typeof setTimeout> | undefined;
  buffer: Array<{ event: string; payload: unknown; at: number }>;
  waiters: Array<() => void>;
  left: boolean;
}

interface PhxMessage {
  topic: string;
  event: string;
  payload: unknown;
  ref: string | null;
  join_ref?: string | null;
}

export class RealtimeLink {
  readonly #opts: RealtimeOptions;
  readonly #topics = new Map<string, Topic>();
  #ws: SocketLike | null = null;
  #ref = 0;
  #up = false;
  #closed = true;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pendingHeartbeat: string | null = null;
  /** Paced broadcasts waiting for their turn. */
  readonly #outbox: string[] = [];
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #lastSent = Number.NEGATIVE_INFINITY;

  constructor(opts: RealtimeOptions) {
    this.#opts = opts;
  }

  get connected(): boolean {
    return this.#up;
  }

  connect(): void {
    if (!this.#closed) return;
    this.#closed = false;
    this.#open();
  }

  /** Reconnect now (the network came back, the page is on screen again) instead of waiting for the backoff. */
  nudge(): void {
    if (this.#closed || this.#up) return;
    clearTimeout(this.#reconnectTimer);
    this.#attempt = 0;
    if (!this.#ws) this.#open();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#heartbeat);
    clearTimeout(this.#drainTimer);
    this.#outbox.length = 0;
    for (const t of this.#topics.values()) this.#reset(t);
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        // Already closed.
      }
    }
    this.#setUp(false);
  }

  join(name: string, handler: BroadcastHandler, onJoined?: (joined: boolean) => void): RealtimeTopic {
    const existing = this.#topics.get(name);
    if (existing) {
      existing.handler = handler;
      existing.onJoined = onJoined;
      return this.#facade(existing);
    }
    const t: Topic = {
      name,
      handler,
      onJoined,
      joined: false,
      joinRef: null,
      joinTimer: undefined,
      rejoinTimer: undefined,
      buffer: [],
      waiters: [],
      left: false,
    };
    this.#topics.set(name, t);
    if (this.#up) this.#join(t);
    return this.#facade(t);
  }

  #facade(t: Topic): RealtimeTopic {
    return {
      name: t.name,
      get joined() {
        return t.joined;
      },
      send: (event, payload, urgent) => this.#send(t, event, payload, urgent === true),
      ready: () => (t.joined ? Promise.resolve() : new Promise<void>((resolve) => t.waiters.push(resolve))),
      leave: () => this.#leave(t),
    };
  }

  // -- socket ----------------------------------------------------------------

  #open(): void {
    let ws: SocketLike;
    try {
      ws = this.#opts.socket(realtimeSocketUrl(this.#opts.url, this.#opts.apikey));
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#attempt = 0;
      this.#setUp(true);
      this.#pendingHeartbeat = null;
      clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#beat(), this.#opts.heartbeatMs ?? HEARTBEAT_MS);
      for (const t of this.#topics.values()) this.#join(t);
    };
    ws.onmessage = (ev) => {
      if (this.#ws !== ws) return;
      this.#receive(ev.data);
    };
    ws.onerror = () => {
      // onclose follows.
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#dropSocket();
    };
  }

  #dropSocket(): void {
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    clearInterval(this.#heartbeat);
    clearTimeout(this.#drainTimer);
    this.#outbox.length = 0;
    for (const t of this.#topics.values()) this.#reset(t, true);
    this.#setUp(false);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    clearTimeout(this.#reconnectTimer);
    const ms = RECONNECT_MS[Math.min(this.#attempt, RECONNECT_MS.length - 1)]!;
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      if (!this.#closed && !this.#ws) this.#open();
    }, ms);
  }

  #setUp(up: boolean): void {
    if (this.#up === up) return;
    this.#up = up;
    this.#opts.onStatus?.(up);
  }

  #beat(): void {
    if (this.#pendingHeartbeat !== null) {
      // The last heartbeat was never answered: the connection is dead even if the browser has not noticed.
      this.#dropSocket();
      return;
    }
    const ref = this.#nextRef();
    this.#pendingHeartbeat = ref;
    this.#raw({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref });
  }

  #nextRef(): string {
    this.#ref = (this.#ref + 1) % 1_000_000_000;
    return String(this.#ref);
  }

  #raw(msg: PhxMessage): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: PhxMessage;
    try {
      msg = JSON.parse(data) as PhxMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.topic !== 'string' || typeof msg.event !== 'string') return;
    if (msg.topic === 'phoenix') {
      if (msg.event === 'phx_reply' && msg.ref === this.#pendingHeartbeat) this.#pendingHeartbeat = null;
      return;
    }
    const name = msg.topic.startsWith('realtime:') ? msg.topic.slice('realtime:'.length) : msg.topic;
    const t = this.#topics.get(name);
    if (!t) return;
    switch (msg.event) {
      case 'phx_reply': {
        if (msg.ref !== t.joinRef || t.joined) return;
        clearTimeout(t.joinTimer);
        const status = (msg.payload as { status?: unknown } | null)?.status;
        if (status === 'ok') {
          t.joined = true;
          t.onJoined?.(true);
          const waiters = t.waiters.splice(0);
          for (const w of waiters) w();
          this.#flushBuffer(t);
        } else {
          t.joinRef = null;
          this.#rejoinLater(t);
        }
        return;
      }
      case 'phx_error':
      case 'phx_close': {
        if (msg.join_ref !== undefined && msg.join_ref !== null && msg.join_ref !== t.joinRef) return;
        const was = t.joined;
        this.#reset(t);
        if (was) t.onJoined?.(false);
        this.#rejoinLater(t);
        return;
      }
      case 'broadcast': {
        const p = msg.payload as { event?: unknown; payload?: unknown } | null;
        if (!p || typeof p.event !== 'string') return;
        try {
          t.handler(p.event, p.payload);
        } catch {
          // A handler's bug must not break the socket.
        }
        return;
      }
      default:
        // presence_state, system messages and the like: not used.
        return;
    }
  }

  // -- topics ----------------------------------------------------------------

  #join(t: Topic): void {
    if (t.left || !this.#up) return;
    clearTimeout(t.joinTimer);
    clearTimeout(t.rejoinTimer);
    const ref = this.#nextRef();
    t.joinRef = ref;
    t.joined = false;
    const sent = this.#raw({
      topic: `realtime:${t.name}`,
      event: 'phx_join',
      payload: {
        config: { broadcast: { self: false, ack: false }, presence: { key: '', enabled: false }, postgres_changes: [], private: false },
        access_token: this.#opts.apikey,
      },
      ref,
      join_ref: ref,
    });
    if (!sent) return;
    t.joinTimer = setTimeout(() => {
      if (!t.joined && t.joinRef === ref) {
        t.joinRef = null;
        this.#join(t);
      }
    }, JOIN_TIMEOUT_MS);
  }

  #rejoinLater(t: Topic): void {
    if (t.left) return;
    clearTimeout(t.rejoinTimer);
    t.rejoinTimer = setTimeout(() => this.#join(t), REJOIN_MS);
  }

  #reset(t: Topic, keepBuffer = false): void {
    clearTimeout(t.joinTimer);
    clearTimeout(t.rejoinTimer);
    const was = t.joined;
    t.joined = false;
    t.joinRef = null;
    if (!keepBuffer) t.buffer.length = 0;
    if (was && keepBuffer) t.onJoined?.(false);
  }

  #leave(t: Topic): void {
    if (t.left) return;
    t.left = true;
    if (t.joined && t.joinRef) this.#raw({ topic: `realtime:${t.name}`, event: 'phx_leave', payload: {}, ref: this.#nextRef(), join_ref: t.joinRef });
    this.#reset(t);
    this.#topics.delete(t.name);
  }

  #send(t: Topic, event: string, payload: unknown, urgent = false): void {
    if (t.left) return;
    if (urgent && t.joined) {
      this.#raw({ topic: `realtime:${t.name}`, event: 'broadcast', payload: { type: 'broadcast', event, payload }, ref: this.#nextRef(), join_ref: t.joinRef });
      return;
    }
    if (!t.joined) {
      t.buffer.push({ event, payload, at: Date.now() });
      if (t.buffer.length > BUFFER_MAX) t.buffer.shift();
      return;
    }
    this.#enqueue(t, event, payload);
  }

  #flushBuffer(t: Topic): void {
    const now = Date.now();
    const items = t.buffer.splice(0).filter((b) => now - b.at <= BUFFER_TTL_MS);
    for (const b of items) this.#enqueue(t, b.event, b.payload);
  }

  #enqueue(t: Topic, event: string, payload: unknown): void {
    const msg: PhxMessage = {
      topic: `realtime:${t.name}`,
      event: 'broadcast',
      payload: { type: 'broadcast', event, payload },
      ref: this.#nextRef(),
      join_ref: t.joinRef,
    };
    this.#outbox.push(JSON.stringify(msg));
    this.#drain();
  }

  #drain(): void {
    if (this.#drainTimer !== undefined) return;
    const gap = Math.ceil(1000 / (this.#opts.perSecond ?? TRIAL_LINK.relayPerSecond));
    const step = () => {
      this.#drainTimer = undefined;
      const ws = this.#ws;
      if (!ws || ws.readyState !== OPEN) return;
      const wait = this.#lastSent + gap - Date.now();
      if (wait > 0) {
        this.#drainTimer = setTimeout(step, wait);
        return;
      }
      const next = this.#outbox.shift();
      if (next === undefined) return;
      try {
        ws.send(next);
      } catch {
        // The socket is closing: onclose handles the rest.
      }
      this.#lastSent = Date.now();
      if (this.#outbox.length > 0) this.#drainTimer = setTimeout(step, gap);
    };
    step();
  }

  /** Broadcasts waiting for their turn (tests, diagnostics). */
  get backlog(): number {
    return this.#outbox.length;
  }
}
