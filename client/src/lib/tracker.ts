// Guest engagement tracker (stream C3). Optional, anonymous, never in the way.
//
// ============================================================================
// MEASUREMENT DEFINITIONS (quoted on the staff Engagement page)
// ============================================================================
// Browsing session
//   A pseudonymous id (`ans_…`, random) shared by the tabs of one browser for
//   one context: public menu browsing, or one dining visit. A new session
//   starts after 30 minutes without activity, whenever the dining visit
//   changes, and after the visit closes. Sessions never carry identity from one
//   visit to another; there is no fingerprinting and no account link. Several
//   phones at one table are several sessions; two people sharing one phone are
//   one session - sessions are devices, not people.
//
// Active time (active_time_chunk.active_ms)
//   Time counted by a monotonic clock only while ALL of these hold:
//     - the page is visible (document.visibilityState = visible),
//     - the window has focus (a tap, key, wheel or touch also proves focus),
//     - the guest touched, tapped, typed or scrolled within the idle threshold
//       (30 s by default, set by the restaurant). Scrolling only extends
//       attention the guest already showed, so scroll restoration or an
//       automatic jump never starts it. Counting begins at the first
//       interaction after the page opens, not when the page opens;
//     - this tab is the one tab of this browser the guest used most recently
//       (other tabs stay passive, so one screen is never counted twice).
//   Counting stops at the moment any condition fails - for idle, at the end of
//   the threshold, not when the idleness is noticed - and on page hide, page
//   unload or navigation away, when the visit closes, and on opt-out. A frozen
//   or sleeping page (no tick for 3 s) never adds its gap. Time is reported in
//   chunks every ~12 s (the heartbeat) while active plus one final chunk at each
//   pause; slivers under 0.25 s are not reported, and chunks never straddle
//   midnight in Bangkok. This is observed foreground time, not attention: a
//   guest reading without touching the screen for longer than the threshold is
//   not counted, and closing the browser or losing the network can lose the
//   last unsent chunk.
//
// Route / dish detail time
//   Each chunk carries the screen it was measured on (menu, item, cart,
//   track, bill, join, other) and its own interval id (interaction_ref). While
//   a dish sheet is open the route is `item` and the chunk carries item_id;
//   the same interval is also reported as item_detail_active_time for that
//   dish. Every detail-time event of one opening carries that opening's
//   reference (`dop_…`, also on its item_detail_open), so they sum to one
//   dwell per opening. Chunk time and detail time are the same time seen two
//   ways: never add them together. "Active menu time" is route `menu` only.
//
// Menu view (menu_view)
//   The menu screen was entered while visible (once per entry, and again when a
//   new session starts on it).
//
// Category view (category_view)
//   A category section was on screen, while the page was visible, for at least
//   1 s with at least half the section - or at least 30% of the viewport height
//   for sections taller than that - showing (or the menu reported it as the
//   current category). Once per category per session.
//
// Item impression (item_impression)
//   At least 50% of a dish card's area was inside the viewport for at least
//   1 s continuously while the page was visible. Once per dish per session,
//   with its category and display position (0-based, as laid out).
//
// Dish opened (item_detail_open)
//   The guest opened a dish sheet; `position` is the card position it was
//   opened from when known, interaction_ref the opening's reference. Every
//   opening counts.
//
// Scroll depth (scroll_depth)
//   The bottom edge of the viewport passed 25/50/75/100% of the page height,
//   after the guest scrolled. Once per threshold per session, screen and
//   layout (layout_version = app layout : orientation + width class, e.g.
//   `menu-v1:ps`). Approximate: it moves with image loading, filters and
//   orientation, and 100% never means every dish was read. Pages that barely
//   scroll report nothing.
//
// Draft changes (cart_add / cart_remove)
//   Sent only after the private draft actually changed; quantity_delta is the
//   change, quick_add marks an add straight from a menu card without opening
//   the dish. Orders themselves are counted by the server from real
//   submissions, never from these events.
//
// Session end (session_end)
//   The dining visit closed on this device (endVisit) or the guest opted out.
//
// Delivery
//   Events are batched (every ~10 s, at 20 events, and when the page is hidden
//   or closed) and retried with the same event ids, which the server
//   de-duplicates. Unsent events survive a reload in a small local backup.
//   Nothing is collected when the restaurant switches analytics off or the
//   guest opts out; opting out drops unsent events and sends only a final
//   `session_end` marked opted_out. Never collected: notes, allergy text, PINs,
//   QR or session tokens, payment references, typed text, keystrokes, prices
//   typed by anyone, URLs, screen contents.
// ============================================================================
//
// Usage (guest interface):
//   initTracker({ enabled, idleThresholdMs, heartbeatMs, menuVersion, layoutVersion, locale })
//   setVisit(visitId | null)          once the guest session is known; again on every change
//   endVisit()                        when the visit closes on this device
//   useTrackRoute('menu')             in each guest screen
//   useDetailTracking(itemId, { source, categoryId })   in the dish sheet host
//   const ref = useItemImpression(item.id, category.id, index)   <article ref={ref}>
//   const ref = useCategoryView(category.id)                     <section ref={ref}>
//   setCategoryVisible(categoryId)    optional: the menu's own "current category"
//   trackCartChange({ itemId, quantityDelta, quickAdd, categoryId, ref })   after a real draft change
//   analyticsSessionId()              for SubmitOrderBody.analytics_session_id (null when off)
//   optOut(true|false) / useAnalyticsOptOut()   for the analytics notice
// Every function is safe to call at any time: before initTracker, while
// disabled, during SSR-less tests. Nothing throws and nothing is awaited.
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefCallback } from 'react';
import { browserEnv } from './tracker-env.ts';
import {
  createTrackerCore,
  type CartChange,
  type ScrollBox,
  type TrackerCore,
  type TrackerOptions,
  type TrackerState,
  type TrackRoute,
} from './tracker-core.ts';

export type { CartChange, TrackerOptions, TrackerState, TrackRoute } from './tracker-core.ts';

let core: TrackerCore | null = null;

function isDev(): boolean {
  try { return Boolean(import.meta.env?.DEV); } catch { return false; }
}

/** The shared engine, created on first use (browser only). */
function engine(): TrackerCore | null {
  if (core) return core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    const dev = isDev();
    core = createTrackerCore(browserEnv(), dev);
    if (dev) {
      window.__rgTracker = {
        state: () => core?.state() ?? null,
        flush: () => core?.flush(),
      };
    }
  } catch {
    core = null;
  }
  return core;
}

declare global {
  interface Window {
    /** Development only: inspect the tracker from the console. */
    __rgTracker?: { state(): TrackerState | null; flush(): void };
  }
}

// ------------------------------------------------------------------ setup

/**
 * Configure (and start or stop) the tracker. Call again whenever the public
 * config, catalog version, layout or language changes; fields left undefined
 * keep their previous value. `enabled: false` stops collection and discards
 * anything unsent. Has no effect while the viewer has opted out.
 */
export function initTracker(opts: TrackerOptions): void {
  engine()?.configure(opts);
}

/**
 * The dining visit this browser is in (null = public browsing). Until the
 * first call, events wait briefly in memory. A different value always starts a
 * different session.
 */
export function setVisit(visitId: string | null): void {
  engine()?.setVisit(visitId);
}

/** The visit closed on this device: report session_end, flush, and stay silent for that visit. */
export function endVisit(): void {
  engine()?.endVisit();
}

/** Persisted per browser (localStorage `rg.analytics.optout`). */
export function optOut(value: boolean): void {
  engine()?.optOut(value);
}

export function isOptedOut(): boolean {
  return engine()?.isOptedOut() ?? false;
}

/** Collecting right now: enabled by the restaurant and not opted out. */
export function isTracking(): boolean {
  return engine()?.isEnabled() ?? false;
}

/** For SubmitOrderBody.analytics_session_id. Null when analytics is off or no session exists yet. */
export function analyticsSessionId(): string | null {
  return engine()?.sessionId() ?? null;
}

/** Send queued events soon (they are sent on their own anyway). */
export function flushTracker(): void {
  engine()?.flush();
}

// ------------------------------------------------------------------ plain calls

/** Enter a screen; returns a function that leaves it. Prefer useTrackRoute in components. */
export function trackRoute(route: TrackRoute): () => void {
  const e = engine();
  if (!e) return () => {};
  const token = e.enterRoute(route);
  return () => e.leaveRoute(token);
}

/** A dish sheet opened; returns a function that closes it. Prefer useDetailTracking in components. */
export function trackDetailOpen(itemId: string, opts?: { source?: number | null; categoryId?: string | null }): () => void {
  const e = engine();
  if (!e) return () => {};
  const token = e.openDetail(itemId, opts);
  return () => e.closeDetail(token);
}

/** The menu's own "this category is now the current one" signal (de-duplicated per session). */
export function setCategoryVisible(categoryId: string): void {
  engine()?.categoryVisible(categoryId);
}

/** Call only after the draft really changed. Positive delta = cart_add, negative = cart_remove. */
export function trackCartChange(change: CartChange): void {
  engine()?.cartChange(change);
}

export function trackCartAdd(itemId: string, quantity: number, opts: Omit<CartChange, 'itemId' | 'quantityDelta'> = {}): void {
  trackCartChange({ ...opts, itemId, quantityDelta: Math.abs(quantity) });
}

export function trackCartRemove(itemId: string, quantity: number, opts: Omit<CartChange, 'itemId' | 'quantityDelta' | 'quickAdd'> = {}): void {
  trackCartChange({ ...opts, itemId, quantityDelta: -Math.abs(quantity) });
}

/** Measure scroll depth on an inner scroller instead of the page (null = the page). */
export function setScrollContainer(el: ScrollBox | null): void {
  engine()?.setScrollContainer(el);
}

/** Current tracker state (debug views, tests). */
export function trackerState(): TrackerState | null {
  return engine()?.state() ?? null;
}

// ------------------------------------------------------------------ React hooks

/** Initialise from a hook; re-runs when any option changes. Pass null while the config is loading. */
export function useInitTracker(opts: TrackerOptions | null): void {
  const key = opts ? JSON.stringify(opts) : '';
  useEffect(() => {
    if (opts) initTracker(opts);
    // `key` captures every field of opts, so opts itself is not a dependency.
  }, [key]);
}

/** Keep the visit context in sync. `undefined` = not known yet (nothing is decided). */
export function useTrackVisit(visitId: string | null | undefined): void {
  useEffect(() => {
    if (visitId !== undefined) setVisit(visitId);
  }, [visitId]);
}

/** Declare the screen this component shows while it is mounted. */
export function useTrackRoute(route: TrackRoute): void {
  useEffect(() => trackRoute(route), [route]);
}

/**
 * Track a dish sheet: item_detail_open when `itemId` becomes non-null, dish
 * active time while it stays open, final chunk when it closes. Pass null for
 * a sheet that only edits an existing draft line if that should not count as
 * an opening.
 */
export function useDetailTracking(itemId: string | null, opts: { source?: number | null; categoryId?: string | null } = {}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!itemId) return;
    return trackDetailOpen(itemId, optsRef.current);
  }, [itemId]);
}

/** Ref callback for a dish card: reports one item_impression per session (>= 50% visible for >= 1 s). */
export function useItemImpression<T extends Element = HTMLElement>(itemId: string, categoryId: string | null, position: number | null): RefCallback<T> {
  return useCallback((el: T | null) => {
    if (!el) return;
    const e = engine();
    if (!e) return;
    return e.observeItem(el, itemId, categoryId, position);
  }, [itemId, categoryId, position]);
}

/** Ref callback for a category section: reports one category_view per session. */
export function useCategoryView<T extends Element = HTMLElement>(categoryId: string): RefCallback<T> {
  return useCallback((el: T | null) => {
    if (!el) return;
    const e = engine();
    if (!e) return;
    return e.observeCategory(el, categoryId);
  }, [categoryId]);
}

/** Ref callback for an inner scroll container whose depth should be measured instead of the page. */
export function useScrollContainer<T extends HTMLElement = HTMLElement>(): RefCallback<T> {
  return useCallback((el: T | null) => {
    if (!el) return;
    setScrollContainer(el);
    return () => setScrollContainer(null);
  }, []);
}

const subscribe = (fn: () => void) => engine()?.subscribe(fn) ?? (() => {});
const optedOutSnapshot = () => engine()?.isOptedOut() ?? false;
const trackingSnapshot = () => engine()?.isEnabled() ?? false;

/** For the analytics notice: `{ optedOut, tracking, setOptOut }`. */
export function useAnalyticsOptOut(): { optedOut: boolean; tracking: boolean; setOptOut: (value: boolean) => void } {
  const optedOut = useSyncExternalStore(subscribe, optedOutSnapshot, () => false);
  const tracking = useSyncExternalStore(subscribe, trackingSnapshot, () => false);
  return { optedOut, tracking, setOptOut: optOut };
}
