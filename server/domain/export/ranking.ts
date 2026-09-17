// Full-year item ranking with availability context (brief 38, 41 item 4).
//
// The rules match the Menu Stats screen (D-S6-06, D-S6-07) so the annual
// report and the dashboard agree:
//  - popularity = net accepted servings; a measured-weight cut is one serving
//    per confirmed portion and its grams are a separate column;
//  - an item with any line in the period is listed; an item without lines is
//    listed only if it (and its category) is published, could be ordered in
//    principle (priced, verified for the operating mode), its seasonal
//    category was active, and it was logged as available at some point;
//  - availability comes from availability_log; time before an item's first
//    log row counts as not available;
//  - competition ranking (1, 2, 2, 4); ties listed by English name, Thai name, key.
import type { Bilingual } from '../../../shared/dto.ts';
import type { ItemStatus, PricingType, ReviewStatus, Station } from '../../../shared/status.ts';
import { BANGKOK_OFFSET_MINUTES } from '../../../shared/time.ts';
import type { RankRow, RankingSnap } from './types.ts';

export interface CatalogItem {
  id: string; key: string; category_id: string; sort: number;
  name_th: string | null; name_en: string | null;
  status: ItemStatus; review_status: ReviewStatus; pricing_type: PricingType;
  price_minor: number | null; rate_minor: number | null; rate_basis_grams: number | null;
  demo_orderable: number; station: Station; sold_out: number; created_at: string;
}

export interface CatalogCategory {
  id: string; key: string; name_th: string | null; name_en: string; sort: number;
  status: ItemStatus; group_key: 'food' | 'drinks' | null;
  seasonal: number; active_from: string | null; active_until: string | null;
}

export interface ItemAcc {
  net: number;
  submitted: number;
  rejected: number;
  cancelled: number;
  orders: Set<string>;
  visits: Set<string>;
  grams: number;
  minor: number;
  variants: Map<string, { name: Bilingual; net: number; submitted: number }>;
  names: Set<string>;
  first: string | null;
  last: string | null;
}

export function newItemAcc(): ItemAcc {
  return { net: 0, submitted: 0, rejected: 0, cancelled: 0, orders: new Set(), visits: new Set(), grams: 0, minor: 0, variants: new Map(), names: new Set(), first: null, last: null };
}

export interface AvailabilityLog { item_id: string; available: number; changed_at: string }

export interface AvailabilityInfo {
  /** Business days with any available time in the window; null = never logged. */
  days: number | null;
  never: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Replay the availability log over [startUtc, endUtc). Time before the first
 * known state is not counted (unknown is not "available"). An item with no log
 * entries at all has unknown availability.
 */
export function computeAvailability(logs: AvailabilityLog[], startUtc: string, endUtc: string, cutoffHour: number): Map<string, AvailabilityInfo> {
  const byItem = new Map<string, AvailabilityLog[]>();
  for (const l of logs) {
    const list = byItem.get(l.item_id) ?? [];
    list.push(l);
    byItem.set(l.item_id, list);
  }
  const out = new Map<string, AvailabilityInfo>();
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  // Business day number of an instant: Bangkok is a fixed UTC+7, shifted by the cutoff hour.
  const shift = BANGKOK_OFFSET_MINUTES * 60_000 - cutoffHour * 3_600_000;
  const dayNo = (ms: number) => Math.floor((ms + shift) / DAY_MS);
  for (const [itemId, entries] of byItem) {
    let state: boolean | null = null;
    let cursor = start;
    // Inclusive day-number ranges touched by available intervals; merged at the end.
    const ranges: Array<[number, number]> = [];
    const addInterval = (from: number, to: number) => {
      if (to > from) ranges.push([dayNo(from), dayNo(to - 1)]);
    };
    for (const e of entries) {
      const at = Date.parse(e.changed_at);
      if (at < start) {
        state = e.available === 1;
        continue;
      }
      if (at >= end) break;
      if (state === true) addInterval(cursor, at);
      state = e.available === 1;
      cursor = at;
    }
    if (state === true) addInterval(cursor, end);
    ranges.sort((a, b) => a[0] - b[0]);
    let days = 0;
    let open = Number.NEGATIVE_INFINITY;
    for (const [from, to] of ranges) {
      const first = Math.max(from, open + 1);
      if (to >= first) days += to - first + 1;
      open = Math.max(open, to);
    }
    const known = entries.some((e) => Date.parse(e.changed_at) < end);
    out.set(itemId, known ? { days, never: days === 0 } : { days: null, never: false });
  }
  return out;
}

const bil = (th: string | null, en: string | null): Bilingual => ({ th, en });

export const TIE_POLICY = 'Standard competition ranking on net accepted servings (equal quantities share a rank: 1, 2, 2, 4); '
  + 'tied items are listed by English name, then Thai name, then item key (the same order as Menu Stats).';

/** Availability label, as on the Menu Stats screen (D-S6-07). */
export function availabilityLabel(days: number | null, periodDays: number): RankRow['availability'] {
  if (days === null) return 'unknown';
  if (days < 2 || days < periodDays * 0.25) return 'insufficient';
  return days >= periodDays ? 'full' : 'partial';
}

export interface RankingInput {
  items: CatalogItem[];
  categories: Map<string, CatalogCategory>;
  accs: Map<string, ItemAcc>;
  availability: Map<string, AvailabilityInfo>;
  /** Days from the later of Jan 1 and the first operating date, to the earlier of Dec 31 and today. */
  periodDays: number;
  periodFrom: string;
  periodTo: string;
  operatingMode: 'demo' | 'live';
  /** Items with at least one available, priced variant. */
  pricedVariantItems: Set<string>;
}

function orderableInPrinciple(item: CatalogItem, mode: 'demo' | 'live', pricedVariantItems: Set<string>): boolean {
  const priced = item.pricing_type === 'fixed' ? item.price_minor !== null
    : item.pricing_type === 'variant' ? pricedVariantItems.has(item.id)
    : item.rate_minor !== null && item.rate_basis_grams !== null;
  if (!priced) return false;
  if (item.review_status === 'verified') return true;
  return mode === 'demo' && item.demo_orderable === 1;
}

function seasonActive(cat: CatalogCategory | undefined, from: string, to: string): boolean {
  if (!cat || cat.seasonal !== 1) return true;
  return (cat.active_from === null || cat.active_from <= to) && (cat.active_until === null || cat.active_until >= from);
}

export function buildRanking(input: RankingInput): RankingSnap {
  const { items, categories, accs, availability, periodDays } = input;
  const excluded = { unpublished: 0, archived: 0, not_orderable: 0, out_of_season: 0, not_available: 0 };
  const rows: RankRow[] = [];
  const catTotals = new Map<string, number>();
  let totalNet = 0;

  for (const item of items) {
    const acc = accs.get(item.id);
    const cat = categories.get(item.category_id);
    const hasLines = Boolean(acc && acc.submitted > 0);
    const avail = availability.get(item.id) ?? { days: null, never: false };
    if (!hasLines) {
      if (item.status === 'archived') { excluded.archived++; continue; }
      if (item.status !== 'published' || !cat || cat.status !== 'published') { excluded.unpublished++; continue; }
      if (!orderableInPrinciple(item, input.operatingMode, input.pricedVariantItems)) { excluded.not_orderable++; continue; }
      if (!seasonActive(cat, input.periodFrom, input.periodTo)) { excluded.out_of_season++; continue; }
      if (!avail.days) { excluded.not_available++; continue; }
    }
    const a = acc ?? newItemAcc();
    const label = availabilityLabel(avail.days, periodDays);
    let quality: RankRow['quality'] = null;
    if (label === 'insufficient' || (label === 'unknown' && a.submitted === 0)) quality = 'insufficient_availability';
    else if (label !== 'unknown' && a.submitted === 0) quality = 'never_ordered_despite_availability';
    const former = [...a.names].filter((n) => n && n !== item.name_th && n !== item.name_en);
    totalNet += a.net;
    catTotals.set(item.category_id, (catTotals.get(item.category_id) ?? 0) + a.net);
    rows.push({
      rank: 0,
      item_id: item.id,
      key: item.key,
      name: bil(item.name_th, item.name_en),
      former_names: former.slice(0, 3),
      category: cat ? bil(cat.name_th, cat.name_en) : bil(null, 'Unknown category'),
      category_id: item.category_id,
      category_sort: cat?.sort ?? 9999,
      group: cat?.group_key ?? null,
      status: item.status,
      review_status: item.review_status,
      archived: item.status === 'archived',
      measured: item.pricing_type === 'measured_weight',
      pricing_type: item.pricing_type,
      station: item.station,
      net_qty: a.net,
      submitted_qty: a.submitted,
      rejected_qty: a.rejected,
      cancelled_qty: a.cancelled,
      orders: a.orders.size,
      visits: a.visits.size,
      grams: a.grams,
      accepted_minor: a.minor,
      share: null,
      category_share: null,
      available_days: avail.days,
      period_days: periodDays,
      per_available_day: avail.days ? Math.round((a.net / avail.days) * 100) / 100 : null,
      availability: label,
      quality,
      sold_out_now: item.sold_out === 1,
      variants: [...a.variants.values()].sort((x, y) => y.net - x.net || y.submitted - x.submitted)
        .map((v) => ({ name: v.name, net_qty: v.net, submitted_qty: v.submitted })),
      first_ordered: a.first,
      last_ordered: a.last,
    });
  }

  const text = (v: string | null) => v ?? '￿';
  rows.sort((x, y) => y.net_qty - x.net_qty
    || text(x.name.en).localeCompare(text(y.name.en))
    || text(x.name.th).localeCompare(text(y.name.th), 'th')
    || x.key.localeCompare(y.key));
  let prevNet = Number.NaN;
  let prevRank = 0;
  rows.forEach((r, i) => {
    r.rank = r.net_qty === prevNet ? prevRank : i + 1;
    prevNet = r.net_qty;
    prevRank = r.rank;
    r.share = totalNet > 0 ? r.net_qty / totalNet : null;
    const ct = catTotals.get(r.category_id) ?? 0;
    r.category_share = ct > 0 ? r.net_qty / ct : null;
  });

  return {
    rows,
    total_net: totalNet,
    zero_order_items: rows.filter((r) => r.net_qty === 0).length,
    excluded,
    tie_policy: TIE_POLICY,
  };
}
