/// <reference path="./env.d.ts" />

/**
 * Which backend the cabinet talks to, fixed at build time:
 * - Supabase (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY set): Auth, RPC, Realtime, Edge Functions;
 * - otherwise the self-hosted apps/cloud HTTP API (free mode on the club mini-PC).
 * `__TS_SUPABASE__` is a literal, so the bundler drops the unused backend.
 */
export const SUPABASE_MODE: boolean = __TS_SUPABASE__;

export function supabaseUrl(): string {
  return (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
}

export function supabaseAnonKey(): string {
  return import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
}

export function vapidPublicKey(): string {
  return import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';
}
