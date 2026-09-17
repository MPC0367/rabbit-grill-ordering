// Shared state guards: can this visit take a new order right now?
// Called inside the order-creation transaction so a pause, a billing start or
// a checkout that commits first is always respected (brief 25, 30).
import type { PublicConfigDTO } from '../../shared/dto.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import type { VisitStatus } from '../../shared/status.ts';
import { bangkokParts } from '../../shared/time.ts';
import { one } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { getSettings } from '../lib/settings.ts';

export interface VisitRow {
  id: string; table_id: string; status: VisitStatus;
  join_pin: string | null; pin_rotated_at: string | null; pin_failures: number; pin_locked_until: string | null;
  covers: number | null; charges_json: string;
  seated_at: string; seated_business_date: string; opened_by: string | null; open_idempotency_key: string | null;
  bill_requested_at: string | null; billing_started_at: string | null; billing_started_by: string | null;
  closed_at: string | null; closed_by: string | null; close_business_date: string | null; close_idempotency_key: string | null;
  close_exception: string | null; is_fixture: number; created_at: string; updated_at: string; version: number;
}

export interface TableRow {
  id: string; label: string; zone: string | null; location_type: string; sort: number;
  enabled: number; ordering_paused: number; archived_at: string | null;
  created_at: string; updated_at: string; version: number;
}

export function getVisit(id: string): VisitRow | undefined {
  return one<VisitRow>('SELECT * FROM visits WHERE id = ?', [id]);
}

export function getTable(id: string): TableRow | undefined {
  return one<TableRow>('SELECT * FROM dining_tables WHERE id = ?', [id]);
}

export function activeVisitForTable(tableId: string): VisitRow | undefined {
  return one<VisitRow>(`SELECT * FROM visits WHERE table_id = ? AND status <> 'closed'`, [tableId]);
}

/** null when within hours or hours are not enforced; otherwise whether open now. */
export function withinHours(at = Date.now()): boolean | null {
  const s = getSettings().ordering;
  if (!s.enforce_hours) return null;
  const p = bangkokParts(at);
  const day = (p.weekday + 6) % 7; // Monday = 0
  const minutes = p.hour * 60 + p.minute;
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return (s.weekly_hours[day] ?? []).some((h) => minutes >= toMin(h.open) && minutes < toMin(h.close));
}

export function publicOrderingState(): PublicConfigDTO['ordering'] {
  const s = getSettings().ordering;
  return {
    enabled: s.enabled,
    paused_message: { th: s.paused_message_th, en: s.paused_message_en },
    estimated_wait_minutes: s.estimated_wait_minutes,
    within_hours: withinHours(),
  };
}

export function unacceptedRounds(): number {
  return one<{ n: number }>(
    `SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_lines l ON l.order_id = o.id
      JOIN visits v ON v.id = o.visit_id
      WHERE l.status = 'submitted' AND v.status <> 'closed'`)?.n ?? 0;
}

export type OrderSource = 'guest' | 'staff' | 'manual_recovery' | 'portion_quote';

/** Reason a new order cannot be created for this visit, or null. */
export function orderingBlock(visit: VisitRow, source: OrderSource): ErrorCode | null {
  if (visit.status === 'closed') return 'visit_closed';
  if (visit.status === 'billing') return 'visit_billing';
  const table = getTable(visit.table_id);
  if (!table || table.enabled !== 1) return 'table_disabled';
  // Recovered paper orders already happened; pauses and hours do not apply.
  if (source === 'manual_recovery') return null;
  if (table.ordering_paused === 1) return 'table_paused';
  const s = getSettings().ordering;
  if (!s.enabled) return 'ordering_paused';
  if (withinHours() === false) return 'outside_hours';
  // A confirmed portion quote is part of an order the guest already started.
  if (source !== 'portion_quote' && s.intake_limit !== null && unacceptedRounds() >= s.intake_limit) return 'intake_full';
  return null;
}

export function assertCanOrder(visit: VisitRow, source: OrderSource): void {
  const block = orderingBlock(visit, source);
  if (block) throw new AppError(block);
}
