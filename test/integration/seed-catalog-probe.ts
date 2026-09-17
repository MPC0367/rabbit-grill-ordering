// Test helper (not a test): seed ONLY the draft catalog into a fresh database
// and print what a reviewer-facing screen would read back.
//   node test/integration/seed-catalog-probe.ts <db path>
//
// The full demo seed writes a synthetic year and takes minutes; the catalog on
// its own takes milliseconds, which is all the fixture claims under test need.
import { closeDatabase, many, migrate, openDatabase, tx } from '../../server/db/index.ts';
import { seedCatalog } from '../../server/db/seed/catalog.ts';
import { createWriter, rng } from '../../server/db/seed/util.ts';

const [dbPath] = process.argv.slice(2);
openDatabase(dbPath);
migrate();
const now = '2026-01-01T00:00:00.000Z';
const result = tx(() => seedCatalog(createWriter(), rng('catalog'), { now, availableSince: now }));
const items = many<{ key: string; aliases_th: string; aliases_en: string; aliases_verified: number }>(
  'SELECT key, aliases_th, aliases_en, aliases_verified FROM menu_items ORDER BY key');
const audits = many<{ action: string; reason: string | null; after_json: string | null }>(
  "SELECT action, reason, after_json FROM audit_events WHERE action = 'menu.aliases_reviewed' ORDER BY id");
closeDatabase();
process.stdout.write(JSON.stringify({ items: result.items, rows: items, audits }));
