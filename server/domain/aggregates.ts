// Insight foundations shared by stats.ts, kpi.ts and analytics.ts:
//  - reporting periods (week / month / year / custom) and their buckets,
//  - the "previous equivalent period" window with same-elapsed-span cuts,
//  - percentile helpers, fixture filters, the first operating date,
//  - item availability reconstructed from availability_log,
//  - the rebuildable agg_item_daily table (brief 40: durable facts plus
//    rebuildable daily aggregates, never a mutable year counter).
//
// Every reporting query works on stored business_date columns (Asia/Bangkok,
// stamped at write time, D-11) over inclusive date ranges, which is the same
// as the half-open UTC interval [from 00:00, to+1 00:00) local time.
// See docs/DECISIONS.md "Metric dictionary" (D-S6-*).
import type { StatsPeriod } from '../../shared/dto.ts';
import { LINE_STATUSES, isChargeable } from '../../shared/status.ts';
import {
  addDays, businessDate, businessRangeUtc, daysBetween, monthDates, monthStart, nowIso, weekDates,
} from '../../shared/time.ts';
import { inTransaction, many, one, run, tx } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { cutoffHour } from '../lib/settings.ts';

// ------------------------------------------------------------------ params & clock
export interface StatsParams {
  period?: StatsPeriod;
  /** Any date inside the wanted week/month/year (default: today). */
  anchor?: string | null;
  /** Custom range, inclusive business dates. */
  from?: string | null;
  to?: string | null;
  include_fixture?: boolean;
  /** Clock override (ISO instant) for tests and report snapshots. Routes never pass it. */
  now?: string;
}

export interface Clock {
  iso: string;
  ms: number;
  /** Today's business date (Asia/Bangkok, configured cutoff). */
  today: string;
  cutoff: number;
}

export function clockOf(now?: string): Clock {
  const ms = now ? new Date(now).getTime() : Date.now();
  if (!Number.isFinite(ms)) throw new AppError('validation_failed', 'Invalid clock override');
  const cutoff = cutoffHour();
  return { iso: new Date(ms).toISOString(), ms, today: businessDate(ms, cutoff), cutoff };
}

/** UTC instant (ms) where a business date starts. */
export function dayStartMs(date: string, cutoff: number): number {
  return new Date(businessRangeUtc(date, date, cutoff).start).getTime();
}

/** Longest custom range, in days (a full leap year plus some slack for report appendices). */
export const MAX_CUSTOM_DAYS = 400;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function assertDate(value: string, what: string): string {
  const [y, m, d] = value.split('-').map(Number);
  const real = DATE_RE.test(value) && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d && m >= 1 && m <= 12;
  if (!real) {
    throw new AppError('validation_failed', `${what} must be a real date (YYYY-MM-DD)`, { field: what });
  }
  return value;
}

// ------------------------------------------------------------------ periods & buckets
/** A chart bucket: one business date, or one calendar month in the year view. */
export interface Bucket {
  /** YYYY-MM-DD, or YYYY-MM for months. */
  key: string;
  from: string;
  to: string;
  /** Short English fallback label; clients localise from `key`. */
  label: string;
}

export interface ResolvedPeriod {
  period: StatsPeriod;
  from: string;
  to: string;
  unit: 'day' | 'month';
  buckets: Bucket[];
  /** Number of dates in the period. */
  length: number;
  clock: Clock;
  include_fixture: boolean;
}

function monthBucket(year: number, month: number): Bucket {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const dates = monthDates(`${key}-01`);
  return { key, from: dates[0], to: dates[dates.length - 1], label: MONTH_LABELS[month - 1] };
}

export function resolvePeriod(p: StatsParams): ResolvedPeriod {
  const clock = clockOf(p.now);
  const period: StatsPeriod = p.period ?? 'week';
  const anchor = p.anchor ? assertDate(p.anchor, 'anchor') : clock.today;
  const include_fixture = p.include_fixture === true;
  let from: string;
  let to: string;
  let unit: 'day' | 'month' = 'day';
  let buckets: Bucket[];

  switch (period) {
    case 'week': {
      const dates = weekDates(anchor);
      from = dates[0];
      to = dates[6];
      buckets = dates.map((d, i) => ({ key: d, from: d, to: d, label: WEEKDAY_LABELS[i] }));
      break;
    }
    case 'month': {
      const dates = monthDates(anchor);
      from = dates[0];
      to = dates[dates.length - 1];
      buckets = dates.map((d) => ({ key: d, from: d, to: d, label: String(Number(d.slice(8))) }));
      break;
    }
    case 'year': {
      const year = Number(anchor.slice(0, 4));
      from = `${year}-01-01`;
      to = `${year}-12-31`;
      unit = 'month';
      buckets = Array.from({ length: 12 }, (_, i) => monthBucket(year, i + 1));
      break;
    }
    case 'custom': {
      if (!p.from || !p.to) throw new AppError('validation_failed', 'A custom range needs from and to', { fields: ['from', 'to'] });
      from = assertDate(p.from, 'from');
      to = assertDate(p.to, 'to');
      if (from > to) throw new AppError('validation_failed', 'from must not be after to', { fields: ['from', 'to'] });
      const n = daysBetween(from, to) + 1;
      if (n > MAX_CUSTOM_DAYS) throw new AppError('validation_failed', `A custom range can cover at most ${MAX_CUSTOM_DAYS} days`, { max_days: MAX_CUSTOM_DAYS });
      buckets = Array.from({ length: n }, (_, i) => {
        const d = addDays(from, i);
        return { key: d, from: d, to: d, label: d.slice(5) };
      });
      break;
    }
  }
  return { period, from, to, unit, buckets, length: daysBetween(from, to) + 1, clock, include_fixture };
}

/** Every business date from..to inclusive. */
export function datesBetween(from: string, to: string): string[] {
  if (from > to) return [];
  return Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
}

export type BucketState = 'complete' | 'partial' | 'future' | 'missing';

/**
 * State of a bucket (D-S6-03): future = starts after today; partial = contains
 * today; missing = ends before the first operating date (or nothing has ever
 * operated); otherwise complete (a real zero is a complete zero).
 */
export function bucketState(b: Bucket, today: string, firstDate: string | null): BucketState {
  if (b.from > today) return 'future';
  if (b.from <= today && today <= b.to) return 'partial';
  if (firstDate === null || b.to < firstDate) return 'missing';
  return 'complete';
}

// ------------------------------------------------------------------ comparison window
export interface CompareWindow {
  from: string;
  to: string;
  /** Only records stamped before this instant count (same elapsed span); null = whole period. */
  cutIso: string | null;
  comparable: boolean;
  /** Machine code the client translates (see D-S6-04). */
  note: string | null;
  /** false when there is nothing to compare with (previous total must be null). */
  hasBaseline: boolean;
}

function sameMonthDay(date: string, year: number): string {
  const md = date.slice(5);
  // 29 Feb in a non-leap year falls back to 28 Feb.
  const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
  return md === '02-29' && !leap ? `${year}-02-28` : `${year}-${md}`;
}

/**
 * The preceding equivalent period (D-S6-04). When the current period contains
 * today, only the same elapsed span of the previous period is compared: the
 * same number of days in, up to the same local time of day.
 */
export function previousWindow(rp: ResolvedPeriod, firstDate: string | null): CompareWindow {
  const { from, to, clock } = rp;
  let prevFrom: string;
  let prevTo: string;
  switch (rp.period) {
    case 'week':
      prevFrom = addDays(from, -7);
      prevTo = addDays(to, -7);
      break;
    case 'month':
      prevTo = addDays(from, -1);
      prevFrom = monthStart(prevTo);
      break;
    case 'year': {
      const y = Number(from.slice(0, 4)) - 1;
      prevFrom = `${y}-01-01`;
      prevTo = `${y}-12-31`;
      break;
    }
    default:
      prevTo = addDays(from, -1);
      prevFrom = addDays(from, -rp.length);
  }

  const base = { from: prevFrom, to: prevTo };
  if (from > clock.today) return { ...base, cutIso: null, comparable: false, note: 'future_period', hasBaseline: false };
  if (firstDate === null) return { ...base, cutIso: null, comparable: false, note: 'no_data_yet', hasBaseline: false };
  if (prevTo < firstDate) return { ...base, cutIso: null, comparable: false, note: 'no_prior_data', hasBaseline: false };

  let cutIso: string | null = null;
  let note: string | null = null;
  if (from <= clock.today && clock.today <= to) {
    const elapsed = daysBetween(from, clock.today);
    let equivalent: string;
    if (rp.period === 'year') equivalent = sameMonthDay(clock.today, Number(prevFrom.slice(0, 4)));
    else equivalent = addDays(prevFrom, elapsed);
    if (equivalent > prevTo) equivalent = prevTo;
    const intoDay = clock.ms - dayStartMs(clock.today, clock.cutoff);
    cutIso = new Date(dayStartMs(equivalent, clock.cutoff) + intoDay).toISOString();
    note = 'same_elapsed_span';
  }
  if (prevFrom < firstDate) return { ...base, cutIso, comparable: false, note: 'prior_partial_coverage', hasBaseline: true };
  return { ...base, cutIso, comparable: true, note, hasBaseline: true };
}

export interface Change {
  absolute: number | null;
  percent: number | null;
  label: 'up' | 'down' | 'flat' | 'no_baseline' | 'unequal_coverage';
}

/** Change vs the previous window. Never an infinite percentage (D-S6-04). */
export function compareTotals(current: number, previous: number | null, w: CompareWindow): Change {
  if (previous === null || !w.hasBaseline) return { absolute: null, percent: null, label: 'no_baseline' };
  if (!w.comparable) return { absolute: round2(current - previous), percent: null, label: 'unequal_coverage' };
  if (previous === 0) return { absolute: round2(current), percent: null, label: 'no_baseline' };
  const percent = Math.round(((current - previous) / previous) * 1000) / 10;
  return { absolute: round2(current - previous), percent, label: current > previous ? 'up' : current < previous ? 'down' : 'flat' };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------------ percentiles
/** Median (mean of the two middle values for an even sample). */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1];
}

export function distribution(values: number[]): { median: number | null; p90: number | null; sample: number } {
  const m = median(values);
  const p = percentile(values, 90);
  return { median: m === null ? null : Math.round(m), p90: p === null ? null : Math.round(p), sample: values.length };
}

// ------------------------------------------------------------------ SQL helpers
/** SQL list of chargeable line statuses, derived from the shared state machine. */
export const CHARGEABLE_SQL = `(${LINE_STATUSES.filter(isChargeable).map((s) => `'${s}'`).join(',')})`;

/** Fixture filter for a table alias: real reports exclude demo data (D-10). */
export function fixtureSql(alias: string, include: boolean): string {
  return include ? '1 = 1' : `${alias}.is_fixture = 0`;
}

/** First operating date = earliest seated business date of a visit in scope (D-S6-03). */
export function firstOperatingDate(include: boolean): string | null {
  return one<{ d: string | null }>(`SELECT MIN(v.seated_business_date) AS d FROM visits v WHERE ${fixtureSql('v', include)}`)?.d ?? null;
}

export function secondsBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000;
}

// ------------------------------------------------------------------ availability
export interface ItemAvailability {
  /** false when the item has no availability_log rows at all. */
  known: boolean;
  /** When the item's log starts (before that its state is unknown). */
  firstLogMs: number | null;
  /** First moment the log shows the item available (for the "new" label). */
  firstAvailableMs: number | null;
  /** Half-open [start, end) UTC ms intervals while available, ended at `now` at the latest. */
  intervals: Array<[number, number]>;
}

const UNKNOWN: ItemAvailability = { known: false, firstLogMs: null, firstAvailableMs: null, intervals: [] };

/**
 * Rebuild availability intervals for every logged item from availability_log.
 * Before an item's first log row its state is unknown and treated as not
 * available; each row sets the new state from `changed_at` onwards.
 */
export function loadAvailability(nowMs: number): Map<string, ItemAvailability> {
  const rows = many<{ item_id: string; available: number; changed_at: string }>(
    `SELECT item_id, available, changed_at FROM availability_log WHERE changed_at <= :now ORDER BY item_id, changed_at, id`,
    { now: new Date(nowMs).toISOString() },
  );
  const out = new Map<string, ItemAvailability>();
  let current: { id: string; av: ItemAvailability; openSince: number | null } | null = null;
  const close = () => {
    if (current && current.openSince !== null && nowMs > current.openSince) current.av.intervals.push([current.openSince, nowMs]);
  };
  for (const r of rows) {
    if (!current || current.id !== r.item_id) {
      close();
      current = { id: r.item_id, av: { known: true, firstLogMs: new Date(r.changed_at).getTime(), firstAvailableMs: null, intervals: [] }, openSince: null };
      out.set(r.item_id, current.av);
    }
    const at = new Date(r.changed_at).getTime();
    if (r.available === 1) {
      if (current.av.firstAvailableMs === null) current.av.firstAvailableMs = at;
      if (current.openSince === null) current.openSince = at;
    } else if (current.openSince !== null) {
      if (at > current.openSince) current.av.intervals.push([current.openSince, at]);
      current.openSince = null;
    }
  }
  close();
  return out;
}

export function availabilityOf(map: Map<string, ItemAvailability>, itemId: string): ItemAvailability {
  return map.get(itemId) ?? UNKNOWN;
}

export function overlapMs(av: ItemAvailability, startMs: number, endMs: number): number {
  let total = 0;
  for (const [a, b] of av.intervals) {
    const lo = Math.max(a, startMs);
    const hi = Math.min(b, endMs);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/**
 * Available days in [from, to] up to now: a business date counts when the item
 * was available at any moment of it (D-S6-07). null when there is no log.
 */
export function availableDays(av: ItemAvailability, from: string, to: string, clock: Clock): number | null {
  if (!av.known) return null;
  const last = to < clock.today ? to : clock.today;
  let n = 0;
  for (const d of datesBetween(from, last)) {
    const start = dayStartMs(d, clock.cutoff);
    if (overlapMs(av, start, Math.min(start + 86_400_000, clock.ms)) > 0) n++;
  }
  return n;
}

// ------------------------------------------------------------------ agg_item_daily
export interface RefreshResult { from: string; to: string; days: number; rows: number; built_at: string }

export const AGG_STATE_NAME = 'agg_item_daily';

export function aggFreshness(): { built_through: string | null; built_at: string | null } {
  const r = one<{ built_through: string | null; built_at: string }>('SELECT built_through, built_at FROM agg_state WHERE name = ?', [AGG_STATE_NAME]);
  return { built_through: r?.built_through ?? null, built_at: r?.built_at ?? null };
}

function earliestDataDate(cutoff: number): string | null {
  const r = one<{ o: string | null; e: string | null; a: string | null }>(
    `SELECT (SELECT MIN(business_date) FROM orders) AS o,
            (SELECT MIN(business_date) FROM analytics_events) AS e,
            (SELECT MIN(changed_at) FROM availability_log) AS a`);
  const candidates = [r?.o, r?.e, r?.a ? businessDate(r.a, cutoff) : null].filter((v): v is string => Boolean(v));
  return candidates.length ? candidates.sort()[0] : null;
}

interface AggRow {
  item_id: string; is_fixture: number;
  impressions: number; detail_opens: number; detail_active_ms: number; adds: number; add_qty: number;
  submitted_qty: number; net_qty: number; grams: number; orders: number;
}

function blankAgg(itemId: string, fixture: number): AggRow {
  return { item_id: itemId, is_fixture: fixture, impressions: 0, detail_opens: 0, detail_active_ms: 0, adds: 0, add_qty: 0, submitted_qty: 0, net_qty: 0, grams: 0, orders: 0 };
}

function rebuildDay(date: string, availability: Map<string, ItemAvailability>, clock: Clock): number {
  const rows = new Map<string, AggRow>();
  const get = (itemId: string, fixture: number) => {
    const key = `${itemId}|${fixture}`;
    let r = rows.get(key);
    if (!r) { r = blankAgg(itemId, fixture); rows.set(key, r); }
    return r;
  };

  for (const l of many<{ item_id: string; is_fixture: number; submitted_qty: number; net_qty: number; grams: number; orders: number }>(
    `SELECT l.item_id, o.is_fixture,
            SUM(l.quantity) AS submitted_qty,
            SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.quantity ELSE 0 END) AS net_qty,
            SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN COALESCE(l.measured_grams, 0) ELSE 0 END) AS grams,
            COUNT(DISTINCT CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.order_id END) AS orders
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.business_date = :date
      GROUP BY l.item_id, o.is_fixture`, { date })) {
    Object.assign(get(l.item_id, l.is_fixture), { submitted_qty: l.submitted_qty, net_qty: l.net_qty, grams: l.grams, orders: l.orders });
  }

  for (const e of many<{ item_id: string; is_fixture: number; impressions: number; detail_opens: number; detail_active_ms: number; adds: number; add_qty: number }>(
    `SELECT item_id, is_fixture,
            SUM(type = 'item_impression') AS impressions,
            SUM(type = 'item_detail_open') AS detail_opens,
            SUM(CASE WHEN type = 'item_detail_active_time' THEN COALESCE(active_ms, 0) ELSE 0 END) AS detail_active_ms,
            SUM(type = 'cart_add') AS adds,
            SUM(CASE WHEN type = 'cart_add' THEN COALESCE(quantity_delta, 0) ELSE 0 END) AS add_qty
       FROM analytics_events
      WHERE business_date = :date AND item_id IS NOT NULL
      GROUP BY item_id, is_fixture`, { date })) {
    Object.assign(get(e.item_id, e.is_fixture), {
      impressions: e.impressions, detail_opens: e.detail_opens, detail_active_ms: e.detail_active_ms, adds: e.adds, add_qty: e.add_qty,
    });
  }

  // Availability is a property of the item, not of demo data: every logged
  // item gets a real-data row for the day once its log has started.
  const start = dayStartMs(date, clock.cutoff);
  const end = Math.min(start + 86_400_000, clock.ms);
  const minutes = new Map<string, number>();
  for (const [itemId, av] of availability) {
    if (av.firstLogMs === null || av.firstLogMs >= start + 86_400_000) continue;
    minutes.set(itemId, end > start ? Math.round(overlapMs(av, start, end) / 60_000) : 0);
    get(itemId, 0);
  }

  run('DELETE FROM agg_item_daily WHERE business_date = ?', [date]);
  for (const r of rows.values()) {
    run(
      `INSERT INTO agg_item_daily (business_date, item_id, is_fixture, impressions, detail_opens, detail_active_ms, adds, add_qty,
                                   submitted_qty, net_qty, grams, orders, available_minutes)
       VALUES (:date, :item_id, :is_fixture, :impressions, :detail_opens, :detail_active_ms, :adds, :add_qty,
               :submitted_qty, :net_qty, :grams, :orders, :available_minutes)`,
      { date, ...r, available_minutes: minutes.has(r.item_id) ? minutes.get(r.item_id)! : null },
    );
  }
  return rows.size;
}

/**
 * Rebuild agg_item_daily for [fromDate, toDate] (default: from the last built
 * date, or the earliest data, through today). Each date is deleted and
 * re-inserted in its own transaction, so a crash mid-way leaves every date
 * either old-and-whole or new-and-whole; re-running is always safe.
 * Not for use inside another transaction.
 */
export function refreshAggregates(fromDate?: string, toDate?: string, opts: { now?: string } = {}): RefreshResult {
  if (inTransaction()) throw new Error('refreshAggregates() must not run inside a transaction');
  const clock = clockOf(opts.now);
  const state = aggFreshness();
  const to = toDate ? assertDate(toDate, 'to') : clock.today;
  const from = fromDate ? assertDate(fromDate, 'from') : (state.built_through ?? earliestDataDate(clock.cutoff) ?? to);
  const dates = datesBetween(from, to);
  const availability = loadAvailability(clock.ms);
  let rowCount = 0;
  for (const d of dates) rowCount += tx(() => rebuildDay(d, availability, clock));
  const builtAt = nowIso();
  tx(() => {
    const through = state.built_through && state.built_through > to ? state.built_through : to;
    run(
      `INSERT INTO agg_state (name, built_through, built_at, data_version) VALUES (:name, :through, :at, 1)
       ON CONFLICT(name) DO UPDATE SET built_through = :through, built_at = :at, data_version = data_version + 1`,
      { name: AGG_STATE_NAME, through, at: builtAt },
    );
  });
  return { from, to, days: dates.length, rows: rowCount, built_at: builtAt };
}

// ------------------------------------------------------------------ shared order timing
/**
 * Seconds from submission to first acceptance for rounds in [from, to] that
 * waited for acceptance: guest, staff-assisted and portion rounds. Recovered
 * paper rounds are excluded; they carry no acceptance time (D-25, D-S6-05).
 */
export function acceptanceSeconds(from: string, to: string, include: boolean): number[] {
  return many<{ s: string; a: string | null }>(
    `SELECT o.submitted_at AS s,
            COALESCE(o.first_accepted_at, (SELECT MIN(l.accepted_at) FROM order_lines l WHERE l.order_id = o.id)) AS a
       FROM orders o
      WHERE o.business_date BETWEEN :from AND :to AND o.source <> 'manual_recovery' AND ${fixtureSql('o', include)}`,
    { from, to },
  )
    .filter((r) => r.a !== null)
    .map((r) => secondsBetween(r.s, r.a as string))
    .filter((s) => s >= 0);
}

/** Business-day hour order (cutoff first) so hourly charts read like a trading day. */
export function businessHours(cutoff: number): number[] {
  return Array.from({ length: 24 }, (_, i) => (cutoff + i) % 24);
}
