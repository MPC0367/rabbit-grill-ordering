// Service requests and feedback (brief 15, 22, 36; D-13, D-16).
//
// A request (call staff, request the bill, ask to change an order, ask about
// allergies ...) is scoped to the dining visit. A visit has at most ONE active
// (sent or acknowledged) request per type: repeated taps return the request
// already waiting instead of paging staff twice. The partial UNIQUE index
// `service_one_active_per_type` is the backstop. Once a request is completed
// or cancelled, a new one of the same type may be sent.
//
//   sent --acknowledge--> acknowledged --complete--> completed
//     \------------------ complete / cancel ------> completed | cancelled
//
// At checkout every still-open request is resolved with an attributable
// reason: only the bill request counts as handled (the bill was dealt with at
// checkout); anything else is cancelled, never silently marked completed.
//
// Feedback is optional, one per guest session, never published anywhere.
import type { ServiceRequestDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import { SERVICE_TRANSITIONS, type ServiceStatus, type ServiceType } from '../../shared/status.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import { insert, isConstraintError, many, one, tx, updateVersioned } from '../db/index.ts';
import { audit, type Actor } from '../lib/audit.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { cutoffHour, fixtureFlag, getSettings } from '../lib/settings.ts';
import { getTable, getVisit, type VisitRow } from './guards.ts';

// ------------------------------------------------------------------ rows and DTOs
export interface ServiceRequestRow {
  id: string; visit_id: string; table_id: string; table_label: string;
  type: ServiceType; note: string | null; status: ServiceStatus;
  idempotency_key: string; guest_session_id: string | null; created_by_staff: string | null;
  created_at: string; business_date: string;
  acknowledged_at: string | null; acknowledged_by: string | null;
  completed_at: string | null; completed_by: string | null;
  cancelled_at: string | null; cancelled_by: string | null;
  close_reason: string | null; is_fixture: number; updated_at: string; version: number;
}

/** Row plus the label of the table the visit is at NOW (a transferred visit moves its requests). */
type ServiceRequestListRow = ServiceRequestRow & { live_label: string | null };

/** Guests see states and reasons; staff names stay on staff screens. */
export type ServiceView = 'guest' | 'staff';

export const ACTIVE_SERVICE_STATUSES: readonly ServiceStatus[] = ['sent', 'acknowledged'];

/** close_reason stored on a bill request resolved by checkout. */
export const BILL_HANDLED_AT_CHECKOUT = 'Bill handled at checkout';
/** Fallback when checkout passes no reason for other open requests. */
export const DEFAULT_CHECKOUT_CLOSE_REASON = 'Closed at checkout';

const NOTE_MAX = 200;

const SELECT_WITH_LABEL = `
  SELECT s.*, CASE WHEN v.status <> 'closed' THEN t.label END AS live_label
    FROM service_requests s
    JOIN visits v ON v.id = s.visit_id
    LEFT JOIN dining_tables t ON t.id = v.table_id`;

export function getServiceRequest(id: string): ServiceRequestRow | undefined {
  return one<ServiceRequestListRow>(`${SELECT_WITH_LABEL} WHERE s.id = ?`, [id]);
}

export function serviceRequestDTO(row: ServiceRequestRow | ServiceRequestListRow, view: ServiceView = 'staff'): ServiceRequestDTO {
  const staff = view === 'staff';
  const live = (row as ServiceRequestListRow).live_label;
  return {
    id: row.id,
    type: row.type,
    note: row.note,
    status: row.status,
    table_label: live ?? row.table_label,
    visit_id: row.visit_id,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: staff ? row.acknowledged_by : null,
    completed_at: row.completed_at,
    close_reason: row.close_reason,
    version: row.version,
    completed_by: staff ? row.completed_by : null,
    cancelled_at: row.cancelled_at,
    cancelled_by: staff ? row.cancelled_by : null,
  };
}

function currentDTO(id: string, view: ServiceView = 'staff'): ServiceRequestDTO {
  const row = getServiceRequest(id);
  if (!row) throw new AppError('not_found', 'Service request not found');
  return serviceRequestDTO(row, view);
}

function findByKey(visitId: string, key: string): ServiceRequestRow | undefined {
  return one<ServiceRequestListRow>(`${SELECT_WITH_LABEL} WHERE s.visit_id = ? AND s.idempotency_key = ?`, [visitId, key]);
}

function activeOfType(visitId: string, type: ServiceType): ServiceRequestRow | undefined {
  return one<ServiceRequestListRow>(
    `${SELECT_WITH_LABEL} WHERE s.visit_id = ? AND s.type = ? AND s.status IN ('sent','acknowledged')`,
    [visitId, type],
  );
}

function emitService(row: { id: string; visit_id: string; type: ServiceType; table_label: string }, status: ServiceStatus, version: number): void {
  // Payload: ids, state and the table only - never the note.
  emit('service.updated', {
    audience: 'all',
    visit_id: row.visit_id,
    entity: { type: 'service_request', id: row.id, version },
    payload: { type: row.type, status, table_label: row.table_label },
  });
}

// ------------------------------------------------------------------ create
export interface CreateServiceRequestArgs {
  visit: Pick<VisitRow, 'id'>;
  type: ServiceType;
  note?: string | null;
  idempotencyKey: string;
  guestSessionId?: string | null;
  staffUserId?: string | null;
  actor: Actor;
}

/**
 * Send a service request for a visit (open or billing). Returns the request
 * and whether it already existed: the same idempotency key returns the same
 * request, and an active request of the same type is returned instead of a
 * duplicate. Rate limited per guest session.
 */
export function createServiceRequest(args: CreateServiceRequestArgs): { request: ServiceRequestDTO; existing: boolean } {
  const view: ServiceView = args.guestSessionId ? 'guest' : 'staff';
  if (args.guestSessionId) hit(`service:${args.guestSessionId}`, LIMITS.service);
  const note = args.note?.trim() ? args.note.trim() : null;
  if (note && [...note].length > NOTE_MAX) {
    throw new AppError('validation_failed', `Notes can be up to ${NOTE_MAX} characters.`, { issues: [{ path: 'note', message: 'Too long', code: 'too_big' }] });
  }

  return tx(() => {
    const replay = findByKey(args.visit.id, args.idempotencyKey);
    if (replay) {
      if (replay.type !== args.type) {
        throw new AppError('idempotency_mismatch', 'This request key was already used for a different request.');
      }
      return { request: serviceRequestDTO(replay, view), existing: true };
    }

    const visit = getVisit(args.visit.id);
    if (!visit) throw new AppError('not_found', 'Visit not found');
    if (visit.status === 'closed') throw new AppError('visit_closed');
    if (!getSettings().services[args.type]) {
      throw new AppError('bad_request', 'This service is not offered by the restaurant right now. Please ask a member of staff.', {
        reason: 'service_disabled', type: args.type,
      });
    }

    const active = activeOfType(visit.id, args.type);
    if (active) return { request: serviceRequestDTO(active, view), existing: true };

    const table = getTable(visit.table_id);
    const now = nowIso();
    const row = {
      id: newId('svc'),
      visit_id: visit.id,
      table_id: visit.table_id,
      table_label: table?.label ?? '?',
      type: args.type,
      note,
      status: 'sent' as const,
      idempotency_key: args.idempotencyKey,
      guest_session_id: args.guestSessionId ?? null,
      created_by_staff: args.staffUserId ?? null,
      created_at: now,
      business_date: businessDate(now, cutoffHour()),
      is_fixture: visit.is_fixture === 1 ? 1 : fixtureFlag(),
      updated_at: now,
      version: 1,
    };
    try {
      // Savepoint: a constraint failure leaves the caller's transaction usable.
      tx(() => insert('service_requests', row));
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      const winner = findByKey(visit.id, args.idempotencyKey) ?? activeOfType(visit.id, args.type);
      if (!winner) throw err;
      return { request: serviceRequestDTO(winner, view), existing: true };
    }

    audit(args.actor, 'service.request', { type: 'service_request', id: row.id, visit_id: visit.id }, {
      after: { type: row.type, status: row.status, has_note: note !== null },
    });
    emitService(row, 'sent', 1);
    return { request: currentDTO(row.id, view), existing: false };
  });
}

// ------------------------------------------------------------------ read
export function listVisitRequests(visitId: string, view: ServiceView = 'staff'): ServiceRequestDTO[] {
  return many<ServiceRequestListRow>(`${SELECT_WITH_LABEL} WHERE s.visit_id = ? ORDER BY s.created_at, s.id`, [visitId])
    .map((r) => serviceRequestDTO(r, view));
}

export function openRequestCount(visitId: string): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM service_requests WHERE visit_id = ? AND status IN ('sent','acknowledged')`, [visitId],
  )?.n ?? 0;
}

/**
 * Staff service queue. `active`: every waiting request, oldest first (the
 * queue is worked by age). `all`: one business date's requests, newest first.
 */
export function listServiceQueue(q: { scope: 'active' | 'all'; date?: string }): ServiceRequestDTO[] {
  if (q.scope === 'active') {
    return many<ServiceRequestListRow>(`${SELECT_WITH_LABEL} WHERE s.status IN ('sent','acknowledged') ORDER BY s.created_at, s.id`)
      .map((r) => serviceRequestDTO(r));
  }
  const date = q.date ?? businessDate(nowIso(), cutoffHour());
  return many<ServiceRequestListRow>(
    `${SELECT_WITH_LABEL} WHERE s.business_date = ? ORDER BY s.created_at DESC, s.id LIMIT 500`, [date],
  ).map((r) => serviceRequestDTO(r));
}

// ------------------------------------------------------------------ staff transitions
export interface ServiceTransitionArgs {
  id: string;
  to: ServiceStatus;
  version: number;
  reason?: string | null;
  /** Staff actor; its label (display name) is recorded as acknowledged/completed/cancelled by. */
  actor: Actor;
}

/**
 * Acknowledge, complete or cancel a request. The caller checks permissions
 * (cancel needs service.cancel). A stale version returns the current request.
 */
export function transitionServiceRequest(args: ServiceTransitionArgs): ServiceRequestDTO {
  return tx(() => {
    const row = getServiceRequest(args.id);
    if (!row) throw new AppError('not_found', 'Service request not found');
    if (row.version !== args.version) staleVersion(serviceRequestDTO(row));
    if (!SERVICE_TRANSITIONS[row.status].includes(args.to)) {
      throw new AppError('invalid_transition', `A ${row.status} request cannot become ${args.to}.`, { current: serviceRequestDTO(row) });
    }
    const reason = args.reason?.trim() ? args.reason.trim() : null;
    if (args.to === 'cancelled' && !reason) {
      throw new AppError('validation_failed', 'Give a reason for cancelling this request.', {
        issues: [{ path: 'reason', message: 'Required', code: 'required' }],
      });
    }

    const now = nowIso();
    const by = args.actor.label;
    const patch: Record<string, unknown> = { status: args.to, updated_at: now };
    if (args.to === 'acknowledged') {
      patch.acknowledged_at = now;
      patch.acknowledged_by = by;
    } else if (args.to === 'completed') {
      patch.completed_at = now;
      patch.completed_by = by;
      // Completing straight from "sent" is also the first staff response.
      if (!row.acknowledged_at) {
        patch.acknowledged_at = now;
        patch.acknowledged_by = by;
      }
      if (reason) patch.close_reason = reason;
    } else if (args.to === 'cancelled') {
      patch.cancelled_at = now;
      patch.cancelled_by = by;
      patch.close_reason = reason;
    }
    if (!updateVersioned('service_requests', row.id, row.version, patch)) staleVersion(currentDTO(row.id));

    audit(args.actor, `service.${args.to}`, { type: 'service_request', id: row.id, visit_id: row.visit_id }, {
      reason,
      before: { status: row.status },
      after: { status: args.to, type: row.type },
    });
    const fresh = getServiceRequest(row.id)!;
    emitService(serviceRequestDTO(fresh), args.to, fresh.version);
    return serviceRequestDTO(fresh);
  });
}

// ------------------------------------------------------------------ checkout
/**
 * Resolve every open request of a visit during checkout (brief 36 step 4).
 * The bill request is completed (checkout handled it); everything else is
 * cancelled with `reason`, attributed to the staff actor.
 */
export function closeRequestsForCheckout(visitId: string, reason: string | null | undefined, actor: Actor): { completed: number; cancelled: number } {
  const why = reason?.trim() ? reason.trim() : DEFAULT_CHECKOUT_CLOSE_REASON;
  return tx(() => {
    const open = many<ServiceRequestListRow>(
      `${SELECT_WITH_LABEL} WHERE s.visit_id = ? AND s.status IN ('sent','acknowledged') ORDER BY s.created_at, s.id`, [visitId],
    );
    const now = nowIso();
    let completed = 0;
    let cancelled = 0;
    for (const r of open) {
      const handled = r.type === 'bill';
      const status: ServiceStatus = handled ? 'completed' : 'cancelled';
      const closeReason = handled ? BILL_HANDLED_AT_CHECKOUT : why;
      const patch = handled
        ? { status, completed_at: now, completed_by: actor.label, close_reason: closeReason, updated_at: now }
        : { status, cancelled_at: now, cancelled_by: actor.label, close_reason: closeReason, updated_at: now };
      if (!updateVersioned('service_requests', r.id, r.version, patch)) staleVersion(currentDTO(r.id));
      if (handled) completed++; else cancelled++;
      audit(actor, handled ? 'service.completed_at_checkout' : 'service.cancelled_at_checkout',
        { type: 'service_request', id: r.id, visit_id: visitId },
        { reason: closeReason, before: { status: r.status }, after: { status, type: r.type } });
      emitService(serviceRequestDTO(r), status, r.version + 1);
    }
    return { completed, cancelled };
  });
}

// ------------------------------------------------------------------ feedback
export interface FeedbackArgs {
  visitId: string;
  guestSessionId: string;
  rating?: number | null;
  comment?: string | null;
  idempotencyKey: string;
  actor: Actor;
}

interface FeedbackRow { id: string; visit_id: string; guest_session_id: string; idempotency_key: string }

/**
 * Store optional feedback: one per guest session. The same key replays;
 * a second submission from the same browser returns already_done. Comments
 * are private to the restaurant: never emitted, audited only as "has comment".
 */
export function submitFeedback(args: FeedbackArgs): { replayed: boolean } {
  hit(`feedback:${args.guestSessionId}`, LIMITS.feedback);
  const rating = args.rating ?? null;
  const comment = args.comment?.trim() ? args.comment.trim() : null;
  return tx(() => {
    const mine = one<FeedbackRow>('SELECT id, visit_id, guest_session_id, idempotency_key FROM feedback WHERE guest_session_id = ?', [args.guestSessionId]);
    if (mine) {
      if (mine.idempotency_key === args.idempotencyKey) return { replayed: true };
      throw new AppError('already_done', 'Thank you - your feedback is already with us.');
    }
    if (rating === null && comment === null) {
      throw new AppError('validation_failed', 'Choose a rating or write a comment.', {
        issues: [{ path: 'rating', message: 'Rating or comment required', code: 'required' }],
      });
    }
    const visit = getVisit(args.visitId);
    if (!visit) throw new AppError('not_found', 'Visit not found');
    if (visit.status === 'closed') throw new AppError('visit_closed');

    const now = nowIso();
    const id = newId('fbk');
    try {
      tx(() => insert('feedback', {
        id,
        visit_id: visit.id,
        guest_session_id: args.guestSessionId,
        rating,
        comment,
        idempotency_key: args.idempotencyKey,
        created_at: now,
        business_date: businessDate(now, cutoffHour()),
        is_fixture: visit.is_fixture === 1 ? 1 : fixtureFlag(),
      }));
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      const again = one<FeedbackRow>('SELECT id, visit_id, guest_session_id, idempotency_key FROM feedback WHERE guest_session_id = ?', [args.guestSessionId]);
      if (again?.idempotency_key === args.idempotencyKey) return { replayed: true };
      throw new AppError('idempotency_mismatch', 'This feedback key was already used.');
    }
    audit(args.actor, 'feedback.submit', { type: 'feedback', id, visit_id: visit.id }, {
      after: { rating, has_comment: comment !== null },
    });
    return { replayed: false };
  });
}
