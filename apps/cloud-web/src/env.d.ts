/** Set by vite.config.ts (`define`): true when the build has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. */
declare const __TS_SUPABASE__: boolean;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}
