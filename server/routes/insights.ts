// Insights HTTP adapters (S6): engagement ingestion (public) and the staff
// Order Stats, Menu Stats, Engagement, KPI and CSV export endpoints.
// Mounted at /api/analytics and /api/staff (see server/app.ts, docs/API.md).
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import type { EngagementDTO, MenuStatsDTO, OrderStatsDTO } from '../../shared/dto.ts';
import { IdSchema, IsoDateSchema, StatsQuery } from '../../shared/schemas.ts';
import { bangkokParts } from '../../shared/time.ts';
import { many } from '../db/index.ts';
import { assertCan, requireStaff, resolveGuest, staffOf } from '../lib/auth.ts';
import { csvResponseHeaders, toCsv, type CsvColumn } from '../lib/csv.ts';
import { AppError } from '../lib/errors.ts';
import { clientIp } from '../lib/http.ts';
import { ingestAnalytics, engagementStats } from '../domain/analytics.ts';
import { datesBetween, fixtureSql, resolvePeriod, type StatsParams } from '../domain/aggregates.ts';
import { kpis } from '../domain/kpi.ts';
import { dayDrilldown, itemStats, listRounds, menuStats, orderStats, type RoundRow } from '../domain/stats.ts';

// ------------------------------------------------------------------ query parsing
const PERIODS = ['week', 'month', 'year', 'custom'] as const;
const METRICS = ['rounds', 'accepted_rounds', 'visits', 'devices', 'diners', 'items'] as const;

/** StatsQuery with an optional period: from+to alone means a custom range. */
const BaseQuery = StatsQuery.extend({ period: z.enum(PERIODS).optional() });
const OrderStatsQuery = BaseQuery.extend({ metric: z.enum(METRICS).default('rounds') });
const DayQuery = z.object({ date: IsoDateSchema, include_fixture: z.enum(['0', '1']).default('0') });
const MenuQuery = BaseQuery.extend({
  category: IdSchema.optional(),
  direction: z.enum(['most', 'least']).default('most'),
  measure: z.enum(['net', 'submitted', 'per_available_day', 'grams']).default('net'),
});
const ExportQuery = MenuQuery.extend({
  view: z.enum(['orders', 'menu', 'engagement']),
  metric: z.enum(METRICS).default('rounds'),
  /** orders view: one row per day (default) or per round. */
  rows: z.enum(['day', 'order']).default('day'),
  /** engagement view: raw events instead of the summary (reports.export_raw). */
  raw: z.enum(['0', '1']).default('0'),
});

/** Validate query parameters, treating empty values (`?anchor=`) as absent. */
function statsQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation_failed', 'Some query parameters are not valid', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

function periodParams(q: z.infer<typeof BaseQuery>): StatsParams {
  return {
    period: q.period ?? (q.from && q.to ? 'custom' : 'week'),
    anchor: q.anchor ?? null,
    from: q.from ?? null,
    to: q.to ?? null,
    include_fixture: q.include_fixture === '1',
  };
}

// ------------------------------------------------------------------ CSV builders
/** Bangkok wall-clock ISO string with its offset, e.g. 2026-01-15T19:30:00+07:00. */
export function bangkokIso(iso: string | null): string | null {
  if (!iso) return null;
  const p = bangkokParts(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}+07:00`;
}

function dayRowsCsv(s: OrderStatsDTO): string {
  type Row = OrderStatsDTO['buckets'][number] | { date: string; label: string; state: string; value: number; breakdown: OrderStatsDTO['buckets'][number]['breakdown'] | null };
  const cols: CsvColumn<Row>[] = [
    { key: 'date', header: s.period === 'year' ? 'month' : 'business_date', value: (r) => r.date },
    { key: 'state', header: 'state', value: (r) => r.state },
    { key: 'value', header: `value_${s.metric}`, value: (r) => r.value },
    { key: 'submitted', header: 'submitted_rounds', value: (r) => r.breakdown?.submitted },
    { key: 'accepted', header: 'accepted_rounds', value: (r) => r.breakdown?.accepted },
    { key: 'rejected', header: 'rejected_rounds', value: (r) => r.breakdown?.rejected },
    { key: 'cancelled', header: 'cancelled_rounds', value: (r) => r.breakdown?.cancelled },
    { key: 'visits', header: 'ordering_visits', value: (r) => r.breakdown?.visits },
    { key: 'devices', header: 'ordering_devices_approx', value: (r) => r.breakdown?.devices },
    { key: 'diners', header: 'recorded_diners', value: (r) => r.breakdown?.diners },
    { key: 'with_covers', header: 'visits_with_covers', value: (r) => r.breakdown?.diners_coverage.with_covers },
    { key: 'seated', header: 'visits_seated', value: (r) => r.breakdown?.diners_coverage.visits },
    { key: 'items', header: 'items_accepted', value: (r) => r.breakdown?.items },
  ];
  // The period total is recomputed at period level, so only the selected metric is given.
  const totalRow: Row = { date: `${s.from}..${s.to}`, label: 'total', state: 'period_total', value: s.total, breakdown: null };
  return toCsv<Row>([...s.buckets, totalRow], cols);
}

function roundRowsCsv(rows: RoundRow[], showMoney: boolean): string {
  const cols: CsvColumn<RoundRow>[] = [
    { key: 'business_date', header: 'business_date', value: (r) => r.business_date },
    { key: 'reference', header: 'order_reference', value: (r) => r.reference },
    { key: 'submitted_at', header: 'submitted_at_bangkok', value: (r) => bangkokIso(r.submitted_at) },
    { key: 'local_at', header: 'order_time_bangkok', value: (r) => bangkokIso(r.local_at) },
    { key: 'table', header: 'table_at_order', value: (r) => r.table_label },
    { key: 'round', header: 'round_no', value: (r) => r.round_no },
    { key: 'source', header: 'source', value: (r) => r.source },
    { key: 'status', header: 'status', value: (r) => r.status },
    { key: 'items', header: 'items_active', value: (r) => r.items },
    { key: 'chargeable', header: 'items_accepted', value: (r) => r.chargeable_items },
  ];
  if (showMoney) cols.push({ key: 'subtotal', header: 'active_subtotal_thb', value: (r) => (r.subtotal_minor === null ? null : (r.subtotal_minor / 100).toFixed(2)) });
  return toCsv(rows, cols);
}

function rankingCsv(s: MenuStatsDTO): string {
  type Row = MenuStatsDTO['rows'][number];
  const cols: CsvColumn<Row>[] = [
    { key: 'rank', header: 'rank', value: (r) => r.rank },
    { key: 'item_id', header: 'item_id', value: (r) => r.item_id },
    { key: 'name_th', header: 'name_th', value: (r) => r.name.th },
    { key: 'name_en', header: 'name_en', value: (r) => r.name.en },
    { key: 'category_en', header: 'category_en', value: (r) => r.category.en },
    { key: 'category_th', header: 'category_th', value: (r) => r.category.th },
    { key: 'measured', header: 'measured_weight', value: (r) => r.measured_weight },
    { key: 'net', header: 'net_qty', value: (r) => r.net_qty },
    { key: 'submitted', header: 'submitted_qty', value: (r) => r.submitted_qty },
    { key: 'grams', header: 'grams', value: (r) => r.grams },
    { key: 'orders', header: 'orders', value: (r) => r.orders },
    { key: 'visits', header: 'visits', value: (r) => r.visits },
    { key: 'share', header: 'share_of_quantity', value: (r) => r.share },
    { key: 'change', header: 'change', value: (r) => r.change.label },
    { key: 'previous', header: 'previous_net_qty', value: (r) => r.change.previous },
    { key: 'delta', header: 'change_delta', value: (r) => r.change.delta },
    { key: 'available_days', header: 'available_days', value: (r) => r.available_days },
    { key: 'period_days', header: 'period_days', value: (r) => r.period_days },
    { key: 'per_day', header: 'net_per_available_day', value: (r) => r.per_available_day },
    { key: 'availability', header: 'availability', value: (r) => r.availability },
    { key: 'quality', header: 'data_quality', value: (r) => r.quality },
    { key: 'archived', header: 'archived', value: (r) => r.archived },
    { key: 'variants', header: 'variants', value: (r) => r.variants.map((v) => `${v.name.en ?? v.name.th ?? '?'}: ${v.net_qty}`).join('; ') },
  ];
  return toCsv(s.rows, cols);
}

interface SummaryRow { section: string; key: string; name_th: string | null; name_en: string | null; value: number | string | null; denominator: number | null; sample: number | null }

function engagementCsv(e: EngagementDTO): string {
  const rows: SummaryRow[] = [];
  const add = (section: string, key: string, value: number | string | null, denominator: number | null = null, sample: number | null = null, name?: { th: string | null; en: string | null }) =>
    rows.push({ section, key, name_th: name?.th ?? null, name_en: name?.en ?? null, value, denominator, sample });
  const c = e.coverage;
  add('coverage', 'measured_sessions', c.measured_sessions);
  add('coverage', 'dining_sessions', c.dining_sessions, c.measured_sessions);
  add('coverage', 'public_sessions', c.public_sessions, c.measured_sessions);
  add('coverage', 'opted_out_sessions', c.opted_out_sessions);
  add('coverage', 'telemetry_since', c.telemetry_since);
  add('coverage', 'note', c.note);
  add('active_time', 'menu_ms_median', e.active_menu_ms.median, null, e.active_menu_ms.sample);
  add('active_time', 'menu_ms_p90', e.active_menu_ms.p90, null, e.active_menu_ms.sample);
  add('active_time', 'detail_ms_median', e.active_detail_ms.median, null, e.active_detail_ms.sample);
  add('active_time', 'detail_ms_p90', e.active_detail_ms.p90, null, e.active_detail_ms.sample);
  const f = e.funnel;
  add('funnel', 'dining_sessions', f.sessions);
  add('funnel', 'impression_sessions', f.impression_sessions, f.sessions);
  add('funnel', 'detail_sessions', f.detail_sessions, f.sessions);
  add('funnel', 'add_sessions', f.add_sessions, f.sessions);
  add('funnel', 'quick_add_sessions', f.quick_add_sessions, f.sessions);
  add('funnel', 'submit_sessions', f.submit_sessions, f.sessions);
  add('orders', 'attributed_orders', f.attributed_orders, f.attributed_orders + f.unattributed_orders);
  add('orders', 'unattributed_orders', f.unattributed_orders, f.attributed_orders + f.unattributed_orders);
  for (const s of e.scroll) add('scroll_depth', `reached_${s.threshold}`, s.sessions, e.scroll_sessions ?? c.measured_sessions);
  for (const cat of e.categories) add('category_exposure', cat.category_id, cat.sessions_exposed, c.measured_sessions, null, cat.name);
  for (const it of e.items) {
    add('item_impressions', it.item_id, it.impressions, null, null, it.name);
    add('item_detail_opens', it.item_id, it.detail_opens, null, null, it.name);
    add('item_adds', it.item_id, it.adds, null, null, it.name);
    add('item_impression_sessions', it.item_id, it.impression_sessions ?? null, null, null, it.name);
    add('item_add_rate', it.item_id, it.add_rate, it.impression_sessions ?? null, null, it.name);
    add('item_submitted_qty_attributed', it.item_id, it.submitted, null, null, it.name);
  }
  for (const d of e.daily) {
    add('daily_sessions', d.date, d.sessions);
    add('daily_active_menu_ms', d.date, d.active_ms);
  }
  return toCsv(rows, [
    { key: 'section', header: 'section', value: (r) => r.section },
    { key: 'key', header: 'key', value: (r) => r.key },
    { key: 'name_th', header: 'name_th', value: (r) => r.name_th },
    { key: 'name_en', header: 'name_en', value: (r) => r.name_en },
    { key: 'value', header: 'value', value: (r) => r.value },
    { key: 'denominator', header: 'denominator', value: (r) => r.denominator },
    { key: 'sample', header: 'sample', value: (r) => r.sample },
  ]);
}

interface RawEventRow {
  event_id: string; session_id: string; kind: string; type: string; route: string | null; item_id: string | null;
  category_id: string | null; active_ms: number | null; depth: number | null; position: number | null;
  quantity_delta: number | null; quick_add: number | null; layout_version: string | null; menu_version: string | null;
  client_seq: number | null; received_at: string; business_date: string; is_fixture: number;
}

/**
 * Retained raw events (pseudonymous session ids; no visit ids, no free text),
 * streamed one business day at a time with a yield in between: a year of
 * events is tens of megabytes, and building it in one piece stalled ordering
 * for over a second (D-S8-14).
 */
function rawEventsCsv(p: StatsParams): ReadableStream<Uint8Array> {
  const rp = resolvePeriod(p);
  const keys: Array<keyof RawEventRow> = ['event_id', 'session_id', 'kind', 'type', 'route', 'item_id', 'category_id', 'active_ms', 'depth',
    'position', 'quantity_delta', 'quick_add', 'layout_version', 'menu_version', 'client_seq', 'business_date', 'is_fixture'];
  const cols: CsvColumn<RawEventRow>[] = keys.map((k) => ({ key: k, header: k === 'kind' ? 'session_kind' : k, value: (r) => r[k] }));
  cols.splice(cols.length - 2, 0, { key: 'received_at', header: 'received_at_bangkok', value: (r) => bangkokIso(r.received_at) });
  const dates = datesBetween(rp.from, rp.to);
  const encoder = new TextEncoder();
  let index = -1;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === -1) {
        index = 0;
        controller.enqueue(encoder.encode(toCsv([], cols)));
        return;
      }
      // Skip empty days in one go; stop after one non-empty day per pull.
      while (index < dates.length) {
        const rows = many<RawEventRow>(
          `SELECT e.event_id, e.session_id, s.kind, e.type, e.route, e.item_id, e.category_id, e.active_ms, e.depth, e.position,
                  e.quantity_delta, e.quick_add, e.layout_version, e.menu_version, e.client_seq, e.received_at, e.business_date, e.is_fixture
             FROM analytics_events e JOIN analytics_sessions s ON s.id = e.session_id
            WHERE e.business_date = :d AND ${fixtureSql('e', rp.include_fixture)}
            ORDER BY e.received_at, e.session_id, e.client_seq, e.event_id`,
          { d: dates[index++] },
        );
        if (rows.length === 0) continue;
        controller.enqueue(encoder.encode(toCsv(rows, cols, { bom: false, header: false })));
        await new Promise<void>((resolve) => setImmediate(resolve));
        return;
      }
      controller.close();
    },
  });
}

function exportName(view: string, p: StatsParams): string {
  const rp = resolvePeriod(p);
  return `rabbit-grill-${view}-${rp.from}_${rp.to}${rp.include_fixture ? '-incl-demo' : ''}.csv`;
}

// ------------------------------------------------------------------ staff routes
export const insightsStaff = new Hono<AppEnv>()
  .get('/stats/orders', requireStaff('stats.view'), (c) => {
    const q = statsQuery(c, OrderStatsQuery);
    return c.json(orderStats({ ...periodParams(q), metric: q.metric }));
  })
  .get('/stats/orders/day', requireStaff('stats.view'), (c) => {
    const q = statsQuery(c, DayQuery);
    return c.json(dayDrilldown(q.date, { include_fixture: q.include_fixture === '1', showMoney: staffOf(c).can('billing.view') }));
  })
  .get('/stats/menu', requireStaff('stats.view'), (c) => {
    const q = statsQuery(c, MenuQuery);
    return c.json(menuStats({ ...periodParams(q), category: q.category ?? null, direction: q.direction, measure: q.measure }));
  })
  .get('/stats/menu/items/:id', requireStaff('stats.view'), (c) => {
    const id = IdSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new AppError('not_found', 'Menu item not found');
    return c.json(itemStats(id.data, periodParams(statsQuery(c, BaseQuery))));
  })
  .get('/stats/engagement', requireStaff('stats.engagement'), (c) => {
    return c.json(engagementStats(periodParams(statsQuery(c, BaseQuery))));
  })
  .get('/stats/kpis', requireStaff('stats.view'), (c) => {
    const q = statsQuery(c, BaseQuery);
    return c.json(kpis({ ...periodParams(q), financial: staffOf(c).can('reports.financial') }));
  })
  .get('/stats/export.csv', requireStaff('stats.view'), (c) => {
    const q = statsQuery(c, ExportQuery);
    const p = periodParams(q);
    const staff = staffOf(c);
    let csv: string | ReadableStream<Uint8Array>;
    let name: string;
    switch (q.view) {
      case 'orders':
        if (q.rows === 'order') {
          const rp = resolvePeriod(p);
          const showMoney = staff.can('billing.view');
          csv = roundRowsCsv(listRounds(rp.from, rp.to, rp.include_fixture, showMoney), showMoney);
          name = exportName('order-rounds', p);
        } else {
          csv = dayRowsCsv(orderStats({ ...p, metric: q.metric }));
          name = exportName(`orders-${q.metric}`, p);
        }
        break;
      case 'menu':
        csv = rankingCsv(menuStats({ ...p, category: q.category ?? null, direction: q.direction, measure: q.measure }));
        name = exportName(`menu-${q.direction}-${q.measure}`, p);
        break;
      case 'engagement':
        assertCan(c, 'stats.engagement');
        if (q.raw === '1') {
          assertCan(c, 'reports.export_raw');
          csv = rawEventsCsv(p);
          name = exportName('engagement-events', p);
        } else {
          csv = engagementCsv(engagementStats(p));
          name = exportName('engagement', p);
        }
        break;
    }
    return c.body(csv, 200, csvResponseHeaders(name));
  });

// ------------------------------------------------------------------ public ingestion
/** 100 events of a few hundred bytes each fit comfortably. */
const MAX_BATCH_BYTES = 128 * 1024;

export const analyticsRoutes = new Hono<AppEnv>()
  .post(
    '/batch',
    bodyLimit({
      maxSize: MAX_BATCH_BYTES,
      // Connection: close - the unread body stays on the socket, which must not be reused (D-S8-09).
      onError: (c) => c.json({ error: { code: 'bad_request', message: 'Analytics batch is too large' } }, 413, { Connection: 'close' }),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new AppError('bad_request', 'Expected a JSON body');
      }
      // The guest cookie is optional here and never cleared: telemetry must not
      // change anyone's access.
      const guest = resolveGuest(c);
      const result = ingestAnalytics(raw, {
        guest: 'guest' in guest ? guest.guest : null,
        guestError: 'error' in guest ? guest.error : null,
        ip: clientIp(c),
      });
      return c.json(result);
    },
  );

