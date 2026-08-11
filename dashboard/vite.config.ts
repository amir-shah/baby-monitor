import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Pi serves the built dashboard from the API process (`paths.static_dir`),
 * mounted at the site root — hence `base: '/'` and a flat `dist/`.
 *
 * Everything the app talks to lives under `/api`, so in dev we proxy that to
 * the Python service instead of enabling CORS. The proxy must not buffer:
 * `/api/stream/events` is Server-Sent Events and `/api/stream/mjpeg` is a
 * never-ending multipart response. `http-proxy` streams both through
 * untouched as long as we do not add a body-rewriting middleware.
 */
const API_TARGET = process.env.BABYMON_API_URL ?? 'http://127.0.0.1:8080';

const apiProxy = {
  target: API_TARGET,
  changeOrigin: false,
  // Long-lived responses (SSE, MJPEG). 0 disables the proxy timeout.
  timeout: 0,
  proxyTimeout: 0,
} as const;

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    // No manualChunks: one small app chunk beats a waterfall of tiny ones on
    // a LAN-served single-page app.
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': apiProxy,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': apiProxy,
    },
  },
});
