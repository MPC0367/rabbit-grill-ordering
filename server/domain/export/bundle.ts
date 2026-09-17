// Annual data export: a ZIP of CSV files holding every row behind the annual
// report (brief 41, "companion CSV exports").
//
// Privacy rules for every file:
//  - guest notes are never exported, only a has_note / allergy_flag;
//  - PINs, QR/session tokens, passwords and payment references are never read;
//  - guest browser sessions and analytics sessions appear as pseudonymous
//    per-export references (sha256 of export id + row id), not database ids;
//  - money columns, bills and payments only when the job is financial;
//  - raw engagement events only when the requester may export raw data.
// Cells go through the foundation CSV writer (UTF-8 BOM, formula-injection safe).
import { createHash } from 'node:crypto';
import { csvCell, toCsv, type CsvColumn } from '../../lib/csv.ts';
import { deriveOrderStatus } from '../../../shared/status.ts';
import type { SnapshotReader } from './reader.ts';
import { DAY_LINES_SQL, DAY_ORDERS_SQL, modifierSummary, type LineDb } from './snapshot.ts';
import { secondsBetween } from './quantiles.ts';
import type { BillRow, CorrectionRow, DailyRow, PeriodRow, PortionRow, RankRow, ReportSnapshot } from './types.ts';
import { createZip } from './zip.ts';

type Cell = string | number | boolean | null | undefined;

/** Stream CSV text: header (with BOM) first, then rows in pieces. */
async function* csvPieces<T>(columns: CsvColumn<T>[], batches: AsyncIterable<T[]> | Iterable<T[]>, counter: { rows: number }): AsyncGenerator<string> {
  yield toCsv<T>([], columns);
  for await (const batch of batches as AsyncIterable<T[]>) {
    if (!batch.length) continue;
    counter.rows += batch.length;
    yield batch.map((row) => columns.map((c) => csvCell(c.value(row))).join(',')).join('\r\n') + '\r\n';
  }
}

const col = <T>(key: string, value: (row: T) => Cell, header = key): CsvColumn<T> => ({ key, header, value });

function months(year: number): Array<{ mf: string; mt: string }> {
  return Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    const last = new Date(Date.UTC(year, i + 1, 0)).getUTCDate();
    return { mf: `${year}-${m}-01`, mt: `${year}-${m}-${last}` };
  });
}

export interface BundleResult { files: Array<{ name: string; rows: number; bytes: number }>; bytes: number }

export async function writeCsvBundle(r: SnapshotReader, s: ReportSnapshot, outPath: string): Promise<BundleResult> {
  const job = s.job;
  const fin = job.financial;
  const fx = job.include_fixture ? 1 : 0;
  const base = { fx, from: s.range.from, to: s.range.to, start: s.range.start_utc, end: s.range.end_utc };
  const dates = s.daily.map((d) => d.date);
  const pseudo = (kind: string, id: string | null) => (id ? createHash('sha256').update(`${job.id}:${kind}:${id}`).digest('hex').slice(0, 12) : '');
  const zip = await createZip(outPath);
  const files: BundleResult['files'] = [];
  const add = async <T>(name: string, columns: CsvColumn<T>[], batches: AsyncIterable<T[]> | Iterable<T[]>) => {
    const counter = { rows: 0 };
    const { bytes } = await zip.add(name, csvPieces(columns, batches, counter));
    files.push({ name, rows: counter.rows, bytes });
  };

  try {
    // ------------------------------------------------------------ orders.csv
    type OrderCsv = Record<string, Cell>;
    async function* orderBatches(): AsyncGenerator<OrderCsv[]> {
      for (const d of dates) {
        const orders = r.all<Record<string, string | number | null>>(DAY_ORDERS_SQL, { ...base, d });
        if (!orders.length) { await r.tick(); continue; }
        const lines = r.all<LineDb>(DAY_LINES_SQL, { ...base, d });
        const byOrder = new Map<string, LineDb[]>();
        for (const l of lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), l]);
        const extra = new Map(r.all<{ id: string; finished_at: string | null; staff: string | null; is_fixture: number }>(
          `SELECT o.id, o.finished_at, su.display_name AS staff, o.is_fixture FROM orders o LEFT JOIN staff_users su ON su.id = o.staff_user_id
            WHERE o.business_date = :d AND (:fx = 1 OR o.is_fixture = 0)`, { ...base, d }).map((x) => [x.id, x]));
        yield orders.map((o) => {
          const ls = byOrder.get(String(o.id)) ?? [];
          const net = ls.filter((l) => ['accepted', 'preparing', 'almost_done', 'ready', 'served'].includes(l.status));
          const x = extra.get(String(o.id));
          return {
            ...o,
            business_date: d,
            status: deriveOrderStatus(ls),
            lines: ls.length,
            qty_total: ls.reduce((a, l) => a + l.quantity, 0),
            qty_net: net.reduce((a, l) => a + l.quantity, 0),
            accepted_minor: net.reduce((a, l) => a + l.line_total_minor, 0),
            has_note: ls.some((l) => l.has_note === 1),
            allergy_flag: ls.some((l) => l.allergy_flag === 1),
            finished_at: x?.finished_at ?? null,
            staff_name: x?.staff ?? null,
            is_fixture: x?.is_fixture === 1,
          };
        });
        await r.tick();
      }
    }
    await add<OrderCsv>('orders.csv', [
      col('order_id', (o) => o.id),
      col('reference', (o) => o.reference),
      col('business_date', (o) => o.business_date),
      col('submitted_at_utc', (o) => o.submitted_at),
      col('table_label', (o) => o.table_label),
      col('round_no', (o) => o.round_no),
      col('source', (o) => o.source),
      col('visit_id', (o) => o.visit_id),
      col('device_ref', (o) => pseudo('guest', o.guest_session_id as string | null)),
      col('analytics_session_ref', (o) => pseudo('analytics', o.analytics_session_id as string | null)),
      col('staff_name', (o) => o.staff_name),
      col('manual_reference', (o) => o.manual_reference),
      col('manual_original_time_utc', (o) => o.manual_original_time),
      col('status', (o) => o.status),
      col('lines', (o) => o.lines),
      col('qty_total', (o) => o.qty_total),
      col('qty_net', (o) => o.qty_net),
      ...(fin ? [col<OrderCsv>('submitted_subtotal_minor', (o) => o.subtotal_minor), col<OrderCsv>('accepted_value_minor', (o) => o.accepted_minor)] : []),
      col('has_note', (o) => o.has_note),
      col('allergy_flag', (o) => o.allergy_flag),
      col('first_accepted_at_utc', (o) => o.first_accepted_at),
      col('finished_at_utc', (o) => o.finished_at),
      col('is_fixture', (o) => o.is_fixture),
    ], orderBatches());

    // ------------------------------------------------------------ order_lines.csv
    type LineCsv = LineDb & { reference: string; business_date: string; category: string };
    const categoryNames = new Map(r.all<{ id: string; name_en: string }>('SELECT id, name_en FROM menu_categories').map((c) => [c.id, c.name_en]));
    const itemKeys = new Map(r.all<{ id: string; key: string }>('SELECT id, key FROM menu_items').map((i) => [i.id, i.key]));
    async function* lineBatches(): AsyncGenerator<LineCsv[]> {
      for (const d of dates) {
        const refs = new Map(r.all<{ id: string; reference: string }>(
          `SELECT o.id, o.reference FROM orders o WHERE o.business_date = :d AND (:fx = 1 OR o.is_fixture = 0)`, { ...base, d }).map((o) => [o.id, o.reference]));
        if (!refs.size) { await r.tick(); continue; }
        yield r.all<LineDb>(DAY_LINES_SQL, { ...base, d }).map((l) => ({ ...l, reference: refs.get(l.order_id) ?? '', business_date: d, category: categoryNames.get(l.category_id) ?? l.category_id }));
        await r.tick();
      }
    }
    await add<LineCsv>('order_lines.csv', [
      col('line_id', (l) => l.id),
      col('order_id', (l) => l.order_id),
      col('reference', (l) => l.reference),
      col('business_date', (l) => l.business_date),
      col('line_no', (l) => l.line_no),
      col('item_id', (l) => l.item_id),
      col('item_key', (l) => itemKeys.get(l.item_id) ?? ''),
      col('name_th', (l) => l.name_th),
      col('name_en', (l) => l.name_en),
      col('variant_th', (l) => l.variant_name_th),
      col('variant_en', (l) => l.variant_name_en),
      col('choices', (l) => modifierSummary(l.modifiers_json, 'en')),
      col('category', (l) => l.category),
      col('station', (l) => l.station),
      col('pricing_type', (l) => l.pricing_type),
      col('quantity', (l) => l.quantity),
      col('measured_grams', (l) => l.measured_grams),
      ...(fin ? [
        col<LineCsv>('unit_price_minor', (l) => l.unit_price_minor),
        col<LineCsv>('choices_minor', (l) => l.modifiers_minor),
        col<LineCsv>('line_total_minor', (l) => l.line_total_minor),
      ] : []),
      col('status', (l) => l.status),
      col('status_reason', (l) => l.status_reason),
      col('has_note', (l) => l.has_note === 1),
      col('allergy_flag', (l) => l.allergy_flag === 1),
      col('prepared_before_entry', (l) => l.prepared_before_entry === 1),
      col('submitted_at_utc', (l) => l.submitted_at),
      col('accepted_at_utc', (l) => l.accepted_at),
      col('preparing_at_utc', (l) => l.preparing_at),
      col('ready_at_utc', (l) => l.ready_at),
      col('served_at_utc', (l) => l.served_at),
      col('rejected_at_utc', (l) => l.rejected_at),
      col('cancelled_at_utc', (l) => l.cancelled_at),
    ], lineBatches());

    // ------------------------------------------------------------ summaries from the snapshot
    await add<DailyRow>('daily.csv', [
      col('date', (d) => d.date),
      col('weekday', (d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d.weekday]),
      col('state', (d) => d.state),
      col('submitted_rounds', (d) => d.submitted),
      col('accepted_rounds', (d) => d.accepted),
      col('rejected_rounds', (d) => d.rejected),
      col('cancelled_rounds', (d) => d.cancelled),
      col('ordering_visits', (d) => d.visits),
      col('ordering_devices', (d) => d.devices),
      col('visits_seated', (d) => d.seated),
      col('visits_with_covers', (d) => d.covered),
      col('recorded_diners', (d) => d.diners),
      col('items_net', (d) => d.items),
      col('items_submitted', (d) => d.submitted_items),
      col('measured_grams', (d) => d.grams),
      col('checkouts', (d) => d.closed),
      ...(fin ? [col<DailyRow>('accepted_value_minor', (d) => d.accepted_minor)] : []),
    ], [s.daily]);

    const periods = [...s.monthly.map((p) => ({ ...p, kind: 'month' })), ...s.weekly.map((p) => ({ ...p, kind: 'week' })),
      { ...s.overview, kind: 'year', key: String(job.year), label: String(job.year), from: s.range.from, to: s.range.to, state: s.year_state === 'completed' ? 'complete' : 'partial', clipped: false } as PeriodRow & { kind: string }];
    await add<PeriodRow & { kind: string }>('periods.csv', [
      col('period', (p) => p.kind),
      col('key', (p) => p.key),
      col('from', (p) => p.from),
      col('to', (p) => p.to),
      col('state', (p) => p.state),
      col('clipped_to_year', (p) => p.clipped),
      col('submitted_rounds', (p) => p.submitted),
      col('accepted_rounds', (p) => p.accepted),
      col('rejected_rounds', (p) => p.rejected),
      col('cancelled_rounds', (p) => p.cancelled),
      col('ordering_visits_distinct', (p) => p.visits),
      col('ordering_devices_distinct', (p) => p.devices),
      col('visits_seated', (p) => p.seated),
      col('visits_with_covers', (p) => p.covered),
      col('recorded_diners', (p) => p.diners),
      col('items_net', (p) => p.items),
      col('checkouts', (p) => p.closed),
    ], [periods]);

    await add<RankRow>('items_ranking.csv', [
      col('rank', (x) => x.rank),
      col('item_id', (x) => x.item_id),
      col('item_key', (x) => x.key),
      col('name_th', (x) => x.name.th),
      col('name_en', (x) => x.name.en),
      col('category_en', (x) => x.category.en),
      col('category_th', (x) => x.category.th),
      col('status_now', (x) => x.status),
      col('review_status_now', (x) => x.review_status),
      col('priced_by_weight', (x) => x.measured),
      col('net_servings', (x) => x.net_qty),
      col('submitted_qty', (x) => x.submitted_qty),
      col('rejected_qty', (x) => x.rejected_qty),
      col('cancelled_qty', (x) => x.cancelled_qty),
      col('orders', (x) => x.orders),
      col('visits', (x) => x.visits),
      col('measured_grams', (x) => x.grams),
      col('share_of_net', (x) => (x.share === null ? null : Number(x.share.toFixed(6)))),
      col('share_of_category', (x) => (x.category_share === null ? null : Number(x.category_share.toFixed(6)))),
      col('available_days', (x) => x.available_days),
      col('period_days', (x) => x.period_days),
      col('net_per_available_day', (x) => (x.per_available_day === null ? null : Number(x.per_available_day.toFixed(4)))),
      col('availability', (x) => x.availability),
      col('data_quality', (x) => x.quality),
      col('sold_out_now', (x) => x.sold_out_now),
      col('variants_net', (x) => x.variants.map((v) => `${v.name.en ?? v.name.th}: ${v.net_qty}`).join('; ')),
      col('first_ordered', (x) => x.first_ordered),
      col('last_ordered', (x) => x.last_ordered),
      col('ordered_as_other_names', (x) => x.former_names.join('; ')),
      ...(fin ? [col<RankRow>('accepted_value_minor', (x) => x.accepted_minor)] : []),
    ], [s.ranking.rows]);

    await add<PortionRow>('portion_requests.csv', [
      col('request_id', (p) => p.id),
      col('business_date', (p) => p.business_date),
      col('requested_at_utc', (p) => p.created_at),
      col('table_label', (p) => p.table_label),
      col('item', (p) => p.item),
      col('status', (p) => p.status),
      col('preferred_grams', (p) => p.preferred_grams),
      col('quote_revisions', (p) => p.quotes),
      col('final_grams', (p) => p.grams),
      ...(fin ? [col<PortionRow>('amount_minor', (p) => p.amount_minor)] : []),
      col('confirmed_via', (p) => p.confirmed_via),
      col('order_reference', (p) => p.order_reference),
      col('resolution_reason', (p) => p.resolution),
    ], [s.portions]);

    // ------------------------------------------------------------ service_requests.csv
    type ServiceCsv = { id: string; business_date: string; created_at: string; table_label: string; visit_id: string; type: string; status: string; acknowledged_at: string | null; completed_at: string | null; cancelled_at: string | null; close_reason: string | null; has_note: number };
    async function* serviceBatches(): AsyncGenerator<ServiceCsv[]> {
      for (const m of months(job.year)) {
        yield r.all<ServiceCsv>(
          `SELECT id, business_date, created_at, table_label, visit_id, type, status, acknowledged_at, completed_at, cancelled_at, close_reason,
                  ((note IS NOT NULL AND TRIM(note) <> '') OR note_removed_at IS NOT NULL) AS has_note
             FROM service_requests WHERE business_date BETWEEN :mf AND :mt AND (:fx = 1 OR is_fixture = 0) ORDER BY created_at`, { ...base, ...m });
        await r.tick();
      }
    }
    await add<ServiceCsv>('service_requests.csv', [
      col('request_id', (x) => x.id),
      col('business_date', (x) => x.business_date),
      col('created_at_utc', (x) => x.created_at),
      col('table_label', (x) => x.table_label),
      col('visit_id', (x) => x.visit_id),
      col('type', (x) => x.type),
      col('status', (x) => x.status),
      col('acknowledged_at_utc', (x) => x.acknowledged_at),
      col('completed_at_utc', (x) => x.completed_at),
      col('cancelled_at_utc', (x) => x.cancelled_at),
      col('seconds_to_acknowledge', (x) => secondsBetween(x.created_at, x.acknowledged_at)),
      col('seconds_to_complete', (x) => secondsBetween(x.created_at, x.completed_at)),
      col('close_reason', (x) => x.close_reason),
      col('has_note', (x) => x.has_note === 1),
    ], serviceBatches());

    // ------------------------------------------------------------ visits.csv
    type VisitCsv = { id: string; table_label: string; seated_at: string; seated_business_date: string; covers: number | null; status: string; closed_at: string | null; close_business_date: string | null; closed_by_exception: number; rounds: number; is_fixture: number };
    async function* visitBatches(): AsyncGenerator<VisitCsv[]> {
      for (const m of months(job.year)) {
        yield r.all<VisitCsv>(
          `SELECT v.id, COALESCE((SELECT o.table_label FROM orders o WHERE o.visit_id = v.id ORDER BY o.submitted_at LIMIT 1), t.label) AS table_label,
                  v.seated_at, v.seated_business_date, v.covers, v.status, v.closed_at, v.close_business_date,
                  (v.close_exception IS NOT NULL) AS closed_by_exception,
                  (SELECT COUNT(*) FROM orders o WHERE o.visit_id = v.id) AS rounds, v.is_fixture
             FROM visits v JOIN dining_tables t ON t.id = v.table_id
            WHERE (v.seated_business_date BETWEEN :mf AND :mt
                   OR (v.close_business_date BETWEEN :mf AND :mt AND v.seated_business_date < :from))
              AND (:fx = 1 OR v.is_fixture = 0)
            ORDER BY v.seated_at`, { ...base, ...m });
        await r.tick();
      }
    }
    await add<VisitCsv>('visits.csv', [
      col('visit_id', (v) => v.id),
      col('table_label', (v) => v.table_label),
      col('seated_at_utc', (v) => v.seated_at),
      col('seated_business_date', (v) => v.seated_business_date),
      col('covers_entered', (v) => v.covers),
      col('status', (v) => v.status),
      col('closed_at_utc', (v) => v.closed_at),
      col('closed_business_date', (v) => v.close_business_date),
      col('minutes_seated', (v) => (v.closed_at ? Math.round((secondsBetween(v.seated_at, v.closed_at) ?? 0) / 60) : null)),
      col('closed_by_exception', (v) => v.closed_by_exception === 1),
      col('order_rounds_all_time', (v) => v.rounds),
      col('is_fixture', (v) => v.is_fixture === 1),
    ], visitBatches());

    await add<CorrectionRow>('corrections.csv', [
      col('recorded_at_utc', (c) => c.at),
      col('kind', (c) => c.kind),
      col('reference', (c) => c.reference),
      col('table_label', (c) => c.table_label),
      col('item', (c) => c.item),
      col('from', (c) => c.from),
      col('to', (c) => c.to),
      col('reason', (c) => c.reason),
      col('by', (c) => c.actor),
      col('recorded_on_later_business_day', (c) => c.late),
    ], [s.corrections]);

    // ------------------------------------------------------------ engagement
    type EngDay = ReportSnapshot['engagement']['daily'][number];
    await add<EngDay>('engagement_daily.csv', [
      col('date', (d) => d.date),
      col('sessions', (d) => d.sessions),
      col('dining_sessions', (d) => d.dining_sessions),
      col('public_sessions', (d) => d.public_sessions),
      col('opted_out_sessions', (d) => d.opted_out),
      col('events', (d) => d.events),
      col('active_ms_all_routes', (d) => d.active_ms),
      col('active_ms_menu', (d) => d.menu_active_ms),
      col('item_impressions', (d) => d.impressions),
      col('item_detail_opens', (d) => d.detail_opens),
      col('cart_adds', (d) => d.adds),
    ], [s.engagement.daily]);

    if (job.raw_events) {
      type EventCsv = Record<string, string | number | null>;
      async function* eventBatches(): AsyncGenerator<EventCsv[]> {
        for (const d of dates) {
          let after = 0;
          for (;;) {
            const rows = r.all<EventCsv>(
              `SELECT rowid AS rid, event_id, session_id, type, business_date, received_at, route, item_id, category_id, active_ms, depth,
                      position, quantity_delta, quick_add, layout_version, menu_version, client_seq, client_elapsed_ms, visit_id
                 FROM analytics_events WHERE business_date = :d AND (:fx = 1 OR is_fixture = 0) AND rowid > :after
                ORDER BY rowid LIMIT 5000`, { ...base, d, after });
            if (!rows.length) break;
            after = Number(rows[rows.length - 1].rid);
            yield rows;
            await r.tick();
            if (rows.length < 5000) break;
          }
        }
      }
      await add<EventCsv>('engagement_events.csv', [
        col('event_id', (e) => e.event_id),
        col('session_ref', (e) => pseudo('analytics', e.session_id as string)),
        col('visit_id', (e) => e.visit_id),
        col('type', (e) => e.type),
        col('business_date', (e) => e.business_date),
        col('received_at_utc', (e) => e.received_at),
        col('route', (e) => e.route),
        col('item_id', (e) => e.item_id),
        col('category_id', (e) => e.category_id),
        col('active_ms', (e) => e.active_ms),
        col('scroll_depth', (e) => e.depth),
        col('position', (e) => e.position),
        col('quantity_delta', (e) => e.quantity_delta),
        col('quick_add', (e) => e.quick_add),
        col('layout_version', (e) => e.layout_version),
        col('menu_version', (e) => e.menu_version),
        col('client_seq', (e) => e.client_seq),
        col('client_elapsed_ms', (e) => e.client_elapsed_ms),
      ], eventBatches());
    }

    // ------------------------------------------------------------ money
    if (fin) {
      type PaymentCsv = Record<string, string | number | null>;
      const methodLabels = new Map<string, string>();
      for (const m of s.payments?.methods ?? []) methodLabels.set(m.method, m.label);
      async function* paymentBatches(): AsyncGenerator<PaymentCsv[]> {
        for (const m of months(job.year)) {
          // `reference` is deliberately not selected.
          yield r.all<PaymentCsv>(
            `SELECT p.id, p.business_date, p.confirmed_at, p.visit_id, p.bill_revision_id, p.kind, p.method, p.amount_minor, p.tendered_minor,
                    p.change_minor, p.status, p.reverses_payment_id, p.reason, su.display_name AS confirmed_by, p.is_fixture
               FROM payments p LEFT JOIN staff_users su ON su.id = p.confirmed_by
              WHERE p.business_date BETWEEN :mf AND :mt AND (:fx = 1 OR p.is_fixture = 0) ORDER BY p.confirmed_at`, { ...base, ...m });
          await r.tick();
        }
      }
      await add<PaymentCsv>('payments.csv', [
        col('payment_id', (p) => p.id),
        col('business_date', (p) => p.business_date),
        col('confirmed_at_utc', (p) => p.confirmed_at),
        col('visit_id', (p) => p.visit_id),
        col('bill_revision_id', (p) => p.bill_revision_id),
        col('kind', (p) => p.kind),
        col('method', (p) => p.method),
        col('method_label', (p) => methodLabels.get(String(p.method)) ?? p.method),
        col('amount_minor', (p) => p.amount_minor),
        col('tendered_minor', (p) => p.tendered_minor),
        col('change_minor', (p) => p.change_minor),
        col('status', (p) => p.status),
        col('reverses_payment_id', (p) => p.reverses_payment_id),
        col('reason', (p) => p.reason),
        col('confirmed_by', (p) => p.confirmed_by),
        col('is_fixture', (p) => p.is_fixture === 1),
      ], paymentBatches());

      await add<BillRow>('bills.csv', [
        col('bill_revision_id', (b) => b.id),
        col('business_date', (b) => b.business_date),
        col('finalized_at_utc', (b) => b.finalized_at),
        col('visit_id', (b) => b.visit_id),
        col('table_label', (b) => b.table_label),
        col('revision_no', (b) => b.revision_no),
        col('status', (b) => b.status),
        col('items_subtotal_minor', (b) => b.subtotal_minor),
        col('adjustments_minor', (b) => b.adjustments_minor),
        col('charges_added_minor', (b) => b.charges_minor),
        col('total_minor', (b) => b.total_minor),
        col('settled_minor', (b) => b.paid_minor),
        col('methods', (b) => b.methods),
        col('supersede_reason', (b) => b.note),
      ], [s.bills]);
    }

    // ------------------------------------------------------------ README.txt (last, so row counts are exact)
    const readme = readmeText(s, files);
    await zip.add('README.txt', [readme]);
    files.push({ name: 'README.txt', rows: 0, bytes: Buffer.byteLength(readme) });
    const { bytes } = await zip.close();
    return { files, bytes };
  } catch (err) {
    await zip.abort();
    throw err;
  }
}

const DESCRIPTIONS: Record<string, string> = {
  'orders.csv': 'One row per order round (business date = submission date).',
  'order_lines.csv': 'One row per order line with its status history timestamps. Guest notes are replaced by has_note.',
  'daily.csv': 'Every calendar day of the year with the report\'s daily counts (state: complete, partial, future, before_records).',
  'periods.csv': 'Months, Monday-Sunday weeks (clipped to the year) and the year, with distinct counts recomputed per period.',
  'items_ranking.csv': 'The full item ranking, including zero-order eligible items, with availability context.',
  'portion_requests.csv': 'Measured-weight portion requests with their final quoted or confirmed weight.',
  'service_requests.csv': 'Every table service request with response times.',
  'visits.csv': 'Visits seated in the year (plus visits seated earlier and closed in the year), with entered covers.',
  'corrections.csv': 'Cancellations, status corrections, recoveries and other after-the-fact changes.',
  'engagement_daily.csv': 'Engagement telemetry per business day.',
  'engagement_events.csv': 'Every retained raw engagement event (pseudonymous session references).',
  'payments.csv': 'Recorded payments, reversals and refund records. Payment references are never exported.',
  'bills.csv': 'Every bill revision finalized in the year, with settled amounts.',
};

/**
 * Guest ratings, always with the sample they come from (D-F-06). Ratings are
 * self-selected, so the count is printed beside the average every time and the
 * average is never printed alone. Comment text is not exported at all.
 */
function guestRatingLines(s: ReportSnapshot): string[] {
  const f = s.feedback;
  if (f.rated === 0) {
    return [
      `  Guests sent ${f.entries} feedback entr${f.entries === 1 ? 'y' : 'ies'} this year and no rating, so there is no average.`,
      '  Feedback is optional and one per phone: it measures the guests who chose to answer, nobody else.',
    ];
  }
  return [
    `  Average guest rating ${f.average_rating?.toFixed(2)} of 5, from ${f.rated} rating${f.rated === 1 ? '' : 's'}`,
    `  (${f.entries} feedback entr${f.entries === 1 ? 'y' : 'ies'} in total, ${f.with_comment} with a comment).`,
    `  Ratings 5 to 1: ${f.distribution.map((d) => `${d.rating}★ ${d.count}`).join(', ')}.`,
    '  Feedback is optional and one per phone: this is the guests who chose to answer, not every party served.',
    '  Comment text is never exported.',
  ];
}

function readmeText(s: ReportSnapshot, files: BundleResult['files']): string {
  const j = s.job;
  const lines = [
    `${s.restaurant.name_en} - annual data export ${j.year}`,
    '='.repeat(60),
    '',
    `Label:            ${j.label} (revision ${j.revision})${j.reason ? ` - reason: ${j.reason}` : ''}`,
    `Export id:        ${j.id}`,
    `Requested:        ${j.requested_at} by ${j.requested_by} (role scope: ${j.role_scope})`,
    `Generated (UTC):  ${s.generated_at}`,
    `Data cutoff (UTC): ${s.data_cutoff} (one consistent read snapshot: ${s.isolated_snapshot ? 'yes' : 'no'})`,
    `Data version:     ${s.data_version}`,
    '',
    'SCOPE',
    `  Business dates ${s.range.from} to ${s.range.to}, time zone Asia/Bangkok (UTC+07:00),`,
    `  business day starting ${String(s.range.cutoff_hour).padStart(2, '0')}:00. UTC interval [${s.range.start_utc}, ${s.range.end_utc}).`,
    '  All *_utc columns are UTC ISO-8601. business_date columns are Bangkok business dates.',
    `  Demo/fixture data: ${j.include_fixture ? 'INCLUDED (is_fixture columns mark it)' : 'excluded'}.`,
    `  Money: ${j.financial ? 'included, as integer satang (1 THB = 100 satang)' : 'excluded (the requesting role lacks reports.financial): no price, bill or payment values'}.`,
    `  Raw engagement events: ${j.raw_events ? 'included' : 'excluded (the requesting role lacks reports.export_raw); daily engagement totals are included'}.`,
    '',
    'ATTRIBUTION',
    '  Order rounds and lines count on the submission business date; visits/covers on the seated date;',
    '  checkouts on the closed date; payments on the confirmation date; bills on the finalization date.',
    '',
    'GUEST RATINGS',
    ...guestRatingLines(s),
    '',
    'FILES',
    ...files.map((f) => `  ${f.name.padEnd(24)} ${String(f.rows).padStart(8)} rows  ${DESCRIPTIONS[f.name] ?? ''}`),
    '  README.txt               this file',
    '',
    'NEVER INCLUDED, AND WHY',
    '  - Guest note text (private free text): replaced by has_note and allergy_flag.',
    '  - Table QR tokens, visit PINs, session tokens, passwords: secrets, never read by the export.',
    '  - Payment references: not needed for reporting.',
    '  - Guest and analytics session ids: replaced by per-export pseudonymous references',
    '    (device_ref, analytics_session_ref, session_ref) that cannot be joined to other exports.',
    ...(j.financial ? [] : ['  - Prices, line totals, bills and payments: outside the requesting role\'s permissions.']),
    ...(j.raw_events ? [] : ['  - engagement_events.csv: outside the requesting role\'s permissions.']),
    '',
    'FORMAT',
    '  UTF-8 with byte-order mark, comma separated, CRLF line endings, RFC 4180 quoting.',
    '  Text cells that start with = + - @ tab or carriage return are prefixed with an apostrophe',
    '  so spreadsheet software never evaluates them as formulas.',
    '',
    'NOTES',
    ...s.notes.map((n) => `  - ${n}`),
    '',
  ];
  return lines.join('\r\n');
}
