import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is the owner cabinet (apps/cloud-web/src) plus the native shell in src/; built into www/
// with relative paths so the WebView loads it from the app bundle.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'www', emptyOutDir: true },
  server: { port: 5190, strictPort: true },
});
