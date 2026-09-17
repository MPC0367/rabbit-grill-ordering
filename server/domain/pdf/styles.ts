// Print stylesheet for the annual report, in Rabbit Grill's identity: paper
// ground, forest structure, ink text, ember used sparingly for emphasis, thin
// rules. Oswald for short headings and figures, Noto Sans Thai for reading
// text and every Thai string, Cormorant Garamond only for the wordmark.
import { C } from './charts.ts';
import { FONT, fontFaceCss } from './fonts.ts';

export function reportCss(): string {
  return `${fontFaceCss()}
@page { size: A4; margin: 17mm 15mm 17mm 15mm; background: ${C.paper}; }
@page cover { margin: 0; background: ${C.forest}; }
@page wide { size: A4 landscape; margin: 14mm 14mm 15mm 14mm; background: ${C.paper}; }
:root { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: ${C.paper}; }
body { font-family: ${FONT.sans}, sans-serif; font-size: 8.4pt; line-height: 1.55; color: ${C.ink}; font-weight: 400;
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
[lang="th"] { letter-spacing: 0; }
h1, h2, h3, h4 { margin: 0; font-weight: 500; }
p { margin: 0 0 2.2mm; }
/* <code> would otherwise use the browser's monospace default, a font installed on the server (not embedded). */
code { font-family: ${FONT.sans}, sans-serif; font-size: 0.95em; }
.muted { color: ${C.taupe}; }
.small { font-size: 7.4pt; }
.ember { color: ${C.emberInk}; }
.nowrap { white-space: nowrap; }

/* ------------------------------------------------------------ cover */
.cover { page: cover; position: relative; width: 210mm; height: 297mm; overflow: hidden; color: ${C.bone};
  padding: 22mm 20mm 20mm; display: flex; flex-direction: column; background: ${C.forest}; }
.cover .frame { position: absolute; inset: 9mm; border: 0.3mm solid rgba(248,244,234,0.28); pointer-events: none; }
.wordmark { font-family: ${FONT.serif}, serif; font-weight: 600; font-size: 31pt; letter-spacing: 0.34em; line-height: 1; margin-left: 0.1em; }
.wordmark-sub { font-family: ${FONT.display}, sans-serif; font-size: 8.5pt; letter-spacing: 0.42em; color: ${C.ember}; margin-top: 3.2mm; }
.wordmark-sub span[lang="th"] { font-family: ${FONT.sans}, sans-serif; letter-spacing: 0; font-size: 8.5pt; }
.cover .rule { height: 0.3mm; background: rgba(248,244,234,0.35); margin: 12mm 0 0; }
.cover .title { margin-top: 30mm; }
.cover .kicker { font-family: ${FONT.display}, sans-serif; font-size: 13pt; letter-spacing: 0.3em; text-transform: uppercase; }
.cover .kicker-th { font-size: 11pt; color: rgba(248,244,234,0.78); margin-top: 1mm; }
.cover .year { font-family: ${FONT.display}, sans-serif; font-weight: 300; font-size: 150pt; line-height: 0.92; letter-spacing: -0.01em; margin: 6mm 0 0 -2mm; }
.badge { display: inline-flex; align-items: center; gap: 2.5mm; margin-top: 8mm; font-family: ${FONT.display}, sans-serif;
  font-size: 10.5pt; letter-spacing: 0.22em; text-transform: uppercase; padding: 2mm 4mm 2.1mm; border: 0.4mm solid ${C.ember}; }
.badge.final, .badge.revised { background: ${C.ember}; color: ${C.bone}; }
.badge.provisional { color: ${C.bone}; }
.badge .rev { opacity: 0.85; letter-spacing: 0.12em; }
.cover .reason { margin-top: 4mm; max-width: 140mm; font-size: 9.5pt; color: rgba(248,244,234,0.9); }
.cover .facts { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; column-gap: 12mm; row-gap: 3.4mm;
  border-top: 0.3mm solid rgba(248,244,234,0.35); padding-top: 6mm; }
.cover .fact dt { font-family: ${FONT.display}, sans-serif; font-size: 7pt; letter-spacing: 0.22em; text-transform: uppercase; color: ${C.ember}; }
.cover .fact dd { margin: 0.6mm 0 0; font-size: 9pt; line-height: 1.45; }
.cover .fact dd .sub { display: block; color: rgba(248,244,234,0.7); font-size: 7.6pt; }
.cover .colophon { margin-top: 6mm; font-size: 7pt; color: rgba(248,244,234,0.6); }

/* ------------------------------------------------------------ sections */
.section { break-before: page; }
.wide { page: wide; break-before: page; }
.sec-head { display: grid; grid-template-columns: 15mm 1fr auto; align-items: end; border-bottom: 0.5mm solid ${C.ink};
  padding-bottom: 2.2mm; margin-bottom: 5mm; }
.sec-no { font-family: ${FONT.display}, sans-serif; font-size: 22pt; font-weight: 300; color: ${C.ember}; line-height: 1; }
.sec-title { font-family: ${FONT.display}, sans-serif; font-size: 19pt; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.05; }
.sec-th { font-size: 9.5pt; color: ${C.taupe}; margin-top: 1mm; line-height: 1.5; }
.sec-meta { font-family: ${FONT.display}, sans-serif; font-size: 7.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.taupe}; text-align: right; line-height: 1.5; }
h3 { font-family: ${FONT.display}, sans-serif; font-size: 10.5pt; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
  margin: 6mm 0 2.2mm; break-after: avoid; }
h3 .th { font-family: ${FONT.sans}, sans-serif; text-transform: none; letter-spacing: 0; font-weight: 400; color: ${C.taupe}; font-size: 8.4pt; margin-left: 2mm; }
h3:first-child { margin-top: 0; }
.lead { font-size: 9pt; max-width: 165mm; }
.block { break-inside: avoid; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.two > * { min-width: 0; }

/* ------------------------------------------------------------ figures */
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 0.3mm solid ${C.ink}; }
.kpi { padding: 3mm 3mm 3.4mm 0; border-bottom: 0.2mm solid ${C.rule}; break-inside: avoid; }
.kpi + .kpi { padding-left: 3mm; border-left: 0.2mm solid ${C.rule}; }
.kpi:nth-child(4n+1) { padding-left: 0; border-left: 0; }
.kpi .k-label { font-family: ${FONT.display}, sans-serif; font-size: 7pt; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.taupe}; line-height: 1.35; min-height: 7.4mm; }
.kpi .k-th { font-size: 7pt; color: ${C.taupe}; line-height: 1.45; }
.kpi .k-value { font-family: ${FONT.display}, sans-serif; font-size: 21pt; font-weight: 400; line-height: 1.1; margin-top: 1mm; color: ${C.forest}; }
.kpi .k-value small { font-size: 9pt; color: ${C.taupe}; font-weight: 400; margin-left: 1mm; }
.kpi .k-note { font-size: 7pt; color: ${C.taupe}; line-height: 1.4; margin-top: 0.6mm; }
.kpis.money .k-value { color: ${C.ink}; font-size: 17pt; }
.chart { display: block; width: 100%; height: auto; overflow: visible; }
.chart .ax { font-family: ${FONT.sans}, sans-serif; font-size: 7px; fill: ${C.taupe}; }
.chart .val { font-family: ${FONT.display}, sans-serif; font-size: 7.5px; fill: ${C.ink}; }
.chart .lbl { font-family: ${FONT.sans}, sans-serif; font-size: 8px; fill: ${C.ink}; }
.figure { margin: 1mm 0 2mm; break-inside: avoid; }
.caption { font-size: 7.2pt; color: ${C.taupe}; margin-top: 1.2mm; }
.legend { display: flex; flex-wrap: wrap; gap: 1mm 4mm; font-size: 7pt; color: ${C.taupe}; margin-top: 1.4mm; align-items: center; }
.legend span { display: inline-flex; align-items: center; gap: 1.2mm; }
.legend i { display: inline-block; width: 3mm; height: 3mm; }
.legend i.hatch { background: #E3D9C3; border: 0.2mm dashed #B9AE96; }
.funnel { display: grid; grid-template-columns: 34mm 1fr 22mm; gap: 1.2mm 2mm; align-items: center; font-size: 7.8pt; margin: 1mm 0 2mm; }
.funnel .track { height: 3.2mm; background: ${C.paper2}; position: relative; }
.funnel .fill { position: absolute; left: 0; top: 0; bottom: 0; background: ${C.forest2}; }
.funnel .fill.last { background: ${C.ember}; }
.funnel .v { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.funnel .v small { color: ${C.taupe}; }
tr.range td { color: ${C.steel}; font-style: normal; background: transparent !important; }
.note { border-left: 0.8mm solid ${C.ember}; background: ${C.bone}; padding: 2.2mm 3mm; margin: 3mm 0; font-size: 8pt; break-inside: avoid; }
.note strong { font-family: ${FONT.display}, sans-serif; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; font-size: 7.4pt; margin-right: 1.5mm; }
.scope { border: 0.25mm solid ${C.forest}; padding: 2.4mm 3mm; margin: 3mm 0; font-size: 8pt; break-inside: avoid; }
.scope strong { color: ${C.forest}; }
ul.plain { margin: 0; padding-left: 4mm; }
ul.plain li { margin: 0 0 1.2mm; }
.toc { list-style: none; margin: 0; padding: 0; counter-reset: none; }
.toc li { display: grid; grid-template-columns: 11mm 1fr; padding: 1.6mm 0; border-bottom: 0.2mm solid ${C.rule}; break-inside: avoid; }
.toc .no { font-family: ${FONT.display}, sans-serif; color: ${C.ember}; font-size: 10pt; }
.toc .t { font-family: ${FONT.display}, sans-serif; font-size: 10pt; letter-spacing: 0.06em; text-transform: uppercase; }
.toc .d { display: block; font-size: 7.6pt; color: ${C.taupe}; line-height: 1.45; }

/* ------------------------------------------------------------ tables */
table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; }
table.fixed { table-layout: fixed; }
table.fixed td { overflow-wrap: anywhere; }
thead { display: table-header-group; }
tfoot { display: table-row-group; }
tr { break-inside: avoid; }
th { font-family: ${FONT.display}, sans-serif; font-weight: 500; font-size: 6.8pt; letter-spacing: 0.1em; text-transform: uppercase;
  text-align: left; color: ${C.forest}; padding: 1.6mm 1.6mm 1.3mm; border-bottom: 0.35mm solid ${C.ink}; vertical-align: bottom; line-height: 1.3; }
td { padding: 1.05mm 1.6mm; border-bottom: 0.15mm solid ${C.rule}; vertical-align: top; line-height: 1.5; }
th.n, td.n { text-align: right; }
td.n { white-space: nowrap; }
td .alt { display: block; color: ${C.taupe}; font-size: 0.9em; }
td .sub { display: block; color: ${C.taupe}; font-size: 0.88em; }
tbody tr:nth-child(even) td { background: #EEE6D5; }
tr.group td { background: ${C.paper2} !important; font-family: ${FONT.display}, sans-serif; font-size: 7.6pt; letter-spacing: 0.12em;
  text-transform: uppercase; color: ${C.forest}; padding-top: 1.6mm; border-bottom: 0.25mm solid ${C.forest}; break-after: avoid; }
tr.total td { font-weight: 600; border-top: 0.3mm solid ${C.ink}; border-bottom: 0.3mm solid ${C.ink}; background: transparent !important; }
tr.future td { color: ${C.steel}; }
tr.before td { color: ${C.steel}; }
tr.partial td { color: ${C.emberInk}; }
table.compact td { padding-top: 0.7mm; padding-bottom: 0.7mm; }
table.dense { font-size: 7.3pt; }
table.dense td { padding: 0.8mm 1.3mm; line-height: 1.45; }
table.dense th { padding: 1.3mm 1.3mm 1.1mm; font-size: 6.3pt; letter-spacing: 0.03em; }
.tag { display: inline-block; font-family: ${FONT.display}, sans-serif; font-size: 6.4pt; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 0 1.2mm; border: 0.2mm solid currentColor; border-radius: 0.6mm; line-height: 1.55; white-space: nowrap; }
.tag.warn { color: ${C.emberInk}; }
.tag.ok { color: ${C.forest}; }
.tag.dim { color: ${C.taupe}; }
.state { font-size: 7pt; color: ${C.taupe}; white-space: nowrap; }
.bar-cell { position: relative; }
.bar-cell i { position: absolute; left: 1.6mm; bottom: 0.5mm; height: 0.7mm; background: ${C.forest2}; opacity: 0.55; }
.items { color: ${C.ink2}; }
.rank { font-family: ${FONT.display}, sans-serif; font-size: 9pt; color: ${C.forest}; }
.appendix-lead { display: flex; justify-content: space-between; gap: 8mm; align-items: flex-start; margin-bottom: 3mm; }
.appendix-lead .scope { margin: 0; max-width: 150mm; }

/* Screen view of the same HTML (QA copy): page-like sheets instead of print margins. */
@media screen {
  body { background: #D9D0BC; padding: 8mm 0; }
  .cover { margin: 0 auto 8mm; }
  .section, .wide { background: ${C.paper}; width: 210mm; margin: 0 auto 8mm; padding: 17mm 15mm; box-shadow: 0 1px 3px rgba(23,21,15,0.25); }
  .wide { width: 297mm; padding: 14mm; }
}
`;
}
