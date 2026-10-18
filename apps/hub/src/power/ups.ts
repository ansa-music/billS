import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { ChannelAddressError, parseHostPort } from '../lamps/address.ts';

/**
 * Reading the club's UPS. The HUB and the network gear sit on it; the lamps
 * do not. Two common daemons are supported with tiny clients on node:net:
 *
 *   nut://host:3493/upsname   Network UPS Tools (upsd): `LIST VAR upsname`
 *   apcupsd://host:3551       apcupsd Network Information Server: `status`
 *   simulator                 in-memory UPS for development and tests
 */
export interface UpsReading {
  onBattery: boolean;
  /** 0–100, null when the UPS does not report it. */
  chargePercent: number | null;
  /** Estimated seconds left on battery, null when unknown. */
  runtimeSeconds: number | null;
  /** Raw status word(s) of the daemon: "OL", "OB LB", "ONLINE", "ONBATT"… */
  status: string;
  model: string | null;
}

export interface UpsSource {
  readonly kind: 'nut' | 'apcupsd' | 'simulator';
  readonly label: string;
  read(signal: AbortSignal): Promise<UpsReading>;
}

export type UpsConfig =
  | { kind: 'nut'; host: string; port: number; ups: string }
  | { kind: 'apcupsd'; host: string; port: number }
  | { kind: 'simulator' };

export class UpsConfigError extends Error {
  constructor(url: string, reason: string) {
    super(`Неверный HUB_UPS «${url}»: ${reason}`);
    this.name = 'UpsConfigError';
  }
}

/** Parses HUB_UPS. Empty/undefined → null (no UPS monitoring). */
export function parseUpsUrl(url: string | undefined): UpsConfig | null {
  const raw = (url ?? '').trim();
  if (raw === '' || raw === 'off' || raw === 'none') return null;
  if (raw === 'simulator') return { kind: 'simulator' };
  const m = /^(nut|apcupsd):\/\/([^/]+)(?:\/(.*))?$/.exec(raw);
  if (!m || !m[1] || !m[2]) throw new UpsConfigError(raw, 'ожидается nut://host[:3493]/upsname, apcupsd://host[:3551] или simulator');
  const hostPort = (defaultPort: number) => {
    try {
      return parseHostPort(m[2]!, defaultPort, raw);
    } catch (err) {
      throw new UpsConfigError(raw, err instanceof ChannelAddressError ? err.message.replace(/^[^:]*: /, '') : String(err));
    }
  };
  if (m[1] === 'nut') {
    const { host, port } = hostPort(3493);
    const ups = (m[3] ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(ups)) throw new UpsConfigError(raw, 'после «/» нужно имя ИБП из ups.conf (например, nut://192.168.1.2:3493/ups)');
    return { kind: 'nut', host, port, ups };
  }
  if (m[3] !== undefined && m[3] !== '') throw new UpsConfigError(raw, 'apcupsd не принимает путь после host:port');
  const { host, port } = hostPort(3551);
  return { kind: 'apcupsd', host, port };
}

export function createUpsSource(config: UpsConfig): UpsSource {
  switch (config.kind) {
    case 'nut':
      return new NutUps(config.host, config.port, config.ups);
    case 'apcupsd':
      return new ApcupsdUps(config.host, config.port);
    case 'simulator':
      return new SimulatorUps();
  }
}

// ── Shared TCP helper ───────────────────────────────────────────────────────

/**
 * One connection per reading: connect, send, collect bytes until `done`
 * says the answer is complete, close. An abort rejects at once and drops the
 * socket, so a late answer can never be mistaken for a fresh one.
 */
function exchange(
  host: string,
  port: number,
  request: Buffer,
  done: (received: Buffer) => boolean,
  signal: AbortSignal,
  label: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    let socket: Socket;
    const finish = (err: unknown, value?: Buffer) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      if (err !== null) reject(err);
      else resolve(value!);
    };
    const onAbort = () => finish(signal.reason);
    socket = createConnection({ host, port });
    socket.setNoDelay(true);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (done(all)) finish(null, all);
    });
    socket.once('error', (err) => finish(new Error(`${label}: ${err.message}`)));
    socket.once('close', () => finish(new Error(`${label}: connection closed before the answer was complete`)));
  });
}

// ── NUT (upsd) ───────────────────────────────────────────────────────────────

/**
 * Parses the answer to `LIST VAR <ups>`:
 *   BEGIN LIST VAR ups
 *   VAR ups ups.status "OL CHRG"
 *   VAR ups battery.charge "100"
 *   …
 *   END LIST VAR ups
 * Errors come as `ERR UNKNOWN-UPS` etc.
 */
export function parseNutVars(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('ERR ')) throw new Error(`NUT: ${t.slice(4)}`);
    const m = /^VAR\s+\S+\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(t);
    if (m && m[1] && m[2] !== undefined) vars.set(m[1], m[2].replace(/\\(.)/g, '$1'));
  }
  return vars;
}

/** NUT status words: OL on line, OB on battery, LB low battery, CHRG/DISCHRG, FSD forced shutdown… */
export function readingFromNut(vars: Map<string, string>): UpsReading {
  const status = vars.get('ups.status');
  if (status === undefined) throw new Error('NUT: ups.status is missing');
  const words = status.split(/\s+/).filter(Boolean);
  const onBattery = words.includes('OB') || words.includes('LB') || words.includes('FSD') || words.includes('DISCHRG');
  return {
    onBattery: onBattery && !words.includes('OL'),
    chargePercent: num(vars.get('battery.charge')),
    runtimeSeconds: num(vars.get('battery.runtime')),
    status,
    model: vars.get('ups.model') ?? vars.get('device.model') ?? null,
  };
}

export class NutUps implements UpsSource {
  readonly kind = 'nut';
  readonly label: string;
  readonly #host: string;
  readonly #port: number;
  readonly #ups: string;

  constructor(host: string, port: number, ups: string) {
    this.#host = host;
    this.#port = port;
    this.#ups = ups;
    this.label = `nut://${host}:${port}/${ups}`;
  }

  async read(signal: AbortSignal): Promise<UpsReading> {
    const end = `END LIST VAR ${this.#ups}`;
    const buf = await exchange(
      this.#host,
      this.#port,
      Buffer.from(`LIST VAR ${this.#ups}\n`, 'utf8'),
      (received) => {
        const text = received.toString('utf8');
        return text.includes(`${end}\n`) || /(^|\n)ERR [^\n]*\n/.test(text);
      },
      signal,
      this.label,
    );
    return readingFromNut(parseNutVars(buf.toString('utf8')));
  }
}

// ── apcupsd NIS ──────────────────────────────────────────────────────────────

/**
 * apcupsd NIS speaks length-prefixed frames: 2 bytes big-endian length, then
 * text. The client sends "status"; the server answers with one frame per
 * line ("STATUS   : ONLINE \n") and a zero-length frame at the end.
 */
export function encodeNisFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const frame = Buffer.alloc(2 + body.length);
  frame.writeUInt16BE(body.length, 0);
  body.copy(frame, 2);
  return frame;
}

/** Splits received bytes into frames; `complete` once the zero-length frame arrived. */
export function decodeNisFrames(buffer: Buffer): { lines: string[]; complete: boolean } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const len = buffer.readUInt16BE(offset);
    if (len === 0) return { lines, complete: true };
    if (offset + 2 + len > buffer.length) break;
    lines.push(buffer.subarray(offset + 2, offset + 2 + len).toString('utf8').replace(/\n$/, ''));
    offset += 2 + len;
  }
  return { lines, complete: false };
}

/** "BCHARGE  : 100.0 Percent" → { BCHARGE: "100.0 Percent" } */
export function parseApcupsdStatus(lines: string[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    vars.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return vars;
}

/** apcupsd STATUS words: ONLINE, ONBATT, LOWBATT, CHARGING, COMMLOST, SHUTTING DOWN… */
export function readingFromApcupsd(vars: Map<string, string>): UpsReading {
  const status = vars.get('STATUS');
  if (status === undefined) throw new Error('apcupsd: STATUS is missing');
  const upper = status.toUpperCase();
  if (upper.includes('COMMLOST')) throw new Error('apcupsd: COMMLOST — the daemon has lost the UPS');
  const onBattery = /\b(ONBATT|LOWBATT|SHUTTING DOWN)\b/.test(upper) && !/\bONLINE\b/.test(upper);
  const timeLeft = vars.get('TIMELEFT');
  let runtimeSeconds: number | null = null;
  if (timeLeft !== undefined) {
    const n = num(timeLeft);
    if (n !== null) runtimeSeconds = /second/i.test(timeLeft) ? Math.round(n) : /hour/i.test(timeLeft) ? Math.round(n * 3600) : Math.round(n * 60);
  }
  return {
    onBattery,
    chargePercent: num(vars.get('BCHARGE')),
    runtimeSeconds,
    status,
    model: vars.get('MODEL') ?? null,
  };
}

export class ApcupsdUps implements UpsSource {
  readonly kind = 'apcupsd';
  readonly label: string;
  readonly #host: string;
  readonly #port: number;

  constructor(host: string, port: number) {
    this.#host = host;
    this.#port = port;
    this.label = `apcupsd://${host}:${port}`;
  }

  async read(signal: AbortSignal): Promise<UpsReading> {
    const buf = await exchange(
      this.#host,
      this.#port,
      encodeNisFrame('status'),
      (received) => decodeNisFrames(received).complete,
      signal,
      this.label,
    );
    return readingFromApcupsd(parseApcupsdStatus(decodeNisFrames(buf).lines));
  }
}

// ── Simulator ────────────────────────────────────────────────────────────────

export interface SimulatorUpsState {
  onBattery: boolean;
  chargePercent: number;
  runtimeSeconds: number;
  /** The daemon is unreachable (cable pulled, service down). */
  unreachable: boolean;
}

export class SimulatorUps implements UpsSource {
  readonly kind = 'simulator';
  readonly label = 'simulator';
  readonly state: SimulatorUpsState = { onBattery: false, chargePercent: 100, runtimeSeconds: 1800, unreachable: false };

  set(patch: Partial<SimulatorUpsState>): SimulatorUpsState {
    Object.assign(this.state, patch);
    return { ...this.state };
  }

  async read(signal: AbortSignal): Promise<UpsReading> {
    if (signal.aborted) throw signal.reason;
    if (this.state.unreachable) throw new Error('simulator: UPS daemon unreachable');
    const s = this.state;
    return {
      onBattery: s.onBattery,
      chargePercent: s.chargePercent,
      runtimeSeconds: s.runtimeSeconds,
      status: s.onBattery ? (s.chargePercent < 20 ? 'OB LB' : 'OB DISCHRG') : 'OL',
      model: 'Simulated UPS',
    };
  }
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /-?\d+(\.\d+)?/.exec(value);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
