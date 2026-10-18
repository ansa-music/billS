import { fileURLToPath } from 'node:url';

export interface HubConfig {
  host: string;
  port: number;
  dbPath: string;
  /** Time zone of the demo club created on first start. */
  demoTimezone: string;
  /** Simulated controller response time. */
  simulatorLatencyMs: number;
  /** Cloud base URL (stage 6); null = the club runs standalone, the outbox just accumulates. */
  cloudUrl: string | null;
  cloudApiKey: string;
  hubId: string;
  /** How often the outbox is pushed to the cloud (also the heartbeat period). */
  cloudSyncIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const cloudUrl = env.CLOUD_URL?.trim();
  return {
    host: env.HUB_HOST ?? '127.0.0.1',
    port: Number(env.HUB_PORT ?? 4310),
    dbPath: env.HUB_DB_PATH ?? fileURLToPath(new URL('../data/hub.db', import.meta.url)),
    demoTimezone: env.HUB_DEMO_TZ ?? 'Asia/Almaty',
    simulatorLatencyMs: Number(env.HUB_SIM_LATENCY_MS ?? 300),
    cloudUrl: cloudUrl ? cloudUrl.replace(/\/+$/, '') : null,
    cloudApiKey: env.CLOUD_API_KEY ?? '',
    hubId: env.HUB_ID ?? '',
    cloudSyncIntervalMs: Number(env.CLOUD_SYNC_INTERVAL_MS ?? 10_000),
  };
}
