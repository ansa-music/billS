import { fileURLToPath } from 'node:url';

export type LampDriverKind = 'simulator' | 'esp32-http' | 'modbus-tcp';
export const LAMP_DRIVERS: readonly LampDriverKind[] = ['simulator', 'esp32-http', 'modbus-tcp'];

export interface HubConfig {
  host: string;
  port: number;
  dbPath: string;
  /** Time zone of the demo club created on first start. */
  demoTimezone: string;
  /** Simulated controller response time. */
  simulatorLatencyMs: number;
  /** Built hall screen (apps/web/dist) served on `/`; skipped when the folder is missing. */
  webDistPath: string;
  /** Which relay controller the lamps are wired to. */
  lampDriver: LampDriverKind;
  esp32: {
    /** Board that `relay-N` channels map onto, host or host:port. */
    host: string | undefined;
    /** API_TOKEN of the firmware, if set. */
    token: string | undefined;
  };
  modbus: {
    /** Relay module that `relay-N` channels map onto, host or host:port. */
    host: string | undefined;
    unitId: number;
    /** 1: relay N is coil N-1 on the wire (usual); 0: relay N is coil N. */
    coilBase: 0 | 1;
    /** Read discrete inputs as current sensors. */
    currentInputs: boolean;
    /** Discrete input of relay N = its coil address + offset. */
    currentInputOffset: number;
  };
  /** Period of the relay/current-sensor poll; 0 disables it. */
  lampPollMs: number;
  /** How long a light-without-game / dark-during-game anomaly lasts before an alert. */
  lampAlertAfterMs: number;
  /** Who may switch manual mode off, by X-Actor name (until stage 3 roles). */
  managerActors: string[];
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${value}"`);
  return n;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const lampDriver = (env.HUB_LAMP_DRIVER ?? 'simulator') as LampDriverKind;
  if (!LAMP_DRIVERS.includes(lampDriver)) {
    throw new Error(`HUB_LAMP_DRIVER must be one of ${LAMP_DRIVERS.join(', ')}, got "${lampDriver}"`);
  }
  const coilBase = int(env.HUB_MODBUS_COIL_BASE, 1, 'HUB_MODBUS_COIL_BASE');
  if (coilBase !== 0 && coilBase !== 1) throw new Error('HUB_MODBUS_COIL_BASE must be 0 or 1');
  return {
    host: env.HUB_HOST ?? '127.0.0.1',
    port: int(env.HUB_PORT, 4310, 'HUB_PORT'),
    dbPath: env.HUB_DB_PATH ?? fileURLToPath(new URL('../data/hub.db', import.meta.url)),
    demoTimezone: env.HUB_DEMO_TZ ?? 'Asia/Almaty',
    simulatorLatencyMs: int(env.HUB_SIM_LATENCY_MS, 300, 'HUB_SIM_LATENCY_MS'),
    webDistPath: env.HUB_WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
    lampDriver,
    esp32: {
      host: env.HUB_ESP32_HOST || undefined,
      token: env.HUB_ESP32_TOKEN || undefined,
    },
    modbus: {
      host: env.HUB_MODBUS_HOST || undefined,
      unitId: int(env.HUB_MODBUS_UNIT_ID, 1, 'HUB_MODBUS_UNIT_ID'),
      coilBase,
      currentInputs: flag(env.HUB_MODBUS_CURRENT_INPUTS, true),
      currentInputOffset: int(env.HUB_MODBUS_CURRENT_INPUT_OFFSET, 0, 'HUB_MODBUS_CURRENT_INPUT_OFFSET'),
    },
    lampPollMs: int(env.HUB_LAMP_POLL_MS, 10_000, 'HUB_LAMP_POLL_MS'),
    lampAlertAfterMs: int(env.HUB_LAMP_ALERT_AFTER_MS, 60_000, 'HUB_LAMP_ALERT_AFTER_MS'),
    managerActors: (env.HUB_MANAGER_ACTORS ?? 'Управляющий')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
