// Payment records (brief 16, 23, 24; D-12).
//
// V1 records OFFLINE payments that a cashier has verified: one full-bill
// settlement per payable revision. The database guarantees it (partial UNIQUE
// index payments_one_settlement), the endpoint is idempotent, and a guest can
// never mark a bill paid - there is no guest payment endpoint at all.
//
// Confirmed history is never edited or deleted. A correction inserts a
// `reversal` row (or, once the visit is closed, a `refund_record`: a record of
// a manual refund staff say they made, not a transfer this app performed).
// Payment references are shown only to staff with payments.view and never
// written to the audit log or the event stream.
import type { PaymentBody, ReversePaymentBody } from '../../shared/schemas.ts';
import type { Bilingual, PaymentDTO, PaymentExceptionDTO, PaymentsListDTO, StaffBillDTO } from '../../shared/dto.ts';
import type { PaymentKind, PaymentStatus, VisitStatus } from '../../shared/status.ts';
import type { PaymentMethod } from '../../shared/settings.ts';
import type { z } from 'zod';
import { newId } from '../../shared/ids.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import { config } from '../config.ts';
import { insert, isConstraintError, many, one, run, updateVersioned } from '../db/index.ts';
import { AppError, assertFound, staleVersion } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { emit } from '../lib/events.ts';
import { cutoffHour, getSettings } from '../lib/settings.ts';
import { touchReportData } from '../lib/reportdata.ts';
import type { StaffContext } from '../lib/auth.ts';
import { getVisit, type VisitRow } from './guards.ts';
import {
  assertVisitNotClosed, currentRevision, ensureBill, getBill, getRevision, requireVisit,
  revisionMatchesRunning, runningBill, staffBill,
} from './billing.ts';

// ------------------------------------------------------------------ rows and DTOs
export interface PaymentRow {
  id: string;
  visit_id: string;
  bill_revision_id: string;
  kind: PaymentKind;
  method: string;
  amount_minor: number;
  tendered_minor: number | null;
  change_minor: number | null;
  reference: string | null;
  status: PaymentStatus;
  idempotency_key: string;
  reverses_payment_id: string | null;
  reason: string | null;
  confirmed_by: string;
  confirmed_at: string;
  business_date: string;
  is_fixture: number;
}

type ListedPayment = PaymentRow & { staff_name: string | null; table_label: string | null };

const PAYMENT_SELECT = `
  SELECT p.*, u.display_name AS staff_name, t.label AS table_label
    FROM payments p
    LEFT JOIN staff_users u ON u.id = p.confirmed_by
    JOIN visits v ON v.id = p.visit_id
    JOIN dining_tables t ON t.id = v.table_id`;

export function methodLabel(methodId: string): Bilingual {
  const m = getSettings().payment_methods.find((x) => x.id === methodId);
  return m ? { th: m.label_th, en: m.label_en } : { th: methodId, en: methodId };
}

export function paymentDTO(p: ListedPayment, showReference: boolean): PaymentDTO {
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    method: p.method,
    method_label: methodLabel(p.method),
    amount_minor: p.amount_minor,
    tendered_minor: p.tendered_minor,
    change_minor: p.change_minor,
    reference: showReference ? p.reference : null,
    bill_revision_id: p.bill_revision_id,
    confirmed_by: p.staff_name,
    confirmed_at: p.confirmed_at,
    reverses_payment_id: p.reverses_payment_id,
    reason: p.reason,
    visit_id: p.visit_id,
    table_label: p.table_label ?? undefined,
  };
}

/** Every payment record of a visit, newest first. */
export function visitPayments(visitId: string, showReference: boolean): PaymentDTO[] {
  return many<ListedPayment>(`${PAYMENT_SELECT} WHERE p.visit_id = ? ORDER BY p.confirmed_at DESC, p.id`, [visitId])
    .map((p) => paymentDTO(p, showReference));
}

function getPayment(id: string): PaymentRow | undefined {
  return one<PaymentRow>('SELECT * FROM payments WHERE id = ?', [id]);
}

function paymentByKey(key: string): PaymentRow | undefined {
  return one<PaymentRow>('SELECT * FROM payments WHERE idempotency_key = ?', [key]);
}

function today(): string {
  return businessDate(Date.now(), cutoffHour());
}

function enabledMethod(id: string): PaymentMethod {
  const m = getSettings().payment_methods.find((x) => x.id === id && x.enabled);
  if (!m) {
    throw new AppError('validation_failed', 'That payment method is not enabled.', {
      issues: [{ path: 'method', message: 'not an enabled payment method', code: 'invalid_value' }],
    });
  }
  return m;
}

// ------------------------------------------------------------------ confirm a settlement
export function confirmPayment(visitId: string, input: z.infer<typeof PaymentBody>, staff: StaffContext): StaffBillDTO {
  // Replay: the same attempt returns the bill as it is now. The same key with
  // any different recorded detail is a different attempt, not a replay.
  const prior = paymentByKey(input.idempotency_key);
  if (prior) {
    const tenderedMethod = getSettings().payment_methods.find((m) => m.id === input.method)?.tendered === true;
    const same = prior.kind === 'settlement' && prior.visit_id === visitId && prior.bill_revision_id === input.revision_id
      && prior.method === input.method && prior.amount_minor === input.amount_minor
      && prior.tendered_minor === (tenderedMethod ? input.tendered_minor ?? null : null)
      && prior.reference === (input.reference?.trim() || null);
    if (!same) throw new AppError('idempotency_mismatch', 'This payment attempt was already used for something else.');
    return staffBill(visitId, staff);
  }

  const visit = requireVisit(visitId);
  assertVisitNotClosed(visit);
  const bill = ensureBill(visit.id);
  const revision = getRevision(input.revision_id);
  if (!revision || revision.visit_id !== visit.id) throw new AppError('not_found', 'That bill revision is not on this visit.');

  // The revision must be the bill's current PAYABLE revision.
  if (revision.status === 'settled' || bill.status === 'settled') {
    throw new AppError('already_settled', 'This bill has already been paid.', { bill: staffBill(visitId, staff) });
  }
  if (revision.status !== 'payable' || bill.current_revision_id !== revision.id) {
    throw new AppError('bill_changed', 'The bill was changed. Check the new bill before taking payment.', { bill: staffBill(visitId, staff) });
  }
  if (!revisionMatchesRunning(revision, runningBill(visit))) {
    throw new AppError('bill_changed', 'Items changed after the bill was finalized. Finalize it again before taking payment.', {
      bill: staffBill(visitId, staff),
    });
  }

  const method = enabledMethod(input.method);
  // V1 records full-bill payments only (no split bills, no tips).
  if (input.amount_minor !== revision.total_minor) {
    throw new AppError('amount_mismatch', 'The amount must equal the bill total.', {
      expected_minor: revision.total_minor, received_minor: input.amount_minor,
    });
  }
  let tendered: number | null = null;
  let change: number | null = null;
  if (method.tendered && input.tendered_minor !== null && input.tendered_minor !== undefined) {
    if (input.tendered_minor < input.amount_minor) {
      throw new AppError('amount_mismatch', 'The cash received is less than the bill total.', {
        expected_minor: revision.total_minor, tendered_minor: input.tendered_minor,
      });
    }
    tendered = input.tendered_minor;
    change = input.tendered_minor - input.amount_minor;
  }

  const id = newId('pay');
  const now = nowIso();
  try {
    insert('payments', {
      id,
      visit_id: visit.id,
      bill_revision_id: revision.id,
      kind: 'settlement',
      method: method.id,
      amount_minor: input.amount_minor,
      tendered_minor: tendered,
      change_minor: change,
      reference: input.reference?.trim() || null,
      status: 'confirmed',
      idempotency_key: input.idempotency_key,
      reverses_payment_id: null,
      reason: null,
      confirmed_by: staff.user.id,
      confirmed_at: now,
      business_date: today(),
      // Financial records inherit the visit's demo flag so a demo visit never
      // produces a "real" payment (and vice versa) if the mode changes mid-visit.
      is_fixture: visit.is_fixture,
    });
  } catch (err) {
    // A racing cashier committed first: the partial UNIQUE index keeps one settlement.
    if (isConstraintError(err, 'payments.bill_revision_id')) {
      throw new AppError('already_settled', 'This bill has already been paid.', { bill: staffBill(visitId, staff) });
    }
    if (isConstraintError(err, 'payments.idempotency_key')) {
      throw new AppError('idempotency_mismatch', 'This payment attempt was already used.');
    }
    throw err;
  }

  if (run(`UPDATE bill_revisions SET status = 'settled' WHERE id = ? AND status = 'payable'`, [revision.id]).changes !== 1) {
    throw new AppError('bill_changed', 'The bill was changed on another device.');
  }
  if (!updateVersioned('bills', bill.id, bill.version, { status: 'settled', updated_at: now })) staleVersion();

  audit(staff.actor, 'payment.confirm', { type: 'payment', id, visit_id: visit.id }, {
    // No payment reference here: audit entries are widely readable.
    after: {
      method: method.id, amount_minor: input.amount_minor, tendered_minor: tendered, change_minor: change,
      revision_no: revision.revision_no, has_reference: Boolean(input.reference?.trim()),
    },
  });
  emit('payment.recorded', { audience: 'staff', visit_id: visit.id, entity: { type: 'payment', id }, payload: { kind: 'settlement' } });
  emit('bill.updated', { audience: 'all', visit_id: visit.id, entity: { type: 'bill', id: bill.id, version: bill.version + 1 }, payload: { paid: true } });
  return staffBill(visitId, staff);
}

// ------------------------------------------------------------------ reverse / refund record
export function reversePayment(paymentId: string, input: z.infer<typeof ReversePaymentBody>, staff: StaffContext): StaffBillDTO {
  const prior = paymentByKey(input.idempotency_key);
  if (prior) {
    if (prior.reverses_payment_id !== paymentId || prior.reason !== input.reason) {
      throw new AppError('idempotency_mismatch', 'This correction attempt was already used for something else.');
    }
    return staffBill(prior.visit_id, staff);
  }

  const original = assertFound(getPayment(paymentId), 'payment');
  if (original.kind !== 'settlement') {
    throw new AppError('invalid_transition', 'Only a settlement can be reversed.', { kind: original.kind });
  }
  // Already reversed (by anyone): both devices see the same single reversal.
  if (original.status === 'reversed') return staffBill(original.visit_id, staff);
  if (original.status !== 'confirmed') {
    throw new AppError('invalid_transition', 'Only a confirmed payment can be reversed.', { status: original.status });
  }

  const visit = assertFound(getVisit(original.visit_id), 'visit');
  const closed = visit.status === 'closed';
  const kind: PaymentKind = closed ? 'refund_record' : 'reversal';
  const id = newId('pay');
  const now = nowIso();
  try {
    insert('payments', {
      id,
      visit_id: visit.id,
      bill_revision_id: original.bill_revision_id,
      kind,
      method: original.method,
      amount_minor: original.amount_minor,
      tendered_minor: null,
      change_minor: null,
      reference: null,
      status: 'confirmed',
      idempotency_key: input.idempotency_key,
      reverses_payment_id: original.id,
      reason: input.reason,
      confirmed_by: staff.user.id,
      confirmed_at: now,
      business_date: today(),
      is_fixture: original.is_fixture,
    });
  } catch (err) {
    if (isConstraintError(err, 'payments.reverses_payment_id')) return staffBill(visit.id, staff);
    throw err;
  }
  run(`UPDATE payments SET status = 'reversed' WHERE id = ? AND status = 'confirmed'`, [original.id]);

  if (!closed) reopenSettlement(visit, original.bill_revision_id);

  // A reversal changes a day that may already have been reported.
  touchReportData(original.business_date);
  if (original.business_date !== today()) touchReportData(today());

  audit(staff.actor, kind === 'reversal' ? 'payment.reverse' : 'payment.refund_record', { type: 'payment', id: original.id, visit_id: visit.id }, {
    reason: input.reason,
    before: { status: 'confirmed' },
    after: { status: 'reversed', record_id: id, kind, amount_minor: original.amount_minor, method: original.method },
  });
  emit('payment.recorded', { audience: 'staff', visit_id: visit.id, entity: { type: 'payment', id }, payload: { kind } });
  const bill = getBill(visit.id);
  if (bill) {
    emit('bill.updated', {
      audience: closed ? 'staff' : 'all', visit_id: visit.id,
      entity: { type: 'bill', id: bill.id, version: bill.version }, payload: { paid: bill.status === 'settled' },
    });
  }
  return staffBill(visit.id, staff);
}

/** Reversal on an active visit: the settled revision becomes payable again. */
function reopenSettlement(visit: VisitRow, revisionId: string): void {
  const bill = assertFound(getBill(visit.id), 'bill');
  const revision = assertFound(getRevision(revisionId), 'bill revision');
  // The settled revision is always the bill's current one (reopen and
  // re-finalize refuse a settled bill), so no other payable revision exists.
  if (revision.status === 'settled' && currentRevision(bill)?.id === revision.id) {
    run(`UPDATE bill_revisions SET status = 'payable' WHERE id = ? AND status = 'settled'`, [revision.id]);
    if (!updateVersioned('bills', bill.id, bill.version, { status: 'finalized', current_revision_id: revision.id, updated_at: nowIso() })) staleVersion();
  }
}

// ------------------------------------------------------------------ payments list
export interface PaymentListQuery {
  date: string;
  status?: PaymentStatus;
  includeFixture: boolean;
}

export function listPayments(q: PaymentListQuery): PaymentsListDTO {
  const fixture = q.includeFixture ? 1 : 0;
  const payments = many<ListedPayment>(
    `${PAYMENT_SELECT}
      WHERE p.business_date = :date AND (:status IS NULL OR p.status = :status) AND (p.is_fixture = 0 OR :fixture = 1)
      ORDER BY p.confirmed_at DESC, p.id`,
    { date: q.date, status: q.status ?? null, fixture },
  ).map((p) => paymentDTO(p, true));

  const exceptions: PaymentExceptionDTO[] = [];

  // Finalized bills with nothing settled against them (not closed by exception: listed below).
  for (const r of many<{ id: string; visit_id: string; revision_no: number; total_minor: number; finalized_at: string; visit_status: VisitStatus; label: string }>(
    `SELECT r.id, r.visit_id, r.revision_no, r.total_minor, r.finalized_at, v.status AS visit_status, t.label
       FROM bill_revisions r JOIN visits v ON v.id = r.visit_id JOIN dining_tables t ON t.id = v.table_id
      WHERE r.status = 'payable' AND r.total_minor > 0 AND r.business_date = :date
        AND v.close_exception IS NULL AND (r.is_fixture = 0 OR :fixture = 1)
      ORDER BY r.finalized_at`,
    { date: q.date, fixture },
  )) {
    exceptions.push({
      kind: 'unpaid_finalized', visit_id: r.visit_id, visit_status: r.visit_status, table_label: r.label,
      at: r.finalized_at, amount_minor: r.total_minor, reason: null, revision_no: r.revision_no, payment_id: null,
    });
  }

  // Visits a manager closed despite blockers.
  for (const v of many<VisitRow & { label: string }>(
    `SELECT v.*, t.label FROM visits v JOIN dining_tables t ON t.id = v.table_id
      WHERE v.close_business_date = :date AND v.close_exception IS NOT NULL AND (v.is_fixture = 0 OR :fixture = 1)
      ORDER BY v.closed_at`,
    { date: q.date, fixture },
  )) {
    const current = currentRevision(getBill(v.id));
    const due = current?.status === 'settled' ? 0 : current ? current.total_minor : runningBill(v).math.total_minor;
    exceptions.push({
      kind: 'closed_with_exception', visit_id: v.id, visit_status: v.status, table_label: v.label,
      at: v.closed_at ?? v.updated_at, amount_minor: due, reason: v.close_exception,
      revision_no: current?.revision_no ?? null, payment_id: null,
    });
  }

  // Reversals and recorded refunds.
  for (const p of payments.filter((x) => x.kind !== 'settlement')) {
    exceptions.push({
      kind: p.kind === 'reversal' ? 'reversal' : 'refund_record', visit_id: p.visit_id!, visit_status: null,
      table_label: p.table_label ?? '', at: p.confirmed_at, amount_minor: p.amount_minor, reason: p.reason,
      revision_no: null, payment_id: p.id,
    });
  }

  const settlements = payments.filter((p) => p.kind === 'settlement' && p.status === 'confirmed');
  const sum = (xs: Array<{ amount_minor: number }>) => xs.reduce((s, x) => s + x.amount_minor, 0);
  return {
    date: q.date,
    payments,
    exceptions,
    summary: {
      confirmed: { count: settlements.length, value_minor: sum(settlements) },
      exceptions: { count: exceptions.length, value_minor: sum(exceptions) },
    },
    include_fixture: q.includeFixture,
  };
}

// ------------------------------------------------------------------ online payments (deferred)
/**
 * Boundary for an optional online-payment provider (brief 24). DEFERRED in V1:
 * no provider is implemented and no route offers a guest "pay" button.
 * A real adapter must:
 *  - create an attempt against ONE payable revision for its exact amount and
 *    currency (payment_attempts), keeping secrets server-side;
 *  - verify callbacks with the provider's signature procedure, deduplicate them
 *    by provider event id (payment_callbacks), and validate merchant,
 *    reference, amount, currency and revision before settling;
 *  - settle through the same transaction and UNIQUE index as confirmPayment,
 *    routing late or mismatched successes to staff review (`needs_review`);
 *  - treat browser redirects as navigation only and recover pending outcomes
 *    with lookup().
 * Card details are never collected or stored by this application.
 */
export interface PaymentAttemptInput {
  attemptId: string;
  revisionId: string;
  amountMinor: number;
  currency: 'THB';
  /** Where the provider sends the guest back to (navigation only, never proof of payment). */
  returnUrl: string;
}

export interface PaymentAttemptCreated {
  providerRef: string;
  /** Hosted payment page or a provider QR payload for the guest. */
  redirectUrl?: string;
  qrPayload?: string;
  expiresAt?: string;
}

export interface VerifiedCallback {
  eventId: string;
  providerRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  amountMinor: number;
  currency: string;
  merchantId: string;
}

export interface PaymentAdapter {
  readonly provider: string;
  createAttempt(input: PaymentAttemptInput): Promise<PaymentAttemptCreated>;
  /** Returns null when the signature or authenticity check fails. */
  verifyCallback(req: { headers: Record<string, string>; rawBody: string }): Promise<VerifiedCallback | null>;
  lookup(providerRef: string): Promise<{ status: 'pending' | 'succeeded' | 'failed'; amountMinor: number; currency: string }>;
}

let warnedUnimplemented = false;

/** The configured online-payment adapter, or null (always null in V1). */
export function getPaymentAdapter(): PaymentAdapter | null {
  if (!config.paymentProvider) return null;
  if (!warnedUnimplemented) {
    warnedUnimplemented = true;
    console.warn(`[payments] PAYMENT_PROVIDER="${config.paymentProvider}" is set, but no online-payment adapter is implemented in V1. Payments stay staff-confirmed.`);
  }
  return null;
}

/** For a future online-payment route: fail clearly while no provider is wired. */
export function requirePaymentAdapter(): PaymentAdapter {
  const adapter = getPaymentAdapter();
  if (!adapter) throw new AppError('payments_not_configured', 'Online payment is not available. Please pay at the counter.');
  return adapter;
}
