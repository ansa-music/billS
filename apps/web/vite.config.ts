import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Ports come from the same root .env as the HUB (HUB_PORT, WEB_PORT), so several
// checkouts (worktrees, parallel sessions, scripts/local.mjs) can run side by side.
// The /api proxy follows HUB_URL, or HUB_PORT when HUB_URL is not set. Process env wins over .env.
const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * VITE_DEMO_LOCAL=1: the HUB's own code (apps/hub/src) is bundled into the page.
 * Node built-ins and Fastify are swapped for small browser stand-ins.
 */
function demoHubAliases() {
  const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  const shim = (name: string) => at(`./src/demo-hub/shims/${name}.ts`);
  return [
    { find: /^@ts-hub\//, replacement: `${at('../hub/src/')}` },
    { find: /^fastify$/, replacement: at('./src/demo-hub/mini-fastify.ts') },
    { find: /^@fastify\/static$/, replacement: shim('fastify-static') },
    { find: /^node:sqlite$/, replacement: shim('sqlite') },
    { find: /^node:fs$/, replacement: shim('fs') },
    { find: /^node:path$/, replacement: shim('path') },
    { find: /^node:url$/, replacement: shim('url') },
    { find: /^node:crypto$/, replacement: shim('crypto') },
    { find: /^node:events$/, replacement: shim('events') },
    { find: /^node:(net|child_process)$/, replacement: shim('process') },
  ];
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const hubPort = Number(env.HUB_PORT || 4310);
  const webPort = Number(env.WEB_PORT || 5173);
  const hubUrl = env.HUB_URL || `http://127.0.0.1:${hubPort}`;
  // Public demo without a server: the real HUB runs inside the page (src/demo-hub).
  const demoLocal = env.VITE_DEMO_LOCAL === '1';
  return {
    // Sub-path hosting (GitHub Pages: /billS/demo/). The app uses a hash router, so only assets move.
    base: env.VITE_BASE || '/',
    resolve: demoLocal ? { alias: demoHubAliases() } : {},
    plugins: [
      react(),
      // PWA: the service worker precaches the built interface so a hall tablet opens it
      // even when the HUB is briefly unreachable. The manifest and icons are static files
      // in public/ (not generated); the worker is registered from React (src/pwa.tsx),
      // which also shows the "new version" banner — nothing reloads by itself.
      VitePWA({
        registerType: 'prompt',
        injectRegister: null,
        manifest: false,
        devOptions: { enabled: false },
        workbox: {
          // The demo build also precaches SQLite (WebAssembly), so it opens offline too.
          globPatterns: [`**/*.{js,css,html,svg,png,woff2,webmanifest${demoLocal ? ',wasm' : ''}}`],
          // Inter Variable (woff2) is well over the default 2 MiB limit.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          // A new build waits until the user taps «Обновить» (src/pwa.tsx) — no forced reloads.
          skipWaiting: false,
          // The very first worker takes control of the page that registered it; otherwise
          // that page is never controlled, the next build activates silently and the
          // update banner has nothing to switch to.
          clientsClaim: true,
          runtimeCaching: [
            {
              // Nothing under /api/ is ever cached: state, commands, the SSE stream
              // (/api/events) and the dev simulators (/api/dev/*). NetworkOnly is a plain
              // fetch() whose response is handed straight back to the page — the SSE body
              // streams through untouched, and a failed request fails like it would
              // without a service worker (the app shows its own offline banner).
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
        '/api': hubUrl,
      },
    },
  };
});
