// Facts about the database file itself (app_meta): its identity and the state
// of the development seed. Nothing here is restaurant data.
import { one, run } from '../db/index.ts';
import { nowIso } from '../../shared/time.ts';

export const DB_EPOCH = 'db_epoch';
export const SEED_STATE = 'seed_state';

export function getMeta(key: string): string | null {
  return one<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', [key])?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  run(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, at: nowIso() },
  );
}

export function metaUpdatedAt(key: string): string | null {
  return one<{ updated_at: string }>('SELECT updated_at FROM app_meta WHERE key = ?', [key])?.updated_at ?? null;
}

let epoch: string | null = null;

/**
 * This database's identity (a random value written when it was created). A
 * live client that sees a different epoch knows the event history it holds is
 * void - the database was reset or restored - and starts from the server's
 * cursor instead of keeping its own (D-K-01). Read once per process: the file
 * cannot be swapped under a running server.
 */
export function dbEpoch(): string | null {
  epoch ??= getMeta(DB_EPOCH);
  return epoch;
}

/** Forget the cached epoch (tests and CLI tools that reopen a database). */
export function resetEpochCache(): void {
  epoch = null;
}

export type SeedState = 'running' | 'complete';

export function seedState(): { state: SeedState | null; at: string | null } {
  const value = getMeta(SEED_STATE);
  return { state: value === 'running' || value === 'complete' ? value : null, at: metaUpdatedAt(SEED_STATE) };
}

export function setSeedState(state: SeedState): void {
  setMeta(SEED_STATE, state);
}
