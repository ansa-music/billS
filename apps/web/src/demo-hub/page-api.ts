/**
 * The page's `/api/*` stand-ins, without the HUB itself (so a linked device can use them without loading
 * SQLite and the HUB's code): `window.fetch('/api/…')` goes to an injector — the in-page HUB (boot.ts,
 * watch-hub.ts) or the cash desk over the link (link-device.ts) — and `new EventSource('/api/events')`
 * listens to a change-event source.
 */
import type { ChangeEvent } from '@ts-hub/hub.ts';
import type { InjectOptions, InjectResponse } from './mini-fastify.ts';

/** Anything that answers like MiniFastify.inject: the in-page HUB, a read-only copy, the link to the cash desk. */
export interface Injector {
  inject(options: InjectOptions & { signal?: AbortSignal }): Promise<Pick<InjectResponse, 'statusCode' | 'headers' | 'body'>>;
}

/** Where change events come from (type-only: the HUB itself is not loaded by this module). */
export interface ChangeSource {
  events: {
    on(event: 'changed', listener: (e: ChangeEvent) => void): unknown;
    off(event: 'changed', listener: (e: ChangeEvent) => void): unknown;
  };
}

export function isHubPath(url: URL): boolean {
  return url.origin === window.location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/metrics');
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Same-origin /api/* requests go to `app`; everything else to the network. `changed` runs after every write. */
export function installFetch(app: Injector, changed: () => void): void {
  const networkFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), window.location.href);
    if (!isHubPath(url)) return networkFetch(input, init);
    const signal = init?.signal ?? request?.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let payload: string | undefined;
    if (init?.body !== undefined && init.body !== null) payload = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    else if (request && method !== 'GET' && method !== 'HEAD') payload = await request.text();
    const answer = app.inject({ method, url: url.pathname + url.search, headers, ...(payload !== undefined ? { payload } : {}), ...(signal ? { signal } : {}) });
    // A request the page gives up on (AbortSignal.timeout) rejects like a real fetch would.
    const res = signal
      ? await new Promise<Awaited<typeof answer>>((resolve, reject) => {
          const onAbort = () => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        })
      : await answer;
    if (method !== 'GET' && method !== 'HEAD') changed();
    const empty = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
    return new Response(empty ? null : res.body, { status: res.statusCode, headers: res.headers });
  };
}

/** `new EventSource('/api/events')` subscribes to `source`'s change events (in-page: always open). */
export function installEventSource(source: ChangeSource): void {
  const NetworkEventSource = window.EventSource;

  class DemoEventSource extends EventTarget {
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
    #onChange: (e: ChangeEvent) => void = () => {};
    #ping: ReturnType<typeof setInterval> | undefined;

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = new URL(String(url), window.location.href).href;
      if (!isHubPath(new URL(this.url))) {
        // Not the HUB: a real stream (returning an object from a constructor replaces `this`).
        return new NetworkEventSource(url, init) as unknown as DemoEventSource;
      }
      // Events arrive asynchronously, as over the network: never inside the HUB's own call.
      this.#onChange = (e) => setTimeout(() => this.#emit('changed', JSON.stringify(e)), 0);
      source.events.on('changed', this.#onChange);
      this.#ping = setInterval(() => this.#emit('ping', '{}'), 15_000);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        const open = new Event('open');
        this.onopen?.(open);
        this.dispatchEvent(open);
      }, 0);
    }

    #emit(type: string, data: string): void {
      if (this.readyState !== 1) return;
      const event = new MessageEvent(type, { data });
      if (type === 'message') this.onmessage?.(event);
      this.dispatchEvent(event);
    }

    close(): void {
      this.readyState = 2;
      source.events.off('changed', this.#onChange);
      clearInterval(this.#ping);
    }
  }

  window.EventSource = DemoEventSource as unknown as typeof EventSource;
}
