// Live updates: one EventSource per interface (guest or staff), shared by all
// components through <LiveProvider>. Events only say "something changed";
// components refetch authoritative state with useResource().
//
//   <LiveProvider url="/api/staff/events"> ... </LiveProvider>
//   const { state } = useLive();                  // 'connecting' | 'live' | 'reconnecting' | 'offline' | 'ended'
//   useLiveEvent(['order.', 'line.'], (e) => ...); // topic prefixes
//   const orders = useResource('/api/staff/orders', { topics: ['order.', 'line.'] });
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';

export interface WireEvent {
  id: number;
  topic: string;
  visit_id: string | null;
  entity: { type: string | null; id: string | null; version: number | null };
  payload: Record<string, unknown>;
  at: string;
}

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'ended';

type Handler = (e: WireEvent) => void;
type ResyncHandler = () => void;

interface LiveApi {
  state: LiveState;
  lastEventAt: number | null;
  lastSyncAt: number | null;
  subscribe: (prefixes: string[], fn: Handler) => () => void;
  onResync: (fn: ResyncHandler) => () => void;
}

const LiveContext = createContext<LiveApi>({
  state: 'offline',
  lastEventAt: null,
  lastSyncAt: null,
  subscribe: () => () => {},
  onResync: () => () => {},
});

const POLL_MS = 5000;

export function LiveProvider({ url, children, onEnded }: { url: string | null; children: ReactNode; onEnded?: () => void }) {
  const [state, setState] = useState<LiveState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const handlers = useRef(new Set<{ prefixes: string[]; fn: Handler }>());
  const resyncers = useRef(new Set<ResyncHandler>());
  const seen = useRef(new Set<number>());
  const cursor = useRef(0);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  const dispatch = useCallback((e: WireEvent) => {
    if (seen.current.has(e.id)) return; // duplicate delivery
    seen.current.add(e.id);
    if (seen.current.size > 2000) seen.current = new Set([...seen.current].slice(-1000));
    cursor.current = Math.max(cursor.current, e.id);
    setLastEventAt(Date.now());
    for (const h of handlers.current) {
      if (h.prefixes.some((p) => e.topic.startsWith(p))) {
        try { h.fn(e); } catch (err) { console.error(err); }
      }
    }
  }, []);

  const resync = useCallback(() => {
    setLastSyncAt(Date.now());
    for (const fn of resyncers.current) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }, []);

  useEffect(() => {
    if (!url) { setState('offline'); return; }
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let disposed = false;

    const poll = async () => {
      if (disposed) return;
      try {
        const r = await api.get<{ cursor: number; events: WireEvent[]; resync: boolean }>(`${url}/poll?since=${cursor.current}`);
        if (r.resync) resync();
        r.events.forEach(dispatch);
        cursor.current = Math.max(cursor.current, r.cursor);
        setState('live');
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'visit_closed' || err.code === 'visit_access_revoked' || err.code === 'visit_access_required')) {
          setState('ended');
          endedRef.current?.();
          return;
        }
        setState(navigator.onLine ? 'reconnecting' : 'offline');
      }
      pollTimer = setTimeout(poll, POLL_MS);
    };

    const connect = () => {
      if (disposed) return;
      if (typeof EventSource === 'undefined' || failures >= 4) {
        // Streaming unavailable (proxy, old browser): fall back to polling.
        void poll();
        return;
      }
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener('hello', (ev) => {
        failures = 0;
        const data = JSON.parse((ev as MessageEvent).data) as { cursor: number };
        cursor.current = Math.max(cursor.current, data.cursor);
        setState('live');
        resync(); // always refetch after (re)connecting: events may have been missed
      });
      es.addEventListener('resync', () => resync());
      es.addEventListener('change', (ev) => dispatch(JSON.parse((ev as MessageEvent).data) as WireEvent));
      es.addEventListener('access', () => {
        setState('ended');
        es?.close();
        endedRef.current?.();
      });
      es.onerror = () => {
        failures++;
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        if (failures >= 4) {
          es?.close();
          // Check whether access ended before falling back to polling.
          void poll();
        }
      };
    };

    connect();
    const online = () => { if (failures >= 4) { failures = 0; if (pollTimer) clearTimeout(pollTimer); connect(); } };
    const offline = () => setState('offline');
    const visible = () => { if (document.visibilityState === 'visible') resync(); };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [url, dispatch, resync]);

  const value = useMemo<LiveApi>(() => ({
    state,
    lastEventAt,
    lastSyncAt,
    subscribe: (prefixes, fn) => {
      const h = { prefixes, fn };
      handlers.current.add(h);
      return () => { handlers.current.delete(h); };
    },
    onResync: (fn) => {
      resyncers.current.add(fn);
      return () => { resyncers.current.delete(fn); };
    },
  }), [state, lastEventAt, lastSyncAt]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveApi {
  return useContext(LiveContext);
}

export function useLiveEvent(prefixes: string[], fn: Handler): void {
  const live = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  const key = prefixes.join('|');
  useEffect(() => live.subscribe(key.split('|'), (e) => ref.current(e)), [live.subscribe, key]);
}

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  /** Last fetch failed but older data is still shown. */
  stale: boolean;
  refresh: () => Promise<void>;
  mutate: (next: T | ((prev: T | undefined) => T)) => void;
  fetchedAt: number | null;
}

/**
 * Fetch JSON and keep it fresh: refetches when a matching live event arrives
 * (debounced), after every reconnect, and when `path` changes.
 * Pass `path = null` to pause.
 */
export function useResource<T>(path: string | null, opts: { topics?: string[]; debounceMs?: number; intervalMs?: number } = {}): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const live = useLive();
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.get<T>(path);
      if (my !== seq.current) return;
      setData(r);
      setError(null);
      setFetchedAt(Date.now());
    } catch (err) {
      if (my !== seq.current) return;
      setError(err instanceof ApiError ? err : new ApiError('internal', 0, String(err)));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setData(undefined);
    setError(null);
    void refresh();
  }, [refresh]);

  const topicsKey = (opts.topics ?? []).join('|');
  useEffect(() => {
    if (!path || !topicsKey) return;
    const debounce = opts.debounceMs ?? 150;
    const offEvent = live.subscribe(topicsKey.split('|'), () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), debounce);
    });
    const offResync = live.onResync(() => void refresh());
    return () => { offEvent(); offResync(); if (timer.current) clearTimeout(timer.current); };
  }, [path, topicsKey, live.subscribe, live.onResync, refresh, opts.debounceMs]);

  useEffect(() => {
    if (!path || !opts.intervalMs) return;
    const t = setInterval(() => void refresh(), opts.intervalMs);
    return () => clearInterval(t);
  }, [path, opts.intervalMs, refresh]);

  const mutate = useCallback((next: T | ((prev: T | undefined) => T)) => {
    setData((prev) => (typeof next === 'function' ? (next as (p: T | undefined) => T)(prev) : next));
  }, []);

  return { data, error, loading, stale: Boolean(error && data !== undefined), refresh, mutate, fetchedAt };
}
