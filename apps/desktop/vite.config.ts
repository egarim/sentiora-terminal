import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to a bridge you started separately:
//   node apps/desktop/bin/living-terminal.mjs --port 8791 --allow-origin http://localhost:5173
//   npm --prefix apps/desktop run dev
// The production path needs no proxy at all: the bridge serves dist/ itself, so
// the UI and the API share one origin and one bearer token.
const bridgePort = Number(process.env.SENTIORA_DESKTOP_PORT ?? 8791);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${bridgePort}`,
        changeOrigin: false,
      },
    },
  },
});
