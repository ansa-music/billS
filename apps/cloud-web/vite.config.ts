import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The cabinet talks to the cloud server; ports come from the root .env so several stands do not clash.
// Backend choice and the sub-path come from VITE_* (process env or apps/cloud-web/.env*):
// VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY → Supabase mode; VITE_BASE → e.g. /billS/cabinet/ on GitHub Pages.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', ['CLOUD_', 'CLOUD_WEB_']);
  const vite = loadEnv(mode, '.', 'VITE_');
  const cloudPort = Number(env.CLOUD_PORT ?? 4320);
  const webPort = Number(env.CLOUD_WEB_PORT ?? 5180);
  const supabase = Boolean(vite.VITE_SUPABASE_URL && vite.VITE_SUPABASE_ANON_KEY);
  const base = normalizeBase(vite.VITE_BASE);
  return {
    base,
    define: { __TS_SUPABASE__: JSON.stringify(supabase) },
    plugins: [
      react(),
      // PWA: the owner installs the cabinet on the phone (served over HTTPS).
      // Manifest and icons are static files in public/ with relative paths, so any base path works;
      // the worker precaches the app shell and updates itself — the cabinet holds no unsaved state
      // worth a "new version" prompt. public/push-sw.js adds the Web Push handlers to the worker.
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'script-defer',
        manifest: false,
        devOptions: { enabled: false },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          importScripts: ['push-sw.js'],
          runtimeCaching: [
            {
              // Reports and sign-in are always live: the API (same origin or the cloud's) is never cached.
              urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${cloudPort}`,
      },
    },
  };
});

/** "" → "/", "billS/cabinet" → "/billS/cabinet/", "./" stays relative. */
function normalizeBase(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw || raw === '/') return '/';
  if (raw === './' || raw === '.') return './';
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
}
