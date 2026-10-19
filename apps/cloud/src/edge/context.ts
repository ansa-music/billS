import type { SqlDriver } from '../db/driver.ts';
import type { Log, PushSender, WatchdogOptions } from '../push.ts';
import { PushDispatcher, pushSenderFromEnv, RoutingSender } from '../push.ts';

/** Everything an Edge Function handler needs; built once per isolate and reused across requests. */
export interface EdgeContext {
  db: SqlDriver;
  push: PushDispatcher;
  /** Channels that will actually send: 'webpush' (VAPID set), 'ntfy', 'fcm'. */
  pushChannels: string[];
  now: () => number;
  log: Log;
  watchdog: WatchdogOptions;
  /** `x-ts-cron` must equal it for `notify`; null → notify refuses to run. */
  notifySecret: string | null;
  /**
   * Legacy HS256 JWT secret of the project (optional). When set, the `owner` function checks
   * HS256 signatures itself; otherwise it relies on the platform (`verify_jwt = true`).
   */
  jwtSecret: string | null;
  /** Origins allowed to call `owner` from a browser; empty → any (`*`), the token is the guard. */
  corsOrigins: string[];
}

export type Env = Record<string, string | undefined>;

const minutes = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface EdgeContextOptions {
  log?: Log;
  now?: () => number;
  /** Replaces the senders built from the environment (tests). */
  sender?: PushSender;
}

/**
 * Builds the context from Supabase secrets / environment:
 * NOTIFY_SECRET, TS_CABINET_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, NTFY_TOKEN,
 * NTFY_DISABLED, CLOUD_FCM_SERVICE_ACCOUNT_JSON, SUPABASE_JWT_SECRET (optional), TS_CORS_ORIGINS,
 * CLOUD_HUB_OFFLINE_MINUTES (10), CLOUD_SHIFT_OPEN_HOURS (20), CLOUD_PUSH_MAX_AGE_MINUTES (120).
 */
export function edgeContext(db: SqlDriver, env: Env, options: EdgeContextOptions = {}): EdgeContext {
  const log = options.log ?? ((m: string) => console.log(m));
  const now = options.now ?? (() => Date.now());
  const sender = options.sender ?? pushSenderFromEnv(env, log);
  const push = new PushDispatcher(db, sender, now, {
    maxAgeMs: minutes(env.CLOUD_PUSH_MAX_AGE_MINUTES, 120) * 60_000,
    log,
  });
  const pushChannels = sender instanceof RoutingSender ? sender.channels : sender.enabled ? ['custom'] : [];
  return {
    db,
    push,
    pushChannels,
    now,
    log,
    watchdog: {
      hubOfflineMs: minutes(env.CLOUD_HUB_OFFLINE_MINUTES, 10) * 60_000,
      shiftOpenMs: minutes(env.CLOUD_SHIFT_OPEN_HOURS, 20) * 3_600_000,
    },
    notifySecret: env.NOTIFY_SECRET?.trim() || null,
    jwtSecret: env.SUPABASE_JWT_SECRET?.trim() || null,
    corsOrigins: (env.TS_CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

/** Sends what is queued; a failure is logged, never turned into an error for the caller. */
export async function flushQuietly(ctx: Pick<EdgeContext, 'push' | 'log'>): Promise<void> {
  try {
    await ctx.push.flush();
  } catch (e) {
    ctx.log(`Ошибка рассылки push: ${(e as Error).message}`);
  }
}

/**
 * Tells the database whether Web Push is configured (VAPID keys present): the RPC
 * owner_push_settings() cannot see function secrets and reads `ts_runtime.push_configured`.
 * Best effort: a missing table (older schema) is only logged.
 */
export async function reportPushConfigured(ctx: Pick<EdgeContext, 'db' | 'now' | 'log' | 'pushChannels'>): Promise<void> {
  try {
    await ctx.db.run(
      `INSERT INTO ts_runtime (key, value, updated_at) VALUES ('push_configured', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [ctx.pushChannels.includes('webpush') ? '1' : '0', ctx.now()],
    );
  } catch (e) {
    ctx.log(`ts_runtime: ${(e as Error).message}`);
  }
}
