// `npm run dev`: API (node --watch) on API_PORT + Vite on PORT with /api proxied.
// One command, one URL for the browser: http://localhost:8344
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const PORT = process.env.PORT ?? '8344';
const API_PORT = process.env.API_PORT ?? '8345';
const root = resolve(import.meta.dirname, '..');

const children: ChildProcess[] = [];

function start(name: string, args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (line: string) => `[${name}] ${line}`;
  child.stdout!.setEncoding('utf8').on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => console.error(tag(l))));
  child.on('exit', (code) => {
    console.log(tag(`exited with ${code}`));
    if (!stopping) shutdown(code ?? 1);
  });
  children.push(child);
}

start('api', ['--watch-path=server', '--watch-path=shared', '--watch-preserve-output', 'server/main.ts'], {
  RG_LISTEN_PORT: API_PORT,
  PORT,
  SERVE_CLIENT: '0',
});
start('web', [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', PORT, '--strictPort'], {
  API_PORT,
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
