// Stream C2 hooks: live refetch that survives LiveProvider re-renders,
// access-loss handling, and the table's service requests.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GuestBillDTO, ServiceRequestDTO } from '../../../../shared/dto.ts';
import type { ServiceType } from '../../../../shared/status.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useLive, useResource, type Resource, type WireEvent } from '../../lib/live.tsx';
import { useGuestSession } from '../shell/session.tsx';
import { attemptKey, isAccessEnded, isAccessRequired, settleUnlessAmbiguous } from './lib.ts';

/**
 * Refetch on matching live events (debounced) and after every reconnect.
 * The debounce timer lives in a ref and is only cleared on unmount:
 * LiveProvider hands out a new `subscribe` on every event, so a timer owned
 * by the subscription effect would be cancelled by its own re-run.
 */
export function useLiveRefetch(
  prefixes: string[],
  refresh: () => unknown,
  opts: { debounceMs?: number; onEvent?: (e: WireEvent) => void; onResync?: () => void } = {},
): void {
  const live = useLive();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ refresh, opts });
  latest.current = { refresh, opts };
  const key = prefixes.join('|');

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    const schedule = (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void latest.current.refresh();
      }, ms);
    };
    const offEvent = live.subscribe(key.split('|'), (e) => {
      latest.current.opts.onEvent?.(e);
      schedule(latest.current.opts.debounceMs ?? 150);
    });
    const offResync = live.onResync(() => {
      latest.current.opts.onResync?.();
      schedule(0);
    });
    return () => { offEvent(); offResync(); };
  }, [live.subscribe, live.onResync, key]);
}

/**
 * A guest resource that refetches on the given topics and hands access loss
 * to the session (closed or revoked → ended page; expired → public).
 */
export function useVisitResource<T>(path: string | null, topics: string[], opts: { onEvent?: (e: WireEvent) => void; onResync?: () => void } = {}): Resource<T> {
  const r = useResource<T>(path);
  useLiveRefetch(topics, r.refresh, opts);
  useAccessGuard(r.error);
  return r;
}

/** Access errors from any guest request end the visit on this device. */
export function useAccessGuard(error: unknown): void {
  const { markEnded, refresh } = useGuestSession();
  useEffect(() => {
    if (isAccessEnded(error)) markEnded(error.code);
    else if (isAccessRequired(error)) void refresh();
  }, [error, markEnded, refresh]);
}

/** Call inside a catch: returns true when the failure was an access loss (already handled). */
export function useAccessFailure(): (err: unknown) => boolean {
  const { markEnded, refresh } = useGuestSession();
  return useCallback((err: unknown) => {
    if (isAccessEnded(err)) { markEnded(err.code); return true; }
    if (isAccessRequired(err)) { void refresh(); return true; }
    return false;
  }, [markEnded, refresh]);
}

// ------------------------------------------------------------------ service requests
const ACTIVE = new Set(['sent', 'acknowledged']);

export interface ServiceSlot {
  active: ServiceRequestDTO | null;
  lastDone: ServiceRequestDTO | null;
}

export interface SendResult {
  request: ServiceRequestDTO | null;
  /** The server returned a request that was already waiting. */
  existing: boolean;
}

export function useServiceRequests(visitId: string | null) {
  const r = useVisitResource<{ requests: ServiceRequestDTO[] }>(visitId ? '/api/guest/service' : null, ['service.', 'visit.']);
  const [busy, setBusy] = useState<ServiceType | null>(null);
  const failure = useAccessFailure();

  const slots = useMemo(() => {
    const map = new Map<ServiceType, ServiceSlot>();
    const list = [...(r.data?.requests ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    for (const req of list) {
      const slot = map.get(req.type) ?? { active: null, lastDone: null };
      if (ACTIVE.has(req.status) && !slot.active) slot.active = req;
      if (req.status === 'completed' && !slot.lastDone) slot.lastDone = req;
      map.set(req.type, slot);
    }
    return map;
  }, [r.data]);

  const upsert = useCallback((req: ServiceRequestDTO) => {
    r.mutate((prev) => {
      const list = prev?.requests ?? [];
      const rest = list.filter((x) => x.id !== req.id);
      return { requests: [req, ...rest] };
    });
  }, [r.mutate]);

  /** POST a request (dedupe server side). Throws ApiError on failure (access loss is handled first). */
  const send = useCallback(async (type: ServiceType, note?: string | null): Promise<SendResult> => {
    if (!visitId) throw new ApiError('visit_access_required', 401, 'no visit');
    const scope = `svc.${visitId}.${type}`;
    setBusy(type);
    try {
      if (type === 'bill') {
        const had = slots.get('bill')?.active ?? null;
        await api.post<GuestBillDTO>('/api/guest/bill/request', { idempotency_key: attemptKey(scope) });
        settleUnlessAmbiguous(scope, null);
        await r.refresh();
        return { request: null, existing: had !== null };
      }
      const body: Record<string, unknown> = { type, idempotency_key: attemptKey(scope) };
      if (note && note.trim()) body.note = note.trim();
      const had = slots.get(type)?.active ?? null;
      const req = await api.post<ServiceRequestDTO>('/api/guest/service', body);
      settleUnlessAmbiguous(scope, null);
      upsert(req);
      void r.refresh();
      return { request: req, existing: had !== null && had.id === req.id };
    } catch (err) {
      settleUnlessAmbiguous(scope, err);
      failure(err);
      throw err;
    } finally {
      setBusy(null);
    }
  }, [visitId, slots, upsert, r.refresh, failure]);

  return { ...r, slots, busy, send };
}

// ------------------------------------------------------------------ committed changes
const CATCH_UP_MS = 1_000;

/**
 * Tells whether a fetched payload was caused by a committed live event (as
 * opposed to a first load, a reconnect or a catch-up). Pass `onEvent` and
 * `onResync` to useVisitResource, then ask `committed(data)` while rendering.
 */
export function useCommitted(prefixes: string[]) {
  const lastEvent = useRef(0);
  const lastResync = useRef(0);
  const seen = useRef(new WeakMap<object, boolean>());
  const key = prefixes.join('|');
  const onEvent = useCallback((e: WireEvent) => {
    const now = performance.now();
    // After a reconnect the server replays what was missed straight after
    // 'hello': that burst is catch-up, not a change the guest just witnessed.
    if (now - lastResync.current < CATCH_UP_MS) return;
    if (key.split('|').some((p) => e.topic.startsWith(p))) lastEvent.current = now;
  }, [key]);
  const onResync = useCallback(() => { lastResync.current = performance.now(); }, []);
  const committed = useCallback((data: object | undefined | null): boolean => {
    if (!data) return false;
    if (!seen.current.has(data)) seen.current.set(data, lastEvent.current > lastResync.current);
    return seen.current.get(data) === true;
  }, []);
  return { onEvent, onResync, committed };
}
