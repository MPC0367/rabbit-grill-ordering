// Engagement tracker - pseudonymous browsing sessions.
//
// One session per browser *context*: the public menu is one context and each
// dining visit is its own context, so identity never crosses visits. Tabs of
// the same browser in the same context share the session (localStorage), so
// a reload or a second tab continues it instead of inventing a new "person".
//
// A session ends after SESSION_TIMEOUT_MS without activity, when the visit
// changes, when the visit closes (endVisit) or on opt-out. Ids are random
// (`ans_…`), never derived from the device: no fingerprinting.
import type { TrackerEnv } from './tracker-env.ts';

export const SESSION_TIMEOUT_MS = 30 * 60_000;
/** The API caps elapsed_ms at 24 h; rotate well before that. */
const MAX_SESSION_ELAPSED_MS = 20 * 3_600_000;
/** Session records untouched for this long are deleted at start-up. */
const RECORD_TTL_MS = 24 * 3_600_000;
const SEEN_CAP = 1000;
const ENDED_CAP = 20;
const TOUCH_WRITE_MS = 5_000;

const PREFIX = 'rg.analytics.';
export const KEYS = {
  optOut: `${PREFIX}optout`,
  lease: `${PREFIX}leader`,
  ended: `${PREFIX}ended`,
  sessionPrefix: `${PREFIX}s.`,
  seenPrefix: `${PREFIX}seen.`,
  queuePrefix: `${PREFIX}q.`,
  session: (ctx: string) => `${PREFIX}s.${ctx}`,
  seen: (sessionId: string) => `${PREFIX}seen.${sessionId}`,
  queue: (tabId: string) => `${PREFIX}q.${tabId}`,
  all: PREFIX,
} as const;

interface SessionRecord {
  v: 1;
  id: string;
  visit: string | null;
  startedWall: number;
  /** Wall time of the last activity (interaction or event) in any tab. */
  lastWall: number;
  /** elapsed_ms as of `savedWall`; a new page continues from here. */
  elapsed: number;
  savedWall: number;
  /** Next event sequence number. */
  seq: number;
}

/** Per-session de-duplication: item impressions, category views, depth thresholds. */
export type SeenKind = 'i' | 'c' | 'd';
type Seen = Record<SeenKind, string[]>;

interface LiveSession {
  id: string;
  visit: string | null;
  /** elapsed_ms at `anchor` (monotonic). */
  base: number;
  anchor: number;
  /** Monotonic time of this page's last write of lastWall (writes are throttled). */
  lastTouchWrite: number;
}

export interface Allocation {
  sessionId: string;
  visit: string | null;
  seq: number;
  elapsed: number;
}

export interface Sessions {
  /** Context known and not suspended (an ended visit suspends until the context changes). */
  ready(): boolean;
  contextKnown(): boolean;
  contextVisit(): string | null;
  /** Returns true when the context actually changed. */
  setContext(visit: string | null): boolean;
  /** Current session id, creating/rotating as needed; null when not ready. */
  currentId(): string | null;
  /** Current session id only if one already exists and is fresh (never creates). */
  peekId(): string | null;
  allocate(): Allocation | null;
  touch(): void;
  hasSeen(kind: SeenKind, key: string): boolean;
  /** Marks and returns true when the key was not seen before in this session. */
  markSeen(kind: SeenKind, key: string): boolean;
  /** Session record for `sessionId` still exists: elapsed_ms right now, else null. */
  elapsedFor(sessionId: string): number | null;
  /** Forget the current context's session (after its session_end); an ended visit stays suspended. */
  endCurrent(): void;
  refreshEnded(): void;
  isEnded(visit: string): boolean;
  clearAll(): void;
  janitor(): void;
}

function isRecord(x: unknown): x is SessionRecord {
  const r = x as SessionRecord | null;
  return !!r && r.v === 1 && typeof r.id === 'string' && typeof r.seq === 'number' && typeof r.lastWall === 'number'
    && typeof r.elapsed === 'number' && typeof r.savedWall === 'number' && (r.visit === null || typeof r.visit === 'string');
}

export function createSessions(env: TrackerEnv): Sessions {
  const store = env.storage;
  let known = false;
  let visit: string | null = null;
  let live: LiveSession | null = null;
  let seenCache: { id: string; seen: Seen } | null = null;
  let ended = new Set<string>(readEnded());

  function readEnded(): string[] {
    const v = store.get<unknown>(KEYS.ended, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  const ctxKey = () => KEYS.session(visit ?? 'public');

  function readRecord(): SessionRecord | null {
    const r = store.get<unknown>(ctxKey(), null);
    return isRecord(r) && r.visit === visit ? r : null;
  }

  function recordElapsed(r: SessionRecord, wall: number): number {
    return r.elapsed + Math.max(0, wall - r.savedWall);
  }

  function fresh(r: SessionRecord, wall: number): boolean {
    return wall - r.lastWall <= SESSION_TIMEOUT_MS && recordElapsed(r, wall) <= MAX_SESSION_ELAPSED_MS;
  }

  function adopt(r: SessionRecord, now: number, wall: number): LiveSession {
    return {
      id: r.id,
      visit: r.visit,
      base: recordElapsed(r, wall),
      anchor: now,
      lastTouchWrite: -Infinity,
    };
  }

  function elapsedNow(s: LiveSession, now: number): number {
    return Math.max(0, Math.floor(s.base + (now - s.anchor)));
  }

  function ready(): boolean {
    return known && !(visit !== null && ended.has(visit));
  }

  /** Resolve the live session and its stored record, rotating when stale. */
  function resolve(): { s: LiveSession; r: SessionRecord } | null {
    if (!ready()) return null;
    const now = env.now();
    const wall = env.wallNow();
    let r = readRecord();
    // The inactivity timeout is judged on the shared record (another tab may
    // have kept the session alive); only the elapsed cap is checked per page.
    const liveStale = live !== null && elapsedNow(live, now) > MAX_SESSION_ELAPSED_MS;
    if (r && fresh(r, wall) && !(live && r.id === live.id && liveStale)) {
      // Our session, or one another tab of this browser started in the same context.
      if (!live || live.id !== r.id) live = adopt(r, now, wall);
      return { s: live, r };
    }
    if (r) store.remove(KEYS.seen(r.id));
    if (live && live.id !== r?.id) store.remove(KEYS.seen(live.id));
    // A visit another tab already closed must not get a new session here.
    if (visit !== null) {
      ended = new Set(readEnded());
      if (ended.has(visit)) { live = null; return null; }
    }
    r = { v: 1, id: env.newId('ans'), visit, startedWall: wall, lastWall: wall, elapsed: 0, savedWall: wall, seq: 0 };
    store.set(ctxKey(), r);
    live = { id: r.id, visit, base: 0, anchor: now, lastTouchWrite: now };
    seenCache = null;
    return { s: live, r };
  }

  function loadSeen(id: string): Seen {
    const raw = store.get<Partial<Seen> | null>(KEYS.seen(id), null);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const seen: Seen = { i: list(raw?.i), c: list(raw?.c), d: list(raw?.d) };
    // Keep entries this page marked even if another tab's write raced ours.
    if (seenCache && seenCache.id === id) {
      for (const k of ['i', 'c', 'd'] as const) {
        for (const v of seenCache.seen[k]) if (!seen[k].includes(v)) seen[k].push(v);
      }
    }
    seenCache = { id, seen };
    return seen;
  }

  return {
    ready,
    contextKnown: () => known,
    contextVisit: () => visit,

    setContext(next) {
      if (known && visit === next) return false;
      known = true;
      visit = next;
      live = null;
      seenCache = null;
      return true;
    },

    currentId: () => resolve()?.s.id ?? null,

    peekId() {
      if (!ready()) return null;
      const r = readRecord();
      return r && fresh(r, env.wallNow()) ? r.id : null;
    },

    allocate() {
      const got = resolve();
      if (!got) return null;
      const { s, r } = got;
      const now = env.now();
      const wall = env.wallNow();
      const elapsed = elapsedNow(s, now);
      const seq = r.seq;
      store.set(ctxKey(), { ...r, seq: seq + 1, elapsed, savedWall: wall, lastWall: wall });
      s.lastTouchWrite = now;
      return { sessionId: s.id, visit: s.visit, seq, elapsed };
    },

    touch() {
      if (!ready() || !live) return;
      const now = env.now();
      if (now - live.lastTouchWrite < TOUCH_WRITE_MS) return;
      const r = readRecord();
      if (!r || r.id !== live.id) return;
      const wall = env.wallNow();
      live.lastTouchWrite = now;
      store.set(ctxKey(), { ...r, lastWall: wall, elapsed: elapsedNow(live, now), savedWall: wall });
    },

    hasSeen(kind, key) {
      const id = resolve()?.s.id;
      if (!id) return true;
      return loadSeen(id)[kind].includes(key);
    },

    markSeen(kind, key) {
      const id = resolve()?.s.id;
      if (!id) return false;
      const seen = loadSeen(id);
      if (seen[kind].includes(key)) return false;
      seen[kind].push(key);
      if (seen[kind].length > SEEN_CAP) seen[kind] = seen[kind].slice(-SEEN_CAP);
      store.set(KEYS.seen(id), seen);
      return true;
    },

    elapsedFor(sessionId) {
      const now = env.now();
      if (live && live.id === sessionId) return elapsedNow(live, now);
      for (const key of store.keys(KEYS.sessionPrefix)) {
        const r = store.get<unknown>(key, null);
        if (isRecord(r) && r.id === sessionId) return Math.floor(recordElapsed(r, env.wallNow()));
      }
      return null;
    },

    endCurrent() {
      if (!known) return;
      const r = readRecord();
      if (r) {
        store.remove(ctxKey());
        store.remove(KEYS.seen(r.id));
      }
      if (live) store.remove(KEYS.seen(live.id));
      live = null;
      seenCache = null;
      if (visit !== null) {
        ended = new Set(readEnded());
        ended.add(visit);
        store.set(KEYS.ended, [...ended].slice(-ENDED_CAP));
      }
    },

    refreshEnded() {
      ended = new Set(readEnded());
      if (visit !== null && ended.has(visit)) live = null;
    },

    isEnded: (v) => ended.has(v),

    clearAll() {
      for (const key of store.keys(KEYS.all)) if (key !== KEYS.optOut) store.remove(key);
      live = null;
      seenCache = null;
      ended = new Set();
    },

    janitor() {
      const wall = env.wallNow();
      const liveIds = new Set<string>();
      for (const key of store.keys(KEYS.sessionPrefix)) {
        const r = store.get<unknown>(key, null);
        if (!isRecord(r) || wall - r.lastWall > RECORD_TTL_MS) store.remove(key);
        else liveIds.add(r.id);
      }
      for (const key of store.keys(KEYS.seenPrefix)) {
        if (!liveIds.has(key.slice(KEYS.seenPrefix.length))) store.remove(key);
      }
    },
  };
}
