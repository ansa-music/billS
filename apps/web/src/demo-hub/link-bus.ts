/**
 * «Подключить устройство»: the message bus between the cash desk and the devices — Supabase Realtime
 * broadcast (packages/domain/src/trial-link-realtime.ts) with the project's public anon key, the same
 * project the trial reports to. In development `VITE_LINK_LOOPBACK=1` swaps it for a BroadcastChannel
 * between tabs of one browser (a stand-in with the same shape: two tabs = cash desk + device, no cloud).
 * Light: no HUB, so the dialog and the device can import it.
 */
import type { BroadcastHandler, SocketLike } from '@bills/domain';
import { RealtimeLink } from '@bills/domain';

export interface BusTopic {
  readonly joined: boolean;
  /** `urgent`: no pacing (a «bye» while the page closes). */
  send(event: string, payload: unknown, urgent?: boolean): void;
  ready(): Promise<void>;
  leave(): void;
}

export interface LinkBus {
  readonly kind: 'realtime' | 'loopback';
  readonly connected: boolean;
  connect(): void;
  close(): void;
  /** Reconnect now (network back, page on screen) instead of after the pause. */
  nudge(): void;
  join(topic: string, handler: BroadcastHandler, onJoined?: (joined: boolean) => void): BusTopic;
}

// VITE_LINK_SUPABASE_URL (optional) relays through a project without turning on the trial's reports to the TS
// cloud — for a development stand against a real Supabase project.
const SUPABASE_URL = String(import.meta.env.VITE_LINK_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const SUPABASE_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
/** Development stand-in: tabs of one browser talk over a BroadcastChannel instead of Supabase. */
export const LINK_LOOPBACK = import.meta.env.VITE_LINK_LOOPBACK === '1';

/** Can this build connect devices at all? (Realtime needs the project address and its public key.) */
export function linkBusConfigured(): boolean {
  if (LINK_LOOPBACK) return typeof BroadcastChannel === 'function';
  return Boolean(SUPABASE_URL && SUPABASE_KEY) && typeof WebSocket === 'function';
}

export function createLinkBus(onStatus: (up: boolean) => void): LinkBus {
  return LINK_LOOPBACK ? loopbackBus(onStatus) : realtimeBus(onStatus);
}

function realtimeBus(onStatus: (up: boolean) => void): LinkBus {
  const rt = new RealtimeLink({
    url: SUPABASE_URL,
    apikey: SUPABASE_KEY,
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    onStatus,
  });
  return {
    kind: 'realtime',
    get connected() {
      return rt.connected;
    },
    connect: () => rt.connect(),
    close: () => rt.close(),
    nudge: () => rt.nudge(),
    join: (topic, handler, onJoined) => rt.join(topic, handler, onJoined),
  };
}

/** Realtime's broadcast limit on the free plan: the loopback refuses the same, so oversized messages show up in development. */
const LOOPBACK_MAX_BYTES = 256 * 1024;

function loopbackBus(onStatus: (up: boolean) => void): LinkBus {
  const me = Math.random().toString(36).slice(2);
  let channel: BroadcastChannel | null = null;
  const topics = new Map<string, { handler: BroadcastHandler; onJoined: ((j: boolean) => void) | undefined }>();
  let up = false;
  const facade = (name: string): BusTopic => ({
    get joined() {
      return up && topics.has(name);
    },
    send(event, payload) {
      if (!channel || !topics.has(name)) return;
      const msg = { topic: name, event, payload, from: me };
      const size = JSON.stringify(msg).length;
      if (size > LOOPBACK_MAX_BYTES) {
        console.error(`[link] a ${size}-byte message is over the Realtime broadcast limit; it would be refused`);
        return;
      }
      channel.postMessage(msg);
    },
    ready: () => Promise.resolve(),
    leave() {
      topics.delete(name);
    },
  });
  return {
    kind: 'loopback',
    get connected() {
      return up;
    },
    connect() {
      if (channel) return;
      channel = new BroadcastChannel('ts-link-loopback');
      channel.onmessage = (e: MessageEvent) => {
        const m = e.data as { topic?: unknown; event?: unknown; payload?: unknown; from?: unknown };
        if (m.from === me || typeof m.topic !== 'string' || typeof m.event !== 'string') return;
        topics.get(m.topic)?.handler(m.event, m.payload);
      };
      up = true;
      queueMicrotask(() => {
        onStatus(true);
        for (const t of topics.values()) t.onJoined?.(true);
      });
    },
    close() {
      channel?.close();
      channel = null;
      up = false;
      topics.clear();
      onStatus(false);
    },
    nudge() {},
    join(name, handler, onJoined) {
      topics.set(name, { handler, onJoined });
      if (up) queueMicrotask(() => onJoined?.(true));
      return facade(name);
    },
  };
}
