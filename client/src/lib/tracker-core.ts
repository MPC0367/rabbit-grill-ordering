// Engagement tracker - the engine. See tracker.ts for the measurement
// definitions and the public API; this file implements them against a
// TrackerEnv so the same code runs in the browser and in a fake-timer harness.
import type { AnalyticsEvent } from '../../../shared/schemas.ts';
import type { TrackerEnv, Unlisten } from './tracker-env.ts';
import { createSessions, KEYS, type SeenKind } from './tracker-session.ts';
import { createLeader, type ChannelMessage, type Leader } from './tracker-leader.ts';
import { createTransport, type Transport } from './tracker-transport.ts';
import { categoryCriterion, createDwellObserver, itemCriterion, type DwellObserver } from './tracker-visibility.ts';

export type TrackRoute = AnalyticsEvent['route'];
export type TrackEventType = AnalyticsEvent['type'];
export type TrackLocale = 'th' | 'en';

export interface TrackerOptions {
  /** PublicConfigDTO.analytics.enabled. False = the tracker does nothing and keeps nothing. */
  enabled: boolean;
  /** Default 30 000 (PublicConfigDTO.analytics.idle_threshold_seconds × 1000). */
  idleThresholdMs?: number;
  /** Default 12 000 (PublicConfigDTO.analytics.heartbeat_seconds × 1000). */
  heartbeatMs?: number;
  /** CatalogDTO.version the guest is looking at. */
  menuVersion?: string | number | null;
  /** Version of the guest layout (card size, grid); a viewport class is appended. */
  layoutVersion?: string | null;
  locale?: TrackLocale;
  /** Dining visit if already known (null = public browsing). Otherwise call setVisit(). */
  visitId?: string | null;
}

export interface CartChange {
  itemId: string;
  /** +n added to the draft, -n removed. Zero is ignored. */
  quantityDelta: number;
  /** Added straight from the menu card without opening the dish. */
  quickAdd?: boolean;
  categoryId?: string | null;
  /** Draft line uid (lets the server pair an add with a later removal). Never free text. */
  ref?: string | null;
}

export interface TrackerState {
  configured: 'unknown' | 'enabled' | 'disabled';
  running: boolean;
  optedOut: boolean;
  tabId: string | null;
  context: { known: boolean; visit: string | null; suspended: boolean };
  sessionId: string | null;
  visible: boolean;
  focused: boolean;
  leader: boolean;
  active: boolean;
  idleInMs: number | null;
  chunk: { route: TrackRoute; itemId: string | null; accumMs: number } | null;
  route: TrackRoute;
  detailItemId: string | null;
  pending: number;
  observed: { items: number; categories: number };
  transport: ReturnType<Transport['stats']> | null;
  settings: { idleThresholdMs: number; heartbeatMs: number; menuVersion: string | null; layoutVersion: string };
}

export interface TrackerCore {
  configure(opts: TrackerOptions): void;
  setVisit(visitId: string | null): void;
  endVisit(): void;
  optOut(value: boolean): void;
  isOptedOut(): boolean;
  isEnabled(): boolean;
  subscribe(fn: () => void): () => void;
  enterRoute(route: TrackRoute): number;
  leaveRoute(token: number): void;
  openDetail(itemId: string, opts?: { source?: number | null; categoryId?: string | null }): number;
  closeDetail(token: number): void;
  categoryVisible(categoryId: string): void;
  observeItem(el: Element, itemId: string, categoryId: string | null, position: number | null): () => void;
  observeCategory(el: Element, categoryId: string): () => void;
  setScrollContainer(el: ScrollBox | null): void;
  cartChange(change: CartChange): void;
  sessionId(): string | null;
  flush(): void;
  state(): TrackerState;
  dispose(): void;
}

export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

// ------------------------------------------------------------------ constants
const TICK_MS = 1_000;
/** A gap between evaluations longer than this means the page was frozen/asleep: not counted. */
const MAX_STALL_MS = 3_000;
/** Pieces of active time shorter than this are not reported. */
const MIN_CHUNK_MS = 250;
/** API cap for active_ms. */
const MAX_ACTIVE_MS = 120_000;
const MAX_ELAPSED_MS = 24 * 3_600_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 12_000;
const DEPTH_THRESHOLDS = [25, 50, 75, 100] as const;
const DEPTH_THROTTLE_MS = 250;
const PENDING_CAP = 50;
const PENDING_MAX_AGE_MS = 60_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const DIRECT_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const cleanId = (v: unknown): string | null => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const clampInt = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
const clampNum = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
/** Bangkok calendar day index (UTC+7, no DST); chunks never straddle midnight. */
const dayKey = (wall: number) => Math.floor((wall + BANGKOK_OFFSET_MS) / DAY_MS);

interface Chunk {
  id: string;
  sessionId: string;
  route: TrackRoute;
  itemId: string | null;
  categoryId: string | null;
  /** Reference of the dish opening this chunk belongs to (item_detail_active_time). */
  detailRef: string | null;
  accum: number;
  day: number;
}

interface RouteEntry { token: number; route: TrackRoute; leaving: number | null }
interface DetailEntry { token: number; itemId: string; categoryId: string | null; ref: string; leaving: number | null }
type EventFields = Partial<Omit<AnalyticsEvent, 'event_id' | 'type' | 'seq' | 'elapsed_ms' | 'layout_version' | 'menu_version'>>;

export function createTrackerCore(env: TrackerEnv, dev = false): TrackerCore {
  const sessions = createSessions(env);
  const listeners = new Set<() => void>();

  let configured: TrackerState['configured'] = 'unknown';
  let running = false;
  let optedOut = env.storage.get<unknown>(KEYS.optOut, false) === true;
  const cfg = {
    idle: DEFAULT_IDLE_MS,
    heartbeat: DEFAULT_HEARTBEAT_MS,
    menuVersion: null as string | null,
    layout: 'v1',
    locale: 'th' as TrackLocale,
  };

  let leader: Leader | null = null;
  let transport: Transport | null = null;
  let offs: Unlisten[] = [];

  // Page state
  let visible = env.isVisible();
  let focused = true;
  let leaving = false;
  let directAt = -Infinity;
  let anyAt = -Infinity;

  // Active time
  let activeSince: number | null = null;
  let lastEval = env.now();
  let chunk: Chunk | null = null;
  let tickTimer: number | null = null;

  // UI scope
  let tokenSeq = 0;
  const routes: RouteEntry[] = [];
  let detail: DetailEntry | null = null;
  let pendingView = false;
  let scrollBox: ScrollBox | null = null;
  let depthTimer: number | null = null;
  let lastDepthAt = -Infinity;

  let pending: Array<{ at: number; fn: () => void }> = [];
  let itemObs: DwellObserver<{ itemId: string; categoryId: string | null; position: number | null }> | null = null;
  let catObs: DwellObserver<string> | null = null;

  function debug(msg: string, data?: unknown) {
    if (dev) console.debug(`[tracker] ${msg}`, data ?? '');
  }

  function guard(fn: () => void) {
    try { fn(); } catch (err) { if (dev) console.warn('[tracker]', err); }
  }

  function notify() {
    for (const l of listeners) guard(l);
  }

  // ---------------------------------------------------------------- scope
  // The most recently entered screen wins; 'other' is only a fallback, because
  // React mounts a page's effects before its shell's.
  const baseRoute = (): TrackRoute => {
    for (let i = routes.length - 1; i >= 0; i--) if (routes[i].route !== 'other') return routes[i].route;
    return 'other';
  };
  const effectiveRoute = (): TrackRoute => (detail ? 'item' : baseRoute());
  // Only [A-Za-z0-9_.:-]: the server discards version strings with anything else.
  const layoutVersion = () => `${cfg.layout.slice(0, 28)}:${env.viewportClass().replace(/[^A-Za-z0-9]/g, '').slice(0, 3)}`;

  const canRecord = () => running && !optedOut && sessions.ready();
  const canCount = () => canRecord() && visible && !leaving;

  // ---------------------------------------------------------------- events
  function record(type: TrackEventType, fields: EventFields) {
    if (!canRecord() || !transport) return;
    const a = sessions.allocate();
    if (!a) return;
    const event: AnalyticsEvent = {
      event_id: env.newId('evt'),
      type,
      seq: a.seq,
      elapsed_ms: clampInt(a.elapsed, 0, MAX_ELAPSED_MS),
      route: fields.route ?? effectiveRoute(),
      layout_version: layoutVersion(),
      ...(cfg.menuVersion ? { menu_version: cfg.menuVersion } : {}),
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined && k !== 'route') (event as Record<string, unknown>)[k] = v;
    }
    transport.enqueue({ s: a.sessionId, v: a.visit, e: event, n: 0 });
    debug(type, event);
  }

  /** Record now, or hold briefly while the config or the visit context is still loading. */
  function runOrBuffer(fn: () => void) {
    if (optedOut || configured === 'disabled') return;
    if (canRecord()) { guard(fn); return; }
    if (running && sessions.contextKnown()) return; // suspended: the visit has ended
    pending.push({ at: env.now(), fn });
    if (pending.length > PENDING_CAP) pending.shift();
  }

  function replay() {
    if (!canRecord() || pending.length === 0) return;
    const now = env.now();
    const items = pending;
    pending = [];
    for (const p of items) if (now - p.at <= PENDING_MAX_AGE_MS) guard(p.fn);
  }

  function markOnce(kind: SeenKind, key: string): boolean {
    return sessions.markSeen(kind, key);
  }

  function tryView() {
    if (!pendingView || !canCount() || baseRoute() !== 'menu') return;
    pendingView = false;
    record('menu_view', { route: 'menu' });
  }

  // ---------------------------------------------------------------- active time
  function eligible(now: number): boolean {
    return canCount() && focused && !!leader?.isLeader() && now - anyAt < cfg.idle;
  }

  function accumulate(now: number) {
    if (activeSince === null) return;
    let end = Math.min(now, anyAt + cfg.idle);
    if (now - lastEval > MAX_STALL_MS) {
      // The page was frozen or the device slept: nothing after the last
      // observation counts, and like a hidden page it needs a new interaction.
      end = Math.min(end, lastEval);
      directAt = -Infinity;
      anyAt = -Infinity;
    }
    if (chunk && end > activeSince) chunk.accum += end - activeSince;
  }

  function openChunk(): boolean {
    const sessionId = sessions.currentId();
    if (!sessionId) return false;
    chunk = {
      id: env.newId('ivl'),
      sessionId,
      route: effectiveRoute(),
      itemId: detail?.itemId ?? null,
      categoryId: detail?.categoryId ?? null,
      detailRef: detail?.ref ?? null,
      accum: 0,
      day: dayKey(env.wallNow()),
    };
    return true;
  }

  function closeChunk() {
    const c = chunk;
    chunk = null;
    if (!c) return;
    const ms = clampInt(c.accum, 0, MAX_ACTIVE_MS);
    if (ms < MIN_CHUNK_MS) return;
    // Never move time into a different session than the one it was measured in.
    if (sessions.peekId() !== c.sessionId) return;
    record('active_time_chunk', {
      route: c.route,
      item_id: c.itemId,
      category_id: c.categoryId,
      active_ms: ms,
      interaction_ref: c.id,
    });
    if (c.itemId) {
      // One reference per opening: every chunk of one dwell shares it, so the
      // server can sum them into one value per detail open.
      record('item_detail_active_time', {
        route: 'item',
        item_id: c.itemId,
        category_id: c.categoryId,
        active_ms: ms,
        interaction_ref: c.detailRef,
      });
    }
  }

  /** Stop counting now and report what the current chunk holds. */
  function pauseNow() {
    const now = env.now();
    accumulate(now);
    activeSince = null;
    lastEval = now;
    closeChunk();
  }

  function evaluate() {
    if (!running) return;
    const now = env.now();
    const ok = eligible(now);
    if (activeSince !== null) {
      accumulate(now);
      if (ok) activeSince = now;
      else { activeSince = null; closeChunk(); }
    } else if (ok) {
      if (chunk || openChunk()) activeSince = now;
    }
    lastEval = now;
    if (activeSince !== null && chunk) {
      if (chunk.accum >= cfg.heartbeat || dayKey(env.wallNow()) !== chunk.day) {
        closeChunk();
        if (!openChunk()) activeSince = null;
      }
      leader?.renew();
    }
    syncTick();
  }

  function scopeChanged() {
    if (!running) return;
    if (activeSince !== null || chunk) pauseNow();
    if (baseRoute() !== 'menu') pendingView = false;
    evaluate();
    tryView();
  }

  function syncTick() {
    const want = running && visible && !leaving;
    if (want && tickTimer === null) tickTimer = env.setTimer(tick, TICK_MS);
    else if (!want && tickTimer !== null) { env.clearTimer(tickTimer); tickTimer = null; }
  }

  function tick() {
    tickTimer = null;
    guard(() => {
      leader?.check();
      evaluate();
      tryView();
      itemObs?.poll();
      catObs?.poll();
    });
    syncTick();
  }

  // ---------------------------------------------------------------- scroll depth
  function depthCheck() {
    depthTimer = null;
    lastDepthAt = env.now();
    if (!canCount()) return;
    const m = scrollBox
      ? { top: scrollBox.scrollTop, viewport: scrollBox.clientHeight, height: scrollBox.scrollHeight }
      : env.scrollMetrics();
    if (!m || m.height <= 0 || m.viewport <= 0) return;
    // A page that barely scrolls has no meaningful depth.
    if (m.height - m.viewport < m.viewport * 0.25) return;
    const pct = Math.min(100, ((m.top + m.viewport) / m.height) * 100);
    const route = effectiveRoute();
    const layout = layoutVersion();
    for (const t of DEPTH_THRESHOLDS) {
      // 100% allows a pixel of rounding at the very bottom.
      if (pct < (t === 100 ? 99.5 : t)) break;
      if (markOnce('d', `${route}|${layout}|${t}`)) record('scroll_depth', { route, depth: t });
    }
  }

  // ---------------------------------------------------------------- page events
  function onDirect() {
    const now = env.now();
    directAt = now;
    anyAt = now;
    focused = true;
    if (!running || optedOut) return;
    if (!visible) visible = env.isVisible();
    if (!sessions.ready()) return;
    sessions.touch();
    leader?.claim();
    if (activeSince === null) evaluate();
  }

  function onScroll(e: Event) {
    const now = env.now();
    // Scrolling only sustains attention the guest already showed: scroll
    // restoration and programmatic jumps must not start active time.
    if (now - directAt >= cfg.idle) return;
    anyAt = now;
    if (!running || optedOut) return;
    const fromDocument = env.isDocument(e.target);
    if (scrollBox ? e.target !== (scrollBox as unknown) : !fromDocument) return;
    if (depthTimer === null) {
      depthTimer = env.setTimer(() => guard(depthCheck), Math.max(0, DEPTH_THROTTLE_MS - (now - lastDepthAt)));
    }
  }

  function onVisibility() {
    visible = env.isVisible();
    if (!running) return;
    if (!visible) {
      evaluate();
      itemObs?.pause();
      catObs?.pause();
      leader?.release();
      transport?.flush(true);
    } else {
      leaving = false;
      focused = env.hasFocus() || focused;
      itemObs?.rearm(false);
      catObs?.rearm(false);
      evaluate();
      tryView();
    }
    syncTick();
  }

  function onPageHide(persisted: boolean) {
    if (!running) return;
    leaving = true;
    evaluate();
    leader?.release();
    transport?.flush(true);
    transport?.persistNow(true);
    syncTick();
    debug('pagehide', { persisted });
  }

  function onPageShow(persisted: boolean) {
    if (!running || !persisted) return;
    leaving = false;
    transport?.reclaimOwn();
    onVisibility();
  }

  function onChannel(msg: ChannelMessage) {
    if (msg.t === 'optout' || msg.t === 'optin') syncOptOut();
    else if (msg.t === 'ended' && msg.visit === sessions.contextVisit()) endedElsewhere();
  }

  function endedElsewhere() {
    // The session was closed by another tab: its time here ends with it.
    activeSince = null;
    chunk = null;
    sessions.refreshEnded();
    itemObs?.pause();
    catObs?.pause();
    notify();
  }

  function syncOptOut() {
    const next = env.storage.get<unknown>(KEYS.optOut, false) === true;
    if (next === optedOut) return;
    optedOut = next;
    if (optedOut) stop(true);
    else if (configured === 'enabled') start();
    notify();
  }

  // Cross-tab signals that must work even while this tab is not running.
  const offGlobalStorage = env.onStorageChange((key) => guard(() => {
    if (key === KEYS.optOut || key === null) syncOptOut();
    if (running && (key === KEYS.ended || key === null)) {
      const v = sessions.contextVisit();
      sessions.refreshEnded();
      if (v !== null && sessions.isEnded(v) && (chunk || activeSince !== null)) endedElsewhere();
    }
  }));

  // ---------------------------------------------------------------- lifecycle
  function start() {
    if (running || optedOut || configured !== 'enabled') return;
    running = true;
    leaving = false;
    visible = env.isVisible();
    focused = env.hasFocus() || focused;
    sessions.janitor();
    leader = createLeader(env, { onYield: () => guard(evaluate), onMessage: (m) => guard(() => onChannel(m)) });
    const tabId = leader.tabId;
    transport = createTransport(env, {
      tabId,
      locale: () => cfg.locale,
      currentVisit: () => sessions.contextVisit(),
      elapsedFor: (id) => sessions.elapsedFor(id),
      onDebug: dev ? debug : undefined,
    });
    transport.adoptBackups();
    const passive = { capture: true, passive: true } as const;
    offs = [
      env.listen('document', 'visibilitychange', () => guard(onVisibility)),
      env.listen('window', 'pagehide', (e) => guard(() => onPageHide(!!(e as PageTransitionEvent).persisted))),
      env.listen('window', 'pageshow', (e) => guard(() => onPageShow(!!(e as PageTransitionEvent).persisted))),
      env.listen('document', 'freeze', () => guard(() => onPageHide(true))),
      env.listen('document', 'resume', () => guard(() => onPageShow(true))),
      env.listen('window', 'blur', () => guard(() => { focused = false; evaluate(); })),
      env.listen('window', 'focus', () => guard(() => { focused = true; evaluate(); })),
      env.listen('document', 'scroll', (e) => guard(() => onScroll(e)), passive),
      ...DIRECT_EVENTS.map((type) => env.listen('document', type, () => guard(onDirect), passive)),
    ];
    replay();
    itemObs?.rearm(false);
    catObs?.rearm(false);
    evaluate();
    tryView();
    notify();
    debug('start', { tabId });
  }

  function stop(discard: boolean) {
    if (!running) return;
    if (discard) { activeSince = null; chunk = null; }
    else pauseNow();
    for (const off of offs) guard(off);
    offs = [];
    if (tickTimer !== null) { env.clearTimer(tickTimer); tickTimer = null; }
    if (depthTimer !== null) { env.clearTimer(depthTimer); depthTimer = null; }
    itemObs?.pause();
    catObs?.pause();
    if (transport) {
      if (discard) transport.discardAll(true);
      else if (!leaving) transport.flush(true); // pagehide already flushed and left an orphan backup
      transport.dispose();
    }
    if (discard) sessions.clearAll();
    leader?.dispose();
    leader = null;
    transport = null;
    running = false;
    pending = [];
    debug('stop', { discard });
  }

  function configure(opts: TrackerOptions) {
    cfg.idle = clampNum(opts.idleThresholdMs, 5_000, 600_000, cfg.idle);
    cfg.heartbeat = clampNum(opts.heartbeatMs, 5_000, 60_000, cfg.heartbeat);
    if (opts.menuVersion !== undefined) cfg.menuVersion = opts.menuVersion === null ? null : String(opts.menuVersion).replace(/[^\w.:-]/g, '').slice(0, 64) || null;
    if (opts.layoutVersion !== undefined) cfg.layout = (opts.layoutVersion ?? 'v1').replace(/[^\w.:-]/g, '').slice(0, 28) || 'v1';
    if (opts.locale === 'th' || opts.locale === 'en') cfg.locale = opts.locale;
    if (opts.visitId !== undefined) setVisit(opts.visitId);
    const next = opts.enabled ? 'enabled' : 'disabled';
    if (next === configured) return;
    configured = next;
    if (next === 'enabled') start();
    else {
      // The restaurant switched collection off: keep nothing that was not sent.
      pending = [];
      stop(true);
    }
    notify();
  }

  function setVisit(visitId: string | null) {
    const next = visitId === null ? null : cleanId(visitId);
    if (visitId !== null && next === null) return;
    if (sessions.contextKnown() && sessions.contextVisit() === next) return;
    const firstKnown = !sessions.contextKnown();
    // Close the old context's time under its own session first.
    if (running && (activeSince !== null || chunk)) pauseNow();
    sessions.setContext(next);
    if (running) {
      replay();
      itemObs?.rearm(!firstKnown);
      catObs?.rearm(!firstKnown);
      if (baseRoute() === 'menu') pendingView = true;
      transport?.flush(false);
      evaluate();
      tryView();
    }
    notify();
  }

  function endVisit() {
    if (!sessions.contextKnown()) return;
    const visit = sessions.contextVisit();
    if (running && sessions.ready()) {
      pauseNow();
      if (sessions.peekId()) record('session_end', { route: effectiveRoute() });
      transport?.flush(true);
    }
    sessions.endCurrent();
    leader?.post({ t: 'ended', visit });
    pendingView = false;
    itemObs?.pause();
    catObs?.pause();
    notify();
  }

  function optOut(value: boolean) {
    if (value) {
      if (optedOut) return;
      if (running && transport && sessions.ready()) {
        pauseNow();
        const sessionId = sessions.peekId();
        const a = sessionId ? sessions.allocate() : null;
        transport.discardAll(true);
        if (a) {
          // One last word: this session opted out. Unsent behaviour is dropped, not sent.
          const end: AnalyticsEvent = {
            event_id: env.newId('evt'),
            type: 'session_end',
            seq: a.seq,
            elapsed_ms: clampInt(a.elapsed, 0, MAX_ELAPSED_MS),
            route: effectiveRoute(),
            layout_version: layoutVersion(),
            ...(cfg.menuVersion ? { menu_version: cfg.menuVersion } : {}),
          };
          transport.sendDirect(a.sessionId, a.visit, [end], true);
        }
      }
      env.storage.set(KEYS.optOut, true);
      optedOut = true;
      leader?.post({ t: 'optout' });
      stop(true);
      sessions.clearAll();
    } else {
      if (!optedOut) return;
      env.storage.remove(KEYS.optOut);
      optedOut = false;
      leader?.post({ t: 'optin' });
      start();
    }
    notify();
  }

  // ---------------------------------------------------------------- UI hooks
  function enterRoute(route: TrackRoute): number {
    const reuse = routes.find((r) => r.leaving !== null && r.route === route);
    if (reuse) {
      // Same route mounted again before the old entry left (React StrictMode, fast re-render).
      env.clearTimer(reuse.leaving as number);
      reuse.leaving = null;
      return reuse.token;
    }
    const token = ++tokenSeq;
    routes.push({ token, route, leaving: null });
    if (route === 'menu') pendingView = true;
    scopeChanged();
    return token;
  }

  function leaveRoute(token: number) {
    const entry = routes.find((r) => r.token === token);
    if (!entry || entry.leaving !== null) return;
    entry.leaving = env.setTimer(() => guard(() => {
      const i = routes.indexOf(entry);
      if (i >= 0) routes.splice(i, 1);
      scopeChanged();
    }), 0);
  }

  function openDetail(itemId: string, opts: { source?: number | null; categoryId?: string | null } = {}): number {
    const id = cleanId(itemId);
    if (!id) return 0;
    if (detail && detail.leaving !== null && detail.itemId === id) {
      env.clearTimer(detail.leaving);
      detail.leaving = null;
      return detail.token;
    }
    if (detail?.leaving != null) env.clearTimer(detail.leaving);
    const categoryId = cleanId(opts.categoryId);
    const position = typeof opts.source === 'number' && Number.isFinite(opts.source) ? clampInt(opts.source, 0, 500) : null;
    const ref = env.newId('dop');
    detail = { token: ++tokenSeq, itemId: id, categoryId, ref, leaving: null };
    runOrBuffer(() => record('item_detail_open', { route: 'item', item_id: id, category_id: categoryId, position, interaction_ref: ref }));
    scopeChanged();
    return detail.token;
  }

  function closeDetail(token: number) {
    const entry = detail;
    if (!entry || entry.token !== token || entry.leaving !== null) return;
    entry.leaving = env.setTimer(() => guard(() => {
      if (detail !== entry) return;
      detail = null;
      scopeChanged();
    }), 0);
  }

  function categoryVisible(categoryId: string) {
    const id = cleanId(categoryId);
    if (!id) return;
    runOrBuffer(() => {
      if (!visible) return;
      if (markOnce('c', id)) record('category_view', { route: 'menu', category_id: id });
    });
  }

  function itemObserver() {
    itemObs ??= createDwellObserver({
      minMs: 1_000,
      meets: itemCriterion,
      thresholds: [0, 0.25, 0.5, 0.75, 1],
      alwaysMeasure: false,
      now: env.now,
      canCount,
      onDwell: (_key, m) => {
        if (markOnce('i', m.itemId)) {
          record('item_impression', { route: baseRoute(), item_id: m.itemId, category_id: m.categoryId, position: m.position });
        }
      },
    });
    return itemObs;
  }

  function categoryObserver() {
    catObs ??= createDwellObserver({
      minMs: 1_000,
      meets: categoryCriterion,
      thresholds: [0],
      alwaysMeasure: true,
      now: env.now,
      canCount,
      onDwell: (id) => {
        if (markOnce('c', id)) record('category_view', { route: 'menu', category_id: id });
      },
    });
    return catObs;
  }

  function observeItem(el: Element, itemId: string, categoryId: string | null, position: number | null) {
    // Always observed: canCount() decides whether anything is recorded, so cards
    // mounted while collection was off still count once it is switched on.
    const id = cleanId(itemId);
    if (!id) return () => {};
    const pos = typeof position === 'number' && Number.isFinite(position) ? clampInt(position, 0, 500) : null;
    return itemObserver().observe(el, id, { itemId: id, categoryId: cleanId(categoryId), position: pos });
  }

  function observeCategory(el: Element, categoryId: string) {
    const id = cleanId(categoryId);
    if (!id) return () => {};
    return categoryObserver().observe(el, id, id);
  }

  function cartChange(change: CartChange) {
    const itemId = cleanId(change.itemId);
    if (!itemId || typeof change.quantityDelta !== 'number' || !Number.isFinite(change.quantityDelta)) return;
    const delta = clampInt(change.quantityDelta, -99, 99);
    if (delta === 0) return;
    const route = effectiveRoute();
    const fields: EventFields = {
      route,
      item_id: itemId,
      category_id: cleanId(change.categoryId),
      quantity_delta: delta,
      quick_add: delta > 0 ? !!change.quickAdd : null,
      interaction_ref: cleanId(change.ref),
    };
    runOrBuffer(() => record(delta > 0 ? 'cart_add' : 'cart_remove', fields));
  }

  return {
    configure: (o) => guard(() => configure(o)),
    setVisit: (v) => guard(() => setVisit(v)),
    endVisit: () => guard(endVisit),
    optOut: (v) => guard(() => optOut(v)),
    isOptedOut: () => optedOut,
    isEnabled: () => configured === 'enabled' && !optedOut,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    enterRoute: (r) => { let t = 0; guard(() => { t = enterRoute(r); }); return t; },
    leaveRoute: (t) => guard(() => leaveRoute(t)),
    openDetail: (id, o) => { let t = 0; guard(() => { t = openDetail(id, o); }); return t; },
    closeDetail: (t) => guard(() => closeDetail(t)),
    categoryVisible: (id) => guard(() => categoryVisible(id)),
    observeItem: (el, id, cat, pos) => { let off = () => {}; guard(() => { off = observeItem(el, id, cat, pos); }); return () => guard(off); },
    observeCategory: (el, id) => { let off = () => {}; guard(() => { off = observeCategory(el, id); }); return () => guard(off); },
    setScrollContainer: (el) => { scrollBox = el; },
    cartChange: (c) => guard(() => cartChange(c)),
    sessionId: () => {
      let id: string | null = null;
      guard(() => { id = canRecord() ? sessions.peekId() : null; });
      return id;
    },
    flush: () => guard(() => transport?.flush(false)),
    state() {
      const now = env.now();
      return {
        configured,
        running,
        optedOut,
        tabId: leader?.tabId ?? null,
        context: { known: sessions.contextKnown(), visit: sessions.contextVisit(), suspended: sessions.contextKnown() && !sessions.ready() },
        sessionId: sessions.peekId(),
        visible,
        focused,
        leader: !!leader?.isLeader(),
        active: activeSince !== null,
        idleInMs: anyAt === -Infinity ? null : Math.max(0, Math.round(anyAt + cfg.idle - now)),
        chunk: chunk ? { route: chunk.route, itemId: chunk.itemId, accumMs: Math.round(chunk.accum + (activeSince !== null ? Math.max(0, Math.min(now, anyAt + cfg.idle) - activeSince) : 0)) } : null,
        route: effectiveRoute(),
        detailItemId: detail?.itemId ?? null,
        pending: pending.length,
        observed: { items: itemObs?.count() ?? 0, categories: catObs?.count() ?? 0 },
        transport: transport?.stats() ?? null,
        settings: { idleThresholdMs: cfg.idle, heartbeatMs: cfg.heartbeat, menuVersion: cfg.menuVersion, layoutVersion: layoutVersion() },
      };
    },
    dispose() {
      guard(() => stop(false));
      offGlobalStorage();
      itemObs?.dispose();
      catObs?.dispose();
      itemObs = null;
      catObs = null;
      listeners.clear();
    },
  };
}
