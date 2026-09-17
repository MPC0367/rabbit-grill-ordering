// Display helpers for the insights screens: dates and ranges in both
// languages (Gregorian years, D-14), spoken dates, durations, weights and
// signed changes. Month and weekday words come from lib/format.ts (short)
// and Intl (long, spoken); digits stay Latin.
import type { Locale } from '../../../../shared/settings.ts';
import { dateLabel, monthLabel, num, weekdayShort } from '../../lib/format.ts';
import type { Range } from './query.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

function parts(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

/** "Mon 14" */
export function dayShort(date: string, lang: Locale): string {
  return `${weekdayShort(date, lang)} ${parts(date).d}`;
}

/** "Tue 15 Sep" */
export function dayMonth(date: string, lang: Locale, weekday = true): string {
  return dateLabel(date, lang, { weekday });
}

/** "15 Sep 2026" */
export function fullDate(date: string, lang: Locale): string {
  return dateLabel(date, lang, { year: true });
}

/** "Mon 14 – Sun 20 Sep 2026", "Mon 28 Sep – Sun 4 Oct 2026", "Mon 29 Dec 2025 – Sun 4 Jan 2026". */
export function rangeLabel(r: Range, lang: Locale, opts: { weekday?: boolean } = {}): string {
  const a = parts(r.from);
  const b = parts(r.to);
  const wd = opts.weekday ?? true;
  const right = dateLabel(r.to, lang, { weekday: wd, year: true });
  if (r.from === r.to) return right;
  const left = [
    wd ? weekdayShort(r.from, lang) : '',
    String(a.d),
    a.m !== b.m || a.y !== b.y ? monthLabel(a.m, lang) : '',
    a.y !== b.y ? String(a.y) : '',
  ].filter(Boolean).join(' ');
  return `${left} – ${right}`;
}

/** "1 – 17 Sep": a span inside one period without weekdays or year. */
export function spanLabel(from: string, to: string, lang: Locale): string {
  const a = parts(from);
  const b = parts(to);
  if (from === to) return dateLabel(to, lang);
  const left = a.m === b.m ? String(a.d) : dateLabel(from, lang);
  return `${left} – ${dateLabel(to, lang)}`;
}

/** "Mon–Thu" for a span inside one week. */
export function weekdaySpan(from: string, to: string, lang: Locale): string {
  return from === to ? weekdayShort(from, lang) : `${weekdayShort(from, lang)}–${weekdayShort(to, lang)}`;
}

const longFormats = new Map<string, Intl.DateTimeFormat>();
function longFormat(lang: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}:${JSON.stringify(opts)}`;
  let f = longFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(lang === 'th' ? 'th-TH-u-ca-gregory-nu-latn' : 'en-GB', { ...opts, timeZone: 'UTC' });
    longFormats.set(key, f);
  }
  return f;
}

function utc(date: string): Date {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d || 1));
}

/** "Monday 14 September 2026" (screen readers, table view). */
export function spokenDate(date: string, lang: Locale): string {
  return longFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(utc(date));
}

/** "September 2026" for YYYY-MM or a date. */
export function monthYear(dateOrMonth: string, lang: Locale): string {
  const d = utc(dateOrMonth.length === 7 ? `${dateOrMonth}-01` : dateOrMonth);
  const month = longFormat(lang, { month: 'long' }).format(d);
  return `${month} ${d.getUTCFullYear()}`;
}

/** "Sep" for YYYY-MM. */
export function monthShort(month: string, lang: Locale): string {
  return monthLabel(Number(month.slice(5, 7)), lang);
}

/** Minutes and seconds for a StatCard: [{n:'2',unit:'m'},{n:'10',unit:'s'}]. */
export function durationParts(ms: number | null, t: T): Array<{ n: string; unit?: string }> | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return [{ n: String(h), unit: t('insights.unit.h') }, { n: String(m), unit: t('insights.unit.m') }];
  if (m > 0) return [{ n: String(m), unit: t('insights.unit.m') }, { n: String(s), unit: t('insights.unit.s') }];
  return [{ n: String(s), unit: t('insights.unit.s') }];
}

/** "2 m 10 s" as one string. */
export function durationText(ms: number | null, t: T): string {
  const p = durationParts(ms, t);
  if (!p) return '—';
  return p.map((x) => `${x.n} ${x.unit ?? ''}`.trim()).join(' ');
}

/** "4.6 kg" above 1 kg, else "420 g". */
export function weightText(g: number | null | undefined, t: T): string {
  if (g === null || g === undefined) return '—';
  if (g >= 1000) return t('insights.unit.kgValue', { n: (Math.round(g / 100) / 10).toLocaleString('en-US') });
  return t('insights.unit.gValue', { n: num(g) });
}

/** "+7%", "−3.5%", "0%". */
export function signedPct(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '';
  const v = Math.round(percent * 10) / 10;
  if (v === 0) return '0%';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US')}%`;
}

/** "+11", "−3", "0". */
export function signed(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${num(Math.abs(n))}`;
}

/** 0.0552 → "5.5%"; small shares keep one decimal, larger ones none. */
export function share(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const p = ratio * 100;
  if (p > 0 && p < 10) return `${(Math.round(p * 10) / 10).toLocaleString('en-US')}%`;
  return `${Math.round(p)}%`;
}

/** n / d as a share text, or "—" without a denominator. */
export function ratioText(n: number, d: number): string {
  return d > 0 ? share(n / d) : '—';
}

/** Integer or 2-decimal number ("2.5"). */
export function decimal(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? num(n) : (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
