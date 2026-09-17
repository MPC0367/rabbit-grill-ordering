// Complete checkout: end the dining visit and free the table (brief 36, D-13).
//
// ONE idempotent transaction. It re-reads the visit, verifies fulfilment and
// settlement, closes what is still open with an attributable reason, closes
// the visit, revokes guest access and clears the PIN. The table then shows
// Available on its own, because table state is derived from the active visit
// (a disabled table stays Disabled). Payment alone never frees a table, and
// finishing the food never frees a table: only this action does.
import type { CheckoutBody } from '../../shared/schemas.ts';
import type { BillLineDTO, CheckoutResultDTO } from '../../shared/dto.ts';
import type { z } from 'zod';
import { businessDate, nowIso } from '../../shared/time.ts';
import { one, run, updateVersioned } from '../db/index.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { emit } from '../lib/events.ts';
import { cutoffHour } from '../lib/settings.ts';
import type { StaffContext } from '../lib/auth.ts';
import { getVisit, type VisitRow } from './guards.ts';
import {
  currentRevision, ensureBill, getBill, requireVisit, revisionMatchesRunning, runningBill, type RevisionRow,
} from './billing.ts';
import { closeRequestsForCheckout, openRequestCount } from './service.ts';
import { cancelPortionsForCheckout, openPortionCount } from './portions.ts';
import { revokeVisitAccess } from './visits.ts';
import { tableTile } from './tables.ts';

/** Codes that stop checkout unless a manager records an exception. */
export type CheckoutBlocker = 'unresolved_orders' | 'bill_not_finalized' | 'unpaid_bill';
/** Shown to staff but closed automatically (with a reason) at checkout. */
export type CheckoutNotice = 'open_requests' | 'open_portions';

export interface CheckoutState {
  blocking: CheckoutBlocker[];
  informational: CheckoutNotice[];
  /** Submitted or accepted-but-not-served lines. */
  unresolved_lines: BillLineDTO[];
  /** Chargeable lines or adjustments exist, so an immutable revision is required. */
  has_content: boolean;
  /** What is still owed: the current revision's total, else the running total; 0 once settled. */
  amount_due_minor: number;
  current: RevisionRow | undefined;
  open_requests: number;
  open_portions: number;
}

/** Everything checkout needs to know about a (not yet closed) visit. */
export function checkoutState(visit: VisitRow): CheckoutState {
  const empty: CheckoutState = {
    blocking: [], informational: [], unresolved_lines: [], has_content: false,
    amount_due_minor: 0, current: undefined, open_requests: 0, open_portions: 0,
  };
  if (visit.status === 'closed') return empty;

  const running = runningBill(visit);
  const current = currentRevision(getBill(visit.id));
  const blocking: CheckoutBlocker[] = [];

  if (running.unserved_lines.length > 0) blocking.push('unresolved_orders');

  // A payable revision that no longer matches the lines (an item was cancelled
  // after finalizing) must be finalized again; nobody may settle it as is.
  const revisionInForce = current && (current.status === 'settled' || revisionMatchesRunning(current, running));
  if (running.has_content && !revisionInForce) blocking.push('bill_not_finalized');

  const settled = current?.status === 'settled';
  const due = settled ? 0 : current ? current.total_minor : running.math.total_minor;
  if (due > 0) blocking.push('unpaid_bill');

  const openRequests = openRequestCount(visit.id);
  const openPortions = openPortionCount(visit.id);
  const informational: CheckoutNotice[] = [];
  if (openRequests > 0) informational.push('open_requests');
  if (openPortions > 0) informational.push('open_portions');

  return {
    blocking,
    informational,
    unresolved_lines: running.unserved_lines,
    has_content: running.has_content,
    amount_due_minor: due,
    current,
    open_requests: openRequests,
    open_portions: openPortions,
  };
}

/** Blocking codes followed by informational ones (see API.md internal contracts). */
export function checkoutBlockers(visitId: string): string[] {
  const visit = getVisit(visitId);
  if (!visit) return [];
  const s = checkoutState(visit);
  return [...s.blocking, ...s.informational];
}

const BLOCKER_MESSAGE: Record<CheckoutBlocker, string> = {
  unresolved_orders: 'Some items are not served or resolved yet.',
  bill_not_finalized: 'Finalize the bill before completing checkout.',
  unpaid_bill: 'The bill has not been paid yet.',
};

function remainingDetails(s: CheckoutState) {
  return {
    blockers: s.blocking,
    notices: s.informational,
    remaining: {
      unresolved_lines: s.unresolved_lines,
      amount_due_minor: s.amount_due_minor,
      revision_no: s.current?.revision_no ?? null,
      revision_status: s.current?.status ?? null,
      open_requests: s.open_requests,
      open_portion_requests: s.open_portions,
    },
  };
}

function result(visit: VisitRow, replayed: boolean): CheckoutResultDTO {
  return {
    visit_id: visit.id,
    status: 'closed',
    closed_at: visit.closed_at!,
    table: tableTile(visit.table_id),
    replayed,
  };
}

export function completeCheckout(visitId: string, input: z.infer<typeof CheckoutBody>, staff: StaffContext): CheckoutResultDTO {
  // a) Re-read inside the transaction. Two devices pressing Complete checkout
  //    both get the single closed visit back; nothing runs twice.
  const visit = requireVisit(visitId);
  const keyOwner = one<{ id: string }>('SELECT id FROM visits WHERE close_idempotency_key = ?', [input.idempotency_key]);
  if (keyOwner && keyOwner.id !== visit.id) {
    throw new AppError('idempotency_mismatch', 'This checkout attempt belongs to another visit.');
  }
  if (visit.status === 'closed') return result(visit, true);

  const state = checkoutState(visit);

  // b) Checkout normally follows "Start checkout". Straight from dining only
  //    when nothing was ever charged or is still waiting (guests left without ordering).
  if (visit.status === 'open' && (state.has_content || state.unresolved_lines.length > 0)) {
    throw new AppError('invalid_transition', 'Start checkout and settle the bill first.', {
      visit_status: visit.status, ...remainingDetails(state),
    });
  }

  // c) Blockers: stop, say exactly what remains, keep the table occupied -
  //    unless a manager records an exception with a reason.
  let exception: string | null = null;
  if (state.blocking.length > 0) {
    const reason = input.exception_reason?.trim() || null;
    if (!reason) {
      const first = state.blocking[0];
      throw new AppError(first, BLOCKER_MESSAGE[first], remainingDetails(state));
    }
    if (!staff.can('visits.close_exception')) {
      throw new AppError('forbidden', 'Only a manager can close a visit with an exception.', {
        permission: 'visits.close_exception', ...remainingDetails(state),
      });
    }
    exception = reason;
  }

  const now = nowIso();
  const closeDate = businessDate(now, cutoffHour());

  // A finalized zero-total bill needs no payment: record it as settled so it
  // never shows up as an unpaid exception.
  const zeroBillSettled = state.current?.status === 'payable' && state.current.total_minor === 0;
  if (zeroBillSettled) {
    run(`UPDATE bill_revisions SET status = 'settled' WHERE id = ? AND status = 'payable'`, [state.current!.id]);
    const bill = ensureBill(visit.id);
    if (!updateVersioned('bills', bill.id, bill.version, { status: 'settled', updated_at: now })) staleVersion();
    emit('bill.updated', { audience: 'all', visit_id: visit.id, entity: { type: 'bill', id: bill.id, version: bill.version + 1 }, payload: { paid: true } });
  }

  // d) Close what is still open, attributably. Never silently "completed".
  closeRequestsForCheckout(visit.id, input.request_close_reason?.trim() || 'Closed at checkout', staff.actor);
  cancelPortionsForCheckout(visit.id, 'Visit closed at checkout', staff.actor);

  // e) Close the visit, clear the PIN, revoke every guest session.
  if (!updateVersioned('visits', visit.id, visit.version, {
    status: 'closed',
    closed_at: now,
    closed_by: staff.user.id,
    close_business_date: closeDate,
    close_idempotency_key: input.idempotency_key,
    close_exception: exception,
    join_pin: null,
    updated_at: now,
  })) staleVersion();
  revokeVisitAccess(visit.id, 'checkout', staff.actor);

  // f) Nothing to do for the table: its state derives from the active visit.

  // g) Audit and publish (delivered after commit).
  const entity = { type: 'visit', id: visit.id, visit_id: visit.id };
  audit(staff.actor, 'visit.checkout', entity, {
    reason: exception,
    before: { status: visit.status },
    after: {
      status: 'closed', close_business_date: closeDate, exception: exception !== null,
      amount_due_minor: state.amount_due_minor, zero_bill_settled: zeroBillSettled,
    },
  });
  if (exception) {
    audit(staff.actor, 'visit.close_exception', entity, {
      reason: exception,
      after: remainingDetails(state),
    });
  }
  emit('visit.closed', { audience: 'all', visit_id: visit.id, entity: { type: 'visit', id: visit.id, version: visit.version + 1 }, payload: { status: 'closed' } });
  emit('table.updated', { audience: 'staff', visit_id: visit.id, entity: { type: 'table', id: visit.table_id }, payload: { visit_status: 'closed' } });

  // h) The fresh table tile (Available, or Disabled if the table is disabled).
  return result(getVisit(visit.id)!, false);
}
