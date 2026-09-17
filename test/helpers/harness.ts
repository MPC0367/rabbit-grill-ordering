// Integration-test harness: a real server process on a free port with its own
// throwaway database, plus cookie-aware HTTP clients.
//
//   const srv = await startServer();                 // live mode, PIN required
//   const floor = await srv.staff('floor');
//   const visit = await srv.openVisit('tbl_T01');    // { id, join_pin, ... }
//   const guest = await srv.guest('tbl_T01', visit.join_pin);
//   const res = await guest.post('/api/guest/orders', {...});
//   srv.sql('SELECT count(*) n FROM orders');        // direct read for assertions
//   await srv.stop();
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Role } from '../../shared/permissions.ts';
import { PASSWORD, T } from './fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  cookies = new Map<string, string>();
  readonly base: string;
  // No parameter properties: Node's type stripping cannot erase them.
  constructor(base: string) {
    this.base = base;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-RG-Client': '1' } : {}),
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(sc) || /expires=Thu, 01 Jan 1970/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(path: string) { return this.request<T>('GET', path); }
  post<T = any>(path: string, body: unknown = {}) { return this.request<T>('POST', path, body); }
  patch<T = any>(path: string, body: unknown = {}) { return this.request<T>('PATCH', path, body); }

  /** Same cookies, independent object (a second tab on the same device). */
  clone(): Client {
    const c = new Client(this.base);
    c.cookies = new Map(this.cookies);
    return c;
  }
}

export interface TestServer {
  url: string;
  dbPath: string;
  client(): Client;
  staff(role: Role): Promise<Client>;
  openVisit(tableId: string, covers?: number | null): Promise<any>;
  guest(tableId: string, pin: string | null): Promise<Client>;
  sql<T = any>(query: string, params?: unknown[]): T[];
  stop(): Promise<void>;
  logs(): string;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

let keyCounter = 0;
export function key(prefix = 'k'): string {
  keyCounter++;
  return `${prefix}_${process.pid}_${Date.now().toString(36)}_${keyCounter.toString().padStart(4, '0')}`;
}

export async function startServer(opts: { mode?: 'live' | 'demo'; pinRequired?: boolean; env?: Record<string, string> } = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'rg-test-'));
  const dbPath = join(dir, 'test.db');
  // Build the database in a child process so this test process never holds it open.
  await new Promise<void>((res, rej) => {
    const p = spawn(process.execPath, [join(ROOT, 'test/helpers/prepare-db.ts'), dbPath, opts.mode ?? 'live', String(opts.pinRequired ?? true)], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`prepare-db exited ${code}`))));
  });
  const port = await freePort();
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['server/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RG_LISTEN_PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: dbPath,
      REPORTS_DIR: join(dir, 'reports'),
      SEED_DEMO: '0',
      SEED_HISTORY: '0',
      SERVE_CLIENT: '0',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      NODE_ENV: 'test',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    if (Date.now() - started > 20_000) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  let reader: DatabaseSync | null = null;
  const srv: TestServer = {
    url,
    dbPath,
    client: () => new Client(url),
    async staff(role) {
      const c = new Client(url);
      const r = await c.post('/api/staff/auth/login', { username: role, password: PASSWORD(role) });
      if (r.status !== 200) throw new Error(`login ${role} failed: ${r.status} ${JSON.stringify(r.body)}`);
      return c;
    },
    async openVisit(tableId, covers = 2) {
      const floor = await srv.staff('floor');
      const r = await floor.post(`/api/staff/tables/${tableId}/visits`, { covers, idempotency_key: key('open') });
      if (r.status >= 300) throw new Error(`open visit failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async guest(tableId, pin) {
      const c = new Client(url);
      const r = await c.post('/api/public/qr/join', { token: T.tokens[tableId], ...(pin ? { pin } : {}) });
      // 201 = new membership, 200 = this browser had already joined (S2, D-18).
      if (r.status !== 200 && r.status !== 201) throw new Error(`join failed: ${r.status} ${JSON.stringify(r.body)}`);
      return c;
    },
    sql(query, params = []) {
      reader ??= new DatabaseSync(dbPath, { readOnly: true });
      return reader.prepare(query).all(...(params as never[])) as never[];
    },
    async stop() {
      reader?.close();
      reader = null;
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
    },
    logs: () => output,
  };
  return srv;
}
