// In-memory fixture records and the functions that write them. History and
// live fixtures both build these plain objects and hand them to the writers,
// so every fixture row follows the same invariants as the real code paths:
// snapshots on order lines, one line_events row per transition, business
// dates stamped from the event time, is_fixture = 1 everywhere it exists.
import type { BillLineDTO } from '../../../shared/dto.ts';
import type { LineStatus, ServiceStatus, ServiceType } from '../../../shared/status.ts';
import { lineTotal } from '../../../shared/money.ts';
import { payloadHash, sha256 } from '../../lib/http.ts';
import type { ModelItem, ModelVariant } from './menu-model.ts';
import type { SeedStaff, StaffByRole } from './staff.ts';
import type { SeedTable } from './tables.ts';
import { iso, REF_ALPHABET, type Rng, type Writer } from './util.ts';

export interface SeedCtx {
  w: Writer;
  staff: StaffByRole;
  /** Business date (Bangkok, configured cutoff) of an instant. */
  bdate: (ms: number) => string;
  /** Order references already used (UNIQUE). */
  refs: Set<string>;
}

export interface ActorRef {
  type: 'staff' | 'guest' | 'system';
  id: string | null;
  label: string | null;
}

export const staffActor = (s: SeedStaff): ActorRef => ({ type: 'staff', id: s.id, label: s.display_name });
export const guestActor = (g: SimGuest): ActorRef => ({ type: 'guest', id: g.id, label: `Guest ${g.guest_no}` });

// ------------------------------------------------------------------ records
export interface SimVisit {
  id: string;
  table: SeedTable | null; // assigned before writing
  status: 'open' | 'billing' | 'closed';
  seated: number;
  covers: number | null;
  opened_by: string;
  join_pin: string | null;
  bill_requested_at: number | null;
  billing_started_at: number | null;
  billing_started_by: string | null;
  closed_at: number | null;
  closed_by: string | null;
  close_exception: string | null;
  version: number;
}

export interface SimGuest {
  id: string;
  visit_id: string;
  guest_no: number;
  joined: number;
  last_seen: number;
  locale: 'th' | 'en';
  /** Pseudonymous analytics session attributed to this browser, if instrumented. */
  analytics_id: string | null;
}

export interface Step {
  status: LineStatus;
  at: number;
  kind: 'forward' | 'reject' | 'cancel';
  actor: ActorRef;
  reason: string | null;
}

export interface SimLine {
  id: string;
  line_no: number;
  item: ModelItem;
  variant: ModelVariant | null;
  /** null = no beans choice; false = house beans; true = special blend. */
  blend: boolean | null;
  quantity: number;
  unit_price_minor: number;
  modifiers_minor: number;
  line_total_minor: number;
  measured: { grams: number; rate_minor: number; basis: number; quote_id: string } | null;
  note: string | null;
  allergy: boolean;
  steps: Step[];
}

export type OrderSource = 'guest' | 'staff' | 'portion_quote';

export interface SimOrder {
  id: string;
  reference: string;
  visit: SimVisit;
  round_no: number; // assigned once all rounds of the visit are known
  source: OrderSource;
  guest: SimGuest | null;
  staff_id: string | null;
  key: string;
  locale: 'th' | 'en';
  at: number;
  lines: SimLine[];
  /** Duplicate submission rejected as a whole (never gets cart events). */
  duplicate: boolean;
}

export interface SimService {
  id: string;
  visit: SimVisit;
  type: ServiceType;
  status: ServiceStatus;
  guest: SimGuest | null;
  created_by_staff: string | null;
  created: number;
  /** `by` is the staff display label, as the service module stores it. */
  ack: { at: number; by: string } | null;
  done: { at: number; by: string } | null;
  cancelled: { at: number; by: string } | null;
  close_reason: string | null;
  key: string;
}

export interface SimQuote {
  id: string;
  revision: number;
  grams: number;
  rate_minor: number;
  basis: number;
  amount_minor: number;
  note: string | null;
  created: number;
  expires: number;
  status: 'active' | 'superseded' | 'confirmed' | 'expired' | 'withdrawn';
  created_by: string;
  confirmed: { at: number; via: 'guest' | 'in_person'; guest_id: string | null; staff_id: string | null; key: string } | null;
  order_line_id: string | null;
}

export interface SimPortion {
  id: string;
  visit: SimVisit;
  item: ModelItem;
  guest: SimGuest | null;
  created_by_staff: string | null;
  preferred_grams: number | null;
  status: 'requested' | 'quoted' | 'confirmed' | 'declined' | 'cancelled' | 'expired';
  created: number;
  /** `by` is the actor label ("Guest 2" or a staff display name), as the portions module stores it. */
  resolved: { at: number; by: string | null; reason: string | null } | null;
  quotes: SimQuote[];
  key: string;
  version: number;
}

export interface SimAdjustment {
  id: string;
  kind: 'discount' | 'comp' | 'correction';
  amount_minor: number;
  reason: string;
  line_id: string | null;
  by: string;
  at: number;
}

export interface SimRevision {
  id: string;
  revision_no: number;
  status: 'payable' | 'superseded' | 'settled';
  finalized: number;
  finalized_by: string;
  superseded: { at: number; by: string; reason: string } | null;
  /** Lines and adjustments as they stood at finalization. */
  lines: SimLine[];
  orders: Map<string, SimOrder>; // line id -> order (for references)
  adjustments: SimAdjustment[];
}

export interface SimPayment {
  id: string;
  revision_id: string;
  amount_minor: number;
  tendered_minor: number;
  change_minor: number;
  by: string;
  at: number;
  key: string;
}

// ------------------------------------------------------------------ builders
export function newReference(ctx: SeedCtx, r: Rng): string {
  for (;;) {
    const ref = `RG-${r.chars(4, REF_ALPHABET)}`;
    if (!ctx.refs.has(ref)) {
      ctx.refs.add(ref);
      return ref;
    }
  }
}

/** A priced line for a fixed / variant item (the same arithmetic as priceCart). */
export function pricedLine(r: Rng, item: ModelItem, opts: {
  line_no: number; quantity: number; variant: ModelVariant | null; blend: boolean | null;
  note: string | null; allergy: boolean; submitted: Step;
}): SimLine {
  const unit = item.pricing_type === 'variant' ? (opts.variant?.price_minor ?? 0) : (item.price_minor ?? 0);
  const mods = opts.blend === true && item.beans ? item.beans.blend.price_delta_minor : 0;
  return {
    id: r.id('oln'), line_no: opts.line_no, item, variant: opts.variant, blend: item.beans ? opts.blend : null,
    quantity: opts.quantity, unit_price_minor: unit, modifiers_minor: mods,
    line_total_minor: lineTotal(unit, mods, opts.quantity),
    measured: null, note: opts.note, allergy: opts.allergy, steps: [opts.submitted],
  };
}

/** The single order line a confirmed portion quote creates (quantity 1, measured grams). */
export function portionLine(r: Rng, item: ModelItem, quote: SimQuote, submitted: Step): SimLine {
  return {
    id: r.id('oln'), line_no: 1, item, variant: null, blend: null, quantity: 1,
    unit_price_minor: quote.amount_minor, modifiers_minor: 0, line_total_minor: quote.amount_minor,
    measured: { grams: quote.grams, rate_minor: quote.rate_minor, basis: quote.basis, quote_id: quote.id },
    note: null, allergy: false, steps: [submitted],
  };
}

export function finalStatus(line: SimLine): LineStatus {
  return line.steps[line.steps.length - 1].status;
}

export function isChargeableStatus(s: LineStatus): boolean {
  return s === 'accepted' || s === 'preparing' || s === 'almost_done' || s === 'ready' || s === 'served';
}

/** Time the line reached a terminal state (or its latest step). */
export function lineEnd(line: SimLine): number {
  return line.steps[line.steps.length - 1].at;
}

function modifiersSnapshot(line: SimLine): string {
  const beans = line.item.beans;
  if (line.blend === null || !beans) return '[]';
  const opt = line.blend ? beans.blend : beans.house;
  return JSON.stringify([{
    group: { th: beans.name_th, en: beans.name_en },
    options: [{ name: { th: opt.name_th, en: opt.name_en }, price_minor: line.blend ? opt.price_delta_minor : 0 }],
  }]);
}

function modifierPicks(line: SimLine): Array<{ group_id: string; option_ids: string[] }> {
  const beans = line.item.beans;
  if (line.blend === null || !beans) return [];
  return [{ group_id: beans.group_id, option_ids: [line.blend ? beans.blend.id : beans.house.id] }];
}

// ------------------------------------------------------------------ writers
export function writeVisit(ctx: SeedCtx, v: SimVisit): void {
  if (!v.table) throw new Error('fixture visit has no table');
  ctx.w.put('visits', {
    id: v.id, table_id: v.table.id, status: v.status,
    join_pin: v.join_pin, pin_rotated_at: v.join_pin ? iso(v.seated) : null,
    pin_failures: 0, pin_locked_until: null,
    covers: v.covers, charges_json: '[]',
    seated_at: iso(v.seated), seated_business_date: ctx.bdate(v.seated),
    opened_by: v.opened_by, open_idempotency_key: null,
    bill_requested_at: v.bill_requested_at === null ? null : iso(v.bill_requested_at),
    billing_started_at: v.billing_started_at === null ? null : iso(v.billing_started_at),
    billing_started_by: v.billing_started_by,
    closed_at: v.closed_at === null ? null : iso(v.closed_at),
    closed_by: v.closed_by,
    close_business_date: v.closed_at === null ? null : ctx.bdate(v.closed_at),
    close_idempotency_key: null,
    close_exception: v.close_exception,
    is_fixture: 1,
    created_at: iso(v.seated),
    updated_at: iso(v.closed_at ?? v.billing_started_at ?? v.bill_requested_at ?? v.seated),
    version: v.version,
  });
}

/**
 * Guest browser membership. `tokenHash` is supplied by the caller: live
 * fixtures hash a real random secret nobody holds; closed history visits
 * can use a hash of a fixture string because their sessions are revoked.
 */
export function writeGuest(ctx: SeedCtx, g: SimGuest, tokenHash: string, revoked: { at: number; reason: string } | null): void {
  ctx.w.put('guest_sessions', {
    id: g.id, visit_id: g.visit_id, token_hash: tokenHash, guest_no: g.guest_no,
    created_at: iso(g.joined), last_seen_at: iso(g.last_seen),
    revoked_at: revoked ? iso(revoked.at) : null, revoke_reason: revoked?.reason ?? null,
  });
}

export function fixtureTokenHash(id: string): string {
  return sha256(`fixture-closed-session:${id}`);
}

export function writeOrder(ctx: SeedCtx, o: SimOrder): void {
  const v = o.visit;
  if (!v.table) throw new Error('fixture order has no table');
  let first: number | null = null;
  let last = o.at;
  let finished: Step | null = null;
  const moments = new Set<number>();
  let allTerminal = true;
  for (const l of o.lines) {
    for (const s of l.steps) {
      if (s.status === 'accepted' && (first === null || s.at < first)) first = s.at;
      if (s.at > last) last = s.at;
      if (s !== l.steps[0]) moments.add(s.at);
    }
    const end = l.steps[l.steps.length - 1];
    if (end.status !== 'served' && end.status !== 'rejected' && end.status !== 'cancelled') allTerminal = false;
    else if (!finished || end.at > finished.at) finished = end;
  }
  const subtotal = o.lines.reduce((sum, l) => sum + l.line_total_minor, 0);
  const payload = {
    lines: o.lines.map((l) => ({
      item_id: l.item.id, variant_id: l.variant?.id ?? null, quantity: l.quantity,
      modifiers: modifierPicks(l), note: l.note, portion_quote_id: l.measured?.quote_id ?? null,
    })),
  };
  ctx.w.put('orders', {
    id: o.id, reference: o.reference, visit_id: v.id, table_id: v.table.id, table_label: v.table.label,
    round_no: o.round_no, source: o.source,
    guest_session_id: o.guest?.id ?? null, staff_user_id: o.staff_id,
    analytics_session_id: o.source !== 'staff' ? (o.guest?.analytics_id ?? null) : null,
    idempotency_key: o.key, payload_hash: payloadHash(payload), locale: o.locale,
    submitted_at: iso(o.at), business_date: ctx.bdate(o.at),
    manual_reference: null, manual_original_time: null,
    subtotal_minor: subtotal,
    first_accepted_at: first === null ? null : iso(first),
    finished_at: allTerminal && finished ? iso(finished.at) : null,
    finished_by: allTerminal && finished ? finished.actor.id : null,
    is_fixture: 1, updated_at: iso(last), version: 1 + moments.size,
  });

  for (const l of o.lines) {
    const at: Partial<Record<LineStatus, number>> = {};
    for (const s of l.steps) at[s.status] = s.at;
    const end = l.steps[l.steps.length - 1];
    const stamp = (s: LineStatus) => (at[s] === undefined ? null : iso(at[s]!));
    ctx.w.put('order_lines', {
      id: l.id, order_id: o.id, visit_id: v.id, line_no: l.line_no,
      item_id: l.item.id, variant_id: l.variant?.id ?? null, category_id: l.item.category_id,
      name_th: l.item.name_th, name_en: l.item.name_en,
      variant_name_th: l.variant?.name_th ?? null, variant_name_en: l.variant?.name_en ?? null,
      station: l.item.station, prep_kind: l.item.prep_kind, pricing_type: l.item.pricing_type,
      unit_price_minor: l.unit_price_minor, modifiers_json: modifiersSnapshot(l), modifiers_minor: l.modifiers_minor,
      quantity: l.quantity,
      measured_grams: l.measured?.grams ?? null,
      rate_minor: l.measured?.rate_minor ?? null,
      rate_basis_grams: l.measured?.basis ?? null,
      portion_quote_id: l.measured?.quote_id ?? null,
      line_total_minor: l.line_total_minor,
      note: l.note, allergy_flag: l.allergy,
      alcohol: l.item.alcohol ? 1 : 0,
      requires_staff_confirm: l.item.requires_staff_confirm ? 1 : 0,
      status: end.status,
      status_reason: end.kind === 'forward' ? null : end.reason,
      submitted_at: iso(l.steps[0].at),
      accepted_at: stamp('accepted'), preparing_at: stamp('preparing'), almost_done_at: stamp('almost_done'),
      ready_at: stamp('ready'), served_at: stamp('served'), rejected_at: stamp('rejected'), cancelled_at: stamp('cancelled'),
      prepared_before_entry: 0, is_fixture: 1,
      updated_at: iso(end.at), version: l.steps.length,
    });
    l.steps.forEach((s, i) => {
      ctx.w.put('line_events', {
        line_id: l.id, order_id: o.id, visit_id: v.id,
        from_status: i === 0 ? null : l.steps[i - 1].status, to_status: s.status,
        kind: s.kind, actor_type: s.actor.type, actor_id: s.actor.id, reason: s.reason,
        created_at: iso(s.at),
      });
    });
  }
}

export function writeService(ctx: SeedCtx, s: SimService): void {
  const v = s.visit;
  if (!v.table) throw new Error('fixture request has no table');
  const last = s.cancelled?.at ?? s.done?.at ?? s.ack?.at ?? s.created;
  ctx.w.put('service_requests', {
    id: s.id, visit_id: v.id, table_id: v.table.id, table_label: v.table.label,
    type: s.type, note: null, status: s.status, idempotency_key: s.key,
    guest_session_id: s.guest?.id ?? null, created_by_staff: s.created_by_staff,
    created_at: iso(s.created), business_date: ctx.bdate(s.created),
    acknowledged_at: s.ack ? iso(s.ack.at) : null, acknowledged_by: s.ack?.by ?? null,
    completed_at: s.done ? iso(s.done.at) : null, completed_by: s.done?.by ?? null,
    cancelled_at: s.cancelled ? iso(s.cancelled.at) : null, cancelled_by: s.cancelled?.by ?? null,
    close_reason: s.close_reason, is_fixture: 1,
    updated_at: iso(last), version: 1 + (s.ack ? 1 : 0) + (s.done || s.cancelled ? 1 : 0),
  });
}

export function writePortion(ctx: SeedCtx, p: SimPortion): void {
  const v = p.visit;
  if (!v.table) throw new Error('fixture portion has no table');
  const last = Math.max(p.created, p.resolved?.at ?? 0, ...p.quotes.map((q) => q.confirmed?.at ?? q.created));
  ctx.w.put('portion_requests', {
    id: p.id, visit_id: v.id, table_id: v.table.id, item_id: p.item.id,
    guest_session_id: p.guest?.id ?? null, created_by_staff: p.created_by_staff,
    preferred_grams: p.preferred_grams, note: null, status: p.status,
    idempotency_key: p.key, created_at: iso(p.created), business_date: ctx.bdate(p.created),
    resolved_at: p.resolved ? iso(p.resolved.at) : null,
    resolved_by: p.resolved?.by ?? null,
    resolution_reason: p.resolved?.reason ?? null,
    is_fixture: 1, updated_at: iso(last), version: p.version,
  });
  for (const q of p.quotes) {
    ctx.w.put('portion_quotes', {
      id: q.id, request_id: p.id, revision: q.revision, grams: q.grams,
      rate_minor: q.rate_minor, rate_basis_grams: q.basis, amount_minor: q.amount_minor,
      choices_json: '[]', note: q.note, expires_at: iso(q.expires), status: q.status,
      created_by: q.created_by, created_at: iso(q.created),
      confirmed_at: q.confirmed ? iso(q.confirmed.at) : null,
      confirmed_via: q.confirmed?.via ?? null,
      confirmed_guest_session_id: q.confirmed?.guest_id ?? null,
      confirmed_staff_id: q.confirmed?.staff_id ?? null,
      confirm_idempotency_key: q.confirmed?.key ?? null,
      order_line_id: q.order_line_id,
    });
  }
}

function billLine(l: SimLine, o: SimOrder): BillLineDTO {
  return {
    order_reference: o.reference,
    line_id: l.id,
    name: { th: l.item.name_th, en: l.item.name_en },
    variant_name: l.variant ? { th: l.variant.name_th, en: l.variant.name_en } : null,
    quantity: l.quantity,
    measured_grams: l.measured?.grams ?? null,
    line_total_minor: l.line_total_minor,
    status: statusAt(l, Number.POSITIVE_INFINITY),
  };
}

/** A line's status as of `at` (the last step at or before it). */
export function statusAt(l: SimLine, at: number): LineStatus {
  let status = l.steps[0].status;
  for (const s of l.steps) if (s.at <= at) status = s.status;
  return status;
}

/** Revision totals from its frozen lines + adjustments; charges are none by default (D-07). */
export function revisionTotals(rev: SimRevision): { subtotal: number; adjustments: number; total: number } {
  let subtotal = 0;
  for (const l of rev.lines) if (isChargeableStatus(statusAt(l, rev.finalized))) subtotal += l.line_total_minor;
  const adjustments = rev.adjustments.reduce((s, a) => s + a.amount_minor, 0);
  return { subtotal, adjustments, total: Math.max(0, subtotal + adjustments) };
}

export function writeBill(ctx: SeedCtx, v: SimVisit, bill: { id: string; status: 'open' | 'finalized' | 'settled'; created: number; updated: number; version: number }, revisions: SimRevision[]): void {
  const current = revisions.filter((rv) => rv.status !== 'superseded').at(-1) ?? null;
  ctx.w.put('bills', {
    id: bill.id, visit_id: v.id, status: bill.status, current_revision_id: current?.id ?? null,
    created_at: iso(bill.created), updated_at: iso(bill.updated), version: bill.version,
  });
  for (const rv of revisions) {
    const snapshot = (l: SimLine): BillLineDTO => ({ ...billLine(l, rv.orders.get(l.id)!), status: statusAt(l, rv.finalized) });
    const chargeable = rv.lines.filter((l) => isChargeableStatus(statusAt(l, rv.finalized)));
    const excluded = rv.lines.filter((l) => {
      const s = statusAt(l, rv.finalized);
      return s === 'rejected' || s === 'cancelled';
    });
    const t = revisionTotals(rv);
    ctx.w.put('bill_revisions', {
      id: rv.id, bill_id: bill.id, visit_id: v.id, revision_no: rv.revision_no, status: rv.status,
      lines_json: JSON.stringify(chargeable.map(snapshot)),
      excluded_json: JSON.stringify(excluded.map(snapshot)),
      adjustments_json: JSON.stringify(rv.adjustments.map((a) => ({ id: a.id, kind: a.kind, amount_minor: a.amount_minor, reason: a.reason }))),
      subtotal_minor: t.subtotal, adjustments_minor: t.adjustments,
      charges_json: '[]', total_minor: t.total,
      finalized_at: iso(rv.finalized), finalized_by: rv.finalized_by,
      business_date: ctx.bdate(rv.finalized),
      superseded_at: rv.superseded ? iso(rv.superseded.at) : null,
      superseded_by: rv.superseded?.by ?? null,
      supersede_reason: rv.superseded?.reason ?? null,
      is_fixture: 1,
    });
  }
}

export function writeAdjustment(ctx: SeedCtx, v: SimVisit, a: SimAdjustment): void {
  ctx.w.put('bill_adjustments', {
    id: a.id, visit_id: v.id, kind: a.kind, amount_minor: a.amount_minor, reason: a.reason,
    order_line_id: a.line_id, created_by: a.by, created_at: iso(a.at),
  });
}

export function writePayment(ctx: SeedCtx, v: SimVisit, p: SimPayment): void {
  ctx.w.put('payments', {
    id: p.id, visit_id: v.id, bill_revision_id: p.revision_id, kind: 'settlement', method: 'cash',
    amount_minor: p.amount_minor, tendered_minor: p.tendered_minor, change_minor: p.change_minor,
    reference: null, status: 'confirmed', idempotency_key: p.key, reverses_payment_id: null, reason: null,
    confirmed_by: p.by, confirmed_at: iso(p.at), business_date: ctx.bdate(p.at), is_fixture: 1,
  });
}

export function writeAudit(ctx: SeedCtx, actor: ActorRef, action: string, entity: { type: string; id: string | null; visit_id?: string | null }, at: number, extra: { reason?: string | null; before?: unknown; after?: unknown } = {}): void {
  ctx.w.put('audit_events', {
    actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action,
    entity_type: entity.type, entity_id: entity.id, visit_id: entity.visit_id ?? null,
    reason: extra.reason ?? null,
    before_json: extra.before === undefined ? null : JSON.stringify(extra.before),
    after_json: extra.after === undefined ? null : JSON.stringify(extra.after),
    created_at: iso(at),
  });
}

export function writeAvailability(ctx: SeedCtx, itemId: string, available: boolean, reason: string, at: number, by: string | null): void {
  ctx.w.put('availability_log', { item_id: itemId, available, reason, changed_at: iso(at), changed_by: by });
}

/** Cash handed over: exact, or rounded up to a 100 / 500 / 1,000 baht note. */
export function cashTendered(r: Rng, total: number): number {
  if (total <= 0 || r.chance(0.3)) return total;
  const notes = total <= 50_000 ? [10_000, 50_000, 100_000] : total <= 200_000 ? [50_000, 100_000] : [100_000];
  const note = r.pick(notes);
  const tendered = Math.ceil(total / note) * note;
  return tendered === total ? tendered + note : tendered;
}
