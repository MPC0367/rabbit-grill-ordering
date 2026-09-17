// Order Stats (brief 37) and Menu Stats (brief 38).
//
// Everything here is read-only and computed live from the durable facts
// (orders, order_lines, visits, availability_log, analytics_events), so a
// figure is always as fresh as `generated_at`. Distinct metrics are recomputed
// for each bucket and again for the whole period; they are never summed.
// Definitions: docs/DECISIONS.md, "Metric dictionary" (D-S6-*).
import type {
  Bilingual, DayBucketDTO, DayDrilldownDTO, ItemStatsDTO, MenuStatsDTO, OrderMetric, OrderStatsDTO, RankingRowDTO,
} from '../../shared/dto.ts';
import { deriveOrderStatus, isActive, isChargeable, type LineStatus, type OrderStatus, type PricingType } from '../../shared/status.ts';
import { addDays, bangkokParts, nowIso, weekStart } from '../../shared/time.ts';
import { many, one } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { getSettings } from '../lib/settings.ts';
import { NO_FILTERS, orderFilter, type KpiFilters } from './kpi-filters.ts';
import { bi } from './pricing.ts';
import {
  CHARGEABLE_SQL, acceptanceSeconds, assertDate, availabilityOf, availableDays, bucketState, businessHours,
  compareTotals, datesBetween, dayStartMs, distribution, firstOperatingDate, fixtureSql, loadAvailability,
  previousWindow, resolvePeriod, round2, type Clock, type CompareWindow, type ItemAvailability, type ResolvedPeriod,
  type StatsParams,
} from './aggregates.ts';

// ================================================================== order stats
export interface OrderStatsParams extends StatsParams {
  metric?: OrderMetric;
}

/** One submitted round with its line summary (current line statuses). */
interface OrderFact {
  id: string;
  visit_id: string;
  business_date: string;
  source: string;
  guest_session_id: string | null;
  lines: number;
  chargeable_lines: number;
  chargeable_qty: number;
  pending_lines: number;
  rejected_lines: number;
}

interface SeatedVisit { seated_business_date: string; covers: number | null }

type Breakdown = DayBucketDTO['breakdown'];

// INDEXED BY: without it, GROUP BY o.id makes SQLite walk the whole orders
// primary key instead of the business_date range.
function loadOrderFacts(from: string, to: string, include: boolean, cutIso: string | null = null): OrderFact[] {
  return many<OrderFact>(
    `SELECT o.id, o.visit_id, o.business_date, o.source, o.guest_session_id,
            COUNT(l.id) AS lines,
            COALESCE(SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN 1 ELSE 0 END), 0) AS chargeable_lines,
            COALESCE(SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.quantity ELSE 0 END), 0) AS chargeable_qty,
            COALESCE(SUM(CASE WHEN l.status = 'submitted' THEN 1 ELSE 0 END), 0) AS pending_lines,
            COALESCE(SUM(CASE WHEN l.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected_lines
       FROM orders o INDEXED BY orders_business_date LEFT JOIN order_lines l ON l.order_id = o.id
      WHERE o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}
        AND (:cut IS NULL OR o.submitted_at < :cut)
      GROUP BY o.id`,
    { from, to, cut: cutIso },
  );
}

function loadSeatedVisits(from: string, to: string, include: boolean, cutIso: string | null = null): SeatedVisit[] {
  return many<SeatedVisit>(
    `SELECT v.seated_business_date, v.covers FROM visits v
      WHERE v.seated_business_date BETWEEN :from AND :to AND ${fixtureSql('v', include)}
        AND (:cut IS NULL OR v.seated_at < :cut)`,
    { from, to, cut: cutIso },
  );
}

/**
 * Round outcome (D-S6-01), mutually exclusive: accepted (>= 1 chargeable line),
 * else pending (>= 1 line still submitted), else rejected (every line
 * rejected), else cancelled. submitted = all four.
 */
function outcome(f: OrderFact): 'accepted' | 'pending' | 'rejected' | 'cancelled' {
  if (f.chargeable_lines > 0) return 'accepted';
  if (f.pending_lines > 0) return 'pending';
  if (f.lines > 0 && f.rejected_lines === f.lines) return 'rejected';
  return 'cancelled';
}

function breakdownOf(facts: OrderFact[], seated: SeatedVisit[]): Breakdown {
  const b: Breakdown = {
    submitted: facts.length, accepted: 0, rejected: 0, cancelled: 0, visits: 0, devices: 0, diners: 0,
    diners_coverage: { with_covers: 0, visits: seated.length }, items: 0,
  };
  const visits = new Set<string>();
  const devices = new Set<string>();
  for (const f of facts) {
    const o = outcome(f);
    if (o === 'accepted') b.accepted++;
    else if (o === 'rejected') b.rejected++;
    else if (o === 'cancelled') b.cancelled++;
    visits.add(f.visit_id);
    if (f.source === 'guest' && f.guest_session_id) devices.add(f.guest_session_id);
    b.items += f.chargeable_qty;
  }
  b.visits = visits.size;
  b.devices = devices.size;
  for (const v of seated) {
    if (v.covers !== null) {
      b.diners += v.covers;
      b.diners_coverage.with_covers++;
    }
  }
  return b;
}

const METRIC_FIELD: Record<OrderMetric, keyof Omit<Breakdown, 'diners_coverage'>> = {
  rounds: 'submitted',
  accepted_rounds: 'accepted',
  visits: 'visits',
  devices: 'devices',
  diners: 'diners',
  items: 'items',
};

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function todayCards(clock: Clock, include: boolean): OrderStatsDTO['cards'] {
  const today = clock.today;
  const b = breakdownOf(loadOrderFacts(today, today, include), loadSeatedVisits(today, today, include));
  const accept = distribution(acceptanceSeconds(today, today, include));
  const unresolved = one<{ n: number }>(
    `SELECT COUNT(DISTINCT o.id) AS n FROM orders o
       JOIN visits v ON v.id = o.visit_id
       JOIN order_lines l ON l.order_id = o.id
      WHERE v.status <> 'closed' AND l.status IN ('submitted','accepted','preparing','almost_done','ready')
        AND ${fixtureSql('o', include)}`)?.n ?? 0;
  return {
    orders_today: b.submitted,
    visits_ordering_today: b.visits,
    diners_today: b.diners,
    diners_coverage_today: b.diners_coverage,
    median_accept_seconds: accept.median,
    accept_sample: accept.sample,
    unresolved_orders: unresolved,
  };
}

/** Weekly / monthly / yearly / custom order activity for one metric. */
export function orderStats(q: OrderStatsParams): OrderStatsDTO {
  const rp = resolvePeriod(q);
  const metric: OrderMetric = q.metric ?? 'rounds';
  const include = rp.include_fixture;
  const field = METRIC_FIELD[metric];
  const first = firstOperatingDate(include);

  const facts = loadOrderFacts(rp.from, rp.to, include);
  const seated = loadSeatedVisits(rp.from, rp.to, include);
  const bucketOf = (date: string) => (rp.unit === 'month' ? date.slice(0, 7) : date);
  const factsBy = groupBy(facts, (f) => bucketOf(f.business_date));
  const seatedBy = groupBy(seated, (v) => bucketOf(v.seated_business_date));

  const buckets: DayBucketDTO[] = rp.buckets.map((bk) => {
    const state = bucketState(bk, rp.clock.today, first);
    const breakdown = breakdownOf(factsBy.get(bk.key) ?? [], seatedBy.get(bk.key) ?? []);
    const value = state === 'future' || state === 'missing' ? null : breakdown[field];
    return { date: bk.key, label: bk.label, state, value, breakdown };
  });

  const total = breakdownOf(facts, seated)[field];
  const w = previousWindow(rp, first);
  const previousTotal = w.hasBaseline
    ? breakdownOf(loadOrderFacts(w.from, w.to, include, w.cutIso), loadSeatedVisits(w.from, w.to, include, w.cutIso))[field]
    : null;

  return {
    metric,
    period: rp.period,
    from: rp.from,
    to: rp.to,
    buckets,
    total,
    previous: { from: w.from, to: w.to, total: previousTotal, comparable: w.comparable, note: w.note },
    change: compareTotals(total, previousTotal, w),
    cards: todayCards(rp.clock, include),
    include_fixture: include,
    generated_at: nowIso(),
    first_operating_date: first,
  };
}

// ================================================================== rounds & day drill-down
export interface RoundRow {
  id: string;
  reference: string;
  business_date: string;
  table_label: string;
  submitted_at: string;
  /** Original paper time for recovered rounds, else submitted_at. */
  local_at: string;
  source: string;
  round_no: number;
  status: OrderStatus;
  /** Quantity of lines that are not rejected or cancelled (pending included). */
  items: number;
  /** Quantity of chargeable lines (the Items metric). */
  chargeable_items: number;
  /** Value of lines that are not rejected or cancelled; null without billing.view. */
  subtotal_minor: number | null;
}

/**
 * Every round submitted in [from, to], oldest first, with its current status.
 * `filters` is the operational report's table / category / staff scope, so the
 * CSV behind a filtered figure lists the same rounds (D-S8-25).
 */
export function listRounds(from: string, to: string, include: boolean, showMoney: boolean, filters: KpiFilters = NO_FILTERS): RoundRow[] {
  const f = orderFilter(filters);
  const orders = many<{ id: string; reference: string; business_date: string; table_label: string; submitted_at: string; local_at: string; source: string; round_no: number }>(
    `SELECT o.id, o.reference, o.business_date, o.table_label, o.submitted_at, o.source, o.round_no,
            COALESCE(o.manual_original_time, o.submitted_at) AS local_at
       FROM orders o
      WHERE o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}${f.sql}
      ORDER BY o.business_date, o.submitted_at, o.id`,
    { from, to, ...f.params },
  );
  const lines = groupBy(
    many<{ order_id: string; status: LineStatus; quantity: number; line_total_minor: number }>(
      `SELECT l.order_id, l.status, l.quantity, l.line_total_minor
         FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}${f.sql}`,
      { from, to, ...f.params },
    ),
    (l) => l.order_id,
  );
  return orders.map((o) => {
    const ls = lines.get(o.id) ?? [];
    const active = ls.filter((l) => isActive(l.status));
    return {
      ...o,
      status: deriveOrderStatus(ls),
      items: active.reduce((sum, l) => sum + l.quantity, 0),
      chargeable_items: ls.filter((l) => isChargeable(l.status)).reduce((sum, l) => sum + l.quantity, 0),
      subtotal_minor: showMoney ? active.reduce((sum, l) => sum + l.line_total_minor, 0) : null,
    };
  });
}

export interface DayDrilldownParams {
  include_fixture?: boolean;
  /** Caller holds billing.view: include order values. */
  showMoney?: boolean;
}

/**
 * The rounds submitted on one business date, with the table label snapshot
 * taken at submission, and an hourly breakdown (Bangkok clock hours, listed
 * from the business-day cutoff; hourly items = the Items metric).
 */
export function dayDrilldown(date: string, q: DayDrilldownParams = {}): DayDrilldownDTO {
  assertDate(date, 'date');
  const include = q.include_fixture === true;
  const rounds = listRounds(date, date, include, q.showMoney === true);
  const hourly = new Map(businessHours(getSettings().business_day_cutoff_hour).map((h) => [h, { hour: h, rounds: 0, items: 0 }]));
  for (const r of rounds) {
    const hour = hourly.get(bangkokParts(r.local_at).hour)!;
    hour.rounds++;
    hour.items += r.chargeable_items;
  }
  return {
    date,
    orders: rounds.map((r) => ({
      id: r.id, reference: r.reference, table_label: r.table_label, submitted_at: r.submitted_at,
      source: r.source, items: r.items, status: r.status, subtotal_minor: r.subtotal_minor,
    })),
    hourly: [...hourly.values()],
    include_fixture: include,
    generated_at: nowIso(),
  };
}

// ================================================================== menu stats
export type MenuDirection = MenuStatsDTO['direction'];
export type MenuMeasure = MenuStatsDTO['measure'];

export interface MenuStatsParams extends StatsParams {
  category?: string | null;
  direction?: MenuDirection;
  measure?: MenuMeasure;
}

export const TIE_POLICY =
  'Competition ranking (1, 2, 2, 4): items with equal values share a rank and the next rank is skipped. ' +
  'Tied rows are listed by English name, then Thai name, then item key. Items without a value for the ' +
  'selected measure (no availability log) are listed last with a shared rank.';

interface ItemCatalogRow {
  id: string; key: string; name_th: string | null; name_en: string | null; status: string;
  review_status: string; demo_orderable: number; pricing_type: PricingType;
  price_minor: number | null; rate_minor: number | null; rate_basis_grams: number | null;
  alcohol: number; image: string | null; category_id: string;
  cat_name_th: string | null; cat_name_en: string; cat_status: string; cat_seasonal: number;
  cat_active_from: string | null; cat_active_until: string | null; cat_alcohol: number;
}

interface ItemTotals { net: number; submitted: number; grams: number; orders: number; visits: number }

function itemCatalog(): ItemCatalogRow[] {
  return many<ItemCatalogRow>(
    `SELECT i.id, i.key, i.name_th, i.name_en, i.status, i.review_status, i.demo_orderable, i.pricing_type,
            i.price_minor, i.rate_minor, i.rate_basis_grams, i.alcohol, i.image, i.category_id,
            c.name_th AS cat_name_th, c.name_en AS cat_name_en, c.status AS cat_status, c.seasonal AS cat_seasonal,
            c.active_from AS cat_active_from, c.active_until AS cat_active_until, c.alcohol AS cat_alcohol
       FROM menu_items i JOIN menu_categories c ON c.id = i.category_id`);
}

/** Per-item quantities for rounds submitted in [from, to] (optionally before `cut`). */
function itemTotals(from: string, to: string, include: boolean, cutIso: string | null = null, itemId: string | null = null): Map<string, ItemTotals> {
  const rows = many<ItemTotals & { item_id: string }>(
    `SELECT l.item_id,
            SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.quantity ELSE 0 END) AS net,
            SUM(l.quantity) AS submitted,
            SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN COALESCE(l.measured_grams, 0) ELSE 0 END) AS grams,
            COUNT(DISTINCT CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.order_id END) AS orders,
            COUNT(DISTINCT CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.visit_id END) AS visits
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}
        AND (:cut IS NULL OR o.submitted_at < :cut)
        AND (:item IS NULL OR l.item_id = :item)
      GROUP BY l.item_id`,
    { from, to, cut: cutIso, item: itemId },
  );
  return new Map(rows.map((r) => [r.item_id, r]));
}

/** Variant breakdown (net quantity) per item; names follow the current variant, else the line snapshot. */
function variantTotals(from: string, to: string, include: boolean, itemId: string | null = null): Map<string, Array<{ name: Bilingual; net_qty: number }>> {
  const rows = many<{ item_id: string; variant_id: string; th: string | null; en: string | null; snap_th: string | null; snap_en: string | null; net: number }>(
    `SELECT l.item_id, l.variant_id, v.name_th AS th, v.name_en AS en,
            MAX(l.variant_name_th) AS snap_th, MAX(l.variant_name_en) AS snap_en,
            SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.quantity ELSE 0 END) AS net
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       LEFT JOIN item_variants v ON v.id = l.variant_id
      WHERE o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}
        AND l.variant_id IS NOT NULL AND (:item IS NULL OR l.item_id = :item)
      GROUP BY l.item_id, l.variant_id
      ORDER BY net DESC, l.variant_id`,
    { from, to, item: itemId },
  );
  const out = new Map<string, Array<{ name: Bilingual; net_qty: number }>>();
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push({ name: bi(r.th ?? r.snap_th, r.en ?? r.snap_en), net_qty: r.net });
    out.set(r.item_id, list);
  }
  return out;
}

/**
 * Could this item be ordered at all (ignoring sold-out, which availability covers)?
 * With an availability log (`logged`), today's alcohol and operating-mode
 * settings are not applied to the past: the log records when those settings
 * switched the dish on or off (D-S8-12).
 */
function orderableInPrinciple(item: ItemCatalogRow, variantPriced: Set<string>, logged: boolean): boolean {
  const s = getSettings();
  if (item.status !== 'published' || item.cat_status !== 'published') return false;
  if (!logged && (item.alcohol === 1 || item.cat_alcohol === 1) && !s.alcohol.enabled) return false;
  const priced = item.pricing_type === 'fixed' ? item.price_minor !== null
    : item.pricing_type === 'variant' ? variantPriced.has(item.id)
      : item.rate_minor !== null && item.rate_basis_grams !== null;
  if (!priced) return false;
  if (item.review_status === 'verified') return true;
  return (logged || s.operating_mode === 'demo') && item.demo_orderable === 1;
}

/** A seasonal category whose active window misses the whole period. */
function seasonallyInactive(item: ItemCatalogRow, from: string, to: string): boolean {
  if (item.cat_seasonal !== 1) return false;
  if (item.cat_active_from && item.cat_active_from > to) return true;
  if (item.cat_active_until && item.cat_active_until < from) return true;
  return false;
}

export function availabilityLabel(days: number | null, periodDays: number): RankingRowDTO['availability'] {
  if (days === null) return 'unknown';
  if (days < 2 || days < 0.25 * periodDays) return 'insufficient';
  if (days >= periodDays) return 'full';
  return 'partial';
}

/** The span over which availability is judged: elapsed days, from the first operating date. */
function availabilitySpan(rp: ResolvedPeriod, first: string | null): { from: string; to: string; days: number } {
  const from = first && first > rp.from ? first : rp.from;
  const to = rp.to < rp.clock.today ? rp.to : rp.clock.today;
  return { from, to, days: datesBetween(from, to).length };
}

/** First business date the item was ever ordered (only needed for items without an availability log). */
function firstOrderDate(itemId: string, include: boolean): string | null {
  return one<{ d: string | null }>(
    `SELECT MIN(o.business_date) AS d FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.item_id = ? AND ${fixtureSql('o', include)}`, [itemId])?.d ?? null;
}

function isNewInPeriod(itemId: string, av: ItemAvailability, rp: ResolvedPeriod): boolean {
  if (av.firstAvailableMs !== null) {
    return av.firstAvailableMs >= dayStartMs(rp.from, rp.clock.cutoff) && av.firstAvailableMs < dayStartMs(addDays(rp.to, 1), rp.clock.cutoff);
  }
  const first = firstOrderDate(itemId, rp.include_fixture);
  return first !== null && first >= rp.from && first <= rp.to;
}

function itemChange(net: number, prev: number | null, isNew: boolean, w: CompareWindow): RankingRowDTO['change'] {
  if (isNew) return { previous: prev, label: 'new', delta: null };
  if (prev === null) return { previous: null, label: 'no_baseline', delta: null };
  if (!w.comparable || prev === 0) return { previous: prev, label: 'no_baseline', delta: net - prev };
  return { previous: prev, label: net > prev ? 'up' : net < prev ? 'down' : 'flat', delta: net - prev };
}

function displayName(r: { name: Bilingual; key: string }): [string, string, string] {
  return [(r.name.en ?? '').toLowerCase(), r.name.th ?? '', r.key];
}

function compareNames(a: [string, string, string], b: [string, string, string]): number {
  return a[0].localeCompare(b[0], 'en') || a[1].localeCompare(b[1], 'th') || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/** Sort + competition ranking. `value` null sorts last in both directions. */
export function rankRows<T extends { name: Bilingual; key: string }>(rows: T[], value: (r: T) => number | null, direction: MenuDirection): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return direction === 'most' ? vb - va : va - vb;
    }
    return compareNames(displayName(a), displayName(b));
  });
  let rank = 0;
  let last: number | null | undefined;
  return sorted.map((r, i) => {
    const v = value(r);
    if (i === 0 || v !== last) rank = i + 1;
    last = v;
    return { ...r, rank };
  });
}

/** Item ranking for a period (brief 38, 44F). */
export function menuStats(q: MenuStatsParams): MenuStatsDTO {
  const rp = resolvePeriod(q);
  const include = rp.include_fixture;
  const direction: MenuDirection = q.direction ?? 'most';
  const measure: MenuMeasure = q.measure ?? 'net';
  const categoryId = q.category ?? null;
  if (categoryId && !one('SELECT 1 AS x FROM menu_categories WHERE id = ?', [categoryId])) {
    throw new AppError('not_found', 'Category not found');
  }

  const first = firstOperatingDate(include);
  const w = previousWindow(rp, first);
  const current = itemTotals(rp.from, rp.to, include);
  const previous = w.hasBaseline ? itemTotals(w.from, w.to, include, w.cutIso) : null;
  const variants = variantTotals(rp.from, rp.to, include);
  const availability = loadAvailability(rp.clock.ms);
  const span = availabilitySpan(rp, first);
  const variantPriced = new Set(many<{ item_id: string }>(
    'SELECT DISTINCT item_id FROM item_variants WHERE archived_at IS NULL AND available = 1 AND price_minor IS NOT NULL').map((r) => r.item_id));

  type Draft = Omit<RankingRowDTO, 'rank' | 'share'> & { key: string; value: number | null };
  const drafts: Draft[] = [];
  for (const item of itemCatalog()) {
    if (categoryId && item.category_id !== categoryId) continue;
    const totals = current.get(item.id);
    const av = availabilityOf(availability, item.id);
    const days = span.days > 0 ? availableDays(av, span.from, span.to, rp.clock) : (av.known ? 0 : null);
    if (!totals) {
      // Zero-order candidates must have been orderable and actually available (D-S6-07).
      if (span.days === 0) continue;
      if (!orderableInPrinciple(item, variantPriced, av.known)) continue;
      if (seasonallyInactive(item, rp.from, rp.to)) continue;
      if (av.known && !days) continue;
    }
    const measured = item.pricing_type === 'measured_weight';
    const t = totals ?? { net: 0, submitted: 0, grams: 0, orders: 0, visits: 0 };
    if (measure === 'grams' && !measured && t.grams === 0) continue;

    const availabilityState = availabilityLabel(days, span.days);
    const quality: RankingRowDTO['quality'] =
      availabilityState === 'insufficient' ? 'insufficient_availability'
        : availabilityState === 'unknown' ? (t.net === 0 ? 'insufficient_availability' : null)
          : t.submitted === 0 ? 'never_ordered_despite_availability' : null;
    const perDay = days ? round2(t.net / days) : null;
    const prev = previous ? (previous.get(item.id)?.net ?? 0) : null;
    const value = measure === 'net' ? t.net : measure === 'submitted' ? t.submitted : measure === 'grams' ? t.grams : perDay;

    drafts.push({
      key: item.key,
      value,
      item_id: item.id,
      name: bi(item.name_th, item.name_en),
      category: bi(item.cat_name_th, item.cat_name_en),
      image: item.image,
      measured_weight: measured,
      net_qty: t.net,
      submitted_qty: t.submitted,
      grams: measured || t.grams > 0 ? t.grams : null,
      orders: t.orders,
      visits: t.visits,
      change: itemChange(t.net, prev, isNewInPeriod(item.id, av, rp), w),
      available_days: days,
      period_days: span.days,
      per_available_day: perDay,
      availability: availabilityState,
      quality,
      archived: item.status === 'archived',
      variants: variants.get(item.id) ?? [],
    });
  }

  const totalNet = drafts.reduce((s, d) => s + d.net_qty, 0);
  const rows: RankingRowDTO[] = rankRows(drafts, (d) => d.value, direction).map(({ key: _key, value: _value, ...r }) => ({
    ...r,
    share: totalNet > 0 ? Math.round((r.net_qty / totalNet) * 10_000) / 10_000 : null,
  }));

  return {
    period: rp.period,
    from: rp.from,
    to: rp.to,
    direction,
    measure,
    category_id: categoryId,
    rows,
    totals: { net_qty: totalNet, items_ranked: rows.length, zero_order_items: rows.filter((r) => r.net_qty === 0).length },
    tie_policy: TIE_POLICY,
    include_fixture: include,
    generated_at: nowIso(),
    previous: { from: w.from, to: w.to, comparable: w.comparable, note: w.note },
  };
}

// ================================================================== item detail
/** Weekly trend, variants, engagement and portion funnel for one item. */
export function itemStats(itemId: string, q: StatsParams): ItemStatsDTO {
  const item = one<{ id: string; name_th: string | null; name_en: string | null; pricing_type: PricingType }>(
    'SELECT id, name_th, name_en, pricing_type FROM menu_items WHERE id = ?', [itemId]);
  if (!item) throw new AppError('not_found', 'Menu item not found');
  const rp = resolvePeriod(q);
  const include = rp.include_fixture;
  const first = firstOperatingDate(include);
  const clock = rp.clock;

  // Weekly trend: a week view shows the 12 weeks ending with it; longer views
  // show every Monday-start week overlapping the period. Future weeks and weeks
  // wholly before the first operating date are left out (never a fabricated trend).
  const trendFrom = rp.period === 'week' ? addDays(rp.from, -77) : weekStart(rp.from);
  const net = many<{ business_date: string; net: number }>(
    `SELECT o.business_date, SUM(l.quantity) AS net
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.item_id = :item AND l.status IN ${CHARGEABLE_SQL}
        AND o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}
      GROUP BY o.business_date`,
    { item: itemId, from: trendFrom, to: rp.to },
  );
  const weeks = new Map<string, number>();
  for (let ws = trendFrom; ws <= rp.to; ws = addDays(ws, 7)) {
    if (ws > clock.today) break;
    if (first === null || addDays(ws, 6) < first) continue;
    weeks.set(ws, 0);
  }
  for (const r of net) {
    const ws = weekStart(r.business_date);
    if (weeks.has(ws)) weeks.set(ws, (weeks.get(ws) ?? 0) + r.net);
  }

  // Engagement in the period (item-scoped events).
  const counts = new Map(many<{ type: string; n: number }>(
    `SELECT e.type, COUNT(*) AS n FROM analytics_events e
      WHERE e.item_id = :item AND e.business_date BETWEEN :from AND :to AND ${fixtureSql('e', include)}
      GROUP BY e.type`,
    { item: itemId, from: rp.from, to: rp.to },
  ).map((r) => [r.type, r.n]));
  const dwell = many<{ ms: number }>(
    `SELECT SUM(e.active_ms) AS ms FROM analytics_events e
      WHERE e.item_id = :item AND e.type = 'item_detail_active_time'
        AND e.business_date BETWEEN :from AND :to AND ${fixtureSql('e', include)}
      GROUP BY e.session_id, COALESCE(e.interaction_ref, e.event_id)`,
    { item: itemId, from: rp.from, to: rp.to },
  ).map((r) => r.ms);
  // Sessions (not events) on both sides of the add rate (D-S8-06).
  const perSession = one<{ sessions: number; saw: number; converted: number }>(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(imp > 0), 0) AS saw, COALESCE(SUM(imp > 0 AND adds > 0), 0) AS converted
       FROM (SELECT e.session_id, SUM(e.type = 'item_impression') AS imp, SUM(e.type = 'cart_add') AS adds
               FROM analytics_events e
              WHERE e.item_id = :item AND e.business_date BETWEEN :from AND :to AND ${fixtureSql('e', include)}
              GROUP BY e.session_id)`,
    { item: itemId, from: rp.from, to: rp.to }) ?? { sessions: 0, saw: 0, converted: 0 };
  const sampleSessions = perSession.sessions;
  const submittedOrders = one<{ n: number }>(
    `SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_lines l ON l.order_id = o.id
      WHERE l.item_id = :item AND o.analytics_session_id IS NOT NULL
        AND o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}`,
    { item: itemId, from: rp.from, to: rp.to })?.n ?? 0;
  const impressions = counts.get('item_impression') ?? 0;
  const adds = counts.get('cart_add') ?? 0;

  let portion: ItemStatsDTO['portion_funnel'] = null;
  if (item.pricing_type === 'measured_weight') {
    const p = one<{ requests: number; quoted: number; confirmed: number }>(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(EXISTS (SELECT 1 FROM portion_quotes q WHERE q.request_id = pr.id)), 0) AS quoted,
              COALESCE(SUM(pr.status = 'confirmed'), 0) AS confirmed
         FROM portion_requests pr
        WHERE pr.item_id = :item AND pr.business_date BETWEEN :from AND :to AND ${fixtureSql('pr', include)}`,
      { item: itemId, from: rp.from, to: rp.to });
    const grams = one<{ g: number | null }>(
      `SELECT SUM(q.grams) AS g FROM portion_quotes q JOIN portion_requests pr ON pr.id = q.request_id
        WHERE q.status = 'confirmed' AND pr.item_id = :item
          AND pr.business_date BETWEEN :from AND :to AND ${fixtureSql('pr', include)}`,
      { item: itemId, from: rp.from, to: rp.to })?.g ?? 0;
    portion = { requests: p?.requests ?? 0, quoted: p?.quoted ?? 0, confirmed: p?.confirmed ?? 0, grams_total: grams };
  }

  const span = availabilitySpan(rp, first);
  const av = availabilityOf(loadAvailability(clock.ms), itemId);
  return {
    item_id: item.id,
    name: bi(item.name_th, item.name_en),
    weekly: [...weeks].map(([week_start, net_qty]) => ({ week_start, net_qty })),
    variants: variantTotals(rp.from, rp.to, include, itemId).get(itemId) ?? [],
    engagement: {
      impressions,
      detail_opens: counts.get('item_detail_open') ?? 0,
      detail_active_ms_median: distribution(dwell).median,
      adds,
      add_rate: perSession.saw > 0 ? Math.round((perSession.converted / perSession.saw) * 10_000) / 10_000 : null,
      submitted_orders: submittedOrders,
      sample_sessions: sampleSessions,
    },
    portion_funnel: portion,
    availability_days: span.days > 0 ? availableDays(av, span.from, span.to, clock) : (av.known ? 0 : null),
    from: rp.from,
    to: rp.to,
    period: rp.period,
    period_days: span.days,
    include_fixture: include,
    generated_at: nowIso(),
  };
}

