import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WEB_PORT / HUB_URL let a second copy run beside the default one (see scripts/local.mjs).
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': env.HUB_URL ?? 'http://127.0.0.1:4310',
    },
  },
});
