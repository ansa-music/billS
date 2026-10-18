import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Esp32HttpLampDriver } from '../src/lamps/esp32-http.ts';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

/** A fake ESP32 board: 8 relays, current sensors on 1–4, scriptable misbehaviour. */
class FakeBoard {
  readonly relays = new Map<number, boolean>();
  readonly seen: Seen[] = [];
  /** Sensor override per channel (true/false); otherwise follows the relay. */
  readonly lights = new Map<number, boolean>();
  token: string | undefined;
  /** Next requests: never answer. */
  silent = 0;
  /** Next relay command: reply ok but with the wrong state. */
  lie = false;
  /** Next request: HTTP 500. */
  crash = false;
  blinks: Array<{ ch: number; body: unknown }> = [];
  statusHits = 0;
  #server: Server | undefined;

  constructor() {
    for (let ch = 1; ch <= 8; ch++) this.relays.set(ch, false);
  }

  async listen(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    const { port } = this.#server!.address() as AddressInfo;
    return `127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => this.#server?.close(() => r()));
  }

  #status(ch: number) {
    const on = this.relays.get(ch) ?? false;
    return { ch, on, currentOn: ch <= 4 ? (this.lights.get(ch) ?? on) : null };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    this.seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (this.silent > 0) {
      this.silent--;
      return; // leave the request hanging; the socket is closed on close()
    }
    if (this.crash) {
      this.crash = false;
      send(500, { ok: false, error: 'boom' });
      return;
    }
    if (this.token && req.headers.authorization !== `Bearer ${this.token}`) {
      send(401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      this.statusHits++;
      send(200, { ok: true, id: 'fake', relays: [...this.relays.keys()].map((ch) => this.#status(ch)) });
      return;
    }
    const blink = /^\/relay\/(\d+)\/blink$/.exec(req.url ?? '');
    if (req.method === 'POST' && blink) {
      const ch = Number(blink[1]);
      if (!this.relays.has(ch)) return send(404, { ok: false, error: 'unknown channel' });
      this.blinks.push({ ch, body });
      return send(200, { ok: true, ch, state: this.relays.get(ch) });
    }
    const relay = /^\/relay\/(\d+)$/.exec(req.url ?? '');
    if (req.method === 'POST' && relay) {
      const ch = Number(relay[1]);
      if (!this.relays.has(ch)) return send(404, { ok: false, error: 'unknown channel' });
      const on = (body as { on?: unknown })?.on;
      if (typeof on !== 'boolean') return send(400, { ok: false, error: 'bad body' });
      if (this.lie) {
        this.lie = false;
        return send(200, { ok: true, ch, state: !on });
      }
      this.relays.set(ch, on);
      return send(200, { ok: true, ch, state: on, currentOn: this.#status(ch).currentOn });
    }
    send(404, { ok: false, error: 'not found' });
  }
}

const never = () => new AbortController().signal;

function withBoard(t: { after: (fn: () => Promise<void>) => void }) {
  const board = new FakeBoard();
  t.after(() => board.close());
  return board;
}

test('setLamp posts to /relay/<ch> and trusts only a matching state', async (t) => {
  const board = withBoard(t);
  const host = await board.listen();
  const driver = new Esp32HttpLampDriver({ defaultHost: host });

  await driver.setLamp(`esp32:${host}/3`, true, never());
  assert.equal(board.relays.get(3), true);
  assert.deepEqual(board.seen.at(-1), { method: 'POST', url: '/relay/3', auth: undefined, body: { on: true } });

  await driver.setLamp('relay-5', true, never()); // demo channel → default host
  assert.equal(board.relays.get(5), true);

  board.lie = true;
  await assert.rejects(driver.setLamp('relay-5', false, never()), /reports ON after OFF/);

  await assert.rejects(driver.setLamp('relay-9', true, never()), /1–32|unknown channel/);
  board.crash = true;
  await assert.rejects(driver.setLamp('relay-1', true, never()), /boom/);
});

test('an unanswered request is cut by the AbortSignal, not by the driver', async (t) => {
  const board = withBoard(t);
  const host = await board.listen();
  const driver = new Esp32HttpLampDriver({ defaultHost: host });
  board.silent = 1;
  const controller = new AbortController();
  const pending = driver.setLamp('relay-1', true, controller.signal);
  setTimeout(() => controller.abort(new Error('No controller confirmation within 50 ms')), 50);
  await assert.rejects(pending, /within 50 ms/);
  assert.equal(board.relays.get(1), false);
});

test('readState shares one /status call between channels and reports current sensors', async (t) => {
  const board = withBoard(t);
  const host = await board.listen();
  const driver = new Esp32HttpLampDriver({ defaultHost: host, statusCacheMs: 500 });
  board.relays.set(2, true);
  board.lights.set(1, true); // light on by hand while relay 1 is off

  const [s1, s2, s7] = await Promise.all([
    driver.readState('relay-1', never()),
    driver.readState('relay-2', never()),
    driver.readState('relay-7', never()),
  ]);
  assert.deepEqual(s1, { on: false, currentOn: true });
  assert.deepEqual(s2, { on: true, currentOn: true });
  assert.deepEqual(s7, { on: false, currentOn: undefined }); // no sensor on 7
  assert.equal(board.statusHits, 1);

  await driver.setLamp('relay-7', true, never()); // a command invalidates the cache
  assert.deepEqual(await driver.readState('relay-7', never()), { on: true, currentOn: undefined });
  assert.equal(board.statusHits, 2);
});

test('blink is delegated to the firmware with the timing, and the token travels with every request', async (t) => {
  const board = withBoard(t);
  const host = await board.listen();
  board.token = 'secret';
  const noToken = new Esp32HttpLampDriver({ defaultHost: host });
  await assert.rejects(noToken.setLamp('relay-1', true, never()), /unauthorized/);

  const driver = new Esp32HttpLampDriver({ defaultHost: host, token: 'secret', blinkOnMs: 300, blinkOffMs: 200 });
  await driver.blink(`esp32:${host}/4`, 3, never());
  assert.deepEqual(board.blinks, [{ ch: 4, body: { times: 3, onMs: 300, offMs: 200 } }]);
  assert.equal(board.seen.at(-1)?.auth, 'Bearer secret');
});

test('a board that is not there fails fast with the address in the message', async () => {
  const driver = new Esp32HttpLampDriver({ defaultHost: '127.0.0.1:1' });
  await assert.rejects(driver.setLamp('relay-1', true, never()), /ESP32 http:\/\/127\.0\.0\.1:1/);
  const unconfigured = new Esp32HttpLampDriver();
  await assert.rejects(unconfigured.setLamp('relay-1', true, never()), /HUB_ESP32_HOST/);
});
