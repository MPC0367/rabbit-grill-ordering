// Entry point: migrate, seed development fixtures if asked, start jobs, listen.
import { serve } from '@hono/node-server';
import { networkInterfaces } from 'node:os';
import { config } from './config.ts';
import { closeDatabase, migrate, openDatabase } from './db/index.ts';
import { createApp } from './app.ts';
import { startJobs, stopJobs } from './jobs/runner.ts';

openDatabase();
const applied = migrate();
if (applied.length) console.log(`[db] applied ${applied.join(', ')}`);

if (config.seedDemo) {
  if (config.production) {
    console.warn('[seed] SEED_DEMO is ignored in production.');
  } else {
    const { seedIfEmpty } = await import('./db/seed.ts');
    await seedIfEmpty({ history: config.seedHistory });
  }
}

const app = createApp();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  console.log(`[server] Rabbit Grill ordering API on http://localhost:${info.port}`);
  // A loopback listener (npm run dev's API) is not reachable at the LAN address.
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopbackOnly) for (const ip of lan) console.log(`[server]   LAN: http://${ip}:${info.port}`);
  console.log(`[server] QR base URL: ${config.publicBaseUrl}`);
  for (const line of configWarnings(lan)) console.warn(`[server] WARNING: ${line}`);
});

/** Settings that silently break phones or sign-in on a real install (D-S8-09). */
function configWarnings(lan: string[]): string[] {
  const out: string[] = [];
  let baseHost = '';
  try { baseHost = new URL(config.publicBaseUrl).hostname; } catch { out.push(`PUBLIC_BASE_URL "${config.publicBaseUrl}" is not a valid URL.`); }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(baseHost);
  if (loopback && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    out.push(`QR cards point at ${config.publicBaseUrl}, which phones cannot open.${config.publicBaseUrlDefaulted ? ' PUBLIC_BASE_URL is not set.' : ''}`
      + ` Set PUBLIC_BASE_URL to the address guests use${lan[0] ? ` (for example http://${lan[0]}:${config.port})` : ''} before printing cards.`);
  }
  if (config.cookieSecure && config.publicBaseUrl.startsWith('http:')) {
    out.push('COOKIE_SECURE is on but PUBLIC_BASE_URL is plain http: browsers drop Secure cookies over http, so staff cannot sign in'
      + ' and guests cannot join. Serve https, or set COOKIE_SECURE=0 for a LAN-only install.');
  }
  if (config.production && !config.cookieSecure) {
    out.push('Cookies are not marked Secure (PUBLIC_BASE_URL is http). That is expected on a closed restaurant LAN; use https anywhere else.');
  }
  return out;
}

startJobs();

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal}: shutting down`);
  stopJobs();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
