// Engagement tracker - the small slice of the browser the engine touches.
//
// The engine (tracker-core.ts) never reads `window`, `document`, `performance`
// or `fetch` directly: it goes through a TrackerEnv, so a Node harness can
// drive it with fake clocks, fake visibility and a fake network. The real
// implementation lives here and is only created in a browser.
import { newId } from '../../../shared/ids.ts';
import { storage } from './store.ts';

/** Same shape as `storage` in lib/store.ts: JSON values, never throws. */
export interface KeyValueStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  keys(prefix: string): string[];
}

export interface SendOptions {
  keepalive: boolean;
  /** 'same-origin' only for the dining session of the visit this tab is in; 'omit' otherwise. */
  credentials: 'same-origin' | 'omit';
}

/** status 0 = the request never got an HTTP answer (offline, blocked, aborted). */
export interface SendResult {
  status: number;
  retryAfterMs: number | null;
}

export interface Channel {
  post(data: unknown): void;
  close(): void;
}

export type Unlisten = () => void;

export interface TrackerEnv {
  /** Monotonic milliseconds (performance.now). All intervals are measured with this. */
  now(): number;
  /** Wall clock (Date.now). Only for gaps between page loads, leases and the session timeout. */
  wallNow(): number;
  storage: KeyValueStore;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** Run low-priority work when the main thread is idle (never later than `timeoutMs`). */
  idle(fn: () => void, timeoutMs: number): void;
  send(url: string, body: string, opts: SendOptions): Promise<SendResult>;
  /** BroadcastChannel, or null where unsupported (the storage event is the fallback). */
  openChannel(name: string, onMessage: (data: unknown) => void): Channel | null;
  onStorageChange(fn: (key: string | null) => void): Unlisten;
  isVisible(): boolean;
  hasFocus(): boolean;
  listen(target: 'window' | 'document', type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): Unlisten;
  /** The event target is the document itself (page scroll), not an inner scroller. */
  isDocument(target: EventTarget | null): boolean;
  newId(prefix: string): string;
  /** Document scroll position for scroll depth; null when there is no document. */
  scrollMetrics(): { top: number; viewport: number; height: number } | null;
  /** Viewport class appended to layout_version: orientation + width bucket, e.g. "ps". */
  viewportClass(): string;
}

const SEND_TIMEOUT_MS = 20_000;

function retryAfterFrom(res: Response, data: unknown): number | null {
  const header = Number(res.headers.get('Retry-After'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const seconds = (data as { error?: { details?: { retry_after_seconds?: unknown } } } | null)?.error?.details?.retry_after_seconds;
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null;
}

/** The real environment. Call only in a browser. */
export function browserEnv(): TrackerEnv {
  const w = window;
  const d = document;
  return {
    now: () => w.performance.now(),
    wallNow: () => Date.now(),
    storage,
    setTimer: (fn, ms) => w.setTimeout(fn, ms),
    clearTimer: (h) => w.clearTimeout(h),
    idle: (fn, timeoutMs) => {
      if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => fn(), { timeout: timeoutMs });
      else w.setTimeout(fn, 1);
    },
    async send(url, body, opts) {
      let res: Response;
      // A request that hangs must not block later batches forever.
      const controller = new AbortController();
      const timer = w.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        // keepalive lets the request outlive the page (pagehide) and, unlike
        // sendBeacon, keeps the X-RG-Client header the CSRF guard requires.
        res = await fetch(url, {
          method: 'POST',
          keepalive: opts.keepalive,
          credentials: opts.credentials,
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-RG-Client': '1' },
          body,
          signal: controller.signal,
        });
      } catch {
        return { status: 0, retryAfterMs: null };
      } finally {
        w.clearTimeout(timer);
      }
      let data: unknown = null;
      if (res.status === 429) {
        try { data = await res.json(); } catch { data = null; }
      }
      return { status: res.status, retryAfterMs: res.status === 429 ? retryAfterFrom(res, data) : null };
    },
    openChannel(name, onMessage) {
      if (typeof w.BroadcastChannel !== 'function') return null;
      try {
        const ch = new w.BroadcastChannel(name);
        ch.onmessage = (e: MessageEvent) => onMessage(e.data);
        return {
          post: (data) => { try { ch.postMessage(data); } catch { /* closed */ } },
          close: () => { try { ch.close(); } catch { /* ignore */ } },
        };
      } catch {
        return null;
      }
    },
    onStorageChange(fn) {
      const h = (e: StorageEvent) => fn(e.key);
      w.addEventListener('storage', h);
      return () => w.removeEventListener('storage', h);
    },
    isVisible: () => d.visibilityState === 'visible',
    hasFocus: () => {
      try { return d.hasFocus(); } catch { return true; }
    },
    listen(target, type, fn, opts) {
      const t: EventTarget = target === 'window' ? w : d;
      t.addEventListener(type, fn, opts);
      return () => t.removeEventListener(type, fn, opts);
    },
    newId,
    isDocument: (t) => t === d || t === d.documentElement || t === d.scrollingElement,
    scrollMetrics() {
      const el = d.scrollingElement ?? d.documentElement;
      if (!el) return null;
      return { top: el.scrollTop, viewport: w.innerHeight || el.clientHeight, height: el.scrollHeight };
    },
    viewportClass() {
      const width = w.innerWidth || 0;
      const orient = (w.innerHeight || 0) >= width ? 'p' : 'l';
      return `${orient}${width < 600 ? 's' : width < 1024 ? 'm' : 'l'}`;
    },
  };
}
