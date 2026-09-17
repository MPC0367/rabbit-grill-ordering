// The table bill (brief 16, 23; D-12).
//
// One bill per dining visit, created lazily. Until it is finalized the bill is
// a RUNNING view computed from the visit's order lines:
//   chargeable = accepted or later, not rejected/cancelled (shared isChargeable)
//   pending    = submitted, shown separately and never in the amount due
//   excluded   = rejected / cancelled
// plus non-voided adjustments and the charge rules snapshotted at seating,
// totalled by shared computeBill() (never floats, never client totals).
//
// "Finalize" freezes that view into an immutable bill_revisions row, which is
// what the guest sees and what a cashier settles. Reopening supersedes the
// payable revision (history is kept) and returns the visit to ordering.
//
// Every mutation here is synchronous and runs inside tx(); state is re-read
// inside the transaction.
import type { AdjustmentBody, FinalizeBillBody, VoidAdjustmentBody } from '../../shared/schemas.ts';
import type { BillLineDTO, BillRevisionDTO, GuestBillDTO, StaffBillDTO } from '../../shared/dto.ts';
import { computeBill, type BillMath, type ChargeLine, type ChargeRule, type Minor } from '../../shared/money.ts';
import { ACTIVE_UNSERVED, LINE_STATUSES, isChargeable, type BillStatus, type LineStatus, type RevisionStatus } from '../../shared/status.ts';
import { newId } from '../../shared/ids.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import type { z } from 'zod';
import { insert, many, one, parseJson, run, updateVersioned } from '../db/index.ts';
import { AppError, assertFound, staleVersion } from '../lib/errors.ts';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import { emit } from '../lib/events.ts';
import { cutoffHour, getSettings } from '../lib/settings.ts';
import { touchReportData } from '../lib/reportdata.ts';
import { payloadHash } from '../lib/http.ts';
import type { StaffContext } from '../lib/auth.ts';
import { bi } from './pricing.ts';
import { getTable, getVisit, type VisitRow } from './guards.ts';
import { checkoutState } from './checkout.ts';
import { visitPayments } from './payments.ts';
import { openRequestCount } from './service.ts';
import { openPortionCount } from './portions.ts';

// ------------------------------------------------------------------ rows
export interface BillRow {
  id: string;
  visit_id: string;
  status: BillStatus;
  current_revision_id: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface RevisionRow {
  id: string;
  bill_id: string;
  visit_id: string;
  revision_no: number;
  status: RevisionStatus;
  lines_json: string;
  excluded_json: string;
  adjustments_json: string;
  subtotal_minor: number;
  adjustments_minor: number;
  charges_json: string;
  total_minor: number;
  finalized_at: string;
  finalized_by: string;
  business_date: string;
  superseded_at: string | null;
  superseded_by: string | null;
  supersede_reason: string | null;
  is_fixture: number;
}

export interface AdjustmentRow {
  id: string;
  visit_id: string;
  kind: 'discount' | 'comp' | 'correction';
  amount_minor: number;
  reason: string;
  order_line_id: string | null;
  created_by: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  idempotency_key: string | null;
  payload_hash: string | null;
}

interface BillLineRow {
  id: string;
  reference: string;
  name_th: string | null;
  name_en: string | null;
  variant_name_th: string | null;
  variant_name_en: string | null;
  quantity: number;
  measured_grams: number | null;
  line_total_minor: number;
  status: LineStatus;
}

export type AdjustmentSummary = BillRevisionDTO['adjustments'][number];

// ------------------------------------------------------------------ reads
export function getBill(visitId: string): BillRow | undefined {
  return one<BillRow>('SELECT * FROM bills WHERE visit_id = ?', [visitId]);
}

/** The visit's bill, created on first use. Safe inside or outside a transaction. */
export function ensureBill(visitId: string): BillRow {
  const now = nowIso();
  run(
    `INSERT INTO bills (id, visit_id, status, current_revision_id, created_at, updated_at)
     VALUES (:id, :visit, 'open', NULL, :now, :now) ON CONFLICT(visit_id) DO NOTHING`,
    { id: newId('bil'), visit: visitId, now },
  );
  return getBill(visitId)!;
}

export function getRevision(id: string): RevisionRow | undefined {
  return one<RevisionRow>('SELECT * FROM bill_revisions WHERE id = ?', [id]);
}

/** The bill's current revision when it is still in force (payable or settled). */
export function currentRevision(bill: BillRow | undefined): RevisionRow | undefined {
  if (!bill?.current_revision_id) return undefined;
  const rev = getRevision(bill.current_revision_id);
  return rev && rev.status !== 'superseded' ? rev : undefined;
}

export function visitRevisions(visitId: string): RevisionRow[] {
  return many<RevisionRow>('SELECT * FROM bill_revisions WHERE visit_id = ? ORDER BY revision_no DESC', [visitId]);
}

export function requireVisit(visitId: string): VisitRow {
  return assertFound(getVisit(visitId), 'visit');
}

/** Staff mutations on a closed visit are refused; the visit is history now. */
export function assertVisitNotClosed(visit: VisitRow): void {
  if (visit.status === 'closed') {
    throw new AppError('invalid_transition', 'This visit is already closed.', { visit_status: visit.status });
  }
}

function toBillLine(r: BillLineRow): BillLineDTO {
  const variant = r.variant_name_th || r.variant_name_en ? bi(r.variant_name_th, r.variant_name_en) : null;
  return {
    order_reference: r.reference,
    line_id: r.id,
    name: bi(r.name_th, r.name_en),
    variant_name: variant,
    quantity: r.quantity,
    measured_grams: r.measured_grams,
    line_total_minor: r.line_total_minor,
    status: r.status,
  };
}

function visitBillLines(visitId: string): BillLineDTO[] {
  return many<BillLineRow>(
    `SELECT l.id, o.reference, l.name_th, l.name_en, l.variant_name_th, l.variant_name_en,
            l.quantity, l.measured_grams, l.line_total_minor, l.status
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.visit_id = ?
      ORDER BY o.round_no, l.line_no`,
    [visitId],
  ).map(toBillLine);
}

const CHARGEABLE_STATUSES = LINE_STATUSES.filter(isChargeable);

/**
 * Adjustments that count on the running bill: not voided, and - when linked
 * to a dish - only while that dish is still chargeable. Cancelling or
 * rejecting a dish voids its linked adjustments (voidLineAdjustments); the
 * line check is the backstop for rows written before that rule existed.
 */
export function activeAdjustments(visitId: string): AdjustmentRow[] {
  return many<AdjustmentRow>(
    `SELECT a.* FROM bill_adjustments a LEFT JOIN order_lines l ON l.id = a.order_line_id
      WHERE a.visit_id = :visit AND a.voided_at IS NULL
        AND (a.order_line_id IS NULL OR l.status IN (SELECT value FROM json_each(:chargeable)))
      ORDER BY a.created_at, a.id`,
    { visit: visitId, chargeable: CHARGEABLE_STATUSES },
  );
}

/** Voided adjustments of a visit, newest first (staff bill history). */
function voidedAdjustments(visitId: string): AdjustmentRow[] {
  return many<AdjustmentRow>(
    'SELECT * FROM bill_adjustments WHERE visit_id = ? AND voided_at IS NOT NULL ORDER BY voided_at DESC, id',
    [visitId],
  );
}

// ------------------------------------------------------------------ payment state
export type PaymentState = 'none' | 'paid' | 'refunded' | 'reversed';

interface RevisionPayments {
  /** A confirmed settlement for the revision is in force (or the revision owes nothing). */
  paid: boolean;
  state: PaymentState;
  refund: StaffBillDTO['refund'];
}

/**
 * What actually happened to the money of a (settled) revision. A settled
 * revision stays settled as history (D-S8-04), but when its settlement was
 * refunded after checkout the bill is no longer "paid".
 */
function revisionPayments(rev: RevisionRow | undefined): RevisionPayments {
  if (!rev) return { paid: false, state: 'none', refund: null };
  const settlement = one<{ id: string; status: string }>(
    `SELECT id, status FROM payments WHERE bill_revision_id = ? AND kind = 'settlement'
      ORDER BY (status = 'confirmed') DESC, confirmed_at DESC LIMIT 1`, [rev.id]);
  if (settlement?.status === 'confirmed') return { paid: true, state: 'paid', refund: null };
  if (rev.status === 'settled' && !settlement) {
    // A zero-total bill is settled at checkout without a payment row.
    return { paid: rev.total_minor === 0, state: rev.total_minor === 0 ? 'paid' : 'none', refund: null };
  }
  if (settlement?.status === 'reversed') {
    const counter = one<{ kind: string; amount_minor: number; reason: string | null; confirmed_at: string; by: string | null }>(
      `SELECT p.kind, p.amount_minor, p.reason, p.confirmed_at, u.display_name AS by
         FROM payments p LEFT JOIN staff_users u ON u.id = p.confirmed_by
        WHERE p.reverses_payment_id = ? LIMIT 1`, [settlement.id]);
    if (counter?.kind === 'refund_record') {
      return {
        paid: false,
        state: 'refunded',
        refund: { amount_minor: counter.amount_minor, reason: counter.reason, by: counter.by, at: counter.confirmed_at },
      };
    }
    return { paid: false, state: 'reversed', refund: null };
  }
  return { paid: false, state: 'none', refund: null };
}

export function visitChargeRules(visit: VisitRow): ChargeRule[] {
  return parseJson<ChargeRule[]>(visit.charges_json, []);
}

export interface RunningBill {
  lines: BillLineDTO[];
  pending_lines: BillLineDTO[];
  excluded_lines: BillLineDTO[];
  /** Accepted-but-not-served plus submitted lines (ACTIVE_UNSERVED). */
  unserved_lines: BillLineDTO[];
  adjustments: AdjustmentSummary[];
  /** The adjustment rows behind `adjustments` (staff views). */
  adjustment_rows: AdjustmentRow[];
  math: BillMath;
  /** Anything that must be captured in a finalized revision (chargeable lines or adjustments). */
  has_content: boolean;
}

/** The live bill as it stands right now, from order lines + adjustments + seated charges. */
export function runningBill(visit: VisitRow): RunningBill {
  const all = visitBillLines(visit.id);
  const lines = all.filter((l) => isChargeable(l.status));
  const adjustmentRows = activeAdjustments(visit.id);
  const adjustments = adjustmentRows.map((a) => ({ id: a.id, kind: a.kind, amount_minor: a.amount_minor, reason: a.reason }));
  const math = computeBill({
    lineTotals: lines.map((l) => l.line_total_minor),
    adjustments: adjustments.map((a) => a.amount_minor),
    charges: visitChargeRules(visit),
  });
  return {
    lines,
    pending_lines: all.filter((l) => l.status === 'submitted'),
    excluded_lines: all.filter((l) => l.status === 'rejected' || l.status === 'cancelled'),
    unserved_lines: all.filter((l) => ACTIVE_UNSERVED.includes(l.status)),
    adjustments,
    adjustment_rows: adjustmentRows,
    math,
    has_content: lines.length > 0 || adjustments.length > 0,
  };
}

/**
 * Does the frozen revision still describe what the table actually has?
 * After finalize no new order or adjustment can be added, but a line can
 * still be cancelled; then the revision overstates the amount due and must be
 * finalized again before anyone takes payment for it.
 */
export function revisionMatchesRunning(rev: RevisionRow, running: RunningBill): boolean {
  if (rev.total_minor !== running.math.total_minor) return false;
  const frozen = parseJson<BillLineDTO[]>(rev.lines_json, []).map((l) => `${l.line_id}:${l.line_total_minor}`).sort();
  const live = running.lines.map((l) => `${l.line_id}:${l.line_total_minor}`).sort();
  return frozen.length === live.length && frozen.every((v, i) => v === live[i]);
}

export function revisionDTO(r: RevisionRow): BillRevisionDTO {
  const adjustments = parseJson<AdjustmentSummary[]>(r.adjustments_json, []);
  return {
    id: r.id,
    revision_no: r.revision_no,
    status: r.status,
    lines: parseJson<BillLineDTO[]>(r.lines_json, []),
    subtotal_minor: r.subtotal_minor,
    adjustments,
    adjustments_minor: r.adjustments_minor,
    charges: parseJson<ChargeLine[]>(r.charges_json, []),
    total_minor: r.total_minor,
    finalized_at: r.finalized_at,
    finalized_by: staffName(r.finalized_by),
    superseded_at: r.superseded_at,
    supersede_reason: r.supersede_reason,
  };
}

type StaffAdjustmentDTO = NonNullable<StaffBillDTO['adjustments']>[number];

function adjustmentDTO(a: AdjustmentRow): StaffAdjustmentDTO {
  return {
    id: a.id,
    kind: a.kind,
    amount_minor: a.amount_minor,
    reason: a.reason,
    order_line_id: a.order_line_id,
    created_at: a.created_at,
    created_by: staffName(a.created_by),
    voided_at: a.voided_at,
    voided_by: staffName(a.voided_by),
    void_reason: a.void_reason,
  };
}

function staffName(id: string | null): string | null {
  if (!id) return null;
  return one<{ display_name: string }>('SELECT display_name FROM staff_users WHERE id = ?', [id])?.display_name ?? null;
}

// ------------------------------------------------------------------ presentation
interface BillSnapshot {
  visit: VisitRow;
  bill: BillRow | undefined;
  current: RevisionRow | undefined;
  running: RunningBill;
  money: RevisionPayments;
}

function snapshot(visitId: string, create: boolean): BillSnapshot {
  const visit = requireVisit(visitId);
  const bill = create ? ensureBill(visitId) : getBill(visitId);
  const current = currentRevision(bill);
  return { visit, bill, current, running: runningBill(visit), money: revisionPayments(current) };
}

/**
 * The guest-facing bill. While a payable or settled revision exists the
 * guest sees exactly that immutable revision; otherwise the running view.
 */
function presentBill(s: BillSnapshot): GuestBillDTO {
  const table = getTable(s.visit.table_id);
  const base = {
    visit_status: s.visit.status,
    bill_status: s.bill?.status ?? 'open',
    table_label: table?.label ?? '',
    pending_lines: s.running.pending_lines,
    // A settled revision whose settlement was refunded after checkout is history, not "paid".
    paid: s.bill?.status === 'settled' && s.money.paid,
    bill_requested_at: s.visit.bill_requested_at,
    checkout_complete: s.visit.status === 'closed',
  } satisfies Partial<GuestBillDTO>;
  if (s.current) {
    return {
      ...base,
      lines: parseJson<BillLineDTO[]>(s.current.lines_json, []),
      excluded_lines: parseJson<BillLineDTO[]>(s.current.excluded_json, []),
      subtotal_minor: s.current.subtotal_minor,
      adjustments_minor: s.current.adjustments_minor,
      charges: parseJson<ChargeLine[]>(s.current.charges_json, []),
      total_minor: s.current.total_minor,
      revision_no: s.current.revision_no,
    };
  }
  return {
    ...base,
    lines: s.running.lines,
    excluded_lines: s.running.excluded_lines,
    subtotal_minor: s.running.math.subtotal_minor,
    adjustments_minor: s.running.math.adjustments_minor,
    charges: s.running.math.charges,
    total_minor: s.running.math.total_minor,
    revision_no: null,
  };
}

export function guestBill(visitId: string): GuestBillDTO {
  return presentBill(snapshot(visitId, false));
}

export function staffBill(visitId: string, staff: StaffContext): StaffBillDTO {
  const s = snapshot(visitId, true);
  const bill = s.bill!;
  const state = checkoutState(s.visit);
  const revisions = visitRevisions(visitId);
  return {
    ...presentBill(s),
    visit_id: s.visit.id,
    bill_id: bill.id,
    bill_version: bill.version,
    visit_version: s.visit.version,
    current_revision: s.current ? revisionDTO(s.current) : null,
    revisions: revisions.map(revisionDTO),
    payments: visitPayments(visitId, staff.can('payments.view')),
    unresolved: {
      submitted_lines: s.running.pending_lines.length,
      unserved_lines: s.running.unserved_lines.length,
      open_requests: openRequestCount(visitId),
      open_portion_requests: openPortionCount(visitId),
    },
    payment_methods: getSettings().payment_methods.filter((m) => m.enabled),
    can_checkout: s.visit.status !== 'closed' && state.blocking.length === 0,
    checkout_blockers: [...state.blocking, ...state.informational],
    running_total_minor: s.running.math.total_minor,
    revision_stale: s.current?.status === 'payable' ? !revisionMatchesRunning(s.current, s.running) : false,
    payment_state: s.bill?.status === 'settled' ? s.money.state : s.money.state === 'reversed' ? 'reversed' : 'none',
    refund: s.money.refund,
    adjustments: s.running.adjustment_rows.map((a) => adjustmentDTO(a)),
    voided_adjustments: voidedAdjustments(visitId).map((a) => adjustmentDTO(a)),
  };
}

// ------------------------------------------------------------------ helpers for mutations
function today(): string {
  return businessDate(Date.now(), cutoffHour());
}

/** Bump the bill version (and status/revision when given); the bill row was read in this tx. */
function touchBill(bill: BillRow, patch: { status?: BillStatus; current_revision_id?: string | null } = {}): number {
  if (!updateVersioned('bills', bill.id, bill.version, { ...patch, updated_at: nowIso() })) staleVersion();
  return bill.version + 1;
}

function emitBill(visit: VisitRow, billId: string, version: number, payload: Record<string, unknown>): void {
  emit('bill.updated', { audience: 'all', visit_id: visit.id, entity: { type: 'bill', id: billId, version }, payload });
}

function emitVisitAndTable(visit: VisitRow, version: number, status: VisitRow['status']): void {
  emit('visit.updated', { audience: 'all', visit_id: visit.id, entity: { type: 'visit', id: visit.id, version }, payload: { status } });
  emit('table.updated', { audience: 'staff', visit_id: visit.id, entity: { type: 'table', id: visit.table_id }, payload: { visit_status: status } });
}

/** Supersede a payable revision (keeps it as history). */
export function supersedeRevision(rev: RevisionRow, reason: string, staff: StaffContext): void {
  const r = run(
    `UPDATE bill_revisions SET status = 'superseded', superseded_at = :at, superseded_by = :by, supersede_reason = :reason
      WHERE id = :id AND status = 'payable'`,
    { id: rev.id, at: nowIso(), by: staff.user.id, reason },
  );
  if (r.changes !== 1) throw new AppError('bill_changed', 'The bill changed on another device.');
  // A finalized total a report may already have counted is no longer in force.
  touchReportData(rev.business_date);
}

// ------------------------------------------------------------------ start checkout
/** Visit open -> billing. New guest and staff orders are then refused by guards.orderingBlock. */
export function startBilling(visitId: string, version: number, staff: StaffContext): StaffBillDTO {
  const visit = requireVisit(visitId);
  assertVisitNotClosed(visit);
  // A second device pressing "Start checkout" just sees the billing state.
  if (visit.status === 'billing') return staffBill(visitId, staff);
  if (visit.version !== version) staleVersion(staffBill(visitId, staff));
  const now = nowIso();
  if (!updateVersioned('visits', visit.id, version, {
    status: 'billing', billing_started_at: now, billing_started_by: staff.user.id, updated_at: now,
  })) staleVersion(staffBill(visitId, staff));
  ensureBill(visit.id);
  audit(staff.actor, 'visit.billing_start', { type: 'visit', id: visit.id, visit_id: visit.id }, {
    before: { status: visit.status }, after: { status: 'billing' },
  });
  emitVisitAndTable(visit, version + 1, 'billing');
  return staffBill(visitId, staff);
}

// ------------------------------------------------------------------ finalize
export function finalizeBill(visitId: string, input: z.infer<typeof FinalizeBillBody>, staff: StaffContext): StaffBillDTO {
  const visit = requireVisit(visitId);
  assertVisitNotClosed(visit);
  if (visit.status !== 'billing') {
    throw new AppError('invalid_transition', 'Start checkout before finalizing the bill.', { visit_status: visit.status });
  }
  const bill = ensureBill(visit.id);
  if (bill.version !== input.bill_version) staleVersion(staffBill(visitId, staff));
  const existing = bill.current_revision_id ? getRevision(bill.current_revision_id) : undefined;
  if (existing?.status === 'settled') {
    throw new AppError('already_settled', 'This bill is already paid. Reverse the payment before changing it.', { bill: staffBill(visitId, staff) });
  }
  const running = runningBill(visit);
  if (running.pending_lines.length > 0) {
    throw new AppError('unresolved_orders', 'Accept or reject the waiting items before finalizing the bill.', {
      lines: running.pending_lines,
    });
  }
  if (running.math.total_minor !== input.expected_total_minor) {
    throw new AppError('bill_changed', 'The bill changed while you were reviewing it. Check the new total.', {
      expected_total_minor: input.expected_total_minor,
      total_minor: running.math.total_minor,
      bill: staffBill(visitId, staff),
    });
  }

  // Only one payable revision may exist (partial UNIQUE index): retire the old one first.
  if (existing?.status === 'payable') supersedeRevision(existing, 'refinalized', staff);

  const now = nowIso();
  const revisionNo = (one<{ n: number | null }>('SELECT MAX(revision_no) AS n FROM bill_revisions WHERE bill_id = ?', [bill.id])?.n ?? 0) + 1;
  const revisionId = newId('rev');
  insert('bill_revisions', {
    id: revisionId,
    bill_id: bill.id,
    visit_id: visit.id,
    revision_no: revisionNo,
    status: 'payable',
    lines_json: JSON.stringify(running.lines),
    excluded_json: JSON.stringify(running.excluded_lines),
    adjustments_json: JSON.stringify(running.adjustments),
    subtotal_minor: running.math.subtotal_minor,
    adjustments_minor: running.math.adjustments_minor,
    charges_json: JSON.stringify(running.math.charges),
    total_minor: running.math.total_minor,
    finalized_at: now,
    finalized_by: staff.user.id,
    business_date: today(),
    is_fixture: visit.is_fixture,
  });
  const billVersion = touchBill(bill, { status: 'finalized', current_revision_id: revisionId });
  audit(staff.actor, 'bill.finalize', { type: 'bill', id: bill.id, visit_id: visit.id }, {
    before: existing ? { revision_no: existing.revision_no, total_minor: existing.total_minor } : undefined,
    after: { revision_no: revisionNo, total_minor: running.math.total_minor, lines: running.lines.length },
  });
  emitBill(visit, bill.id, billVersion, { status: 'finalized', revision_no: revisionNo });
  return staffBill(visitId, staff);
}

// ------------------------------------------------------------------ reopen
/** Manager action: supersede the payable revision and let the table order again. */
export function reopenBilling(visitId: string, input: { version: number; reason: string }, staff: StaffContext): StaffBillDTO {
  const visit = requireVisit(visitId);
  assertVisitNotClosed(visit);
  if (visit.version !== input.version) staleVersion(staffBill(visitId, staff));
  const bill = ensureBill(visit.id);
  const current = bill.current_revision_id ? getRevision(bill.current_revision_id) : undefined;
  if (current?.status === 'settled') {
    throw new AppError('already_settled', 'This bill is already paid. Reverse the payment before reopening.', { bill: staffBill(visitId, staff) });
  }
  if (visit.status === 'open' && current?.status !== 'payable') {
    throw new AppError('invalid_transition', 'This table is already ordering.', { visit_status: visit.status });
  }
  if (current?.status === 'payable') supersedeRevision(current, input.reason, staff);
  const billVersion = touchBill(bill, { status: 'open', current_revision_id: null });

  let visitVersion = visit.version;
  if (visit.status === 'billing') {
    if (!updateVersioned('visits', visit.id, visit.version, {
      status: 'open', billing_started_at: null, billing_started_by: null, updated_at: nowIso(),
    })) staleVersion(staffBill(visitId, staff));
    visitVersion += 1;
  }
  audit(staff.actor, 'bill.reopen', { type: 'bill', id: bill.id, visit_id: visit.id }, {
    reason: input.reason,
    before: { visit_status: visit.status, bill_status: bill.status, revision_no: current?.revision_no ?? null },
    after: { visit_status: 'open', bill_status: 'open' },
  });
  emitBill(visit, bill.id, billVersion, { status: 'open', reopened: true });
  emitVisitAndTable(visit, visitVersion, 'open');
  return staffBill(visitId, staff);
}

// ------------------------------------------------------------------ adjustments
/** Sanity bound for one adjustment (1,000,000 THB): stops typos and keeps totals safe integers. */
export const MAX_ADJUSTMENT_MINOR = 100_000_000;

/** What an adjustment request asks for; a replayed key must ask for the same thing. */
function adjustmentHash(visitId: string, input: z.infer<typeof AdjustmentBody>): string {
  return payloadHash({
    visit: visitId, kind: input.kind, amount: input.amount_minor, reason: input.reason, line: input.order_line_id ?? null,
  });
}

/** Adjustments are refused once a revision is payable (reopen first) or settled (reverse first). */
function assertBillAdjustable(visitId: string, bill: BillRow, staff: StaffContext, what: string): void {
  const current = currentRevision(bill);
  if (current?.status === 'settled') {
    throw new AppError('already_settled', `This bill is already paid. Reverse the payment before ${what}.`, { bill: staffBill(visitId, staff) });
  }
  if (current?.status === 'payable') {
    throw new AppError('bill_changed', `The bill is finalized. Reopen it before ${what}.`, { bill: staffBill(visitId, staff) });
  }
}

/**
 * Add a discount, comp or correction (manager). Retry-safe: the same
 * idempotency key with the same details returns the bill as it is now, and
 * `bill_version` (the bill the manager was looking at) must still be current,
 * so a second device or a resent request cannot apply one discount twice.
 */
export function addAdjustment(visitId: string, input: z.infer<typeof AdjustmentBody>, staff: StaffContext): StaffBillDTO {
  const hash = adjustmentHash(visitId, input);
  if (input.idempotency_key) {
    const prior = one<AdjustmentRow>('SELECT * FROM bill_adjustments WHERE idempotency_key = ?', [input.idempotency_key]);
    if (prior) {
      if (prior.visit_id !== visitId || prior.payload_hash !== hash) {
        throw new AppError('idempotency_mismatch', 'This adjustment attempt was already used for something else.');
      }
      return staffBill(visitId, staff);
    }
  }
  const visit = requireVisit(visitId);
  assertVisitNotClosed(visit);
  const bill = ensureBill(visit.id);
  assertBillAdjustable(visitId, bill, staff, 'adjusting it');
  if (input.bill_version !== undefined && input.bill_version !== bill.version) staleVersion(staffBill(visitId, staff));
  if (input.order_line_id) {
    const line = one<{ visit_id: string; status: LineStatus }>('SELECT visit_id, status FROM order_lines WHERE id = ?', [input.order_line_id]);
    if (!line || line.visit_id !== visit.id) throw new AppError('not_found', 'That item is not on this bill.');
    // A comp for a dish that is not on the bill (waiting, rejected, cancelled) would reduce everything else.
    if (!isChargeable(line.status)) {
      throw new AppError('invalid_transition', 'That dish is not on the bill, so it cannot be adjusted.', { line_id: input.order_line_id, status: line.status });
    }
  }
  if (Math.abs(input.amount_minor) > MAX_ADJUSTMENT_MINOR) {
    throw new AppError('validation_failed', 'That adjustment is larger than any bill this restaurant would issue.', {
      issues: [{ path: 'amount_minor', message: `at most ${MAX_ADJUSTMENT_MINOR} satang`, code: 'too_big' }],
    });
  }
  const running = runningBill(visit);
  const base = running.math.subtotal_minor + running.math.adjustments_minor + input.amount_minor;
  if (!Number.isSafeInteger(base) || base > MAX_ADJUSTMENT_MINOR * 10) {
    throw new AppError('validation_failed', 'The adjusted bill would be implausibly large.', {
      issues: [{ path: 'amount_minor', message: 'bill total out of range', code: 'too_big' }],
    });
  }
  if (base < 0) {
    throw new AppError('validation_failed', 'An adjustment cannot take the bill below zero.', {
      issues: [{ path: 'amount_minor', message: 'exceeds the bill', code: 'too_small' }],
      max_reduction_minor: running.math.subtotal_minor + running.math.adjustments_minor,
    });
  }
  const id = newId('adj');
  const now = nowIso();
  insert('bill_adjustments', {
    id,
    visit_id: visit.id,
    kind: input.kind,
    amount_minor: input.amount_minor,
    reason: input.reason,
    order_line_id: input.order_line_id ?? null,
    created_by: staff.user.id,
    created_at: now,
    idempotency_key: input.idempotency_key ?? null,
    payload_hash: hash,
  });
  const billVersion = touchBill(bill);
  // A late discount can change a period that was already reported.
  touchReportData(today());
  if (visit.seated_business_date !== today()) touchReportData(visit.seated_business_date);
  audit(staff.actor, 'bill.adjust', { type: 'bill_adjustment', id, visit_id: visit.id }, {
    reason: input.reason,
    after: { kind: input.kind, amount_minor: input.amount_minor as Minor, order_line_id: input.order_line_id ?? null },
  });
  emitBill(visit, bill.id, billVersion, { adjusted: true });
  return staffBill(visitId, staff);
}

/** Mark one adjustment voided (the row stays; revisions already finalized keep their copy). */
function markVoided(adj: AdjustmentRow, reason: string, byUserId: string | null, actor: Actor): boolean {
  const r = run(
    `UPDATE bill_adjustments SET voided_at = :at, voided_by = :by, void_reason = :reason
      WHERE id = :id AND voided_at IS NULL`,
    { id: adj.id, at: nowIso(), by: byUserId, reason },
  );
  if (r.changes !== 1) return false;
  audit(actor, 'bill.adjust_void', { type: 'bill_adjustment', id: adj.id, visit_id: adj.visit_id }, {
    reason,
    before: { kind: adj.kind, amount_minor: adj.amount_minor, order_line_id: adj.order_line_id },
    after: { voided: true },
  });
  return true;
}

/**
 * Manager action: void an adjustment entered in error. Allowed while the
 * bill is open (like adding one); `bill_version` must be current. Voiding an
 * adjustment that is already voided returns the bill unchanged.
 */
export function voidAdjustment(visitId: string, adjustmentId: string, input: z.infer<typeof VoidAdjustmentBody>, staff: StaffContext): StaffBillDTO {
  const visit = requireVisit(visitId);
  const adj = one<AdjustmentRow>('SELECT * FROM bill_adjustments WHERE id = ? AND visit_id = ?', [adjustmentId, visit.id]);
  if (!adj) throw new AppError('not_found', 'That adjustment is not on this bill.');
  if (adj.voided_at) return staffBill(visitId, staff);
  assertVisitNotClosed(visit);
  const bill = ensureBill(visit.id);
  assertBillAdjustable(visitId, bill, staff, 'voiding an adjustment');
  if (input.bill_version !== bill.version) staleVersion(staffBill(visitId, staff));
  markVoided(adj, input.reason, staff.user.id, staff.actor);
  const billVersion = touchBill(bill);
  touchReportData(today());
  if (visit.seated_business_date !== today()) touchReportData(visit.seated_business_date);
  emitBill(visit, bill.id, billVersion, { adjusted: true, voided: adj.id });
  return staffBill(visitId, staff);
}

/**
 * Dishes left the bill (rejected or cancelled): every adjustment linked to
 * them is voided in the same transaction, so a comp can never reduce what the
 * rest of the table owes. Returns how many adjustments were voided.
 */
export function voidLineAdjustments(lineIds: string[], reason: string, staff: StaffContext | null): number {
  if (lineIds.length === 0) return 0;
  const rows = many<AdjustmentRow>(
    `SELECT * FROM bill_adjustments WHERE voided_at IS NULL
        AND order_line_id IN (SELECT value FROM json_each(:ids)) ORDER BY visit_id, created_at, id`,
    { ids: lineIds },
  );
  let voided = 0;
  const visits = new Set<string>();
  for (const adj of rows) {
    if (markVoided(adj, reason, staff?.user.id ?? null, staff?.actor ?? SYSTEM)) {
      voided++;
      visits.add(adj.visit_id);
    }
  }
  for (const visitId of visits) {
    const visit = getVisit(visitId);
    const bill = getBill(visitId);
    if (!visit || !bill) continue;
    const billVersion = touchBill(bill);
    touchReportData(today());
    if (visit.seated_business_date !== today()) touchReportData(visit.seated_business_date);
    emitBill(visit, bill.id, billVersion, { adjusted: true, voided_for_line: true });
  }
  return voided;
}
