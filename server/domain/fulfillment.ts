// Fulfilment: staff-controlled line milestones, exceptions, Finish order and
// the live board query (brief 14, 19, 35).
//
// Every line moves only along shared/status.ts transitions. Changes are
// all-or-nothing over the lines a staff member selected, each checked against
// the version that staff member saw, so two devices can never silently
// overwrite each other. Almost done is optional and is never back-filled.
import type { z } from 'zod';
import type { StaffOrderDTO } from '../../shared/dto.ts';
import type { FinishOrderBody, TransitionBody } from '../../shared/schemas.ts';
import type { Permission } from '../../shared/permissions.ts';
import {
  ACTIVE_UNSERVED, FORWARD, TERMINAL, isChargeable, transitionKind,
  type LineStatus, type Station, type TransitionKind,
} from '../../shared/status.ts';
import { businessRangeUtc, nowIso, todayBusinessDate } from '../../shared/time.ts';
import { insert, one, run, updateVersioned } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { touchReportData } from '../lib/reportdata.ts';
import { cutoffHour } from '../lib/settings.ts';
import { getVisit } from './guards.ts';
import { buildOrderDTOs, getOrder, linesByIds, orderDTO, orderDTOs, orderLines, selectOrders, type LineRow } from './orders.ts';
import { bi } from './pricing.ts';

export type FinishOrderInput = z.infer<typeof FinishOrderBody>;

/** The timestamp column each state stamps. */
const STATUS_AT = {
  submitted: 'submitted_at',
  accepted: 'accepted_at',
  preparing: 'preparing_at',
  almost_done: 'almost_done_at',
  ready: 'ready_at',
  served: 'served_at',
  rejected: 'rejected_at',
  cancelled: 'cancelled_at',
} as const satisfies Record<LineStatus, keyof LineRow>;

const AUDIT_ACTION: Record<TransitionKind, string> = {
  forward: 'order.lines_advanced',
  reject: 'order.lines_rejected',
  cancel: 'order.lines_cancelled',
  correction: 'order.lines_corrected',
};

const MIN_REASON = 3;

/** Permission a staff member needs for one line transition (docs/API.md). */
export function requiredPermission(from: LineStatus, to: LineStatus, kind: TransitionKind): Permission {
  switch (kind) {
    case 'forward':
      if (to === 'accepted') return 'orders.accept';
      if (to === 'served') return 'orders.serve';
      return 'orders.prepare';
    case 'reject':
      return 'orders.accept';
    case 'cancel':
      return from === 'accepted' ? 'orders.cancel_unstarted' : 'orders.cancel_started';
    case 'correction':
      return 'orders.correct';
  }
}

interface PlannedChange {
  line: LineRow;
  to: LineStatus;
  kind: TransitionKind;
  reason: string | null;
}

const staffView = (staff: StaffContext) => ({ kind: 'staff' as const, staff });

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** A payable (or the current settled) revision freezes what the table owes. */
function billLocked(visitId: string): boolean {
  return Boolean(one(
    `SELECT 1 AS x FROM bill_revisions r
      WHERE r.visit_id = :visit
        AND (r.status = 'payable'
             OR (r.status = 'settled' AND r.id = (SELECT current_revision_id FROM bills WHERE visit_id = :visit)))
      LIMIT 1`, { visit: visitId }));
}

/** Permissions, reasons, visit state and bill lock for a set of planned changes. */
function checkChanges(changes: PlannedChange[], staff: StaffContext): void {
  const missing = unique(changes.map((ch) => requiredPermission(ch.line.status, ch.to, ch.kind)).filter((p) => !staff.can(p)));
  if (missing.length) {
    throw new AppError('forbidden', 'Your role cannot do this.', { permission: missing[0], permissions: missing });
  }
  for (const ch of changes) {
    if (ch.kind !== 'forward' && [...(ch.reason ?? '')].length < MIN_REASON) {
      throw new AppError('validation_failed', 'Please give a reason.', { issues: [{ path: 'reason', message: 'A reason is required for this change.' }] });
    }
  }
  for (const visitId of unique(changes.map((ch) => ch.line.visit_id))) {
    const visit = getVisit(visitId);
    if (!visit || visit.status === 'closed') {
      throw new AppError('conflict', 'This visit is already closed.', { reason: 'visit_closed', visit_id: visitId });
    }
    const altersBill = changes.some((ch) => ch.line.visit_id === visitId && isChargeable(ch.line.status) !== isChargeable(ch.to));
    if (altersBill && billLocked(visitId)) {
      throw new AppError('bill_changed', 'Reopen the bill first.', { visit_id: visitId });
    }
  }
}

function applyLine(ch: PlannedChange, staff: StaffContext, now: string): void {
  const { line, to, kind } = ch;
  const patch: Record<string, unknown> = { status: to, updated_at: now };
  if (kind === 'correction') {
    // Undo the milestones after the target; the target keeps its original
    // time when it had one. The full history stays in line_events.
    const target = FORWARD.indexOf(to);
    for (const s of FORWARD.slice(target + 1)) patch[STATUS_AT[s]] = null;
    if (line[STATUS_AT[to]] === null) patch[STATUS_AT[to]] = now;
    patch.status_reason = null;
  } else {
    patch[STATUS_AT[to]] = now;
    if (kind === 'reject' || kind === 'cancel') patch.status_reason = ch.reason;
  }
  // Versions were checked up front in this transaction; this is the backstop.
  if (!updateVersioned('order_lines', line.id, line.version, patch)) staleVersion();
  insert('line_events', {
    line_id: line.id,
    order_id: line.order_id,
    visit_id: line.visit_id,
    from_status: line.status,
    to_status: to,
    kind,
    actor_type: staff.actor.type,
    actor_id: staff.actor.id,
    reason: kind === 'forward' ? null : ch.reason,
    created_at: now,
  });
}

/**
 * Apply checked changes, one order at a time: lines, order version, audit,
 * report-data invalidation and exactly one `line.updated` event per order.
 * `bumpOrders = false` lets Finish order do its own versioned order update.
 */
function applyChanges(changes: PlannedChange[], staff: StaffContext, now: string, bumpOrders: boolean): void {
  const today = todayBusinessDate(cutoffHour());
  for (const orderId of unique(changes.map((ch) => ch.line.order_id))) {
    const order = getOrder(orderId)!;
    const group = changes.filter((ch) => ch.line.order_id === orderId);
    for (const ch of group) applyLine(ch, staff, now);

    if (bumpOrders) {
      const accepted = group.some((ch) => ch.kind === 'forward' && ch.to === 'accepted');
      // A correction that reopens a served dish un-finishes the order.
      const reopened = order.finished_at !== null && group.some((ch) => !TERMINAL.includes(ch.to));
      run(
        `UPDATE orders SET version = version + 1, updated_at = :now,
                first_accepted_at = CASE WHEN :accepted = 1 THEN COALESCE(first_accepted_at, :now) ELSE first_accepted_at END,
                finished_at = CASE WHEN :reopened = 1 THEN NULL ELSE finished_at END,
                finished_by = CASE WHEN :reopened = 1 THEN NULL ELSE finished_by END
          WHERE id = :id`,
        { id: orderId, now, accepted, reopened },
      );
    }

    for (const kind of unique(group.map((ch) => ch.kind))) {
      const ofKind = group.filter((ch) => ch.kind === kind);
      audit(staff.actor, AUDIT_ACTION[kind], { type: 'order', id: orderId, visit_id: order.visit_id }, {
        reason: kind === 'forward' ? null : ofKind[0].reason,
        before: { lines: ofKind.map((ch) => ({ id: ch.line.id, status: ch.line.status, version: ch.line.version })) },
        after: { reference: order.reference, lines: ofKind.map((ch) => ({ id: ch.line.id, status: ch.to })) },
      });
    }

    // Exceptions change what was sold; late updates change an earlier day.
    if (group.some((ch) => ch.kind !== 'forward') || order.business_date !== today) {
      touchReportData(order.business_date);
    }

    const targets = unique(group.map((ch) => ch.to));
    emit('line.updated', {
      audience: 'all',
      visit_id: order.visit_id,
      entity: { type: 'order', id: orderId, version: order.version + 1 },
      payload: { order_id: orderId, reference: order.reference, to: targets.length === 1 ? targets[0] : 'mixed', count: group.length },
    });
  }
}

// ------------------------------------------------------------------ transitions
/**
 * Move the listed lines to `to`. All-or-nothing: any stale version, invalid
 * step, missing permission or missing reason rejects the whole request.
 * Returns the affected order ids in the order they were first listed.
 */
export function transitionLines(input: TransitionBody, staff: StaffContext): string[] {
  const ids = input.lines.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new AppError('bad_request', 'A dish was listed twice.');
  const rows = new Map(linesByIds(ids).map((r) => [r.id, r]));
  const missing = ids.filter((id) => !rows.has(id));
  if (missing.length) throw new AppError('not_found', 'Some dishes were not found.', { line_ids: missing });

  const orderIds = unique(ids.map((id) => rows.get(id)!.order_id));
  if (input.lines.some((l) => rows.get(l.id)!.version !== l.version)) {
    staleVersion(orderDTOs(orderIds, staffView(staff)));
  }

  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const changes: PlannedChange[] = input.lines.map((l) => {
    const line = rows.get(l.id)!;
    const kind = transitionKind(line.status, input.to);
    if (!kind) {
      throw new AppError('invalid_transition', `A dish cannot go from ${line.status} to ${input.to}.`, { line_id: line.id, from: line.status, to: input.to });
    }
    return { line, to: input.to, kind, reason };
  });

  checkChanges(changes, staff);
  applyChanges(changes, staff, nowIso(), true);
  return orderIds;
}

// ------------------------------------------------------------------ finish order
/**
 * Finish order: every active line ends served (only a Ready dish may be
 * resolved to Served) or is explicitly cancelled with a reason (a dish that
 * was never accepted is rejected instead). Terminal lines stay untouched.
 * Bills, payments and the visit are not affected.
 */
export function finishOrder(orderId: string, input: FinishOrderInput, staff: StaffContext): void {
  const order = getOrder(orderId);
  if (!order) throw new AppError('not_found', 'Order not found');
  if (order.version !== input.version) staleVersion(orderDTO(orderId, staffView(staff)));
  if (order.finished_at) throw new AppError('already_done', 'This order is already finished.');

  const lines = orderLines(orderId);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  for (const r of input.resolutions) {
    if (seen.has(r.line_id)) throw new AppError('bad_request', 'A dish was listed twice.');
    seen.add(r.line_id);
    const line = byId.get(r.line_id);
    if (!line) throw new AppError('not_found', 'That dish is not part of this order.', { line_id: r.line_id });
    if (line.version !== r.version) staleVersion(orderDTO(orderId, staffView(staff)));
  }

  const changes: PlannedChange[] = [];
  for (const r of input.resolutions) {
    const line = byId.get(r.line_id)!;
    if (TERMINAL.includes(line.status)) {
      // Already where the resolution wants it: nothing to do.
      const settled = r.action === 'served' ? line.status === 'served' : line.status !== 'served';
      if (settled) continue;
      const served = r.action === 'served';
      throw new AppError('invalid_transition', served ? 'That dish was already rejected or cancelled.' : 'That dish has already been served.', {
        line_id: line.id, from: line.status, to: served ? 'served' : 'cancelled',
      });
    }
    if (r.action === 'served' && line.status !== 'ready') {
      throw new AppError('invalid_transition', 'Only dishes that are ready can be marked served.', { line_id: line.id, from: line.status, to: 'served' });
    }
    const to: LineStatus = r.action === 'served' ? 'served' : line.status === 'submitted' ? 'rejected' : 'cancelled';
    const reason = r.action === 'cancel' && r.reason?.trim() ? r.reason.trim() : null;
    changes.push({ line, to, kind: transitionKind(line.status, to)!, reason });
  }

  const resolved = new Set(changes.map((ch) => ch.line.id));
  const unresolved = lines.filter((l) => ACTIVE_UNSERVED.includes(l.status) && !resolved.has(l.id));
  if (unresolved.length) {
    throw new AppError('unresolved_orders', 'Some dishes are not served or resolved yet.', {
      lines: unresolved.map((l) => ({ id: l.id, name: bi(l.name_th, l.name_en), status: l.status, quantity: l.quantity, version: l.version })),
    });
  }

  checkChanges(changes, staff);
  const now = nowIso();
  applyChanges(changes, staff, now, false);
  if (!updateVersioned('orders', orderId, input.version, { finished_at: now, finished_by: staff.user.id, updated_at: now })) {
    staleVersion();
  }
  const count = (to: LineStatus) => changes.filter((ch) => ch.to === to).length;
  audit(staff.actor, 'order.finished', { type: 'order', id: orderId, visit_id: order.visit_id }, {
    after: { reference: order.reference, served: count('served'), cancelled: count('cancelled'), rejected: count('rejected') },
  });
  emit('order.updated', {
    audience: 'all',
    visit_id: order.visit_id,
    entity: { type: 'order', id: orderId, version: order.version + 1 },
    payload: { order_id: orderId, reference: order.reference, finished: true },
  });
}

// ------------------------------------------------------------------ board query
export interface StaffOrderFilter {
  /** active: open work on visits that are not closed; history: one business date. */
  scope: 'active' | 'history';
  /** Orders with at least one line in any of these line states. */
  statuses?: LineStatus[];
  /** Table id or label: matches where the round was ordered or where the party sits now. */
  table?: string;
  /** Orders with at least one line for this station. */
  station?: Station;
  /** Business date for history (default today). */
  date?: string;
  limit?: number;
}

export const DEFAULT_BOARD_LIMIT = 300;
export const MAX_BOARD_LIMIT = 500;

/**
 * Active scope: orders on a visit that is not closed which still have an
 * unserved line, or which are unfinished and changed today (so served rounds
 * stay visible until someone finishes them). Oldest submission first, so
 * unacknowledged work leads. History scope: one business date, newest first.
 */
export function listStaffOrders(f: StaffOrderFilter, staff: StaffContext | null): StaffOrderDTO[] {
  const cutoff = cutoffHour();
  const today = todayBusinessDate(cutoff);
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.scope === 'active') {
    params.today_start = businessRangeUtc(today, today, cutoff).start;
    params.unserved = ACTIVE_UNSERVED;
    where.push(`v.status <> 'closed'`);
    where.push(`(EXISTS (SELECT 1 FROM order_lines a WHERE a.order_id = o.id AND a.status IN (SELECT value FROM json_each(:unserved)))
                 OR (o.finished_at IS NULL AND o.updated_at >= :today_start))`);
  } else {
    params.date = f.date ?? today;
    where.push('o.business_date = :date');
  }
  if (f.statuses?.length) {
    params.statuses = f.statuses;
    where.push('EXISTS (SELECT 1 FROM order_lines s WHERE s.order_id = o.id AND s.status IN (SELECT value FROM json_each(:statuses)))');
  }
  if (f.station) {
    params.station = f.station;
    where.push('EXISTS (SELECT 1 FROM order_lines st WHERE st.order_id = o.id AND st.station = :station)');
  }
  if (f.table) {
    params.table = f.table;
    where.push('(:table IN (v.table_id, o.table_id) OR t.label = :table COLLATE NOCASE OR o.table_label = :table COLLATE NOCASE)');
  }
  const limit = Math.min(Math.max(1, f.limit ?? DEFAULT_BOARD_LIMIT), MAX_BOARD_LIMIT);
  const orderBy = f.scope === 'active' ? 'o.submitted_at, o.round_no' : 'o.submitted_at DESC, o.round_no DESC';
  return buildOrderDTOs(selectOrders(where.join(' AND '), params, orderBy, limit), { kind: 'staff', staff });
}
