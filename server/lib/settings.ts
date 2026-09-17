// Settings store: JSON values per top-level key, merged over DEFAULT_SETTINGS.
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings.ts';
import { inTransaction, many, one, run } from '../db/index.ts';
import { nowIso } from '../../shared/time.ts';

let cache: Settings | null = null;
/**
 * A setting was written inside a transaction that may still roll back: until
 * that transaction ends, reads go to the database and are never cached, so a
 * rolled-back value can never linger in the cache.
 */
let writtenInTx = false;

export function getSettings(): Settings {
  if (writtenInTx) {
    if (inTransaction()) return load();
    // The writing transaction has ended (committed or rolled back).
    writtenInTx = false;
    cache = null;
  }
  return (cache ??= load());
}

function load(): Settings {
  const rows = many<{ key: string; value: string }>('SELECT key, value FROM settings');
  const merged = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (!(r.key in merged)) continue;
    try {
      const v = JSON.parse(r.value);
      const base = merged[r.key];
      merged[r.key] = base && typeof base === 'object' && !Array.isArray(base) && v && typeof v === 'object' && !Array.isArray(v)
        ? { ...(base as object), ...(v as object) }
        : v;
    } catch { /* ignore corrupt value, keep default */ }
  }
  return merged as unknown as Settings;
}

/** Persist one top-level key. Call inside a transaction and audit the change. */
export function putSetting<K extends keyof Settings>(key: K, value: Settings[K], by: string | null): void {
  run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (:key, :value, :by, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    { key, value: JSON.stringify(value), by, at: nowIso() },
  );
  cache = null;
  if (inTransaction()) writtenInTx = true;
}

export function settingUpdatedAt(key: keyof Settings): string | null {
  return one<{ updated_at: string }>('SELECT updated_at FROM settings WHERE key = ?', [key])?.updated_at ?? null;
}

export function invalidateSettings(): void {
  cache = null;
}

export function isDemo(): boolean {
  return getSettings().operating_mode === 'demo';
}

/** New records are fixtures while the restaurant runs in demo mode. */
export function fixtureFlag(): 0 | 1 {
  return isDemo() ? 1 : 0;
}

export function cutoffHour(): number {
  return getSettings().business_day_cutoff_hour;
}
