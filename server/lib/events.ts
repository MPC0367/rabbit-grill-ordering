// Transactional outbox + Server-Sent Events.
//
// emit() writes an `events` row inside the caller's transaction. Only after
// COMMIT is the in-process hub poked, and every SSE connection then reads new
// rows from the database. Events are invalidation signals (topic, entity id,
// version, a small summary) - clients refetch authoritative state, so a
// dropped connection or missed poke can never lose an order.
import { EventEmitter } from 'node:events';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { afterCommit, insert, many, one } from '../db/index.ts';
import { dbEpoch } from './meta.ts';
import { nowIso } from '../../shared/time.ts';
import type { Permission } from '../../shared/permissions.ts';

export type Audience = 'staff' | 'guest' | 'all';

export interface EventRow {
  id: number;
  topic: string;
  audience: Audience;
  visit_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  entity_version: number | null;
  payload: string;
  created_at: string;
}

export interface WireEvent {
  id: number;
  topic: string;
  visit_id: string | null;
  entity: { type: string | null; id: string | null; version: number | null };
  payload: Record<string, unknown>;
  at: string;
}

const hub = new EventEmitter();
hub.setMaxListeners(0);
let pokeScheduled = false;

/**
 * Topics (keep in sync with docs/API.md):
 *  order.created  order.updated  line.updated  service.updated  portion.updated
 *  bill.updated   payment.recorded  visit.opened  visit.updated  visit.closed
 *  table.updated  menu.updated  ordering.updated  report.updated  settings.updated
 */
export function emit(
  topic: string,
  opts: {
    audience?: Audience;
    visit_id?: string | null;
    entity?: { type: string; id: string; version?: number | null };
    payload?: Record<string, unknown>;
  } = {},
): void {
  insert('events', {
    topic,
    audience: opts.audience ?? 'staff',
    visit_id: opts.visit_id ?? null,
    entity_type: opts.entity?.type ?? null,
    entity_id: opts.entity?.id ?? null,
    entity_version: opts.entity?.version ?? null,
    payload: JSON.stringify(opts.payload ?? {}),
    created_at: nowIso(),
  });
  pokeStreams();
}

/**
 * Wake every open stream once the current transaction commits, so each
 * re-checks its access and reads new rows now rather than within 15 s.
 * emit() does this; session revocation calls it directly.
 */
export function pokeStreams(): void {
  afterCommit(() => {
    if (pokeScheduled) return;
    pokeScheduled = true;
    setImmediate(() => {
      pokeScheduled = false;
      hub.emit('poke');
    });
  });
}

function toWire(r: EventRow): WireEvent {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(r.payload); } catch { /* keep empty */ }
  return {
    id: r.id,
    topic: r.topic,
    visit_id: r.visit_id,
    entity: { type: r.entity_type, id: r.entity_id, version: r.entity_version },
    payload,
    at: r.created_at,
  };
}

export function latestEventId(): number {
  return one<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id ?? 0;
}

/**
 * `stillValid` is re-checked before every read: a stream ends (event
 * `access`, state `ended`) as soon as its session is revoked, the account is
 * deactivated or - for staff - the permissions the stream was filtered with
 * change. Staff streams say which: `ended` (sign in again) or `changed`
 * (reconnect to get the new topic filter).
 */
type Filter =
  | { kind: 'staff'; hiddenTopics: string[]; stillValid?: () => boolean; endState?: () => 'ended' | 'changed' }
  | { kind: 'guest'; visitId: string; stillValid: () => boolean };

function fetchSince(filter: Filter, cursor: number, limit = 200): EventRow[] {
  if (filter.kind === 'staff') {
    // Hidden topics are excluded in SQL, BEFORE the limit: filtering afterwards
    // let a run of >= `limit` hidden rows (e.g. many bill.updated events for a
    // kitchen tablet) come back empty forever, so the cursor never advanced and
    // new orders were never delivered, and the resync check miscounted.
    return many<EventRow>(
      `SELECT * FROM events WHERE id > :cursor AND audience IN ('staff','all')
         AND NOT EXISTS (SELECT 1 FROM json_each(:hidden) h WHERE substr(events.topic, 1, length(h.value)) = h.value)
       ORDER BY id LIMIT :limit`,
      { cursor, limit, hidden: filter.hiddenTopics },
    );
  }
  return many<EventRow>(
    `SELECT * FROM events WHERE id > :cursor AND audience IN ('guest','all')
       AND (visit_id IS NULL OR visit_id = :visit) ORDER BY id LIMIT :limit`,
    { cursor, visit: filter.visitId, limit },
  );
}

/** Topics hidden from roles without the matching permission. */
export function hiddenTopicsFor(has: (p: Permission) => boolean): string[] {
  const hidden: string[] = [];
  if (!has('payments.view')) hidden.push('payment.');
  if (!has('billing.view')) hidden.push('bill.');
  if (!has('reports.view')) hidden.push('report.');
  if (!has('settings.manage')) hidden.push('settings.');
  return hidden;
}

/**
 * Stream events to one client. Sends `hello` first (with the current cursor)
 * so the client knows to refetch; replays from Last-Event-ID when given.
 */
export function sseStream(c: Context, filter: Filter): Response {
  const headerId = Number(c.req.header('last-event-id') ?? c.req.query('since') ?? NaN);
  c.header('Cache-Control', 'no-store, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const latest = latestEventId();
    // A cursor beyond the newest event (the database was restored or reset since
    // the client last connected) would silently skip every new event until the
    // ids caught up: start from now instead; the client refetches on hello.
    const replay = Number.isFinite(headerId) && headerId >= 0 && headerId <= latest;
    let cursor = replay ? headerId : latest;
    let closed = false;
    let wake: (() => void) | null = null;
    const poke = () => { wake?.(); };
    hub.on('poke', poke);
    stream.onAbort(() => {
      closed = true;
      hub.off('poke', poke);
      wake?.();
    });

    // `epoch` identifies the database file: a client that reconnects to a
    // restored or reset database sees it change and starts from this cursor
    // instead of keeping its own event history (D-K-01).
    await stream.writeSSE({
      event: 'hello',
      id: String(cursor),
      data: JSON.stringify({ cursor, server_time: nowIso(), replay, epoch: dbEpoch() }),
      retry: 3000,
    });

    let lastBeat = Date.now();
    while (!closed) {
      if (filter.stillValid && !filter.stillValid()) {
        // 'changed': still signed in, but with other permissions - reconnect for the new topic filter.
        const state = filter.kind === 'staff' && filter.endState ? filter.endState() : 'ended';
        await stream.writeSSE({ event: 'access', data: JSON.stringify({ state }) });
        break;
      }
      let rows = fetchSince(filter, cursor);
      // Replay window exceeded: tell the client to refetch everything.
      if (rows.length >= 200) {
        cursor = latestEventId();
        await stream.writeSSE({ event: 'resync', id: String(cursor), data: JSON.stringify({ cursor }) });
        rows = [];
      }
      for (const r of rows) {
        cursor = r.id;
        await stream.writeSSE({ event: 'change', id: String(r.id), data: JSON.stringify(toWire(r)) });
      }
      if (Date.now() - lastBeat > 20_000) {
        await stream.write(': keep-alive\n\n');
        lastBeat = Date.now();
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 15_000);
        wake = () => { clearTimeout(t); wake = null; resolve(); };
      });
    }
    hub.off('poke', poke);
  }, async (err) => {
    console.error('[sse]', err.message);
  });
}

/** Poll endpoint equivalent for clients that cannot keep a stream open. */
export function eventsSince(filter: Filter, cursor: number): { cursor: number; events: WireEvent[]; resync: boolean; epoch: string | null } {
  // Same reset as sseStream: a cursor from a newer (pre-restore) database resyncs.
  const epoch = dbEpoch();
  const latest = latestEventId();
  if (cursor > latest) return { cursor: latest, events: [], resync: true, epoch };
  const rows = fetchSince(filter, cursor);
  if (rows.length >= 200) return { cursor: latestEventId(), events: [], resync: true, epoch };
  return { cursor: rows.at(-1)?.id ?? cursor, events: rows.map(toWire), resync: false, epoch };
}
