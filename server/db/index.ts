// SQLite access (node:sqlite, synchronous). One process owns the database.
//
//   import { db, tx, one, many, run } from '../db/index.ts';
//   const order = tx(() => { ...reads + writes...; return result; });
//
// `tx` uses BEGIN IMMEDIATE so a write lock is taken up front: everything
// inside runs atomically against a consistent snapshot. Because the driver is
// synchronous and the server is a single Node process, no other request can
// interleave inside a transaction body. Work registered with `afterCommit`
// (event notifications) runs only once the data is durable.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, SQLInputValue>;
export type Params = Record<string, unknown> | unknown[];

let database: DatabaseSync | null = null;
const statements = new Map<string, StatementSync>();

export function openDatabase(path = config.databasePath): DatabaseSync {
  if (database) return database;
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA synchronous = NORMAL');
  d.exec('PRAGMA foreign_keys = ON');
  d.exec('PRAGMA busy_timeout = 5000');
  database = d;
  return d;
}

export function db(): DatabaseSync {
  return database ?? openDatabase();
}

export function closeDatabase(): void {
  statements.clear();
  database?.close();
  database = null;
}

function prepare(sql: string): StatementSync {
  let st = statements.get(sql);
  if (!st) {
    st = db().prepare(sql);
    statements.set(sql, st);
  }
  return st;
}

function normalize(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function bind(params?: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(normalize);
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = normalize(v);
  return [out];
}

/** First row or undefined. Named params use `:name` in SQL and `{ name }` here. */
export function one<T = Row>(sql: string, params?: Params): T | undefined {
  return prepare(sql).get(...(bind(params) as SQLInputValue[])) as T | undefined;
}

export function many<T = Row>(sql: string, params?: Params): T[] {
  return prepare(sql).all(...(bind(params) as SQLInputValue[])) as T[];
}

export function run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const r = prepare(sql).run(...(bind(params) as SQLInputValue[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** INSERT a row object into `table`. Column names come from code, never from input. */
export function insert(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, row);
}

/**
 * Optimistic update: `UPDATE table SET ... , version = version + 1 WHERE id = :id AND version = :version`.
 * Returns false when the row changed underneath the caller (stale version).
 */
export function updateVersioned(table: string, id: string, version: number, patch: Record<string, unknown>): boolean {
  const cols = Object.keys(patch);
  const sets = cols.map((c) => `${c} = :p_${c}`);
  const params: Record<string, unknown> = { id, version };
  for (const c of cols) params[`p_${c}`] = patch[c];
  const r = run(`UPDATE ${table} SET ${[...sets, 'version = version + 1'].join(', ')} WHERE id = :id AND version = :version`, params);
  return r.changes === 1;
}

// ------------------------------------------------------------------ transactions
let depth = 0;
let commitQueue: Array<() => void> = [];

export function inTransaction(): boolean {
  return depth > 0;
}

/** Run `fn` after the outermost transaction commits (or immediately if none). */
export function afterCommit(fn: () => void): void {
  if (depth === 0) {
    queueMicrotask(fn);
  } else {
    commitQueue.push(fn);
  }
}

export function tx<T>(fn: () => T): T {
  if (depth > 0) {
    // Nested call: use a savepoint so an inner failure can be contained by the caller.
    const name = `sp_${depth}`;
    db().exec(`SAVEPOINT ${name}`);
    depth++;
    try {
      const result = fn();
      db().exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      db().exec(`ROLLBACK TO ${name}`);
      db().exec(`RELEASE ${name}`);
      throw err;
    } finally {
      depth--;
    }
  }
  db().exec('BEGIN IMMEDIATE');
  depth = 1;
  const queued: Array<() => void> = [];
  commitQueue = queued;
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('tx() bodies must be synchronous');
    db().exec('COMMIT');
    depth = 0;
    commitQueue = [];
    for (const job of queued) {
      try { job(); } catch (err) { console.error('[afterCommit]', err); }
    }
    return result;
  } catch (err) {
    depth = 0;
    commitQueue = [];
    try { db().exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** True when a thrown error is a SQLite UNIQUE / constraint violation. */
export function isConstraintError(err: unknown, needle?: string): boolean {
  const e = err as { code?: string; errcode?: number; message?: string };
  const constraint = e?.code === 'ERR_SQLITE_ERROR' && (e.errcode === 2067 || e.errcode === 1555 || e.errcode === 19 || e.errcode === 275 || e.errcode === 531 || /constraint/i.test(e.message ?? ''));
  if (!constraint) return false;
  return needle ? (e.message ?? '').includes(needle) : true;
}

// ------------------------------------------------------------------ migrations
export function migrate(): string[] {
  const d = db();
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(many<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
  const dir = join(here, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    d.exec('BEGIN IMMEDIATE');
    try {
      d.exec(sql);
      run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
      d.exec('COMMIT');
      applied.push(file);
    } catch (err) {
      d.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  statements.clear();
  return applied;
}

// ------------------------------------------------------------------ JSON helpers
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
