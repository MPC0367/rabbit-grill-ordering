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
import { acceptEvent, createLiveCursor, syncCursor } from './live-cursor.ts';

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

export interface ResyncInfo {
  /**
   * The server's event history restarted (database restore or reset): event
   * ids below the old cursor are being reused. Anything that remembers event
   * ids (an alert floor) should restart from `cursor`.
   */
  reset: boolean;
  /** The event cursor after this resync. */
  cursor: number;
}
type ResyncHandler = (info: ResyncInfo) => void;

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
  const book = useRef(createLiveCursor());
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  const dispatch = useCallback((e: WireEvent) => {
    if (!acceptEvent(book.current, e.id)) return; // duplicate delivery
    setLastEventAt(Date.now());
    for (const h of handlers.current) {
      if (h.prefixes.some((p) => e.topic.startsWith(p))) {
        try { h.fn(e); } catch (err) { console.error(err); }
      }
    }
  }, []);

  const resync = useCallback((reset = false) => {
    setLastSyncAt(Date.now());
    const info: ResyncInfo = { reset, cursor: book.current.cursor };
    for (const fn of resyncers.current) {
      try { fn(info); } catch (err) { console.error(err); }
    }
  }, []);

  useEffect(() => {
    if (!url) { setState('offline'); return; }
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const clearRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; };
    let disposed = false;
    // A document leaving for the back/forward cache keeps its stream open
    // unless we close it, and browsers allow only six connections per host:
    // a few full navigations would then stall every request.
    let parked = false;
    // Bumped whenever the transport changes (a new stream, parking): a poll
    // answer that arrives after that belongs to the old transport and is dropped.
    let gen = 0;

    const poll = async () => {
      if (disposed || parked) return;
      const mine = gen;
      const since = book.current.cursor;
      try {
        const r = await api.get<{ cursor: number; events: WireEvent[]; resync: boolean; epoch?: string }>(`${url}/poll?since=${since}`);
        if (mine !== gen || disposed) return;
        // A cursor below ours means the server's history restarted (restore):
        // follow it and forget old ids, or this would resync on every poll.
        const reset = syncCursor(book.current, { cursor: r.cursor, since, epoch: r.epoch });
        if (r.resync || reset) resync(reset);
        r.events.forEach(dispatch);
        setState('live');
      } catch (err) {
        if (mine !== gen || disposed) return;
        if (err instanceof ApiError && (err.code === 'visit_closed' || err.code === 'visit_access_revoked' || err.code === 'visit_access_required')) {
          clearRetry();
          setState('ended');
          endedRef.current?.();
          return;
        }
        setState(navigator.onLine ? 'reconnecting' : 'offline');
      }
      if (disposed || parked || mine !== gen) return;
      pollTimer = setTimeout(poll, POLL_MS);
    };

    const connect = () => {
      if (disposed || parked) return;
      gen++;
      retryTimer = null;
      // One transport at a time: a poll scheduled while the stream was down stops here.
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (typeof EventSource === 'undefined' || failures >= 4) {
        // Streaming unavailable (proxy, old browser): fall back to polling.
        void poll();
        return;
      }
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener('hello', (ev) => {
        failures = 0;
        const data = JSON.parse((ev as MessageEvent).data) as { cursor: number; replay?: boolean; epoch?: string };
        // A replaying hello carries our own Last-Event-ID; a lower cursor
        // means the server started from its (restored) newest event instead.
        const reset = syncCursor(book.current, { cursor: data.cursor, epoch: data.epoch });
        setState('live');
        resync(reset); // always refetch after (re)connecting: events may have been missed
      });
      es.addEventListener('resync', (ev) => {
        let reset = false;
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { cursor?: number; epoch?: string };
          if (typeof data.cursor === 'number') reset = syncCursor(book.current, { cursor: data.cursor, epoch: data.epoch });
        } catch { /* no body: refetch anyway */ }
        resync(reset);
      });
      es.addEventListener('change', (ev) => dispatch(JSON.parse((ev as MessageEvent).data) as WireEvent));
      es.addEventListener('access', () => {
        setState('ended');
        es?.close();
        endedRef.current?.();
      });
      es.onerror = () => {
        failures++;
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        // A non-200 answer (a proxy's 502 while the server restarts, an expired
        // session) closes an EventSource for good: the browser never retries it.
        const closed = es?.readyState === EventSource.CLOSED;
        if (failures >= 4 || closed) {
          es?.close();
          es = null;
          // Check whether access ended before falling back to polling.
          void poll();
          // Try streaming again (2 s, 4 s, 8 s); the fourth failure stays on polling.
          if (failures < 4) { clearRetry(); retryTimer = setTimeout(connect, 1000 * 2 ** failures); }
        }
      };
    };

    connect();
    const online = () => {
      if (disposed || parked) return;
      if (failures >= 4) { failures = 0; if (pollTimer) clearTimeout(pollTimer); connect(); return; }
      if (!es) {
        // Polling without a stream: check now instead of waiting for the timer.
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; void poll(); }
        return;
      }
      // A stream that survived the blip never says hello again: take the
      // state back from 'offline' (it reports 'reconnecting' if it did drop).
      setState(es.readyState === EventSource.OPEN ? 'live' : 'reconnecting');
    };
    const offline = () => setState('offline');
    const visible = () => { if (document.visibilityState === 'visible') resync(); };
    const park = () => {
      parked = true;
      gen++;
      es?.close();
      es = null;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      clearRetry();
    };
    const unpark = (e: PageTransitionEvent) => {
      if (!e.persisted || !parked) return;
      parked = false;
      failures = 0;
      setState('reconnecting');
      connect(); // 'hello' triggers a resync
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    window.addEventListener('pagehide', park);
    window.addEventListener('pageshow', unpark);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
      clearRetry();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('pagehide', park);
      window.removeEventListener('pageshow', unpark);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [url, dispatch, resync]);

  // subscribe/onResync must keep their identity across events: consumers list
  // them as effect dependencies, and a new identity on every event would re-run
  // those effects and cancel the debounced refetch the event had just scheduled.
  const subscribe = useCallback((prefixes: string[], fn: Handler) => {
    const h = { prefixes, fn };
    handlers.current.add(h);
    return () => { handlers.current.delete(h); };
  }, []);
  const onResync = useCallback((fn: ResyncHandler) => {
    resyncers.current.add(fn);
    return () => { resyncers.current.delete(fn); };
  }, []);

  const value = useMemo<LiveApi>(
    () => ({ state, lastEventAt, lastSyncAt, subscribe, onResync }),
    [state, lastEventAt, lastSyncAt, subscribe, onResync],
  );

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
