// A throwaway app instance for the browser suites (test/e2e, test/visual).
//
//   const app = await startInstance({ port: 8771 });          // npm run dev path
//   const app = await startInstance({ mode: 'prod' });         // npm run build + npm start path
//   app.base  -> http://localhost:<port>
//   await app.stop();
//
// Each instance gets its own SQLite file and reports folder under
// var/e2e/<name>/ and is seeded with the demo fixtures before the server
// starts (the synthetic year too, unless history: false). Nothing touches the
// development database in var/rabbit-grill.db.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { lanAddresses } from '../../scripts/env.ts';

export const ROOT = resolve(import.meta.dirname, '..', '..');

export interface Instance {
  base: string;
  port: number;
  dir: string;
  log: string;
  stop: () => Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '0.0.0.0', () => s.close(() => done(true)));
  });
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // dev.ts has children of its own; take the whole tree down.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitFor(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  child.once('exit', (code) => { exited = code ?? 1; });
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`the app exited with ${exited} before it answered ${url}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${url}`);
}

export async function startInstance(opts: {
  name?: string;
  port?: number;
  mode?: 'dev' | 'prod';
  history?: boolean;
  /** Keep the database folder after stop (default: removed). */
  keep?: boolean;
  env?: Record<string, string>;
} = {}): Promise<Instance> {
  const mode = opts.mode ?? 'dev';
  const name = opts.name ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const port = opts.port ?? await freePort();
  const apiPort = port + 1;
  for (const p of mode === 'dev' ? [port, apiPort] : [port]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use; pass another --port`);
  }
  const dir = resolve(ROOT, 'var', 'e2e', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'app.log');
  const out = createWriteStream(log);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    API_PORT: String(apiPort),
    DATABASE_PATH: join(dir, 'app.db'),
    REPORTS_DIR: join(dir, 'reports'),
    SEED_HISTORY: opts.history === false ? '0' : '1',
    // Every simulated phone shares 127.0.0.1; the per-address join limit is
    // covered by the integration suite, not here.
    TRUST_PROXY_HOPS: '0',
    ...opts.env,
  };
  delete env.NODE_ENV;
  delete env.PUBLIC_BASE_URL;

  let child: ChildProcess;
  if (mode === 'dev') {
    child = spawn(process.execPath, ['scripts/dev.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // Build, seed explicitly (npm start never seeds on its own), then start.
    for (const [label, args] of [['build', [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'build']], ['seed', ['scripts/seed.ts']]] as const) {
      const r = spawnSync(process.execPath, [...args], { cwd: ROOT, env, encoding: 'utf8' });
      out.write(`---- ${label}\n${r.stdout}${r.stderr}`);
      if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}); see ${log}`);
    }
    // Like a restaurant LAN install: QR cards carry this computer's LAN address.
    const lan = lanAddresses()[0];
    child = spawn(process.execPath, ['scripts/start.ts'], {
      cwd: ROOT,
      env: { ...env, PUBLIC_BASE_URL: `http://${lan ? lan.address : 'localhost'}:${port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  child.stdout!.pipe(out, { end: false });
  child.stderr!.pipe(out, { end: false });
  const base = `http://localhost:${port}`;
  try {
    await waitFor(`${base}/api/health`, child, 240_000);
    await waitFor(`${base}/menu`, child, 30_000);
  } catch (err) {
    killTree(child);
    throw new Error(`${(err as Error).message} (log: ${log})`);
  }

  return {
    base,
    port,
    dir,
    log,
    stop: async () => {
      if (child.exitCode === null) {
        const gone = new Promise((r) => child.once('exit', r));
        killTree(child);
        await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
      }
      out.end();
      if (!opts.keep) {
        for (let i = 0; i < 10; i++) {
          try { rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
        }
      }
    },
  };
}
