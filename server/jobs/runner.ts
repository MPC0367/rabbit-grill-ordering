// In-process background jobs. One Node process owns the database, so a few
// timers are enough; every task is idempotent and safe to run late.
//
//   report jobs      poll every 2 s, one job at a time, never overlapping
//   quote expiry     every 60 s   (S4 expireQuotes)
//   aggregates       every 5 min  (S6 refreshAggregates, last 3 business days)
//   year rollover    at start and every 10 min: completed years with data get
//                    a final annual report + data export (nothing is reset)
//
// On start, report jobs left "generating" by a stopped process are queued
// again. Timers are unref()'d so they never keep the process alive, and each
// task catches its own errors so one failure cannot stop the others.
import { addDays, nowIso, todayBusinessDate } from '../../shared/time.ts';
import { cutoffHour } from '../lib/settings.ts';
import { ensureFinalReports, requeueInterrupted, runNextReportJob } from '../domain/reports.ts';

const REPORT_POLL_MS = 2_000;
const QUOTE_EXPIRY_MS = 60_000;
const AGGREGATES_MS = 5 * 60_000;
const ROLLOVER_MS = 10 * 60_000;

let timers: NodeJS.Timeout[] = [];
let started = false;
let stopping = false;
let reportBusy = false;
let aggregatesBusy = false;

function log(task: string, message: string): void {
  console.log(`[jobs] ${task}: ${message}`);
}

function safely(task: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[jobs] ${task} failed:`, (err as Error)?.message ?? err);
  }
}

/** Run queued report jobs one after another until the queue is empty or a job does not finish. */
async function pumpReports(): Promise<void> {
  if (reportBusy || stopping) return;
  reportBusy = true;
  try {
    while (!stopping) {
      const result = await runNextReportJob();
      if (!result) break;
      log('report', `${result.id} ${result.status} in ${result.ms} ms${result.error ? ` (${result.error})` : ''}`);
      // A failed attempt is retried on a later poll, not in a tight loop.
      if (result.status !== 'ready') break;
    }
  } catch (err) {
    console.error('[jobs] report runner failed:', (err as Error)?.message ?? err);
  } finally {
    reportBusy = false;
  }
}

async function expireQuotesTask(): Promise<void> {
  try {
    const { expireQuotes } = await import('../domain/portions.ts');
    // expireQuotes opens its own transaction.
    const n = expireQuotes(nowIso());
    if (n) log('quotes', `${n} portion quote(s) expired`);
  } catch (err) {
    console.error('[jobs] quote expiry failed:', (err as Error)?.message ?? err);
  }
}

async function refreshAggregatesTask(): Promise<void> {
  if (aggregatesBusy || stopping) return;
  aggregatesBusy = true;
  try {
    const { refreshAggregates } = await import('../domain/aggregates.ts');
    const today = todayBusinessDate(cutoffHour());
    // Not inside a transaction: the aggregate rebuild manages its own writes.
    await refreshAggregates(addDays(today, -2), today);
  } catch (err) {
    console.error('[jobs] aggregate refresh failed:', (err as Error)?.message ?? err);
  } finally {
    aggregatesBusy = false;
  }
}

function rollover(): void {
  safely('rollover', () => {
    const queued = ensureFinalReports();
    if (queued.length) {
      log('rollover', `queued ${queued.length} year-end report job(s)`);
      nudgeJobs();
    }
  });
}

function every(ms: number, fn: () => unknown): void {
  const t = setInterval(() => { void fn(); }, ms);
  t.unref();
  timers.push(t);
}

function soon(ms: number, fn: () => unknown): void {
  const t = setTimeout(() => { void fn(); }, ms);
  t.unref();
  timers.push(t);
}

export function startJobs(): void {
  if (started) return;
  started = true;
  stopping = false;
  safely('requeue', () => {
    const n = requeueInterrupted();
    if (n) log('report', `${n} interrupted job(s) put back in the queue`);
  });
  rollover();
  every(REPORT_POLL_MS, pumpReports);
  every(QUOTE_EXPIRY_MS, expireQuotesTask);
  every(AGGREGATES_MS, refreshAggregatesTask);
  every(ROLLOVER_MS, rollover);
  soon(1_000, pumpReports);
  soon(3_000, preloadRenderer);
  soon(5_000, expireQuotesTask);
  soon(15_000, refreshAggregatesTask);
}

async function preloadRenderer(): Promise<void> {
  try {
    const { preloadPdfRenderer } = await import('../domain/pdf/render.ts');
    await preloadPdfRenderer();
  } catch (err) {
    // Not fatal: a missing driver is reported by the report job itself.
    console.error('[jobs] PDF renderer preload failed:', (err as Error)?.message ?? err);
  }
}

export function stopJobs(): void {
  stopping = true;
  started = false;
  for (const t of timers) clearTimeout(t);
  timers = [];
}

/** Ask the runner to look at the report queue now (after a job is queued). */
export function nudgeJobs(): void {
  if (!started || stopping) return;
  setImmediate(() => { void pumpReports(); });
}
