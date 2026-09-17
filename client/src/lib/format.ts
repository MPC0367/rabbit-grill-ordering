// Display formatting. Times are shown in Asia/Bangkok regardless of the
// device timezone; digits are Latin in both languages.
import { formatMoney } from '../../../shared/money.ts';
import { bangkokParts, formatClock } from '../../../shared/time.ts';
import type { Locale } from '../../../shared/settings.ts';

export const money = formatMoney;
export const clock = formatClock;

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "17 ก.ย. 2026" / "17 Sep 2026" for a YYYY-MM-DD business date. Gregorian years in both (D-14). */
export function dateLabel(date: string, lang: Locale, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const months = lang === 'th' ? TH_MONTHS : EN_MONTHS;
  const days = lang === 'th' ? TH_DAYS : EN_DAYS;
  const parts = [opts.weekday ? `${days[wd]}` : '', `${d} ${months[m - 1]}`, opts.year ? String(y) : ''].filter(Boolean);
  return parts.join(' ');
}

export function weekdayShort(date: string, lang: Locale): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (lang === 'th' ? TH_DAYS : EN_DAYS)[wd];
}

export function monthLabel(month: number, lang: Locale): string {
  return (lang === 'th' ? TH_MONTHS : EN_MONTHS)[month - 1];
}

/** Timestamp → "17 Sep, 19:42" in Bangkok time. */
export function dateTime(iso: string, lang: Locale): string {
  const p = bangkokParts(iso);
  const months = lang === 'th' ? TH_MONTHS : EN_MONTHS;
  return `${p.day} ${months[p.month - 1]}, ${clock(iso)}`;
}

/** Elapsed minutes as a compact label: "now", "4 min", "1 h 12". */
export function elapsed(fromIso: string, now: number, lang: Locale): string {
  const mins = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  if (mins < 1) return lang === 'th' ? 'เมื่อสักครู่' : 'just now';
  if (mins < 60) return lang === 'th' ? `${mins} นาที` : `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return lang === 'th' ? `${h} ชม. ${m} นาที` : `${h} h ${m} min`;
}

export function durationMs(ms: number | null, lang: Locale): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return lang === 'th' ? `${s} วินาที` : `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return lang === 'th' ? `${m} นาที ${r} วินาที` : `${m}m ${r}s`;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

export function pct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function grams(g: number | null | undefined, lang: Locale): string {
  if (g === null || g === undefined) return '—';
  return lang === 'th' ? `${g.toLocaleString('en-US')} กรัม` : `${g.toLocaleString('en-US')} g`;
}
