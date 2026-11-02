import type { CafeHub } from './cafe-hub.ts';
import type { AdminRegistry } from './registry.ts';

/** Bindings of wrangler.toml. */
export interface Env {
  /** One Durable Object per café, named by its café code. */
  CAFE: DurableObjectNamespace<CafeHub>;
  /** One object for the admin API's Idempotency-Keys (registry.ts). */
  REGISTRY: DurableObjectNamespace<AdminRegistry>;
  /** The TS screens built for the cloud (scripts/build-web.mjs), served from the same origin. */
  ASSETS?: Fetcher;
  /** Bearer token of /admin/* (a secret: `wrangler secret put ADMIN_TOKEN`; locally `--var`). */
  ADMIN_TOKEN?: string;
  /** Other origins allowed to call the API (comma-separated patterns, `https://*.pages.dev`). */
  ALLOWED_ORIGINS?: string;
  /** Local tuning only: log SQL statements that read or write more rows than this (shims/sqlite.ts). */
  COST_DEBUG?: string;
}
