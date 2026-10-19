import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The cabinet talks to the cloud server; ports come from the root .env so several stands do not clash.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', ['CLOUD_', 'CLOUD_WEB_']);
  const cloudPort = Number(env.CLOUD_PORT ?? 4320);
  const webPort = Number(env.CLOUD_WEB_PORT ?? 5180);
  return {
    plugins: [
      react(),
      // PWA: the owner installs the cabinet on the phone (Firebase Hosting serves it over HTTPS).
      // Manifest and icons are static files in public/; the worker precaches the app shell and
      // updates itself — the cabinet holds no unsaved state worth a "new version" prompt.
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
