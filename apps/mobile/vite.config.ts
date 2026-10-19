import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The app is the owner cabinet (apps/cloud-web/src) plus the native shell in src/; built into www/
// with relative paths so the WebView loads it from the app bundle.
// VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (process env or apps/mobile/.env*) → Supabase build:
// sign-in by e-mail, pushes through ntfy, FCM is not registered. Without them — the self-hosted cloud with FCM.
export default defineConfig(({ mode }) => {
  const vite = loadEnv(mode, '.', 'VITE_');
  const supabase = Boolean(vite.VITE_SUPABASE_URL && vite.VITE_SUPABASE_ANON_KEY);
  return {
    base: './',
    define: { __TS_SUPABASE__: JSON.stringify(supabase) },
    plugins: [react()],
    build: { outDir: 'www', emptyOutDir: true },
    server: { port: 5190, strictPort: true },
  };
});
