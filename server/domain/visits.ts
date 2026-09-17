// Dining visits and guest access (brief 07, 20, 29, 30, 36; D-04, D-13).
//
// A table is permanent; a visit is one party's stay: Open -> Billing -> Closed.
// Only one visit per table can be active (partial UNIQUE index). Opening a
// visit issues a fresh join PIN; guests who scan the permanent QR must enter
// it (default) to get a guest session bound to THIS visit. Closing the visit,
// revoking guests or rotating the PIN never reuses an old authorization.
//
// PINs and guest tokens are secrets: never audited, emitted or logged.
// Every function here is synchronous and expects to run inside tx().
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuditEntryDTO, GuestSessionDTO, QrResolveDTO, VisitDetailDTO } from '../../shared/dto.ts';
import { newId, newJoinPin, newSecret } from '../../shared/ids.ts';
import { deriveTableState, SERVICE_TYPES, type ServiceType } from '../../shared/status.ts';
import { businessDate, nowIso, todayBusinessDate } from '../../shared/time.ts';
import { insert, isConstraintError, many, one, parseJson, run, updateVersioned } from '../db/index.ts';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import { guestTokenHash, type GuestContext, type StaffContext } from '../lib/auth.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { touchReportData } from '../lib/reportdata.ts';
import { cutoffHour, fixtureFlag, getSettings } from '../lib/settings.ts';
import { activeVisitForTable, getTable, getVisit, orderingBlock, type TableRow, type VisitRow } from './guards.ts';
import { ensureActiveToken, findToken, isWellFormedToken, qrUrl, type QrTokenRow } from './qr.ts';
import { listVisitOrders } from './orders.ts';
import { listVisitRequests } from './service.ts';
import { listVisitPortions } from './portions.ts';
import { staffBill } from './billing.ts';

// The contract lists overview() under visits.ts / tables.ts; it lives with the table counts.
export { overview } from './tables.ts';

// ------------------------------------------------------------------ helpers
function requireVisit(visitId: string): VisitRow {
  const v = getVisit(visitId);
  if (!v) throw new AppError('not_found', 'Visit not found');
  return v;
}

function assertActive(visit: VisitRow): void {
  if (visit.status === 'closed') throw new AppError('invalid_transition', 'This visit is already closed.', { visit_status: visit.status });
}

function visitEntity(visit: { id: string }) {
  return { type: 'visit', id: visit.id, visit_id: visit.id };
}

function emitVisit(topic: string, visitId: string, version: number, audience: 'staff' | 'all', payload: Record<string, unknown> = {}): void {
  emit(topic, { audience, visit_id: visitId, entity: { type: 'visit', id: visitId, version }, payload });
}

function emitTable(tableId: string, payload: Record<string, unknown> = {}): void {
  const t = getTable(tableId);
  emit('table.updated', { audience: 'staff', entity: { type: 'table', id: tableId, version: t?.version ?? null }, payload });
}

/** A PIN different from the current one (a "rotation" that repeats the old PIN would look broken). */
function freshPin(previous: string | null): string {
  const digits = getSettings().join.pin_digits;
  let pin = newJoinPin(digits);
  for (let i = 0; i < 5 && pin === previous; i++) pin = newJoinPin(digits);
  return pin;
}

/** Constant-time PIN comparison (hashing first equalises the lengths). */
function pinMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function lockedUntil(visit: VisitRow, now = Date.now()): string | null {
  return visit.pin_locked_until && new Date(visit.pin_locked_until).getTime() > now ? visit.pin_locked_until : null;
}

export function enabledServices(): ServiceType[] {
  const s = getSettings().services;
  return SERVICE_TYPES.filter((t) => s[t]);
}

// ------------------------------------------------------------------ open
/**
 * Seat a party. Replaying the same idempotency key returns the same visit;
 * a table that already has an active visit answers `conflict`.
 */
export function openVisit(tableId: string, input: { covers?: number | null; idempotencyKey: string }, staff: StaffContext): { visitId: string; replayed: boolean } {
  const prior = one<VisitRow>('SELECT * FROM visits WHERE open_idempotency_key = ?', [input.idempotencyKey]);
  if (prior) {
    const sameTable = prior.table_id === tableId
      || one('SELECT 1 AS x FROM visit_transfers WHERE visit_id = ? AND from_table_id = ?', [prior.id, tableId]) !== undefined;
    if (!sameTable) throw new AppError('idempotency_mismatch', 'This attempt already opened a visit at another table.');
    return { visitId: prior.id, replayed: true };
  }

  const table = getTable(tableId);
  if (!table || table.archived_at) throw new AppError('not_found', 'Table not found');
  if (table.enabled !== 1) throw new AppError('table_disabled', 'This table is disabled. Enable it before seating guests.');
  const active = activeVisitForTable(tableId);
  if (active) throw new AppError('conflict', 'This table already has an open visit.', { visit_id: active.id, visit_status: active.status });

  const settings = getSettings();
  const now = nowIso();
  const id = newId('vis');
  const pin = settings.join.pin_required ? newJoinPin(settings.join.pin_digits) : null;
  try {
    insert('visits', {
      id,
      table_id: tableId,
      status: 'open',
      join_pin: pin,
      covers: input.covers ?? null,
      // Charges are snapshotted at seating: a later settings change never reprices this bill.
      charges_json: JSON.stringify(settings.charges.filter((c) => c.enabled)),
      seated_at: now,
      seated_business_date: businessDate(now, cutoffHour()),
      opened_by: staff.user.id,
      open_idempotency_key: input.idempotencyKey,
      is_fixture: fixtureFlag(),
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    if (isConstraintError(err, 'visits')) throw new AppError('conflict', 'This table already has an open visit.');
    throw err;
  }
  audit(staff.actor, 'visit.opened', visitEntity({ id }), {
    after: { table_id: tableId, table_label: table.label, covers: input.covers ?? null, pin_required: pin !== null },
  });
  emitVisit('visit.opened', id, 1, 'staff', { table_id: tableId });
  emitTable(tableId, { visit_status: 'open' });
  return { visitId: id, replayed: false };
}

// ------------------------------------------------------------------ detail
interface AuditRow {
  id: number; actor_type: AuditEntryDTO['actor_type']; actor_label: string | null; action: string;
  entity_type: string; entity_id: string | null; visit_id: string | null; reason: string | null;
  before_json: string | null; after_json: string | null; created_at: string;
}

const SECRET_KEYS = ['pin', 'join_pin', 'token', 'token_hash', 'password', 'password_hash'];

/** Drop keys from a parsed audit payload (recursively). */
function scrub(value: unknown, drop: (key: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, drop));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!drop(k)) out[k] = scrub(v, drop);
    return out;
  }
  return value;
}

/**
 * The visit's audit trail, oldest first (most recent 300 entries). Amounts
 * (`*_minor`) are removed for roles without billing.view and payment
 * references for roles without payments.view; secrets never appear.
 */
export function visitHistory(visitId: string, staff: StaffContext): AuditEntryDTO[] {
  const rows = many<AuditRow>(
    `SELECT * FROM audit_events
      WHERE visit_id = :id OR (entity_type = 'visit' AND entity_id = :id)
      ORDER BY id DESC LIMIT 300`,
    { id: visitId },
  ).reverse();
  const money = staff.can('billing.view');
  const refs = staff.can('payments.view');
  return rows.map((r) => {
    const paymentish = r.entity_type === 'payment' || r.action.startsWith('payment');
    const drop = (k: string) => SECRET_KEYS.includes(k) || (!money && k.endsWith('_minor')) || (!refs && paymentish && k === 'reference');
    return {
      id: r.id,
      at: r.created_at,
      actor_type: r.actor_type,
      actor_label: r.actor_label,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      visit_id: r.visit_id,
      reason: r.reason,
      before: scrub(parseJson(r.before_json, null), drop),
      after: scrub(parseJson(r.after_json, null), drop),
    };
  });
}

/**
 * Everything staff need about one visit. The PIN is included only for roles
 * that may open visits; the bill only for roles with billing.view.
 */
export function visitDetail(visitId: string, staff: StaffContext): VisitDetailDTO {
  const visit = requireVisit(visitId);
  const table = getTable(visit.table_id);
  if (!table) throw new AppError('not_found', 'Table not found');
  const current = activeVisitForTable(table.id);
  const token = ensureActiveToken(table.id, SYSTEM);
  const opener = visit.opened_by
    ? one<{ display_name: string }>('SELECT display_name FROM staff_users WHERE id = ?', [visit.opened_by])
    : undefined;
  const guests = many<{ guest_no: number; created_at: string; last_seen_at: string | null; revoked_at: string | null }>(
    'SELECT guest_no, created_at, last_seen_at, revoked_at FROM guest_sessions WHERE visit_id = ? ORDER BY guest_no',
    [visitId],
  );
  const active = visit.status !== 'closed';
  return {
    id: visit.id,
    table: { id: table.id, label: table.label, state: deriveTableState(table.enabled === 1, current?.status ?? null) },
    status: visit.status,
    join_pin: active && staff.can('visits.open') ? visit.join_pin : null,
    pin_rotated_at: visit.pin_rotated_at,
    covers: visit.covers,
    seated_at: visit.seated_at,
    opened_by: opener?.display_name ?? null,
    closed_at: visit.closed_at,
    guests: guests.map((g) => ({
      label: `Guest ${g.guest_no}`,
      joined_at: g.created_at,
      last_seen_at: g.last_seen_at,
      revoked: g.revoked_at !== null,
    })),
    orders: listVisitOrders(visitId, { kind: 'staff', staff }),
    requests: listVisitRequests(visitId),
    portions: listVisitPortions(visitId),
    bill: staff.can('billing.view') ? staffBill(visitId, staff) : null,
    history: visitHistory(visitId, staff),
    qr_url: qrUrl(token.token),
    version: visit.version,
    pin_locked_until: active ? lockedUntil(visit) : null,
  };
}

// ------------------------------------------------------------------ staff changes
export function updateCovers(visitId: string, input: { covers: number | null; version: number }, staff: StaffContext): void {
  const visit = requireVisit(visitId);
  if (visit.version !== input.version) staleVersion(visitDetail(visitId, staff));
  if (visit.covers === input.covers) return;
  if (!updateVersioned('visits', visitId, input.version, { covers: input.covers, updated_at: nowIso() })) {
    staleVersion(visitDetail(visitId, staff));
  }
  audit(staff.actor, 'visit.covers_updated', visitEntity(visit), { before: { covers: visit.covers }, after: { covers: input.covers } });
  // Diners count by seated date: a correction to a past day changes reported figures.
  if (visit.status === 'closed' || visit.seated_business_date !== todayBusinessDate(cutoffHour())) {
    touchReportData(visit.seated_business_date);
  }
  emitVisit('visit.updated', visitId, visit.version + 1, 'staff', { covers: input.covers });
  emitTable(visit.table_id);
}

/** New PIN; failures and lockout reset. Guests already joined keep their access. */
export function rotatePin(visitId: string, input: { version: number }, staff: StaffContext): void {
  const visit = requireVisit(visitId);
  assertActive(visit);
  if (visit.version !== input.version) staleVersion(visitDetail(visitId, staff));
  const now = nowIso();
  const ok = updateVersioned('visits', visitId, input.version, {
    join_pin: freshPin(visit.join_pin),
    pin_rotated_at: now,
    pin_failures: 0,
    pin_locked_until: null,
    updated_at: now,
  });
  if (!ok) staleVersion(visitDetail(visitId, staff));
  audit(staff.actor, 'visit.pin_rotated', visitEntity(visit), { after: { unlocked: lockedUntil(visit) !== null } });
  emitVisit('visit.updated', visitId, visit.version + 1, 'staff', { pin_rotated: true });
}

/**
 * Revoke every guest session of the visit and rotate the PIN, e.g. when a
 * QR photo and PIN were shared. Connected guest streams end ("access").
 */
export function revokeGuests(visitId: string, input: { version: number; reason: string }, staff: StaffContext): void {
  const visit = requireVisit(visitId);
  assertActive(visit);
  if (visit.version !== input.version) staleVersion(visitDetail(visitId, staff));
  const now = nowIso();
  const revoked = run(
    `UPDATE guest_sessions SET revoked_at = :now, revoke_reason = :reason WHERE visit_id = :id AND revoked_at IS NULL`,
    { id: visitId, now, reason: input.reason },
  ).changes;
  const ok = updateVersioned('visits', visitId, input.version, {
    join_pin: freshPin(visit.join_pin),
    pin_rotated_at: now,
    pin_failures: 0,
    pin_locked_until: null,
    updated_at: now,
  });
  if (!ok) staleVersion(visitDetail(visitId, staff));
  audit(staff.actor, 'visit.guests_revoked', visitEntity(visit), { reason: input.reason, after: { revoked_sessions: revoked, pin_rotated: true } });
  emitVisit('visit.updated', visitId, visit.version + 1, 'all', { access: 'revoked' });
  emitTable(visit.table_id);
}

/**
 * Move the whole active visit to an enabled, empty table. Order history keeps
 * the label it was placed under; new rounds, the guests' header and live
 * service/portion tasks follow the party to the new table.
 */
export function transferVisit(visitId: string, input: { to_table_id: string; version: number; reason: string }, staff: StaffContext): void {
  const visit = requireVisit(visitId);
  assertActive(visit);
  if (visit.version !== input.version) staleVersion(visitDetail(visitId, staff));
  if (input.to_table_id === visit.table_id) throw new AppError('invalid_transition', 'The visit is already at this table.');
  const from = getTable(visit.table_id)!;
  const to = getTable(input.to_table_id);
  if (!to || to.archived_at) throw new AppError('not_found', 'Destination table not found');
  if (to.enabled !== 1) throw new AppError('table_disabled', 'The destination table is disabled.');
  const occupied = activeVisitForTable(to.id);
  if (occupied) throw new AppError('conflict', 'The destination table already has a visit.', { table_id: to.id });

  const now = nowIso();
  let ok = false;
  try {
    ok = updateVersioned('visits', visitId, input.version, { table_id: to.id, updated_at: now });
  } catch (err) {
    if (isConstraintError(err, 'visits')) throw new AppError('conflict', 'The destination table already has a visit.', { table_id: to.id });
    throw err;
  }
  if (!ok) staleVersion(visitDetail(visitId, staff));
  insert('visit_transfers', {
    id: newId('vtr'),
    visit_id: visitId,
    from_table_id: from.id,
    to_table_id: to.id,
    reason: input.reason,
    created_by: staff.user.id,
    created_at: now,
  });

  // Live tasks are about where the party sits now; closed ones stay as history.
  const services = run(
    `UPDATE service_requests SET table_id = :to, table_label = :label, updated_at = :now, version = version + 1
      WHERE visit_id = :id AND status IN ('sent','acknowledged')`,
    { id: visitId, to: to.id, label: to.label, now },
  ).changes;
  const portions = run(
    `UPDATE portion_requests SET table_id = :to, updated_at = :now, version = version + 1
      WHERE visit_id = :id AND status IN ('requested','quoted')`,
    { id: visitId, to: to.id, now },
  ).changes;

  audit(staff.actor, 'visit.transferred', visitEntity(visit), {
    reason: input.reason,
    before: { table_id: from.id, table_label: from.label },
    after: { table_id: to.id, table_label: to.label, moved_requests: services, moved_portions: portions },
  });
  emitVisit('visit.updated', visitId, visit.version + 1, 'all', { transferred: true });
  if (services > 0) emit('service.updated', { audience: 'staff', visit_id: visitId, payload: { transferred: true } });
  if (portions > 0) emit('portion.updated', { audience: 'staff', visit_id: visitId, payload: { transferred: true } });
  emitTable(from.id, { visit_status: null });
  emitTable(to.id, { visit_status: visit.status });
}

/**
 * Checkout (S5) and other closers: revoke every guest session and clear the
 * PIN. Does not bump the visit version (the caller owns the visit update).
 */
export function revokeVisitAccess(visitId: string, reason: string, actor: Actor): { revoked: number } {
  const now = nowIso();
  const revoked = run(
    `UPDATE guest_sessions SET revoked_at = :now, revoke_reason = :reason WHERE visit_id = :id AND revoked_at IS NULL`,
    { id: visitId, now, reason },
  ).changes;
  run('UPDATE visits SET join_pin = NULL, pin_failures = 0, pin_locked_until = NULL WHERE id = ?', [visitId]);
  audit(actor, 'visit.access_revoked', visitEntity({ id: visitId }), { reason, after: { revoked_sessions: revoked, pin_cleared: true } });
  const visit = getVisit(visitId);
  // A closing visit publishes visit.closed itself; otherwise tell its guests now.
  if (visit && visit.status !== 'closed') emitVisit('visit.updated', visitId, visit.version, 'all', { access: 'revoked' });
  return { revoked };
}

// ------------------------------------------------------------------ guest access
export interface QrTarget {
  token: QrTokenRow;
  table: TableRow;
  /** The table's active (open/billing) visit, if any. */
  visit: VisitRow | undefined;
}

/** Resolve a scanned token. Throws qr_invalid (unknown/malformed) or qr_disabled (rotated / table removed). */
export function qrTarget(token: unknown): QrTarget {
  if (!isWellFormedToken(token)) throw new AppError('qr_invalid', 'This QR code is not valid.');
  const row = findToken(token);
  const table = row ? getTable(row.table_id) : undefined;
  if (!row || !table) throw new AppError('qr_invalid', 'This QR code is not valid.');
  if (row.active !== 1 || table.archived_at) {
    throw new AppError('qr_disabled', 'This QR code has been replaced. Please ask staff for help.');
  }
  return { token: row, table, visit: activeVisitForTable(table.id) };
}

/**
 * What a scan may learn: the table label, whether the table is ready to join
 * and whether a PIN is needed. Never the PIN, orders or the bill.
 */
export function resolveQr(target: QrTarget, current: GuestContext | null): QrResolveDTO {
  const { table, visit } = target;
  const join = getSettings().join;
  const state: QrResolveDTO['state'] = table.enabled !== 1 ? 'disabled' : visit ? 'ready' : 'no_open_visit';
  // A member of the current visit is recognised even if staff disabled the table
  // meanwhile: they still see their orders and bill (ordering itself is blocked).
  const alreadyJoined = visit !== undefined && current !== null && current.visitId === visit.id;
  return {
    table_label: table.label,
    state,
    pin_required: join.pin_required && !alreadyJoined,
    already_joined: alreadyJoined,
  };
}

export type JoinOutcome =
  | { ok: true; guestId: string; visitId: string; /** new cookie token; null = keep the existing cookie */ token: string | null }
  | { ok: false; error: AppError };

/** Someone at the QR who has not joined yet. */
const ANONYMOUS: Actor = { type: 'guest', id: null, label: 'QR scan' };

/**
 * Join the table's current visit. Wrong PINs are counted on the visit and
 * lock joining for `lockout_minutes` after `max_failures`; the failure is
 * returned (not thrown) so the caller can commit the counter before erroring.
 */
export function joinVisit(tokenValue: string, pin: string | undefined, current: GuestContext | null): JoinOutcome {
  const { table, visit } = qrTarget(tokenValue);
  // This browser already belongs to the current visit: no PIN, no new session.
  if (visit && current && current.visitId === visit.id) return { ok: true, guestId: current.guestId, visitId: visit.id, token: null };
  if (table.enabled !== 1) throw new AppError('table_disabled', 'This table is not taking orders. Please ask staff for help.');
  if (!visit) throw new AppError('no_open_visit', 'This table has not been opened yet. Staff will open it when you are seated.');

  const join = getSettings().join;
  if (join.pin_required) {
    const until = lockedUntil(visit);
    if (until) {
      const retry = Math.ceil((new Date(until).getTime() - Date.now()) / 1000);
      throw new AppError('pin_locked', 'Too many wrong PINs. Please wait or ask staff.', { until, retry_after_seconds: retry });
    }
    // A visit opened while PINs were off has none: staff rotate the PIN to create one.
    if (!visit.join_pin) throw new AppError('pin_required', 'Ask staff for this table’s PIN.', { reason: 'no_pin_set' });
    if (!pin) throw new AppError('pin_required', 'Enter the PIN staff gave you.');
    if (!pinMatches(pin, visit.join_pin)) {
      const failures = visit.pin_failures + 1;
      if (failures >= join.max_failures) {
        const lockUntil = new Date(Date.now() + join.lockout_minutes * 60_000).toISOString();
        run('UPDATE visits SET pin_failures = 0, pin_locked_until = :until WHERE id = :id', { id: visit.id, until: lockUntil });
        audit(ANONYMOUS, 'visit.pin_locked', visitEntity(visit), { after: { failures, until: lockUntil } });
        emitVisit('visit.updated', visit.id, visit.version, 'staff', { pin_locked: true });
        return {
          ok: false,
          error: new AppError('pin_locked', 'Too many wrong PINs. Please wait or ask staff.', {
            until: lockUntil, retry_after_seconds: join.lockout_minutes * 60,
          }),
        };
      }
      run('UPDATE visits SET pin_failures = :f WHERE id = :id', { id: visit.id, f: failures });
      return { ok: false, error: new AppError('pin_invalid', 'That PIN is not right.', { attempts_left: join.max_failures - failures }) };
    }
    if (visit.pin_failures > 0) run('UPDATE visits SET pin_failures = 0 WHERE id = ?', [visit.id]);
  }

  const now = nowIso();
  const guestNo = (one<{ n: number | null }>('SELECT MAX(guest_no) AS n FROM guest_sessions WHERE visit_id = ?', [visit.id])?.n ?? 0) + 1;
  const token = newSecret(32);
  const guestId = newId('gst');
  insert('guest_sessions', {
    id: guestId,
    visit_id: visit.id,
    token_hash: guestTokenHash(token),
    guest_no: guestNo,
    created_at: now,
    last_seen_at: now,
  });
  const actor: Actor = { type: 'guest', id: guestId, label: `Guest ${guestNo}` };
  audit(actor, 'guest.joined', { type: 'guest_session', id: guestId, visit_id: visit.id }, { after: { guest_no: guestNo, pin_checked: join.pin_required } });
  emitVisit('visit.updated', visit.id, visit.version, 'staff', { guest_joined: guestNo });
  emitTable(table.id);
  return { ok: true, guestId, visitId: visit.id, token };
}

/** This browser leaves the visit: its own session ends, other guests are unaffected. */
export function leaveVisit(guest: GuestContext): void {
  const changed = run(
    `UPDATE guest_sessions SET revoked_at = :now, revoke_reason = 'guest_left' WHERE id = :id AND revoked_at IS NULL`,
    { id: guest.guestId, now: nowIso() },
  ).changes;
  if (changed === 0) return;
  audit(guest.actor, 'guest.left', { type: 'guest_session', id: guest.guestId, visit_id: guest.visitId });
  const visit = getVisit(guest.visitId);
  if (visit) {
    emitVisit('visit.updated', visit.id, visit.version, 'staff', { guest_left: guest.guestNo });
    emitTable(visit.table_id);
  }
}

/** The guest's view of their session, read fresh (label, status, ordering block). */
export function guestSessionDTO(guest: Pick<GuestContext, 'guestId' | 'visitId'>): GuestSessionDTO {
  const visit = requireVisit(guest.visitId);
  const table = getTable(visit.table_id);
  if (!table) throw new AppError('not_found', 'Table not found');
  const block = orderingBlock(visit, 'guest');
  return {
    guest_id: guest.guestId,
    visit: {
      id: visit.id,
      status: visit.status,
      table_label: table.label,
      seated_at: visit.seated_at,
      bill_requested_at: visit.bill_requested_at,
    },
    ordering: { allowed: block === null, reason: block },
    services: enabledServices(),
  };
}
