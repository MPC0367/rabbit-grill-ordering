// Data retention (brief 25, 29, 40; D-S8-02).
//
// Settings > Data retention promises that private or detailed records are
// removed after a configurable time. This task keeps that promise:
//
//   guest notes      order-line, service-request and weighing notes past
//                    notes_days lose their text (note_removed_at remembers
//                    that a note existed; the allergy flag stays)
//   feedback         comments past feedback_days are removed; ratings stay
//   raw events       analytics_events past raw_events_days are deleted, but
//                    only for dates the daily item aggregates already cover
//   audit log        entries past audit_days are deleted
//   housekeeping     the event outbox (older than 7 days, keeping the newest
//                    1,000) and staff sessions that ended 30+ days ago
//
// Orders, visits, bills and payments are never touched, so annual totals do
// not change. Horizons are Bangkok business dates. Every step works in small
// transactions and yields between them, so a large first run never stalls
// service. The run is idempotent and leaves one system audit entry.
import { addDays, businessDate, businessRangeUtc, nowIso } from '../../shared/time.ts';
import { inTransaction, many, one, run, tx } from '../db/index.ts';
import { audit, SYSTEM } from '../lib/audit.ts';
import { cutoffHour, getSettings } from '../lib/settings.ts';
import { refreshAggregates } from './aggregates.ts';

export const RETENTION_STATE = 'retention';
const BATCH = 2_000;
const OUTBOX_KEEP_DAYS = 7;
const OUTBOX_KEEP_ROWS = 1_000;
const SESSION_KEEP_DAYS = 30;

export interface RetentionResult {
  dry_run: boolean;
  ran_at: string;
  horizons: { notes_before: string; feedback_before: string; raw_events_before: string; audit_before: string };
  order_line_notes: number;
  service_request_notes: number;
  portion_request_notes: number;
  portion_quote_notes: number;
  feedback_comments: number;
  raw_events: number;
  /** Raw events dated up to here are gone (their daily item aggregates are kept). */
  raw_events_purged_through: string | null;
  audit_entries: number;
  outbox_events: number;
  staff_sessions: number;
}

export interface RetentionStatus {
  last_run_at: string | null;
  raw_events_purged_through: string | null;
}

export function retentionStatus(): RetentionStatus {
  const r = one<{ built_at: string; built_through: string | null }>('SELECT built_at, built_through FROM agg_state WHERE name = ?', [RETENTION_STATE]);
  return { last_run_at: r?.built_at ?? null, raw_events_purged_through: r?.built_through ?? null };
}

const yieldToService = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Repeat `step` (one small transaction that changes at most BATCH rows) until
 * it changes nothing. In a dry run, `count` answers instead.
 */
async function drain(step: () => number, count: () => number, dryRun: boolean): Promise<number> {
  if (dryRun) return count();
  let total = 0;
  for (;;) {
    const n = tx(step);
    total += n;
    if (n < BATCH) return total;
    await yieldToService();
  }
}

const n = (sql: string, params: Record<string, unknown>) => one<{ n: number }>(sql, params)?.n ?? 0;

export async function runRetention(opts: { now?: number; dryRun?: boolean } = {}): Promise<RetentionResult> {
  if (inTransaction()) throw new Error('runRetention() must not run inside a transaction');
  const dryRun = opts.dryRun === true;
  const nowMs = opts.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const cutoff = cutoffHour();
  const today = businessDate(nowMs, cutoff);
  const r = getSettings().retention;
  // A record dated before the horizon is past its retention period.
  const notesBefore = addDays(today, -r.notes_days);
  const feedbackBefore = addDays(today, -r.feedback_days);
  const rawBefore = addDays(today, -r.raw_events_days);
  const auditBefore = addDays(today, -r.audit_days);
  const auditBeforeUtc = businessRangeUtc(auditBefore, auditBefore, cutoff).start;
  const p = { now, batch: BATCH };

  const orderLineNotes = await drain(
    () => run(
      `UPDATE order_lines SET note = NULL, note_removed_at = :now
        WHERE rowid IN (SELECT l.rowid FROM order_lines l JOIN orders o ON o.id = l.order_id
                         WHERE o.business_date < :before AND l.note IS NOT NULL LIMIT :batch)`, { ...p, before: notesBefore }).changes,
    () => n(`SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
              WHERE o.business_date < :before AND l.note IS NOT NULL`, { before: notesBefore }),
    dryRun);
  const serviceNotes = await drain(
    () => run(
      `UPDATE service_requests SET note = NULL, note_removed_at = :now
        WHERE rowid IN (SELECT rowid FROM service_requests WHERE business_date < :before AND note IS NOT NULL LIMIT :batch)`,
      { ...p, before: notesBefore }).changes,
    () => n('SELECT COUNT(*) AS n FROM service_requests WHERE business_date < :before AND note IS NOT NULL', { before: notesBefore }),
    dryRun);
  const portionNotes = await drain(
    () => run(
      `UPDATE portion_requests SET note = NULL, note_removed_at = :now
        WHERE rowid IN (SELECT rowid FROM portion_requests WHERE business_date < :before AND note IS NOT NULL LIMIT :batch)`,
      { ...p, before: notesBefore }).changes,
    () => n('SELECT COUNT(*) AS n FROM portion_requests WHERE business_date < :before AND note IS NOT NULL', { before: notesBefore }),
    dryRun);
  const quoteNotes = await drain(
    () => run(
      `UPDATE portion_quotes SET note = NULL, note_removed_at = :now
        WHERE rowid IN (SELECT q.rowid FROM portion_quotes q JOIN portion_requests pr ON pr.id = q.request_id
                         WHERE pr.business_date < :before AND q.note IS NOT NULL LIMIT :batch)`, { ...p, before: notesBefore }).changes,
    () => n(`SELECT COUNT(*) AS n FROM portion_quotes q JOIN portion_requests pr ON pr.id = q.request_id
              WHERE pr.business_date < :before AND q.note IS NOT NULL`, { before: notesBefore }),
    dryRun);

  const feedbackComments = await drain(
    () => run(
      `UPDATE feedback SET comment = NULL, comment_removed_at = :now
        WHERE rowid IN (SELECT rowid FROM feedback WHERE business_date < :before AND comment IS NOT NULL LIMIT :batch)`,
      { ...p, before: feedbackBefore }).changes,
    () => n('SELECT COUNT(*) AS n FROM feedback WHERE business_date < :before AND comment IS NOT NULL', { before: feedbackBefore }),
    dryRun);

  // Raw events go one business date at a time, and only once that date's daily
  // item aggregates exist (built here if missing), so no count is lost.
  const previous = retentionStatus().raw_events_purged_through;
  let rawEvents = 0;
  for (const { d } of many<{ d: string }>(
    'SELECT DISTINCT business_date AS d FROM analytics_events WHERE business_date < :before ORDER BY d', { before: rawBefore })) {
    if (dryRun) {
      rawEvents += n('SELECT COUNT(*) AS n FROM analytics_events WHERE business_date = :d', { d });
      continue;
    }
    const itemEvents = one('SELECT 1 AS x FROM analytics_events WHERE business_date = :d AND item_id IS NOT NULL LIMIT 1', { d });
    const aggregated = one('SELECT 1 AS x FROM agg_item_daily WHERE business_date = :d LIMIT 1', { d });
    if (itemEvents && !aggregated) refreshAggregates(d, d);
    rawEvents += await drain(
      () => run(`DELETE FROM analytics_events WHERE rowid IN (SELECT rowid FROM analytics_events WHERE business_date = :d LIMIT :batch)`, { d, batch: BATCH }).changes,
      () => 0,
      false);
  }
  const horizonEnd = addDays(rawBefore, -1);
  const purgedThrough = previous !== null && previous > horizonEnd ? previous : horizonEnd;

  const auditEntries = await drain(
    () => run(
      `DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at < :before ORDER BY id LIMIT :batch)`,
      { before: auditBeforeUtc, batch: BATCH }).changes,
    () => n('SELECT COUNT(*) AS n FROM audit_events WHERE created_at < :before', { before: auditBeforeUtc }),
    dryRun);

  // The outbox only feeds live streams; clients refetch on (re)connect.
  const outboxBefore = new Date(nowMs - OUTBOX_KEEP_DAYS * 86_400_000).toISOString();
  const keepFrom = one<{ id: number | null }>('SELECT MIN(id) AS id FROM (SELECT id FROM events ORDER BY id DESC LIMIT :keep)', { keep: OUTBOX_KEEP_ROWS })?.id ?? 0;
  const outboxEvents = await drain(
    () => run(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < :before AND id < :keep ORDER BY id LIMIT :batch)`,
      { before: outboxBefore, keep: keepFrom, batch: BATCH }).changes,
    () => n('SELECT COUNT(*) AS n FROM events WHERE created_at < :before AND id < :keep', { before: outboxBefore, keep: keepFrom }),
    dryRun);

  const sessionsBefore = new Date(nowMs - SESSION_KEEP_DAYS * 86_400_000).toISOString();
  const staffSessions = await drain(
    () => run(
      `DELETE FROM staff_sessions WHERE rowid IN (SELECT rowid FROM staff_sessions
         WHERE expires_at < :before OR (revoked_at IS NOT NULL AND revoked_at < :before) LIMIT :batch)`,
      { before: sessionsBefore, batch: BATCH }).changes,
    () => n('SELECT COUNT(*) AS n FROM staff_sessions WHERE expires_at < :before OR (revoked_at IS NOT NULL AND revoked_at < :before)', { before: sessionsBefore }),
    dryRun);

  const result: RetentionResult = {
    dry_run: dryRun,
    ran_at: now,
    horizons: { notes_before: notesBefore, feedback_before: feedbackBefore, raw_events_before: rawBefore, audit_before: auditBefore },
    order_line_notes: orderLineNotes,
    service_request_notes: serviceNotes,
    portion_request_notes: portionNotes,
    portion_quote_notes: quoteNotes,
    feedback_comments: feedbackComments,
    raw_events: rawEvents,
    raw_events_purged_through: dryRun ? previous : purgedThrough,
    audit_entries: auditEntries,
    outbox_events: outboxEvents,
    staff_sessions: staffSessions,
  };
  if (!dryRun) {
    tx(() => {
      run(
        `INSERT INTO agg_state (name, built_through, built_at, data_version) VALUES (:name, :through, :at, 1)
         ON CONFLICT(name) DO UPDATE SET built_through = :through, built_at = :at, data_version = data_version + 1`,
        { name: RETENTION_STATE, through: purgedThrough, at: nowIso() },
      );
      const { dry_run: _d, ran_at: _r, ...counts } = result;
      audit(SYSTEM, 'retention.run', { type: 'retention', id: today }, { after: counts });
    });
  }
  return result;
}

/** The retention task runs once per business day (the runner asks often; this says whether it is due). */
export function retentionDue(nowMs = Date.now()): boolean {
  const last = retentionStatus().last_run_at;
  if (!last) return true;
  const cutoff = cutoffHour();
  return businessDate(last, cutoff) < businessDate(nowMs, cutoff);
}
