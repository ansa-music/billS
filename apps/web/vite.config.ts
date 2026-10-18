import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Ports come from the root .env (HUB_PORT, WEB_PORT) so two stands can run side by side.
const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const hubPort = Number(env.HUB_PORT ?? 4310);
  const webPort = Number(env.WEB_PORT ?? 5173);
  return {
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${hubPort}`,
      },
    },
  };
});
