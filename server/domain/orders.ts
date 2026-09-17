// Orders: the single insert path for order rounds and their lines, plus the
// read models (OrderDTO for guests, StaffOrderDTO for staff) every screen uses.
//
// createOrder() is called inside the caller's tx() by guest submission,
// staff-assisted ordering, manual recovery (routes/orders.ts) and confirmed
// portion quotes (S4). Pricing has already happened in priceCart(); this
// module only persists what was priced, with full snapshots, so later menu
// edits never change what was ordered (brief 12, 13, 27).
import type { CartLineInput } from '../../shared/schemas.ts';
import type { LineStepDTO, OrderDTO, OrderLineDTO, StaffOrderDTO } from '../../shared/dto.ts';
import type { ChargeRule } from '../../shared/money.ts';
import { lineTotal, measuredAmount } from '../../shared/money.ts';
import { newId, newOrderReference } from '../../shared/ids.ts';
import { countLines, deriveOrderStatus, type LineStatus, type PricingType, type Station } from '../../shared/status.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import { insert, isConstraintError, many, one, parseJson } from '../db/index.ts';
import { audit, type Actor } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { payloadHash } from '../lib/http.ts';
import { touchReportData } from '../lib/reportdata.ts';
import { cutoffHour } from '../lib/settings.ts';
import { assertCanOrder, getTable, getVisit, type OrderSource, type VisitRow } from './guards.ts';
import { bi, type PricedLine } from './pricing.ts';

// ------------------------------------------------------------------ rows
export interface OrderRow {
  id: string; reference: string; visit_id: string; table_id: string; table_label: string;
  round_no: number; source: OrderSource;
  guest_session_id: string | null; staff_user_id: string | null; analytics_session_id: string | null;
  idempotency_key: string; payload_hash: string; locale: string | null;
  submitted_at: string; business_date: string;
  manual_reference: string | null; manual_original_time: string | null;
  subtotal_minor: number; first_accepted_at: string | null;
  finished_at: string | null; finished_by: string | null;
  is_fixture: number; updated_at: string; version: number;
}

export interface LineRow {
  id: string; order_id: string; visit_id: string; line_no: number;
  item_id: string; variant_id: string | null; category_id: string;
  name_th: string | null; name_en: string | null; variant_name_th: string | null; variant_name_en: string | null;
  station: Station; prep_kind: 'cook' | 'prepare'; pricing_type: PricingType;
  unit_price_minor: number; modifiers_json: string; modifiers_minor: number; quantity: number;
  measured_grams: number | null; rate_minor: number | null; rate_basis_grams: number | null; portion_quote_id: string | null;
  line_total_minor: number; note: string | null; allergy_flag: number;
  status: LineStatus; status_reason: string | null;
  submitted_at: string; accepted_at: string | null; preparing_at: string | null; almost_done_at: string | null;
  ready_at: string | null; served_at: string | null; rejected_at: string | null; cancelled_at: string | null;
  prepared_before_entry: number; is_fixture: number; updated_at: string; version: number;
}

export interface LineEventRow {
  id: number; line_id: string; order_id: string; visit_id: string;
  from_status: LineStatus | null; to_status: LineStatus;
  kind: LineStepDTO['kind']; actor_type: Actor['type']; actor_id: string | null;
  reason: string | null; created_at: string;
}

export function getOrder(id: string): OrderRow | undefined {
  return one<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
}

export function orderLines(orderId: string): LineRow[] {
  return many<LineRow>('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_no', [orderId]);
}

/** Lines by id (any order), in no particular order. */
export function linesByIds(ids: string[]): LineRow[] {
  return many<LineRow>('SELECT * FROM order_lines WHERE id IN (SELECT value FROM json_each(:ids))', { ids });
}

/** Charge rules snapshotted on the visit at seating (D-07). */
export function visitCharges(visit: VisitRow): ChargeRule[] {
  return parseJson<ChargeRule[]>(visit.charges_json, []);
}

// ------------------------------------------------------------------ idempotency
/**
 * Stable hash of what a guest (or staff member) asked for. Two submissions
 * with the same key must describe the same food: item, variant, quantity,
 * choices (order-independent within a group), note and the allergy tick.
 * Client-side hints such as expected prices are deliberately not part of it.
 */
export function cartPayloadHash(lines: CartLineInput[]): string {
  return payloadHash(lines.map((l) => ({
    item: l.item_id,
    variant: l.variant_id ?? null,
    quantity: l.quantity,
    modifiers: (l.modifiers ?? [])
      .filter((m) => m.option_ids.length > 0)
      .map((m) => ({ group: m.group_id, options: [...m.option_ids].sort() }))
      .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0)),
    note: l.note?.trim() ? l.note.trim() : null,
    allergy: l.allergy_note === true,
  })));
}

/** The order created by an earlier attempt with this key in this visit, if any. */
export function findAttempt(visitId: string, key: string): OrderRow | undefined {
  return one<OrderRow>('SELECT * FROM orders WHERE visit_id = :visit AND idempotency_key = :key', { visit: visitId, key });
}

/**
 * Resolve a repeated attempt: same payload → the original order (replay);
 * different payload → idempotency_mismatch. Returns null for a fresh key.
 */
export function replayOf(visitId: string, key: string, hash: string): { orderId: string; replayed: true } | null {
  const existing = findAttempt(visitId, key);
  if (!existing) return null;
  if (existing.payload_hash !== hash) {
    throw new AppError('idempotency_mismatch', 'This attempt was already used for a different order.', { reference: existing.reference });
  }
  return { orderId: existing.id, replayed: true };
}

// ------------------------------------------------------------------ createOrder
export interface ManualRecovery {
  /** The paper ticket's reference; unique across all orders. */
  reference: string;
  /** When the order was actually taken (ISO instant). Becomes submitted_at. */
  originalTime: string;
  /** How far the food already got, so the kitchen is not asked to cook it twice. */
  already: 'none' | 'prepared' | 'served';
  reason?: string | null;
}

export interface CreateOrderArgs {
  visit: VisitRow;
  source: OrderSource;
  actor: Actor;
  guestSessionId?: string | null;
  staffUserId?: string | null;
  idempotencyKey: string;
  payloadHash: string;
  priced: PricedLine[];
  locale?: string | null;
  analyticsSessionId?: string | null;
  manual?: ManualRecovery;
}

const REFERENCE_ATTEMPTS = 12;
/** Recovered paper orders may be entered this long after they were taken. */
const RECOVERY_WINDOW_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;

function unusedReference(): string {
  // 30^4 references; widen the code if a busy database makes collisions likely.
  for (let length = 4; length <= 8; length++) {
    for (let i = 0; i < REFERENCE_ATTEMPTS; i++) {
      const ref = newOrderReference(length);
      if (!one('SELECT 1 AS x FROM orders WHERE reference = ?', [ref])) return ref;
    }
  }
  throw new Error('could not allocate an order reference');
}

/**
 * The time a paper order was really taken: not in the future, within the
 * recovery window, and not before the previous party at this table checked
 * out - that ticket belongs to them and must not land on the next party's
 * bill. (It may precede this visit's seated_at: during an outage the party is
 * often opened in the system only after the paper orders were taken; D-S8-15.)
 */
function recoveryTime(original: string, visit: VisitRow): string {
  const t = new Date(original).getTime();
  const now = Date.now();
  if (!Number.isFinite(t)) throw new AppError('validation_failed', 'The original order time is not valid.', { issues: [{ path: 'original_time', message: 'invalid' }] });
  if (t > now + CLOCK_SKEW_MS) throw new AppError('validation_failed', 'The original order time is in the future.', { issues: [{ path: 'original_time', message: 'future' }] });
  if (t < now - RECOVERY_WINDOW_MS) throw new AppError('validation_failed', 'Paper orders must be entered within 24 hours.', { issues: [{ path: 'original_time', message: 'too_old' }] });
  const previous = one<{ closed_at: string | null }>(
    `SELECT MAX(closed_at) AS closed_at FROM visits WHERE table_id = :table AND status = 'closed' AND id <> :id`,
    { table: visit.table_id, id: visit.id },
  )?.closed_at ?? null;
  if (previous && t < Date.parse(previous) - CLOCK_SKEW_MS) {
    throw new AppError('validation_failed', 'That time is before the previous party at this table checked out.', {
      issues: [{ path: 'original_time', message: 'before_previous_party', code: 'too_small' }],
      previous_party_closed_at: previous,
    });
  }
  return new Date(t).toISOString();
}

/**
 * THE only insert path for orders and order lines. Must run inside tx().
 * Replays return the original order; a new key creates the next round.
 */
export function createOrder(args: CreateOrderArgs): { orderId: string; replayed: boolean } {
  const manual = args.source === 'manual_recovery' ? args.manual : undefined;
  if (args.source === 'manual_recovery' && !manual) throw new Error('manual recovery needs its paper reference');

  // 1. Same attempt again? (checked before any ordering guard: a replay of an
  //    order that already exists must succeed even if ordering paused since.)
  const existing = findAttempt(args.visit.id, args.idempotencyKey);
  if (existing) {
    if (existing.payload_hash === args.payloadHash) return { orderId: existing.id, replayed: true };
    if (manual) throw new AppError('conflict', 'That paper reference was already entered with different items.', { field: 'manual_reference', reference: existing.reference });
    throw new AppError('idempotency_mismatch', 'This attempt was already used for a different order.', { reference: existing.reference });
  }
  if (manual) {
    const taken = one<{ reference: string }>('SELECT reference FROM orders WHERE manual_reference = ?', [manual.reference]);
    if (taken) throw new AppError('conflict', 'That paper reference was already entered.', { field: 'manual_reference', reference: taken.reference });
  }

  // 2. Re-read the visit inside this transaction and apply the ordering guards.
  const visit = getVisit(args.visit.id);
  if (!visit) throw new AppError('not_found', 'Visit not found');
  assertCanOrder(visit, args.source);
  if (args.priced.length === 0) throw new AppError('cart_empty', 'Add at least one item.');
  const table = getTable(visit.table_id);
  if (!table) throw new AppError('not_found', 'Table not found');

  const now = nowIso();
  const submittedAt = manual ? recoveryTime(manual.originalTime, visit) : now;
  const bizDate = businessDate(submittedAt, cutoffHour());
  const roundNo = (one<{ n: number | null }>('SELECT MAX(round_no) AS n FROM orders WHERE visit_id = ?', [visit.id])?.n ?? 0) + 1;
  const orderId = newId('ord');
  const reference = unusedReference();

  // 3. Lines with full snapshots.
  const lineStatus: LineStatus = manual?.already === 'served' ? 'served' : manual?.already === 'prepared' ? 'ready' : 'submitted';
  const lines = args.priced.map((p, i) => {
    const m = p.measured;
    const quantity = m ? 1 : p.quantity;
    if (m && p.unit_price_minor !== measuredAmount(m.grams, m.rate_minor, m.rate_basis_grams)) {
      throw new Error('measured line amount does not match its weight and rate');
    }
    return {
      id: newId('oln'),
      order_id: orderId,
      visit_id: visit.id,
      line_no: i + 1,
      item_id: p.item.id,
      variant_id: p.variant?.id ?? null,
      category_id: p.item.category_id,
      name_th: p.item.name_th,
      name_en: p.item.name_en,
      variant_name_th: p.variant?.name_th ?? null,
      variant_name_en: p.variant?.name_en ?? null,
      station: p.item.station,
      prep_kind: p.prep_kind,
      pricing_type: p.item.pricing_type,
      unit_price_minor: p.unit_price_minor,
      modifiers_json: JSON.stringify(p.modifiers_snapshot),
      modifiers_minor: p.modifiers_minor,
      quantity,
      measured_grams: m?.grams ?? null,
      rate_minor: m?.rate_minor ?? null,
      rate_basis_grams: m?.rate_basis_grams ?? null,
      portion_quote_id: m?.portion_quote_id ?? null,
      line_total_minor: lineTotal(p.unit_price_minor, p.modifiers_minor, quantity),
      note: p.note?.trim() ? p.note.trim() : null,
      allergy_flag: p.allergy_flag ? 1 : 0,
      status: lineStatus,
      submitted_at: submittedAt,
      // A recovered line records when it was entered as ready/served; the
      // unknown earlier milestones stay empty rather than being invented.
      ready_at: lineStatus === 'ready' ? now : null,
      served_at: lineStatus === 'served' ? now : null,
      prepared_before_entry: lineStatus === 'submitted' ? 0 : 1,
      is_fixture: visit.is_fixture,
      updated_at: now,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.line_total_minor, 0);

  // 4. The order row. UNIQUE(visit_id, idempotency_key) is the backstop for
  //    concurrent submissions of one attempt.
  try {
    insert('orders', {
      id: orderId,
      reference,
      visit_id: visit.id,
      table_id: table.id,
      table_label: table.label,
      round_no: roundNo,
      source: args.source,
      guest_session_id: args.guestSessionId ?? null,
      staff_user_id: args.staffUserId ?? null,
      analytics_session_id: args.analyticsSessionId ?? null,
      idempotency_key: args.idempotencyKey,
      payload_hash: args.payloadHash,
      locale: args.locale ?? null,
      submitted_at: submittedAt,
      business_date: bizDate,
      manual_reference: manual?.reference ?? null,
      manual_original_time: manual ? submittedAt : null,
      subtotal_minor: subtotal,
      is_fixture: visit.is_fixture,
      updated_at: now,
    });
  } catch (err) {
    if (isConstraintError(err, 'orders.idempotency_key')) {
      const replay = replayOf(visit.id, args.idempotencyKey, args.payloadHash);
      if (replay) return replay;
    }
    if (isConstraintError(err, 'orders.manual_reference')) {
      throw new AppError('conflict', 'That paper reference was already entered.', { field: 'manual_reference' });
    }
    throw err;
  }

  // Recovered rounds say so on every step; normal rounds start with a forward step.
  const firstKind = manual ? 'recovery' : 'forward';
  for (const line of lines) {
    insert('order_lines', line);
    insert('line_events', {
      line_id: line.id, order_id: orderId, visit_id: visit.id,
      from_status: null, to_status: 'submitted',
      kind: firstKind,
      actor_type: args.actor.type, actor_id: args.actor.id,
      reason: null, created_at: submittedAt,
    });
    if (line.status !== 'submitted') {
      insert('line_events', {
        line_id: line.id, order_id: orderId, visit_id: visit.id,
        from_status: 'submitted', to_status: line.status, kind: 'recovery',
        actor_type: args.actor.type, actor_id: args.actor.id,
        reason: manual?.reason ?? null, created_at: now,
      });
    }
  }

  // 5. Audit (never the note text) and notify.
  const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
  audit(args.actor, manual ? 'order.recovered' : 'order.created', { type: 'order', id: orderId, visit_id: visit.id }, {
    reason: manual?.reason ?? null,
    after: {
      reference, round_no: roundNo, source: args.source, table_label: table.label,
      subtotal_minor: subtotal, item_count: itemCount,
      lines: lines.map((l) => ({
        id: l.id, item_id: l.item_id, variant_id: l.variant_id, quantity: l.quantity,
        line_total_minor: l.line_total_minor, has_note: l.note !== null, allergy_flag: l.allergy_flag === 1,
        measured_grams: l.measured_grams, portion_quote_id: l.portion_quote_id, status: l.status,
      })),
      ...(manual ? { flagged: true, manual_reference: manual.reference, original_time: submittedAt, already: manual.already } : {}),
    },
  });
  if (manual) touchReportData(bizDate);
  emit('order.created', {
    audience: 'all',
    visit_id: visit.id,
    entity: { type: 'order', id: orderId, version: 1 },
    payload: { reference, round_no: roundNo, table_label: table.label, source: args.source, item_count: itemCount },
  });
  return { orderId, replayed: false };
}

// ------------------------------------------------------------------ read models
export type GuestOrderView = { kind: 'guest'; guestSessionId: string | null };
export type StaffOrderView = { kind: 'staff'; staff?: StaffContext | null };
export type OrderView = GuestOrderView | StaffOrderView;

interface OrderJoinRow extends OrderRow {
  current_table_id: string;
  current_table_label: string;
  guest_no: number | null;
  staff_display_name: string | null;
}

const ORDER_SELECT = `
  SELECT o.*, v.table_id AS current_table_id, t.label AS current_table_label,
         g.guest_no AS guest_no, su.display_name AS staff_display_name
    FROM orders o
    JOIN visits v ON v.id = o.visit_id
    JOIN dining_tables t ON t.id = v.table_id
    LEFT JOIN guest_sessions g ON g.id = o.guest_session_id
    LEFT JOIN staff_users su ON su.id = o.staff_user_id`;

/**
 * Order rows with the joins the DTO needs. `where` and `orderBy` are trusted
 * SQL written in this stream's modules; values always go through `params`.
 */
export function selectOrders(where: string, params: Record<string, unknown>, orderBy = 'o.submitted_at, o.round_no', limit?: number): OrderJoinRow[] {
  const sql = `${ORDER_SELECT} WHERE ${where} ORDER BY ${orderBy}${limit !== undefined ? ' LIMIT :limit' : ''}`;
  return many<OrderJoinRow>(sql, limit !== undefined ? { ...params, limit } : params);
}

interface EventJoinRow extends LineEventRow {
  staff_display_name: string | null;
  guest_no: number | null;
}

function stepActor(e: EventJoinRow, view: OrderView): string | null {
  if (view.kind !== 'staff') return null;
  if (e.actor_type === 'staff') return e.staff_display_name;
  if (e.actor_type === 'guest') return e.guest_no !== null ? `Guest ${e.guest_no}` : 'Guest';
  return null;
}

/** Guests see why a dish was rejected or cancelled; internal correction and recovery notes stay staff-only. */
function stepReason(e: EventJoinRow, view: OrderView): string | null {
  if (view.kind === 'staff') return e.reason;
  return e.kind === 'reject' || e.kind === 'cancel' ? e.reason : null;
}

function lineDTO(l: LineRow, events: EventJoinRow[], view: OrderView): OrderLineDTO {
  return {
    id: l.id,
    item_id: l.item_id,
    name: bi(l.name_th, l.name_en),
    variant_name: l.variant_name_th !== null || l.variant_name_en !== null ? bi(l.variant_name_th, l.variant_name_en) : null,
    modifiers: parseJson<OrderLineDTO['modifiers']>(l.modifiers_json, []),
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    modifiers_minor: l.modifiers_minor,
    line_total_minor: l.line_total_minor,
    measured_grams: l.measured_grams,
    rate_minor: l.rate_minor,
    rate_basis_grams: l.rate_basis_grams,
    note: l.note,
    allergy_flag: l.allergy_flag === 1,
    station: l.station,
    prep_kind: l.prep_kind,
    status: l.status,
    status_reason: l.status_reason,
    steps: events.map((e) => ({
      status: e.to_status,
      at: e.created_at,
      kind: e.kind,
      reason: stepReason(e, view),
      actor: stepActor(e, view),
    })),
    version: l.version,
  };
}

/**
 * orders.view_bill_values is enforced here, not only in the interface (brief 18):
 * a staff member without it gets every amount as 0 and `money_hidden: true`.
 * Dish prices are public on the menu; per-table totals are not.
 */
function redactMoney(dto: StaffOrderDTO): StaffOrderDTO {
  return {
    ...dto,
    subtotal_minor: 0,
    money_hidden: true,
    lines: dto.lines.map((l) => ({
      ...l,
      unit_price_minor: 0,
      modifiers_minor: 0,
      line_total_minor: 0,
      rate_minor: null,
      modifiers: l.modifiers.map((g) => ({ ...g, options: g.options.map((opt) => ({ ...opt, price_minor: 0 })) })),
    })),
  };
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/** Build DTOs for already-selected order rows, batching the line and event reads. */
export function buildOrderDTOs(rows: OrderJoinRow[], view: GuestOrderView): OrderDTO[];
export function buildOrderDTOs(rows: OrderJoinRow[], view: StaffOrderView): StaffOrderDTO[];
export function buildOrderDTOs(rows: OrderJoinRow[], view: OrderView): Array<OrderDTO | StaffOrderDTO>;
export function buildOrderDTOs(rows: OrderJoinRow[], view: OrderView): Array<OrderDTO | StaffOrderDTO> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = many<LineRow>(
    'SELECT * FROM order_lines WHERE order_id IN (SELECT value FROM json_each(:ids)) ORDER BY order_id, line_no', { ids });
  const events = many<EventJoinRow>(
    `SELECT e.*, su.display_name AS staff_display_name, g.guest_no AS guest_no
       FROM line_events e
       LEFT JOIN staff_users su ON e.actor_type = 'staff' AND su.id = e.actor_id
       LEFT JOIN guest_sessions g ON e.actor_type = 'guest' AND g.id = e.actor_id
      WHERE e.order_id IN (SELECT value FROM json_each(:ids)) ORDER BY e.id`, { ids });

  const linesByOrder = new Map<string, LineRow[]>();
  for (const l of lines) pushTo(linesByOrder, l.order_id, l);
  const eventsByLine = new Map<string, EventJoinRow[]>();
  for (const e of events) pushTo(eventsByLine, e.line_id, e);
  const hideMoney = view.kind === 'staff' && Boolean(view.staff) && !view.staff!.can('orders.view_bill_values');

  return rows.map((o) => {
    const ls = linesByOrder.get(o.id) ?? [];
    const lastUpdate = ls.reduce((max, l) => (l.updated_at > max ? l.updated_at : max), o.updated_at);
    const base: OrderDTO = {
      id: o.id,
      reference: o.reference,
      // The table the round was ordered at (kept on transfer, D-20). Staff
      // views add where the party sits now.
      table_label: o.table_label,
      round_no: o.round_no,
      source: o.source,
      submitted_at: o.submitted_at,
      status: deriveOrderStatus(ls),
      counts: countLines(ls, true),
      lines: ls.map((l) => lineDTO(l, eventsByLine.get(l.id) ?? [], view)),
      subtotal_minor: o.subtotal_minor,
      last_update_at: lastUpdate,
      version: o.version,
    };
    if (view.kind === 'guest') {
      return { ...base, mine: view.guestSessionId !== null && o.guest_session_id === view.guestSessionId };
    }
    const unaccepted = ls.filter((l) => l.status === 'submitted').map((l) => l.submitted_at).sort();
    const staffDto: StaffOrderDTO = {
      ...base,
      visit_id: o.visit_id,
      table_id: o.table_id,
      guest_label: o.guest_no !== null ? `Guest ${o.guest_no}` : null,
      staff_name: o.staff_display_name,
      manual_reference: o.manual_reference,
      finished_at: o.finished_at,
      is_fixture: o.is_fixture === 1,
      has_allergy_note: ls.some((l) => l.allergy_flag === 1),
      oldest_unaccepted_at: unaccepted[0] ?? null,
      current_table_label: o.current_table_label,
      current_table_id: o.current_table_id,
    };
    return hideMoney ? redactMoney(staffDto) : staffDto;
  });
}

export function orderDTO(orderId: string, view: GuestOrderView): OrderDTO;
export function orderDTO(orderId: string, view: StaffOrderView): StaffOrderDTO;
export function orderDTO(orderId: string, view: OrderView): OrderDTO | StaffOrderDTO;
export function orderDTO(orderId: string, view: OrderView): OrderDTO | StaffOrderDTO {
  const [dto] = buildOrderDTOs(selectOrders('o.id = :id', { id: orderId }), view);
  if (!dto) throw new AppError('not_found', 'Order not found');
  return dto;
}

export function orderDTOs(orderIds: string[], view: StaffOrderView): StaffOrderDTO[] {
  if (orderIds.length === 0) return [];
  const rows = selectOrders('o.id IN (SELECT value FROM json_each(:ids))', { ids: orderIds });
  const byId = new Map(buildOrderDTOs(rows, view).map((d) => [d.id, d]));
  return orderIds.map((id) => byId.get(id)).filter((d): d is StaffOrderDTO => d !== undefined);
}

/**
 * Every round of a visit, oldest round first (round_no ascending). The guest
 * interface decides its own presentation order.
 */
export function listVisitOrders(visitId: string, view: GuestOrderView): OrderDTO[];
export function listVisitOrders(visitId: string, view: StaffOrderView): StaffOrderDTO[];
export function listVisitOrders(visitId: string, view: OrderView): Array<OrderDTO | StaffOrderDTO>;
export function listVisitOrders(visitId: string, view: OrderView): Array<OrderDTO | StaffOrderDTO> {
  return buildOrderDTOs(selectOrders('o.visit_id = :visit', { visit: visitId }, 'o.round_no'), view);
}

/** Line counts (rows, not quantities) that tables, billing and checkout use. */
export function visitLineSummary(visitId: string): { submitted: number; unserved: number; ready: number; rounds: number; unaccepted_rounds: number } {
  const r = one<{ submitted: number | null; unserved: number | null; ready: number | null }>(
    `SELECT SUM(status = 'submitted') AS submitted,
            SUM(status IN ('submitted','accepted','preparing','almost_done','ready')) AS unserved,
            SUM(status = 'ready') AS ready
       FROM order_lines WHERE visit_id = ?`, [visitId]);
  const o = one<{ rounds: number; unaccepted: number }>(
    `SELECT COUNT(*) AS rounds,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = orders.id AND l.status = 'submitted')) AS unaccepted
       FROM orders WHERE visit_id = ?`, [visitId]);
  return {
    submitted: r?.submitted ?? 0,
    unserved: r?.unserved ?? 0,
    ready: r?.ready ?? 0,
    rounds: o?.rounds ?? 0,
    unaccepted_rounds: o?.unaccepted ?? 0,
  };
}

