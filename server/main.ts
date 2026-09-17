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
  for (const ip of lan) console.log(`[server]   LAN: http://${ip}:${info.port}`);
  console.log(`[server] QR base URL: ${config.publicBaseUrl}`);
});

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
