import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The same root .env as the HUB: the proxy follows HUB_PORT.
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${env.HUB_PORT || 4310}`,
      },
    },
  };
});
