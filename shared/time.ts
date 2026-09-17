// Reporting time. Storage is UTC ISO-8601 (`2026-09-17T12:34:56.789Z`).
// Reporting is Asia/Bangkok, which is UTC+7 all year (no daylight saving),
// so a fixed offset is exact. The business day starts at `cutoffHour` local
// time (default 00:00 - D-11); a business date is stamped on each record when
// it is written, so changing the cutoff affects future records only.

export const BANGKOK_OFFSET_MINUTES = 7 * 60;
export const TIMEZONE = 'Asia/Bangkok';

const DAY_MS = 86_400_000;

export function nowIso(): string {
  return new Date().toISOString();
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Local (Bangkok) wall-clock parts for a UTC instant. */
export function bangkokParts(input: string | Date | number) {
  const t = new Date(input).getTime() + BANGKOK_OFFSET_MINUTES * 60_000;
  const d = new Date(t);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

/** YYYY-MM-DD business date for an instant. */
export function businessDate(input: string | Date | number, cutoffHour = 0): string {
  const shifted = new Date(new Date(input).getTime() - cutoffHour * 3_600_000);
  const p = bangkokParts(shifted);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid date ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** 0 = Monday ... 6 = Sunday */
export function isoWeekday(date: string): number {
  return (new Date(parseDate(date)).getUTCDay() + 6) % 7;
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -isoWeekday(date));
}

/** The seven dates Monday..Sunday of the week containing `date`. */
export function weekDates(date: string): string[] {
  const start = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function monthDates(date: string): string[] {
  const start = monthStart(date);
  const [y, m] = start.split('-').map(Number);
  const next = formatDate(Date.UTC(y, m, 1));
  return Array.from({ length: daysBetween(start, next) }, (_, i) => addDays(start, i));
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * UTC half-open interval [start, end) covering local business dates
 * `from`..`to` inclusive.
 */
export function businessRangeUtc(from: string, to: string, cutoffHour = 0): { start: string; end: string } {
  const offset = BANGKOK_OFFSET_MINUTES * 60_000 - cutoffHour * 3_600_000;
  return {
    start: new Date(parseDate(from) - offset).toISOString(),
    end: new Date(parseDate(addDays(to, 1)) - offset).toISOString(),
  };
}

/** Calendar year as a half-open business-date range [Jan 1, next Jan 1). */
export function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Split a UTC interval at local business-day boundaries (for active-time chunks). */
export function splitByBusinessDay(startIso: string, endIso: string, cutoffHour = 0): Array<{ date: string; ms: number }> {
  const out: Array<{ date: string; ms: number }> = [];
  let cursor = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  while (cursor < end) {
    const date = businessDate(cursor, cutoffHour);
    const boundary = new Date(businessRangeUtc(date, date, cutoffHour).end).getTime();
    const stop = Math.min(boundary, end);
    out.push({ date, ms: stop - cursor });
    cursor = stop;
  }
  return out;
}

/** HH:MM in Bangkok. */
export function formatClock(input: string | Date | number): string {
  const p = bangkokParts(input);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
}

export function todayBusinessDate(cutoffHour = 0): string {
  return businessDate(Date.now(), cutoffHour);
}
