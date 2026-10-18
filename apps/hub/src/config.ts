import { fileURLToPath } from 'node:url';

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return {
    host: env.HUB_HOST ?? '127.0.0.1',
    port: Number(env.HUB_PORT ?? 4310),
    dbPath: env.HUB_DB_PATH ?? fileURLToPath(new URL('../data/hub.db', import.meta.url)),
    demoTimezone: env.HUB_DEMO_TZ ?? 'Asia/Almaty',
    simulatorLatencyMs: Number(env.HUB_SIM_LATENCY_MS ?? 300),
    webDistPath: env.HUB_WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
  };
}
