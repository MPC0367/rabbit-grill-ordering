// node test/helpers/prepare-db.ts <db path> <live|demo> <pinRequired true|false>
import { closeDatabase, migrate, openDatabase, tx } from '../../server/db/index.ts';
import { seedTestFixtures } from './fixtures.ts';

const [dbPath, mode, pin] = process.argv.slice(2);
openDatabase(dbPath);
migrate();
tx(() => seedTestFixtures({ mode: mode === 'demo' ? 'demo' : 'live', pinRequired: pin !== 'false' }));
closeDatabase();
