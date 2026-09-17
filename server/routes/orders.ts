// Orders and fulfilment HTTP adapters (S3). Mounted at /api/guest and
// /api/staff (see app.ts); paths below are relative to those mounts.
//
// Guests and staff share one submission path: parse → replay check →
// ordering guards → priceCart() against the live catalog → createOrder().
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import type { AttemptLookupDTO, OrderDTO, QuoteDTO, StaffOrderDTO, SubmitResultDTO } from '../../shared/dto.ts';
import {
  AssistOrderBody, FinishOrderBody, IdSchema, IsoDateSchema, QuoteBody, RecoverOrderBody, StaffQuoteBody,
  SubmitOrderBody, TransitionBody, idempotencyKey, type CartLineInput,
} from '../../shared/schemas.ts';
import { LINE_STATUSES, STATIONS, type LineStatus } from '../../shared/status.ts';
import { nowIso } from '../../shared/time.ts';
import { tx } from '../db/index.ts';
import type { Actor } from '../lib/audit.ts';
import { guestOf, requireGuest, requireStaff, staffOf, type StaffContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { body, payloadHash, sha256 } from '../lib/http.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { assertCanOrder, getVisit, type VisitRow } from '../domain/guards.ts';
import {
  getCategory, getItem, itemVariants, priceCart, unavailableReason, type PriceCartResult,
} from '../domain/pricing.ts';
import {
  cartPayloadHash, createOrder, findAttempt, listVisitOrders, orderDTO, orderDTOs, replayOf, visitCharges,
} from '../domain/orders.ts';
import { finishOrder, listStaffOrders, MAX_BOARD_LIMIT, transitionLines } from '../domain/fulfillment.ts';
import { listVisitPortions } from '../domain/portions.ts';

// ------------------------------------------------------------------ helpers
function visitOr404(id: string): VisitRow {
  const visit = getVisit(id);
  if (!visit) throw new AppError('not_found', 'Visit not found');
  return visit;
}

function cartChanged(quote: QuoteDTO): never {
  throw new AppError('cart_changed', 'Something in the order changed. Please review it before sending.', { quote });
}

/** Analytics ids are opaque client tokens; anything else is dropped rather than stored. */
function analyticsId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

interface SubmitArgs {
  visitId: string;
  source: 'guest' | 'staff';
  actor: Actor;
  guestSessionId?: string | null;
  staffUserId?: string | null;
  key: string;
  lines: CartLineInput[];
  expectedSubtotal: number;
  locale?: string | null;
  analyticsSessionId?: string | null;
}

/** Guest and staff-assisted submission: one transaction, replay first. */
function submitCart(a: SubmitArgs): { orderId: string; replayed: boolean } {
  const hash = cartPayloadHash(a.lines);
  return tx(() => {
    const visit = visitOr404(a.visitId);
    // A replay of an order that exists must succeed even if ordering has
    // since paused or the table moved to checkout.
    const replay = replayOf(visit.id, a.key, hash);
    if (replay) return replay;
    assertCanOrder(visit, a.source);
    const priced = priceCart(a.lines, { charges: visitCharges(visit) });
    if (!priced.ok || priced.quote.subtotal_minor !== a.expectedSubtotal) cartChanged(priced.quote);
    return createOrder({
      visit,
      source: a.source,
      actor: a.actor,
      guestSessionId: a.guestSessionId ?? null,
      staffUserId: a.staffUserId ?? null,
      idempotencyKey: a.key,
      payloadHash: hash,
      priced: priced.priced,
      locale: a.locale ?? null,
      analyticsSessionId: a.analyticsSessionId ?? null,
    });
  });
}

/**
 * Paper orders already happened: an item that is sold out or whose category
 * is paused *now* can still be recorded. Everything else (unknown items,
 * invalid choices, price differences, measured-weight cuts) needs review.
 */
function recoveryBlocked(result: PriceCartResult, lines: CartLineInput[]): boolean {
  return result.quote.issues.some((issue) => {
    if (issue.code === 'sold_out') return false;
    if (issue.code !== 'not_orderable') return true;
    const item = getItem(lines[issue.line_index].item_id);
    const cat = item ? getCategory(item.category_id) : undefined;
    return !item || !cat || unavailableReason(item, cat, itemVariants(item.id)) !== 'paused';
  });
}

const blank = <S extends z.ZodType>(schema: S) => z.preprocess((v) => (v === '' ? undefined : v), schema);

const StaffOrdersQuery = z.object({
  scope: blank(z.enum(['active', 'history']).default('active')),
  status: blank(z.string().max(200).optional()),
  table: blank(z.string().trim().max(64).optional()),
  station: blank(z.enum(STATIONS).optional()),
  date: blank(IsoDateSchema.optional()),
  limit: blank(z.coerce.number().int().min(1).max(MAX_BOARD_LIMIT).optional()),
});

function parseStatuses(raw: string | undefined): LineStatus[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = values.filter((v) => !(LINE_STATUSES as readonly string[]).includes(v));
  if (bad.length) {
    throw new AppError('validation_failed', 'Unknown status filter', { issues: [{ path: 'status', message: `unknown: ${bad.join(', ')}` }] });
  }
  return values as LineStatus[];
}

const staffView = (staff: StaffContext) => ({ kind: 'staff' as const, staff });

// ------------------------------------------------------------------ guest
export const ordersGuest = new Hono<AppEnv>()
  // Validate a draft against the live catalog and this visit's charge snapshot.
  .post('/quote', requireGuest(), async (c) => {
    const g = guestOf(c);
    hit(`quote:guest:${g.guestId}`, LIMITS.quote);
    const input = await body(c, QuoteBody);
    const visit = visitOr404(g.visitId);
    return c.json<QuoteDTO>(priceCart(input.lines, { charges: visitCharges(visit) }).quote);
  })
  .post('/orders', requireGuest(), async (c) => {
    const g = guestOf(c);
    hit(`order:guest:${g.guestId}`, LIMITS.submitOrder);
    const input = await body(c, SubmitOrderBody);
    const result = submitCart({
      visitId: g.visitId,
      source: 'guest',
      actor: g.actor,
      guestSessionId: g.guestId,
      key: input.idempotency_key,
      lines: input.lines,
      expectedSubtotal: input.expected_subtotal_minor,
      locale: input.locale,
      analyticsSessionId: analyticsId(input.analytics_session_id),
    });
    const order = orderDTO(result.orderId, { kind: 'guest', guestSessionId: g.guestId });
    return c.json<SubmitResultDTO>({ order, replayed: result.replayed }, result.replayed ? 200 : 201);
  })
  // Resolve an ambiguous submission. Creation is synchronous and single-process,
  // so "not_found" is definitive: the attempt never created an order (D-06).
  .get('/orders/attempts/:key', requireGuest(), (c) => {
    const g = guestOf(c);
    const key = idempotencyKey.safeParse(c.req.param('key'));
    if (!key.success) throw new AppError('validation_failed', 'Invalid attempt key', { issues: [{ path: 'key', message: 'invalid' }] });
    const found = findAttempt(g.visitId, key.data);
    const dto: AttemptLookupDTO = found
      ? { status: 'created', order: orderDTO(found.id, { kind: 'guest', guestSessionId: g.guestId }) }
      : { status: 'not_found' };
    return c.json(dto);
  })
  // The whole table's rounds (round order, oldest first) and portion requests.
  .get('/orders', requireGuest(), (c) => {
    const g = guestOf(c);
    const orders: OrderDTO[] = listVisitOrders(g.visitId, { kind: 'guest', guestSessionId: g.guestId });
    return c.json({ orders, portions: listVisitPortions(g.visitId) });
  });

// ------------------------------------------------------------------ staff
export const ordersStaff = new Hono<AppEnv>()
  .get('/orders', requireStaff('orders.view'), (c) => {
    const parsed = StaffOrdersQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Some query parameters are not valid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const q = parsed.data;
    const orders = listStaffOrders({
      scope: q.scope,
      statuses: parseStatuses(q.status),
      table: q.table || undefined,
      station: q.station,
      date: q.date,
      limit: q.limit,
    }, staffOf(c));
    return c.json({ orders, server_time: nowIso() });
  })
  // Per-line and bulk milestones; permissions are checked per line by target.
  .post('/orders/transition', requireStaff('orders.view'), async (c) => {
    const staff = staffOf(c);
    hit(`staff:${staff.user.id}`, LIMITS.staffMutation);
    const input = await body(c, TransitionBody);
    const ids = tx(() => transitionLines(input, staff));
    const orders: StaffOrderDTO[] = orderDTOs(ids, staffView(staff));
    return c.json({ orders });
  })
  .post('/orders/quote', requireStaff('orders.assist'), async (c) => {
    const input = await body(c, StaffQuoteBody);
    const visit = visitOr404(input.visit_id);
    return c.json<QuoteDTO>(priceCart(input.lines, { charges: visitCharges(visit) }).quote);
  })
  // Staff-assisted ordering: same pricing and persistence path as guests,
  // attributed to the signed-in staff member (source `staff`).
  .post('/orders/assist', requireStaff('orders.assist'), async (c) => {
    const staff = staffOf(c);
    hit(`staff:${staff.user.id}`, LIMITS.staffMutation);
    const input = await body(c, AssistOrderBody);
    const result = submitCart({
      visitId: input.visit_id,
      source: 'staff',
      actor: staff.actor,
      staffUserId: staff.user.id,
      key: input.idempotency_key,
      lines: input.lines,
      expectedSubtotal: input.expected_subtotal_minor,
    });
    const order = orderDTO(result.orderId, staffView(staff));
    return c.json<SubmitResultDTO>({ order, replayed: result.replayed }, result.replayed ? 200 : 201);
  })
  // Enter an order taken on paper during an outage. `already` records how far
  // the food got so the kitchen is not asked to cook it again.
  .post('/orders/recover', requireStaff('orders.recover_manual'), async (c) => {
    const staff = staffOf(c);
    hit(`staff:${staff.user.id}`, LIMITS.staffMutation);
    const input = await body(c, RecoverOrderBody);
    const originalMs = Date.parse(input.original_time);
    if (!Number.isFinite(originalMs)) {
      throw new AppError('validation_failed', 'The original order time is not valid.', { issues: [{ path: 'original_time', message: 'invalid' }] });
    }
    // The paper reference is the attempt identity: re-sending the same entry
    // replays it; the same reference with different content is a conflict.
    const key = `rec_${sha256(input.manual_reference).slice(0, 40)}`;
    const hash = payloadHash({ lines: cartPayloadHash(input.lines), original_time: new Date(originalMs).toISOString(), already: input.already });
    const result = tx(() => {
      const visit = visitOr404(input.visit_id);
      const existing = findAttempt(visit.id, key);
      if (existing) {
        if (existing.payload_hash === hash) return { orderId: existing.id, replayed: true };
        throw new AppError('conflict', 'That paper reference was already entered with different details.', { field: 'manual_reference', reference: existing.reference });
      }
      assertCanOrder(visit, 'manual_recovery');
      const priced = priceCart(input.lines, { charges: visitCharges(visit) });
      if (priced.priced.length !== input.lines.length || recoveryBlocked(priced, input.lines)) cartChanged(priced.quote);
      return createOrder({
        visit,
        source: 'manual_recovery',
        actor: staff.actor,
        staffUserId: staff.user.id,
        idempotencyKey: key,
        payloadHash: hash,
        priced: priced.priced,
        manual: { reference: input.manual_reference, originalTime: input.original_time, already: input.already, reason: input.reason },
      });
    });
    const order = orderDTO(result.orderId, staffView(staff));
    return c.json<SubmitResultDTO>({ order, replayed: result.replayed }, result.replayed ? 200 : 201);
  })
  .get('/orders/:id', requireStaff('orders.view'), (c) => {
    const id = IdSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new AppError('not_found', 'Order not found');
    return c.json<StaffOrderDTO>(orderDTO(id.data, staffView(staffOf(c))));
  })
  // Finish order: served or explicitly resolved; never touches bills or the visit.
  .post('/orders/:id/finish', requireStaff('orders.serve'), async (c) => {
    const staff = staffOf(c);
    hit(`staff:${staff.user.id}`, LIMITS.staffMutation);
    const id = IdSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new AppError('not_found', 'Order not found');
    const input = await body(c, FinishOrderBody);
    tx(() => finishOrder(id.data, input, staff));
    return c.json<StaffOrderDTO>(orderDTO(id.data, staffView(staff)));
  });
