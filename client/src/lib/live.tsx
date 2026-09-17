// Live updates: one EventSource per interface (guest or staff), shared by all
// components through <LiveProvider>. Events only say "something changed";
// components refetch authoritative state with useResource().
//
//   <LiveProvider url="/api/staff/events"> ... </LiveProvider>
//   const { state } = useLive();                  // 'connecting' | 'live' | 'reconnecting' | 'offline' | 'ended'
//   const { transport } = useLive();              // 'stream' | 'poll': how updates arrive right now
//   const { outage } = useLive();                 // the server itself is not answering
//   useLiveEvent(['order.', 'line.'], (e) => ...); // topic prefixes
//   const orders = useResource('/api/staff/orders', { topics: ['order.', 'line.'] });
//
// The stream is the fast path; 5-second polling is the fallback. Polling keeps
// trying the stream again (a server restart that outlives four retries used to
// leave a page polling for good while reporting "Live"), and reports itself as
// `transport: 'poll'` so indicators can say what is really happening.
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

/** How updates are arriving: the event stream, or the 5-second poll fallback. */
export type LiveTransport = 'stream' | 'poll';

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

export interface LiveApi {
  state: LiveState;
  /** 'stream' while the EventSource is delivering, 'poll' while the fallback is. */
  transport: LiveTransport | null;
  /**
   * The restaurant system itself is not answering (this device's network is
   * up, but repeated reads failed or came back as a gateway error). Null once
   * anything answers again. Screens show the paper procedure while it is set.
   */
  outage: { since: number } | null;
  lastEventAt: number | null;
  lastSyncAt: number | null;
  subscribe: (prefixes: string[], fn: Handler) => () => void;
  onResync: (fn: ResyncHandler) => () => void;
}

const LiveContext = createContext<LiveApi>({
  state: 'offline',
  transport: null,
  outage: null,
  lastEventAt: null,
  lastSyncAt: null,
  subscribe: () => () => {},
  onResync: () => () => {},
});

const POLL_MS = 5000;
/** Named pings arrive about every 15 s; this much silence means the stream is dead. */
const SILENCE_MS = 45_000;
/** While polling, try the stream again this often (doubling up to STREAM_RETRY_MAX). */
const STREAM_RETRY_MS = 30_000;
const STREAM_RETRY_MAX = 120_000;
/** Reads that keep failing for this long, with the network up, are an outage. */
const OUTAGE_AFTER_MS = 8000;
/** A stream that ends with `access: ended` while /me still works is re-opened at most this often. */
const ENDED_RECHECK_MAX = 3;

interface HelloData { cursor: number; replay?: boolean; epoch?: string; ping_ms?: number }

export function LiveProvider({ url, children, onEnded }: { url: string | null; children: ReactNode; onEnded?: () => void }) {
  const [state, setState] = useState<LiveState>('connecting');
  const [transport, setTransport] = useState<LiveTransport | null>(null);
  const [outage, setOutage] = useState<{ since: number } | null>(null);
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
    // An event is proof of a working connection: a stale 'offline' (a browser
    // that reported a blip the stream survived) must not outlive it.
    setState((s) => (s === 'ended' ? s : 'live'));
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
    if (!url) { setState('offline'); setTransport(null); setOutage(null); return; }
    const staff = url.startsWith('/api/staff');
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const clearRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; };
    const clearSilence = () => { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = null; };
    const clearPoll = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; };
    // One poll loop at a time: the timer forgets itself as it fires, so the
    // poll it starts can schedule the next one.
    const schedulePoll = (ms = POLL_MS) => {
      if (disposed || parked) return;
      clearPoll();
      pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, ms);
    };
    let disposed = false;
    // A document leaving for the back/forward cache keeps its stream open
    // unless we close it, and browsers allow only six connections per host:
    // a few full navigations would then stall every request.
    let parked = false;
    // Bumped whenever the transport changes (a new stream, parking): a poll
    // answer that arrives after that belongs to the old transport and is dropped.
    let gen = 0;
    // Polling owns the updates; a stream opened while it runs is a "trial"
    // that only takes over once it says hello.
    let polling = false;
    let trial = false;
    let trialAt = 0;
    let trialBackoff = STREAM_RETRY_MS;
    let pollBusy = false;
    // The server sends named `ping` events; until one arrives (an older
    // server sends only SSE comments, which EventSource never shows to JS)
    // there is nothing to watch for, so the watchdog stays disarmed.
    let pingSeen = false;
    let silenceMs = SILENCE_MS;
    let downSince: number | null = null;
    let endedRechecks = 0;

    const markUp = () => { downSince = null; setOutage(null); };
    const markDown = () => {
      const now = Date.now();
      if (downSince === null) { downSince = now; return; }
      if (now - downSince >= OUTAGE_AFTER_MS) setOutage((o) => o ?? { since: downSince as number });
    };

    /** Restart the silence watchdog; called for every byte the stream delivers. */
    const heard = () => {
      clearSilence();
      if (!pingSeen || disposed || parked || !es) return;
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (disposed || parked || !es) return;
        // Open but silent (a half-open connection through a proxy): the
        // browser will never error, so drop it and reconnect ourselves.
        const dead = es;
        es = null;
        dead.close();
        failures++;
        if (!trial) setState(navigator.onLine ? 'reconnecting' : 'offline');
        trial = false;
        void poll();
        if (failures < 4) { clearRetry(); retryTimer = setTimeout(connect, 2000); }
        else startPolling();
      }, silenceMs);
    };

    const startPolling = () => {
      if (disposed || parked) return;
      polling = true;
      setTransport('poll');
      trialAt = Math.max(trialAt, Date.now() + STREAM_RETRY_MS);
      if (!pollTimer && !pollBusy) void poll();
      else if (!pollTimer) schedulePoll();
    };

    const endStream = () => {
      clearSilence();
      clearRetry();
      clearPoll();
      polling = false;
      trial = false;
      setState('ended');
      setTransport(null);
      setOutage(null);
      endedRef.current?.();
    };

    /**
     * A staff stream that ends re-checks the session itself: the server also
     * ends a stream whose permissions changed under it, and a signed-in
     * person must not be left staring at "Connection ended".
     */
    const recheckStaffSession = async () => {
      const mine = gen;
      try {
        await api.get('/api/staff/auth/me');
        if (disposed || parked || mine !== gen) return;
        if (endedRechecks >= ENDED_RECHECK_MAX) { endStream(); return; }
        endedRechecks++;
        failures = 0;
        clearRetry();
        retryTimer = setTimeout(connect, 2000);
        setState('reconnecting');
      } catch (err) {
        if (disposed || mine !== gen) return;
        const gone = err instanceof ApiError && (err.status === 401 || err.status === 403 || err.code === 'auth_required' || err.code === 'forbidden');
        if (gone) { endStream(); return; }
        // The server is unreachable rather than the session gone: keep trying.
        markDown();
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        startPolling();
      }
    };

    const poll = async () => {
      if (disposed || parked || pollBusy) return;
      pollBusy = true;
      const mine = gen;
      const since = book.current.cursor;
      let again = true;
      try {
        const r = await api.get<{ cursor: number; events: WireEvent[]; resync: boolean; epoch?: string }>(`${url}/poll?since=${since}`);
        if (mine !== gen || disposed) return;
        // A cursor below ours means the server's history restarted (restore):
        // follow it and forget old ids, or this would resync on every poll.
        // `resync` answers are authoritative either way: take the cursor.
        const reset = syncCursor(book.current, { cursor: r.cursor, since, epoch: r.epoch, authoritative: r.resync });
        if (r.resync || reset) resync(reset);
        r.events.forEach(dispatch);
        markUp();
        setState('live');
        // An answered poll is a confirmed sync even when nothing changed, so
        // the "synced 19:52" beside the state keeps up with the 5-second loop.
        setLastSyncAt(Date.now());
        if (!es || trial) setTransport('poll');
      } catch (err) {
        if (mine !== gen || disposed) return;
        if (err instanceof ApiError && (err.code === 'visit_closed' || err.code === 'visit_access_revoked' || err.code === 'visit_access_required')) {
          endStream();
          again = false;
          return;
        }
        if (staff && err instanceof ApiError && (err.status === 401 || err.code === 'auth_required')) {
          endStream();
          again = false;
          return;
        }
        // A read that failed for want of a server, with this device online,
        // is the restaurant system being down - say so rather than blaming
        // the network (the shell then shows the paper procedure).
        if (navigator.onLine && (!(err instanceof ApiError) || err.ambiguous || err.status >= 500)) markDown();
        setState(navigator.onLine ? 'reconnecting' : 'offline');
      } finally {
        pollBusy = false;
        if (!disposed && !parked && mine === gen && again) {
          // Polling with no stream: try the fast path again from time to time.
          if (polling && !es && typeof EventSource !== 'undefined' && Date.now() >= trialAt) openStream(true);
          if (polling || !es) schedulePoll();
        }
      }
    };

    function openStream(keepPolling: boolean) {
      if (disposed || parked || typeof EventSource === 'undefined') return;
      if (!keepPolling) {
        gen++;
        clearPoll();
        polling = false;
      }
      clearSilence();
      trial = keepPolling;
      pingSeen = false;
      retryTimer = null;
      const source = new EventSource(url!, { withCredentials: true });
      es = source;
      source.addEventListener('hello', (ev) => {
        if (es !== source) return;
        failures = 0;
        trial = false;
        polling = false;
        trialBackoff = STREAM_RETRY_MS;
        // The stream has taken over: drop any poll answer still in flight.
        gen++;
        clearPoll();
        let data: HelloData = { cursor: 0 };
        try { data = JSON.parse((ev as MessageEvent).data) as HelloData; } catch { /* refetch anyway */ }
        if (typeof data.ping_ms === 'number' && data.ping_ms > 0) {
          pingSeen = true;
          silenceMs = Math.max(SILENCE_MS, data.ping_ms * 3);
        }
        heard();
        // A replaying hello carries our own Last-Event-ID; a lower cursor
        // without a replay means the server started from its (restored)
        // newest event instead. Either way the server's cursor is where this
        // page now stands, so it is taken as it is.
        const reset = syncCursor(book.current, { cursor: data.cursor, epoch: data.epoch, authoritative: true, replay: data.replay });
        markUp();
        setTransport('stream');
        setState('live');
        resync(reset); // always refetch after (re)connecting: events may have been missed
      });
      // Named heartbeat: an SSE comment (`: keep-alive`) never reaches JS, so
      // only a named event can tell a working stream from a silent one.
      source.addEventListener('ping', () => {
        if (es !== source) return;
        pingSeen = true;
        heard();
        markUp();
        setState((s) => (s === 'ended' ? s : 'live'));
      });
      source.addEventListener('resync', (ev) => {
        if (es !== source) return;
        heard();
        let reset = false;
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { cursor?: number; epoch?: string };
          if (typeof data.cursor === 'number') reset = syncCursor(book.current, { cursor: data.cursor, epoch: data.epoch, authoritative: true });
        } catch { /* no body: refetch anyway */ }
        resync(reset);
      });
      source.addEventListener('change', (ev) => {
        if (es !== source) return;
        heard();
        if (trial) { trial = false; polling = false; clearPoll(); setTransport('stream'); }
        dispatch(JSON.parse((ev as MessageEvent).data) as WireEvent);
      });
      source.addEventListener('access', (ev) => {
        if (es !== source) return;
        heard();
        let access: { state?: string } = {};
        try { access = JSON.parse((ev as MessageEvent).data) as { state?: string }; } catch { /* treat as ended */ }
        es = null;
        source.close();
        clearSilence();
        if (access.state === 'changed') {
          // Still signed in with other permissions: reconnect for the new
          // topic filter (the old stream would never send those topics again).
          failures = 0;
          clearRetry();
          setState('reconnecting');
          retryTimer = setTimeout(connect, 300);
          return;
        }
        if (staff) { void recheckStaffSession(); return; }
        endStream();
      });
      source.onerror = () => {
        if (es !== source || disposed || parked) return;
        clearSilence();
        failures++;
        if (trial) {
          // A trial stream while polling: keep polling and back off.
          es = null;
          source.close();
          trial = false;
          trialBackoff = Math.min(trialBackoff * 2, STREAM_RETRY_MAX);
          trialAt = Date.now() + trialBackoff;
          return;
        }
        setState(navigator.onLine ? 'reconnecting' : 'offline');
        // A non-200 answer (a proxy's 502 while the server restarts, an expired
        // session) closes an EventSource for good: the browser never retries it.
        const closed = source.readyState === EventSource.CLOSED;
        // Even while the browser retries by itself, one read says whether the
        // server is there at all (and ends the stream when access is gone).
        if (failures === 1 && !pollTimer) void poll();
        if (failures >= 4 || closed) {
          es = null;
          source.close();
          startPolling();
          // Try streaming again (2 s, 4 s, 8 s); from the fourth failure the
          // poll loop retries it on its own, slower, schedule.
          if (failures < 4) { clearRetry(); retryTimer = setTimeout(connect, 1000 * 2 ** failures); }
        }
      };
    }

    function connect() {
      if (disposed || parked) return;
      retryTimer = null;
      if (typeof EventSource === 'undefined' || failures >= 4) {
        // Streaming unavailable (proxy, old browser): fall back to polling.
        startPolling();
        return;
      }
      openStream(false);
    }

    connect();
    const online = () => {
      if (disposed || parked) return;
      if (es && es.readyState === EventSource.OPEN) {
        // A stream that survived the blip never says hello again: take the
        // state back from 'offline' and refetch what the blip may have cost.
        markUp();
        setState('live');
        if (!trial) setTransport('stream');
        resync();
        return;
      }
      if (es && es.readyState === EventSource.CONNECTING) { setState('reconnecting'); return; }
      // No stream: check now instead of waiting for the timer, and let the
      // next poll answer try the stream again immediately.
      failures = 0;
      trialAt = 0;
      trialBackoff = STREAM_RETRY_MS;
      clearRetry();
      clearPoll();
      if (polling) void poll();
      else connect();
    };
    const offline = () => setState('offline');
    const visible = () => { if (document.visibilityState === 'visible') resync(); };
    const park = () => {
      parked = true;
      gen++;
      es?.close();
      es = null;
      clearPoll();
      clearRetry();
      clearSilence();
    };
    const unpark = (e: PageTransitionEvent) => {
      if (!e.persisted || !parked) return;
      parked = false;
      failures = 0;
      polling = false;
      trial = false;
      trialAt = 0;
      trialBackoff = STREAM_RETRY_MS;
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
      clearPoll();
      clearRetry();
      clearSilence();
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
    () => ({ state, transport, outage, lastEventAt, lastSyncAt, subscribe, onResync }),
    [state, transport, outage, lastEventAt, lastSyncAt, subscribe, onResync],
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
