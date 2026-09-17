// Small shell hooks: connectivity, guest routes, tracker wiring.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive, type LiveState } from '../../lib/live.tsx';
import {
  endVisit, setVisit, useInitTracker, useTrackRoute, type TrackRoute,
} from '../../lib/tracker.ts';
import { useCatalog } from './catalog.tsx';
import { useGuestSession } from './session.tsx';

// ---------------------------------------------------------------- connectivity
function subscribeOnline(fn: () => void) {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

/** navigator.onLine as a hook (true when unknown). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine !== false, () => true);
}

/**
 * The live state as guest screens should read it. LiveProvider says 'offline'
 * only from the browser's own offline signal, and it does not clear that when
 * the network returns unless its stream errors or says hello again, which a
 * stream that survived a short blip never does. So while the browser is
 * online, a leftover 'offline' counts as live: if the stream really died, its
 * next retry fails and the provider reports 'reconnecting' (DECISIONS D-G-04).
 */
export function useGuestLiveState(): LiveState {
  const online = useOnline();
  const { state } = useLive();
  return state === 'offline' && online ? 'live' : state;
}

/** A stream down for this long means the restaurant server is out of reach, not a blip. */
const LONG_OUTAGE_MS = 12_000;

/**
 * What the guest should be told about the connection:
 *  offline       the device has no network, or (joined) the live stream has been down for a while
 *  reconnecting  joined, network up, the stream is re-establishing (small chip, no banner)
 * LiveProvider keeps reporting 'offline' until its next retry even after the
 * network is back, so the network state decides between the two.
 */
export function useGuestConnection(joined: boolean): { offline: boolean; reconnecting: boolean } {
  const online = useOnline();
  const state = useGuestLiveState();
  // Before the first 'hello' the provider may still say 'offline' from the
  // time it had no url: only a failure it reported, or a drop after being live, counts.
  const [seenLive, setSeenLive] = useState(false);
  useEffect(() => {
    if (!joined) setSeenLive(false);
    else if (state === 'live') setSeenLive(true);
  }, [joined, state]);
  const down = joined && (state === 'reconnecting' || (seenLive && state !== 'live' && state !== 'ended'));
  const [since, setSince] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    setSince((s) => (down ? s ?? Date.now() : null));
  }, [down]);
  useEffect(() => {
    if (since === null) return;
    const wait = Math.max(0, since + LONG_OUTAGE_MS - Date.now()) + 50;
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [since]);
  const long = since !== null && Date.now() - since >= LONG_OUTAGE_MS;
  return { offline: !online || long, reconnecting: online && down && !long };
}

// ---------------------------------------------------------------- routes
export type GuestRouteKey = 'root' | 'menu' | 'cart' | 'track' | 'bill' | 'join' | 'notFound';

export interface GuestRoute {
  key: GuestRouteKey;
  token?: string;
}

export function resolveGuestRoute(path: string): GuestRoute {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  switch (clean) {
    case '':
    case '/': return { key: 'root' };
    case '/menu': return { key: 'menu' };
    case '/menu/cart': return { key: 'cart' };
    case '/menu/orders': return { key: 'track' };
    case '/menu/bill': return { key: 'bill' };
    default: break;
  }
  const m = /^\/q\/([^/]+)$/.exec(clean);
  if (m) {
    try { return { key: 'join', token: decodeURIComponent(m[1]) }; } catch { return { key: 'notFound' }; }
  }
  return { key: 'notFound' };
}

/** Routes that belong to a dining visit (they show the ended page once it closes). */
export const VISIT_ROUTES: ReadonlySet<GuestRouteKey> = new Set(['cart', 'track', 'bill']);

const TRACK_ROUTE: Record<GuestRouteKey, TrackRoute> = {
  root: 'other', menu: 'menu', cart: 'cart', track: 'track', bill: 'bill', join: 'join', notFound: 'other',
};

// ---------------------------------------------------------------- tracker
/**
 * Engagement tracker wiring for the whole guest interface (brief 39):
 * configure from the public config, follow the visit, end it on close,
 * and declare the current screen.
 */
export function useGuestTracker(route: GuestRouteKey, ended: boolean): void {
  const { config } = useConfig();
  const { catalog } = useCatalog();
  const { lang } = useI18n();
  const { mode, session } = useGuestSession();

  useInitTracker(config ? {
    enabled: config.analytics.enabled,
    idleThresholdMs: config.analytics.idle_threshold_seconds * 1000,
    heartbeatMs: config.analytics.heartbeat_seconds * 1000,
    menuVersion: catalog?.version ?? null,
    layoutVersion: 'menu-v1',
    locale: lang,
  } : null);

  const visitId = mode === 'joined' && session ? session.visit.id : null;
  const joinedVisit = useRef<string | null>(null);
  useEffect(() => {
    if (mode === 'loading') return;
    if (mode === 'joined' && visitId) {
      joinedVisit.current = visitId;
      setVisit(visitId);
    } else if (mode === 'ended' && joinedVisit.current) {
      // The visit this tab took part in closed: final chunk + session_end, then silence.
      joinedVisit.current = null;
      endVisit();
    } else if (mode === 'public' || (mode === 'ended' && !joinedVisit.current)) {
      setVisit(null);
    }
  }, [mode, visitId]);

  useTrackRoute(ended ? 'other' : TRACK_ROUTE[route]);
}
