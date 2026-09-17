import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.API_PORT ?? 8345);
const api = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  root: 'client',
  publicDir: '../public',
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 8344),
    strictPort: true,
    host: process.env.HOST ?? '0.0.0.0',
    proxy: {
      // SSE streams pass straight through; the API sets no-transform headers.
      '/api': { target: api, changeOrigin: false, ws: false },
      '/files': { target: api, changeOrigin: false },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
