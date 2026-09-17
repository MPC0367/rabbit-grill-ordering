// Assemble the annual report HTML from a snapshot. Large sections are built in
// slices (the `tick` callback yields to the event loop), and the heavy lifting
// (layout, pagination, PDF output) happens in the browser process.
import type { ReportSnapshot } from '../export/types.ts';
import { billsAppendix, correctionsAppendix, ordersAppendix, portionsAppendix, referenceSection } from './appendix.ts';
import { esc } from './format.ts';
import { footerFontCss } from './fonts.ts';
import { aboutPage, cover } from './front.ts';
import { engagementSection, exceptionsSection, operationsSection, paymentsSection } from './insight.ts';
import { menuSection, rankingAppendix } from './menu.ts';
import { reportCss } from './styles.ts';
import { dailySection, overviewSection, timeSection } from './volume.ts';

export async function buildReportHtml(s: ReportSnapshot, tick: () => Promise<void>): Promise<string> {
  const fin = Boolean(s.payments);
  const toc = [
    { no: '01', title: 'Year overview', desc: 'Headline counts, outcomes of submitted rounds, how rounds were placed' },
    { no: '02', title: 'Orders over time', desc: 'Monthly and weekly charts, calendar of every day, hour and weekday patterns' },
    { no: '03', title: 'Daily record', desc: 'Every day of the year with its counts, including zero and not-yet-happened days' },
    { no: '04', title: 'Menu ranking', desc: 'Most and least ordered, priced-by-weight cuts, categories, full ranking (landscape)' },
    { no: '05', title: 'Guest engagement', desc: 'Measured sessions, active time, exposure, add and submit funnel, limitations' },
    { no: '06', title: 'Service operations', desc: 'Acceptance, preparation and service intervals, visit durations, requests, portions' },
    { no: '07', title: 'Cancellations & exceptions', desc: `Reasons, stages, corrections${fin ? ', payment exceptions' : ''}` },
    ...(fin ? [{ no: '08', title: 'Bills & payments', desc: 'Finalized bills, recorded payments by method and month' }] : []),
    { no: 'A', title: 'Every order round', desc: 'One row per round with items, quantities and statuses (landscape)' },
    { no: 'B', title: 'Corrections & recoveries', desc: 'After-the-fact changes, recovered paper orders, exceptions' },
    { no: 'C', title: 'Priced-by-weight portions', desc: 'Each measured-weight request and its confirmed weight' },
    ...(fin ? [{ no: 'D', title: 'Bills', desc: 'Every bill revision finalized in the year' }] : []),
    { no: 'R', title: 'Definitions & provenance', desc: 'Metric dictionary, attribution, data coverage, report versions' },
  ];
  const parts: string[] = [];
  parts.push(cover(s), aboutPage(s, toc), overviewSection(s), timeSection(s));
  await tick();
  parts.push(await dailySection(s, tick));
  parts.push(menuSection(s));
  parts.push(await rankingAppendix(s, tick));
  parts.push(await engagementSection(s, tick));
  parts.push(operationsSection(s), exceptionsSection(s), paymentsSection(s));
  await tick();
  parts.push(await ordersAppendix(s, tick));
  parts.push(await correctionsAppendix(s, tick));
  parts.push(portionsAppendix(s));
  parts.push(await billsAppendix(s, tick));
  parts.push(referenceSection(s));
  const title = `${s.restaurant.name_en} annual report ${s.job.year} (${s.job.label}, revision ${s.job.revision})`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<meta name="generator" content="Rabbit Grill ordering platform">
<meta name="description" content="Typographic wordmark; data cutoff ${esc(s.data_cutoff)}; data version ${s.data_version}">
<title>${esc(title)}</title>
<style>${reportCss()}</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>`;
}

/** Page footer: restaurant, year, label and "page X of Y" on every page. */
export function footerTemplate(s: ReportSnapshot): string {
  const label = `${s.job.label.toUpperCase()} · R${s.job.revision}${s.job.include_fixture ? ' · INCLUDES DEMO DATA' : ''}`;
  return `<style>${footerFontCss()}</style>
<div style="width:100%;margin:0 15mm 0;padding-top:1.5mm;display:flex;justify-content:space-between;align-items:baseline;
  font-family:'RG Display',Arial,sans-serif;font-size:7px;letter-spacing:0.14em;color:#8E8B82;-webkit-print-color-adjust:exact">
  <span>${esc(s.restaurant.name_en.toUpperCase())} · ANNUAL REPORT ${s.job.year}</span>
  <span>${esc(label)}</span>
  <span>PAGE <span class="pageNumber"></span> OF <span class="totalPages"></span></span>
</div>`;
}
