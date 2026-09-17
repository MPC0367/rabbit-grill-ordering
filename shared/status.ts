// State machines. Guest and staff screens both derive their wording from
// these internal states; neither invents its own meaning (brief 06, 14, 35).

// ---------------------------------------------------------------- order lines
export const LINE_STATUSES = ['submitted', 'accepted', 'preparing', 'almost_done', 'ready', 'served', 'rejected', 'cancelled'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

/** The forward journey, in order. `almost_done` is optional. */
export const FORWARD: readonly LineStatus[] = ['submitted', 'accepted', 'preparing', 'almost_done', 'ready', 'served'];
export const TERMINAL: readonly LineStatus[] = ['served', 'rejected', 'cancelled'];
export const ACTIVE_UNSERVED: readonly LineStatus[] = ['submitted', 'accepted', 'preparing', 'almost_done', 'ready'];

export type TransitionKind = 'forward' | 'reject' | 'cancel' | 'correction';

/** Normal staff transitions. Preparing may skip Almost done. */
export const FORWARD_TRANSITIONS: Record<LineStatus, readonly LineStatus[]> = {
  submitted: ['accepted'],
  accepted: ['preparing'],
  preparing: ['almost_done', 'ready'],
  almost_done: ['ready'],
  ready: ['served'],
  served: [],
  rejected: [],
  cancelled: [],
};

/** Exception transitions (always need a reason). */
export const EXCEPTION_TRANSITIONS: Record<LineStatus, ReadonlyArray<{ to: LineStatus; kind: TransitionKind }>> = {
  submitted: [{ to: 'rejected', kind: 'reject' }],
  accepted: [{ to: 'cancelled', kind: 'cancel' }, { to: 'submitted', kind: 'correction' }],
  preparing: [{ to: 'cancelled', kind: 'cancel' }, { to: 'accepted', kind: 'correction' }],
  almost_done: [{ to: 'cancelled', kind: 'cancel' }, { to: 'preparing', kind: 'correction' }],
  ready: [{ to: 'cancelled', kind: 'cancel' }, { to: 'preparing', kind: 'correction' }],
  served: [{ to: 'ready', kind: 'correction' }],
  rejected: [],
  cancelled: [],
};

export function transitionKind(from: LineStatus, to: LineStatus): TransitionKind | null {
  if (FORWARD_TRANSITIONS[from].includes(to)) return 'forward';
  return EXCEPTION_TRANSITIONS[from].find((t) => t.to === to)?.kind ?? null;
}

/** The single "next" action shown on a staff ticket. */
export function nextForward(status: LineStatus): LineStatus | null {
  switch (status) {
    case 'submitted': return 'accepted';
    case 'accepted': return 'preparing';
    case 'preparing': return 'ready'; // Almost done is offered as a secondary action
    case 'almost_done': return 'ready';
    case 'ready': return 'served';
    default: return null;
  }
}

export function forwardIndex(status: LineStatus): number {
  return FORWARD.indexOf(status);
}

export function isActive(status: LineStatus): boolean {
  return status !== 'rejected' && status !== 'cancelled';
}

/** Lines that count on the bill: accepted (or later) and not rejected/cancelled. */
export function isChargeable(status: LineStatus): boolean {
  return status === 'accepted' || status === 'preparing' || status === 'almost_done' || status === 'ready' || status === 'served';
}

// ---------------------------------------------------------------- orders (derived)
export const ORDER_STATUSES = ['received', 'confirmed', 'preparing', 'almost_done', 'ready', 'partially_served', 'served', 'rejected', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface LineCounts {
  submitted: number; accepted: number; preparing: number; almost_done: number;
  ready: number; served: number; rejected: number; cancelled: number;
  active: number; total: number;
}

export function countLines(lines: ReadonlyArray<{ status: LineStatus; quantity?: number }>, byQuantity = false): LineCounts {
  const c: LineCounts = { submitted: 0, accepted: 0, preparing: 0, almost_done: 0, ready: 0, served: 0, rejected: 0, cancelled: 0, active: 0, total: 0 };
  for (const l of lines) {
    const n = byQuantity ? (l.quantity ?? 1) : 1;
    c[l.status] += n;
    c.total += n;
    if (isActive(l.status)) c.active += n;
  }
  return c;
}

/**
 * Aggregate order state from its lines. The order is only as far along as its
 * least advanced active line; one ready drink never makes the order ready.
 */
export function deriveOrderStatus(lines: ReadonlyArray<{ status: LineStatus }>): OrderStatus {
  const active = lines.filter((l) => isActive(l.status));
  if (active.length === 0) {
    return lines.length > 0 && lines.every((l) => l.status === 'rejected') ? 'rejected' : 'cancelled';
  }
  const served = active.filter((l) => l.status === 'served').length;
  if (served === active.length) return 'served';
  const unserved = active.filter((l) => l.status !== 'served');
  const min = Math.min(...unserved.map((l) => forwardIndex(l.status)));
  if (served > 0) return 'partially_served';
  switch (FORWARD[min]) {
    case 'submitted': return 'received';
    case 'accepted': return 'confirmed';
    case 'preparing': return 'preparing';
    case 'almost_done': return 'almost_done';
    default: return 'ready';
  }
}

// ---------------------------------------------------------------- visits and tables
export const VISIT_STATUSES = ['open', 'billing', 'closed'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const TABLE_STATES = ['available', 'dining', 'checking_out', 'disabled'] as const;
export type TableState = (typeof TABLE_STATES)[number];

export function deriveTableState(enabled: boolean, activeVisitStatus: VisitStatus | null): TableState {
  if (activeVisitStatus === 'billing') return 'checking_out';
  if (activeVisitStatus === 'open') return 'dining';
  return enabled ? 'available' : 'disabled';
}

// ---------------------------------------------------------------- bills and payments
export const BILL_STATUSES = ['open', 'finalized', 'settled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const REVISION_STATUSES = ['payable', 'superseded', 'settled'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const PAYMENT_STATUSES = ['confirmed', 'reversed', 'failed', 'claimed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_KINDS = ['settlement', 'reversal', 'refund_record'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

// ---------------------------------------------------------------- service requests
export const SERVICE_STATUSES = ['sent', 'acknowledged', 'completed', 'cancelled'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const SERVICE_TYPES = ['call_staff', 'water', 'utensils', 'bill', 'order_change', 'allergy_help'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  sent: ['acknowledged', 'completed', 'cancelled'],
  acknowledged: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// ---------------------------------------------------------------- measured-weight portions
export const PORTION_REQUEST_STATUSES = ['requested', 'quoted', 'confirmed', 'declined', 'cancelled', 'expired'] as const;
export type PortionRequestStatus = (typeof PORTION_REQUEST_STATUSES)[number];

export const QUOTE_STATUSES = ['active', 'superseded', 'confirmed', 'expired', 'withdrawn'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

// ---------------------------------------------------------------- catalog
export const ITEM_STATUSES = ['draft', 'published', 'archived'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const REVIEW_STATUSES = ['unverified', 'needs_review', 'verified'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const PRICING_TYPES = ['fixed', 'variant', 'measured_weight'] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

export const STATIONS = ['kitchen', 'bar'] as const;
export type Station = (typeof STATIONS)[number];

// ---------------------------------------------------------------- report jobs
export const JOB_STATUSES = ['queued', 'generating', 'ready', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const REPORT_LABELS = ['provisional', 'final', 'revised'] as const;
export type ReportLabel = (typeof REPORT_LABELS)[number];

// ---------------------------------------------------------------- guest-facing wording keys
/**
 * i18n key for the guest timeline title of a line/order state. Drinks and
 * desserts (station "bar" or category dessert) say "preparing", not "cooking".
 */
export function guestStepKey(status: LineStatus | OrderStatus, kind: 'cook' | 'prepare' = 'cook'): string {
  switch (status) {
    case 'submitted':
    case 'received': return 'track.step.received';
    case 'accepted':
    case 'confirmed': return 'track.step.confirmed';
    case 'preparing': return kind === 'cook' ? 'track.step.cooking' : 'track.step.preparing';
    case 'almost_done': return 'track.step.almostDone';
    case 'ready': return 'track.step.ready';
    case 'partially_served': return 'track.step.partiallyServed';
    case 'served': return 'track.step.served';
    case 'rejected': return 'track.step.rejected';
    case 'cancelled': return 'track.step.cancelled';
  }
}
