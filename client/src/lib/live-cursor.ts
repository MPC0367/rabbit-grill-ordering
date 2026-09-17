// The live client's event bookkeeping, kept free of React and the DOM so it
// can be tested on its own (test/unit/live-cursor.test.ts).
//
//  - `cursor` is the newest event id this page has accounted for; it is sent
//    as `since` when polling.
//  - `seen` drops duplicate deliveries (a replay overlapping a poll).
//  - The server's event ids restart when its database is restored or reset.
//    It then answers with a cursor BELOW ours (a `hello` that does not replay,
//    or a poll with `resync: true`), and, once the server sends one, a
//    different database `epoch`. Either way this page's history is void:
//    take the server's cursor and forget the ids we saw, or every recycled id
//    would be dropped as a "duplicate" and polling would resync forever.

export interface LiveCursor {
  cursor: number;
  seen: Set<number>;
  /** Database identity reported by the server, when it reports one. */
  epoch: string | null;
}

export const SEEN_MAX = 2000;
export const SEEN_KEEP = 1000;

export function createLiveCursor(): LiveCursor {
  return { cursor: 0, seen: new Set(), epoch: null };
}

/** Record a delivered event. False when it was already delivered. */
export function acceptEvent(s: LiveCursor, id: number): boolean {
  if (s.seen.has(id)) return false;
  s.seen.add(id);
  if (s.seen.size > SEEN_MAX) s.seen = new Set([...s.seen].slice(-SEEN_KEEP));
  if (id > s.cursor) s.cursor = id;
  return true;
}

export interface ServerCursor {
  /** The server's cursor (hello.cursor, poll.cursor, resync.cursor). */
  cursor: number;
  /** Poll: the `since` this answer is for. Defaults to the current cursor. */
  since?: number;
  /** Database identity, when the server sends one. */
  epoch?: string | null;
  /**
   * The server is stating where this page stands (`hello`, the `resync`
   * event, a poll answered with `resync: true`), so its cursor is taken as
   * it is instead of only moving ours forward.
   */
  authoritative?: boolean;
  /**
   * `hello` only: the server replayed from this page's own Last-Event-ID, so
   * its cursor is ours, not its newest event - a lower one is not a restore.
   */
  replay?: boolean;
}

/**
 * Take a cursor from the server. Returns true when the server's event
 * history was reset (restore / reset): the client state is then cleared and
 * follows the server; the caller should refetch everything.
 */
export function syncCursor(s: LiveCursor, server: ServerCursor): boolean {
  const cursor = Number(server.cursor);
  if (!Number.isFinite(cursor) || cursor < 0) return false;
  const epoch = server.epoch ?? null;
  const epochChanged = epoch !== null && s.epoch !== null && epoch !== s.epoch;
  if (epoch !== null) s.epoch = epoch;
  const behind = !server.replay && cursor < (server.since ?? s.cursor);
  if (epochChanged || behind) {
    s.cursor = cursor;
    s.seen = new Set();
    return true;
  }
  if (server.authoritative || cursor > s.cursor) s.cursor = cursor;
  return false;
}
