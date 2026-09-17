// Bills, payment records and checkout (S5). HTTP adapters only:
// parse -> authorize -> tx(domain) -> DTO. Mounted at /api/guest and /api/staff.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import {
  AdjustmentBody, BillRequestBody, CheckoutBody, FinalizeBillBody, IdSchema, IsoDateSchema, PaymentBody,
  ReversePaymentBody, VersionBody, VersionReasonBody, VoidAdjustmentBody,
} from '../../shared/schemas.ts';
import { PAYMENT_STATUSES } from '../../shared/status.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import { run, tx } from '../db/index.ts';
import { body, query } from '../lib/http.ts';
import { AppError } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { emit } from '../lib/events.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { cutoffHour, isDemo } from '../lib/settings.ts';
import { guestOf, guestTx, requireGuest, requireStaff, staffOf } from '../lib/auth.ts';
import { getVisit } from '../domain/guards.ts';
import {
  addAdjustment, finalizeBill, guestBill, reopenBilling, startBilling, staffBill, voidAdjustment,
} from '../domain/billing.ts';
import { confirmPayment, listPayments, reversePayment } from '../domain/payments.ts';
import { completeCheckout } from '../domain/checkout.ts';
import { createServiceRequest } from '../domain/service.ts';

/** Route ids are opaque; anything malformed is simply "not found". */
function idParam(c: Context<AppEnv>, name = 'id'): string {
  const parsed = IdSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new AppError('not_found', 'Not found');
  return parsed.data;
}

/** Staff mutations share a generous per-user limit (protects against runaway clients). */
function staffMutation(c: Context<AppEnv>) {
  const staff = staffOf(c);
  hit(`staff-mutation:${staff.user.id}`, LIMITS.staffMutation);
  return staff;
}

const PaymentsQuery = z.object({
  date: IsoDateSchema.optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  include_fixture: z.enum(['0', '1']).optional(),
});

// ------------------------------------------------------------------ guest
export const billingGuest = new Hono<AppEnv>()
  .get('/bill', requireGuest(), (c) => c.json(guestBill(guestOf(c).visitId)))

  // "Request the bill": a `bill` service request plus a first-request stamp on the visit.
  .post('/bill/request', requireGuest(), async (c) => {
    const input = await body(c, BillRequestBody);
    const guest = guestOf(c);
    // createServiceRequest applies the per-guest service rate limit itself.
    const dto = guestTx(guest.guestId, () => {
      const visit = getVisit(guest.visitId);
      if (!visit || visit.status === 'closed') throw new AppError('visit_closed');
      createServiceRequest({
        visit, type: 'bill', note: null, idempotencyKey: input.idempotency_key,
        guestSessionId: guest.guestId, actor: guest.actor,
      });
      if (!visit.bill_requested_at) {
        const now = nowIso();
        const r = run(
          `UPDATE visits SET bill_requested_at = :now, updated_at = :now, version = version + 1
            WHERE id = :id AND bill_requested_at IS NULL`,
          { id: visit.id, now },
        );
        if (r.changes === 1) {
          audit(guest.actor, 'visit.bill_requested', { type: 'visit', id: visit.id, visit_id: visit.id });
          emit('visit.updated', { audience: 'all', visit_id: visit.id, entity: { type: 'visit', id: visit.id, version: visit.version + 1 }, payload: { bill_requested: true } });
          emit('table.updated', { audience: 'staff', visit_id: visit.id, entity: { type: 'table', id: visit.table_id }, payload: { bill_requested: true } });
        }
      }
      return guestBill(visit.id);
    });
    return c.json(dto);
  });

// ------------------------------------------------------------------ staff
export const billingStaff = new Hono<AppEnv>()
  .get('/visits/:id/bill', requireStaff('billing.view'), (c) => {
    const id = idParam(c);
    const staff = staffOf(c);
    return c.json(tx(() => staffBill(id, staff)));
  })

  .post('/visits/:id/billing/start', requireStaff('billing.start'), async (c) => {
    const id = idParam(c);
    const input = await body(c, VersionBody);
    const staff = staffMutation(c);
    return c.json(tx(() => startBilling(id, input.version, staff)));
  })

  .post('/visits/:id/billing/reopen', requireStaff('billing.reopen'), async (c) => {
    const id = idParam(c);
    const input = await body(c, VersionReasonBody);
    const staff = staffMutation(c);
    return c.json(tx(() => reopenBilling(id, input, staff)));
  })

  .post('/visits/:id/bill/finalize', requireStaff('billing.finalize'), async (c) => {
    const id = idParam(c);
    const input = await body(c, FinalizeBillBody);
    const staff = staffMutation(c);
    return c.json(tx(() => finalizeBill(id, input, staff)));
  })

  .post('/visits/:id/adjustments', requireStaff('billing.adjust'), async (c) => {
    const id = idParam(c);
    const input = await body(c, AdjustmentBody);
    const staff = staffMutation(c);
    return c.json(tx(() => addAdjustment(id, input, staff)));
  })

  .post('/visits/:id/adjustments/:adj/void', requireStaff('billing.adjust'), async (c) => {
    const id = idParam(c);
    const adj = idParam(c, 'adj');
    const input = await body(c, VoidAdjustmentBody);
    const staff = staffMutation(c);
    return c.json(tx(() => voidAdjustment(id, adj, input, staff)));
  })

  .post('/visits/:id/payments', requireStaff('payments.confirm'), async (c) => {
    const id = idParam(c);
    const input = await body(c, PaymentBody);
    const staff = staffMutation(c);
    return c.json(tx(() => confirmPayment(id, input, staff)));
  })

  .post('/payments/:id/reverse', requireStaff('payments.correct'), async (c) => {
    const id = idParam(c);
    const input = await body(c, ReversePaymentBody);
    const staff = staffMutation(c);
    return c.json(tx(() => reversePayment(id, input, staff)));
  })

  // exception_reason additionally needs visits.close_exception (checked in the domain,
  // only when a blocker actually needs overriding).
  .post('/visits/:id/checkout', requireStaff('checkout.complete'), async (c) => {
    const id = idParam(c);
    const input = await body(c, CheckoutBody);
    const staff = staffMutation(c);
    return c.json(tx(() => completeCheckout(id, input, staff)));
  })

  .get('/payments', requireStaff('payments.view'), (c) => {
    const q = query(c, PaymentsQuery);
    const includeFixture = q.include_fixture ? q.include_fixture === '1' : isDemo();
    return c.json(listPayments({
      date: q.date ?? businessDate(Date.now(), cutoffHour()),
      status: q.status,
      includeFixture,
    }));
  });
