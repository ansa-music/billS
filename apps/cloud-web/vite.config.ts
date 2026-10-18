import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The cabinet talks to the cloud server; ports come from the root .env so several stands do not clash.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', ['CLOUD_', 'CLOUD_WEB_']);
  const cloudPort = Number(env.CLOUD_PORT ?? 4320);
  const webPort = Number(env.CLOUD_WEB_PORT ?? 5180);
  return {
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${cloudPort}`,
      },
    },
  };
});
