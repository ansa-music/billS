/**
 * Entry of the Edge Functions core bundle (`node scripts/bundle-edge.mjs` →
 * supabase/functions/_shared/core.js). Runtime-neutral: WHATWG Request/Response,
 * WebCrypto, `node:*` builtins only — runs in Node (tests) and Deno (Supabase).
 */
export type { SqlDriver } from '../db/driver.ts';
export { createPostgresDriver } from '../db/postgres.ts';
export type { PgPoolLike } from '../db/postgres.ts';
export type { EdgeContext, EdgeContextOptions, Env } from './context.ts';
export { edgeContext, flushQuietly, reportPushConfigured } from './context.ts';
export type { EdgeRequest } from './http.ts';
export { routeOf } from './http.ts';
export { handleSync } from './sync.ts';
export { handlePlatform } from './platform.ts';
export { handleInviteManager } from './invite-manager.ts';
export { handleSignup } from './signup.ts';
export { handleBooking } from './booking.ts';
export { handleTrial } from './trial.ts';
export { authUserId, handleOwner, requireOwner } from './owner.ts';
export { handleNotify, sameSecret } from './notify.ts';
export { handleTelegram } from './telegram.ts';
export { NtfySender, pushSenderFromEnv, RoutingSender, WebPushSender } from '../push.ts';
