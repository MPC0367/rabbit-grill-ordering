// Helpers shared by the Tables and Billing screens (C5).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bilingual, StaffBillDTO } from '../../../../shared/dto.ts';
import { newIdempotencyKey } from '../../../../shared/ids.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useLive, useResource, type Resource } from '../../lib/live.tsx';
import { storage } from '../../lib/store.ts';
import type { Picked } from '../../lib/i18n.tsx';

export { useStaff } from '../shell/session.tsx';

type T = (key: string, vars?: Record<string, string | number>) => string;

// ------------------------------------------------------------------ plurals
/** `key` for counts other than 1, `${key}One` for exactly 1 (both exist in i18n/tables.ts). */
export function tn(t: T, key: string, n: number, vars: Record<string, string | number> = {}): string {
  return t(n === 1 ? `${key}One` : key, { n, ...vars });
}

// ------------------------------------------------------------------ errors
/** Translated words for an API failure (never a raw server message). */
export function errorText(t: T, err: unknown): string {
  if (err instanceof ApiError) {
    const key = `error.${err.code}`;
    const text = t(key);
    return text === key ? t('error.internal') : text;
  }
  return t('error.internal');
}

export function isApiError(err: unknown, ...codes: string[]): err is ApiError {
  return err instanceof ApiError && (codes.length === 0 || codes.includes(err.code));
}

/** The request may have reached the server: keep the idempotency key and let staff retry. */
export function isAmbiguous(err: unknown): boolean {
  return err instanceof ApiError && err.ambiguous;
}

// ------------------------------------------------------------------ idempotency keys
const KEY_PREFIX = 'rg.c5.key.';

/**
 * An idempotency key that survives reloads until the attempt is resolved.
 * `key()` returns the pending key for `scope` (creating it), `clear()` forgets it.
 * A key older than `maxAgeMs` is replaced: it belongs to an attempt nobody is retrying.
 */
export function pendingKey(scope: string, maxAgeMs = 30 * 60_000) {
  const k = KEY_PREFIX + scope;
  return {
    key(): string {
      const existing = storage.get<{ key: string; at: number } | null>(k, null);
      if (existing && typeof existing.key === 'string' && Date.now() - existing.at < maxAgeMs) return existing.key;
      const fresh = newIdempotencyKey();
      storage.set(k, { key: fresh, at: Date.now() });
      return fresh;
    },
    /** A pending attempt exists (a previous request may have reached the server). */
    pending(): boolean {
      const existing = storage.get<{ key: string; at: number } | null>(k, null);
      return Boolean(existing && Date.now() - existing.at < maxAgeMs);
    },
    clear(): void {
      storage.remove(k);
    },
  };
}

// ------------------------------------------------------------------ history
/**
 * Run `fn` once a closing kit overlay (Sheet / Dialog) has popped its history
 * entry. Those entries carry the kit's `__rgOverlay` mark and are removed with
 * an asynchronous history.back(); navigating before it lands would be undone.
 */
export function afterOverlaysClose(fn: () => void): void {
  setTimeout(() => {
    const st = window.history.state as Record<string, unknown> | null;
    if (!st || typeof st.__rgOverlay !== 'string') { fn(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', finish);
      clearTimeout(timer);
      setTimeout(fn, 0);
    };
    const timer = setTimeout(finish, 400);
    window.addEventListener('popstate', finish);
  }, 0);
}

// ------------------------------------------------------------------ names
/** Dish name with a visible marker when it fell back to the other language. */
export function dishName(pick: (b: Bilingual | null | undefined) => Picked, name: Bilingual, extra?: Array<string | null | undefined>): Picked & { marked: boolean } {
  const p = pick(name);
  const parts = [p.text, ...(extra ?? []).filter((x): x is string => Boolean(x))];
  return { ...p, text: parts.join(' · '), marked: p.fallback && p.text !== '' };
}

// ------------------------------------------------------------------ time
/** Compact seated time for tiles: "48 min", "1 h 04". */
export function seatedFor(t: T, fromIso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  if (mins < 1) return t('tables.dur.now');
  if (mins < 60) return t('tables.dur.min', { m: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return t('tables.dur.hm', { h, mm: String(m).padStart(2, '0') });
}

// ------------------------------------------------------------------ data
/**
 * Subscribe to live events without depending on the provider value's identity
 * (it changes on every event, which would cancel a pending debounced refresh).
 * `fn` runs debounced after a matching event (and after every reconnect).
 */
export function useLiveKick(prefixes: string[], fn: () => void, opts: { visitId?: string | null; debounceMs?: number; enabled?: boolean } = {}): void {
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = prefixes.join('|');
  const { visitId = null, debounceMs = 150, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fnRef.current(), debounceMs);
    };
    const l = liveRef.current;
    const off = l.subscribe(key.split('|'), (e) => {
      if (!visitId || e.visit_id === null || e.visit_id === visitId) kick();
    });
    const offResync = l.onResync(kick);
    return () => { off(); offResync(); if (timer) clearTimeout(timer); };
  }, [key, visitId, debounceMs, enabled]);
}

/** useResource plus a live refresh that only listens to one visit's events (or all when visitId is null). */
export function useLiveResource<V>(path: string | null, prefixes: string[], visitId: string | null = null): Resource<V> {
  const res = useResource<V>(path);
  useLiveKick(prefixes, () => void res.refresh(), { visitId, enabled: path !== null });
  return res;
}

export const VISIT_TOPICS = ['visit.', 'order.', 'line.', 'service.', 'portion.', 'bill.', 'payment.', 'table.'];
export const TABLE_TOPICS = ['table.', 'visit.', 'order.', 'line.', 'service.', 'portion.', 'bill.', 'payment.'];
export const BILL_TOPICS = ['bill.', 'payment.', 'line.', 'order.', 'visit.', 'settings.'];

/**
 * Staff bills for several visits at once (the Checking out tiles). Refetches
 * on bill, payment, line and visit events, debounced.
 */
export function useBills(visitIds: string[], enabled: boolean): Map<string, StaffBillDTO> {
  const [bills, setBills] = useState<Map<string, StaffBillDTO>>(() => new Map());
  const key = [...visitIds].sort().join(',');
  const seq = useRef(0);
  const load = useCallback(async () => {
    const ids = key ? key.split(',') : [];
    const my = ++seq.current;
    if (!enabled || ids.length === 0) { setBills(new Map()); return; }
    const pairs = await Promise.all(ids.map(async (id) => {
      try { return [id, await api.get<StaffBillDTO>(`/api/staff/visits/${encodeURIComponent(id)}/bill`)] as const; } catch { return null; }
    }));
    if (my !== seq.current) return;
    setBills((prev) => {
      const next = new Map<string, StaffBillDTO>();
      for (const id of ids) {
        const got = pairs.find((p) => p && p[0] === id);
        if (got) next.set(id, got[1]);
        else if (prev.has(id)) next.set(id, prev.get(id)!); // keep the last good bill on a failed refresh
      }
      return next;
    });
  }, [key, enabled]);
  useEffect(() => { void load(); }, [load]);
  useLiveKick(['bill.', 'payment.', 'line.', 'visit.', 'order.'], () => void load(), { debounceMs: 250, enabled });
  return bills;
}

/** Money typed by staff ("1,250.50", "1250") in integer satang, or null when not a valid amount. */
export function parseBaht(input: string): number | null {
  const s = input.replace(/[\s,฿]/g, '');
  if (s === '') return null;
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return whole * 100 + frac;
}

/** Satang as an editable baht string ("1250", "1250.50"). */
export function bahtInput(minor: number): string {
  const whole = Math.floor(Math.abs(minor) / 100);
  const frac = Math.abs(minor) % 100;
  return `${minor < 0 ? '-' : ''}${whole}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}
