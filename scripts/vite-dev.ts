// Vite dev server for `npm run dev` (scripts/dev.ts starts it as the "web"
// child). It is `vite --port $PORT --strictPort` plus two things:
//
// 1. A file-serving allow-list. During LAN phone testing anyone on the Wi-Fi
//    can reach this port, and Vite's default allow-list is the whole project.
//    /@fs/<path> would then hand out the SQLite database (live visit PINs, QR
//    tokens, staff password hashes), the report files and the server source.
//    Only what the browser app needs is served: client/, shared/ (imported by
//    the client), public/ and node_modules/ (fonts, React). test/e2e/run.ts
//    checks this ("dev server file serving").
// 2. X-Forwarded-For on every proxied request (`xfwd`). The API behind this
//    proxy sees every phone as 127.0.0.1 otherwise, so one wrong PIN guesser
//    or one busy table would use up everybody's join and sign-in budgets.
//    scripts/dev.ts starts the API with TRUST_PROXY_HOPS=1 to read it.
import { resolve } from 'node:path';
import { createServer, type FileSystemServeOptions, type Plugin } from 'vite';

const root = resolve(import.meta.dirname, '..');
const abs = (p: string) => resolve(root, p).replace(/\\/g, '/');

export const DEV_FS: FileSystemServeOptions = {
  strict: true,
  allow: ['client', 'shared', 'public', 'node_modules'].map(abs),
  // Setting `deny` replaces Vite's defaults, so they are repeated here.
  deny: [
    '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
    '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.sqlite-*',
    `${abs('var')}/**`, `${abs('server')}/**`, `${abs('scripts')}/**`, `${abs('data-src')}/**`, `${abs('test')}/**`,
  ],
};

/** Adds `xfwd: true` to every proxy entry vite.config.ts defines, whatever its keys. */
export const forwardClientAddress: Plugin = {
  name: 'rg-forward-client-address',
  apply: 'serve',
  config(config) {
    const proxy = config.server?.proxy;
    if (!proxy) return;
    for (const [path, entry] of Object.entries(proxy)) {
      proxy[path] = typeof entry === 'string' ? { target: entry, xfwd: true } : { ...entry, xfwd: true };
    }
  },
};

/**
 * Vite refuses requests whose Host header it does not recognise (it allows
 * localhost and bare IP addresses, which covers LAN phone testing). A hosted
 * development environment serves the app on a real hostname, so that hostname
 * has to be named: DEV_ALLOWED_HOSTS=".example.dev,host.example" adds them, and
 * a GitHub codespace's forwarding domain is added automatically.
 */
export function devAllowedHosts(env = process.env): string[] {
  const listed = (env.DEV_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const codespace = env.CODESPACE_NAME ? [`.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev'}`] : [];
  return [...new Set([...listed, ...codespace])];
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8344);
  const allowedHosts = devAllowedHosts();
  const server = await createServer({
    configFile: resolve(root, 'vite.config.ts'),
    plugins: [forwardClientAddress],
    server: { port, strictPort: true, fs: DEV_FS, ...(allowedHosts.length ? { allowedHosts } : {}) },
  });
  await server.listen();
  server.printUrls();
  const stop = async () => {
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
