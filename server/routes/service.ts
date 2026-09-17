// Service requests, feedback and measured-weight portions: HTTP adapters (S4).
// Mounted at /api/guest and /api/staff (see app.ts); paths below are relative
// to those mounts. Guards are attached per route, never with a module-wide
// `use('*')`, because other modules share the same mount points.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import type { OrderDTO, PortionRequestDTO, ServiceRequestDTO, StaffOrderDTO } from '../../shared/dto.ts';
import {
  FeedbackBody, IdSchema, IsoDateSchema, PortionCancelBody, PortionConfirmBody, PortionDeclineBody,
  PortionInPersonBody, PortionQuoteBody, PortionRequestBody, ServiceRequestBody, ServiceTransitionBody,
  StaffPortionRequestBody,
} from '../../shared/schemas.ts';
import { nowIso } from '../../shared/time.ts';
import { tx } from '../db/index.ts';
import { assertCan, guestOf, guestTx, requireGuest, requireStaff, staffOf, type StaffContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { body, query } from '../lib/http.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { orderDTO } from '../domain/orders.ts';
import {
  createServiceRequest, listServiceQueue, listVisitRequests, submitFeedback, transitionServiceRequest,
} from '../domain/service.ts';
import {
  cancelPortion, confirmPortion, createPortionRequest, declinePortion, expireQuotes, listPortionQueue,
  listVisitPortions, quotePortion, type ConfirmPortionResult,
} from '../domain/portions.ts';

// ------------------------------------------------------------------ helpers
const ServiceQueueQuery = z.object({
  scope: z.enum(['active', 'all']).default('active'),
  date: IsoDateSchema.optional(),
});

const PortionQueueQuery = z.object({
  scope: z.enum(['open', 'all']).default('open'),
  date: IsoDateSchema.optional(),
});

/** Route ids are opaque; anything malformed simply does not exist. */
function routeId(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id || !IdSchema.safeParse(id).success) throw new AppError('not_found', 'Not found');
  return id;
}

function staffMutation(staff: StaffContext): void {
  hit(`staff:${staff.user.id}`, LIMITS.staffMutation);
}

/**
 * A lapsed quote was marked expired inside the (committed) transaction; only
 * now is the error raised, so the expiry is not rolled back with it.
 */
function confirmedOrThrow(r: ConfirmPortionResult): Extract<ConfirmPortionResult, { outcome: 'confirmed' }> {
  if (r.outcome === 'expired') {
    throw new AppError('quote_expired', 'This quote has expired. Staff will confirm the portion again.', { current: r.request });
  }
  return r;
}

// ------------------------------------------------------------------ guest
export const serviceGuest = new Hono<AppEnv>()
  .get('/service', requireGuest(), (c) => {
    const g = guestOf(c);
    return c.json<{ requests: ServiceRequestDTO[] }>({ requests: listVisitRequests(g.visitId, 'guest') });
  })
  .post('/service', requireGuest(), async (c) => {
    const g = guestOf(c);
    const input = await body(c, ServiceRequestBody);
    const result = guestTx(g.guestId, () => createServiceRequest({
      visit: { id: g.visitId },
      type: input.type,
      note: input.note,
      idempotencyKey: input.idempotency_key,
      guestSessionId: g.guestId,
      actor: g.actor,
    }));
    return c.json<ServiceRequestDTO>(result.request, result.existing ? 200 : 201);
  })
  .post('/feedback', requireGuest(), async (c) => {
    const g = guestOf(c);
    const input = await body(c, FeedbackBody);
    const result = guestTx(g.guestId, () => submitFeedback({
      visitId: g.visitId,
      guestSessionId: g.guestId,
      rating: input.rating,
      comment: input.comment,
      idempotencyKey: input.idempotency_key,
      actor: g.actor,
    }));
    return c.json({ ok: true, replayed: result.replayed }, result.replayed ? 200 : 201);
  })
  // Convenience read (GET /api/guest/orders also carries the portions).
  .get('/portions', requireGuest(), (c) => {
    const g = guestOf(c);
    return c.json<{ requests: PortionRequestDTO[] }>({ requests: listVisitPortions(g.visitId) });
  })
  .post('/portions', requireGuest(), async (c) => {
    const g = guestOf(c);
    const input = await body(c, PortionRequestBody);
    hit(`portion:${g.guestId}`, LIMITS.portion);
    const result = guestTx(g.guestId, () => createPortionRequest({
      visitId: g.visitId,
      itemId: input.item_id,
      preferredGrams: input.preferred_grams,
      note: input.note,
      idempotencyKey: input.idempotency_key,
      guestSessionId: g.guestId,
      actor: g.actor,
    }));
    return c.json<PortionRequestDTO>(result.request, result.existing ? 200 : 201);
  })
  .post('/portions/:id/confirm', requireGuest(), async (c) => {
    const g = guestOf(c);
    const id = routeId(c);
    const input = await body(c, PortionConfirmBody);
    hit(`portion:${g.guestId}`, LIMITS.portion);
    const result = confirmedOrThrow(guestTx(g.guestId, () => confirmPortion({
      requestId: id,
      quoteId: input.quote_id,
      revision: input.revision,
      idempotencyKey: input.idempotency_key,
      via: 'guest',
      visitId: g.visitId,
      guestSessionId: g.guestId,
      actor: g.actor,
    })));
    const order = orderDTO(result.orderId, { kind: 'guest', guestSessionId: g.guestId });
    return c.json<{ request: PortionRequestDTO; order: OrderDTO; replayed: boolean }>(
      { request: result.request, order, replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  })
  .post('/portions/:id/decline', requireGuest(), async (c) => {
    const g = guestOf(c);
    const id = routeId(c);
    const input = await body(c, PortionDeclineBody);
    hit(`portion:${g.guestId}`, LIMITS.portion);
    const dto = guestTx(g.guestId, () => declinePortion({ requestId: id, quoteId: input.quote_id, revision: input.revision, visitId: g.visitId, actor: g.actor }));
    return c.json<PortionRequestDTO>(dto);
  })
  .post('/portions/:id/cancel', requireGuest(), (c) => {
    const g = guestOf(c);
    const id = routeId(c);
    hit(`portion:${g.guestId}`, LIMITS.portion);
    const dto = guestTx(g.guestId, () => cancelPortion({ requestId: id, visitId: g.visitId, actor: g.actor }));
    return c.json<PortionRequestDTO>(dto);
  });

// ------------------------------------------------------------------ staff
export const serviceStaff = new Hono<AppEnv>()
  .get('/service', requireStaff('service.handle'), (c) => {
    const q = query(c, ServiceQueueQuery);
    return c.json<{ requests: ServiceRequestDTO[]; server_time: string }>({ requests: listServiceQueue(q), server_time: nowIso() });
  })
  .post('/service/:id/transition', requireStaff('service.handle'), async (c) => {
    const staff = staffOf(c);
    const id = routeId(c);
    const input = await body(c, ServiceTransitionBody);
    if (input.to === 'cancelled') assertCan(c, 'service.cancel');
    staffMutation(staff);
    const dto = tx(() => transitionServiceRequest({ id, to: input.to, version: input.version, reason: input.reason, actor: staff.actor }));
    return c.json<ServiceRequestDTO>(dto);
  })
  .get('/portions', requireStaff('portions.quote'), (c) => {
    const q = query(c, PortionQueueQuery);
    // Settle lapsed quotes first so the queue shows what staff must act on.
    tx(() => expireQuotes());
    return c.json<{ requests: PortionRequestDTO[]; server_time: string }>({ requests: listPortionQueue(q), server_time: nowIso() });
  })
  .post('/portions', requireStaff('portions.quote'), async (c) => {
    const staff = staffOf(c);
    const input = await body(c, StaffPortionRequestBody);
    staffMutation(staff);
    const result = tx(() => createPortionRequest({
      visitId: input.visit_id,
      itemId: input.item_id,
      preferredGrams: input.preferred_grams,
      note: input.note,
      idempotencyKey: input.idempotency_key,
      staffUserId: staff.user.id,
      actor: staff.actor,
    }));
    return c.json<PortionRequestDTO>(result.request, result.existing ? 200 : 201);
  })
  .post('/portions/:id/quote', requireStaff('portions.quote'), async (c) => {
    const staff = staffOf(c);
    const id = routeId(c);
    const input = await body(c, PortionQuoteBody);
    staffMutation(staff);
    const dto = tx(() => quotePortion({
      requestId: id,
      grams: input.grams,
      choices: input.choices,
      note: input.note,
      expiresMinutes: input.expires_minutes,
      version: input.version,
      staffUserId: staff.user.id,
      actor: staff.actor,
    }));
    return c.json<PortionRequestDTO>(dto);
  })
  .post('/portions/:id/confirm-in-person', requireStaff('portions.confirm_in_person'), async (c) => {
    const staff = staffOf(c);
    const id = routeId(c);
    const input = await body(c, PortionInPersonBody);
    staffMutation(staff);
    // Staff record the guest's agreement to the quoted values; they cannot change them here.
    const result = confirmedOrThrow(tx(() => confirmPortion({
      requestId: id,
      quoteId: input.quote_id,
      revision: input.revision,
      idempotencyKey: input.idempotency_key,
      via: 'in_person',
      staffUserId: staff.user.id,
      note: input.note,
      actor: staff.actor,
    })));
    const order = orderDTO(result.orderId, { kind: 'staff', staff });
    return c.json<{ request: PortionRequestDTO; order: StaffOrderDTO; replayed: boolean }>(
      { request: result.request, order, replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  })
  .post('/portions/:id/cancel', requireStaff('portions.quote'), async (c) => {
    const staff = staffOf(c);
    const id = routeId(c);
    const input = await body(c, PortionCancelBody);
    staffMutation(staff);
    const dto = tx(() => cancelPortion({ requestId: id, version: input.version, reason: input.reason, actor: staff.actor }));
    return c.json<PortionRequestDTO>(dto);
  });
