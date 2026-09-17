// The live client's cursor and duplicate bookkeeping (client/src/lib/live-cursor.ts),
// including the database-restore case: the server's event ids restart below the
// page's cursor, and the page must follow the server instead of keeping its maximum.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptEvent, createLiveCursor, SEEN_KEEP, SEEN_MAX, syncCursor } from '../../client/src/lib/live-cursor.ts';

/** A stand-in for server/lib/events.ts eventsSince(): ids 1..latest, 200-row window. */
function fakePoll(latest: number, since: number) {
  if (since > latest) return { cursor: latest, events: [] as number[], resync: true };
  const ids: number[] = [];
  for (let id = since + 1; id <= latest; id++) ids.push(id);
  if (ids.length >= 200) return { cursor: latest, events: [] as number[], resync: true };
  return { cursor: ids.at(-1) ?? since, events: ids, resync: false };
}

/** One poll round as LiveProvider.poll runs it. */
function pollOnce(s: ReturnType<typeof createLiveCursor>, latest: number) {
  const since = s.cursor;
  const r = fakePoll(latest, since);
  const reset = syncCursor(s, { cursor: r.cursor, since });
  const delivered = r.events.filter((id) => acceptEvent(s, id));
  return { resync: r.resync || reset, reset, delivered };
}

describe('acceptEvent', () => {
  test('drops duplicates and advances the cursor', () => {
    const s = createLiveCursor();
    assert.equal(acceptEvent(s, 5), true);
    assert.equal(acceptEvent(s, 5), false);
    assert.equal(acceptEvent(s, 3), true); // late but new
    assert.equal(s.cursor, 5);
  });

  test('keeps the seen set bounded', () => {
    const s = createLiveCursor();
    for (let id = 1; id <= SEEN_MAX + 1; id++) acceptEvent(s, id);
    assert.equal(s.seen.size, SEEN_KEEP);
    assert.equal(s.seen.has(SEEN_MAX + 1), true);
    assert.equal(s.cursor, SEEN_MAX + 1);
  });
});

describe('syncCursor', () => {
  test('ordinary hello and poll answers only move the cursor forward', () => {
    const s = createLiveCursor();
    assert.equal(syncCursor(s, { cursor: 40 }), false); // first hello
    assert.equal(s.cursor, 40);
    assert.equal(syncCursor(s, { cursor: 40 }), false); // replaying hello (Last-Event-ID)
    assert.equal(syncCursor(s, { cursor: 55, since: 40 }), false); // poll
    assert.equal(s.cursor, 55);
    acceptEvent(s, 56);
    assert.equal(syncCursor(s, { cursor: 70 }), false); // 'resync' after a big gap
    assert.equal(s.cursor, 70);
    assert.equal(s.seen.has(56), true);
  });

  test('a hello below the cursor (restored database) resets cursor and seen ids', () => {
    const s = createLiveCursor();
    syncCursor(s, { cursor: 90 });
    for (const id of [91, 92, 93]) acceptEvent(s, id);
    // Server restarted on a backup whose newest event is 60.
    assert.equal(syncCursor(s, { cursor: 60 }), true);
    assert.equal(s.cursor, 60);
    assert.equal(s.seen.size, 0);
    // New events reuse ids this page saw before the restore: all delivered.
    assert.deepEqual([61, 91, 92].map((id) => acceptEvent(s, id)), [true, true, true]);
  });

  test('a changed database epoch resets even when ids happen to be ahead', () => {
    const s = createLiveCursor();
    syncCursor(s, { cursor: 10, epoch: 'a' });
    acceptEvent(s, 11);
    assert.equal(syncCursor(s, { cursor: 500, epoch: 'a' }), false);
    assert.equal(syncCursor(s, { cursor: 800, epoch: 'b' }), true);
    assert.equal(s.cursor, 800);
    assert.equal(s.seen.has(11), false);
    // A server that stops sending an epoch does not trigger a reset.
    assert.equal(syncCursor(s, { cursor: 800 }), false);
  });

  test('ignores malformed cursors', () => {
    const s = createLiveCursor();
    syncCursor(s, { cursor: 12 });
    assert.equal(syncCursor(s, { cursor: Number.NaN }), false);
    assert.equal(syncCursor(s, { cursor: -1 }), false);
    assert.equal(s.cursor, 12);
  });
});

describe('polling across a database restore', () => {
  test('recovers after one resync and delivers events with recycled ids', () => {
    const s = createLiveCursor();
    let latest = 120;
    pollOnce(s, latest); // catch-up
    assert.equal(s.cursor, 120);
    latest = 125;
    assert.deepEqual(pollOnce(s, latest).delivered, [121, 122, 123, 124, 125]);

    // Restore a backup taken at event 100; the page keeps polling.
    latest = 100;
    const first = pollOnce(s, latest);
    assert.equal(first.resync, true);
    assert.equal(first.reset, true);
    assert.equal(s.cursor, 100);

    // New activity reuses ids 101..123. Before the fix every poll resynced
    // (since=125 > latest) and none of these were delivered.
    latest = 123;
    const next = pollOnce(s, latest);
    assert.equal(next.resync, false);
    assert.deepEqual(next.delivered, Array.from({ length: 23 }, (_, i) => 101 + i));
    assert.equal(pollOnce(s, latest).resync, false);
  });

  test('a large gap resyncs without resetting', () => {
    const s = createLiveCursor();
    syncCursor(s, { cursor: 10 });
    acceptEvent(s, 10);
    const r = pollOnce(s, 900);
    assert.equal(r.resync, true);
    assert.equal(r.reset, false);
    assert.equal(s.cursor, 900);
    assert.equal(s.seen.has(10), true);
  });
});
