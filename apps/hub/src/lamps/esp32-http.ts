import { resolveChannel } from './address.ts';
import type { LampDriver, LampState } from './driver.ts';

/**
 * ESP32 relay board (firmware/esp32-relay). HTTP API:
 *
 *   POST http://<ip>/relay/<ch>        {"on":true}      → {"ok":true,"ch":3,"state":true,"currentOn":true}
 *   POST http://<ip>/relay/<ch>/blink  {"times":3,...}  → {"ok":true,"ch":3,"state":true}
 *   GET  http://<ip>/status                             → {"ok":true,"relays":[{"ch":1,"on":true,"currentOn":true}, …]}
 *
 * Timeouts and retries belong to LampController: the driver only honours the
 * AbortSignal and reports errors truthfully.
 */
export interface Esp32HttpOptions {
  /** Host (optionally host:port) that `relay-N` channels map onto. */
  defaultHost?: string | undefined;
  /** Sent as `Authorization: Bearer …` when the firmware has API_TOKEN set. */
  token?: string | undefined;
  /** GET /status answers are shared between channels of one board for this long. */
  statusCacheMs?: number | undefined;
  /** Blink timing passed to the firmware. */
  blinkOnMs?: number | undefined;
  blinkOffMs?: number | undefined;
  /** For tests. */
  fetch?: typeof fetch | undefined;
}

interface RelayStatus {
  ch: number;
  on: boolean;
  currentOn?: boolean | null;
}

interface StatusResponse {
  ok: boolean;
  relays?: RelayStatus[];
  error?: string;
}

interface RelayResponse {
  ok: boolean;
  ch?: number;
  state?: boolean;
  currentOn?: boolean | null;
  error?: string;
}

export class Esp32HttpLampDriver implements LampDriver {
  readonly #defaultHost: string | undefined;
  readonly #token: string | undefined;
  readonly #statusCacheMs: number;
  readonly #blinkOnMs: number;
  readonly #blinkOffMs: number;
  readonly #fetch: typeof fetch;
  readonly #statusCache = new Map<string, { at: number; relays: RelayStatus[] }>();
  readonly #statusInFlight = new Map<string, Promise<RelayStatus[]>>();

  constructor(options: Esp32HttpOptions = {}) {
    this.#defaultHost = options.defaultHost;
    this.#token = options.token;
    this.#statusCacheMs = options.statusCacheMs ?? 1000;
    this.#blinkOnMs = options.blinkOnMs ?? 400;
    this.#blinkOffMs = options.blinkOffMs ?? 400;
    this.#fetch = options.fetch ?? fetch;
  }

  #base(channel: string): { url: string; ch: number; key: string } {
    const a = resolveChannel(channel, 'esp32', this.#defaultHost);
    const key = `${a.host}:${a.port}`;
    return { url: `http://${key}`, ch: a.channel, key };
  }

  async #request<T extends { ok: boolean; error?: string }>(
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    signal: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`ESP32 ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let body: T | undefined;
    try {
      body = (await res.json()) as T;
    } catch {
      body = undefined;
    }
    if (!res.ok || !body || body.ok !== true) {
      const reason = body?.error ?? `HTTP ${res.status}`;
      throw new Error(`ESP32 ${url}: ${reason}`);
    }
    return body;
  }

  async setLamp(channel: string, on: boolean, signal: AbortSignal): Promise<void> {
    const { url, ch, key } = this.#base(channel);
    const body = await this.#request<RelayResponse>(`${url}/relay/${ch}`, { method: 'POST', body: { on } }, signal);
    this.#statusCache.delete(key);
    if (body.state !== on) {
      const got = body.state === undefined ? 'no state' : body.state ? 'ON' : 'OFF';
      throw new Error(`ESP32 ${url}: relay ${ch} reports ${got} after ${on ? 'ON' : 'OFF'}`);
    }
  }

  async readState(channel: string, signal: AbortSignal): Promise<LampState> {
    const { url, ch, key } = this.#base(channel);
    const relays = await this.#status(key, url, signal);
    const relay = relays.find((r) => r.ch === ch);
    if (!relay || typeof relay.on !== 'boolean') throw new Error(`ESP32 ${url}: no relay ${ch} in /status`);
    return { on: relay.on, currentOn: typeof relay.currentOn === 'boolean' ? relay.currentOn : undefined };
  }

  async blink(channel: string, times: number, signal: AbortSignal): Promise<void> {
    const { url, ch } = this.#base(channel);
    await this.#request<RelayResponse>(
      `${url}/relay/${ch}/blink`,
      { method: 'POST', body: { times, onMs: this.#blinkOnMs, offMs: this.#blinkOffMs } },
      signal,
    );
  }

  /** One /status request serves every channel of a board polled in the same second. */
  #status(key: string, url: string, signal: AbortSignal): Promise<RelayStatus[]> {
    const cached = this.#statusCache.get(key);
    if (cached && performance.now() - cached.at < this.#statusCacheMs) return Promise.resolve(cached.relays);
    const inFlight = this.#statusInFlight.get(key);
    if (inFlight) return inFlight;
    const p = this.#request<StatusResponse>(`${url}/status`, { method: 'GET' }, signal)
      .then((body) => {
        if (!Array.isArray(body.relays)) throw new Error(`ESP32 ${url}: /status without relays`);
        this.#statusCache.set(key, { at: performance.now(), relays: body.relays });
        return body.relays;
      })
      .finally(() => this.#statusInFlight.delete(key));
    this.#statusInFlight.set(key, p);
    return p;
  }
}
