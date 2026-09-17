// Tables: the live grid, table administration, QR rotation and the staff
// overview (brief 17, 20, 36).
//
// A table's state is never stored. It is derived from `enabled` and the one
// active (open/billing) visit, so checkout returning a table to Available is
// just the visit closing. Tile figures are read straight from the order,
// service, portion and guest tables so the grid and the overview always
// reconcile with each other and with the queues.
import type { OverviewDTO, TableTileDTO, TablesDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import { deriveTableState, TABLE_STATES, type TableState, type VisitStatus } from '../../shared/status.ts';
import { nowIso } from '../../shared/time.ts';
import { insert, isConstraintError, many, one, updateVersioned } from '../db/index.ts';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { getSettings } from '../lib/settings.ts';
import { getTable, publicOrderingState, withinHours, type TableRow } from './guards.ts';
import { ensureActiveToken, ensureAllTokens, rotateToken } from './qr.ts';

type Attention = TableTileDTO['attention'][number];
type QrState = NonNullable<TableTileDTO['qr']>;

// ------------------------------------------------------------------ tile data
interface ActiveVisitStats {
  id: string;
  table_id: string;
  status: VisitStatus;
  seated_at: string;
  covers: number | null;
  bill_requested_at: string | null;
  version: number;
  rounds: number;
  unresolved_lines: number;
  ready_lines: number;
  unaccepted_rounds: number;
  open_requests: number;
  open_assistance: number;
  bill_attention: number;
  portions_waiting: number;
  guests: number;
  pin_locked: number;
}

/**
 * "The guest asked for the bill and nobody has acted on it yet": the visit is
 * still open with a bill request, or a bill service request is still unacknowledged.
 * Shared by the tile badge and the overview count so they always agree.
 */
const BILL_ATTENTION_SQL = `(
  (v.status = 'open' AND v.bill_requested_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM service_requests sb WHERE sb.visit_id = v.id AND sb.type = 'bill' AND sb.status = 'sent')
)`;

const ACTIVE_VISIT_STATS_SQL = `
  SELECT v.id, v.table_id, v.status, v.seated_at, v.covers, v.bill_requested_at, v.version,
    (SELECT COUNT(*) FROM orders o WHERE o.visit_id = v.id) AS rounds,
    (SELECT COUNT(*) FROM order_lines l WHERE l.visit_id = v.id
        AND l.status IN ('submitted','accepted','preparing','almost_done','ready')) AS unresolved_lines,
    (SELECT COUNT(*) FROM order_lines l WHERE l.visit_id = v.id AND l.status = 'ready') AS ready_lines,
    (SELECT COUNT(DISTINCT l.order_id) FROM order_lines l WHERE l.visit_id = v.id AND l.status = 'submitted') AS unaccepted_rounds,
    (SELECT COUNT(*) FROM service_requests s WHERE s.visit_id = v.id AND s.status IN ('sent','acknowledged')) AS open_requests,
    (SELECT COUNT(*) FROM service_requests s WHERE s.visit_id = v.id AND s.status IN ('sent','acknowledged') AND s.type <> 'bill') AS open_assistance,
    CASE WHEN ${BILL_ATTENTION_SQL} THEN 1 ELSE 0 END AS bill_attention,
    (SELECT COUNT(*) FROM portion_requests p WHERE p.visit_id = v.id AND p.status = 'requested') AS portions_waiting,
    (SELECT COUNT(*) FROM guest_sessions g WHERE g.visit_id = v.id AND g.revoked_at IS NULL) AS guests,
    CASE WHEN v.pin_locked_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1 ELSE 0 END AS pin_locked
  FROM visits v
  WHERE v.status <> 'closed'`;

function activeVisitStats(tableId?: string): ActiveVisitStats[] {
  return tableId
    ? many<ActiveVisitStats>(`${ACTIVE_VISIT_STATS_SQL} AND v.table_id = ?`, [tableId])
    : many<ActiveVisitStats>(ACTIVE_VISIT_STATS_SQL);
}

interface QrRow { table_id: string; created_at: string; card_downloaded_at: string | null; rotated_at: string | null }

const QR_STATE_SQL = `
  SELECT q.table_id, q.created_at, q.card_downloaded_at,
         (SELECT MAX(r.revoked_at) FROM table_qr_tokens r WHERE r.table_id = q.table_id AND r.active = 0) AS rotated_at
    FROM table_qr_tokens q WHERE q.active = 1`;

function qrState(r: QrRow | undefined): QrState | undefined {
  if (!r) return undefined;
  return { issued_at: r.created_at, rotated_at: r.rotated_at, reprint_required: r.rotated_at !== null && r.card_downloaded_at === null };
}

function buildTile(t: TableRow, v: ActiveVisitStats | undefined, qr: QrState | undefined): TableTileDTO {
  const attention: Attention[] = [];
  if (v) {
    if (v.unaccepted_rounds > 0) attention.push('new_order');
    if (v.ready_lines > 0) attention.push('ready_food');
    if (v.open_assistance > 0) attention.push('service_request');
    if (v.bill_attention === 1) attention.push('bill_requested');
    if (v.portions_waiting > 0) attention.push('portion_request');
  }
  return {
    id: t.id,
    label: t.label,
    zone: t.zone,
    sort: t.sort,
    enabled: t.enabled === 1,
    ordering_paused: t.ordering_paused === 1,
    state: deriveTableState(t.enabled === 1, v?.status ?? null),
    version: t.version,
    visit: v
      ? {
          id: v.id,
          status: v.status,
          seated_at: v.seated_at,
          covers: v.covers,
          rounds: v.rounds,
          unresolved_lines: v.unresolved_lines,
          ready_lines: v.ready_lines,
          unaccepted_rounds: v.unaccepted_rounds,
          open_requests: v.open_requests,
          bill_requested: v.bill_requested_at !== null || v.bill_attention === 1,
          guests: v.guests,
          version: v.version,
          pin_locked: v.pin_locked === 1,
        }
      : null,
    attention,
    qr,
  };
}

function liveTable(tableId: string): TableRow {
  const t = getTable(tableId);
  if (!t || t.archived_at) throw new AppError('not_found', 'Table not found');
  return t;
}

/** One table's tile, as the grid shows it. */
export function tableTile(tableId: string): TableTileDTO {
  const t = getTable(tableId);
  if (!t) throw new AppError('not_found', 'Table not found');
  const qr = one<QrRow>(`${QR_STATE_SQL} AND q.table_id = ?`, [tableId]);
  return buildTile(t, activeVisitStats(tableId)[0], qrState(qr));
}

function byTableOrder(a: TableRow, b: TableRow): number {
  return a.sort - b.sort || a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' });
}

function emptyCounts(): Record<TableState, number> {
  return Object.fromEntries(TABLE_STATES.map((s) => [s, 0])) as Record<TableState, number>;
}

/** The live grid: every non-archived table, with counts that reconcile to the tiles. */
export function listTables(): TablesDTO {
  // Seeded or legacy tables may lack a QR token; every table must have one.
  ensureAllTokens(SYSTEM);
  const tables = many<TableRow>('SELECT * FROM dining_tables WHERE archived_at IS NULL').sort(byTableOrder);
  const visits = new Map(activeVisitStats().map((v) => [v.table_id, v]));
  const qr = new Map(many<QrRow>(QR_STATE_SQL).map((r) => [r.table_id, r]));
  const counts = emptyCounts();
  const tiles = tables.map((t) => {
    const tile = buildTile(t, visits.get(t.id), qrState(qr.get(t.id)));
    counts[tile.state] += 1;
    return tile;
  });
  return { tables: tiles, counts, server_time: nowIso() };
}

// ------------------------------------------------------------------ administration
function assertLabelFree(label: string, exceptId: string | null): void {
  const clash = one<{ id: string }>(
    'SELECT id FROM dining_tables WHERE label = ? COLLATE NOCASE AND archived_at IS NULL AND id <> ?',
    [label, exceptId ?? ''],
  );
  if (clash) throw new AppError('conflict', 'Another table already uses this label.', { field: 'label' });
}

function labelConflict(err: unknown): never {
  if (isConstraintError(err, 'dining_tables')) {
    throw new AppError('conflict', 'Another table already uses this label.', { field: 'label' });
  }
  throw err;
}

function tableEvent(t: { id: string; version: number }, payload: Record<string, unknown> = {}): void {
  emit('table.updated', { audience: 'staff', entity: { type: 'table', id: t.id, version: t.version }, payload });
}

/** Tell a table's current guests (if any) to refetch: label, pause or enabled state changed. */
function notifyTableGuests(tableId: string): void {
  const v = one<{ id: string; version: number }>(`SELECT id, version FROM visits WHERE table_id = ? AND status <> 'closed'`, [tableId]);
  if (v) emit('visit.updated', { audience: 'all', visit_id: v.id, entity: { type: 'visit', id: v.id, version: v.version }, payload: { table: true } });
}

export function createTable(input: { label: string; zone?: string | null; sort?: number }, actor: Actor): TableTileDTO {
  const label = input.label.trim();
  assertLabelFree(label, null);
  const sort = input.sort ?? (one<{ n: number | null }>('SELECT MAX(sort) AS n FROM dining_tables WHERE archived_at IS NULL')?.n ?? 0) + 1;
  const now = nowIso();
  const id = newId('tbl');
  try {
    insert('dining_tables', { id, label, zone: input.zone?.trim() || null, sort, enabled: 1, ordering_paused: 0, created_at: now, updated_at: now });
  } catch (err) {
    labelConflict(err);
  }
  ensureActiveToken(id, actor);
  audit(actor, 'table.created', { type: 'table', id }, { after: { label, zone: input.zone ?? null, sort } });
  tableEvent({ id, version: 1 }, { created: true });
  return tableTile(id);
}

export interface TablePatch {
  label?: string;
  zone?: string | null;
  sort?: number;
  enabled?: boolean;
  ordering_paused?: boolean;
  version: number;
}

/**
 * Edit a table. Changing only `ordering_paused` needs `ordering.pause`; any
 * other change needs `tables.manage` (plus `ordering.pause` if the pause flag
 * changes too). Label changes never alter history: orders snapshot the label
 * they were placed under.
 */
export function updateTable(tableId: string, input: TablePatch, staff: StaffContext): TableTileDTO {
  const t = liveTable(tableId);
  const next = {
    label: input.label !== undefined ? input.label.trim() : t.label,
    zone: input.zone !== undefined ? (input.zone?.trim() || null) : t.zone,
    sort: input.sort ?? t.sort,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : t.enabled,
    ordering_paused: input.ordering_paused !== undefined ? (input.ordering_paused ? 1 : 0) : t.ordering_paused,
  };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of Object.keys(next) as Array<keyof typeof next>) {
    if (next[k] !== t[k]) {
      before[k] = t[k];
      after[k] = next[k];
    }
  }
  const changed = Object.keys(after);
  const pauseChanged = changed.includes('ordering_paused');
  const otherChanged = changed.some((k) => k !== 'ordering_paused');

  const need = (perm: 'tables.manage' | 'ordering.pause') => {
    if (!staff.can(perm)) throw new AppError('forbidden', 'Your role cannot do this.', { permission: perm });
  };
  if (otherChanged) need('tables.manage');
  if (pauseChanged) need('ordering.pause');
  if (changed.length === 0 && !staff.can('tables.manage') && !staff.can('ordering.pause')) need('tables.manage');

  if (input.version !== t.version) staleVersion(tableTile(tableId));
  if (changed.length === 0) return tableTile(tableId);
  if ('label' in after) assertLabelFree(next.label, tableId);

  let ok = false;
  try {
    ok = updateVersioned('dining_tables', tableId, input.version, { ...next, updated_at: nowIso() });
  } catch (err) {
    labelConflict(err);
  }
  if (!ok) staleVersion(tableTile(tableId));

  const action = !otherChanged ? (next.ordering_paused === 1 ? 'table.ordering_paused' : 'table.ordering_resumed') : 'table.updated';
  audit(staff.actor, action, { type: 'table', id: tableId }, { before, after });
  tableEvent({ id: tableId, version: t.version + 1 }, { changed });
  if ('label' in after || 'enabled' in after || pauseChanged) notifyTableGuests(tableId);
  return tableTile(tableId);
}

/**
 * Replace a table's permanent QR (e.g. a card was photographed and shared).
 * Every printed card for this table stops working; the returned tile carries
 * `qr.reprint_required = true` until the new card is downloaded.
 */
export function rotateTableQr(tableId: string, input: { version: number; reason: string }, actor: Actor): TableTileDTO {
  const t = liveTable(tableId);
  if (input.version !== t.version) staleVersion(tableTile(tableId));
  if (!updateVersioned('dining_tables', tableId, input.version, { updated_at: nowIso() })) staleVersion(tableTile(tableId));
  rotateToken(tableId, input.reason, actor);
  tableEvent({ id: tableId, version: t.version + 1 }, { qr_rotated: true, reprint_required: true });
  return tableTile(tableId);
}

// ------------------------------------------------------------------ overview
/** What needs action now, and whether anything is blocking ordering (brief 17). */
export function overview(_staff: StaffContext): OverviewDTO {
  const settings = getSettings();
  const counts = emptyCounts();
  const rows = many<{ enabled: number; status: VisitStatus | null }>(
    `SELECT t.enabled, v.status FROM dining_tables t
       LEFT JOIN visits v ON v.table_id = t.id AND v.status <> 'closed'
      WHERE t.archived_at IS NULL`,
  );
  for (const r of rows) counts[deriveTableState(r.enabled === 1, r.status)] += 1;

  const unaccepted = one<{ n: number; oldest: string | null }>(
    `SELECT COUNT(DISTINCT o.id) AS n, MIN(o.submitted_at) AS oldest
       FROM orders o JOIN order_lines l ON l.order_id = o.id JOIN visits v ON v.id = o.visit_id
      WHERE l.status = 'submitted' AND v.status <> 'closed'`,
  )!;
  const ready = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM order_lines l JOIN visits v ON v.id = l.visit_id
      WHERE l.status = 'ready' AND v.status <> 'closed'`,
  )!;
  const requests = one<{ n: number; oldest: string | null }>(
    `SELECT COUNT(*) AS n, MIN(s.created_at) AS oldest FROM service_requests s JOIN visits v ON v.id = s.visit_id
      WHERE s.status IN ('sent','acknowledged') AND v.status <> 'closed'`,
  )!;
  const portions = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM portion_requests p JOIN visits v ON v.id = p.visit_id
      WHERE p.status IN ('requested','quoted') AND v.status <> 'closed'`,
  )!;
  const bills = one<{ n: number }>(`SELECT COUNT(*) AS n FROM visits v WHERE v.status <> 'closed' AND ${BILL_ATTENTION_SQL}`)!;

  const blockers: string[] = [];
  if (!settings.ordering.enabled) blockers.push('ordering_paused');
  if (withinHours() === false) blockers.push('outside_hours');
  if (settings.ordering.intake_limit !== null && unaccepted.n >= settings.ordering.intake_limit) blockers.push('intake_full');
  if (rows.every((r) => r.enabled !== 1)) blockers.push('no_tables');
  if (settings.operating_mode === 'demo') blockers.push('demo_mode');

  return {
    ordering: publicOrderingState(),
    counts,
    unaccepted_rounds: unaccepted.n,
    oldest_unaccepted_at: unaccepted.oldest,
    ready_lines: ready.n,
    open_requests: requests.n,
    oldest_request_at: requests.oldest,
    open_portion_requests: portions.n,
    bills_requested: bills.n,
    blockers,
    server_time: nowIso(),
  };
}
