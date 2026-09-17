// Insights URL state (period, anchor, custom range, metric, menu filters,
// demo-data switch) and the period arithmetic behind previous / next.
// Every view is a URL, so deep links and browser Back work. Choices that
// change what is counted push a history entry; a chart selection, the
// search text and "show all" replace the current entry.
import type { MenuStatsDTO, OrderMetric, StatsPeriod } from '../../../../shared/dto.ts';
import { addDays, businessDate, daysBetween, monthDates, monthStart, weekDates } from '../../../../shared/time.ts';
import { setQuery } from '../../lib/router.ts';

export type InsightsTab = 'orders' | 'menu' | 'engagement';
export type Measure = MenuStatsDTO['measure'];
export type Direction = MenuStatsDTO['direction'];

export const PERIODS: ReadonlyArray<StatsPeriod> = ['week', 'month', 'year', 'custom'];
export const METRICS: ReadonlyArray<OrderMetric> = ['rounds', 'accepted_rounds', 'visits', 'devices', 'diners', 'items'];
export const MEASURES: ReadonlyArray<Measure> = ['net', 'submitted', 'per_available_day', 'grams'];

/** Longest custom range the API accepts (server/domain/aggregates.ts MAX_CUSTOM_DAYS). */
export const MAX_CUSTOM_DAYS = 400;

export interface PeriodState {
  period: StatsPeriod;
  /** Any date inside the wanted week / month / year; null = the current one. */
  anchor: string | null;
  from: string | null;
  to: string | null;
}

export interface Range { from: string; to: string }

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100 && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

export function readPeriod(q: URLSearchParams): PeriodState {
  const p = q.get('period');
  const from = q.get('from');
  const to = q.get('to');
  if ((p === 'custom' || (!p && from && to)) && isDate(from) && isDate(to) && from <= to && daysBetween(from, to) < MAX_CUSTOM_DAYS) {
    return { period: 'custom', anchor: null, from, to };
  }
  const period: StatsPeriod = p === 'month' || p === 'year' ? p : 'week';
  const anchor = q.get('anchor');
  return { period, anchor: isDate(anchor) ? anchor : null, from: null, to: null };
}

/** URL patch for a period (defaults are left out so links stay short). */
export function periodPatch(ps: PeriodState): Record<string, string | null> {
  const custom = ps.period === 'custom';
  return {
    day: null,
    period: ps.period === 'week' ? null : ps.period,
    anchor: custom ? null : ps.anchor,
    from: custom ? ps.from : null,
    to: custom ? ps.to : null,
  };
}

/** API parameters for a period. */
export function periodParams(ps: PeriodState): Record<string, string | null> {
  return ps.period === 'custom'
    ? { period: 'custom', from: ps.from, to: ps.to }
    : { period: ps.period, anchor: ps.anchor };
}

export function readFixture(q: URLSearchParams, demoDefault: boolean): boolean {
  const v = q.get('include_fixture');
  if (v === '1') return true;
  if (v === '0') return false;
  return demoDefault;
}

export function readMetric(q: URLSearchParams): OrderMetric {
  const m = q.get('metric') as OrderMetric | null;
  return m && METRICS.includes(m) ? m : 'rounds';
}

export function readMeasure(q: URLSearchParams): Measure {
  const m = q.get('measure') as Measure | null;
  return m && MEASURES.includes(m) ? m : 'net';
}

export function readDirection(q: URLSearchParams): Direction {
  return q.get('direction') === 'least' ? 'least' : 'most';
}

/** 'food' (default) | 'drinks' | 'all' | a category id. */
export function readCategory(q: URLSearchParams): string {
  const c = q.get('category');
  return c && /^[A-Za-z0-9_-]{1,64}$/.test(c) ? c : 'food';
}

export type TopN = '5' | '10' | 'all';
export function readTop(q: URLSearchParams): TopN {
  const v = q.get('top');
  return v === '5' || v === 'all' ? v : '10';
}

/** Push a change of what is counted (Back returns to the previous view). */
export function pushQuery(patch: Record<string, string | null | undefined>): void {
  setQuery(patch, { replace: false });
}

/** Replace the current entry (selection, search, show all). */
export function replaceQuery(patch: Record<string, string | null | undefined>): void {
  setQuery(patch, { replace: true });
}

export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ period arithmetic

let skewMs = 0;
/** Align "today" with the server clock (PublicConfigDTO.server_time). */
export function setServerTime(iso: string | null | undefined): void {
  if (!iso) return;
  const t = Date.parse(iso);
  if (Number.isFinite(t)) skewMs = t - Date.now();
}

/** Today's business date in Asia/Bangkok (the default 00:00 cutoff, D-11). */
export function today(): string {
  return businessDate(Date.now() + skewMs);
}

export function nowMs(): number {
  return Date.now() + skewMs;
}

/** The dates a period covers, mirroring server/domain/aggregates.ts resolvePeriod. */
export function resolveRange(ps: PeriodState, todayDate = today()): Range {
  const anchor = ps.anchor ?? todayDate;
  switch (ps.period) {
    case 'week': {
      const d = weekDates(anchor);
      return { from: d[0], to: d[6] };
    }
    case 'month': {
      const d = monthDates(anchor);
      return { from: d[0], to: d[d.length - 1] };
    }
    case 'year': {
      const y = anchor.slice(0, 4);
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    case 'custom':
      return { from: ps.from ?? todayDate, to: ps.to ?? todayDate };
  }
}

export function contains(r: Range, date: string): boolean {
  return r.from <= date && date <= r.to;
}

export function rangeDays(r: Range): number {
  return daysBetween(r.from, r.to) + 1;
}

/** The previous (-1) or next (+1) period of the same kind. */
export function shiftPeriod(ps: PeriodState, r: Range, dir: -1 | 1): PeriodState {
  switch (ps.period) {
    case 'week':
      return { ...ps, anchor: addDays(r.from, 7 * dir) };
    case 'month':
      return { ...ps, anchor: dir < 0 ? monthStart(addDays(r.from, -1)) : addDays(r.to, 1) };
    case 'year':
      return { ...ps, anchor: `${Number(r.from.slice(0, 4)) + dir}-01-01` };
    case 'custom': {
      const n = rangeDays(r);
      return { period: 'custom', anchor: null, from: addDays(r.from, n * dir), to: addDays(r.to, n * dir) };
    }
  }
}

/** Switch the period kind while keeping the same place in time. */
export function changePeriodKind(ps: PeriodState, r: Range, next: StatsPeriod, todayDate = today()): PeriodState {
  if (next === 'custom') {
    const to = r.to > todayDate ? todayDate : r.to;
    return { period: 'custom', anchor: null, from: r.from > to ? to : r.from, to };
  }
  const inside = contains(r, todayDate);
  const anchor = inside ? null : ps.period === 'custom' ? r.to : (ps.anchor ?? null);
  return { period: next, anchor, from: null, to: null };
}

/** How many whole periods back from the current one (0 = current). */
export function periodsAgo(ps: PeriodState, r: Range, todayDate = today()): number | null {
  const cur = resolveRange({ ...ps, anchor: null }, todayDate);
  switch (ps.period) {
    case 'week':
      return Math.round(daysBetween(r.from, cur.from) / 7);
    case 'month':
      return (Number(cur.from.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(cur.from.slice(5, 7)) - Number(r.from.slice(5, 7));
    case 'year':
      return Number(cur.from.slice(0, 4)) - Number(r.from.slice(0, 4));
    default:
      return null;
  }
}

/** The last date of the previous period that matches today's place in the current one. */
export function elapsedEquivalent(period: StatsPeriod, cur: Range, prev: Range, todayDate = today()): string {
  let eq: string;
  if (period === 'year') {
    eq = `${prev.from.slice(0, 4)}${todayDate.slice(4)}`;
    if (!isDate(eq)) eq = `${prev.from.slice(0, 4)}-02-28`;
  } else {
    eq = addDays(prev.from, daysBetween(cur.from, todayDate));
  }
  return eq > prev.to ? prev.to : eq;
}
