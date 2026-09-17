import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.API_PORT ?? 8345);
const api = `http://127.0.0.1:${apiPort}`;

// The project root (this file's directory); `root` below is the client folder.
const project = import.meta.dirname;
const abs = (p: string) => resolve(project, p).replace(/\\/g, '/');

export default defineConfig({
  root: 'client',
  publicDir: '../public',
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 8344),
    strictPort: true,
    host: process.env.HOST ?? '0.0.0.0',
    // File-serving allow-list. The dev server listens on the LAN so phones can
    // open it, and Vite's default allow-list is the whole project: /@fs/<path>
    // would hand out the SQLite database (live PINs, QR tokens, staff password
    // hashes), the report files and the server source. `npm run dev` sets the
    // same list from scripts/vite-dev.ts; it is repeated here so a bare
    // `npx vite` is not weaker than the script. test/e2e/run.ts checks it
    // ("dev server file serving"). Keep the two in step.
    fs: {
      strict: true,
      allow: ['client', 'shared', 'public', 'node_modules'].map(abs),
      // Setting `deny` replaces Vite's defaults, so they are repeated here.
      deny: [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
        '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.sqlite-*',
        `${abs('var')}/**`, `${abs('server')}/**`, `${abs('scripts')}/**`, `${abs('data-src')}/**`, `${abs('test')}/**`,
      ],
    },
    proxy: {
      // SSE streams pass straight through; the API sets no-transform headers.
      // xfwd adds X-Forwarded-For: the API (TRUST_PROXY_HOPS=1) would otherwise
      // see every phone as 127.0.0.1, and one wrong-PIN guesser would use up
      // everybody's join and sign-in budget.
      '/api': { target: api, changeOrigin: false, ws: false, xfwd: true },
      '/files': { target: api, changeOrigin: false, xfwd: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Source maps are built but never published: the server answers 404 for
    // *.map, and nothing references them (no //# sourceMappingURL is emitted
    // for a hidden map). They stay in dist/ for reading a production stack.
    sourcemap: 'hidden',
    target: 'es2022',
    rolldownOptions: {
      // The ui barrel re-exports the staff kit. Its modules have no side
      // effects, so guest chunks that use none of it must not load it.
      treeshake: {
        moduleSideEffects: (id: string) => !/client[\/]src[\/]ui[\/]admin[\/]/.test(id),
      },
    },
  },
});
