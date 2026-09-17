// Sections 05-08: engagement, service operations, cancellations and
// exceptions, bills and payments (financial reports only).
import type { EngagementItem, ReasonRow, ReportSnapshot } from '../export/types.ts';
import { businessDate } from '../../../shared/time.ts';
import { funnel } from './charts.ts';
import { dateLong, dateTime, duration, esc, grams, LINE_STATUS_LABEL, money, monthName, num, oneName, pct, SERVICE_LABEL, statCells } from './format.ts';
import { h3, kpi, rowsChunked, sectionHead, type Col, table, thead, tr } from './parts.ts';

/** Month state from the order calendar: future and pre-records months carry no counts. */
function monthState(s: ReportSnapshot, key: string): string {
  return s.monthly.find((m) => m.key === key)?.state ?? 'complete';
}
const MONTH_TAG: Record<string, string> = { partial: 'in progress', future: 'future', before_records: 'before records' };
const monthLabel = (s: ReportSnapshot, key: string): string => {
  const tag = MONTH_TAG[monthState(s, key)];
  return `${monthName(key)}${tag ? ` <span class="state">${tag}</span>` : ''}`;
};
const noCounts = (s: ReportSnapshot, key: string): boolean => ['future', 'before_records'].includes(monthState(s, key));

export async function engagementSection(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  const e = s.engagement;
  // The measurement start is a UTC instant; the header shows its Bangkok business date.
  const measuredSince = e.instrumentation_started_at ? businessDate(e.instrumentation_started_at, s.range.cutoff_hour) : null;
  const scrollBase = e.scroll_sessions ?? e.sessions;
  const loc = s.default_locale;
  const f = e.funnel;
  const none = e.raw_events === 0 && e.agg_fallback_days === 0;
  const itemCols: Col<EngagementItem>[] = [
    { head: 'Item', cell: (i) => oneName(i.name, loc) },
    { head: 'Impressions', num: true, cell: (i) => num(i.impressions) },
    { head: 'Sessions seeing it', num: true, cell: (i) => num(i.impression_sessions) },
    { head: 'Detail opens', num: true, cell: (i) => num(i.detail_opens) },
    { head: 'Adds', num: true, cell: (i) => num(i.adds) },
    { head: 'Sessions adding', num: true, cell: (i) => num(i.add_sessions) },
    { head: 'Add rate', num: true, cell: (i) => pct(i.add_rate) },
    { head: 'Attributed quantity', num: true, cell: (i) => num(i.attributed_qty) },
  ];
  const itemsBody = await rowsChunked(e.items, (i) => tr(itemCols, i), tick);
  return `<section class="section">
  ${sectionHead('05', 'Guest engagement', 'การใช้งานเมนูของลูกค้า', measuredSince ? `Measured since<br>${dateLong(measuredSince)}` : 'Measurement start not recorded')}
  <p class="lead">Measured from the guest menu's own telemetry: pseudonymous browsing sessions, never people, never cross-visit identities.
    Active time counts only while the page is visible and the guest has interacted recently; it is observed activity, not attention.
    Order counts elsewhere in this report never depend on this telemetry.</p>
  ${none ? '<div class="note"><strong>No telemetry</strong>No engagement events were recorded for this year. The figures below are empty by design, not zero interest.</div>' : ''}
  <div class="kpis">
    ${kpi('Measured sessions', 'เซสชันที่วัดได้', num(e.sessions), `Sessions with a stored event: ${num(e.dining_sessions)} at a table · ${num(e.public_sessions)} public browsing`)}
    ${kpi('Ordering visits measured', 'โต๊ะที่มีข้อมูลการใช้งาน', `${num(e.measured_visits)}<small>of ${num(e.ordering_visits)}</small>`, `Coverage ${pct(e.ordering_visits ? e.measured_visits / e.ordering_visits : null, 0)}; the rest had no telemetry`)}
    ${kpi('Active menu time', 'เวลาใช้งานหน้าเมนู', duration(e.menu_active_ms.median === null ? null : e.menu_active_ms.median / 1000), `Median per session · p90 ${duration(e.menu_active_ms.p90 === null ? null : e.menu_active_ms.p90 / 1000)} · n = ${num(e.menu_active_ms.sample)}`)}
    ${kpi('Active dish-detail time', 'เวลาดูรายละเอียดเมนู', duration(e.detail_active_ms.median === null ? null : e.detail_active_ms.median / 1000), `Median per session and dish · p90 ${duration(e.detail_active_ms.p90 === null ? null : e.detail_active_ms.p90 / 1000)} · n = ${num(e.detail_active_ms.sample)}`)}
  </div>

  <div class="two">
    <div class="block">${h3('Session funnel', 'ขั้นตอนการสั่ง')}
      ${funnel([
        { label: 'Measured dining sessions', value: f.sessions },
        { label: 'Saw at least one dish', value: f.impression_sessions },
        { label: 'Opened a dish', value: f.detail_sessions },
        { label: 'Added to their order', value: f.add_sessions },
        { label: 'Submitted an order', value: f.submit_sessions },
      ])}
      <p class="caption">Dining sessions only: a public browser cannot order. ${num(f.quick_add_sessions)} sessions used quick-add, which skips the dish page,
        so "opened a dish" is not a required step. Rounds: ${num(f.attributed_orders)} linked to a measured session; ${num(f.unattributed_orders)} not linked
        (including ${num(f.staff_orders)} staff-assisted, recovered or portion rounds). Missing telemetry never reduces order counts.</p>
    </div>
    <div class="block">${h3('Category exposure', 'หมวดที่ลูกค้าเห็น')}
      ${table<(typeof e.categories)[number]>([
        { head: 'Category', cell: (c) => oneName(c.name, 'en') },
        { head: 'Sessions', num: true, cell: (c) => num(c.sessions) },
        { head: 'Share', num: true, cell: (c) => pct(c.share) },
      ], e.categories, { cls: 'compact', empty: 'No category views recorded.' })}
      ${h3('Scroll depth', 'ระยะการเลื่อน')}
      ${table<(typeof e.scroll)[number]>([
        { head: 'Reached at least', cell: (x) => `${x.threshold}% of the menu` },
        { head: 'Sessions', num: true, cell: (x) => num(x.sessions) },
        { head: 'Share', num: true, cell: (x) => pct(scrollBase ? x.sessions / scrollBase : null) },
      ], e.scroll, { cls: 'compact' })}
      <p class="caption">Share of the ${num(scrollBase)} measured sessions that opened the menu (dining and public); only scrolling on the menu page counts.
        Depth depends on screen size, images and filters, so it is approximate. Reaching 100% does not mean every dish was read.</p>
    </div>
  </div>

  ${h3('Item exposure and adds', 'การเห็นและการเพิ่มแต่ละเมนู')}
  ${e.items.length ? `<table class="dense">${thead(itemCols)}<tbody>${itemsBody}</tbody></table>` : '<p class="muted">No item-level events recorded.</p>'}
  <p class="caption">Add rate = sessions that saw the dish and added it / sessions that saw it (an impression is the dish at least half visible for a second;
    it is counted once per session, while every tap on Add counts as an add). Attributed quantity counts every line of
    rounds linked to a measured, not-opted-out session. A session that continues past the business-day cutoff counts once per business day in the session columns.
    ${e.agg_fallback_days ? `${num(e.agg_fallback_days)} day(s) use daily aggregates, which carry counts but not session detail.` : ''}</p>

  <div class="two">
    <div class="block">${h3('By month', 'รายเดือน')}
      ${table<(typeof e.monthly)[number]>([
        { head: 'Month', cell: (m) => monthLabel(s, m.key) },
        { head: 'Sessions', num: true, cell: (m) => (noCounts(s, m.key) ? '–' : num(m.sessions)) },
        { head: 'At a table', num: true, cell: (m) => (noCounts(s, m.key) ? '–' : num(m.dining_sessions)) },
        { head: 'Active time', num: true, cell: (m) => (noCounts(s, m.key) ? '–' : duration(m.active_ms / 1000)) },
        { head: 'Events', num: true, cell: (m) => (noCounts(s, m.key) ? '–' : num(m.events)) },
      ], e.monthly, { cls: 'compact' })}
    </div>
    <div class="block">${h3('Scope and limitations', 'ขอบเขตและข้อจำกัด')}
      <div class="scope"><strong>Raw events are not reproduced here.</strong> This year holds ${num(e.raw_events)} raw engagement events
        ${e.raw_first_date ? `from ${dateLong(e.raw_first_date)}` : ''}. This PDF prints the per-month and per-item summaries above; per-day totals are in
        <b>engagement_daily.csv</b> and every raw event row is in <b>engagement_events.csv</b> in the annual data export (owner permission to export raw data required).</div>
      <ul class="plain small">
        <li>Telemetry first observed: ${e.first_event_at ? dateTime(e.first_event_at) : 'never'}; measurement switched on: ${e.instrumentation_started_at ? dateTime(e.instrumentation_started_at) : 'not recorded'}; analytics is currently ${e.enabled_now ? 'on' : 'off'}.</li>
        <li>Raw events older than ${num(e.raw_retention_days)} days are removed by the daily retention task (only once the daily item totals for those dates are built);
          ${e.agg_fallback_days ? `${num(e.agg_fallback_days)} day(s) of this year are covered by those daily totals only.` : 'every day of this year still has its raw events.'}</li>
        <li>${num(e.opted_out_sessions)} sessions opted out and are excluded from rates.</li>
        <li>Closing a browser or losing signal can drop the last active interval, so active time is a floor, not an exact figure.</li>
        <li>Long dwell is not "interest" and an unsubmitted cart is not "abandonment"; the report describes behaviour only.</li>
      </ul>
      ${e.event_types.length ? table<(typeof e.event_types)[number]>([
        { head: 'Event type', cell: (t) => `<code>${esc(t.type)}</code>` },
        { head: 'Events', num: true, cell: (t) => num(t.count) },
      ], e.event_types, { cls: 'compact' }) : ''}
    </div>
  </div>
</section>`;
}

export function operationsSection(s: ReportSnapshot): string {
  const t = s.timings;
  type TRow = { label: string; stat: (typeof t)['accept_s']; unit: 'seconds' | 'minutes' };
  const rows: TRow[] = [
    { label: 'Submitted to first acceptance (per round)', stat: t.accept_s, unit: 'seconds' },
    { label: 'Accepted to preparing (per line)', stat: t.accept_to_prepare_s, unit: 'seconds' },
  ];
  for (const st of t.stations) {
    const name = st.station === 'bar' ? 'Bar' : 'Kitchen';
    rows.push({ label: `${name}: preparing to ready`, stat: st.prepare_s, unit: 'seconds' });
    rows.push({ label: `${name}: ready to served`, stat: st.serve_s, unit: 'seconds' });
    rows.push({ label: `${name}: submitted to served`, stat: st.total_s, unit: 'seconds' });
  }
  rows.push({ label: 'Completed visits: seated to checkout', stat: t.visit_minutes, unit: 'minutes' });
  const p = t.portions;
  return `<section class="section">
  ${sectionHead('06', 'Service operations', 'การให้บริการ', 'Recorded intervals only')}
  <p class="lead">Intervals use the times staff recorded as each line moved forward. Lines skipped past a step, recovered paper orders
    (${num(t.excluded_recovered_rounds)} rounds) and lines prepared before entry (${num(t.excluded_prepared_before_entry)}) are left out of the step they lack.
    A visit's seated-to-checkout duration is how long the table was occupied; it is not screen time.</p>
  ${h3('Timings', 'ระยะเวลา')}
  <table><thead><tr><th>Interval</th><th class="n">Median</th><th class="n">p90</th><th class="n">Sample</th></tr></thead>
  <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td>${statCells(r.stat, r.unit)}</tr>`).join('')}</tbody></table>
  <p class="caption">p90: nine in ten intervals were this long or shorter. ${num(t.visits_closed)} visits were checked out in ${s.job.year}.</p>

  ${h3('Table service requests', 'คำขอจากโต๊ะ')}
      <table class="compact fixed words"><colgroup><col><col style="width:18mm"><col style="width:18mm"><col style="width:18mm"><col style="width:18mm"><col style="width:24mm"><col style="width:24mm"></colgroup>
      <thead><tr><th>Request</th><th class="n">Count</th><th class="n">Completed</th><th class="n">Cancelled</th><th class="n">Still open</th><th class="n">Ack. median</th><th class="n">Ack. p90</th></tr></thead>
      <tbody>${t.service.length ? t.service.map((r) => `<tr><td>${esc(SERVICE_LABEL[r.type] ?? r.type)}</td><td class="n">${num(r.count)}</td><td class="n">${num(r.completed)}</td><td class="n">${num(r.cancelled)}</td><td class="n">${num(r.open)}</td><td class="n">${duration(r.ack_s.median)}</td><td class="n">${duration(r.ack_s.p90)}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No service requests recorded.</td></tr>'}</tbody></table>
      <p class="caption">Acknowledgement time runs from the guest's request to the first staff acknowledgement. Every request row is in service_requests.csv.</p>
  <div class="two">
    <div class="block">${h3('Priced-by-weight portions', 'การชั่งน้ำหนักเนื้อ')}
      ${table<{ label: string; value: string }>([
        { head: 'Stage', cell: (r) => esc(r.label) },
        { head: 'Requests', num: true, cell: (r) => r.value },
      ], [
        { label: 'Requested by a guest or staff', value: num(p.requests) },
        { label: 'Weighed and quoted', value: num(p.quoted) },
        { label: 'Confirmed (became an order line)', value: num(p.confirmed) },
        { label: '  of which confirmed in person', value: num(p.confirmed_in_person) },
        { label: 'Declined by the guest', value: num(p.declined) },
        { label: 'Quote expired', value: num(p.expired) },
        { label: 'Cancelled', value: num(p.cancelled) },
        { label: 'Still open at the cutoff', value: num(p.open) },
        { label: 'Confirmed weight', value: grams(p.grams_confirmed) },
      ], { cls: 'compact' })}
      <p class="caption">Only confirmed quotes count as orders; requests and quotes never inflate popularity or totals. Each request is listed in Appendix C.</p>
    </div>
  </div>
</section>`;
}

export function exceptionsSection(s: ReportSnapshot): string {
  const x = s.exceptions;
  const fin = Boolean(s.payments);
  const cols: Col<ReasonRow>[] = [
    { head: 'Outcome', cell: (r) => `<span class="tag ${r.kind === 'rejected' ? 'warn' : 'dim'}">${r.kind === 'rejected' ? 'Rejected' : 'Cancelled'}</span>` },
    { head: 'Reason recorded by staff', cell: (r) => esc(r.reason) },
    { head: 'Lines', num: true, cell: (r) => num(r.lines) },
    { head: 'Quantity', num: true, cell: (r) => num(r.qty) },
    ...(fin ? [{ head: 'Line value', num: true, cell: (r: ReasonRow) => money(r.value_minor) }] : []),
  ];
  const p = s.payments;
  return `<section class="section">
  ${sectionHead('07', 'Cancellations & exceptions', 'การยกเลิกและข้อยกเว้น', `${num(x.reasons.reduce((a, r) => a + r.lines, 0))} lines`)}
  <p class="lead">Rejections happen before the kitchen accepts a round; cancellations happen after. Reasons are the codes and short notes staff chose;
    a rejection is an operational decision (for example sold out), not necessarily a system fault.</p>
  ${h3('By reason', 'ตามเหตุผล')}
  ${table(cols, x.reasons, { empty: 'No lines were rejected or cancelled.' })}
  <div class="two">
    <div class="block">${h3('When lines were cancelled', 'ขั้นตอนที่ยกเลิก')}
      ${table<(typeof x.cancel_stages)[number]>([
        { head: 'Cancelled from', cell: (r) => esc(LINE_STATUS_LABEL[r.from] ?? r.from) },
        { head: 'Lines', num: true, cell: (r) => num(r.lines) },
        { head: 'Quantity', num: true, cell: (r) => num(r.qty) },
      ], x.cancel_stages, { cls: 'compact', empty: 'No cancellations recorded in line history.' })}
    </div>
    <div class="block">${h3('Corrections', 'การแก้ไข')}
      ${table<{ label: string; value: number }>([
        { head: 'Kind', cell: (r) => esc(r.label) },
        { head: 'Count', num: true, cell: (r) => num(r.value) },
      ], [
        { label: 'Status corrections (moved back a step)', value: x.corrections },
        { label: 'Recovered paper orders', value: x.recoveries },
        { label: 'Changes recorded on a later business day', value: x.late_changes },
      ], { cls: 'compact' })}
      <p class="caption">Later-day changes can alter a period that was already reported; they are why revised reports exist. Each one is listed in Appendix B.</p>
    </div>
  </div>
  ${h3('Payment exceptions', 'ข้อยกเว้นการชำระเงิน')}
  ${p ? table<(typeof p.exceptions)[number]>([
    { head: 'When', cell: (r) => `<span class="nowrap">${dateTime(r.at)}</span>`, width: '30mm' },
    { head: 'Kind', cell: (r) => esc({ finalized_unpaid: 'Not settled', amount_mismatch: 'Amount differs', reversed: 'Payment reversed (context)', close_exception: 'Closed by exception (context)', refund_record: 'Refund recorded (context)' }[r.kind]), width: '32mm' },
    { head: 'Table', cell: (r) => esc(r.table_label), width: '16mm' },
    { head: 'Amount', num: true, cell: (r) => (r.amount_minor ? money(r.amount_minor) : '–'), width: '18mm' },
    { head: 'Detail', cell: (r) => esc(r.detail) },
  ], p.exceptions, { cls: 'compact', empty: 'No payment exceptions: every finalized bill has a matching confirmed settlement.' })
    + `<p class="caption"><b>${num(p.exception_count)} payment exception${p.exception_count === 1 ? '' : 's'}, ${money(p.exception_minor)}</b>: current bill revisions with no confirmed
      settlement once the visit closed or the finalize date passed (valued at the bill total), and settlements that differ from the total (valued at the
      difference), the same rule as the KPI screen. Rows marked "context" are shown for completeness and not counted. This compares recorded payments with bills;
      it is not a bank reconciliation.</p>`
    : '<div class="scope"><strong>Not included.</strong> Payment exceptions are shown only in reports requested by a role with the reports.financial permission.</div>'}
</section>`;
}

export function paymentsSection(s: ReportSnapshot): string {
  const p = s.payments;
  if (!p) return '';
  const blank = (key: string) => noCounts(s, key);
  return `<section class="section">
  ${sectionHead('08', 'Bills & payments', 'บิลและการชำระเงิน', 'Owner scope')}
  <div class="kpis money">
    ${kpi('Finalized bill value', 'ยอดบิลที่สรุปแล้ว', money(p.finalized_minor), `${num(p.finalized_bills)} current revisions, dated by finalization`)}
    ${kpi('Settlements recorded', 'การชำระที่บันทึก', money(p.settled_minor), `${num(p.settlements)} settlements, dated by confirmation`)}
    ${kpi('Reversals and refunds', 'การกลับรายการ/คืนเงิน', money(p.reversal_minor + p.refund_minor), `${num(p.reversals)} reversals · ${num(p.refunds)} refunds after checkout, each in its payment's month`)}
    ${kpi('Adjustments', 'ส่วนลด/ปรับยอด', money(p.adjustments.minor), `${num(p.adjustments.count)} adjustments, ${num(p.adjustments.voided)} voided`)}
  </div>
  <div class="two">
    <div class="block">${h3('By payment method', 'ตามวิธีชำระ')}
      ${table<(typeof p.methods)[number]>([
        { head: 'Method', cell: (m) => esc(m.label) },
        { head: 'Count', num: true, cell: (m) => num(m.count), width: '11mm' },
        { head: 'Amount', num: true, cell: (m) => money(m.amount_minor), width: '22mm' },
        { head: 'Reversed', num: true, cell: (m) => (m.reversed_count ? `${money(m.reversed_minor)} (${num(m.reversed_count)})` : '–'), width: '20mm' },
      ], p.methods, { cls: 'compact', empty: 'No payments recorded.' })}
      <p class="caption">Staff-confirmed offline payments. Payment references are never printed.</p>
    </div>
    <div class="block">${h3('By month', 'รายเดือน')}
      ${table<(typeof p.monthly)[number]>([
        { head: 'Month', cell: (m) => monthLabel(s, m.key) },
        { head: 'Finalized', num: true, cell: (m) => (blank(m.key) ? '–' : money(m.finalized_minor)) },
        { head: 'Paid, net', num: true, cell: (m) => (blank(m.key) ? '–' : money(m.paid_minor)) },
      ], p.monthly, { cls: 'compact' })}
    </div>
  </div>
  <p class="caption">Open bills at the data cutoff: ${num(p.open_bills_at_cutoff)}. Accepted item value (${money(p.accepted_minor)}) and finalized bill value differ by
    charges, adjustments, and by timing: rounds count on their submission date, bills on their finalization date.
    ${s.settings.charges_confirmed ? '' : 'Charge settings are not yet confirmed by the owner.'}</p>
</section>`;
}
