// Small helpers shared by the Orders screens (board, requests, assisted ordering).
import type { Bilingual } from '../../../../shared/dto.ts';
import { bangkokParts, BANGKOK_OFFSET_MINUTES, businessDate } from '../../../../shared/time.ts';
import { ApiError } from '../../lib/api.ts';
import { storage } from '../../lib/store.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Waits longer than this (minutes) read "longer than usual". No owner setting exists yet (see final report). */
export const LATE_AFTER_MINUTES = 20;
/** A round this young (ms) carries the "Just in" flag. */
export const JUST_IN_MS = 2 * 60_000;
/** Safety refresh while live events are the main trigger. */
export const SAFETY_REFRESH_MS = 30_000;

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
}

/** Details the API attaches to validation errors, flattened to one readable line. */
function issueText(details: unknown): string | null {
  const issues = (details as { issues?: Array<{ path?: string; message?: string }> } | null)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return issues.map((i) => (i.path ? `${i.path}: ${i.message ?? ''}` : i.message ?? '')).filter(Boolean).join(' · ');
}

/** One translated sentence for an API error, with the useful details the API returns. */
export function errorText(t: T, err: unknown): string {
  const e = toApiError(err);
  const base = t(`error.${e.code}`);
  const d = (e.details ?? null) as Record<string, unknown> | null;
  if (e.code === 'forbidden') return t('orders.err.forbidden');
  if (e.code === 'conflict' && d?.reason === 'visit_closed') return t('orders.err.visitClosed');
  if (e.code === 'conflict' && d?.field === 'manual_reference') {
    return t('recover.err.referenceUsed', { reference: String(d.reference ?? '') });
  }
  if (e.code === 'bill_changed') return t('orders.err.billLocked');
  if (e.code === 'bad_request' && d?.reason === 'not_measured_weight') return t('assist.err.notMeasured');
  if (e.code === 'item_unavailable' && typeof d?.reason === 'string') return `${base} (${t(`assist.reason.${d.reason}`)})`;
  if (e.code === 'validation_failed') {
    const more = issueText(d);
    return more ? `${base} ${more}` : base;
  }
  return base;
}

/** The stale current state a 409 stale_version carries (an order, a list of orders or a request). */
export function staleCurrent<X>(err: unknown): X | null {
  const e = toApiError(err);
  if (e.code !== 'stale_version' && e.code !== 'already_done' && e.code !== 'invalid_transition' && e.code !== 'quote_expired' && e.code !== 'quote_superseded') return null;
  const cur = (e.details as { current?: unknown } | null)?.current;
  return (cur ?? null) as X | null;
}

export function sumQty(lines: ReadonlyArray<{ quantity: number }>): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}

export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** "48m", "1h 04" (compact floor tile) and the spoken form. */
export function seatedShort(iso: string, now: number): string {
  const m = minutesSince(iso, now);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}`;
}

export function seatedLong(t: T, iso: string, now: number): string {
  const m = minutesSince(iso, now);
  if (m < 60) return t('common.minutes', { n: m });
  return t('orders.time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

/** Thai name first on staff tickets; English when no Thai name is on file. */
export function staffName(b: Bilingual | null | undefined): { text: string; lang: 'th' | 'en'; secondary: string | null; noThai: boolean } {
  const th = b?.th?.trim() || null;
  const en = b?.en?.trim() || null;
  if (th) return { text: th, lang: 'th', secondary: en && en !== th ? en : null, noThai: false };
  return { text: en ?? '', lang: 'en', secondary: null, noThai: true };
}

/** Numeric-aware compare for table labels ("2" < "10"). */
export function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

// ------------------------------------------------------------------ Bangkok local time (datetime-local <-> ISO)
const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-09-17T19:42" in Bangkok wall time for an instant. */
export function bangkokLocalInput(ms: number): string {
  const p = bangkokParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Parse a Bangkok wall-clock "YYYY-MM-DDTHH:MM" into a UTC ISO instant (null when malformed). */
export function bangkokInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - BANGKOK_OFFSET_MINUTES * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function todayDate(): string {
  return businessDate(Date.now());
}

// ------------------------------------------------------------------ per-device preferences
const STATION_KEY = 'rg.orders.station';

export type StationPref = 'all' | 'kitchen' | 'bar';

export function readStation(): StationPref {
  const v = storage.get<string>(STATION_KEY, 'all');
  return v === 'kitchen' || v === 'bar' ? v : 'all';
}

export function writeStation(v: StationPref): void {
  storage.set(STATION_KEY, v);
}

/** Idempotency keys that must survive a reload until the request is resolved. */
export function pendingKey(scope: string, make: () => string): string {
  const k = `rg.orders.key.${scope}`;
  const existing = storage.get<string | null>(k, null);
  if (existing) return existing;
  const fresh = make();
  storage.set(k, fresh);
  return fresh;
}

export function clearPendingKey(scope: string): void {
  storage.remove(`rg.orders.key.${scope}`);
}

// ------------------------------------------------------------------ plurals
interface Plural { t: T; has: (key: string) => boolean }

/** `key.one` when n is 1 (English "1 dish"), else `key`; {n} is always passed. */
export function tn(i18n: Plural, key: string, n: number, vars: Record<string, string | number> = {}): string {
  const k = n === 1 && i18n.has(`${key}.one`) ? `${key}.one` : key;
  return i18n.t(k, { ...vars, n });
}
