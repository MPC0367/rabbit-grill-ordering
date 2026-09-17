// `npm run dev`: one command, one URL (http://localhost:8344 by default).
//
//  1. Seed. An empty development database gets the demo fixtures (draft
//     catalog, tables, demo staff, a synthetic year) BEFORE any watched process
//     starts, so saving a server file cannot interrupt the ~15 s seed. Skipped
//     with SEED_DEMO=0; SEED_HISTORY=0 skips only the synthetic year.
//  2. API. `node --watch server/main.ts` on 127.0.0.1:API_PORT. Only the Vite
//     proxy talks to it, so it is not reachable from the network.
//  3. Web. Vite on HOST:PORT (0.0.0.0 unless HOST is set, so phones on the same
//     Wi-Fi can open it), proxying /api and /files, serving only the files the
//     browser app needs (scripts/vite-dev.ts).
//
// QR cards print PUBLIC_BASE_URL. When it is not set, this script uses
// http://<this computer's LAN address>:PORT, because a phone cannot open
// "localhost" on the laptop. See docs/OPERATIONS.md.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { envValue, isLoopbackUrl, isOff, lanAddresses, readDotEnv, ROOT } from './env.ts';

const dotenv = readDotEnv();
const PORT = envValue('PORT', dotenv) ?? '8344';
const API_PORT = envValue('API_PORT', dotenv) ?? String(Number(PORT) + 1);
const HOST = envValue('HOST', dotenv) ?? '0.0.0.0';
const hostIsLocal = /^(127\.|localhost$|::1$)/.test(HOST);
const lan = hostIsLocal ? [] : lanAddresses();
const explicitBase = envValue('PUBLIC_BASE_URL', dotenv);
const publicBaseUrl = (explicitBase ?? (lan[0] ? `http://${lan[0].address}:${PORT}` : `http://localhost:${PORT}`)).replace(/\/+$/, '');
const seedDemo = !isOff(envValue('SEED_DEMO', dotenv)) && process.env.NODE_ENV !== 'production';
const seedHistory = envValue('SEED_HISTORY', dotenv) ?? '1';

const say = (line: string) => console.log(`[dev] ${line}`);

function pipe(name: string, child: ChildProcess) {
  const tag = (line: string) => (line.startsWith(`[${name}]`) ? line : `[${name}] ${line}`);
  child.stdout?.setEncoding('utf8').on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr?.setEncoding('utf8').on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => console.error(tag(l))));
}

// ---- 1. seed to completion, outside any watcher
if (seedDemo) {
  const code = await new Promise<number>((done) => {
    const child = spawn(process.execPath, ['server/db/seed.ts'], {
      cwd: ROOT,
      env: { ...process.env, SEED_DEMO: '1', SEED_HISTORY: seedHistory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipe('seed', child);
    child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0)));
    const stop = () => child.kill();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  if (code !== 0) {
    console.error(`[dev] seeding stopped (exit ${code}). Fix the message above, or run "npm run db:reset" and start again.`);
    process.exit(code);
  }
} else {
  say('SEED_DEMO=0: not seeding. An empty database has no staff: run "npm run admin:create" first.');
}

// ---- 2 + 3. API (watched, local only) and web
const children: ChildProcess[] = [];
let stopping = false;

function start(name: string, args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  pipe(name, child);
  child.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    if (!stopping) shutdown(code ?? 1);
  });
  children.push(child);
}

start('api', ['--watch-path=server', '--watch-path=shared', '--watch-preserve-output', 'server/main.ts'], {
  RG_LISTEN_PORT: API_PORT,
  HOST: '127.0.0.1',
  PORT,
  PUBLIC_BASE_URL: publicBaseUrl,
  SERVE_CLIENT: '0',
  // Seeding already happened above; a watch restart must never start it.
  SEED_DEMO: '0',
});
start('web', [resolve(ROOT, 'scripts/vite-dev.ts')], { PORT, API_PORT, HOST });

say(`this computer   http://localhost:${PORT}`);
if (hostIsLocal) say(`HOST=${HOST}: phones on the network cannot open this server.`);
for (const a of lan) say(`same Wi-Fi      http://${a.address}:${PORT}   (${a.name})`);
say(`QR cards        ${publicBaseUrl}${explicitBase ? '   (PUBLIC_BASE_URL)' : lan[0] ? '   (PUBLIC_BASE_URL not set: first LAN address above)' : ''}`);
if (isLoopbackUrl(publicBaseUrl)) say('warning: QR cards point at this computer only. Phones cannot open them; set PUBLIC_BASE_URL=http://<LAN address>:' + PORT);
say(`api             http://127.0.0.1:${API_PORT}   (local only, reached through the web port)`);

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
