// Seed toolkit: a deterministic PRNG, fixture ids, Bangkok time helpers and a
// fast row writer. Development fixtures only - nothing here runs in production.
//
// Determinism: every stream of random numbers is derived from a fixed string
// (`rng('history:2025-03-14')`), so a reset reproduces the same business data.
// Secrets (QR tokens, PINs, password salts, guest token hashes of live visits)
// deliberately do NOT come from this PRNG: they use Web Crypto like the real code.
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { db } from '../index.ts';

// ------------------------------------------------------------------ PRNG
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  between(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Pick by weight; zero-weight entries are never chosen. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  /** Approximately normal (Box-Muller). */
  normal(mean: number, sd: number): number;
  /** Skewed toward `min`: min + (max - min) * u^power. */
  skew(min: number, max: number, power: number): number;
  /** Random string over `alphabet`. */
  chars(length: number, alphabet?: string): string;
  /** Fixture id in the same shape as shared/ids.ts newId(): `prefix_XXXXXXXXXXXXXXXX`. */
  id(prefix: string): string;
}

// Same alphabet as shared/ids.ts so fixture ids look like real ones.
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32-bit FNV-1a string hash, used to seed sub-streams. */
function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** sfc32: small, fast, well-distributed; plenty for fixtures. */
export function rng(seed: string): Rng {
  let a = hash32(`a:${seed}`);
  let b = hash32(`b:${seed}`);
  let c = hash32(`c:${seed}`);
  let d = 1;
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next(); // discard warm-up output

  const self: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    between: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items, weight) => {
      let total = 0;
      for (const item of items) total += Math.max(0, weight(item));
      if (total <= 0) return items[Math.floor(next() * items.length)];
      let r = next() * total;
      for (const item of items) {
        r -= Math.max(0, weight(item));
        if (r < 0) return item;
      }
      return items[items.length - 1];
    },
    normal: (mean, sd) => {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    skew: (min, max, power) => min + (max - min) * Math.pow(next(), power),
    chars: (length, alphabet = ID_ALPHABET) => {
      let out = '';
      for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)];
      return out;
    },
    id: (prefix) => `${prefix}_${self.chars(16)}`,
  };
  return self;
}

// ------------------------------------------------------------------ time (Asia/Bangkok, UTC+7 all year)
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
const BANGKOK_MS = 7 * HOUR;

/** UTC epoch ms of a Bangkok wall-clock time: `date` + `minutes` after local midnight. */
export function bangkokMs(date: string, minutes: number): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Date.UTC(y, m - 1, d) + Math.round(minutes * MINUTE) - BANGKOK_MS;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Business date for an instant with the configured cutoff hour. Equivalent to
 * shared/time.ts businessDate(), without the object allocations (it is called
 * a few hundred thousand times while seeding history).
 */
export function makeBusinessDate(cutoffHour: number): (ms: number) => string {
  const shift = BANGKOK_MS - cutoffHour * HOUR;
  return (ms) => new Date(ms + shift).toISOString().slice(0, 10);
}

/** Minutes since local midnight for an instant (Bangkok). */
export function localMinutes(ms: number): number {
  return (((ms + BANGKOK_MS) % DAY) + DAY) % DAY / MINUTE;
}

// ------------------------------------------------------------------ row writer
export type RowValue = SQLInputValue | boolean | undefined;
export type SeedRow = Record<string, RowValue>;

export interface Writer {
  /** INSERT one row. Column names come from code, never from input. */
  put(table: string, row: SeedRow): void;
  /** Rows written per table so far. */
  counts(): Record<string, number>;
}

/**
 * Positional prepared INSERTs cached per (table, column list). Much faster
 * than building named-parameter objects for hundreds of thousands of rows.
 */
export function createWriter(): Writer {
  const statements = new Map<string, StatementSync>();
  const written: Record<string, number> = {};
  return {
    put(table, row) {
      const cols = Object.keys(row);
      const key = `${table}|${cols.join(',')}`;
      let st = statements.get(key);
      if (!st) {
        st = db().prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        statements.set(key, st);
      }
      const values: SQLInputValue[] = new Array(cols.length);
      for (let i = 0; i < cols.length; i++) {
        const v = row[cols[i]];
        values[i] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
      }
      st.run(...values);
      written[table] = (written[table] ?? 0) + 1;
    },
    counts: () => ({ ...written }),
  };
}

/** True when `table` has `column` (lets fixtures follow additive migrations of other streams). */
export function hasColumn(table: string, column: string): boolean {
  return db().prepare(`SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
}

/** Yield to the event loop between large transactions. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
