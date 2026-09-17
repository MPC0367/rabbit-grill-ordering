// Appendices (every retained order round, corrections, portions, bills) and
// the reference pages (metric dictionary, attribution, notes, versions).
import type { BillRow, CorrectionRow, OrderRow, PortionRow, ReportSnapshot, VersionRow } from '../export/types.ts';
import { clock, dateLong, dateShort, dateTime, esc, grams, money, monthName, num, ORDER_STATUS_LABEL, SOURCE_LABEL } from './format.ts';
import { appendixRows, h3, isTaggedPdf, rowsChunked, sectionHead, TAGGED_ROW_LIMIT, type Col, table, tableClass, thead, tr } from './parts.ts';

const statusTag = (status: string) => {
  const cls = status === 'served' ? 'ok' : status === 'rejected' || status === 'cancelled' ? 'warn' : 'dim';
  return `<span class="tag ${cls}">${esc(ORDER_STATUS_LABEL[status] ?? status)}</span>`;
};

export async function ordersAppendix(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  const fin = Boolean(s.payments);
  // Landscape content width is 269 mm; the items column takes what is left.
  const cols: Col<OrderRow>[] = [
    { head: 'Reference', cell: (o) => `<b>${esc(o.reference)}</b>${o.manual_reference ? ` <span class="muted">paper ${esc(o.manual_reference)}</span>` : ''}`, width: '17mm' },
    { head: 'Date', cell: (o) => `<span class="nowrap">${dateShort(o.business_date)} ${clock(o.submitted_at)}</span>`, width: '19mm' },
    { head: 'Table · round', cell: (o) => `${esc(o.table_label)} <span class="muted">· ${o.round_no}</span>`, width: '19mm' },
    { head: 'Source', cell: (o) => `${esc(SOURCE_LABEL[o.source] ?? o.source)}${o.staff_name ? ` <span class="muted">${esc(o.staff_name)}</span>` : ''}`, width: '27mm' },
    { head: 'Items (quantity × item; status when not served)', cell: (o) => `<span class="items">${esc(o.items)}</span>` },
    { head: 'Net / all', num: true, cell: (o) => `${num(o.qty_net)} / ${num(o.qty_total)}`, width: '13mm' },
    { head: 'Round', cell: (o) => statusTag(o.status), width: '21mm' },
    ...(fin ? [{ head: 'Subtotal', num: true, cell: (o: OrderRow) => `${money(o.subtotal_minor)}${o.accepted_minor !== o.subtotal_minor ? `<span class="sub">accepted ${money(o.accepted_minor)}</span>` : ''}`, width: '20mm' }] : []),
    { head: 'Flags', cell: (o) => o.flags.map((f) => `<span class="tag ${f === 'allergy' || f === 'late change' ? 'warn' : 'dim'}">${esc(f)}</span>`).join(' '), width: '26mm' },
  ];
  const parts: string[] = [];
  let month = '';
  const body = await rowsChunked(s.orders, (o) => {
    const m = o.business_date.slice(0, 7);
    let head = '';
    if (m !== month) {
      month = m;
      const count = s.monthly.find((x) => x.key === m)?.submitted ?? 0;
      head = `<tr class="group"><td colspan="${cols.length}">${esc(monthName(m))} ${m.slice(0, 4)} · ${num(count)} rounds</td></tr>`;
    }
    return head + tr(cols, o);
  }, tick);
  parts.push(`<section class="wide">
  ${sectionHead('A', 'Appendix A · Every order round', 'ภาคผนวก ก · ทุกรอบการสั่ง', `${num(s.orders.length)} rounds`)}
  <div class="appendix-lead"><div class="scope"><strong>Complete.</strong> One row for every retained order round of ${s.job.year} in this report's scope,
    in submission order, with the table label as it was at the time. Guest notes are never printed; "note" and "allergy" only flag that a note existed.
    Full line-level rows (prices, timestamps, modifiers) are in orders.csv and order_lines.csv.</div></div>
  ${s.orders.length ? `<table${tableClass(cols, 'dense')}>${thead(cols)}<tbody>${body}</tbody></table>` : '<p class="muted">No order rounds in this year.</p>'}
</section>`);
  return parts.join('');
}

const KIND_LABEL: Record<string, string> = {
  correction: 'Status corrected', cancel: 'Cancelled', reject: 'Rejected (later day)', manual_recovery: 'Recovered paper order',
  close_exception: 'Visit closed by exception', payment_reversal: 'Payment reversed', bill_reopened: 'Bill reopened', recovery: 'Recovery',
};

export async function correctionsAppendix(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  const cols: Col<CorrectionRow>[] = [
    { head: 'Recorded', cell: (c) => `<span class="nowrap">${dateTime(c.at)}</span>`, width: '28mm' },
    { head: 'Change', cell: (c) => `${esc(KIND_LABEL[c.kind] ?? c.kind)}${c.late ? ' <span class="tag warn">later day</span>' : ''}`, width: '40mm' },
    { head: 'Round / bill', cell: (c) => esc(c.reference), width: '18mm' },
    { head: 'Table', cell: (c) => esc(c.table_label), width: '16mm' },
    { head: 'Item', cell: (c) => esc(c.item), width: '40mm' },
    { head: 'From', cell: (c) => esc(c.from), width: '20mm' },
    { head: 'To', cell: (c) => esc(c.to), width: '32mm' },
    { head: 'Reason', cell: (c) => esc(c.reason) },
    { head: 'By', cell: (c) => esc(c.actor), width: '28mm' },
  ];
  const body = await rowsChunked(s.corrections, (c) => tr(cols, c), tick);
  return `<section class="wide">
  ${sectionHead('B', 'Appendix B · Corrections & recoveries', 'ภาคผนวก ข · การแก้ไขและการกู้คืน', `${num(s.corrections.length)} entries`)}
  <div class="appendix-lead"><div class="scope"><strong>Scope.</strong> Every cancellation, status correction and recovered paper order affecting ${s.job.year}'s rounds,
    rejections recorded on a later day${s.payments ? ', payment reversals, reopened bills' : ''} and visits closed by manager exception.
    Same-day rejections are summarised by reason in section 07 and shown on each round in Appendix A.</div></div>
  ${s.corrections.length ? `<table${tableClass(cols, 'dense')}>${thead(cols)}<tbody>${body}</tbody></table>` : '<p class="muted">No corrections or recoveries were recorded.</p>'}
</section>`;
}

export function portionsAppendix(s: ReportSnapshot): string {
  const fin = Boolean(s.payments);
  const cols: Col<PortionRow>[] = [
    { head: 'Requested', cell: (p) => `<span class="nowrap">${dateTime(p.created_at)}</span>`, width: '30mm' },
    { head: 'Table', cell: (p) => esc(p.table_label), width: '22mm' },
    { head: 'Cut', cell: (p) => esc(p.item), width: '36mm' },
    { head: 'Status', cell: (p) => `<span class="tag ${p.status === 'confirmed' ? 'ok' : 'dim'}">${esc(p.status)}</span>${p.confirmed_via === 'in_person' ? ' <span class="muted">in person</span>' : ''}`, width: '34mm' },
    { head: 'Preferred weight', num: true, cell: (p) => grams(p.preferred_grams), width: '20mm' },
    { head: 'Quote revisions', num: true, cell: (p) => num(p.quotes), width: '18mm' },
    { head: 'Final weight', num: true, cell: (p) => grams(p.grams), width: '18mm' },
    ...(fin ? [{ head: 'Quote amount', num: true, cell: (p: PortionRow) => money(p.amount_minor), width: '20mm' }] : []),
    { head: 'Order', cell: (p) => esc(p.order_reference ?? ''), width: '18mm' },
    { head: 'Resolution', cell: (p) => esc(p.resolution ?? '') },
  ];
  return `<section class="wide">
  ${sectionHead('C', 'Appendix C · Priced-by-weight portions', 'ภาคผนวก ค · การชั่งน้ำหนัก', `${num(s.portions.length)} requests`)}
  <p class="small muted">Each measured-weight request with its final quoted or confirmed weight${fin ? ' and amount' : ''}, as snapshotted when it was quoted.
    Only confirmed quotes created order lines.</p>
  ${table(cols, s.portions, { cls: 'dense', empty: 'No portion requests in this year.' })}
</section>`;
}

export async function billsAppendix(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  if (!s.payments) return '';
  const cols: Col<BillRow>[] = [
    { head: 'Finalized', cell: (b) => dateTime(b.finalized_at) },
    { head: 'Table', cell: (b) => esc(b.table_label) },
    { head: 'Revision', num: true, cell: (b) => `r${b.revision_no}` },
    { head: 'Status', cell: (b) => `<span class="tag ${b.status === 'settled' ? 'ok' : b.status === 'payable' ? 'warn' : 'dim'}">${esc(b.status)}</span>` },
    { head: 'Items', num: true, cell: (b) => money(b.subtotal_minor) },
    { head: 'Adjustments', num: true, cell: (b) => (b.adjustments_minor ? money(b.adjustments_minor) : '–') },
    { head: 'Charges added', num: true, cell: (b) => (b.charges_minor ? money(b.charges_minor) : '–') },
    { head: 'Total', num: true, cell: (b) => `<b>${money(b.total_minor)}</b>` },
    { head: 'Paid', num: true, cell: (b) => money(b.paid_minor) },
    { head: 'Method', cell: (b) => esc(b.methods) },
    { head: 'Note', cell: (b) => esc(b.note) },
  ];
  const body = await rowsChunked(s.bills, (b) => tr(cols, b), tick);
  return `<section class="wide">
  ${sectionHead('D', 'Appendix D · Bills', 'ภาคผนวก ง · บิล', `${num(s.bills.length)} revisions`)}
  <p class="small muted">Every bill revision finalized in ${s.job.year}, including superseded ones (reopened by a manager, with the reason). Paid = confirmed
    settlements against that revision. Individual payment rows are in payments.csv.</p>
  ${s.bills.length ? `<table${tableClass(cols, 'dense')}>${thead(cols)}<tbody>${body}</tbody></table>` : '<p class="muted">No bills were finalized in this year.</p>'}
</section>`;
}

const DICTIONARY: Array<[string, string, string]> = [
  ['Submitted order round', 'A persistent order created by a guest, staff member, paper recovery or confirmed portion quote, including rounds later rejected or cancelled.', 'Submitted business date'],
  ['Accepted order round', 'A round with at least one line accepted and not later cancelled or rejected.', 'Submitted business date'],
  ['Rejected / cancelled round', 'Rejected: every line was rejected before acceptance. Cancelled: no line is still active and not every line was rejected.', 'Submitted business date'],
  ['Ordering visit', 'A distinct dining visit (one seated party at a table) with at least one submitted round. Recomputed per period, never summed from days.', 'Submitted business date'],
  ['Ordering device', 'A distinct guest browser session that placed a guest QR round. It approximates devices; two people sharing a phone are one device.', 'Submitted business date'],
  ['First operating day', 'The earliest business date on which a visit was seated. Earlier days are "before records", never zero.', 'Seated business date'],
  ['Recorded diners', 'The sum of covers staff entered for visits seated in the period. Visits without covers add nothing and are reported as missing coverage.', 'Seated business date'],
  ['Items ordered (net servings)', 'Quantity on lines accepted and not cancelled. A measured-weight portion is one serving; its grams are reported separately.', 'Submitted business date'],
  ['Submitted quantity', 'Quantity on every line as submitted, including later rejected or cancelled lines (gross demand).', 'Submitted business date'],
  ['Visits checked out', 'Visits whose checkout completed in the period.', 'Closed business date'],
  ['Available days', 'Business days from the later of 1 January and the first operating day on which the item was logged as available at any moment. Time before an item\'s first log entry counts as not available.', 'Availability log'],
  ['Measured session', 'A pseudonymous browsing session with at least one stored engagement event in the year. Never a person and never linked across visits.', 'Event business date'],
  ['Active menu time', 'Per measured session, the sum of foreground intervals on the menu route while the guest interacted within the idle threshold.', 'Event business date'],
  ['Add rate', 'Sessions that saw the dish and added it, divided by sessions that saw it; an impression is the dish at least half visible for at least a second.', 'Event business date'],
  ['Scroll depth', 'The deepest point a session reached on the menu page, over measured sessions that opened the menu. Approximate.', 'Event business date'],
  ['Acceptance time', 'Round submission to the first accepted line, recorded live. Recovered paper orders are excluded.', 'Submitted business date'],
  ['Submitted / accepted item value', 'Sum of round subtotals as submitted / of accepted, not cancelled line totals. Before charges and adjustments. Not revenue.', 'Submitted business date'],
  ['Finalized bill value', 'Totals of current (not superseded) finalized bill revisions, including owner-configured charges and adjustments.', 'Finalized business date'],
  ['Recorded payments, net', 'Staff-confirmed settlements still in force. A later reversal or refund is subtracted on the date of the settlement it corrects. Not a bank reconciliation.', 'Settlement confirmed date'],
  ['Payment exception', 'A current bill revision with no confirmed settlement once the visit closed or the finalize date passed, or a settlement that differs from the bill total.', 'Finalized business date'],
];

export function referenceSection(s: ReportSnapshot): string {
  const vcols: Col<VersionRow>[] = [
    { head: 'Rev.', cell: (v) => `r${v.revision}`, width: '9mm' },
    { head: 'Label', cell: (v) => `<span class="tag ${v.label === 'provisional' ? 'dim' : 'ok'}">${esc(v.label)}</span>`, width: '18mm' },
    { head: 'Status', cell: (v) => (v.current ? '<b>This report</b>' : esc(v.status)), width: '16mm' },
    { head: 'Requested', cell: (v) => `<span class="nowrap">${dateTime(v.requested_at)}</span><span class="sub">${esc(v.requested_by)}</span>`, width: '30mm' },
    { head: 'Data cutoff', cell: (v) => `<span class="nowrap">${dateTime(v.data_cutoff)}</span><span class="sub">data v${v.data_version ?? '–'}</span>`, width: '30mm' },
    { head: 'Rounds', num: true, cell: (v) => (v.current ? num(s.overview.submitted) : v.summary ? num(v.summary.submitted_rounds) : '–'), width: '13mm' },
    { head: 'Accepted', num: true, cell: (v) => (v.current ? num(s.overview.accepted) : v.summary ? num(v.summary.accepted_rounds) : '–'), width: '15mm' },
    { head: 'Items', num: true, cell: (v) => (v.current ? num(s.overview.items) : v.summary ? num(v.summary.items_net) : '–'), width: '12mm' },
    { head: 'Reason / file', cell: (v) => `${esc(v.reason ?? '')}${v.sha256 ? `<span class="sub">sha256 ${esc(v.sha256.slice(0, 16))}…</span>` : ''}` },
  ];
  return `<section class="section">
  ${sectionHead('R', 'Definitions & provenance', 'นิยามและที่มาของข้อมูล', `Report ${esc(s.job.id)}`)}
  ${h3('Metric dictionary', 'พจนานุกรมตัวชี้วัด')}
  <table class="compact"><thead><tr><th style="width:38mm">Metric</th><th>Definition</th><th style="width:32mm">Counted on</th></tr></thead>
  <tbody>${DICTIONARY.map(([m, d, a]) => `<tr><td><b>${esc(m)}</b></td><td>${esc(d)}</td><td>${esc(a)}</td></tr>`).join('')}</tbody></table>

  <div class="two">
    <div>${h3('Time and attribution', 'เวลาและการนับ')}
      <ul class="plain">
        <li>All times are stored in UTC and reported in Asia/Bangkok (UTC+07:00, no daylight saving).</li>
        <li>A business day starts at ${String(s.range.cutoff_hour).padStart(2, '0')}:00; each record's business date was stamped when it was written.</li>
        <li>This report covers business dates ${dateLong(s.range.from)} to ${dateLong(s.range.to)}: the half-open UTC interval
          [${esc(s.range.start_utc)}, ${esc(s.range.end_utc)}).</li>
        <li>Order rounds count by submission; diners by seating; checkouts by closing; payments by confirmation, with any later reversal or refund counted against the payment it corrects. A visit seated before New Year
          and closed after it contributes its diners to the earlier year and its checkout to the later one.</li>
        <li>Weeks run Monday to Sunday. A week that crosses New Year is clipped to this year's days in this report.</li>
        <li>New Year changes the reporting year only. Nothing is deleted, reset or renumbered.</li>
      </ul>
    </div>
    <div>${h3('Data coverage', 'ความครอบคลุมของข้อมูล')}
      <ul class="plain">
        ${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
        <li>Engagement measurement started: ${s.engagement.instrumentation_started_at ? dateTime(s.engagement.instrumentation_started_at) : 'not recorded'};
          first event in this year: ${s.engagement.first_event_at ? dateTime(s.engagement.first_event_at) : 'none'}.</li>
        <li>Retention (applied by a daily clean-up task): guest note text ${num(s.settings.notes_days)} days, feedback comments ${num(s.settings.feedback_days)} days,
          raw engagement events ${num(s.settings.raw_events_days)} days, audit log ${num(s.settings.audit_days)} days.
          ${s.settings.retention_last_run ? `Last run ${dateTime(s.settings.retention_last_run)}.` : 'The clean-up task has not run yet.'}
          Order, visit and payment records are kept (only the note text is removed) so reports stay reproducible.</li>
        <li>Line status totals: ${Object.entries(s.line_status_totals).filter(([, v]) => v).map(([k, v]) => `${esc(k.replace('_', ' '))} ${num(v)}`).join(', ') || 'no lines'}.</li>
      </ul>
    </div>
  </div>

  ${h3('Report versions', 'ประวัติฉบับรายงาน')}
  ${table(vcols, s.versions, { cls: 'compact' })}
  <p class="caption">Earlier files are kept unchanged and stay downloadable. A revised report is produced only on request, with a reason, when data for the year
    changed after the last report (data version ${num(s.data_version)} at this snapshot). Generated ${dateTime(s.generated_at)}; snapshot taken
    ${dateTime(s.data_cutoff)}${s.isolated_snapshot ? ' inside one read transaction, so every page reconciles' : ''}.
    Operating mode at generation: ${esc(s.operating_mode)}.
    ${isTaggedPdf(s)
      ? 'This PDF is tagged for screen readers and has bookmarks for every section.'
      : `This PDF is not tagged and has no bookmarks: its appendices hold ${num(appendixRows(s))} rows, above the ${num(TAGGED_ROW_LIMIT)}-row limit for tagged output, which would make the file impractically large.`}</p>
</section>`;
}

