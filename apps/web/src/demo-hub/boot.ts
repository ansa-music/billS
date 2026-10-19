/**
 * The public demo without a server (VITE_DEMO_LOCAL=1): the real HUB (apps/hub/src)
 * runs inside the page on SQLite compiled to WebAssembly. main.tsx imports this
 * module dynamically, only in that build, and waits for startDemoHub() before
 * rendering. From then on window.fetch('/api/…') and new EventSource('/api/events')
 * are answered by the in-page HUB, so the screens run their normal code.
 *
 * The club is saved to localStorage after every change and wiped at the first
 * load after 04:00 (or by «Сбросить демо»).
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { DEMO_KEYS } from '@bills/domain';
import { systemClock } from '@ts-hub/clock.ts';
import { openDb } from '@ts-hub/db.ts';
import { buildApp } from '@ts-hub/http/app.ts';
import type { ChangeEvent } from '@ts-hub/hub.ts';
import { Hub } from '@ts-hub/hub.ts';
import { SimulatorLampDriver } from '@ts-hub/lamps/simulator.ts';
import { SimulatorUps } from '@ts-hub/power/ups.ts';
import { seedDemo } from '@ts-hub/seed.ts';
import type { MiniFastify } from './mini-fastify.ts';
import type { DatabaseSync } from './shims/sqlite.ts';
import { provideSqlJs } from './shims/sqlite.ts';
import { clearSnapshot, loadSnapshot, nextResetAt, resetDemo, saveSnapshot } from './storage.ts';

const SAVE_DEBOUNCE_MS = 800;

let started: Promise<void> | null = null;

export function startDemoHub(): Promise<void> {
  started ??= boot();
  return started;
}

async function boot(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });

  let db: DatabaseSync;
  const saved = loadSnapshot();
  try {
    provideSqlJs(SQL, saved);
    db = openDb(':memory:');
  } catch (err) {
    // A snapshot from an incompatible build: start a fresh club instead of a broken page.
    console.warn('[demo] saved demo club could not be opened, starting over', err);
    clearSnapshot();
    provideSqlJs(SQL, null);
    db = openDb(':memory:');
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty';
  seedDemo(db, Date.now(), timezone);

  const simulator = new SimulatorLampDriver();
  const ups = new SimulatorUps();
  const hub = new Hub({ db, clock: systemClock, lampDriver: simulator, ups });
  const app = buildApp(hub, {
    simulator,
    upsSimulator: ups,
    logger: false,
    dbPath: ':memory:',
    startedAt: Date.now(),
    version: { version: 'demo', gitSha: null },
    demo: { resetAt: () => nextResetAt(Date.now()) },
  });
  hub.start();
  hub.auth.issueFixedKeys(DEMO_KEYS);

  const changed = keepSaved(db, hub);
  scheduleNightlyReset();
  installFetch(app, changed);
  installEventSource(hub);
}

/**
 * Saves the database shortly after every change event and every command (a login
 * changes the database without an event), and when the tab is hidden or closed.
 * Returns the "something changed" trigger.
 */
function keepSaved(db: DatabaseSync, hub: Hub): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    // sql.js cannot serialise in the middle of a transaction; the HUB's are synchronous,
    // so this only happens if a save is triggered from inside one — try again shortly.
    if (db.isTransaction) {
      timer = setTimeout(save, 50);
      return;
    }
    saveSnapshot(db.export());
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };
  hub.events.on('changed', changed);
  const flush = () => {
    if (timer !== undefined) save();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  save();
  return changed;
}

/** A tab left open overnight starts over at 04:00 too. */
function scheduleNightlyReset(): void {
  const now = Date.now();
  setTimeout(resetDemo, Math.min(nextResetAt(now) - now, 2 ** 31 - 1));
}

function isHubPath(url: URL): boolean {
  return url.origin === window.location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/metrics');
}

/** Same-origin /api/* requests go to the in-page HUB; everything else to the network. */
function installFetch(app: MiniFastify, changed: () => void): void {
  const networkFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), window.location.href);
    if (!isHubPath(url)) return networkFetch(input, init);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let payload: string | undefined;
    if (init?.body !== undefined && init.body !== null) payload = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    else if (request && method !== 'GET' && method !== 'HEAD') payload = await request.text();
    const res = await app.inject({ method, url: url.pathname + url.search, headers, ...(payload !== undefined ? { payload } : {}) });
    if (method !== 'GET' && method !== 'HEAD') changed();
    const empty = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
    return new Response(empty ? null : res.body, { status: res.statusCode, headers: res.headers });
  };
}

/** `new EventSource('/api/events')` subscribes to the in-page HUB's change events. */
function installEventSource(hub: Hub): void {
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
      hub.events.on('changed', this.#onChange);
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
      hub.events.off('changed', this.#onChange);
      clearInterval(this.#ping);
    }
  }

  window.EventSource = DemoEventSource as unknown as typeof EventSource;
}
