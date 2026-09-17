// Consistent, non-blocking reads for report generation.
//
// The live service writes through the process-wide connection (db()). A report
// opens its OWN read-only connection and starts one read transaction on it. In
// WAL mode that transaction sees a stable snapshot of the database for as long
// as it stays open, while orders keep committing on the main connection. So
// every figure, chart and appendix row in one report reconciles, and the report
// never holds a write lock.
//
// node:sqlite is synchronous, so a long statement would freeze the event loop
// (and with it ordering). Callers therefore read in small pieces - one business
// day, one month - and call `tick()` between pieces, which yields to the event
// loop whenever the current slice has run for more than a few milliseconds.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { db } from '../../db/index.ts';

export type Params = Record<string, unknown>;

export interface SnapshotReader {
  /** true when reads run inside a dedicated snapshot transaction. */
  readonly isolated: boolean;
  /** When the snapshot was taken (the report's data cutoff). */
  readonly openedAt: string;
  all<T>(sql: string, params?: Params): T[];
  get<T>(sql: string, params?: Params): T | undefined;
  /** Yield to the event loop if this slice has used its time budget. */
  tick(): Promise<void>;
  close(): void;
}

const SLICE_MS = 8;

function normalize(params: Params = {}): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v as SQLInputValue;
  }
  return out;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Open a snapshot reader on the live database file. With an in-memory database
 * (tests only) there is no second connection to open, so reads fall back to the
 * main connection without isolation.
 */
export function openSnapshotReader(): SnapshotReader {
  const main = db();
  const location = main.location();
  const conn = location ? new DatabaseSync(location, { readOnly: true }) : main;
  const isolated = conn !== main;
  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string) => {
    let st = cache.get(sql);
    if (!st) {
      st = conn.prepare(sql);
      // Report queries share one parameter object ({ from, to, fx, d, ... }).
      st.setAllowUnknownNamedParameters(true);
      cache.set(sql, st);
    }
    return st;
  };

  if (isolated) {
    conn.exec('PRAGMA busy_timeout = 5000');
    conn.exec('BEGIN');
    // A deferred transaction takes its snapshot at the first read: take it now.
    conn.prepare('SELECT COUNT(*) FROM schema_migrations').get();
  }

  const openedAt = new Date().toISOString();
  let sliceStart = performance.now();
  let closed = false;

  return {
    isolated,
    openedAt,
    all<T>(sql: string, params?: Params): T[] {
      return prepare(sql).all(normalize(params)) as T[];
    },
    get<T>(sql: string, params?: Params): T | undefined {
      return prepare(sql).get(normalize(params)) as T | undefined;
    },
    async tick() {
      if (performance.now() - sliceStart < SLICE_MS) return;
      await yieldNow();
      sliceStart = performance.now();
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      if (!isolated) return;
      try { conn.exec('COMMIT'); } catch { /* read transaction already ended */ }
      conn.close();
    },
  };
}
