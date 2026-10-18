/**
 * Lamp driver for an industrial relay module over Modbus TCP (node:net, no
 * dependencies). One coil per lamp; an optional discrete input per lamp for a
 * current sensor.
 *
 *   FC05 Write Single Coil      setLamp — confirmed by the echoed request
 *   FC01 Read Coils             readState (relay), blink (state to return to)
 *   FC02 Read Discrete Inputs   readState (current sensor)
 *
 * Addressing: the channel number is the relay number printed on the module
 * (1-based, see address.ts); `coilBase` 1 (default) maps relay N to coil N-1,
 * `coilBase` 0 maps relay N to coil N. The current sensor of a relay is the
 * discrete input at `coil + currentInputOffset`.
 *
 * The driver does not retry and has no timeouts of its own: the lamp
 * controller wraps every call in an AbortSignal, and an aborted request
 * rejects immediately and drops the connection so a late answer cannot be
 * taken for the next request.
 */
import { createConnection, type Socket } from 'node:net';
import { ChannelAddressError, resolveChannel } from './address.ts';
import { BLINK_PERIOD_MS, blinkByToggling, type LampDriver, type LampState } from './driver.ts';

export const FC_READ_COILS = 0x01;
export const FC_READ_DISCRETE_INPUTS = 0x02;
export const FC_WRITE_SINGLE_COIL = 0x05;

export const EXCEPTION_ILLEGAL_FUNCTION = 0x01;
export const EXCEPTION_ILLEGAL_DATA_ADDRESS = 0x02;
export const EXCEPTION_ILLEGAL_DATA_VALUE = 0x03;

export const MODBUS_EXCEPTION_NAMES: Readonly<Record<number, string>> = {
  0x01: 'Illegal function',
  0x02: 'Illegal data address',
  0x03: 'Illegal data value',
  0x04: 'Server device failure',
  0x05: 'Acknowledge',
  0x06: 'Server device busy',
  0x08: 'Memory parity error',
  0x0a: 'Gateway path unavailable',
  0x0b: 'Gateway target device failed to respond',
};

/** MBAP header: transactionId u16, protocolId u16 (0), length u16, unitId u8. */
const MBAP_SIZE = 7;
/** The length field counts unitId + PDU; a PDU is at most 253 bytes. */
const MIN_LENGTH_FIELD = 2;
const MAX_LENGTH_FIELD = 254;
const MAX_READ_QUANTITY = 2000;

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/** The device answered with a Modbus exception (FC | 0x80 + code). */
export class ModbusExceptionError extends Error {
  readonly fc: number;
  readonly code: number;

  constructor(fc: number, code: number, where?: string) {
    const name = MODBUS_EXCEPTION_NAMES[code] ?? 'Unknown exception';
    super(`Modbus${where ? ` ${where}` : ''}: exception ${hex2(code)} (${name}) on function ${hex2(fc)}`);
    this.name = 'ModbusExceptionError';
    this.fc = fc;
    this.code = code;
  }
}

/** A frame that does not follow the Modbus TCP format, or an answer that does not match the request. */
export class ModbusProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModbusProtocolError';
  }
}

// ---------------------------------------------------------------------------
// Codec

export interface ModbusDataResponse {
  transactionId: number;
  unitId: number;
  fc: number;
  /** The PDU after the function code. */
  data: Buffer;
  exception?: undefined;
}

export interface ModbusExceptionResponse {
  transactionId: number;
  unitId: number;
  /** The requested function (the 0x80 flag is removed). */
  fc: number;
  /** The exception code. */
  exception: number;
  data?: undefined;
}

export type ModbusResponse = ModbusDataResponse | ModbusExceptionResponse;

function checkU16(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`Modbus ${what} must be 0–65535, got ${value}`);
  }
}

function checkU8(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`Modbus ${what} must be 0–255, got ${value}`);
  }
}

function frame(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  checkU16(transactionId, 'transactionId');
  checkU8(unitId, 'unitId');
  const out = Buffer.alloc(MBAP_SIZE + pdu.length);
  out.writeUInt16BE(transactionId, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out.writeUInt8(unitId, 6);
  pdu.copy(out, MBAP_SIZE);
  return out;
}

function readRequest(fc: number, transactionId: number, unitId: number, addr: number, qty: number): Buffer {
  checkU16(addr, 'address');
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_READ_QUANTITY) {
    throw new RangeError(`Modbus quantity must be 1–${MAX_READ_QUANTITY}, got ${qty}`);
  }
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(fc, 0);
  pdu.writeUInt16BE(addr, 1);
  pdu.writeUInt16BE(qty, 3);
  return frame(transactionId, unitId, pdu);
}

/** FC05: writes one coil; the device answers with an echo of the request. */
export function encodeWriteSingleCoil(transactionId: number, unitId: number, addr: number, on: boolean): Buffer {
  checkU16(addr, 'address');
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_WRITE_SINGLE_COIL, 0);
  pdu.writeUInt16BE(addr, 1);
  pdu.writeUInt16BE(on ? 0xff00 : 0x0000, 3);
  return frame(transactionId, unitId, pdu);
}

/** FC01: reads `qty` coils starting at `addr`. */
export function encodeReadCoils(transactionId: number, unitId: number, addr: number, qty: number): Buffer {
  return readRequest(FC_READ_COILS, transactionId, unitId, addr, qty);
}

/** FC02: reads `qty` discrete inputs starting at `addr`. */
export function encodeReadDiscreteInputs(transactionId: number, unitId: number, addr: number, qty: number): Buffer {
  return readRequest(FC_READ_DISCRETE_INPUTS, transactionId, unitId, addr, qty);
}

/**
 * Cuts a TCP byte stream into whole Modbus TCP frames by the MBAP length
 * field. Frames may arrive glued together or split across packets; the
 * unfinished tail is returned as `rest` to be prepended to the next chunk.
 * Throws ModbusProtocolError on an impossible length field (stream desync).
 */
export function splitFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const length = buffer.readUInt16BE(offset + 4);
    if (length < MIN_LENGTH_FIELD || length > MAX_LENGTH_FIELD) {
      throw new ModbusProtocolError(`Modbus: impossible MBAP length ${length}`);
    }
    const total = 6 + length;
    if (buffer.length - offset < total) break;
    frames.push(buffer.subarray(offset, offset + total));
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Decodes one whole frame (as returned by splitFrames). */
export function decodeResponse(buffer: Buffer): ModbusResponse {
  if (buffer.length < MBAP_SIZE + 1) throw new ModbusProtocolError(`Modbus: frame too short (${buffer.length} bytes)`);
  const protocolId = buffer.readUInt16BE(2);
  if (protocolId !== 0) throw new ModbusProtocolError(`Modbus: protocol id ${protocolId}, expected 0`);
  const length = buffer.readUInt16BE(4);
  if (length !== buffer.length - 6) {
    throw new ModbusProtocolError(`Modbus: MBAP length ${length} does not match frame of ${buffer.length} bytes`);
  }
  const transactionId = buffer.readUInt16BE(0);
  const unitId = buffer.readUInt8(6);
  const fc = buffer.readUInt8(7);
  if (fc & 0x80) {
    if (buffer.length < MBAP_SIZE + 2) throw new ModbusProtocolError('Modbus: exception frame without a code');
    return { transactionId, unitId, fc: fc & 0x7f, exception: buffer.readUInt8(8) };
  }
  return { transactionId, unitId, fc, data: buffer.subarray(MBAP_SIZE + 1) };
}

/** Unpacks the data of an FC01/FC02 answer (byteCount + bits, LSB first) into `qty` booleans. */
export function decodeBits(data: Buffer, qty: number): boolean[] {
  const byteCount = Math.ceil(qty / 8);
  if (data.length < 1 || data.readUInt8(0) !== byteCount || data.length !== 1 + byteCount) {
    throw new ModbusProtocolError(`Modbus: malformed bit response for ${qty} bit(s): ${data.toString('hex')}`);
  }
  const bits: boolean[] = [];
  for (let i = 0; i < qty; i++) {
    const byte = data.readUInt8(1 + (i >> 3));
    bits.push((byte & (1 << (i & 7))) !== 0);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// Client

interface Pending {
  build: (transactionId: number) => Buffer;
  signal: AbortSignal;
  resolve: (response: ModbusResponse) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
  transactionId: number;
}

/**
 * One TCP connection to one Modbus device. Connects lazily, sends requests
 * one at a time in order, matches answers by transactionId. On a socket error
 * every waiting request is rejected; the next request reconnects.
 */
export class ModbusTcpClient {
  readonly host: string;
  readonly port: number;
  #socket: Socket | null = null;
  #connected = false;
  #rx: Buffer = Buffer.alloc(0);
  readonly #queue: Pending[] = [];
  #inFlight: Pending | null = null;
  #nextTransactionId = 1;
  #closed = false;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  /** `host:port`, for error messages. */
  get where(): string {
    return `${this.host}:${this.port}`;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Queues a request. `build` receives the transactionId the client assigned
   * and returns the whole frame (see encode*). Rejects with `signal.reason`
   * when aborted, with an Error on socket failure, protocol desync or close().
   */
  request(build: (transactionId: number) => Buffer, signal: AbortSignal): Promise<ModbusResponse> {
    return new Promise<ModbusResponse>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error(`Modbus ${this.where}: client is closed`));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const pending: Pending = {
        build,
        signal,
        resolve,
        reject,
        transactionId: -1,
        onAbort: () => this.#abort(pending),
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
      this.#queue.push(pending);
      this.#pump();
    });
  }

  /** Drops the connection and rejects every waiting request. The client cannot be used afterwards. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#dropSocket();
    this.#rejectAll(new Error(`Modbus ${this.where}: client is closed`));
  }

  #abort(pending: Pending): void {
    const queued = this.#queue.indexOf(pending);
    if (queued >= 0) this.#queue.splice(queued, 1);
    const wasInFlight = this.#inFlight === pending;
    if (wasInFlight) this.#inFlight = null;
    if (queued < 0 && !wasInFlight) return; // already settled
    pending.reject(pending.signal.reason);
    // A late answer must not be taken for the next request; a connection that
    // is still being established is not worth waiting for either.
    if (wasInFlight || !this.#connected) this.#dropSocket();
    this.#pump();
  }

  #rejectAll(reason: Error): void {
    const inFlight = this.#inFlight;
    this.#inFlight = null;
    const waiting = this.#queue.splice(0);
    if (inFlight) waiting.unshift(inFlight);
    for (const p of waiting) {
      p.signal.removeEventListener('abort', p.onAbort);
      p.reject(reason);
    }
  }

  #dropSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#connected = false;
    this.#rx = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
    }
  }

  #pump(): void {
    if (this.#closed || this.#inFlight || this.#queue.length === 0) return;
    if (!this.#socket) {
      this.#connect();
      return;
    }
    if (!this.#connected) return; // the 'connect' handler pumps again
    const pending = this.#queue.shift();
    if (!pending) return;
    pending.transactionId = this.#nextTransactionId;
    this.#nextTransactionId = this.#nextTransactionId >= 0xffff ? 1 : this.#nextTransactionId + 1;
    this.#inFlight = pending;
    this.#socket.write(pending.build(pending.transactionId));
  }

  #connect(): void {
    const socket = createConnection({ host: this.host, port: this.port });
    this.#socket = socket;
    this.#connected = false;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      if (this.#socket !== socket) return;
      this.#connected = true;
      this.#pump();
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.#socket === socket) this.#onData(chunk);
    });
    socket.on('error', (err: Error) => {
      if (this.#socket !== socket) return;
      this.#dropSocket();
      this.#rejectAll(new Error(`Modbus ${this.where}: ${err.message}`, { cause: err }));
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#dropSocket();
      this.#rejectAll(new Error(`Modbus ${this.where}: connection closed`));
    });
  }

  #onData(chunk: Buffer): void {
    this.#rx = this.#rx.length === 0 ? chunk : Buffer.concat([this.#rx, chunk]);
    let frames: Buffer[];
    try {
      const split = splitFrames(this.#rx);
      frames = split.frames;
      this.#rx = split.rest;
    } catch (err) {
      this.#desync(err);
      return;
    }
    for (const raw of frames) {
      let response: ModbusResponse;
      try {
        response = decodeResponse(raw);
      } catch (err) {
        this.#desync(err);
        return;
      }
      const pending = this.#inFlight;
      // Unsolicited or late answer (another transactionId): ignore it.
      if (!pending || response.transactionId !== pending.transactionId) continue;
      this.#inFlight = null;
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve(response);
    }
    this.#pump();
  }

  #desync(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#dropSocket();
    this.#rejectAll(new Error(`Modbus ${this.where}: bad frame from device — ${message}`, { cause: err }));
  }
}

// ---------------------------------------------------------------------------
// Driver

export interface ModbusTcpLampDriverOptions {
  /** `host[:port]` used for `relay-N` channels (HUB_MODBUS_HOST). */
  defaultHost?: string | undefined;
  /** Modbus unit (slave) id, 0–255. Default 1. */
  unitId?: number | undefined;
  /** 1 (default): relay N is coil N-1, as on most modules; 0: relay N is coil N. */
  coilBase?: 0 | 1 | undefined;
  /** Read the current sensor (discrete input) in readState. Default true. */
  currentInputs?: boolean | undefined;
  /** Discrete input of a relay = its coil address + offset. Default 0. */
  currentInputOffset?: number | undefined;
  /** Half-period of blink(): time between toggles. Default BLINK_PERIOD_MS. */
  blinkPeriodMs?: number | undefined;
}

interface Target {
  client: ModbusTcpClient;
  coil: number;
  input: number;
  /** `host:port unit U coil C` for messages. */
  where: string;
}

export class ModbusTcpLampDriver implements LampDriver {
  readonly #defaultHost: string | undefined;
  readonly #unitId: number;
  readonly #coilBase: 0 | 1;
  readonly #currentInputs: boolean;
  readonly #currentInputOffset: number;
  readonly #blinkPeriodMs: number;
  readonly #clients = new Map<string, ModbusTcpClient>();
  #closed = false;

  constructor(options: ModbusTcpLampDriverOptions = {}) {
    const unitId = options.unitId ?? 1;
    checkU8(unitId, 'unitId');
    const coilBase = options.coilBase ?? 1;
    if (coilBase !== 0 && coilBase !== 1) throw new RangeError(`Modbus coilBase must be 0 or 1, got ${String(coilBase)}`);
    const offset = options.currentInputOffset ?? 0;
    if (!Number.isInteger(offset)) throw new RangeError(`Modbus currentInputOffset must be an integer, got ${offset}`);
    const blinkPeriodMs = options.blinkPeriodMs ?? BLINK_PERIOD_MS;
    if (!(blinkPeriodMs > 0)) throw new RangeError(`blinkPeriodMs must be positive, got ${blinkPeriodMs}`);
    this.#defaultHost = options.defaultHost;
    this.#unitId = unitId;
    this.#coilBase = coilBase;
    this.#currentInputs = options.currentInputs ?? true;
    this.#currentInputOffset = offset;
    this.#blinkPeriodMs = blinkPeriodMs;
  }

  /** Hosts a connection has been opened to, as `host:port`. */
  get connections(): readonly string[] {
    return [...this.#clients.keys()];
  }

  async setLamp(channel: string, on: boolean, signal: AbortSignal): Promise<void> {
    await this.#writeCoil(this.#target(channel), on, signal);
  }

  async readState(channel: string, signal: AbortSignal): Promise<LampState> {
    const target = this.#target(channel);
    const on = await this.#readBit(target, FC_READ_COILS, target.coil, signal);
    if (!this.#currentInputs) return { on, currentOn: undefined };
    try {
      const currentOn = await this.#readBit(target, FC_READ_DISCRETE_INPUTS, target.input, signal);
      return { on, currentOn };
    } catch (err) {
      // The module has no discrete inputs at all: no current sensors.
      if (err instanceof ModbusExceptionError && err.code === EXCEPTION_ILLEGAL_FUNCTION) {
        return { on, currentOn: undefined };
      }
      throw err;
    }
  }

  /** Relays have no blink command: toggles the coil and returns it to the state it had. */
  async blink(channel: string, times: number, signal: AbortSignal): Promise<void> {
    const target = this.#target(channel);
    const current = await this.#readBit(target, FC_READ_COILS, target.coil, signal);
    await blinkByToggling((on, s) => this.#writeCoil(target, on, s), current, times, signal, this.#blinkPeriodMs);
  }

  /** Closes every connection; waiting requests are rejected. */
  close(): void {
    this.#closed = true;
    for (const client of this.#clients.values()) client.close();
    this.#clients.clear();
  }

  #target(channel: string): Target {
    if (this.#closed) throw new Error('Modbus driver is closed');
    const address = resolveChannel(channel, 'modbus', this.#defaultHost);
    const coil = address.channel - this.#coilBase;
    if (coil < 0 || coil > 0xffff) throw new ChannelAddressError(channel, `адрес катушки ${coil} вне диапазона 0–65535`);
    const input = coil + this.#currentInputOffset;
    if (this.#currentInputs && (input < 0 || input > 0xffff)) {
      throw new ChannelAddressError(channel, `адрес входа датчика тока ${input} вне диапазона 0–65535`);
    }
    const key = `${address.host}:${address.port}`;
    let client = this.#clients.get(key);
    if (!client) {
      client = new ModbusTcpClient(address.host, address.port);
      this.#clients.set(key, client);
    }
    return { client, coil, input, where: `${key} unit ${this.#unitId} coil ${coil}` };
  }

  async #writeCoil(target: Target, on: boolean, signal: AbortSignal): Promise<void> {
    const response = await target.client.request(
      (tid) => encodeWriteSingleCoil(tid, this.#unitId, target.coil, on),
      signal,
    );
    const data = this.#expectData(response, FC_WRITE_SINGLE_COIL, target.where);
    const confirmed =
      data.length === 4 && data.readUInt16BE(0) === target.coil && data.readUInt16BE(2) === (on ? 0xff00 : 0x0000);
    if (!confirmed) {
      throw new ModbusProtocolError(
        `Modbus ${target.where}: write ${on ? 'ON' : 'OFF'} not confirmed, device echoed ${data.toString('hex')}`,
      );
    }
  }

  async #readBit(target: Target, fc: number, addr: number, signal: AbortSignal): Promise<boolean> {
    const response = await target.client.request(
      (tid) =>
        fc === FC_READ_COILS
          ? encodeReadCoils(tid, this.#unitId, addr, 1)
          : encodeReadDiscreteInputs(tid, this.#unitId, addr, 1),
      signal,
    );
    const data = this.#expectData(response, fc, target.where);
    let bits: boolean[];
    try {
      bits = decodeBits(data, 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ModbusProtocolError(`Modbus ${target.where}: ${message}`, { cause: err });
    }
    return bits[0] ?? false;
  }

  #expectData(response: ModbusResponse, fc: number, where: string): Buffer {
    if (response.exception !== undefined) throw new ModbusExceptionError(response.fc, response.exception, where);
    if (response.fc !== fc) {
      throw new ModbusProtocolError(`Modbus ${where}: answered function ${hex2(response.fc)} to request ${hex2(fc)}`);
    }
    return response.data;
  }
}
