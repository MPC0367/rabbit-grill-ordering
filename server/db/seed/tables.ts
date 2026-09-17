// Demo dining tables: "01".."12", each with one active QR token.
// Table names are a proposed setting, not the restaurant's floor plan (brief 02).
import { newSecret } from '../../../shared/ids.ts';
import type { Rng, Writer } from './util.ts';

export interface SeedTable {
  id: string;
  label: string;
  sort: number;
}

export const TABLE_COUNT = 12;

export function seedTables(w: Writer, r: Rng, now: string): SeedTable[] {
  const tables: SeedTable[] = [];
  for (let n = 1; n <= TABLE_COUNT; n++) {
    const table: SeedTable = { id: r.id('tbl'), label: String(n).padStart(2, '0'), sort: n };
    w.put('dining_tables', {
      id: table.id, label: table.label, zone: null, location_type: 'table', sort: table.sort,
      enabled: 1, ordering_paused: 0, archived_at: null,
      created_at: now, updated_at: now, version: 1,
    });
    // The token is a real secret (Web Crypto), never derived from the fixture PRNG.
    w.put('table_qr_tokens', {
      id: r.id('qrt'), table_id: table.id, token: newSecret(32), active: 1,
      created_at: now, created_by: null,
    });
    tables.push(table);
  }
  return tables;
}
