// Table, category and staff filters for the operational report (D-S8-25).
//
// Not every figure can be split by every filter: a bill belongs to a table but
// not to a dish category, and "how fast were requests answered" belongs to the
// person who answered, not to a category. A figure is therefore narrowed only
// when it supports EVERY active filter; otherwise it is computed with no
// filter at all and listed in `unfiltered`, and the report says so under it.
// That way a number is either exactly what the filter line claims, or plainly
// marked as covering everything.
import type { Bilingual, KpiFigureKey, KpiFilterOptionsDTO, KpiFiltersDTO } from '../../shared/dto.ts';
import { many, one } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { bi } from './pricing.ts';

export type KpiFilters = KpiFiltersDTO;

export const NO_FILTERS: KpiFilters = { table_id: null, category_id: null, staff_id: null };

/** A SQL fragment starting with ` AND ...`, plus only the parameters it uses. */
export interface SqlFilter {
  sql: string;
  params: Record<string, unknown>;
}

const EMPTY: SqlFilter = { sql: '', params: {} };

function combine(parts: Array<[string, Record<string, unknown>] | null>): SqlFilter {
  const used = parts.filter((p): p is [string, Record<string, unknown>] => p !== null);
  if (used.length === 0) return EMPTY;
  return {
    sql: ` AND ${used.map(([sql]) => sql).join(' AND ')}`,
    params: Object.assign({}, ...used.map(([, params]) => params)) as Record<string, unknown>,
  };
}

export function anyFilter(f: KpiFilters): boolean {
  return f.table_id !== null || f.category_id !== null || f.staff_id !== null;
}

/** Which filters each figure can be split by. */
const SUPPORT: Record<KpiFigureKey, { table: boolean; category: boolean; staff: boolean }> = {
  qr_adoption: { table: true, category: false, staff: false },
  guest_order_time: { table: true, category: false, staff: false },
  average_order_value: { table: true, category: true, staff: false },
  average_table_value: { table: true, category: false, staff: false },
  operational_errors: { table: true, category: true, staff: false },
  accept: { table: true, category: true, staff: true },
  ack: { table: true, category: false, staff: true },
  open_bills: { table: true, category: false, staff: false },
  payment_exceptions: { table: true, category: false, staff: false },
  refunds: { table: true, category: false, staff: false },
  totals: { table: true, category: false, staff: false },
  cancellations: { table: true, category: true, staff: false },
  hourly: { table: true, category: true, staff: false },
  service_requests: { table: true, category: false, staff: true },
};

export const KPI_FIGURES = Object.keys(SUPPORT) as KpiFigureKey[];

function supportsAll(key: KpiFigureKey, f: KpiFilters): boolean {
  const s = SUPPORT[key];
  return (!f.table_id || s.table) && (!f.category_id || s.category) && (!f.staff_id || s.staff);
}

/** The filters that apply to one figure: all of them, or none (see the file header). */
export function figureFilters(f: KpiFilters, key: KpiFigureKey): KpiFilters {
  return supportsAll(key, f) ? f : NO_FILTERS;
}

/** Figures the active filters do not narrow (empty when no filter is active). */
export function unfilteredFigures(f: KpiFilters): KpiFigureKey[] {
  if (!anyFilter(f)) return [];
  return KPI_FIGURES.filter((key) => !supportsAll(key, f));
}

// ------------------------------------------------------------------ SQL fragments
/** Conditions on an `orders` row (the round's own table, its dishes, who accepted it). */
export function orderFilter(f: KpiFilters, alias = 'o'): SqlFilter {
  return combine([
    f.table_id ? [`${alias}.table_id = :f_table`, { f_table: f.table_id }] : null,
    f.category_id
      ? [`EXISTS (SELECT 1 FROM order_lines fl WHERE fl.order_id = ${alias}.id AND fl.category_id = :f_category)`, { f_category: f.category_id }]
      : null,
    f.staff_id
      ? [`EXISTS (SELECT 1 FROM line_events fe WHERE fe.order_id = ${alias}.id AND fe.to_status = 'accepted'
                    AND fe.actor_type = 'staff' AND fe.actor_id = :f_staff)`, { f_staff: f.staff_id }]
      : null,
  ]);
}

/**
 * Conditions on an `order_lines` row joined to its order. The category filter
 * selects the lines themselves, so line figures (values, cancellations) count
 * only that category's dishes. No line carries "who accepted it" on its own.
 */
export function lineFilter(f: KpiFilters, lineAlias = 'l', orderAlias = 'o'): SqlFilter {
  return combine([
    f.table_id ? [`${orderAlias}.table_id = :f_table`, { f_table: f.table_id }] : null,
    f.category_id ? [`${lineAlias}.category_id = :f_category`, { f_category: f.category_id }] : null,
  ]);
}

/** Conditions on a `visits` row (where the party sits now, or sat at checkout). */
export function visitFilter(f: KpiFilters, alias = 'v'): SqlFilter {
  return combine([
    f.table_id ? [`${alias}.table_id = :f_table`, { f_table: f.table_id }] : null,
  ]);
}

/** Conditions on a `service_requests` row: its table, and the first staff response. */
export function requestFilter(f: KpiFilters, alias = 's'): SqlFilter {
  return combine([
    f.table_id ? [`${alias}.table_id = :f_table`, { f_table: f.table_id }] : null,
    f.staff_id ? [`${alias}.acknowledged_by_id = :f_staff`, { f_staff: f.staff_id }] : null,
  ]);
}

/** Conditions on a `payments` row (the visit's table; the person is `confirmed_by`). */
export function paymentFilter(f: KpiFilters, alias = 'p'): SqlFilter {
  return combine([
    f.table_id
      ? [`EXISTS (SELECT 1 FROM visits fv WHERE fv.id = ${alias}.visit_id AND fv.table_id = :f_table)`, { f_table: f.table_id }]
      : null,
  ]);
}

// ------------------------------------------------------------------ input and choices
export interface KpiFilterInput {
  table_id?: string | null;
  category_id?: string | null;
  staff_id?: string | null;
}

/** Validate the requested filters against real records; unknown ids are a 422. */
export function resolveFilters(input: KpiFilterInput): KpiFilters {
  const issues: Array<{ path: string; message: string; code: string }> = [];
  const check = (path: 'table_id' | 'category_id' | 'staff_id', sql: string): string | null => {
    const id = input[path] ?? null;
    if (!id) return null;
    if (!one(sql, [id])) {
      issues.push({ path, message: 'Unknown id', code: 'not_found' });
      return null;
    }
    return id;
  };
  const filters: KpiFilters = {
    table_id: check('table_id', 'SELECT 1 AS x FROM dining_tables WHERE id = ?'),
    category_id: check('category_id', 'SELECT 1 AS x FROM menu_categories WHERE id = ?'),
    staff_id: check('staff_id', 'SELECT 1 AS x FROM staff_users WHERE id = ?'),
  };
  if (issues.length) throw new AppError('validation_failed', 'Some filters are not valid', { issues });
  return filters;
}

/**
 * The choices the report offers. Staff are listed from the report itself, so a
 * manager does not need team.manage to filter by a colleague; demo accounts
 * appear only while demo data is included. Archived tables and categories are
 * listed when the current filter uses them, so a chosen filter never
 * disappears from its own select.
 */
export function filterOptions(filters: KpiFilters, includeFixture: boolean): KpiFilterOptionsDTO {
  const tables = many<{ id: string; label: string; sort: number }>(
    `SELECT id, label, sort FROM dining_tables WHERE archived_at IS NULL OR id = :chosen
      ORDER BY sort, label`, { chosen: filters.table_id ?? '' });
  const categories = many<{ id: string; name_th: string | null; name_en: string }>(
    `SELECT c.id, c.name_th, c.name_en FROM menu_categories c
       JOIN menu_groups g ON g.id = c.group_id
      WHERE c.status <> 'archived' OR c.id = :chosen
      ORDER BY g.sort, c.sort, c.key`, { chosen: filters.category_id ?? '' });
  const staff = many<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM staff_users
      WHERE (active = 1 OR id = :chosen) AND (is_fixture = 0 OR :fixture = 1 OR id = :chosen)
      ORDER BY display_name COLLATE NOCASE`, { chosen: filters.staff_id ?? '', fixture: includeFixture ? 1 : 0 });
  return {
    tables: tables.map((t) => ({ id: t.id, label: t.label })),
    categories: categories.map((c) => ({ id: c.id, name: bi(c.name_th, c.name_en) as Bilingual })),
    staff: staff.map((s) => ({ id: s.id, name: s.display_name })),
  };
}
