// Development fixtures: draft catalog, demo tables, demo staff, a synthetic
// fixture history and a "right now" dining room. NEVER runs in production.
//
//   SEED_DEMO=1 node server/main.ts      seeds on first start (empty catalog only)
//   npm run seed                         the same, without starting the server
//   npm run db:reset                     delete the database to seed again
//
// Idempotent: nothing happens when menu_groups already has rows. The catalog,
// tables and staff are one transaction; the history is written one month per
// transaction (yielding in between); the live dining room is the last one.
// If a run is interrupted part-way, reset the database and start again.
import { performance } from 'node:perf_hooks';
import { statSync } from 'node:fs';
import { config } from '../config.ts';
import { closeDatabase, db, migrate, one, openDatabase, tx } from './index.ts';
import { seedState, setSeedState } from '../lib/meta.ts';
import { cutoffHour, getSettings, putSetting } from '../lib/settings.ts';
import { addDays, businessDate, isoWeekday } from '../../shared/time.ts';
import { seedCatalog } from './seed/catalog.ts';
import { seedHistory, type HistoryResult } from './seed/history.ts';
import { seedLive } from './seed/live.ts';
import { INTRODUCED, loadMenuModel } from './seed/menu-model.ts';
import type { SeedCtx } from './seed/records.ts';
import { printStaffNotice, seedStaff } from './seed/staff.ts';
import { seedTables } from './seed/tables.ts';
import { bangkokMs, createWriter, iso, makeBusinessDate, rng } from './seed/util.ts';

/** First day of the synthetic history (Bangkok). */
export const HISTORY_FROM = '2025-01-01';
/** Engagement telemetry "started" here, so 2025 coverage is honestly partial. */
export const INSTRUMENTATION_FROM = '2025-06-01';

const log = (msg: string) => console.log(`[seed] ${msg}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * A seed that started and never finished (the process was killed part-way)
 * leaves a database with a catalog but, say, half a year of history. The
 * marker in app_meta says which: 'running' until the last step commits
 * (D-S8-29). Databases seeded before the marker existed have none and are
 * taken as complete.
 */
export class PartialSeedError extends Error {
  constructor(at: string | null) {
    super(`This database holds an interrupted demo seed${at ? ` (started ${at})` : ''}. Run "npm run db:reset" and seed again.`);
    this.name = 'PartialSeedError';
  }
}

/** Was a seed interrupted? (null when this database was never seeded here.) */
export function partialSeed(): { at: string | null } | null {
  const { state, at } = seedState();
  return state === 'running' ? { at } : null;
}

export async function seedIfEmpty(opts: { history: boolean }): Promise<void> {
  if (config.production) {
    console.warn('[seed] refusing to seed fixtures with NODE_ENV=production.');
    return;
  }
  const interrupted = partialSeed();
  if (interrupted) throw new PartialSeedError(interrupted.at);
  if ((one<{ n: number }>('SELECT COUNT(*) AS n FROM menu_groups')?.n ?? 0) > 0) return;

  // Bulk-load settings for this run only: a large page cache (the random-id
  // indexes otherwise thrash the default 2 MB cache) and no fsync per commit.
  // A crash mid-seed leaves a development database to reset, nothing more.
  const pragma = (name: string) => one<Record<string, number>>(`PRAGMA ${name}`)?.[name];
  const restore = { cache_size: pragma('cache_size') ?? -2000, synchronous: pragma('synchronous') ?? 1 };
  db().exec('PRAGMA cache_size = -131072');
  db().exec('PRAGMA synchronous = OFF');
  try {
    await seedAll(opts);
  } finally {
    db().exec(`PRAGMA cache_size = ${Number(restore.cache_size)}`);
    db().exec(`PRAGMA synchronous = ${Number(restore.synchronous)}`);
  }
}

async function seedAll(opts: { history: boolean }): Promise<void> {
  const started = performance.now();
  const w = createWriter();
  const nowMs = Date.now();
  const now = iso(nowMs);
  const today = businessDate(nowMs, cutoffHour());
  const yesterday = addDays(today, -1);
  const history = opts.history && yesterday >= HISTORY_FROM;
  // The live dining room reaches back under two hours; availability and telemetry must cover it.
  const liveWindowStart = nowMs - 3 * 3_600_000;
  log(`seeding development fixtures${history ? ` with history ${HISTORY_FROM}..${yesterday}` : ''} (DEVELOPMENT ONLY, every record is flagged as a fixture)`);

  // ---- 1. catalog, tables, staff (+ telemetry start marker)
  // The "seeding" marker is written in the same transaction as the catalog, so
  // "the catalog has rows" and "a seed was started here" are never out of step.
  const base = tx(() => {
    setSeedState('running');
    const catalog = seedCatalog(w, rng('catalog'), {
      now,
      availableSince: iso(history ? bangkokMs(HISTORY_FROM, 0) : liveWindowStart),
      introducedLater: history ? Object.keys(INTRODUCED) : [],
    });
    const tables = seedTables(w, rng('tables'), now);
    const staff = seedStaff(w, rng('staff'), now);
    const instrumentationStart = iso(history ? bangkokMs(INSTRUMENTATION_FROM, 0) : Math.min(bangkokMs(today, 0), liveWindowStart));
    putSetting('analytics', { ...getSettings().analytics, instrumentation_started_at: instrumentationStart }, null);
    return { catalog, tables, staff };
  });
  const ctx: SeedCtx = { w, staff: base.staff.staff, bdate: makeBusinessDate(cutoffHour()), refs: new Set() };
  printStaffNotice(base.staff.created);
  const c = base.catalog;
  log(`catalog: ${c.items} items (${c.published} published, ${c.demoOrderable} demo-orderable, ${c.needsReview} need review), ${c.categories} categories, ${c.flags} flags, ${c.missingImages} without photo`);

  const model = loadMenuModel();

  // ---- 2. fixture history
  let hist: HistoryResult | null = null;
  if (history) {
    const t = performance.now();
    hist = await seedHistory({ ctx, model, staff: ctx.staff, tables: base.tables }, { from: HISTORY_FROM, to: yesterday, instrumentationFrom: INSTRUMENTATION_FROM });
    log(`history: ${hist.visits} visits, ${hist.orders} order rounds over ${hist.openDays} open days of ${hist.days} (${hist.turnedAway} parties found no free table), ${hist.diningSessions} dining + ${hist.publicSessions} public analytics sessions in ${secs(performance.now() - t)}`);
  }

  // ---- 3. the dining room right now
  const live = tx(() => seedLive({ ctx, r: rng(`live:${today}`), model, staff: ctx.staff, tables: base.tables, now: nowMs }));
  const pinLines = live.pins.map((p) => `    table ${p.table}  PIN ${p.pin}${p.status === 'billing' ? '  (checking out)' : ''}`);
  console.log([
    '',
    `  ======== DEVELOPMENT ONLY - demo visits open right now${pinLines.length ? ' (fixture PINs)' : ''} ========`,
    ...pinLines,
    `    table ${live.disabledTable}  disabled`,
    pinLines.length
      ? '  Show a table\'s QR from Admin > Tables, scan it, and enter the PIN to join.'
      : '  Show a table\'s QR from Admin > Tables and scan it to join: this restaurant uses no code.',
    '  ===============================================================================',
    '',
  ].join('\n'));
  if (isoWeekday(today) === 2) log('note: today is a Wednesday (listed as closed); the live demo tables are open anyway.');

  // ---- 4. rebuild the insight aggregates (S6), if that module exists yet
  if (hist) {
    const t = performance.now();
    try {
      const mod = (await import(new URL('../domain/aggregates.ts', import.meta.url).href)) as { refreshAggregates?: (from?: string, to?: string) => unknown };
      if (typeof mod.refreshAggregates === 'function') {
        await mod.refreshAggregates(HISTORY_FROM, today);
        log(`aggregates rebuilt in ${secs(performance.now() - t)}`);
      } else {
        log('aggregates: refreshAggregates() not available yet - skipped');
      }
    } catch (err) {
      log(`aggregates: skipped (${(err as Error).message.split('\n')[0]})`);
    }
  }

  // ---- 5. summary
  const counts = w.counts();
  const pick = (t: string) => counts[t] ?? 0;
  log(`done in ${secs(performance.now() - started)}: ` + [
    `${pick('visits')} visits`, `${pick('orders')} orders`, `${pick('order_lines')} lines`, `${pick('line_events')} line events`,
    `${pick('payments')} payments`, `${pick('service_requests')} service requests`, `${pick('portion_requests')} portion requests`,
    `${pick('analytics_sessions')} analytics sessions`, `${pick('analytics_events')} analytics events`, `${pick('audit_events')} audit rows`,
  ].join(', '));
  tx(() => setSeedState('complete'));
  const path = config.databasePath;
  try {
    db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    log(`database ${path}: ${(statSync(path).size / 1_048_576).toFixed(1)} MB`);
  } catch { /* in-memory or locked: size unknown */ }
}

// `npm run seed`: migrate and seed without starting the server.
if (import.meta.main) {
  if (config.production) {
    console.error('npm run seed refuses to run with NODE_ENV=production.');
    process.exit(1);
  }
  openDatabase();
  migrate();
  const interrupted = partialSeed();
  if (interrupted) {
    console.error(`[seed] ${new PartialSeedError(interrupted.at).message}`);
    closeDatabase();
    process.exit(1);
  }
  const before = one<{ n: number }>('SELECT COUNT(*) AS n FROM menu_groups')?.n ?? 0;
  if (before > 0) console.log('[seed] the catalog already has data; nothing to do (npm run db:reset to start over).');
  await seedIfEmpty({ history: config.seedHistory });
  closeDatabase();
}
