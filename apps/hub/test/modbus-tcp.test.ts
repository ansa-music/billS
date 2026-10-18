import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { ChannelAddressError } from '../src/lamps/address.ts';
import {
  decodeBits,
  decodeResponse,
  encodeReadCoils,
  encodeReadDiscreteInputs,
  encodeWriteSingleCoil,
  EXCEPTION_ILLEGAL_DATA_ADDRESS,
  EXCEPTION_ILLEGAL_FUNCTION,
  ModbusExceptionError,
  ModbusProtocolError,
  ModbusTcpClient,
  ModbusTcpLampDriver,
  splitFrames,
} from '../src/lamps/modbus-tcp.ts';

type TestContext = { after: (fn: () => void | Promise<void>) => void };

// ---------------------------------------------------------------------------
// Codec

test('FC05 Write Single Coil is encoded byte for byte', () => {
  assert.deepEqual(
    encodeWriteSingleCoil(0x0102, 1, 6, true),
    Buffer.from([0x01, 0x02, 0x00, 0x00, 0x00, 0x06, 0x01, 0x05, 0x00, 0x06, 0xff, 0x00]),
  );
  assert.deepEqual(
    encodeWriteSingleCoil(0xffff, 0x11, 0x1234, false),
    Buffer.from([0xff, 0xff, 0x00, 0x00, 0x00, 0x06, 0x11, 0x05, 0x12, 0x34, 0x00, 0x00]),
  );
});

test('FC01 Read Coils and FC02 Read Discrete Inputs are encoded byte for byte', () => {
  assert.deepEqual(
    encodeReadCoils(7, 2, 0x0010, 3),
    Buffer.from([0x00, 0x07, 0x00, 0x00, 0x00, 0x06, 0x02, 0x01, 0x00, 0x10, 0x00, 0x03]),
  );
  assert.deepEqual(
    encodeReadDiscreteInputs(8, 2, 0x0010, 1),
    Buffer.from([0x00, 0x08, 0x00, 0x00, 0x00, 0x06, 0x02, 0x02, 0x00, 0x10, 0x00, 0x01]),
  );
});

test('encoders reject values that do not fit the wire', () => {
  assert.throws(() => encodeWriteSingleCoil(0x10000, 1, 0, true), RangeError);
  assert.throws(() => encodeWriteSingleCoil(1, 256, 0, true), RangeError);
  assert.throws(() => encodeWriteSingleCoil(1, 1, 65536, true), RangeError);
  assert.throws(() => encodeReadCoils(1, 1, 0, 0), RangeError);
  assert.throws(() => encodeReadCoils(1, 1, 0, 2001), RangeError);
  assert.throws(() => encodeReadDiscreteInputs(1, 1, -1, 1), RangeError);
});

test('a data response is decoded with its transactionId, unitId, function and data', () => {
  const res = decodeResponse(Buffer.from([0x00, 0x07, 0x00, 0x00, 0x00, 0x04, 0x02, 0x01, 0x01, 0x05]));
  assert.equal(res.transactionId, 7);
  assert.equal(res.unitId, 2);
  assert.equal(res.fc, 1);
  assert.equal(res.exception, undefined);
  assert.deepEqual(res.data, Buffer.from([0x01, 0x05]));
  assert.deepEqual(decodeBits(res.data!, 3), [true, false, true]);
});

test('an exception response yields the function without the 0x80 flag and the code', () => {
  const res = decodeResponse(Buffer.from([0x00, 0x07, 0x00, 0x00, 0x00, 0x03, 0x02, 0x81, 0x02]));
  assert.equal(res.transactionId, 7);
  assert.equal(res.fc, 1);
  assert.equal(res.exception, EXCEPTION_ILLEGAL_DATA_ADDRESS);
  assert.equal(res.data, undefined);

  const err = new ModbusExceptionError(res.fc, res.exception!, '10.0.0.5:502 unit 1 coil 3');
  assert.equal(err.code, 2);
  assert.equal(err.fc, 1);
  assert.match(err.message, /10\.0\.0\.5:502/);
  assert.match(err.message, /Illegal data address/);
});

test('decodeResponse rejects malformed frames', () => {
  // protocol id must be 0
  assert.throws(
    () => decodeResponse(Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x02, 0x01, 0x05])),
    ModbusProtocolError,
  );
  // length field disagrees with the frame
  assert.throws(
    () => decodeResponse(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x05])),
    ModbusProtocolError,
  );
  // too short to hold a function code
  assert.throws(() => decodeResponse(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01])), ModbusProtocolError);
  // exception without a code
  assert.throws(() => decodeResponse(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x01, 0x81])), ModbusProtocolError);
});

test('decodeBits unpacks LSB first and checks the byte count', () => {
  assert.deepEqual(decodeBits(Buffer.from([0x02, 0x81, 0x01]), 9), [
    true, false, false, false, false, false, false, true, true,
  ]);
  assert.throws(() => decodeBits(Buffer.from([0x02, 0x01]), 1), ModbusProtocolError);
  assert.throws(() => decodeBits(Buffer.from([]), 1), ModbusProtocolError);
});

test('splitFrames separates glued frames and keeps a torn tail for the next chunk', () => {
  const a = encodeWriteSingleCoil(1, 1, 0, true);
  const b = decodeResponseFrame(2, 1, [0x01, 0x01, 0x01]);
  const c = encodeReadCoils(3, 1, 4, 1);
  const stream = Buffer.concat([a, b, c]);

  const first = splitFrames(stream.subarray(0, a.length + b.length + 5));
  assert.deepEqual(first.frames, [a, b]);
  assert.deepEqual(first.rest, c.subarray(0, 5));

  const second = splitFrames(Buffer.concat([first.rest, c.subarray(5)]));
  assert.deepEqual(second.frames, [c]);
  assert.equal(second.rest.length, 0);

  // A fragment shorter than the MBAP header yields nothing yet.
  const tiny = splitFrames(a.subarray(0, 3));
  assert.deepEqual(tiny.frames, []);
  assert.deepEqual(tiny.rest, a.subarray(0, 3));

  // An impossible length field means the stream is out of sync.
  assert.throws(() => splitFrames(Buffer.from([0, 1, 0, 0, 0x10, 0x00, 1, 1])), ModbusProtocolError);
});

/** Builds a frame from a PDU (for expected responses). */
function decodeResponseFrame(transactionId: number, unitId: number, pdu: number[]): Buffer {
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(transactionId, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out.writeUInt8(unitId, 6);
  Buffer.from(pdu).copy(out, 7);
  return out;
}

// ---------------------------------------------------------------------------
// Fake Modbus TCP device

/** Coils and discrete inputs behind a TCP server; supports FC01/02/05 and a few faults. */
class FakeModbusServer {
  readonly coils: boolean[] = new Array<boolean>(256).fill(false);
  readonly inputs: boolean[] = new Array<boolean>(256).fill(false);
  readonly writes: Array<{ unitId: number; addr: number; on: boolean }> = [];
  readonly requests: Array<{ transactionId: number; unitId: number; fc: number }> = [];
  /** No discrete inputs on this module: FC02 is answered with exception 01. */
  noInputs = false;
  /** Swallow every request. */
  silent = false;
  /** Answer the next request with this exception code. */
  nextException: number | null = null;
  /** Always answer these function codes with an exception. */
  readonly exceptionByFc: Partial<Record<number, number>> = {};
  /** Prepend a frame with a foreign transactionId to the next answer, in the same packet. */
  glueStaleFrame = false;
  /** Send the next answer in two TCP chunks. */
  fragmentNext = false;
  /** Close the connection instead of answering the next request. */
  dropNext = false;
  connections = 0;
  maxOutstanding = 0;
  #outstanding = 0;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();

  constructor() {
    this.#server = createServer((socket) => this.#onConnection(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        const addr = this.#server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        resolve(addr.port);
      });
    });
  }

  closeConnections(): void {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
  }

  close(): Promise<void> {
    this.closeConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #onConnection(socket: Socket): void {
    this.connections++;
    this.#sockets.add(socket);
    let rx: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      const { frames, rest } = splitFrames(rx);
      rx = rest;
      for (const f of frames) this.#handle(socket, f);
    });
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => undefined);
  }

  #handle(socket: Socket, req: Buffer): void {
    const transactionId = req.readUInt16BE(0);
    const unitId = req.readUInt8(6);
    const fc = req.readUInt8(7);
    this.requests.push({ transactionId, unitId, fc });
    this.#outstanding++;
    this.maxOutstanding = Math.max(this.maxOutstanding, this.#outstanding);

    if (this.dropNext) {
      this.dropNext = false;
      socket.destroy();
      return;
    }
    if (this.silent) return;

    const exception = (code: number) => decodeResponseFrame(transactionId, unitId, [fc | 0x80, code]);
    const forced = this.exceptionByFc[fc];
    let reply: Buffer;
    if (this.nextException !== null) {
      reply = exception(this.nextException);
      this.nextException = null;
    } else if (forced !== undefined) {
      reply = exception(forced);
    } else if (fc === 0x01 || fc === 0x02) {
      const addr = req.readUInt16BE(8);
      const qty = req.readUInt16BE(10);
      if (fc === 0x02 && this.noInputs) {
        reply = exception(0x01);
      } else {
        const bank = fc === 0x01 ? this.coils : this.inputs;
        const bytes = new Array<number>(Math.ceil(qty / 8)).fill(0);
        for (let i = 0; i < qty; i++) {
          if (bank[addr + i]) bytes[i >> 3] = (bytes[i >> 3] ?? 0) | (1 << (i & 7));
        }
        reply = decodeResponseFrame(transactionId, unitId, [fc, bytes.length, ...bytes]);
      }
    } else if (fc === 0x05) {
      const addr = req.readUInt16BE(8);
      const value = req.readUInt16BE(10);
      if (value !== 0xff00 && value !== 0x0000) {
        reply = exception(0x03);
      } else {
        const on = value === 0xff00;
        this.coils[addr] = on;
        this.writes.push({ unitId, addr, on });
        reply = Buffer.from(req);
      }
    } else {
      reply = exception(0x01);
    }

    this.#outstanding--;
    if (this.glueStaleFrame) {
      this.glueStaleFrame = false;
      // A read-coils answer saying ON, under a transactionId nobody asked for.
      const stale = decodeResponseFrame((transactionId + 0x4000) & 0xffff, unitId, [0x01, 0x01, 0x01]);
      reply = Buffer.concat([stale, reply]);
    }
    if (this.fragmentNext) {
      this.fragmentNext = false;
      socket.write(reply.subarray(0, 4));
      setTimeout(() => socket.write(reply.subarray(4)), 5);
      return;
    }
    socket.write(reply);
  }
}

async function setup(
  t: TestContext,
  options: ConstructorParameters<typeof ModbusTcpLampDriver>[0] = {},
): Promise<{ server: FakeModbusServer; driver: ModbusTcpLampDriver; port: number }> {
  const server = new FakeModbusServer();
  const port = await server.listen();
  const driver = new ModbusTcpLampDriver({ defaultHost: `127.0.0.1:${port}`, blinkPeriodMs: 5, ...options });
  t.after(async () => {
    driver.close();
    await server.close();
  });
  return { server, driver, port };
}

/** A signal that fails a hanging test quickly instead of letting it run forever. */
function never(): AbortSignal {
  return AbortSignal.timeout(2000);
}

// ---------------------------------------------------------------------------
// Driver

test('setLamp writes coil N-1 for relay N and confirms by the echoed frame', async (t) => {
  const { server, driver } = await setup(t);

  await driver.setLamp('relay-3', true, never());
  assert.equal(server.coils[2], true);
  assert.deepEqual(server.writes, [{ unitId: 1, addr: 2, on: true }]);

  await driver.setLamp('relay-3', false, never());
  assert.equal(server.coils[2], false);
  assert.deepEqual(server.writes.at(-1), { unitId: 1, addr: 2, on: false });
});

test('coilBase 0 writes coil N for relay N, and unitId is passed through', async (t) => {
  const { server, driver } = await setup(t, { coilBase: 0, unitId: 17 });
  await driver.setLamp('relay-3', true, never());
  assert.equal(server.coils[3], true);
  assert.equal(server.coils[2], false);
  assert.deepEqual(server.writes, [{ unitId: 17, addr: 3, on: true }]);
});

test('an explicit modbus:host:port/N address goes to that host', async (t) => {
  const { server, driver, port } = await setup(t, { defaultHost: undefined });
  await driver.setLamp(`modbus:127.0.0.1:${port}/7`, true, never());
  assert.equal(server.coils[6], true);
  assert.deepEqual(driver.connections, [`127.0.0.1:${port}`]);
});

test('relay-N without a default host and foreign schemes are rejected before any connection', async (t) => {
  const { server, driver } = await setup(t, { defaultHost: undefined });
  await assert.rejects(driver.setLamp('relay-1', true, never()), ChannelAddressError);
  await assert.rejects(driver.setLamp('esp32:192.168.1.50/1', true, never()), ChannelAddressError);
  await assert.rejects(driver.setLamp('relay-0', true, never()), ChannelAddressError);
  assert.equal(server.connections, 0);
  assert.equal(server.requests.length, 0);
});

test('a Modbus exception becomes a ModbusExceptionError naming host, coil and code', async (t) => {
  const { server, driver, port } = await setup(t);
  server.nextException = EXCEPTION_ILLEGAL_DATA_ADDRESS;
  await assert.rejects(driver.setLamp('relay-9', true, never()), (err: unknown) => {
    assert.ok(err instanceof ModbusExceptionError);
    assert.equal(err.code, 2);
    assert.equal(err.fc, 5);
    assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(err.message, /coil 8/);
    return true;
  });
  assert.equal(server.coils[8], false);
  // The connection is still usable afterwards.
  await driver.setLamp('relay-9', true, never());
  assert.equal(server.coils[8], true);
});

test('readState reads the coil and the current sensor input', async (t) => {
  const { server, driver } = await setup(t);
  server.coils[4] = true;
  server.inputs[4] = false;
  assert.deepEqual(await driver.readState('relay-5', never()), { on: true, currentOn: false });

  server.inputs[4] = true;
  assert.deepEqual(await driver.readState('relay-5', never()), { on: true, currentOn: true });

  server.coils[4] = false;
  assert.deepEqual(await driver.readState('relay-5', never()), { on: false, currentOn: true });
  assert.deepEqual(
    server.requests.map((r) => r.fc),
    [1, 2, 1, 2, 1, 2],
  );
});

test('currentInputOffset shifts the sensor input relative to the coil', async (t) => {
  const { server, driver } = await setup(t, { currentInputOffset: 100 });
  server.inputs[104] = true;
  assert.deepEqual(await driver.readState('relay-5', never()), { on: false, currentOn: true });
});

test('a module without discrete inputs (exception 01 on FC02) reports currentOn undefined', async (t) => {
  const { server, driver } = await setup(t);
  server.noInputs = true;
  server.coils[0] = true;
  const state = await driver.readState('relay-1', never());
  assert.equal(state.on, true);
  assert.equal(state.currentOn, undefined);
});

test('other exceptions on the sensor read are errors', async (t) => {
  const { server, driver } = await setup(t);
  // the coil read (FC01) is answered, the sensor read (FC02) gets exception 02
  server.coils[0] = true;
  server.exceptionByFc[2] = EXCEPTION_ILLEGAL_DATA_ADDRESS;
  await assert.rejects(
    driver.readState('relay-1', never()),
    (err: unknown) => err instanceof ModbusExceptionError && err.code === 2 && err.fc === 2,
  );
  assert.deepEqual(
    server.requests.map((r) => r.fc),
    [1, 2],
  );
});

test('currentInputs: false skips the sensor read', async (t) => {
  const { server, driver } = await setup(t, { currentInputs: false });
  server.coils[1] = true;
  const state = await driver.readState('relay-2', never());
  assert.equal(state.on, true);
  assert.equal(state.currentOn, undefined);
  assert.deepEqual(
    server.requests.map((r) => r.fc),
    [1],
  );
});

test('an aborted request rejects with the abort reason, and the next request reconnects', async (t) => {
  const { server, driver } = await setup(t);
  await driver.setLamp('relay-1', true, never());
  assert.equal(server.connections, 1);

  server.silent = true;
  const controller = new AbortController();
  const reason = new Error('No controller confirmation within 50 ms');
  const timer = setTimeout(() => controller.abort(reason), 50);
  t.after(() => clearTimeout(timer));
  const started = performance.now();
  await assert.rejects(driver.setLamp('relay-1', false, controller.signal), (err: unknown) => err === reason);
  assert.ok(performance.now() - started < 1000, 'rejects as soon as aborted');

  server.silent = false;
  await driver.setLamp('relay-1', false, never());
  assert.equal(server.coils[0], false);
  assert.equal(server.connections, 2, 'the connection with the dangling answer was dropped');
});

test('an already aborted signal rejects without touching the network', async (t) => {
  const { server, driver } = await setup(t);
  const controller = new AbortController();
  const reason = new Error('late');
  controller.abort(reason);
  await assert.rejects(driver.setLamp('relay-1', true, controller.signal), (err: unknown) => err === reason);
  assert.equal(server.connections, 0);
});

test('a connection dropped by the device fails the request in flight and reconnects next time', async (t) => {
  const { server, driver, port } = await setup(t);
  await driver.setLamp('relay-1', true, never());

  server.dropNext = true;
  await assert.rejects(driver.setLamp('relay-2', true, never()), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    return true;
  });
  assert.equal(server.coils[1], false);

  await driver.setLamp('relay-2', true, never());
  assert.equal(server.coils[1], true);
  assert.equal(server.connections, 2);
});

test('an idle connection closed by the device is replaced silently', async (t) => {
  const { server, driver } = await setup(t);
  await driver.setLamp('relay-1', true, never());
  server.closeConnections();
  await new Promise((r) => setTimeout(r, 20)); // let the client see the close
  await driver.setLamp('relay-1', false, never());
  assert.equal(server.coils[0], false);
  assert.equal(server.connections, 2);
});

test('a device that is not listening fails with a message naming host and port', async (t) => {
  const probe = new FakeModbusServer();
  const port = await probe.listen();
  await probe.close();
  const driver = new ModbusTcpLampDriver({ defaultHost: `127.0.0.1:${port}` });
  t.after(() => driver.close());
  await assert.rejects(driver.setLamp('relay-1', true, never()), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(`^Modbus 127\\.0\\.0\\.1:${port}: `));
    return true;
  });
});

test('glued and torn answers are parsed, a frame with a foreign transactionId is ignored', async (t) => {
  const { server, driver } = await setup(t, { currentInputs: false });
  server.coils[0] = false;
  server.glueStaleFrame = true; // the stale frame says ON
  assert.equal((await driver.readState('relay-1', never())).on, false);

  server.coils[0] = true;
  server.fragmentNext = true;
  assert.equal((await driver.readState('relay-1', never())).on, true);
});

test('concurrent requests to one host go out one at a time with distinct transactionIds', async (t) => {
  const { server, driver } = await setup(t, { currentInputs: false });
  server.coils[3] = true;
  server.coils[5] = true;

  const results = await Promise.all([
    driver.setLamp('relay-1', true, never()),
    driver.readState('relay-4', never()),
    driver.setLamp('relay-2', true, never()),
    driver.readState('relay-5', never()),
    driver.setLamp('relay-3', false, never()),
    driver.readState('relay-6', never()),
  ]);

  assert.deepEqual(results, [undefined, { on: true, currentOn: undefined }, undefined, { on: false, currentOn: undefined }, undefined, { on: true, currentOn: undefined }]);
  assert.deepEqual(server.coils.slice(0, 3), [true, true, false]);
  assert.equal(server.maxOutstanding, 1);
  assert.equal(server.connections, 1);
  const ids = server.requests.map((r) => r.transactionId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    server.requests.map((r) => r.fc),
    [5, 1, 5, 1, 5, 1],
  );
});

test('blink toggles the coil and ends in the state it started in', async (t) => {
  const { server, driver } = await setup(t);
  server.coils[4] = true;
  await driver.blink('relay-5', 2, never());
  assert.deepEqual(
    server.writes.map((w) => w.on),
    [false, true, false, true],
  );
  assert.ok(server.writes.every((w) => w.addr === 4));
  assert.equal(server.coils[4], true);

  server.writes.length = 0;
  server.coils[4] = false;
  await driver.blink('relay-5', 1, never());
  assert.deepEqual(
    server.writes.map((w) => w.on),
    [true, false],
  );
  assert.equal(server.coils[4], false);
});

test('an aborted blink leaves the relay where the controller finds it, without hanging', async (t) => {
  const { server, driver } = await setup(t);
  server.coils[0] = false;
  const controller = new AbortController();
  const p = driver.blink('relay-1', 50, controller.signal);
  await waitFor(() => server.writes.length >= 1);
  controller.abort(new Error('stop'));
  await assert.rejects(p, /stop/);
});

test('close() rejects waiting requests and refuses new ones', async (t) => {
  const { server, driver } = await setup(t);
  server.silent = true;
  const p = driver.setLamp('relay-1', true, never());
  await waitFor(() => server.requests.length === 1);
  driver.close();
  await assert.rejects(p, /closed/);
  await assert.rejects(driver.setLamp('relay-1', true, never()), /closed/);
});

test('ModbusTcpClient can be used on its own and matches the answer to the request', async (t) => {
  const server = new FakeModbusServer();
  const port = await server.listen();
  const client = new ModbusTcpClient('127.0.0.1', port);
  t.after(async () => {
    client.close();
    await server.close();
  });
  server.coils[10] = true;
  server.coils[12] = true;
  const res = await client.request((tid) => encodeReadCoils(tid, 1, 10, 3), never());
  assert.equal(res.exception, undefined);
  assert.deepEqual(decodeBits(res.data!, 3), [true, false, true]);
  assert.equal(res.transactionId, server.requests[0]?.transactionId);
  assert.equal(client.where, `127.0.0.1:${port}`);
});

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}
