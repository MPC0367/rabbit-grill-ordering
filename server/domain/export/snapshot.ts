// Build the annual report snapshot (brief 40, 41).
//
// Everything is read through one SnapshotReader, so the cover, the charts,
// the ranking and the appendices describe exactly the same data. Big tables
// are read one business day (orders, lines, line events, engagement) or one
// month (visits, requests, portions, payments) at a time, with a yield to the
// event loop between pieces, so generation never stalls live ordering.
//
// Attribution (D-11): order rounds by submitted business date, covers by
// seated date, checkouts by closed date, payments by confirmation date.
// Guest notes are never read: only a has-note flag leaves the database.
import type { Bilingual } from '../../../shared/dto.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings.ts';
import {
  deriveOrderStatus, isChargeable, LINE_STATUSES, type LineStatus, type ServiceType, type Station,
} from '../../../shared/status.ts';
import {
  addDays, bangkokParts, businessDate, businessRangeUtc, daysBetween, isoWeekday, TIMEZONE, weekStart, yearOf,
} from '../../../shared/time.ts';
import type { SnapshotReader } from './reader.ts';
import { pushIf, secondsBetween, statOf } from './quantiles.ts';
import { buildRanking, computeAvailability, newItemAcc, type AvailabilityLog, type CatalogCategory, type CatalogItem, type ItemAcc } from './ranking.ts';
import { readEngagement } from './engagement.ts';
import type {
  BillRow, CorrectionRow, Counters, DailyRow, JobInfo, OrderRow, PaymentException, PaymentsSnap, PeriodRow,
  PortionRow, ReasonRow, ReportSnapshot, SnapshotSummary, VersionRow,
} from './types.ts';

// ------------------------------------------------------------------ row shapes
interface OrderDb {
  id: string; reference: string; visit_id: string; table_label: string; round_no: number; source: string;
  guest_session_id: string | null; analytics_session_id: string | null; staff_user_id: string | null;
  submitted_at: string; manual_reference: string | null; manual_original_time: string | null;
  subtotal_minor: number; first_accepted_at: string | null;
}

export interface LineDb {
  id: string; order_id: string; visit_id: string; line_no: number; item_id: string; variant_id: string | null; category_id: string;
  name_th: string | null; name_en: string | null; variant_name_th: string | null; variant_name_en: string | null;
  station: Station; pricing_type: string; unit_price_minor: number; modifiers_minor: number; modifiers_json: string;
  quantity: number; measured_grams: number | null; line_total_minor: number; has_note: number; allergy_flag: number;
  status: LineStatus; status_reason: string | null; submitted_at: string; accepted_at: string | null;
  preparing_at: string | null; ready_at: string | null; served_at: string | null;
  rejected_at: string | null; cancelled_at: string | null; prepared_before_entry: number;
}

interface EventDb {
  line_id: string; order_id: string; from_status: string | null; to_status: string; kind: string;
  actor_type: string; actor_id: string | null; reason: string | null; created_at: string;
}

/** Columns of order_lines a report may read. The guest note text is deliberately absent; a note removed by retention still counts as a note. */
export const LINE_COLUMNS = `l.id, l.order_id, l.visit_id, l.line_no, l.item_id, l.variant_id, l.category_id,
  l.name_th, l.name_en, l.variant_name_th, l.variant_name_en, l.station, l.pricing_type,
  l.unit_price_minor, l.modifiers_minor, l.modifiers_json, l.quantity, l.measured_grams, l.line_total_minor,
  ((l.note IS NOT NULL AND TRIM(l.note) <> '') OR l.note_removed_at IS NOT NULL) AS has_note, l.allergy_flag, l.status, l.status_reason,
  l.submitted_at, l.accepted_at, l.preparing_at, l.ready_at, l.served_at, l.rejected_at, l.cancelled_at,
  l.prepared_before_entry`;

export const DAY_ORDERS_SQL = `SELECT o.id, o.reference, o.visit_id, o.table_label, o.round_no, o.source, o.guest_session_id,
    o.analytics_session_id, o.staff_user_id, o.submitted_at, o.manual_reference, o.manual_original_time,
    o.subtotal_minor, o.first_accepted_at
  FROM orders o WHERE o.business_date = :d AND (:fx = 1 OR o.is_fixture = 0) ORDER BY o.submitted_at, o.id`;

export const DAY_LINES_SQL = `SELECT ${LINE_COLUMNS} FROM order_lines l JOIN orders o ON o.id = l.order_id
  WHERE o.business_date = :d AND (:fx = 1 OR o.is_fixture = 0) ORDER BY o.submitted_at, l.order_id, l.line_no`;

const DAY_EVENTS_SQL = `SELECT e.line_id, e.order_id, e.from_status, e.to_status, e.kind, e.actor_type, e.actor_id, e.reason, e.created_at
  FROM line_events e JOIN orders o ON o.id = e.order_id
  WHERE o.business_date = :d AND (:fx = 1 OR o.is_fixture = 0) AND e.kind <> 'forward' ORDER BY e.id`;

// ------------------------------------------------------------------ helpers
export function mergeSettings(rows: Array<{ key: string; value: string }>): Settings {
  const merged = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (!(r.key in merged)) continue;
    try {
      const v = JSON.parse(r.value);
      const base = merged[r.key];
      merged[r.key] = base && typeof base === 'object' && !Array.isArray(base) && v && typeof v === 'object' && !Array.isArray(v)
        ? { ...(base as object), ...(v as object) }
        : v;
    } catch { /* keep default */ }
  }
  return merged as unknown as Settings;
}

export function pickName(b: Bilingual, locale: 'th' | 'en'): string {
  return (locale === 'th' ? (b.th ?? b.en) : (b.en ?? b.th)) ?? '';
}

/** Readable summary of a line's modifier snapshot (tolerant of the stored shape). */
export function modifierSummary(json: string, locale: 'th' | 'en'): string {
  let data: unknown;
  try { data = JSON.parse(json); } catch { return ''; }
  if (!Array.isArray(data)) return '';
  const nameOf = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.name !== undefined) return nameOf(o.name);
      const th = typeof o.th === 'string' ? o.th : null;
      const en = typeof o.en === 'string' ? o.en : null;
      if (th || en) return pickName({ th, en }, locale);
      if (typeof o.name_en === 'string' || typeof o.name_th === 'string') return pickName({ th: (o.name_th as string) ?? null, en: (o.name_en as string) ?? null }, locale);
    }
    return '';
  };
  const parts: string[] = [];
  for (const g of data) {
    if (!g || typeof g !== 'object') continue;
    const opts = (g as { options?: unknown[] }).options;
    const names = Array.isArray(opts) ? opts.map(nameOf).filter(Boolean) : [];
    if (names.length) parts.push(names.join(', '));
  }
  return parts.join('; ');
}

function zeroCounters(): Counters {
  return { submitted: 0, accepted: 0, rejected: 0, cancelled: 0, visits: 0, devices: 0, seated: 0, covered: 0, diners: 0, items: 0, submitted_items: 0, grams: 0, closed: 0, accepted_minor: 0 };
}

/** Additive counters plus distinct-visit/device sets recomputed at the period level. */
interface Bucket { c: Counters; visits: Set<string>; devices: Set<string> }
const newBucket = (): Bucket => ({ c: zeroCounters(), visits: new Set(), devices: new Set() });

function addCounters(target: Counters, src: Partial<Counters>): void {
  for (const [k, v] of Object.entries(src) as Array<[keyof Counters, number]>) target[k] += v;
}

function bucketCounters(b: Bucket): Counters {
  return { ...b.c, visits: b.visits.size, devices: b.devices.size };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;

function monthEnd(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
}

function periodState(from: string, to: string, today: string, recordsBegin: string | null): PeriodRow['state'] {
  if (from > today) return 'future';
  if (recordsBegin === null || to < recordsBegin) return 'before_records';
  if (to >= today) return 'partial';
  return 'complete';
}

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2025-02-10 -> 10 February 2025 (notes are read by people). */
const longDate = (d: string) => `${Number(d.slice(8, 10))} ${LONG_MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** UTC instant -> "14 Feb 2025, 14:25" Bangkok. */
function localStamp(iso: string | null): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const p = bangkokParts(iso);
  return `${p.day} ${MON[p.month - 1]} ${p.year}, ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ builder
export async function buildSnapshot(r: SnapshotReader, job: JobInfo): Promise<ReportSnapshot> {
  const settings = mergeSettings(r.all<{ key: string; value: string }>('SELECT key, value FROM settings'));
  const cutoff = settings.business_day_cutoff_hour;
  const locale = settings.default_locale;
  const fx: 0 | 1 = job.include_fixture ? 1 : 0;
  const year = job.year;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const utc = businessRangeUtc(from, to, cutoff);
  const dataCutoff = r.openedAt;
  const today = businessDate(dataCutoff, cutoff);
  const currentYear = yearOf(today);
  const yearState: ReportSnapshot['year_state'] = year < currentYear ? 'completed' : year === currentYear ? 'current' : 'future';
  const dataVersion = r.get<{ version: number }>('SELECT version FROM report_data_versions WHERE year = :year', { year })?.version ?? 0;
  const base = { from, to, fx, year, start: utc.start, end: utc.end };

  // Every date of the year, in order.
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const elapsedDays = yearState === 'future' ? 0 : yearState === 'completed' ? dates.length : daysBetween(from, today) + 1;
  const windowEnd = yearState === 'current' ? dataCutoff : utc.end;

  // First operating date = earliest seated visit in scope (as on the dashboards, D-S6-03).
  const recordsBegin = r.get<{ d: string | null }>(
    'SELECT MIN(seated_business_date) AS d FROM visits WHERE (:fx = 1 OR is_fixture = 0)', base)?.d ?? null;
  // Availability window: from the later of Jan 1 and the first operating date, to the earlier of year end and now.
  const periodFrom = recordsBegin && recordsBegin > from ? recordsBegin : from;
  const periodTo = yearState === 'current' ? today : to;
  const periodDays = recordsBegin === null || recordsBegin > periodTo || yearState === 'future' ? 0 : daysBetween(periodFrom, periodTo) + 1;
  const windowStart = businessRangeUtc(periodFrom, periodFrom, cutoff).start;

  // ---------------------------------------------------------------- catalog & people
  const categoryRows = r.all<CatalogCategory>(
    `SELECT c.id, c.key, c.name_th, c.name_en, c.sort, c.status, g.key AS group_key, c.seasonal, c.active_from, c.active_until
       FROM menu_categories c LEFT JOIN menu_groups g ON g.id = c.group_id ORDER BY g.sort, c.sort`);
  const categories = new Map(categoryRows.map((c) => [c.id, c]));
  const items = r.all<CatalogItem>(
    `SELECT i.id, i.key, i.category_id, i.sort, i.name_th, i.name_en, i.status, i.review_status, i.pricing_type,
            i.price_minor, i.rate_minor, i.rate_basis_grams, i.demo_orderable, i.station, i.sold_out, i.created_at
       FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
       LEFT JOIN menu_groups g ON g.id = c.group_id
      ORDER BY g.sort, c.sort, i.sort, i.key`);
  const pricedVariantItems = new Set(r.all<{ item_id: string }>(
    `SELECT DISTINCT item_id FROM item_variants WHERE archived_at IS NULL AND available = 1 AND price_minor IS NOT NULL`).map((v) => v.item_id));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const staffNames = new Map(r.all<{ id: string; display_name: string }>('SELECT id, display_name FROM staff_users').map((s) => [s.id, s.display_name]));
  const itemName = (id: string): Bilingual => {
    const it = itemById.get(id);
    return it ? { th: it.name_th, en: it.name_en ?? it.key } : { th: null, en: id };
  };
  const categoryName = (id: string): Bilingual => {
    const c = categories.get(id);
    return c ? { th: c.name_th, en: c.name_en } : { th: null, en: id };
  };
  const methodLabels = new Map(settings.payment_methods.map((m) => [m.id, m.label_en]));

  // ---------------------------------------------------------------- accumulators
  const dayBuckets = new Map(dates.map((d) => [d, newBucket()]));
  const monthBuckets = new Map<string, Bucket>();
  const weekBuckets = new Map<string, Bucket>();
  const yearBucket = newBucket();
  const bucketsFor = (d: string): Bucket[] => {
    const mk = d.slice(0, 7);
    const wk = weekStart(d);
    if (!monthBuckets.has(mk)) monthBuckets.set(mk, newBucket());
    if (!weekBuckets.has(wk)) weekBuckets.set(wk, newBucket());
    return [dayBuckets.get(d)!, monthBuckets.get(mk)!, weekBuckets.get(wk)!, yearBucket];
  };
  for (const d of dates) bucketsFor(d);

  const itemAccs = new Map<string, ItemAcc>();
  const lineStatusTotals = Object.fromEntries(LINE_STATUSES.map((s) => [s, 0])) as Record<LineStatus, number>;
  const hourly = Array.from({ length: 24 }, () => 0);
  const weekday = Array.from({ length: 7 }, () => 0);
  const acceptS: number[] = [];
  const acceptToPrepS: number[] = [];
  const stationTimes = new Map<Station, { lines: number; prepare: number[]; serve: number[]; total: number[] }>();
  const reasons = new Map<string, ReasonRow>();
  const cancelStages = new Map<string, { from: string; lines: number; qty: number }>();
  const orderRows: OrderRow[] = [];
  const corrections: CorrectionRow[] = [];
  const orderingVisits = new Set<string>();
  const attributedQty = new Map<string, Map<string, number>>();
  const orderSessions = new Map<string, number>();
  const tableOfVisit = new Map<string, string>();
  const sources = { guest: 0, staff: 0, manual_recovery: 0, portion_quote: 0 } as Record<string, number>;
  let submittedMinor = 0;
  let rejectedItems = 0;
  let cancelledItems = 0;
  let measuredServings = 0;
  let linesTotal = 0;
  let linesWithNote = 0;
  let linesWithAllergy = 0;
  let lateChanges = 0;
  let correctionCount = 0;
  let recoveryCount = 0;
  let excludedPrepared = 0;
  let activeDays = 0;
  let busiestDay: { date: string; submitted: number } | null = null;

  // ---------------------------------------------------------------- orders, day by day
  for (const d of dates) {
    const p = { ...base, d };
    const orders = r.all<OrderDb>(DAY_ORDERS_SQL, p);
    if (orders.length === 0) { await r.tick(); continue; }
    const lines = r.all<LineDb>(DAY_LINES_SQL, p);
    const events = r.all<EventDb>(DAY_EVENTS_SQL, p);
    const linesByOrder = new Map<string, LineDb[]>();
    for (const l of lines) {
      const list = linesByOrder.get(l.order_id) ?? [];
      list.push(l);
      linesByOrder.set(l.order_id, list);
    }
    const eventsByOrder = new Map<string, EventDb[]>();
    for (const e of events) {
      const list = eventsByOrder.get(e.order_id) ?? [];
      list.push(e);
      eventsByOrder.set(e.order_id, list);
    }
    const buckets = bucketsFor(d);
    activeDays++;
    if (!busiestDay || orders.length > busiestDay.submitted) busiestDay = { date: d, submitted: orders.length };

    for (const o of orders) {
      const ls = linesByOrder.get(o.id) ?? [];
      const evs = eventsByOrder.get(o.id) ?? [];
      const status = deriveOrderStatus(ls);
      const accepted = ls.some((l) => isChargeable(l.status));
      const recovered = o.source === 'manual_recovery';
      const lineById = new Map(ls.map((l) => [l.id, l]));
      sources[o.source] = (sources[o.source] ?? 0) + 1;
      orderingVisits.add(o.visit_id);
      tableOfVisit.set(o.visit_id, o.table_label);
      submittedMinor += o.subtotal_minor;

      let net = 0;
      let total = 0;
      let grams = 0;
      let minor = 0;
      for (const l of ls) {
        linesTotal++;
        lineStatusTotals[l.status]++;
        total += l.quantity;
        if (l.has_note) linesWithNote++;
        if (l.allergy_flag) linesWithAllergy++;
        const acc = itemAccs.get(l.item_id) ?? newItemAcc();
        itemAccs.set(l.item_id, acc);
        acc.submitted += l.quantity;
        const snapName = locale === 'th' ? (l.name_th ?? l.name_en) : (l.name_en ?? l.name_th);
        if (snapName) acc.names.add(snapName);
        const vKey = l.variant_id ?? (l.variant_name_en || l.variant_name_th ? `name:${l.variant_name_en ?? l.variant_name_th}` : null);
        let variant = vKey ? acc.variants.get(vKey) : undefined;
        if (vKey && !variant) {
          variant = { name: { th: l.variant_name_th, en: l.variant_name_en }, net: 0, submitted: 0 };
          acc.variants.set(vKey, variant);
        }
        if (variant) variant.submitted += l.quantity;
        // Engagement attribution counts the quantity of every line on the round (D-S6-09).
        if (o.analytics_session_id) {
          const m = attributedQty.get(o.analytics_session_id) ?? new Map<string, number>();
          m.set(l.item_id, (m.get(l.item_id) ?? 0) + l.quantity);
          attributedQty.set(o.analytics_session_id, m);
        }
        if (isChargeable(l.status)) {
          net += l.quantity;
          minor += l.line_total_minor;
          acc.net += l.quantity;
          acc.minor += l.line_total_minor;
          acc.orders.add(o.id);
          acc.visits.add(o.visit_id);
          acc.first ??= d;
          acc.last = d;
          if (variant) variant.net += l.quantity;
          if (l.measured_grams) {
            grams += l.measured_grams;
            acc.grams += l.measured_grams;
            measuredServings += l.quantity;
          }
        } else if (l.status === 'rejected' || l.status === 'cancelled') {
          if (l.status === 'rejected') { rejectedItems += l.quantity; acc.rejected += l.quantity; }
          else { cancelledItems += l.quantity; acc.cancelled += l.quantity; }
          const kind = l.status === 'rejected' ? 'rejected' : 'cancelled';
          const reason = (l.status_reason ?? '').trim() || 'No reason recorded';
          const key = `${kind}|${reason.toLowerCase()}`;
          const row = reasons.get(key) ?? { kind, reason, lines: 0, qty: 0, value_minor: 0 };
          row.lines++;
          row.qty += l.quantity;
          row.value_minor += l.line_total_minor;
          reasons.set(key, row);
        }

        // Timings: only lines whose times were recorded live.
        if (!recovered) {
          const st = stationTimes.get(l.station) ?? { lines: 0, prepare: [], serve: [], total: [] };
          stationTimes.set(l.station, st);
          st.lines++;
          pushIf(st.serve, secondsBetween(l.ready_at, l.served_at));
          if (l.prepared_before_entry) excludedPrepared++;
          else {
            pushIf(st.prepare, secondsBetween(l.preparing_at, l.ready_at));
            pushIf(st.total, secondsBetween(l.submitted_at, l.served_at));
            pushIf(acceptToPrepS, secondsBetween(l.accepted_at, l.preparing_at));
          }
        }
      }

      // Round-level counters.
      const inc: Partial<Counters> = {
        submitted: 1,
        accepted: accepted ? 1 : 0,
        rejected: status === 'rejected' ? 1 : 0,
        cancelled: status === 'cancelled' ? 1 : 0,
        items: net,
        submitted_items: total,
        grams,
        accepted_minor: minor,
      };
      for (const b of buckets) {
        addCounters(b.c, inc);
        b.visits.add(o.visit_id);
        // Devices are guest browser sessions on guest-source rounds only (D-S6-02).
        if (o.source === 'guest' && o.guest_session_id) b.devices.add(o.guest_session_id);
      }
      if (!recovered) {
        const firstAccept = o.first_accepted_at ?? ls.map((l) => l.accepted_at).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
        pushIf(acceptS, secondsBetween(o.submitted_at, firstAccept));
      }
      // A recovered paper order is placed in the hour it was actually taken.
      const placedAt = recovered ? o.manual_original_time : o.submitted_at;
      if (placedAt && Number.isFinite(Date.parse(placedAt))) hourly[bangkokParts(placedAt).hour]++;
      weekday[isoWeekday(d)]++;
      if (o.analytics_session_id) {
        orderSessions.set(o.analytics_session_id, (orderSessions.get(o.analytics_session_id) ?? 0) + 1);
      }

      // Corrections, cancellations after acceptance, recoveries.
      let late = false;
      let recoveryReason: string | null = null;
      for (const e of evs) {
        const eventDate = businessDate(e.created_at, cutoff);
        const isLate = eventDate > d;
        if (isLate) { late = true; lateChanges++; }
        const line = lineById.get(e.line_id);
        const actor = e.actor_type === 'staff' ? (staffNames.get(e.actor_id ?? '') ?? 'Staff') : e.actor_type === 'system' ? 'System' : 'Guest';
        if (e.kind === 'cancel') {
          const stage = cancelStages.get(e.from_status ?? 'unknown') ?? { from: e.from_status ?? 'unknown', lines: 0, qty: 0 };
          stage.lines++;
          stage.qty += line?.quantity ?? 0;
          cancelStages.set(stage.from, stage);
        }
        if (e.kind === 'correction') correctionCount++;
        if (e.kind === 'recovery') { recoveryReason ??= e.reason; continue; }
        if (e.kind === 'reject' && !isLate) continue; // rejections are summarised by reason and shown per round
        corrections.push({
          at: e.created_at,
          kind: e.kind,
          reference: o.reference,
          table_label: o.table_label,
          item: line ? `${line.quantity}× ${pickName({ th: line.name_th, en: line.name_en }, locale)}` : '',
          from: e.from_status ?? '',
          to: e.to_status,
          reason: e.reason ?? '',
          actor,
          late: isLate,
        });
      }
      if (recovered) {
        recoveryCount++;
        corrections.push({
          at: o.submitted_at,
          kind: 'manual_recovery',
          reference: o.reference,
          table_label: o.table_label,
          item: `${total} item${total === 1 ? '' : 's'}`,
          from: o.manual_reference ? `paper ${o.manual_reference}` : 'paper order',
          to: o.manual_original_time ? `taken ${localStamp(o.manual_original_time)}` : '',
          reason: recoveryReason ?? '',
          actor: staffNames.get(o.staff_user_id ?? '') ?? 'Staff',
          late: false,
        });
      }

      const flags: string[] = [];
      if (ls.some((l) => l.allergy_flag)) flags.push('allergy');
      if (ls.some((l) => l.has_note)) flags.push('note');
      if (recovered) flags.push('recovered');
      if (late) flags.push('late change');
      orderRows.push({
        id: o.id,
        reference: o.reference,
        submitted_at: o.submitted_at,
        business_date: d,
        table_label: o.table_label,
        source: o.source,
        round_no: o.round_no,
        manual_reference: o.manual_reference,
        status,
        items: ls.map((l) => {
          const name = pickName({ th: l.name_th, en: l.name_en }, locale);
          const variant = pickName({ th: l.variant_name_th, en: l.variant_name_en }, locale);
          const mods = modifierSummary(l.modifiers_json, locale);
          const detail = [variant, mods, l.measured_grams ? `${l.measured_grams} g` : ''].filter(Boolean).join(', ');
          return `${l.quantity}× ${name}${detail ? ` (${detail})` : ''}${l.status === 'served' ? '' : ` [${l.status}]`}`;
        }).join('; '),
        qty_total: total,
        qty_net: net,
        subtotal_minor: o.subtotal_minor,
        accepted_minor: minor,
        flags,
        staff_name: o.staff_user_id ? (staffNames.get(o.staff_user_id) ?? null) : null,
      });
    }
    await r.tick();
  }

  // ---------------------------------------------------------------- visits, month by month
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  const visitMinutes: number[] = [];
  const closeExceptions: PaymentException[] = [];
  let visitsClosed = 0;
  for (const mk of months) {
    const mp = { ...base, mf: `${mk}-01`, mt: monthEnd(mk) };
    for (const v of r.all<{ id: string; covers: number | null; seated_business_date: string; label: string }>(
      `SELECT v.id, v.covers, v.seated_business_date, t.label FROM visits v JOIN dining_tables t ON t.id = v.table_id
        WHERE v.seated_business_date BETWEEN :mf AND :mt AND (:fx = 1 OR v.is_fixture = 0)`, mp)) {
      if (!tableOfVisit.has(v.id)) tableOfVisit.set(v.id, v.label);
      const inc: Partial<Counters> = { seated: 1, covered: v.covers ? 1 : 0, diners: v.covers ?? 0 };
      if (dayBuckets.has(v.seated_business_date)) for (const b of bucketsFor(v.seated_business_date)) addCounters(b.c, inc);
    }
    for (const v of r.all<{ id: string; seated_at: string; closed_at: string; close_business_date: string; close_exception: string | null; label: string }>(
      `SELECT v.id, v.seated_at, v.closed_at, v.close_business_date, v.close_exception, t.label FROM visits v
         JOIN dining_tables t ON t.id = v.table_id
        WHERE v.close_business_date BETWEEN :mf AND :mt AND v.status = 'closed' AND (:fx = 1 OR v.is_fixture = 0)`, mp)) {
      visitsClosed++;
      pushIf(visitMinutes, (secondsBetween(v.seated_at, v.closed_at) ?? -1) / 60);
      if (dayBuckets.has(v.close_business_date)) for (const b of bucketsFor(v.close_business_date)) addCounters(b.c, { closed: 1 });
      if (v.close_exception) {
        const label = tableOfVisit.get(v.id) ?? v.label;
        closeExceptions.push({ kind: 'close_exception', at: v.closed_at, visit_id: v.id, table_label: label, amount_minor: 0, detail: v.close_exception });
        corrections.push({ at: v.closed_at, kind: 'close_exception', reference: '', table_label: label, item: '', from: '', to: 'closed', reason: v.close_exception, actor: 'Manager', late: false });
      }
    }
    await r.tick();
  }
  const openVisits = r.get<{ n: number }>(`SELECT COUNT(*) AS n FROM visits WHERE status <> 'closed' AND (:fx = 1 OR is_fixture = 0)`, base)?.n ?? 0;

  // ---------------------------------------------------------------- service requests
  const serviceStats = new Map<ServiceType, { count: number; completed: number; cancelled: number; open: number; ack: number[]; complete: number[] }>();
  let serviceTotal = 0;
  for (const mk of months) {
    for (const s of r.all<{ type: ServiceType; status: string; created_at: string; acknowledged_at: string | null; completed_at: string | null }>(
      `SELECT type, status, created_at, acknowledged_at, completed_at FROM service_requests
        WHERE business_date BETWEEN :mf AND :mt AND (:fx = 1 OR is_fixture = 0)`, { ...base, mf: `${mk}-01`, mt: monthEnd(mk) })) {
      serviceTotal++;
      const st = serviceStats.get(s.type) ?? { count: 0, completed: 0, cancelled: 0, open: 0, ack: [], complete: [] };
      serviceStats.set(s.type, st);
      st.count++;
      if (s.status === 'completed') st.completed++;
      else if (s.status === 'cancelled') st.cancelled++;
      else st.open++;
      pushIf(st.ack, secondsBetween(s.created_at, s.acknowledged_at));
      pushIf(st.complete, secondsBetween(s.created_at, s.completed_at));
    }
    await r.tick();
  }

  // ---------------------------------------------------------------- measured-weight portions
  const portions: PortionRow[] = [];
  const portionStats = { requests: 0, quoted: 0, confirmed: 0, declined: 0, cancelled: 0, expired: 0, open: 0, grams_confirmed: 0, confirmed_in_person: 0 };
  for (const mk of months) {
    const mp = { ...base, mf: `${mk}-01`, mt: monthEnd(mk) };
    const quotes = new Map<string, Array<{ revision: number; grams: number; amount_minor: number; status: string; confirmed_via: string | null; reference: string | null }>>();
    for (const q of r.all<{ request_id: string; revision: number; grams: number; amount_minor: number; status: string; confirmed_via: string | null; reference: string | null }>(
      `SELECT q.request_id, q.revision, q.grams, q.amount_minor, q.status, q.confirmed_via, o.reference
         FROM portion_quotes q JOIN portion_requests p ON p.id = q.request_id
         LEFT JOIN order_lines l ON l.id = q.order_line_id LEFT JOIN orders o ON o.id = l.order_id
        WHERE p.business_date BETWEEN :mf AND :mt AND (:fx = 1 OR p.is_fixture = 0) ORDER BY q.revision`, mp)) {
      const list = quotes.get(q.request_id) ?? [];
      list.push(q);
      quotes.set(q.request_id, list);
    }
    for (const pr of r.all<{ id: string; item_id: string; status: string; preferred_grams: number | null; created_at: string; business_date: string; resolution_reason: string | null; table_label: string | null }>(
      `SELECT p.id, p.item_id, p.status, p.preferred_grams, p.created_at, p.business_date, p.resolution_reason,
              COALESCE((SELECT o2.table_label FROM orders o2 WHERE o2.visit_id = p.visit_id ORDER BY o2.submitted_at LIMIT 1), t.label) AS table_label
         FROM portion_requests p LEFT JOIN dining_tables t ON t.id = p.table_id
        WHERE p.business_date BETWEEN :mf AND :mt AND (:fx = 1 OR p.is_fixture = 0) ORDER BY p.created_at`, mp)) {
      const qs = quotes.get(pr.id) ?? [];
      const confirmed = qs.find((q) => q.status === 'confirmed');
      const shown = confirmed ?? qs.at(-1);
      portionStats.requests++;
      if (qs.length) portionStats.quoted++;
      if (pr.status === 'confirmed') portionStats.confirmed++;
      else if (pr.status === 'declined') portionStats.declined++;
      else if (pr.status === 'cancelled') portionStats.cancelled++;
      else if (pr.status === 'expired') portionStats.expired++;
      else portionStats.open++;
      if (confirmed) {
        portionStats.grams_confirmed += confirmed.grams;
        if (confirmed.confirmed_via === 'in_person') portionStats.confirmed_in_person++;
      }
      portions.push({
        id: pr.id,
        business_date: pr.business_date,
        created_at: pr.created_at,
        table_label: pr.table_label ?? '',
        item: pickName(itemName(pr.item_id), locale),
        status: pr.status,
        preferred_grams: pr.preferred_grams,
        quotes: qs.length,
        grams: shown?.grams ?? null,
        amount_minor: job.financial ? (shown?.amount_minor ?? null) : null,
        confirmed_via: confirmed?.confirmed_via ?? null,
        order_reference: confirmed?.reference ?? null,
        resolution: pr.resolution_reason,
      });
    }
    await r.tick();
  }

  // ---------------------------------------------------------------- payments (financial only)
  let payments: PaymentsSnap | null = null;
  const bills: BillRow[] = [];
  if (job.financial) {
    const methods = new Map<string, PaymentsSnap['methods'][number]>();
    const monthlyMoney = new Map(months.map((m) => [m, { key: m, finalized_minor: 0, paid_minor: 0 }]));
    const exceptions: PaymentException[] = [...closeExceptions];
    let finalizedMinor = 0, finalizedBills = 0, settledMinor = 0, settlements = 0, reversalMinor = 0, reversals = 0, refundMinor = 0, refunds = 0;
    // Every reversal and refund record, whatever its date, keyed by the settlement it corrects.
    // A correction counts against its settlement's month (D-S8-03): "paid, net" for any period is
    // then exactly the settlements of that period still in force, as on the KPI screen, and a
    // correction is never subtracted twice (once as "marked reversed", once as its own row).
    const counterRows = r.all<{ sid: string; rev: string; kind: string; amount_minor: number; reason: string | null; confirmed_at: string }>(
      `SELECT c.reverses_payment_id AS sid, s.bill_revision_id AS rev, c.kind, c.amount_minor, c.reason, c.confirmed_at
         FROM payments c JOIN payments s ON s.id = c.reverses_payment_id
        WHERE c.reverses_payment_id IS NOT NULL AND c.kind IN ('reversal', 'refund_record') AND c.status = 'confirmed'
          AND c.business_date >= :from AND (:fx = 1 OR c.is_fixture = 0)`, base);
    const counters = new Map(counterRows.map((c) => [c.sid, c]));
    // Revisions whose settlement was refunded after checkout: not "unpaid" (the refund row explains them).
    const refundedRevisions = new Set(counterRows.filter((c) => c.kind === 'refund_record').map((c) => c.rev));
    for (const mk of months) {
      const mp = { ...base, mf: `${mk}-01`, mt: monthEnd(mk) };
      const pays = r.all<{ id: string; visit_id: string; bill_revision_id: string; kind: string; method: string; amount_minor: number; status: string; reverses_payment_id: string | null; reason: string | null; confirmed_at: string; business_date: string }>(
        `SELECT id, visit_id, bill_revision_id, kind, method, amount_minor, status, reverses_payment_id, reason, confirmed_at, business_date
           FROM payments WHERE business_date BETWEEN :mf AND :mt AND kind = 'settlement' AND (:fx = 1 OR is_fixture = 0) ORDER BY confirmed_at`, mp);
      for (const p of pays) {
        if (p.status !== 'confirmed' && p.status !== 'reversed') continue;
        const m = methods.get(p.method) ?? { method: p.method, label: methodLabels.get(p.method) ?? p.method, count: 0, amount_minor: 0, reversed_count: 0, reversed_minor: 0 };
        methods.set(p.method, m);
        const money = monthlyMoney.get(mk)!;
        const label = tableOfVisit.get(p.visit_id) ?? '';
        settlements++;
        settledMinor += p.amount_minor;
        m.count++;
        m.amount_minor += p.amount_minor;
        money.paid_minor += p.amount_minor;
        if (p.status !== 'reversed') continue;
        const c = counters.get(p.id);
        m.reversed_count++;
        m.reversed_minor += p.amount_minor;
        money.paid_minor -= p.amount_minor;
        const late = c ? businessDate(c.confirmed_at, cutoff) > to : false;
        if (c?.kind === 'refund_record') {
          refunds++;
          refundMinor += p.amount_minor;
          exceptions.push({ kind: 'refund_record', at: c.confirmed_at, visit_id: p.visit_id, table_label: label, amount_minor: p.amount_minor, detail: c.reason ?? 'Refund recorded after checkout' });
          corrections.push({ at: c.confirmed_at, kind: 'payment_reversal', reference: '', table_label: label, item: '', from: 'paid', to: 'refunded', reason: c.reason ?? '', actor: 'Staff', late });
        } else {
          reversals++;
          reversalMinor += p.amount_minor;
          exceptions.push({ kind: 'reversed', at: c?.confirmed_at ?? p.confirmed_at, visit_id: p.visit_id, table_label: label, amount_minor: p.amount_minor, detail: c ? (c.reason ?? 'Reversal') : 'Settlement marked reversed' });
          if (c) corrections.push({ at: c.confirmed_at, kind: 'payment_reversal', reference: '', table_label: label, item: '', from: 'paid', to: 'reversed', reason: c.reason ?? '', actor: 'Staff', late });
        }
      }
      const revs = r.all<{ id: string; visit_id: string; revision_no: number; status: string; subtotal_minor: number; adjustments_minor: number; charges_json: string; total_minor: number; finalized_at: string; business_date: string; supersede_reason: string | null; visit_status: string }>(
        `SELECT b.id, b.visit_id, b.revision_no, b.status, b.subtotal_minor, b.adjustments_minor, b.charges_json, b.total_minor, b.finalized_at,
                b.business_date, b.supersede_reason, v.status AS visit_status
           FROM bill_revisions b JOIN visits v ON v.id = b.visit_id
          WHERE b.business_date BETWEEN :mf AND :mt AND (:fx = 1 OR b.is_fixture = 0) ORDER BY b.finalized_at`, mp);
      const paidByRevision = new Map<string, { minor: number; count: number; methods: Set<string> }>();
      if (revs.length) {
        for (const p of r.all<{ bill_revision_id: string; amount_minor: number; method: string; kind: string; status: string }>(
          `SELECT p.bill_revision_id, p.amount_minor, p.method, p.kind, p.status FROM payments p JOIN bill_revisions b ON b.id = p.bill_revision_id
            WHERE b.business_date BETWEEN :mf AND :mt AND (:fx = 1 OR b.is_fixture = 0)`, mp)) {
          const e = paidByRevision.get(p.bill_revision_id) ?? { minor: 0, count: 0, methods: new Set<string>() };
          if (p.kind === 'settlement' && p.status === 'confirmed') {
            e.minor += p.amount_minor;
            e.count++;
            e.methods.add(methodLabels.get(p.method) ?? p.method);
          }
          paidByRevision.set(p.bill_revision_id, e);
        }
      }
      for (const b of revs) {
        let charges = 0;
        try {
          for (const c of JSON.parse(b.charges_json) as Array<{ amount_minor?: number; inclusive?: boolean }>) if (!c.inclusive) charges += c.amount_minor ?? 0;
        } catch { /* unreadable snapshot: charges shown as 0 */ }
        const paid = paidByRevision.get(b.id);
        const label = tableOfVisit.get(b.visit_id) ?? '';
        if (b.status !== 'superseded') {
          finalizedBills++;
          finalizedMinor += b.total_minor;
          monthlyMoney.get(mk)!.finalized_minor += b.total_minor;
          // Payment exceptions, as the KPI screen defines them (D-S6-10): a current revision with no
          // confirmed settlement once the visit closed or its finalize date passed (valued at the total),
          // or a settlement that differs from the total (valued at the difference).
          // A zero-total revision owes nothing (checkout settles it without a payment row), as in kpi.ts.
          if (!paid?.count && b.total_minor > 0 && refundedRevisions.has(b.id)) {
            // Settled, then refunded after checkout: listed once, as the refund record.
          } else if (!paid?.count && b.total_minor > 0 && (b.visit_status === 'closed' || b.business_date < today)) {
            exceptions.push({ kind: 'finalized_unpaid', at: b.finalized_at, visit_id: b.visit_id, table_label: label, amount_minor: b.total_minor, detail: `Revision ${b.revision_no} has no confirmed settlement${b.visit_status === 'closed' ? ' and the visit is closed' : ''}` });
          } else if (paid?.count && paid.minor !== b.total_minor) {
            exceptions.push({ kind: 'amount_mismatch', at: b.finalized_at, visit_id: b.visit_id, table_label: label, amount_minor: Math.abs(paid.minor - b.total_minor), detail: `Settled ${paid.minor >= b.total_minor ? 'more' : 'less'} than revision ${b.revision_no}'s total` });
          }
        } else {
          corrections.push({ at: b.finalized_at, kind: 'bill_reopened', reference: `bill r${b.revision_no}`, table_label: label, item: '', from: 'finalized', to: 'superseded', reason: b.supersede_reason ?? '', actor: 'Manager', late: false });
        }
        bills.push({
          id: b.id, business_date: b.business_date,
          finalized_at: b.finalized_at, visit_id: b.visit_id, table_label: label, revision_no: b.revision_no, status: b.status,
          subtotal_minor: b.subtotal_minor, adjustments_minor: b.adjustments_minor, charges_minor: charges, total_minor: b.total_minor,
          paid_minor: paid?.minor ?? 0, methods: [...(paid?.methods ?? [])].join(', '), note: b.supersede_reason ?? '',
        });
      }
      await r.tick();
    }
    const adj = r.get<{ n: number; minor: number | null; voided: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN a.voided_at IS NULL THEN a.amount_minor ELSE 0 END) AS minor,
              SUM(a.voided_at IS NOT NULL) AS voided
         FROM bill_adjustments a JOIN visits v ON v.id = a.visit_id
        WHERE a.created_at >= :start AND a.created_at < :end AND (:fx = 1 OR v.is_fixture = 0)`, base);
    const acceptedMinor = yearBucket.c.accepted_minor;
    payments = {
      submitted_minor: submittedMinor,
      accepted_minor: acceptedMinor,
      finalized_minor: finalizedMinor,
      finalized_bills: finalizedBills,
      settled_minor: settledMinor,
      settlements,
      reversal_minor: reversalMinor,
      reversals,
      refund_minor: refundMinor,
      refunds,
      net_paid_minor: settledMinor - reversalMinor - refundMinor,
      adjustments: { count: adj?.n ?? 0, minor: adj?.minor ?? 0, voided: adj?.voided ?? 0 },
      methods: [...methods.values()].sort((a, b) => b.amount_minor - a.amount_minor),
      monthly: [...monthlyMoney.values()],
      exceptions: exceptions.sort((a, b) => a.at.localeCompare(b.at)),
      exception_count: exceptions.filter((e) => e.kind === 'finalized_unpaid' || e.kind === 'amount_mismatch').length,
      exception_minor: exceptions.filter((e) => e.kind === 'finalized_unpaid' || e.kind === 'amount_mismatch').reduce((s, e) => s + e.amount_minor, 0),
      open_bills_at_cutoff: r.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bills b JOIN visits v ON v.id = b.visit_id WHERE b.status <> 'settled' AND v.status <> 'closed' AND (:fx = 1 OR v.is_fixture = 0)`, base)?.n ?? 0,
    };
  }

  // ---------------------------------------------------------------- ranking
  const availabilityLogs = r.all<AvailabilityLog>(
    'SELECT item_id, available, changed_at FROM availability_log WHERE changed_at < :end ORDER BY item_id, changed_at, id', { end: windowEnd });
  await r.tick();
  const ranking = buildRanking({
    items,
    categories,
    accs: itemAccs,
    availability: periodDays > 0 ? computeAvailability(availabilityLogs, windowStart, windowEnd, cutoff) : new Map(),
    periodDays,
    periodFrom,
    periodTo,
    operatingMode: settings.operating_mode,
    pricedVariantItems,
  });
  await r.tick();

  // ---------------------------------------------------------------- engagement
  const engagement = await readEngagement(r, {
    dates,
    from,
    to,
    startUtc: utc.start,
    fx,
    analyticsEnabled: settings.analytics.enabled,
    instrumentationStartedAt: settings.analytics.instrumentation_started_at,
    rawRetentionDays: settings.retention.raw_events_days,
    categories: categoryRows.filter((c) => c.status === 'published').map((c) => ({ id: c.id, name: { th: c.name_th, en: c.name_en } })),
    orderingVisits,
    attributedQty,
    orderSessions,
    totalRounds: yearBucket.c.submitted,
    staffRounds: (sources.staff ?? 0) + (sources.manual_recovery ?? 0) + (sources.portion_quote ?? 0),
    itemName,
    categoryName,
  });

  // ---------------------------------------------------------------- guest ratings
  // What guests chose to send, not a survey: the sample size travels with the
  // average wherever it is printed (D-F-06). Comment TEXT is never read here -
  // only how many entries carried one, the same rule the order notes follow.
  await r.tick();
  const fbRange = { from, to, fx };
  const fbTotals = r.get<{ entries: number; rated: number; sum: number | null; with_comment: number }>(
    `SELECT COUNT(*) AS entries,
            COALESCE(SUM(f.rating IS NOT NULL), 0) AS rated,
            SUM(f.rating) AS sum,
            COALESCE(SUM(f.comment IS NOT NULL), 0) AS with_comment
       FROM feedback f WHERE f.business_date BETWEEN :from AND :to AND (:fx = 1 OR f.is_fixture = 0)`, fbRange)
    ?? { entries: 0, rated: 0, sum: null, with_comment: 0 };
  const fbByRating = new Map(r.all<{ rating: number; n: number }>(
    `SELECT f.rating, COUNT(*) AS n FROM feedback f
      WHERE f.business_date BETWEEN :from AND :to AND (:fx = 1 OR f.is_fixture = 0) AND f.rating IS NOT NULL
      GROUP BY f.rating`, fbRange).map((x) => [x.rating, x.n]));
  const feedback: ReportSnapshot['feedback'] = {
    entries: fbTotals.entries,
    rated: fbTotals.rated,
    average_rating: fbTotals.rated > 0 ? Math.round(((fbTotals.sum ?? 0) / fbTotals.rated) * 100) / 100 : null,
    distribution: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: fbByRating.get(rating) ?? 0 })),
    with_comment: fbTotals.with_comment,
  };

  // ---------------------------------------------------------------- periods
  const daily: DailyRow[] = dates.map((d) => ({
    ...bucketCounters(dayBuckets.get(d)!),
    date: d,
    weekday: isoWeekday(d),
    state: d > today ? 'future' : d === today ? 'partial' : recordsBegin === null || d < recordsBegin ? 'before_records' : 'complete',
  }));
  const monthly: PeriodRow[] = months.map((mk, i) => {
    const mf = `${mk}-01`;
    const mt = monthEnd(mk);
    return { ...bucketCounters(monthBuckets.get(mk)!), key: mk, label: MONTHS[i], from: mf, to: mt, state: periodState(mf, mt, today, recordsBegin), clipped: false };
  });
  const weekly: PeriodRow[] = [...weekBuckets.keys()].sort().map((wk) => {
    const windowTo = addDays(wk, 6);
    const f = wk < from ? from : wk;
    const t = windowTo > to ? to : windowTo;
    return {
      ...bucketCounters(weekBuckets.get(wk)!),
      key: wk,
      label: `${shortDate(f)} – ${shortDate(t)}`,
      from: f,
      to: t,
      state: periodState(f, t, today, recordsBegin),
      clipped: f !== wk || t !== windowTo,
      window_from: wk,
      window_to: windowTo,
    };
  });
  const yearCounters = bucketCounters(yearBucket);
  const busiestMonth = monthly.reduce<{ key: string; submitted: number } | null>(
    (best, m) => (m.submitted > (best?.submitted ?? 0) ? { key: m.label, submitted: m.submitted } : best), null);

  // ---------------------------------------------------------------- version history
  const versions: VersionRow[] = r.all<{ id: string; revision: number; label: VersionRow['label']; status: string; requested_at: string; finished_at: string | null; requested_by: string; data_cutoff: string | null; data_version: number | null; reason: string | null; file_sha256: string | null; summary_json: string | null; display_name: string | null }>(
    `SELECT j.id, j.revision, j.label, j.status, j.requested_at, j.finished_at, j.requested_by, j.data_cutoff, j.data_version,
            j.reason, j.file_sha256, j.summary_json, su.display_name
       FROM report_jobs j LEFT JOIN staff_users su ON su.id = j.requested_by
      WHERE j.kind = :kind AND j.year = :year AND j.include_fixture = :fx ORDER BY j.revision`,
    { kind: job.kind, year, fx }).map((v) => ({
    id: v.id,
    revision: v.revision,
    label: v.label,
    status: v.id === job.id ? 'this report' : v.status,
    requested_at: v.requested_at,
    finished_at: v.finished_at,
    requested_by: v.display_name ?? requesterLabel(v.requested_by),
    data_cutoff: v.id === job.id ? dataCutoff : v.data_cutoff,
    data_version: v.id === job.id ? dataVersion : v.data_version,
    reason: v.reason,
    sha256: v.file_sha256,
    summary: parseSummary(v.summary_json),
    current: v.id === job.id,
  }));

  // ---------------------------------------------------------------- notes
  const fixtureRounds = fx ? 0 : (r.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM orders WHERE business_date BETWEEN :from AND :to AND is_fixture = 1', base)?.n ?? 0);
  const notes: string[] = [];
  if (job.include_fixture) notes.push('This report INCLUDES demo/fixture records. Do not use it as a record of real trading.');
  else if (fixtureRounds > 0) notes.push(`${fixtureRounds} demo/fixture order round${fixtureRounds === 1 ? ' was' : 's were'} recorded in this year and excluded from every figure.`);
  if (yearState === 'current') notes.push(`The year is still in progress. ${longDate(today)} is partial (data to ${localStamp(dataCutoff)} Bangkok time); later days are shown as future, not as zero.`);
  if (yearState === 'future') notes.push('This year has not started yet; every day is shown as future.');
  if (recordsBegin && recordsBegin > from) notes.push(`The first operating day (first seated visit) is ${longDate(recordsBegin)}. Earlier days are marked "before records" rather than zero.`);
  if (!recordsBegin) notes.push('No visit has been seated yet, so there is no first operating day and every day is "before records".');
  const seated = yearCounters.seated;
  if (seated > yearCounters.covered) notes.push(`${seated - yearCounters.covered} of ${seated} seated visits have no covers entered. Recorded diners count only entered covers; missing people are not estimated.`);
  if (sources.manual_recovery) notes.push(`${sources.manual_recovery} recovered paper order${sources.manual_recovery === 1 ? '' : 's'} are counted in volumes but excluded from timing statistics, because their times were entered after the fact.`);
  if (excludedPrepared) notes.push(`${excludedPrepared} line${excludedPrepared === 1 ? ' was' : 's were'} marked prepared before entry and are excluded from preparation timings.`);
  if (engagement.raw_events === 0 && engagement.agg_fallback_days === 0) notes.push('No engagement telemetry was recorded in this year. Order figures are unaffected: they come from the order records.');
  if (engagement.raw_first_date && engagement.raw_first_date > from) notes.push(`Raw engagement events for this year start on ${longDate(engagement.raw_first_date)}${engagement.agg_fallback_days ? `; ${engagement.agg_fallback_days} earlier day(s) use daily item aggregates (impressions, detail opens and adds only)` : ''}.`);
  if (!settings.analytics.enabled) notes.push('Engagement analytics is currently switched off in settings.');
  // Ratings are self-selected: never let an average be read as the year's verdict.
  if (feedback.rated === 0) notes.push('No guest sent a rating in this year, so there is no average guest rating.');
  else notes.push(`The average guest rating is from ${feedback.rated} rating${feedback.rated === 1 ? '' : 's'} guests chose to send, not from every party served.`);
  if (engagement.opted_out_sessions) notes.push(`${engagement.opted_out_sessions} browsing session(s) opted out of engagement measurement and are excluded from engagement rates.`);
  if (job.financial && !settings.charges_confirmed) notes.push('Charge settings have not been confirmed by the owner; bill totals use the charges configured at each seating.');
  if (!job.financial) notes.push('Payment and bill values are excluded: the requesting role does not hold the reports.financial permission.');
  if (!r.isolated) notes.push('Snapshot isolation was not available (in-memory database); figures were read without a dedicated snapshot transaction.');
  if (openVisits && yearState !== 'completed') notes.push(`${openVisits} visit(s) were still open at the data cutoff; their checkout is not yet counted.`);

  const overview = {
    ...yearCounters,
    guest_rounds: sources.guest ?? 0,
    staff_rounds: sources.staff ?? 0,
    recovered_rounds: sources.manual_recovery ?? 0,
    portion_rounds: sources.portion_quote ?? 0,
    rejected_items: rejectedItems,
    cancelled_items: cancelledItems,
    measured_servings: measuredServings,
    lines: linesTotal,
    lines_with_note: linesWithNote,
    lines_with_allergy_flag: linesWithAllergy,
    active_days: activeDays,
    elapsed_days: elapsedDays,
    busiest_day: busiestDay,
    busiest_month: busiestMonth,
    service_requests: serviceTotal,
    portion_requests: portionStats.requests,
    records_begin: recordsBegin,
    open_visits_at_cutoff: openVisits,
  };

  return {
    job,
    restaurant: { name_th: settings.restaurant.name_th, name_en: settings.restaurant.name_en, short_en: settings.restaurant.short_en },
    default_locale: locale,
    operating_mode: settings.operating_mode,
    range: { from, to, start_utc: utc.start, end_utc: utc.end, cutoff_hour: cutoff, timezone: TIMEZONE },
    generated_at: new Date().toISOString(),
    data_cutoff: dataCutoff,
    data_version: dataVersion,
    today,
    year_state: yearState,
    isolated_snapshot: r.isolated,
    overview,
    daily,
    monthly,
    weekly,
    ranking,
    engagement,
    feedback,
    timings: {
      accept_s: statOf(acceptS),
      accept_to_prepare_s: statOf(acceptToPrepS),
      stations: [...stationTimes.entries()].sort((a, b) => (a[0] === 'kitchen' ? -1 : 1) - (b[0] === 'kitchen' ? -1 : 1)).map(([station, t]) => ({
        station, lines: t.lines, prepare_s: statOf(t.prepare), serve_s: statOf(t.serve), total_s: statOf(t.total),
      })),
      visit_minutes: statOf(visitMinutes),
      visits_closed: visitsClosed,
      service: [...serviceStats.entries()].map(([type, s]) => ({
        type, count: s.count, completed: s.completed, cancelled: s.cancelled, open: s.open, ack_s: statOf(s.ack), complete_s: statOf(s.complete),
      })).sort((a, b) => b.count - a.count),
      hourly,
      weekday,
      excluded_recovered_rounds: sources.manual_recovery ?? 0,
      excluded_prepared_before_entry: excludedPrepared,
      portions: portionStats,
    },
    exceptions: {
      reasons: [...reasons.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.qty - a.qty),
      cancel_stages: [...cancelStages.values()].sort((a, b) => b.lines - a.lines),
      late_changes: lateChanges,
      corrections: correctionCount,
      recoveries: recoveryCount,
    },
    payments,
    orders: orderRows,
    corrections: corrections.sort((a, b) => a.at.localeCompare(b.at)),
    portions,
    bills,
    versions,
    notes,
    settings: {
      charges_confirmed: settings.charges_confirmed,
      analytics_enabled: settings.analytics.enabled,
      raw_events_days: settings.retention.raw_events_days,
      notes_days: settings.retention.notes_days,
      audit_days: settings.retention.audit_days,
      feedback_days: settings.retention.feedback_days,
      retention_last_run: r.get<{ at: string }>("SELECT built_at AS at FROM agg_state WHERE name = 'retention'")?.at ?? null,
    },
    line_status_totals: lineStatusTotals,
  };
}

export function requesterLabel(requestedBy: string): string {
  if (requestedBy === 'system') return 'System (year-end rollover)';
  if (requestedBy === 'cli') return 'Command line';
  return 'Former staff account';
}

function parseSummary(json: string | null): SnapshotSummary | null {
  if (!json) return null;
  try { return JSON.parse(json) as SnapshotSummary; } catch { return null; }
}

export function summaryOf(s: ReportSnapshot): SnapshotSummary {
  const out: SnapshotSummary = {
    submitted_rounds: s.overview.submitted,
    accepted_rounds: s.overview.accepted,
    ordering_visits: s.overview.visits,
    diners: s.overview.diners,
    items_net: s.overview.items,
  };
  if (s.payments) {
    out.accepted_minor = s.payments.accepted_minor;
    out.paid_minor = s.payments.net_paid_minor;
  }
  return out;
}

