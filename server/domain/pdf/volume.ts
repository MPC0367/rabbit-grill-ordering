// Sections 01-03: year overview, orders over time, and the full daily record.
import type { DailyRow, PeriodRow, ReportSnapshot } from '../export/types.ts';
import { barChart, C, calendarHeatmap, legend, stackedBar } from './charts.ts';
import { dateLong, dateShort, esc, grams, money, monthName, monthShort, num, pct, WEEKDAYS } from './format.ts';
import { h3, kpi, rowsChunked, sectionHead, type Col, table, tableClass, thead, tr } from './parts.ts';

const coverage = (covered: number, seated: number) => (seated ? `${num(covered)} of ${num(seated)} seated visits had covers entered (${pct(covered / seated, 0)})` : 'No visits seated');

const PERIOD_STATE: Record<PeriodRow['state'], string> = { complete: '', partial: 'in progress', future: 'future', before_records: 'before records' };

/** A count for a period or day, or a dash when the period has no records by definition. */
const pv = (p: { state: string }, v: number) => (p.state === 'future' || p.state === 'before_records' ? '–' : num(v));

export function overviewSection(s: ReportSnapshot): string {
  const o = s.overview;
  const pending = Math.max(0, o.submitted - o.accepted - o.rejected - o.cancelled);
  const p = s.payments;
  const sources = [
    { label: 'Guest QR', value: o.guest_rounds },
    { label: 'Staff-assisted', value: o.staff_rounds },
    { label: 'Measured-weight confirmations', value: o.portion_rounds },
    { label: 'Recovered paper orders', value: o.recovered_rounds },
  ];
  return `<section class="section">
  ${sectionHead('01', 'Year overview', 'ภาพรวมทั้งปี', `${dateLong(s.range.from)} –<br>${dateLong(s.range.to)}`)}
  <div class="kpis">
    ${kpi('Submitted order rounds', 'รอบสั่งอาหารที่ส่งแล้ว', num(o.submitted), 'Every round created, including later rejected or cancelled ones')}
    ${kpi('Accepted order rounds', 'รอบที่รับออร์เดอร์แล้ว', num(o.accepted), `${pct(o.submitted ? o.accepted / o.submitted : null)} of submitted rounds`)}
    ${kpi('Ordering visits', 'โต๊ะที่มีการสั่งอาหาร', num(o.visits), 'Distinct dining visits with a submitted round; repeat rounds do not add visits')}
    ${kpi('Recorded diners', 'จำนวนลูกค้าที่บันทึกไว้', num(o.diners), coverage(o.covered, o.seated))}
    ${kpi('Items ordered (net)', 'จำนวนรายการสุทธิ', num(o.items), `Accepted, not cancelled. ${num(o.submitted_items)} submitted in total`)}
    ${kpi('Measured-weight servings', 'จานที่คิดตามน้ำหนัก', num(o.measured_servings), o.grams ? `${grams(o.grams)} confirmed in total` : 'No confirmed portions')}
    ${kpi('Ordering devices', 'อุปกรณ์ที่สั่งอาหาร', num(o.devices), 'Distinct guest browser sessions. An approximation of devices, never of people')}
    ${kpi('Visits checked out', 'โต๊ะที่เช็กเอาต์แล้ว', num(o.closed), `Counted on the checkout date. ${num(o.seated)} visits were seated this year`)}
    ${kpi('Trading days with orders', 'วันที่มีออร์เดอร์', num(o.active_days), `of ${num(o.elapsed_days)} elapsed days${o.records_begin && o.records_begin > s.range.from ? `; first operating day ${dateShort(o.records_begin)}` : ''}`)}
    ${kpi('Busiest day', 'วันที่มีออร์เดอร์มากที่สุด', o.busiest_day ? `${num(o.busiest_day.submitted)}<small>rounds</small>` : '–', o.busiest_day ? dateLong(o.busiest_day.date) : 'No orders yet')}
    ${kpi('Service requests', 'คำขอบริการ', num(o.service_requests), 'Call staff, bill and other table requests')}
    ${kpi('Portion requests', 'คำขอชั่งน้ำหนัก', num(o.portion_requests), `${num(s.timings.portions.confirmed)} confirmed by the guest or in person`)}
  </div>

  ${h3('What happened to submitted rounds', 'ผลลัพธ์ของรอบสั่งอาหาร')}
  <div class="figure">${stackedBar([
    { label: 'Accepted', value: o.accepted, color: C.forest2 },
    { label: 'Rejected', value: o.rejected, color: C.ember },
    { label: 'Cancelled', value: o.cancelled, color: C.taupe },
    { label: 'Awaiting acceptance', value: pending, color: C.steel },
  ], 680)}</div>
  <p class="caption">A round is accepted when at least one of its lines was accepted and not later cancelled. Rejected: every line rejected.
    Cancelled: no line remains active. ${num(o.rejected_items)} items were rejected and ${num(o.cancelled_items)} cancelled across all rounds.</p>

  <div class="two">
    <div class="block">
      ${h3('How rounds were placed', 'ช่องทางการสั่ง')}
      ${table<{ label: string; value: number }>([
        { head: 'Source', cell: (r) => esc(r.label) },
        { head: 'Rounds', num: true, cell: (r) => num(r.value), width: '18mm' },
        { head: 'Share', num: true, cell: (r) => pct(o.submitted ? r.value / o.submitted : null), width: '16mm' },
      ], sources, { cls: 'compact' })}
      <p class="caption">Staff-assisted and recovered rounds are real orders; they are simply not guest self-service.</p>
    </div>
    <div class="block">
      ${h3('Order lines', 'รายการอาหาร')}
      ${table<{ label: string; value: string }>([
        { head: 'Measure', cell: (r) => esc(r.label) },
        { head: 'Value', num: true, cell: (r) => r.value, width: '26mm' },
      ], [
        { label: 'Order lines recorded', value: num(o.lines) },
        { label: 'Lines with a guest note (never printed)', value: num(o.lines_with_note) },
        { label: 'Lines flagged as allergy-related', value: num(o.lines_with_allergy_flag) },
        { label: 'Visits open at the data cutoff', value: num(o.open_visits_at_cutoff) },
        { label: 'First operating day (first seated visit)', value: o.records_begin ? dateLong(o.records_begin) : '–' },
      ], { cls: 'compact' })}
    </div>
  </div>
  ${p ? `${h3('Money, labelled precisely', 'ยอดเงิน (ระบุความหมายชัดเจน)')}
  <div class="kpis money">
    ${kpi('Submitted item value', 'มูลค่ารายการที่ส่ง', money(p.submitted_minor), 'Sum of round subtotals as submitted')}
    ${kpi('Accepted item value', 'มูลค่ารายการที่รับแล้ว', money(p.accepted_minor), 'Accepted, not cancelled lines; before charges and adjustments')}
    ${kpi('Finalized bill value', 'ยอดบิลที่สรุปแล้ว', money(p.finalized_minor), `${num(p.finalized_bills)} current bill revisions, incl. charges and adjustments`)}
    ${kpi('Recorded payments, net', 'ยอดชำระที่บันทึก (สุทธิ)', money(p.net_paid_minor), `${num(p.settlements)} settlements less reversals and refunds`)}
  </div>
  <p class="caption">None of these is "revenue": no tax treatment is applied, and V1 compares recorded payments only; it is not a bank reconciliation.</p>` : ''}
</section>`;
}

export function timeSection(s: ReportSnapshot): string {
  const bars = s.monthly.map((m) => ({ label: monthShort(m.key), value: m.submitted, inner: m.accepted, state: m.state }));
  const weekBars = s.weekly.map((w) => ({ label: dateShort(w.from), value: w.submitted, state: w.state, muted: w.clipped }));
  const clipped = s.weekly.filter((w) => w.clipped);
  const hourBars = s.timings.hourly.map((v, h) => ({ label: String(h).padStart(2, '0'), value: v }));
  const dayBars = s.timings.weekday.map((v, d) => ({ label: WEEKDAYS[d], value: v }));
  const cols: Col<PeriodRow>[] = [
    { head: 'Month', cell: (m) => `${esc(m.label)}${PERIOD_STATE[m.state] ? ` <span class="state">${PERIOD_STATE[m.state]}</span>` : ''}`, width: '36mm' },
    { head: 'Submitted', num: true, cell: (m) => pv(m, m.submitted) },
    { head: 'Accepted', num: true, cell: (m) => pv(m, m.accepted) },
    { head: 'Rejected', num: true, cell: (m) => pv(m, m.rejected) },
    { head: 'Cancelled', num: true, cell: (m) => pv(m, m.cancelled) },
    { head: 'Ordering visits', num: true, cell: (m) => pv(m, m.visits) },
    { head: 'Seated / with covers', num: true, cell: (m) => (m.state === 'future' || m.state === 'before_records' ? '–' : `${num(m.seated)} / ${num(m.covered)}`) },
    { head: 'Recorded diners', num: true, cell: (m) => pv(m, m.diners) },
    { head: 'Items (net)', num: true, cell: (m) => pv(m, m.items) },
  ];
  const y = s.overview;
  const total = `<tr class="total"><td>Year</td>${[y.submitted, y.accepted, y.rejected, y.cancelled, y.visits].map((v) => `<td class="n">${num(v)}</td>`).join('')}`
    + `<td class="n">${num(y.seated)} / ${num(y.covered)}</td><td class="n">${num(y.diners)}</td><td class="n">${num(y.items)}</td></tr>`;
  return `<section class="section">
  ${sectionHead('02', 'Orders over time', 'จำนวนออร์เดอร์ตามช่วงเวลา', 'Asia/Bangkok business dates')}
  ${h3('Monthly order rounds', 'รายเดือน')}
  <div class="figure">${barChart({ bars, width: 680, height: 165, showValues: true, title: 'Monthly submitted and accepted order rounds' })}
  ${legend([
    { label: 'Submitted rounds', color: C.forest2 }, { label: 'Accepted rounds (inner bar)', color: C.forest },
    { label: 'In progress (outlined)', color: C.paper, outline: C.ember }, { label: 'Future', color: C.steel, dashed: true },
    { label: 'Before records', color: '#B9AE96', dashed: true },
  ])}</div>
  ${table(cols, s.monthly, { cls: 'compact', foot: total })}
  <p class="caption">Ordering visits are distinct counts recomputed for each month and for the year, so months do not add up to the year total.
    Recorded diners count covers entered for visits seated in the month.</p>

  <div class="block">
  ${h3('Weekly order rounds', 'รายสัปดาห์ (จันทร์–อาทิตย์)')}
  <div class="figure">${barChart({ bars: weekBars, width: 680, height: 125, labelEvery: 4, title: 'Weekly submitted order rounds' })}
  ${legend([{ label: 'Monday–Sunday week', color: C.forest2 }, { label: 'Week crossing New Year: only in-year days counted', color: C.forestSoft }, { label: 'Future', color: C.steel, dashed: true }, { label: 'Before records', color: '#B9AE96', dashed: true }])}</div>
  <p class="caption">${clipped.length ? clipped.map((w) => `The week ${dateLong(w.window_from!)} – ${dateLong(w.window_to!)} crosses the year boundary; this report counts only ${dateShort(w.from)} – ${dateShort(w.to)}.`).join(' ') : 'No week crosses the year boundary.'}</p>
  </div>

  <div class="block">
  ${h3('Every day of the year', 'ทุกวันในปี')}
  <div class="figure">${calendarHeatmap(s.daily, (d) => d.submitted, 680)}</div>
  </div>

  <div class="two block">
    <div>${h3('By hour of day', 'ตามชั่วโมง')}
      <div class="figure">${barChart({ bars: hourBars, width: 330, height: 120, labelEvery: 3, title: 'Order rounds by hour (Bangkok)' })}</div>
      <p class="caption">Hour the round was placed, Bangkok time. Recovered paper orders use the time they were taken.</p></div>
    <div>${h3('By weekday', 'ตามวันในสัปดาห์')}
      <div class="figure">${barChart({ bars: dayBars, width: 330, height: 120, showValues: true, title: 'Order rounds by weekday' })}</div>
      <p class="caption">Totals across the year, Monday first.</p></div>
  </div>
</section>`;
}

const DAY_STATE: Record<DailyRow['state'], string> = { complete: '', partial: 'today · partial', future: 'future', before_records: 'before records' };

/** Group consecutive future / before-records days into one labelled range row (every day stays accounted for). */
function dayRuns(days: DailyRow[]): Array<{ kind: 'day'; day: DailyRow } | { kind: 'range'; from: string; to: string; count: number; state: DailyRow['state'] }> {
  const out: ReturnType<typeof dayRuns> = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.state === 'future' || d.state === 'before_records') {
      let j = i;
      while (j + 1 < days.length && days[j + 1].state === d.state) j++;
      if (j - i >= 1) {
        out.push({ kind: 'range', from: d.date, to: days[j].date, count: j - i + 1, state: d.state });
        i = j;
        continue;
      }
    }
    out.push({ kind: 'day', day: d });
  }
  return out;
}

export async function dailySection(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  const cols: Col<DailyRow>[] = [
    { head: 'Date', cell: (d) => dateShort(d.date), width: '14mm' },
    { head: 'Day', cell: (d) => WEEKDAYS[d.weekday], width: '9mm' },
    { head: 'State', cell: (d) => (DAY_STATE[d.state] ? `<span class="state">${DAY_STATE[d.state]}</span>` : ''), width: '19mm' },
    { head: 'Submitted', num: true, cell: (d) => pv(d, d.submitted) },
    { head: 'Accepted', num: true, cell: (d) => pv(d, d.accepted) },
    { head: 'Rejected', num: true, cell: (d) => pv(d, d.rejected) },
    { head: 'Cancelled', num: true, cell: (d) => pv(d, d.cancelled) },
    { head: 'Visits', num: true, cell: (d) => pv(d, d.visits) },
    { head: 'Devices', num: true, cell: (d) => pv(d, d.devices) },
    { head: 'Seated', num: true, cell: (d) => pv(d, d.seated) },
    { head: 'With covers', num: true, cell: (d) => pv(d, d.covered) },
    { head: 'Diners', num: true, cell: (d) => pv(d, d.diners) },
    { head: 'Items', num: true, cell: (d) => pv(d, d.items) },
    { head: 'Checkouts', num: true, cell: (d) => pv(d, d.closed) },
  ];
  const blocks: string[] = [];
  for (const m of s.monthly) {
    const runs = dayRuns(s.daily.filter((d) => d.date.startsWith(m.key)));
    const body = await rowsChunked(runs, (r) => {
      if (r.kind === 'range') {
        return `<tr class="range"><td colspan="2">${dateShort(r.from)} – ${dateShort(r.to)}</td><td><span class="state">${DAY_STATE[r.state]}</span></td>`
          + `<td colspan="${cols.length - 3}">${r.count} days, each ${r.state === 'future' ? 'still to come' : 'before the first operating day'}: no counts apply</td></tr>`;
      }
      const d = r.day;
      return tr(cols, d, d.state === 'partial' ? 'partial' : '');
    }, tick);
    const total = `<tr class="total"><td colspan="3">${esc(monthName(m.key))} total${PERIOD_STATE[m.state] ? ` <span class="state">${PERIOD_STATE[m.state]}</span>` : ''}</td>`
      + [m.submitted, m.accepted, m.rejected, m.cancelled, m.visits, m.devices, m.seated, m.covered, m.diners, m.items, m.closed].map((v) => `<td class="n">${pv(m, v)}</td>`).join('') + '</tr>';
    blocks.push(`<h3>${esc(monthName(m.key))} ${s.job.year}</h3><table${tableClass(cols, 'dense')}>${thead(cols)}<tbody>${body}${total}</tbody></table>`);
  }
  return `<section class="section">
  ${sectionHead('03', 'Daily record', 'บันทึกรายวัน', `${num(s.daily.length)} days`)}
  <p class="lead">Every calendar day of ${s.job.year}: days with no orders show 0; today is marked partial; runs of days that have not happened yet, or that
    precede the platform's first record, are grouped into one labelled line. Visits and devices are distinct per day, and month totals recompute them for the
    whole month. Diners are the covers entered for visits seated that day.</p>
  ${blocks.join('')}
</section>`;
}
