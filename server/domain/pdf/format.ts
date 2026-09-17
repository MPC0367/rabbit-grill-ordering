// Escaping and formatting for the report HTML. Every value that came from the
// database passes through esc() before it reaches the page.
import type { Bilingual } from '../../../shared/dto.ts';
import { formatMoney } from '../../../shared/money.ts';
import { bangkokParts } from '../../../shared/time.ts';
import type { Stat } from '../export/types.ts';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

export const DASH = '–';

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

export function money(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return DASH;
  return formatMoney(minor);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 2025-03-07 -> 7 March 2025 */
export function dateLong(d: string | null | undefined): string {
  if (!d) return DASH;
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

/** 2025-03-07 -> 7 Mar */
export function dateShort(d: string): string {
  return `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
}

export function monthName(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1];
}

export function monthShort(key: string): string {
  return MON[Number(key.slice(5, 7)) - 1];
}

/** UTC instant -> "7 Mar 2025, 19:42" in Bangkok time. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return DASH;
  const p = bangkokParts(iso);
  return `${p.day} ${MON[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** UTC instant -> "19:42" Bangkok. */
export function clock(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return DASH;
  const p = bangkokParts(iso);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** UTC instant -> "2025-03-07" Bangkok calendar date. */
export function localDate(iso: string): string {
  const p = bangkokParts(iso);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${Math.round(s / 60)} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function statCells(s: Stat, unit: 'seconds' | 'minutes' | 'ms'): string {
  const f = (v: number | null) => {
    if (v === null) return DASH;
    if (unit === 'minutes') return duration(v * 60);
    if (unit === 'ms') return duration(v / 1000);
    return duration(v);
  };
  return `<td class="n">${f(s.median)}</td><td class="n">${f(s.p90)}</td><td class="n">${num(s.sample)}</td>`;
}

export function grams(g: number | null | undefined): string {
  if (!g) return DASH;
  return g >= 10_000 ? `${(g / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kg` : `${num(g)} g`;
}

/** Thai and English name, each wrapped with its language. */
export function biName(b: Bilingual, primary: 'th' | 'en'): string {
  const first = primary === 'th' ? b.th : b.en;
  const second = primary === 'th' ? b.en : b.th;
  const firstLang = primary;
  const secondLang = primary === 'th' ? 'en' : 'th';
  if (!first && !second) return '';
  if (!first) return `<span lang="${secondLang}">${esc(second)}</span>`;
  if (!second || second === first) return `<span lang="${firstLang}">${esc(first)}</span>`;
  return `<span lang="${firstLang}">${esc(first)}</span><span class="alt" lang="${secondLang}">${esc(second)}</span>`;
}

export function oneName(b: Bilingual, primary: 'th' | 'en'): string {
  const v = primary === 'th' ? (b.th ?? b.en) : (b.en ?? b.th);
  return esc(v ?? '');
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  received: 'Received', confirmed: 'Confirmed', preparing: 'Preparing', almost_done: 'Almost done', ready: 'Ready',
  partially_served: 'Partly served', served: 'Served', rejected: 'Rejected', cancelled: 'Cancelled',
};

export const SOURCE_LABEL: Record<string, string> = {
  guest: 'Guest QR', staff: 'Staff-assisted', manual_recovery: 'Recovered paper', portion_quote: 'Portion quote',
};

export const SERVICE_LABEL: Record<string, string> = {
  call_staff: 'Call staff', water: 'Water', utensils: 'Utensils', bill: 'Request the bill',
  order_change: 'Change an order', allergy_help: 'Allergy help',
};

export const LINE_STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted', accepted: 'Accepted', preparing: 'Preparing', almost_done: 'Almost done', ready: 'Ready',
  served: 'Served', rejected: 'Rejected', cancelled: 'Cancelled', unknown: 'Unknown',
};
