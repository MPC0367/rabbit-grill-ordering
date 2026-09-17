// Guest feedback: what a phone may still send after checkout, and the
// read-only list the Reports panel shows (brief 15, 26; D-S8-22).
//
// Feedback is one entry per guest session, private to the restaurant: it is
// never pushed on the live stream, never published, and comments are removed
// by the retention task (ratings stay). Writing it lives in service.ts; this
// module answers "may I still send it?" and "what came in this range?".
import type { FeedbackEligibilityDTO, FeedbackItemDTO, FeedbackListDTO } from '../../shared/dto.ts';
import { daysBetween, nowIso } from '../../shared/time.ts';
import { many, one } from '../db/index.ts';
import { FEEDBACK_GRACE_MS, type GuestContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { MAX_CUSTOM_DAYS, assertDate, fixtureSql } from './aggregates.ts';
import { getVisit, type VisitRow } from './guards.ts';

/** At most this many entries are listed; the counts always cover the whole range. */
export const FEEDBACK_LIST_LIMIT = 500;

/** When the post-checkout window closes, or null while the visit is still open. */
export function feedbackDeadline(visit: Pick<VisitRow, 'status' | 'closed_at'>): string | null {
  if (visit.status !== 'closed' || !visit.closed_at) return null;
  return new Date(new Date(visit.closed_at).getTime() + FEEDBACK_GRACE_MS).toISOString();
}

/** True while POST /api/guest/feedback would still accept this visit's session. */
export function feedbackWindowOpen(visit: Pick<VisitRow, 'status' | 'closed_at'>, nowMs = Date.now()): boolean {
  if (visit.status !== 'closed') return true;
  const until = feedbackDeadline(visit);
  return until !== null && nowMs <= new Date(until).getTime();
}

export function alreadySubmitted(guestSessionId: string): boolean {
  return one('SELECT 1 AS x FROM feedback WHERE guest_session_id = ?', [guestSessionId]) !== undefined;
}

/**
 * GET /api/guest/feedback/eligibility. The ended page asks this before it
 * offers the form, so it never shows a form the API would refuse.
 */
export function feedbackEligibility(guest: GuestContext): FeedbackEligibilityDTO {
  const visit = getVisit(guest.visitId);
  if (!visit) throw new AppError('not_found', 'Visit not found');
  const submitted = alreadySubmitted(guest.guestId);
  return {
    eligible: !submitted && feedbackWindowOpen(visit),
    submitted,
    until: feedbackDeadline(visit),
  };
}

// ------------------------------------------------------------------ staff list
export interface FeedbackQuery {
  from: string;
  to: string;
  include_fixture?: boolean;
}

interface FeedbackListRow {
  id: string; created_at: string; business_date: string; rating: number | null; comment: string | null;
  table_label: string | null;
}

/**
 * Guest ratings and comments for a range of business dates, newest first.
 * Demo data is excluded unless asked for. The counts cover the whole range
 * even when the item list is capped.
 */
export function listFeedback(q: FeedbackQuery): FeedbackListDTO {
  const from = assertDate(q.from, 'from');
  const to = assertDate(q.to, 'to');
  if (from > to) throw new AppError('validation_failed', 'from must not be after to', { fields: ['from', 'to'] });
  const days = daysBetween(from, to) + 1;
  if (days > MAX_CUSTOM_DAYS) {
    throw new AppError('validation_failed', `A range can cover at most ${MAX_CUSTOM_DAYS} days`, { max_days: MAX_CUSTOM_DAYS });
  }
  const include = q.include_fixture === true;
  const range = { from, to };
  const where = `f.business_date BETWEEN :from AND :to AND ${fixtureSql('f', include)}`;

  const totals = one<{ count: number; rated: number; sum: number | null; with_comment: number }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(f.rating IS NOT NULL), 0) AS rated,
            SUM(f.rating) AS sum,
            COALESCE(SUM(f.comment IS NOT NULL), 0) AS with_comment
       FROM feedback f WHERE ${where}`, range)!;
  const byRating = new Map(many<{ rating: number; n: number }>(
    `SELECT f.rating, COUNT(*) AS n FROM feedback f WHERE ${where} AND f.rating IS NOT NULL GROUP BY f.rating`, range)
    .map((r) => [r.rating, r.n]));
  const rows = many<FeedbackListRow>(
    `SELECT f.id, f.created_at, f.business_date, f.rating, f.comment, t.label AS table_label
       FROM feedback f
       JOIN visits v ON v.id = f.visit_id
       LEFT JOIN dining_tables t ON t.id = v.table_id
      WHERE ${where}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT :limit`, { ...range, limit: FEEDBACK_LIST_LIMIT + 1 });
  const truncated = rows.length > FEEDBACK_LIST_LIMIT;

  const items: FeedbackItemDTO[] = rows.slice(0, FEEDBACK_LIST_LIMIT).map((r) => ({
    id: r.id,
    submitted_at: r.created_at,
    business_date: r.business_date,
    table_label: r.table_label,
    rating: r.rating,
    comment: r.comment,
  }));
  return {
    from,
    to,
    include_fixture: include,
    count: totals.count,
    rated: totals.rated,
    average_rating: totals.rated > 0 ? Math.round(((totals.sum ?? 0) / totals.rated) * 100) / 100 : null,
    distribution: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: byRating.get(rating) ?? 0 })),
    with_comment: totals.with_comment,
    items,
    ...(truncated ? { truncated: true } : {}),
    generated_at: nowIso(),
  };
}
