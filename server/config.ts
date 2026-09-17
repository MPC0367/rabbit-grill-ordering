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

export const config = {
  production,
  /** Port the API listens on. In `npm run dev` this is API_PORT behind Vite. */
  port: int(env.RG_LISTEN_PORT, int(env.PORT, 8344)),
  host: env.HOST || '0.0.0.0',
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${int(env.PORT, 8344)}`).replace(/\/+$/, ''),
  trustProxyHops: int(env.TRUST_PROXY_HOPS, 0),
  cookieSecure: flag(env.COOKIE_SECURE, production),
  databasePath: resolve(env.DATABASE_PATH || 'var/rabbit-grill.db'),
  reportsDir: resolve(env.REPORTS_DIR || 'var/reports'),
  distDir: resolve('dist'),
  publicDir: resolve('public'),
  seedDemo: flag(env.SEED_DEMO, !production),
  seedHistory: flag(env.SEED_HISTORY, !production),
  browserPath: env.BROWSER_PATH || '',
  paymentProvider: env.PAYMENT_PROVIDER || '',
  serveClient: flag(env.SERVE_CLIENT, true),
  staffSessionHours: int(env.STAFF_SESSION_HOURS, 14),
  guestSessionHours: int(env.GUEST_SESSION_HOURS, 12),
  logRequests: flag(env.LOG_REQUESTS, false),
};

export type Config = typeof config;
