// Small descriptive statistics used by the annual report.
import type { Stat } from './types.ts';

/**
 * Median (mean of the two middle values for an even sample, rounded to a whole
 * unit as on the dashboards) and p90 (nearest-rank: the smallest value with at
 * least 90% of the sample at or below it). Non-finite and negative values are
 * dropped: a negative interval means a clock or correction anomaly.
 */
export function statOf(values: number[]): Stat {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { median: null, p90: null, sample: 0 };
  const mid = Math.floor(n / 2);
  const median = Math.round(n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
  const p90 = v[Math.max(0, Math.ceil(0.9 * n) - 1)];
  return { median, p90, sample: n };
}

/** Seconds between two ISO instants, or null when either is missing. */
export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) ? s : null;
}

export function pushIf(list: number[], value: number | null): void {
  if (value !== null && Number.isFinite(value) && value >= 0) list.push(value);
}

export function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}
