/**
 * Lamp channel addresses — the `lamp_channel` column of billiard_tables.
 *
 *   relay-3                      simulator; with a real driver it is mapped onto the
 *                                default host from .env (HUB_ESP32_HOST / HUB_MODBUS_HOST)
 *   esp32:192.168.1.50/3         ESP32 relay board, relay 3 (1–32), HTTP on port 80
 *   esp32:192.168.1.50:8080/3    the same with an explicit port
 *   modbus:192.168.1.60:502/7    Modbus TCP relay, relay (coil) 7 as printed on the module (1-based)
 *   modbus:192.168.1.60/7        port defaults to 502
 *
 * Channel numbers are the numbers printed on the relay module, starting at 1.
 * The Modbus driver subtracts one to get the wire coil address (HUB_MODBUS_COIL_BASE).
 */
export type ChannelAddress =
  | { scheme: 'relay'; index: number }
  | { scheme: 'esp32'; host: string; port: number; channel: number }
  | { scheme: 'modbus'; host: string; port: number; channel: number };

export class ChannelAddressError extends Error {
  constructor(channel: string, reason: string) {
    super(`Неверный адрес канала «${channel}»: ${reason}`);
    this.name = 'ChannelAddressError';
  }
}

export const MAX_ESP32_CHANNEL = 32;
export const MAX_MODBUS_CHANNEL = 9999;

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i;

export function isValidHost(host: string): boolean {
  if (!HOST_RE.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((o) => Number(o) <= 255);
  return true;
}

/** Splits `host[:port]`; `defaultPort` when none is given. */
export function parseHostPort(raw: string, defaultPort: number, channel = raw): { host: string; port: number } {
  const m = /^([^:/]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m || !m[1]) throw new ChannelAddressError(channel, 'ожидается host или host:port');
  const host = m[1];
  if (!isValidHost(host)) throw new ChannelAddressError(channel, `недопустимый адрес «${host}»`);
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ChannelAddressError(channel, 'порт 1–65535');
  return { host, port };
}

export function parseChannel(channel: string): ChannelAddress {
  const relay = /^relay-(\d{1,4})$/.exec(channel);
  if (relay) {
    const index = Number(relay[1]);
    if (index < 1) throw new ChannelAddressError(channel, 'номер реле начинается с 1');
    return { scheme: 'relay', index };
  }
  const m = /^(esp32|modbus):([^/]+)\/(\d{1,4})$/.exec(channel);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new ChannelAddressError(
      channel,
      'ожидается relay-N, esp32:<ip>[:port]/<реле> или modbus:<ip>[:port]/<реле>',
    );
  }
  const scheme = m[1] as 'esp32' | 'modbus';
  const { host, port } = parseHostPort(m[2], scheme === 'esp32' ? 80 : 502, channel);
  const ch = Number(m[3]);
  const max = scheme === 'esp32' ? MAX_ESP32_CHANNEL : MAX_MODBUS_CHANNEL;
  if (ch < 1 || ch > max) throw new ChannelAddressError(channel, `номер реле 1–${max}`);
  return { scheme, host, port, channel: ch };
}

/**
 * Resolves a channel for a concrete driver: `relay-N` becomes a channel on the
 * default host (from .env) so a demo database works with real hardware.
 */
export function resolveChannel(
  channel: string,
  scheme: 'esp32' | 'modbus',
  defaultHost: string | undefined,
): Extract<ChannelAddress, { scheme: 'esp32' | 'modbus' }> {
  const parsed = parseChannel(channel);
  if (parsed.scheme === 'relay') {
    if (!defaultHost) {
      throw new ChannelAddressError(
        channel,
        `нет адреса контроллера: задайте ${scheme === 'esp32' ? 'HUB_ESP32_HOST' : 'HUB_MODBUS_HOST'} или укажите канал как ${scheme}:<ip>/${parsed.index}`,
      );
    }
    const { host, port } = parseHostPort(defaultHost, scheme === 'esp32' ? 80 : 502, channel);
    const max = scheme === 'esp32' ? MAX_ESP32_CHANNEL : MAX_MODBUS_CHANNEL;
    if (parsed.index > max) throw new ChannelAddressError(channel, `номер реле 1–${max}`);
    return { scheme, host, port, channel: parsed.index };
  }
  if (parsed.scheme !== scheme) {
    throw new ChannelAddressError(channel, `драйвер ${scheme} не обслуживает адреса ${parsed.scheme}:`);
  }
  return parsed;
}
