// `npm start`: the production entry (run `npm run build` first). One process
// serves the built app and the API on HOST:PORT.
//
// Unlike a bare `node server/main.ts`, it never seeds development fixtures
// unless SEED_DEMO=1 is set explicitly (in the shell or in .env): the demo
// staff accounts have published passwords. The server itself warns about a
// localhost QR address and Secure cookies over http. See docs/OPERATIONS.md.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { envValue, isOn, readDotEnv, ROOT } from './env.ts';

const dotenv = readDotEnv();
const warn = (line: string) => console.warn(`[start] warning: ${line}`);

for (const name of ['SEED_DEMO', 'SEED_HISTORY']) {
  if (envValue(name, dotenv) === undefined) process.env[name] = '0';
}

const production = (envValue('NODE_ENV', dotenv) ?? '') === 'production';
if (!production) {
  warn('NODE_ENV is not "production". Set it for a real restaurant install: it also refuses demo seeding.');
  if (isOn(envValue('SEED_DEMO', dotenv))) {
    warn('SEED_DEMO=1: an empty database gets the demo staff accounts (demo-<role> / rabbit-<role>-demo). Deactivate them before service.');
  }
}
if (envValue('SERVE_CLIENT', dotenv) !== '0' && !existsSync(resolve(ROOT, 'dist', 'index.html'))) {
  warn('dist/index.html is missing: run "npm run build" first, or the guest and staff pages will not load.');
}

await import('../server/main.ts');
