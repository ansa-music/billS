import type { SqlDriver } from '../db/driver.ts';
import type { AuthAdmin } from './auth-admin.ts';
import { authAdminApi } from './auth-admin.ts';
import type { LicenseSigner } from '../license.ts';
import { licenseSignerFromEnv, signPendingLicenses } from '../license.ts';
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
  /** Signs client licenses: LICENSE_SIGNING_KEY + LICENSE_KEY_ID, the dev key (logged) without them. */
  licenseSigner: LicenseSigner;
  /**
   * Checks a Supabase Auth access token and returns its user, or null when the token is not
   * valid. Built from SUPABASE_URL + SUPABASE_ANON_KEY (GET /auth/v1/user); null when they are
   * missing. Used by `platform` (verify_jwt = false), which must check signatures itself.
   */
  authUser: AuthUserLookup | null;
  /**
   * Supabase Auth admin API (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, both set by Supabase in
   * every function); null when missing. Used by `invite-manager`.
   */
  authAdmin: AuthAdmin | null;
  /** The manager cabinet's address for links in letters: TS_CABINET_URL, else DEFAULT_CABINET_URL. */
  cabinetUrl: string;
}

export const DEFAULT_CABINET_URL = 'https://ts-cabinet.pages.dev';

export type AuthUserLookup = (accessToken: string) => Promise<{ id: string; email: string | null } | null>;

/** The Auth API of the project answers GET /auth/v1/user only for a valid, unexpired token. */
export function authApiLookup(supabaseUrl: string, anonKey: string, fetchFn: typeof fetch = fetch): AuthUserLookup {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
  return async (token) => {
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${token}`, apikey: anonKey } });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: unknown; email?: unknown };
    return typeof user.id === 'string' ? { id: user.id, email: typeof user.email === 'string' ? user.email : null } : null;
  };
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
 * CLOUD_HUB_OFFLINE_MINUTES (10), CLOUD_SHIFT_OPEN_HOURS (20), CLOUD_PUSH_MAX_AGE_MINUTES (120),
 * LICENSE_SIGNING_KEY (PKCS#8 Ed25519; the dev key when missing), LICENSE_KEY_ID ('ts-2026'),
 * SUPABASE_URL + SUPABASE_ANON_KEY (Auth API lookups), SUPABASE_SERVICE_ROLE_KEY (Auth admin API).
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
    licenseSigner: licenseSignerFromEnv(env, log),
    authUser:
      env.SUPABASE_URL?.trim() && env.SUPABASE_ANON_KEY?.trim()
        ? authApiLookup(env.SUPABASE_URL.trim(), env.SUPABASE_ANON_KEY.trim())
        : null,
    authAdmin:
      env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim()
        ? authAdminApi(env.SUPABASE_URL.trim(), env.SUPABASE_SERVICE_ROLE_KEY.trim())
        : null,
    cabinetUrl: (env.TS_CABINET_URL?.trim() || DEFAULT_CABINET_URL).replace(/\/+$/, ''),
  };
}

/** Signs licenses written unsigned by SQL (ts_seed_demo_cloud); a failure is only logged. */
export async function signPendingQuietly(ctx: Pick<EdgeContext, 'db' | 'licenseSigner' | 'log'>): Promise<void> {
  try {
    await signPendingLicenses(ctx.db, ctx.licenseSigner, ctx.log);
  } catch (e) {
    ctx.log(`Подпись лицензий: ${(e as Error).message}`);
  }
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
