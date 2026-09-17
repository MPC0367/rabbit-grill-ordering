// Cover and "read this first" page.
import type { ReportSnapshot } from '../export/types.ts';
import { dateLong, dateTime, esc, num } from './format.ts';
import { scopeLine, sectionHead } from './parts.ts';

const LABEL_TEXT = { provisional: 'Provisional', final: 'Final', revised: 'Revised' } as const;
const LABEL_TH = { provisional: 'ฉบับชั่วคราว', final: 'ฉบับสมบูรณ์', revised: 'ฉบับแก้ไข' } as const;

function utcOffset(cutoffHour: number): string {
  return `business day starts ${String(cutoffHour).padStart(2, '0')}:00`;
}

/** 2024-12-31T17:00:00.000Z -> 2024-12-31 17:00Z */
const utcShort = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

export function cover(s: ReportSnapshot): string {
  const j = s.job;
  const fact = (dt: string, dd: string, sub = '') => `<div class="fact"><dt>${esc(dt)}</dt><dd>${dd}${sub ? `<span class="sub">${sub}</span>` : ''}</dd></div>`;
  const yearNote = s.year_state === 'current'
    ? `Year to date: data to ${dateTime(s.data_cutoff)} (Bangkok)`
    : s.year_state === 'future' ? 'This year has not started' : 'Completed calendar year';
  return `<section class="cover">
  <div class="frame"></div>
  <div class="wordmark">RABBIT GRILL</div>
  <div class="wordmark-sub">KHAO YAI · <span lang="th">เขาใหญ่</span></div>
  <div class="rule"></div>
  <div class="title">
    <div class="kicker">Annual order &amp; menu report</div>
    <div class="kicker-th" lang="th">รายงานประจำปี · คำสั่งซื้อและเมนู</div>
    <div class="year">${j.year}</div>
    <div class="badge ${j.label}"><span>${LABEL_TEXT[j.label]}</span><span lang="th">${LABEL_TH[j.label]}</span><span class="rev">· Revision ${j.revision}</span></div>
    ${j.reason ? `<div class="reason"><strong>Reason for this ${j.label === 'revised' ? 'revision' : 'report'}:</strong> ${esc(j.reason)}</div>` : ''}
  </div>
  <dl class="facts">
    ${fact('Restaurant', `${esc(s.restaurant.name_en)}`, `<span lang="th">${esc(s.restaurant.name_th)}</span>`)}
    ${fact('Reporting period', `${dateLong(s.range.from)} – ${dateLong(s.range.to)}`, esc(yearNote))}
    ${fact('Time zone', `Asia/Bangkok (UTC+07:00), ${utcOffset(s.range.cutoff_hour)}`, `In UTC: ${esc(utcShort(s.range.start_utc))} to ${esc(utcShort(s.range.end_utc))}, end exclusive`)}
    ${fact('Generated', `${dateTime(s.generated_at)} (Bangkok)`, `Requested ${dateTime(j.requested_at)} by ${esc(j.requested_by)}`)}
    ${fact('Data snapshot', `Cutoff ${dateTime(s.data_cutoff)}`, `Data version v${num(s.data_version)} · ${s.isolated_snapshot ? 'single consistent read snapshot' : 'non-isolated read'}`)}
    ${fact('Scope', esc(scopeLine(s)), `Report ${esc(j.id)}`)}
  </dl>
  <div class="colophon">Typographic wordmark: no approved logo file is on record, so the name is set in type. Gregorian dates throughout.
  Guest notes, PINs, access tokens and payment references are never included in this report.</div>
</section>`;
}

export function aboutPage(s: ReportSnapshot, toc: Array<{ no: string; title: string; desc: string }>): string {
  const o = s.overview;
  return `<section class="section">
  ${sectionHead('00', 'About this report', 'เกี่ยวกับรายงานฉบับนี้', `${s.job.year} · ${esc(s.job.label)} r${s.job.revision}`)}
  <div class="two">
    <div>
      <h3>Contents</h3>
      <ol class="toc">${toc.map((t) => `<li><span class="no">${esc(t.no)}</span><span><span class="t">${esc(t.title)}</span><span class="d">${esc(t.desc)}</span></span></li>`).join('')}</ol>
    </div>
    <div>
      <h3>Read this first</h3>
      <div class="scope"><strong>What is counted.</strong> Durable records only: order rounds, their lines and status history, visits,
        service requests, measured-weight portion requests${s.job.financial ? ', bills and recorded payments' : ''}, and engagement telemetry.
        Nothing is estimated. Where data is missing, the report says so instead of showing zero.</div>
      <div class="scope"><strong>Attribution.</strong> Order rounds count on the business date they were submitted; recorded diners on the date the
        visit was seated; checkouts on the date the visit closed; payments on the date they were confirmed. A visit that spans New Year is split this way, never counted twice.</div>
      <div class="scope"><strong>Words used carefully.</strong> "Submitted", "accepted", "finalized" and "paid" are different totals and are never called revenue.
        "Devices" are browser sessions, not people. "Recorded diners" are the covers staff entered.</div>
      <h3>Data notes for ${s.job.year}</h3>
      <ul class="plain">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <p class="small muted">Companion data: the annual data export (ZIP of CSV files) holds every row behind this report, including raw engagement events
        for roles allowed to export them. ${num(o.submitted)} order rounds and ${num(o.lines)} order lines are listed in full in Appendix A.</p>
    </div>
  </div>
</section>`;
}
