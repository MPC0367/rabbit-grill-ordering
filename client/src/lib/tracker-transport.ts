// Engagement tracker - batching, backup and delivery.
//
// Events wait in memory (plus a small per-tab localStorage backup, so a reload
// does not lose them) and go to POST /api/analytics/batch:
//   - every FLUSH_MS, at FLUSH_AT events, and immediately when the page is hidden
//     or unloaded (keepalive fetch: it survives the page and keeps X-RG-Client);
//   - one session per batch, <= 100 events and <= MAX_BATCH_BYTES of JSON, so two
//     batches fit the browser's 64 KB keepalive budget together;
//   - a failed batch is retried later with the SAME event ids (the server
//     de-duplicates), with backoff; after MAX_TRIES an event is dropped silently.
// Nothing here throws into the UI or awaits anything the order flow waits on.
import type { AnalyticsEvent } from '../../../shared/schemas.ts';
import type { TrackerEnv } from './tracker-env.ts';
import { KEYS } from './tracker-session.ts';

export const BATCH_URL = '/api/analytics/batch';
const FLUSH_MS = 10_000;
const FLUSH_AT = 20;
const MAX_EVENTS_PER_BATCH = 100;
const MAX_BATCH_BYTES = 30_000;
const MAX_QUEUE = 500;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const PERSIST_DEBOUNCE_MS = 1_000;
/** Backups written by a tab that is still alive are left alone for this long. */
const ORPHAN_AFTER_MS = 10 * 60_000;
const BACKUP_TTL_MS = 3 * 24 * 3_600_000;

export interface QueuedEvent {
  /** Session id (batch key). */
  s: string;
  /** Visit of that session (null = public browsing). */
  v: string | null;
  e: AnalyticsEvent;
  /** Failed delivery attempts so far. */
  n: number;
}

interface Backup {
  tab: string;
  /** Written at pagehide: the tab is gone (or frozen) and another may adopt it. */
  orphan: boolean;
  at: number;
  items: QueuedEvent[];
}

export interface TransportDeps {
  tabId: string;
  locale(): 'th' | 'en';
  /** Visit of the context this tab is in (cookie scope). */
  currentVisit(): string | null;
  elapsedFor(sessionId: string): number | null;
  onDebug?(msg: string, data?: unknown): void;
}

export interface Transport {
  enqueue(item: QueuedEvent): void;
  /** `urgent` = page hiding/unloading: send now with keepalive, persist the rest now. */
  flush(urgent?: boolean): void;
  /** Written at pagehide. */
  persistNow(orphan: boolean): void;
  /** Take over backups left by closed tabs or earlier page loads. */
  adoptBackups(): void;
  /** bfcache restore: take our own backup back (or drop what another tab adopted). */
  reclaimOwn(): void;
  /** Opt-out / disabled: drop everything, including backups. */
  discardAll(removeOtherTabs: boolean): void;
  /** One-off request outside the queue (opt-out notice). */
  sendDirect(sessionId: string, visit: string | null, events: AnalyticsEvent[], optedOut: boolean): void;
  size(): number;
  stats(): { queued: number; inFlight: number; sent: number; dropped: number; failures: number; nextAttemptAt: number | null };
  dispose(): void;
}

function isQueued(x: unknown): x is QueuedEvent {
  const q = x as QueuedEvent | null;
  return !!q && typeof q.s === 'string' && (q.v === null || typeof q.v === 'string') && typeof q.n === 'number'
    && !!q.e && typeof q.e.event_id === 'string';
}

export function createTransport(env: TrackerEnv, deps: TransportDeps): Transport {
  let queue: QueuedEvent[] = [];
  /** event_id -> wall time before which it must not be retried. */
  const notBefore = new Map<string, number>();
  const inFlight = new Set<string>();
  let inFlightBytes = 0;
  let flushTimer: number | null = null;
  let persistTimer: number | null = null;
  let idleQueued = false;
  let disposed = false;
  let maxEvents = MAX_EVENTS_PER_BATCH;
  let sent = 0;
  let dropped = 0;
  let failures = 0;

  const backupKey = KEYS.queue(deps.tabId);

  /** Arm the flush timer for the earliest event that may be sent (fresh events: FLUSH_MS from now). */
  function schedule() {
    if (disposed || flushTimer !== null) return;
    const wall = env.wallNow();
    let due = Infinity;
    for (const q of queue) {
      if (inFlight.has(q.e.event_id)) continue;
      const nb = notBefore.get(q.e.event_id);
      due = Math.min(due, nb === undefined ? wall + FLUSH_MS : Math.max(nb, wall + 1_000));
    }
    if (due === Infinity) return;
    flushTimer = env.setTimer(() => {
      flushTimer = null;
      flush(false);
    }, Math.max(1_000, due - wall));
  }

  function persistSoon() {
    if (disposed || persistTimer !== null) return;
    persistTimer = env.setTimer(() => {
      persistTimer = null;
      persistNow(false);
    }, PERSIST_DEBOUNCE_MS);
  }

  function persistNow(orphan: boolean) {
    if (persistTimer !== null) { env.clearTimer(persistTimer); persistTimer = null; }
    if (queue.length === 0) { env.storage.remove(backupKey); return; }
    const backup: Backup = { tab: deps.tabId, orphan, at: env.wallNow(), items: queue.slice(-200) };
    env.storage.set(backupKey, backup);
  }

  function drop(ids: Set<string>, countAsDropped: boolean) {
    if (ids.size === 0) return;
    const before = queue.length;
    queue = queue.filter((q) => !ids.has(q.e.event_id));
    for (const id of ids) notBefore.delete(id);
    if (countAsDropped) dropped += before - queue.length;
    persistSoon();
  }

  function enqueue(item: QueuedEvent) {
    if (disposed) return;
    if (queue.some((q) => q.e.event_id === item.e.event_id)) return;
    queue.push(item);
    if (queue.length > MAX_QUEUE) {
      const overflow = queue.splice(0, queue.length - MAX_QUEUE);
      dropped += overflow.length;
      for (const q of overflow) notBefore.delete(q.e.event_id);
    }
    persistSoon();
    if (queue.length - inFlight.size >= FLUSH_AT && !idleQueued) {
      idleQueued = true;
      env.idle(() => { idleQueued = false; flush(false); }, 2_000);
    } else {
      schedule();
    }
  }

  /** Next batch: one session, events that are due and not already in flight. */
  function nextBatch(wall: number, byteBudget: number): { items: QueuedEvent[]; body: string } | null {
    const first = queue.find((q) => !inFlight.has(q.e.event_id) && (notBefore.get(q.e.event_id) ?? 0) <= wall);
    if (!first) return null;
    const sessionId = first.s;
    const items: QueuedEvent[] = [];
    const envelope = {
      session_id: sessionId,
      locale: deps.locale(),
      opted_out: false,
      // Not in AnalyticsBatchBody (zod strips it): lets the server place each
      // event in time as received_at - (sent_elapsed_ms - elapsed_ms), which a
      // retried or backed-up batch otherwise gets wrong.
      sent_elapsed_ms: deps.elapsedFor(sessionId) ?? undefined,
      events: [] as AnalyticsEvent[],
    };
    let bytes = JSON.stringify(envelope).length;
    for (const q of queue) {
      if (items.length >= maxEvents) break;
      if (q.s !== sessionId || inFlight.has(q.e.event_id) || (notBefore.get(q.e.event_id) ?? 0) > wall) continue;
      const size = JSON.stringify(q.e).length + 1;
      if (items.length > 0 && bytes + size > byteBudget) break;
      bytes += size;
      items.push(q);
    }
    envelope.events = items.map((q) => q.e);
    return { items, body: JSON.stringify(envelope) };
  }

  function sendBatch(items: QueuedEvent[], body: string, urgent: boolean) {
    const ids = new Set(items.map((q) => q.e.event_id));
    for (const id of ids) inFlight.add(id);
    inFlightBytes += body.length;
    const visit = items[0].v;
    // The guest cookie identifies a visit; send it only for the session of the
    // visit this tab is in, so no other session is ever linked to that visit.
    const credentials = visit !== null && visit === deps.currentVisit() ? 'same-origin' : 'omit';
    let done: Promise<{ status: number; retryAfterMs: number | null }>;
    try {
      done = env.send(BATCH_URL, body, { keepalive: true, credentials });
    } catch {
      done = Promise.resolve({ status: 0, retryAfterMs: null });
    }
    const finish = (status: number, retryAfterMs: number | null) => {
      inFlightBytes = Math.max(0, inFlightBytes - body.length);
      settle(ids, status, retryAfterMs, urgent);
    };
    done.then((res) => finish(res.status, res.retryAfterMs), () => finish(0, null));
  }

  function settle(ids: Set<string>, status: number, retryAfterMs: number | null, urgent: boolean) {
    for (const id of ids) inFlight.delete(id);
    if (disposed) return;
    deps.onDebug?.('batch', { status, events: ids.size });
    if (status >= 200 && status < 300) {
      failures = 0;
      sent += ids.size;
      drop(ids, false);
      if (maxEvents < MAX_EVENTS_PER_BATCH) maxEvents = Math.min(MAX_EVENTS_PER_BATCH, maxEvents * 2);
    } else if (status === 413 && ids.size > 1) {
      // Too large for this deployment: halve the batch and retry soon.
      maxEvents = Math.max(1, Math.floor(ids.size / 2));
    } else if (status === 400 || status === 401 || status === 403 || status === 413 || status === 422) {
      // The server will never accept this batch as sent: do not loop on it.
      drop(ids, true);
    } else {
      failures++;
      const wall = env.wallNow();
      const exhausted = new Set<string>();
      for (const q of queue) {
        if (!ids.has(q.e.event_id)) continue;
        // A page-hide attempt refused by the browser's keepalive quota is not a real try.
        if (!(urgent && status === 0)) q.n++;
        if (q.n >= MAX_TRIES) { exhausted.add(q.e.event_id); continue; }
        const backoff = status === 429 && retryAfterMs
          ? retryAfterMs
          : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, q.n - 1));
        notBefore.set(q.e.event_id, wall + backoff);
      }
      drop(exhausted, true);
      persistSoon();
    }
    schedule();
  }

  function flush(urgent = false) {
    if (disposed) return;
    if (flushTimer !== null) { env.clearTimer(flushTimer); flushTimer = null; }
    const wall = env.wallNow();
    if (urgent) {
      // Page is going away: start keepalive requests synchronously, within the
      // browser's shared 64 KB keepalive budget (minus what is already in flight).
      let budget = 60_000 - inFlightBytes;
      for (let i = 0; i < 2 && budget > 2_000; i++) {
        const b = nextBatch(wall, Math.min(MAX_BATCH_BYTES, budget));
        if (!b || b.items.length === 0) break;
        budget -= b.body.length;
        sendBatch(b.items, b.body, true);
      }
      persistNow(false);
      return;
    }
    // One request at a time while the page is alive.
    if (inFlight.size === 0) {
      const b = nextBatch(wall, MAX_BATCH_BYTES);
      if (b && b.items.length > 0) sendBatch(b.items, b.body, false);
    }
    schedule();
  }

  function readBackup(key: string): Backup | null {
    const b = env.storage.get<Backup | null>(key, null);
    if (!b || typeof b !== 'object' || !Array.isArray(b.items) || typeof b.at !== 'number') return null;
    return b;
  }

  return {
    enqueue,
    flush,
    persistNow,

    adoptBackups() {
      const wall = env.wallNow();
      for (const key of env.storage.keys(KEYS.queuePrefix)) {
        if (key === backupKey) continue;
        const b = readBackup(key);
        if (!b) { env.storage.remove(key); continue; }
        if (wall - b.at > BACKUP_TTL_MS) { env.storage.remove(key); continue; }
        if (!b.orphan && wall - b.at < ORPHAN_AFTER_MS) continue; // its tab is probably alive
        env.storage.remove(key);
        for (const item of b.items) if (isQueued(item)) enqueue({ ...item });
      }
      if (queue.length > 0) schedule();
    },

    reclaimOwn() {
      const own = readBackup(backupKey);
      if (own) {
        persistNow(false);
      } else if (queue.length > 0) {
        // Another tab adopted our backup while this page sat in the back/forward cache.
        const ids = new Set(queue.filter((q) => !inFlight.has(q.e.event_id)).map((q) => q.e.event_id));
        drop(ids, false);
      }
    },

    discardAll(removeOtherTabs) {
      queue = [];
      notBefore.clear();
      if (flushTimer !== null) { env.clearTimer(flushTimer); flushTimer = null; }
      if (persistTimer !== null) { env.clearTimer(persistTimer); persistTimer = null; }
      env.storage.remove(backupKey);
      if (removeOtherTabs) for (const key of env.storage.keys(KEYS.queuePrefix)) env.storage.remove(key);
    },

    sendDirect(sessionId, visit, events, optedOut) {
      const body = JSON.stringify({ session_id: sessionId, locale: deps.locale(), opted_out: optedOut, events });
      const credentials = visit !== null && visit === deps.currentVisit() ? 'same-origin' : 'omit';
      try {
        env.send(BATCH_URL, body, { keepalive: true, credentials }).catch(() => {});
      } catch { /* best effort */ }
    },

    size: () => queue.length,

    stats() {
      let next: number | null = null;
      for (const nb of notBefore.values()) next = next === null ? nb : Math.min(next, nb);
      return { queued: queue.length, inFlight: inFlight.size, sent, dropped, failures, nextAttemptAt: next };
    },

    dispose() {
      disposed = true;
      if (flushTimer !== null) env.clearTimer(flushTimer);
      if (persistTimer !== null) env.clearTimer(persistTimer);
      flushTimer = null;
      persistTimer = null;
    },
  };
}
