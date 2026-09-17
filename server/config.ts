// Runtime configuration from the environment (see .env.example).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependency): KEY=VALUE lines, # comments.
function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

const env = process.env;
const int = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const flag = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : v === '1' || v.toLowerCase() === 'true');

const production = env.NODE_ENV === 'production';
const publicBaseUrl = (env.PUBLIC_BASE_URL || `http://localhost:${int(env.PORT, 8344)}`).replace(/\/+$/, '');

export const config = {
  production,
  /** Port the API listens on. In `npm run dev` this is API_PORT behind Vite. */
  port: int(env.RG_LISTEN_PORT, int(env.PORT, 8344)),
  host: env.HOST || '0.0.0.0',
  publicBaseUrl,
  /** PUBLIC_BASE_URL was not configured, so QR cards point at localhost. */
  publicBaseUrlDefaulted: !env.PUBLIC_BASE_URL,
  trustProxyHops: int(env.TRUST_PROXY_HOPS, 0),
  /**
   * Secure cookies. Unset: follows the scheme of PUBLIC_BASE_URL (https = Secure).
   * Browsers drop Secure cookies over plain http, so a production build on a
   * LAN address would otherwise let nobody sign in or join a table (D-S8-09).
   */
  cookieSecure: flag(env.COOKIE_SECURE, publicBaseUrl.startsWith('https:')),
  databasePath: resolve(env.DATABASE_PATH || 'var/rabbit-grill.db'),
  reportsDir: resolve(env.REPORTS_DIR || 'var/reports'),
  distDir: resolve('dist'),
  publicDir: resolve('public'),
  /**
   * Demo fixtures (draft catalog, demo staff with published passwords, a
   * synthetic year) are seeded ONLY when SEED_DEMO is set. A bare
   * `node server/main.ts` against a restaurant's database must never invent
   * accounts or orders (D-S8-30). `npm run dev` and `npm run seed` set it.
   */
  seedDemo: flag(env.SEED_DEMO, false),
  seedHistory: flag(env.SEED_HISTORY, !production),
  browserPath: env.BROWSER_PATH || '',
  paymentProvider: env.PAYMENT_PROVIDER || '',
  serveClient: flag(env.SERVE_CLIENT, true),
  /** Serve dist/assets/*.map (off by default: source maps publish the whole client source). */
  serveSourceMaps: flag(env.SERVE_SOURCEMAPS, false),
  staffSessionHours: int(env.STAFF_SESSION_HOURS, 14),
  guestSessionHours: int(env.GUEST_SESSION_HOURS, 12),
  logRequests: flag(env.LOG_REQUESTS, false),
  /**
   * How often an open live stream sends its `ping` (and the comment keep-alive
   * proxies need). The `hello` payload publishes it as `ping_ms`, so the
   * client's silence watchdog waits for a multiple of the server's own
   * interval instead of guessing (D-F-03). Clamped to 1-60 s; tests set it low
   * so a heartbeat can be observed in a second rather than half a minute.
   */
  streamPingMs: Math.min(60_000, Math.max(1_000, int(env.STREAM_PING_MS, 15_000))),
  /**
   * The daily data-retention task (D-S8-02). Off by default under NODE_ENV=test,
   * where tests plant old records on purpose and run the task themselves
   * (npm run jobs -- retention).
   */
  retentionJob: flag(env.RETENTION_JOB, env.NODE_ENV !== 'test'),
};

export type Config = typeof config;
