// `npm run dev`: one command, one URL (http://localhost:8344 by default).
//
//  1. Seed. An empty development database gets the demo fixtures (draft
//     catalog, tables, demo staff, a synthetic year) BEFORE any watched process
//     starts, so saving a server file cannot interrupt the ~15 s seed. Skipped
//     with SEED_DEMO=0; SEED_HISTORY=0 skips only the synthetic year.
//  2. API. `node --watch server/main.ts` on 127.0.0.1:API_PORT. Only the Vite
//     proxy talks to it, so it is not reachable from the network. It runs with
//     TRUST_PROXY_HOPS=1 (whatever .env says): Vite is exactly one proxy and
//     adds X-Forwarded-For, so rate limits see each phone's own address.
//  3. Web. Vite on HOST:PORT (0.0.0.0 unless HOST is set, so phones on the same
//     Wi-Fi can open it), proxying /api and /files with X-Forwarded-For,
//     serving only the files the browser app needs (scripts/vite-dev.ts).
//
// QR cards print PUBLIC_BASE_URL. When it is not set, this script uses
// http://<this computer's LAN address>:PORT, because a phone cannot open
// "localhost" on the laptop. See docs/OPERATIONS.md.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createProbeServer } from 'node:net';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/** True when nothing else holds the port, so a clash is reported in words, not a stack trace. */
function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createProbeServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, host);
  });
}

/**
 * The open tables and their join PINs, for the banner below. The seed prints
 * these too, but only the first time it runs: every later start skips seeding,
 * so whoever is about to demo the system has no way to read a PIN off screen.
 * Development only, and never allowed to stop a start: an unreadable database
 * just means no banner.
 */
function openTablePins(): Array<{ label: string; pin: string | null; status: string }> {
  try {
    const file = resolve(ROOT, envValue('DATABASE_PATH', dotenv) ?? 'var/rabbit-grill.db');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(
        `SELECT t.label AS label, v.join_pin AS pin, v.status AS status
           FROM visits v JOIN dining_tables t ON t.id = v.table_id
          WHERE v.closed_at IS NULL
          ORDER BY t.sort, t.label`,
      ).all() as Array<{ label: string; pin: string | null; status: string }>;
    } finally {
      db.close();
    }
  } catch (e) {
    // Never fatal, but never silent either: a swallowed error here looks
    // exactly like "no tables are open", which is a lie worth noticing.
    say(`could not read the open-table PINs: ${(e as Error).message}`);
    return [];
  }
}

function pipe(name: string, child: ChildProcess) {
  const tag = (line: string) => (line.startsWith(`[${name}]`) ? line : `[${name}] ${line}`);
  child.stdout?.setEncoding('utf8').on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr?.setEncoding('utf8').on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => console.error(tag(l))));
}

// ---- 0. ports, before the ~15 s seed, so a clash costs a second and reads as a sentence
for (const [label, port, host] of [['web', Number(PORT), HOST], ['api', Number(API_PORT), '127.0.0.1']] as const) {
  if (!(await portFree(port, host))) {
    console.error(
      `[dev] port ${port} (${label}) is already in use.\n`
      + '[dev] The ordering system is most likely already running: open http://localhost:' + PORT + ' before starting another copy.\n'
      + '[dev] To run a second copy anyway, give it its own ports: PORT=8400 API_PORT=8401 npm run dev\n'
      + '[dev]   (PowerShell: $env:PORT=8400; $env:API_PORT=8401; npm run dev)',
    );
    process.exit(1);
  }
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
// Only a value set in the shell counts: a hosted environment that really does
// add a proxy in front of Vite sets it there (a codespace sets 2).
const shellHops = process.env.TRUST_PROXY_HOPS;
const devHops = shellHops !== undefined && shellHops !== '' ? shellHops : '1';

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
  // The Vite proxy is the only client and appends the phone's address to
  // X-Forwarded-For (scripts/vite-dev.ts). A higher value would let a phone
  // choose its own address by sending the header itself - raise it only when
  // another proxy you trust sits in front (a codespace sets 2 in the shell:
  // GitHub's port forwarding, then Vite). A value in .env is for `npm start`
  // and is NOT read here: .env.example ships 0, which would make every phone
  // share one rate-limit budget behind Vite.
  TRUST_PROXY_HOPS: devHops,
});
start('web', [resolve(ROOT, 'scripts/vite-dev.ts')], { PORT, API_PORT, HOST });

say(`this computer   http://localhost:${PORT}`);
if (hostIsLocal) say(`HOST=${HOST}: phones on the network cannot open this server.`);
for (const a of lan) say(`same Wi-Fi      http://${a.address}:${PORT}   (${a.name})`);
say(`QR cards        ${publicBaseUrl}${explicitBase ? '   (PUBLIC_BASE_URL)' : lan[0] ? '   (PUBLIC_BASE_URL not set: first LAN address above)' : ''}`);
if (isLoopbackUrl(publicBaseUrl)) say('warning: QR cards point at this computer only. Phones cannot open them; set PUBLIC_BASE_URL=http://<LAN address>:' + PORT);
say(`api             http://127.0.0.1:${API_PORT}   (local only, reached through the web port)`);
const fileHops = dotenv.TRUST_PROXY_HOPS;
if (fileHops !== undefined && fileHops !== '' && fileHops !== devHops) {
  say(`.env sets TRUST_PROXY_HOPS=${fileHops}; that setting is for "npm start". Development runs with ${devHops}.`);
}

// The PINs a guest needs, on every start - not only the start that seeded.
if (seedDemo) {
  const pins = openTablePins();
  if (pins.length) {
    const coded = pins.some((p) => p.pin);
    console.log([
      '',
      `  ======== DEVELOPMENT ONLY - tables open right now${coded ? ' (fixture PINs)' : ''} ========`,
      ...pins.map((p) => `    table ${p.label}${p.pin ? `  PIN ${p.pin}` : ''}${p.status === 'billing' ? '  (checking out: joins, cannot order)' : ''}`),
      coded
        ? '  Show a table\'s QR from Admin > Tables > Manage tables & QR, scan it, enter the PIN.'
        : '  Show a table\'s QR from Admin > Tables > Manage tables & QR and scan it: no code needed.',
      '  =========================================================================',
      '',
    ].join('\n'));
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
