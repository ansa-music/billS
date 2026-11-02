/**
 * «Облачная касса»: `new EventSource('<café>/api/events')` becomes a WebSocket to the café's HUB in the TS
 * cloud (apps/cloud-hub). An SSE stream would keep the café's Durable Object awake — and billed — all day; a
 * hibernating WebSocket costs nothing while nothing happens. The screens keep their EventSource code:
 *
 *   server → {"t":"changed","e":{kind,tableId?}}   → event `changed` (data: the event JSON), as the HUB's SSE
 *   this   → "ping" every 15 s, server → "pong"    → event `ping` (the watchdog in useHub.tsx sees life)
 *
 * The cloud answers "ping" without waking the café's object (setWebSocketAutoResponse). A dropped socket
 * reconnects by itself after 2 s, like EventSource does, with `error` fired meanwhile.
 */

const PING_MS = 15_000;
const RETRY_MS = 2000;

export function installCloudEventSource(hubUrl: string): void {
  const NativeEventSource = window.EventSource;
  const eventsUrl = new URL(`${hubUrl}/api/events`, window.location.href).href;

  class CloudEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    #ws: WebSocket | null = null;
    #ping: ReturnType<typeof setInterval> | undefined;
    #retry: ReturnType<typeof setTimeout> | undefined;

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = new URL(String(url), window.location.href).href;
      // Not the café's stream: a real EventSource (returning an object from a constructor replaces `this`).
      if (this.url !== eventsUrl) return new NativeEventSource(url, init) as unknown as CloudEventSource;
      this.#connect();
    }

    #connect(): void {
      if (this.readyState === 2) return;
      const ws = new WebSocket(this.url.replace(/^http/, 'ws'));
      this.#ws = ws;
      ws.onopen = () => {
        if (this.#ws !== ws) return;
        this.readyState = 1;
        this.#fire(new Event('open'), this.onopen);
        clearInterval(this.#ping);
        this.#ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, PING_MS);
      };
      ws.onmessage = (m) => {
        if (this.#ws !== ws || typeof m.data !== 'string') return;
        if (m.data === 'pong') {
          this.#fire(new MessageEvent('ping', { data: '{}' }), null);
          return;
        }
        try {
          const msg = JSON.parse(m.data) as { t?: string; e?: unknown };
          if (msg.t === 'changed') this.#fire(new MessageEvent('changed', { data: JSON.stringify(msg.e ?? {}) }), null);
        } catch {
          // Not ours: ignored.
        }
      };
      ws.onclose = () => {
        if (this.#ws !== ws) return;
        clearInterval(this.#ping);
        this.#ws = null;
        if (this.readyState === 2) return;
        this.readyState = 0;
        this.#fire(new Event('error'), this.onerror);
        clearTimeout(this.#retry);
        this.#retry = setTimeout(() => this.#connect(), RETRY_MS);
      };
    }

    #fire(event: Event, handler: ((e: never) => void) | null): void {
      (handler as ((e: Event) => void) | null)?.(event);
      this.dispatchEvent(event);
    }

    close(): void {
      this.readyState = 2;
      clearInterval(this.#ping);
      clearTimeout(this.#retry);
      const ws = this.#ws;
      this.#ws = null;
      ws?.close();
    }
  }

  window.EventSource = CloudEventSource as unknown as typeof EventSource;
}
