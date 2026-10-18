import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports come from the environment so several checkouts (worktrees, parallel
// sessions) can run side by side: WEB_PORT for this dev server, HUB_PORT for
// the HUB it proxies /api to. Defaults match README.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const hubPort = Number(process.env.HUB_PORT ?? 4310);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${hubPort}`,
    },
  },
});
