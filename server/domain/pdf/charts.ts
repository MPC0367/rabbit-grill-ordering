// Inline SVG charts for the annual report. Vector output stays crisp in the
// PDF and needs no chart library. Count axes always start at zero and use
// whole-number ticks; future periods are drawn as dashed outlines, never as
// zero-height "bad" bars.
import { esc, num } from './format.ts';
import type { DailyRow } from '../export/types.ts';

export const C = {
  paper: '#F3ECDD',
  paper2: '#E9E0CB',
  bone: '#F8F4EA',
  ink: '#17150F',
  ink2: '#221E16',
  forest: '#1E4230',
  forest2: '#2C5A40',
  forestSoft: '#8FA897',
  ember: '#CB6234',
  emberInk: '#A8441E',
  taupe: '#6B5E4B',
  steel: '#8E8B82',
  rule: '#CFC4AC',
};

/** A "nice" axis maximum and step with whole-number ticks. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const whole = Math.ceil(step);
  return { max: Math.ceil(max / whole) * whole, step: whole };
}

export interface Bar {
  label: string;
  value: number;
  /** Optional inner value drawn over the bar (e.g. accepted within submitted). */
  inner?: number;
  state?: 'complete' | 'partial' | 'future' | 'before_records';
  muted?: boolean;
  highlight?: boolean;
}

export function barChart(opts: {
  bars: Bar[];
  width: number;
  height: number;
  labelEvery?: number;
  showValues?: boolean;
  title: string;
  valueLabel?: string;
  innerLabel?: string;
}): string {
  const { bars, width, height } = opts;
  const left = 34;
  const right = 6;
  const top = opts.showValues ? 14 : 8;
  const bottom = 20;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const { max, step } = niceScale(Math.max(0, ...bars.map((b) => b.value)));
  const slot = plotW / Math.max(1, bars.length);
  const barW = Math.max(1.5, Math.min(slot * 0.68, 34));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const parts: string[] = [];
  parts.push(`<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(opts.title)}" xmlns="http://www.w3.org/2000/svg">`);
  for (let t = 0; t <= max; t += step) {
    const ty = y(t);
    parts.push(`<line x1="${left}" x2="${width - right}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${t === 0 ? C.ink : C.rule}" stroke-width="${t === 0 ? 0.8 : 0.5}"/>`);
    parts.push(`<text x="${left - 5}" y="${(ty + 3).toFixed(1)}" text-anchor="end" class="ax">${num(t)}</text>`);
  }
  const every = opts.labelEvery ?? 1;
  bars.forEach((b, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    const cx = x + barW / 2;
    if (b.state === 'future') {
      parts.push(`<rect x="${x.toFixed(1)}" y="${(top + plotH - 6).toFixed(1)}" width="${barW.toFixed(1)}" height="6" fill="none" stroke="${C.steel}" stroke-width="0.6" stroke-dasharray="2 1.5"/>`);
    } else if (b.state === 'before_records') {
      parts.push(`<rect x="${x.toFixed(1)}" y="${(top + plotH - 6).toFixed(1)}" width="${barW.toFixed(1)}" height="6" fill="#E3D9C3" stroke="#B9AE96" stroke-width="0.5" stroke-dasharray="1 1"/>`);
    } else if (b.value > 0) {
      const fill = b.muted ? C.forestSoft : b.highlight ? C.ember : C.forest2;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y(b.value).toFixed(1)}" width="${barW.toFixed(1)}" height="${(top + plotH - y(b.value)).toFixed(1)}" fill="${fill}"${b.state === 'partial' ? ` stroke="${C.ember}" stroke-width="0.9"` : ''}/>`);
      if (b.inner !== undefined && b.inner > 0 && !b.muted) {
        const iw = barW * 0.42;
        parts.push(`<rect x="${(cx - iw / 2).toFixed(1)}" y="${y(b.inner).toFixed(1)}" width="${iw.toFixed(1)}" height="${(top + plotH - y(b.inner)).toFixed(1)}" fill="${C.forest}" opacity="0.95"/>`);
        parts.push(`<rect x="${(cx - iw / 2).toFixed(1)}" y="${y(b.inner).toFixed(1)}" width="${iw.toFixed(1)}" height="1" fill="${C.bone}"/>`);
      }
      if (opts.showValues) parts.push(`<text x="${cx.toFixed(1)}" y="${(y(b.value) - 3).toFixed(1)}" text-anchor="middle" class="val">${num(b.value)}</text>`);
    } else if (opts.showValues) {
      parts.push(`<text x="${cx.toFixed(1)}" y="${(top + plotH - 3).toFixed(1)}" text-anchor="middle" class="val">0</text>`);
    }
    if (i % every === 0) parts.push(`<text x="${cx.toFixed(1)}" y="${height - 6}" text-anchor="middle" class="ax">${esc(b.label)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** Legend chips for a bar chart. */
export function legend(items: Array<{ label: string; color: string; dashed?: boolean; outline?: string }>): string {
  return `<div class="legend">${items.map((i) => `<span><i style="background:${i.dashed ? 'transparent' : i.color};${i.dashed ? `border:1px dashed ${i.color};` : ''}${i.outline ? `outline:1px solid ${i.outline};` : ''}"></i>${esc(i.label)}</span>`).join('')}</div>`;
}

/**
 * Calendar heat map: one column per week (Monday first), one row per weekday.
 * Future days are outlined, days before records are hatched, zero days pale.
 */
export function calendarHeatmap(days: DailyRow[], metric: (d: DailyRow) => number, width: number): string {
  if (days.length === 0) return '';
  const first = days[0];
  const offset = first.weekday; // blank cells before Jan 1
  const cols = Math.ceil((days.length + offset) / 7);
  const left = 26;
  const top = 14;
  const cell = Math.min(11.5, (width - left - 4) / cols);
  const gap = 1.6;
  const height = top + 7 * cell + 4;
  const max = Math.max(1, ...days.map(metric));
  const shades = ['#E3D9C3', '#C5D0BD', '#97B09E', '#5E8570', '#2C5A40', '#1E4230'];
  const shade = (v: number) => (v <= 0 ? shades[0] : shades[Math.min(5, 1 + Math.floor((v / max) * 4.999))]);
  const parts = [`<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Daily order rounds calendar" xmlns="http://www.w3.org/2000/svg">`,
    '<defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="#B9AE96" stroke-width="0.8"/></pattern></defs>'];
  ['Mon', 'Wed', 'Fri', 'Sun'].forEach((d, i) => {
    parts.push(`<text x="0" y="${(top + [0, 2, 4, 6][i] * cell + cell * 0.72).toFixed(1)}" class="ax">${d}</text>`);
  });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  days.forEach((d, i) => {
    const idx = i + offset;
    const col = Math.floor(idx / 7);
    const row = d.weekday;
    const x = left + col * cell;
    const yy = top + row * cell;
    // Month label above the first full week column of each month.
    if (d.date.endsWith('-01')) {
      const labelCol = row === 0 ? col : col + 1;
      parts.push(`<text x="${(left + labelCol * cell).toFixed(1)}" y="9" class="ax">${MON[Number(d.date.slice(5, 7)) - 1]}</text>`);
    }
    const w = (cell - gap).toFixed(1);
    if (d.state === 'future') {
      parts.push(`<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${w}" height="${w}" fill="none" stroke="${C.rule}" stroke-width="0.6"/>`);
    } else if (d.state === 'before_records') {
      parts.push(`<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${w}" height="${w}" fill="url(#hatch)"/>`);
    } else {
      parts.push(`<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${w}" height="${w}" fill="${shade(metric(d))}"${d.state === 'partial' ? ` stroke="${C.ember}" stroke-width="0.9"` : ''}/>`);
    }
  });
  parts.push('</svg>');
  const scale = `<div class="legend"><span>Fewer</span>${shades.map((s) => `<span><i style="background:${s}"></i></span>`).join('')}<span>More (max ${num(max)} per day)</span>`
    + `<span><i style="background:transparent;border:0.6px solid ${C.rule}"></i>Future</span><span><i class="hatch"></i>Before records</span></div>`;
  return parts.join('') + scale;
}

/** Funnel / proportion bars as HTML rows: label, bar, count and share of the first step. */
export function funnel(steps: Array<{ label: string; value: number }>): string {
  const base = steps[0]?.value ?? 0;
  const rows = steps.map((st, i) => {
    const w = base > 0 ? Math.min(100, (st.value / base) * 100) : 0;
    const share = i && base ? ` <small>${((st.value / base) * 100).toFixed(1)}%</small>` : '';
    return `<div>${esc(st.label)}</div><div class="track"><div class="fill${i === steps.length - 1 ? ' last' : ''}" style="width:${w.toFixed(2)}%"></div></div><div class="v">${num(st.value)}${share}</div>`;
  });
  return `<div class="funnel" role="img" aria-label="Engagement funnel">${rows.join('')}</div>`;
}

/** A single 100% stacked bar with a legend underneath. */
export function stackedBar(parts: Array<{ label: string; value: number; color: string }>, width: number): string {
  const total = parts.reduce((s, p) => s + p.value, 0);
  let x = 0;
  const rects = parts.filter((p) => p.value > 0).map((p) => {
    const w = total ? (p.value / total) * width : 0;
    const r = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="12" fill="${p.color}"/>`;
    x += w;
    return r;
  });
  const svg = `<svg class="chart" viewBox="0 0 ${width} 12" width="${width}" height="12" role="img" aria-label="Order round outcomes" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="12" fill="${C.paper2}"/>${rects.join('')}</svg>`;
  return svg + legend(parts.map((p) => ({ label: `${p.label} ${num(p.value)}${total ? ` (${((p.value / total) * 100).toFixed(1)}%)` : ''}`, color: p.color })));
}
