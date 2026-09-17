// Delete the local development database (and WAL files) so the next start
// re-migrates and re-seeds. Refuses in production.
import { existsSync, rmSync } from 'node:fs';
import { config } from '../server/config.ts';

if (config.production) {
  console.error('db:reset refuses to run with NODE_ENV=production.');
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) {
  const f = config.databasePath + suffix;
  if (existsSync(f)) {
    rmSync(f);
    console.log('removed', f);
  }
}
console.log('Database reset. Start the server to migrate and seed again.');
