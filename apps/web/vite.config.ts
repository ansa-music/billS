import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports come from the environment so several checkouts (worktrees, parallel
// sessions, scripts/local.mjs) can run side by side: WEB_PORT for this dev
// server, HUB_URL (or HUB_PORT) for the HUB it proxies /api to. Defaults match README.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const webPort = Number(env.WEB_PORT ?? 5173);
const hubUrl = env.HUB_URL ?? `http://127.0.0.1:${Number(env.HUB_PORT ?? 4310)}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': hubUrl,
    },
  },
});
