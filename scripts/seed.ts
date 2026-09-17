// `npm run seed`: migrate and seed an EMPTY development database without
// starting the server (server/db/seed.ts does the work; it refuses
// NODE_ENV=production). The synthetic fixture year is included unless
// SEED_HISTORY=0 is set in the shell or in .env.
import { spawn } from 'node:child_process';
import { envValue, ROOT } from './env.ts';

const child = spawn(process.execPath, ['server/db/seed.ts', ...process.argv.slice(2)], {
  cwd: ROOT,
  env: { ...process.env, SEED_DEMO: '1', SEED_HISTORY: envValue('SEED_HISTORY') ?? '1' },
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
