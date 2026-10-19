import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_LICENSE_KEY, parseOrigins, PLATFORM_LICENSE_PUBLIC_KEYS } from '@bills/domain';

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
  /** UPS to watch: nut://host:3493/ups | apcupsd://host:3551 | simulator | '' (off). */
  ups: string | undefined;
  upsPollMs: number;
  upsCriticalPercent: number;
  /** Cloud base URL (stage 6); null = the club runs standalone, the outbox just accumulates. */
  cloudUrl: string | null;
  cloudApiKey: string;
  hubId: string;
  /** How often the outbox is pushed to the cloud (also the heartbeat period). */
  cloudSyncIntervalMs: number;
  /** HTTPS (`bills ca init`): server certificate and key (PEM); both unset = plain HTTP. */
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  /** Root certificate handed out on /ca.crt; default `ca.crt` next to HUB_TLS_CERT. */
  tlsCa: string | undefined;
  /** With HTTPS: plain-HTTP port that redirects to HTTPS and serves /ca; null = no such listener. */
  httpPort: number | null;
  /** mDNS name announced in the club network (`hub` → hub.local); null = off. */
  mdnsName: string | null;
  /** Folder for `ca init`; default `tls/` next to the database. */
  tlsDir: string;
  /**
   * Origins of screens served from another domain (a club screen on Cloudflare/GitHub Pages),
   * e.g. `https://*.pages.dev`. Empty: no CORS — the club's own screens come from the HUB itself.
   */
  corsOrigins: string[];
  /** Public demo club: fixed demo keys, GET /api/demo, the database is wiped nightly (src/demo.ts). */
  demo: boolean;
  /** Next demo reset, epoch ms; set by src/demo.ts for the child HUB. */
  demoResetAt: number | null;
  /** HUB_LICENSE: `enforce` (default) — the license limits the club; `off` — no checks. The demo is always off. */
  licenseMode: 'enforce' | 'off';
  /** Public keys licenses are checked with: the platform's, plus the dev key with HUB_LICENSE_DEV_KEY=1. */
  licensePublicKeys: Record<string, string>;
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
  const cloudUrl = env.CLOUD_URL?.trim();
  const dbPath = env.HUB_DB_PATH ?? fileURLToPath(new URL('../data/hub.db', import.meta.url));
  const licenseMode = (env.HUB_LICENSE?.trim().toLowerCase() || 'enforce') as 'enforce' | 'off';
  if (licenseMode !== 'enforce' && licenseMode !== 'off') throw new Error(`HUB_LICENSE must be enforce or off, got "${env.HUB_LICENSE}"`);
  return {
    host: env.HUB_HOST ?? '127.0.0.1',
    dbPath,
    // PORT is set by Render and similar hosts.
    port: int(env.HUB_PORT ?? env.PORT, 4310, 'HUB_PORT'),
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
    ups: env.HUB_UPS || undefined,
    upsPollMs: int(env.HUB_UPS_POLL_MS, 5000, 'HUB_UPS_POLL_MS'),
    upsCriticalPercent: int(env.HUB_UPS_CRITICAL_PERCENT, 20, 'HUB_UPS_CRITICAL_PERCENT'),
    cloudUrl: cloudUrl ? cloudUrl.replace(/\/+$/, '') : null,
    cloudApiKey: env.CLOUD_API_KEY ?? '',
    hubId: env.HUB_ID ?? '',
    cloudSyncIntervalMs: int(env.CLOUD_SYNC_INTERVAL_MS, 10_000, 'CLOUD_SYNC_INTERVAL_MS'),
    tlsCert: env.HUB_TLS_CERT || undefined,
    tlsKey: env.HUB_TLS_KEY || undefined,
    tlsCa: env.HUB_TLS_CA || undefined,
    httpPort: env.HUB_HTTP_PORT ? int(env.HUB_HTTP_PORT, 0, 'HUB_HTTP_PORT') : null,
    mdnsName: env.HUB_MDNS_NAME?.trim() || null,
    tlsDir: env.HUB_TLS_DIR || join(dirname(dbPath), 'tls'),
    corsOrigins: parseOrigins(env.HUB_CORS_ORIGINS),
    demo: flag(env.HUB_DEMO, false),
    demoResetAt: env.HUB_DEMO_RESET_AT ? int(env.HUB_DEMO_RESET_AT, 0, 'HUB_DEMO_RESET_AT') : null,
    licenseMode,
    licensePublicKeys: {
      ...PLATFORM_LICENSE_PUBLIC_KEYS,
      ...(flag(env.HUB_LICENSE_DEV_KEY, false) ? { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey } : {}),
    },
  };
}
