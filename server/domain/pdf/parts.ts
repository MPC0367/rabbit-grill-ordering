// Small building blocks shared by the report sections.
import { esc } from './format.ts';
import type { ReportSnapshot } from '../export/types.ts';

export function sectionHead(no: string, title: string, th: string, meta = ''): string {
  return `<header class="sec-head"><div class="sec-no">${esc(no)}</div>`
    + `<div><h2 class="sec-title">${esc(title)}</h2><div class="sec-th" lang="th">${esc(th)}</div></div>`
    + `<div class="sec-meta">${meta}</div></header>`;
}

export function kpi(label: string, th: string, value: string, note = ''): string {
  return `<div class="kpi"><div class="k-label">${esc(label)}<div class="k-th" lang="th">${esc(th)}</div></div>`
    + `<div class="k-value">${value}</div>${note ? `<div class="k-note">${note}</div>` : ''}</div>`;
}

export function h3(title: string, th = ''): string {
  return `<h3>${esc(title)}${th ? `<span class="th" lang="th">${esc(th)}</span>` : ''}</h3>`;
}

export interface Col<T> {
  head: string;
  cell: (row: T) => string;
  num?: boolean;
  width?: string;
}

/**
 * Table head. When any column declares a width, a <colgroup> is emitted and
 * the table should use the `fixed` class so wide tables lay out predictably.
 */
export function thead<T>(cols: Col<T>[]): string {
  const widths = cols.some((c) => c.width) ? `<colgroup>${cols.map((c) => `<col${c.width ? ` style="width:${c.width}"` : ''}>`).join('')}</colgroup>` : '';
  return `${widths}<thead><tr>${cols.map((c) => `<th${c.num ? ' class="n"' : ''}>${c.head}</th>`).join('')}</tr></thead>`;
}

/** Table class list: adds `fixed` when columns carry widths. */
export function tableClass<T>(cols: Col<T>[], cls = ''): string {
  const all = [cls, cols.some((c) => c.width) ? 'fixed' : ''].filter(Boolean).join(' ');
  return all ? ` class="${all}"` : '';
}

export function tr<T>(cols: Col<T>[], row: T, cls = ''): string {
  return `<tr${cls ? ` class="${cls}"` : ''}>${cols.map((c) => `<td${c.num ? ' class="n"' : ''}>${c.cell(row)}</td>`).join('')}</tr>`;
}

/** A whole table for a modest number of rows. */
export function table<T>(cols: Col<T>[], rows: T[], opts: { cls?: string; empty?: string; foot?: string } = {}): string {
  if (rows.length === 0 && opts.empty) return `<p class="muted">${esc(opts.empty)}</p>`;
  return `<table${tableClass(cols, opts.cls)}>${thead(cols)}<tbody>${rows.map((r) => tr(cols, r)).join('')}${opts.foot ?? ''}</tbody></table>`;
}

/** Build table body rows for a large list in slices, yielding between slices. */
export async function rowsChunked<T>(rows: T[], render: (row: T, index: number) => string, tick: () => Promise<void>, slice = 400): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += slice) {
    const end = Math.min(rows.length, i + slice);
    for (let j = i; j < end; j++) out.push(render(rows[j], j));
    await tick();
  }
  return out.join('');
}

export function scopeLine(s: ReportSnapshot): string {
  const parts = [
    s.job.financial ? 'Bill and payment values included' : 'Bill and payment values excluded (role lacks reports.financial)',
    s.job.include_fixture ? 'INCLUDES demo data' : 'demo data excluded',
  ];
  return parts.join(' · ');
}

/** Rows printed in the appendices. */
export function appendixRows(s: ReportSnapshot): number {
  return s.orders.length + s.corrections.length + s.portions.length + s.bills.length;
}

/**
 * Tagged PDF (screen-reader structure + bookmarks) costs roughly 8 KB per
 * printed table row, so very large archives are printed untagged to stay a
 * practical download. The report states which one it is.
 */
export const TAGGED_ROW_LIMIT = 2500;
export const isTaggedPdf = (s: ReportSnapshot) => appendixRows(s) <= TAGGED_ROW_LIMIT;

export const plural = (n: number, one: string, many = `${one}s`) => `${n === 1 ? one : many}`;
