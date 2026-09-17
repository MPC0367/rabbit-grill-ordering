// Realtime catch-up (brief 28, 30 "network reconnect", 31 scenario 12; D-03):
// events are an outbox committed with the change, streamed over SSE with ids,
// replayed from Last-Event-ID, mirrored by the poll endpoint, scoped to the
// visit, and never carry notes, PINs or tokens.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { key, startServer, type Client, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

let srv: TestServer;
let manager: Client;
let kitchen: Client;
let floor: Client;

// Secrets and private text used anywhere in this file; the last test proves none reached an event.
const secretNotes: string[] = [];
const secretPins: string[] = [];
const wireSeen: string[] = [];

before(async () => {
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  [manager, kitchen, floor] = await Promise.all([srv.staff('manager'), srv.staff('kitchen'), srv.staff('floor')]);
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
let tableSeq = 0;
let deviceSeq = 0;

async function newParty() {
  const t = await manager.post('/api/staff/tables', { label: `RT-${++tableSeq}` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const tableId: string = t.body.id;
  const [{ token }] = srv.sql<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [tableId]);
  const visit = await srv.openVisit(tableId, 2);
  secretPins.push(visit.join_pin);
  const join = async (): Promise<Client> => {
    const c = srv.client();
    const n = ++deviceSeq;
    const r = await c.request('POST', '/api/public/qr/join', { token, pin: visit.join_pin }, { 'X-Forwarded-For': `10.3.${Math.floor(n / 250)}.${n % 250}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return c;
  };
  return { tableId, token, visit, join, guest: await join() };
}

function submitSoup(c: Client, note?: string) {
  if (note) secretNotes.push(note);
  return c.post('/api/guest/orders', {
    idempotency_key: key('rt'),
    lines: [{ item_id: T.items.soup, quantity: 1, modifiers: [], ...(note ? { note, allergy_note: true } : {}) }],
    expected_subtotal_minor: 15_000,
  });
}

async function until<V>(probe: () => V | undefined | null | false, what: string, ms = 5_000): Promise<V> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SseMessage { event: string; id: string | null; data: string }
interface Wire { id: number; topic: string; visit_id: string | null; entity: { type: string | null; id: string | null; version: number | null }; payload: Record<string, unknown>; at: string }

/** A real EventSource-like reader over fetch streaming (the client's LiveProvider uses the same wire format). */
function openStream(c: Client, path: string, lastEventId?: number) {
  const controller = new AbortController();
  const messages: SseMessage[] = [];
  let status = 0;
  let ended = false;
  let failure: Error | null = null;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  const pump = (async () => {
    const res = await fetch(c.base + path, { headers, signal: controller.signal });
    status = res.status;
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + value).replace(/\r\n/g, '\n');
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const msg: SseMessage = { event: 'message', id: null, data: '' };
        const data: string[] = [];
        let fields = 0;
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue; // comments are keep-alives
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          fields++;
          if (field === 'event') msg.event = value;
          else if (field === 'id') msg.id = value;
          else if (field === 'data') data.push(value);
        }
        if (fields === 0) continue;
        msg.data = data.join('\n');
        messages.push(msg);
        wireSeen.push(block);
      }
    }
  })().catch((err: Error) => {
    // Aborts are how streams are closed; anything else (the server stopping
    // after a failed assertion) is kept for inspection, never left unhandled.
    if (err.name !== 'AbortError') failure = err;
  }).finally(() => { ended = true; });
  return {
    messages,
    get status() { return status; },
    get ended() { return ended; },
    get failure() { return failure; },
    changes(): Wire[] {
      return messages.filter((m) => m.event === 'change').map((m) => JSON.parse(m.data) as Wire);
    },
    next(pred: (m: SseMessage) => boolean, what: string, ms = 5_000): Promise<SseMessage> {
      return until(() => messages.find(pred), what, ms);
    },
    change(pred: (w: Wire) => boolean, what: string, ms = 5_000): Promise<Wire> {
      return until(() => this.changes().find(pred), what, ms);
    },
    async close() {
      controller.abort();
      await pump;
      assert.equal(failure, null, `stream ${path} failed: ${failure?.message}`);
    },
  };
}

// ------------------------------------------------------------------ scenario 12 (guest)
test('scenario 12: a guest stream that was down catches the missed order.created through Last-Event-ID and the poll endpoint', async () => {
  const party = await newParty();
  const secondPhone = await party.join();

  const first = openStream(party.guest, '/api/guest/events');
  const hello = await first.next((m) => m.event === 'hello', 'hello');
  assert.equal(first.status, 200);
  const helloBody = JSON.parse(hello.data);
  const cursor: number = helloBody.cursor;
  assert.equal(hello.id, String(cursor), 'hello carries the cursor as its event id');
  assert.equal(helloBody.replay, false);
  assert.ok(Number.isInteger(cursor) && cursor > 0);
  // The stream drops (tunnel, sleep, Wi-Fi hand-over).
  await first.close();
  await sleep(50);

  // Meanwhile the order goes through plain HTTP from the other phone.
  const note = `rt-note-${key('n')} no peanuts`;
  const placed = await submitSoup(secondPhone, note);
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = placed.body.order;
  // Committed before any broadcast: the outbox row exists.
  const [row] = srv.sql<{ id: number; entity_version: number; audience: string }>(
    `SELECT id, entity_version, audience FROM events WHERE topic = 'order.created' AND entity_id = ?`, [order.id]);
  assert.ok(row.id > cursor);
  assert.equal(row.audience, 'all');

  // Reconnecting with Last-Event-ID replays what was missed.
  const second = openStream(party.guest, '/api/guest/events', cursor);
  const hello2 = JSON.parse((await second.next((m) => m.event === 'hello', 'hello 2')).data);
  assert.equal(hello2.cursor, cursor);
  assert.equal(hello2.replay, true);
  const missed = await second.change((w) => w.topic === 'order.created' && w.entity.id === order.id, 'missed order.created');
  assert.equal(missed.id, row.id);
  assert.deepEqual(missed.entity, { type: 'order', id: order.id, version: 1 });
  assert.equal(missed.visit_id, party.visit.id);
  assert.equal(missed.payload.reference, order.reference);
  assert.equal(missed.payload.round_no, 1);
  const msg = second.messages.find((m) => m.event === 'change' && JSON.parse(m.data).id === missed.id)!;
  assert.equal(msg.id, String(missed.id), 'the SSE id field is the event id');
  // Replayed events arrive in id order, each once.
  const ids = second.changes().map((w) => w.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id > cursor));

  // While connected, later changes arrive live with increasing entity versions.
  const lineId = order.lines[0].id as string;
  let version = order.lines[0].version as number;
  for (const to of ['accepted', 'preparing']) {
    const r = await kitchen.post('/api/staff/orders/transition', { lines: [{ id: lineId, version }], to });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    version = r.body.orders[0].lines[0].version;
  }
  const lineEvents = await until(() => {
    const got = second.changes().filter((w) => w.topic === 'line.updated' && w.entity.id === order.id);
    return got.length >= 2 ? got : undefined;
  }, 'two live line.updated events');
  assert.deepEqual(lineEvents.map((w) => w.payload.to), ['accepted', 'preparing']);
  assert.deepEqual(lineEvents.map((w) => w.entity.version), [2, 3], 'entity versions let clients drop stale events');
  const current = await party.guest.get('/api/guest/orders');
  assert.equal(current.body.orders[0].version, 3);
  assert.equal(current.body.orders[0].lines[0].status, 'preparing');
  await second.close();

  // A fresh connection without Last-Event-ID starts at "now" (the client refetches on hello).
  const fresh = openStream(party.guest, '/api/guest/events');
  const hello3 = JSON.parse((await fresh.next((m) => m.event === 'hello', 'hello 3')).data);
  assert.ok(hello3.cursor >= lineEvents[1].id);
  assert.equal(hello3.replay, false);
  await sleep(300);
  assert.equal(fresh.changes().filter((w) => w.entity.id === order.id).length, 0);
  await fresh.close();

  // The polling fallback returns the same event from the same cursor.
  const poll = await party.guest.get(`/api/guest/events/poll?since=${cursor}`);
  assert.equal(poll.status, 200);
  assert.equal(poll.body.resync, false);
  const polled = (poll.body.events as Wire[]).find((w) => w.topic === 'order.created' && w.entity.id === order.id);
  assert.ok(polled, 'poll returns the missed order.created');
  assert.equal(polled.id, row.id);
  assert.equal(polled.entity.version, 1);
  assert.ok(poll.body.cursor >= lineEvents[1].id);
  const drained = await party.guest.get(`/api/guest/events/poll?since=${poll.body.cursor}`);
  assert.equal((drained.body.events as Wire[]).filter((w) => w.entity.id === order.id).length, 0);

  // Another table's guest never sees this visit's events, live or polled.
  const stranger = await newParty();
  const strangerPoll = await stranger.guest.get(`/api/guest/events/poll?since=${cursor}`);
  assert.equal(strangerPoll.status, 200);
  assert.ok((strangerPoll.body.events as Wire[]).every((w) => w.visit_id === null || w.visit_id === stranger.visit.id));
  const strangerStream = openStream(stranger.guest, '/api/guest/events', cursor);
  await strangerStream.next((m) => m.event === 'hello', 'stranger hello');
  await sleep(300);
  assert.ok(strangerStream.changes().every((w) => w.visit_id === null || w.visit_id === stranger.visit.id));
  await strangerStream.close();
  // And without visit access there is no stream at all.
  const anonymous = openStream(srv.client(), '/api/guest/events');
  await until(() => anonymous.ended, 'anonymous stream to end');
  assert.equal(anonymous.status, 401);
});

// ------------------------------------------------------------------ scenario 12 (staff)
test('scenario 12: the staff board catches up after a disconnect and a live stream sees new orders after commit', async () => {
  const party = await newParty();

  const board = openStream(kitchen, '/api/staff/events');
  const cursor: number = JSON.parse((await board.next((m) => m.event === 'hello', 'staff hello')).data).cursor;
  await board.close();

  const missedOrder = await submitSoup(party.guest, `staff-rt-${key('n')} gluten free please`);
  assert.equal(missedOrder.status, 201);

  const reconnect = openStream(kitchen, '/api/staff/events', cursor);
  const missed = await reconnect.change((w) => w.topic === 'order.created' && w.entity.id === missedOrder.body.order.id, 'staff missed order.created');
  assert.equal(missed.entity.version, 1);
  assert.equal(missed.payload.reference, missedOrder.body.order.reference);
  assert.equal(missed.payload.table_label, `RT-${tableSeq}`);
  assert.equal(missed.payload.item_count, 1);
  assert.equal(missed.payload.source, 'guest');

  // Still connected: a second round appears live, after its commit.
  const liveOrder = await submitSoup(party.guest);
  assert.equal(liveOrder.status, 201);
  const live = await reconnect.change((w) => w.topic === 'order.created' && w.entity.id === liveOrder.body.order.id, 'live order.created');
  assert.ok(live.id > missed.id);
  assert.equal(live.payload.round_no, 2);
  // What the event points at is already readable (commit before broadcast).
  const detail = await kitchen.get(`/api/staff/orders/${live.entity.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.reference, liveOrder.body.order.reference);
  await reconnect.close();

  // Poll fallback for staff returns both rounds from the same cursor.
  const poll = await kitchen.get(`/api/staff/events/poll?since=${cursor}`);
  assert.equal(poll.status, 200);
  const created = (poll.body.events as Wire[]).filter((w) => w.topic === 'order.created' && w.visit_id === party.visit.id);
  assert.deepEqual(created.map((w) => w.entity.id), [missedOrder.body.order.id, liveOrder.body.order.id]);
  assert.ok(created.every((w) => w.entity.version === 1));

  // Role filtering: the kitchen never receives bill events, a manager does.
  const seenBill = await manager.get(`/api/staff/visits/${party.visit.id}/bill`);
  const adjust = await manager.post(`/api/staff/visits/${party.visit.id}/adjustments`, {
    kind: 'correction', amount_minor: 100, reason: 'Event filter check', idempotency_key: key('adj'), bill_version: seenBill.body.bill_version,
  });
  assert.equal(adjust.status, 200, JSON.stringify(adjust.body));
  const managerPoll = await manager.get(`/api/staff/events/poll?since=${cursor}`);
  assert.ok((managerPoll.body.events as Wire[]).some((w) => w.topic === 'bill.updated' && w.visit_id === party.visit.id));
  const kitchenPoll = await kitchen.get(`/api/staff/events/poll?since=${cursor}`);
  assert.ok((kitchenPoll.body.events as Wire[]).length > 0);
  assert.ok((kitchenPoll.body.events as Wire[]).every((w) => !w.topic.startsWith('bill.') && !w.topic.startsWith('payment.')));
  // Without a staff session there is no staff stream.
  const anonymous = await srv.client().get(`/api/staff/events/poll?since=${cursor}`);
  assert.equal(anonymous.status, 401);
});

test('a run of more than 200 events hidden from a role never stalls that role\'s stream or poll cursor', async () => {
  const party = await newParty();
  const [{ start }] = srv.sql<{ start: number }>('SELECT MAX(id) AS start FROM events');

  // 205 bill adjustments in a row: 205 consecutive bill.updated events, which the kitchen may not see.
  // Each carries the bill version the one before it returned (D-S8-01), so they are sent in order.
  let billVersion = (await manager.get(`/api/staff/visits/${party.visit.id}/bill`)).body.bill_version as number;
  for (let i = 0; i < 205; i++) {
    const r = await manager.post(`/api/staff/visits/${party.visit.id}/adjustments`, {
      kind: 'correction', amount_minor: 1, reason: `Filter window ${i}`, idempotency_key: key('adj'), bill_version: billVersion,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    billVersion = r.body.bill_version as number;
  }
  const hidden = srv.sql(`SELECT id FROM events WHERE id > ? AND topic = 'bill.updated'`, [start]);
  assert.equal(hidden.length, 205);

  // Then a new round arrives: the kitchen must get it.
  const placed = await submitSoup(party.guest);
  assert.equal(placed.status, 201);
  const orderId = placed.body.order.id as string;

  // Poll: a client follows the returned cursor; within a few polls the order must appear.
  let cursor = start;
  let found: Wire | undefined;
  for (let i = 0; i < 5 && !found; i++) {
    const poll = await kitchen.get(`/api/staff/events/poll?since=${cursor}`);
    assert.equal(poll.status, 200);
    assert.ok((poll.body.events as Wire[]).every((w) => !w.topic.startsWith('bill.')));
    found = (poll.body.events as Wire[]).find((w) => w.topic === 'order.created' && w.entity.id === orderId);
    if (poll.body.resync) break; // a resync also resolves the gap: the board refetches everything
    cursor = poll.body.cursor;
  }
  assert.ok(found, `kitchen poll never delivered the order (stuck at cursor ${cursor})`);

  // Stream: replaying from the same cursor reaches the order too.
  const stream = openStream(kitchen, '/api/staff/events', start);
  await stream.change((w) => w.topic === 'order.created' && w.entity.id === orderId, 'kitchen stream to pass the hidden run');
  assert.ok(stream.changes().every((w) => !w.topic.startsWith('bill.')));
  await stream.close();

  // A role that does see the 205 events is told to resync instead of replaying them.
  const managerPoll = await manager.get(`/api/staff/events/poll?since=${start}`);
  assert.equal(managerPoll.body.resync, true);
  assert.ok(managerPoll.body.cursor >= found.id);
});

test('a client cursor ahead of the server (database restored from a backup) is reset instead of silently skipping new orders', async () => {
  const party = await newParty();
  const [{ latest }] = srv.sql<{ latest: number }>('SELECT MAX(id) AS latest FROM events');
  // A tablet that was connected before the restore reconnects with its old, higher Last-Event-ID.
  const ahead = latest + 10_000;

  const stream = openStream(kitchen, '/api/staff/events', ahead);
  const hello = await stream.next((m) => m.event === 'hello', 'hello');
  const helloBody = JSON.parse(hello.data);
  assert.ok(helloBody.cursor <= latest, `hello cursor ${helloBody.cursor} must not exceed the newest event ${latest}`);
  assert.equal(hello.id, String(helloBody.cursor), 'the SSE id resets the browser\'s Last-Event-ID');
  const placed = await submitSoup(party.guest);
  assert.equal(placed.status, 201);
  await stream.change((w) => w.topic === 'order.created' && w.entity.id === placed.body.order.id, 'order.created after the cursor reset');
  await stream.close();

  // The poll endpoint tells such a client to resync and hands back the real cursor.
  for (const [client, path] of [[kitchen, '/api/staff/events/poll'], [party.guest, '/api/guest/events/poll']] as const) {
    const poll = await client.get(`${path}?since=${ahead}`);
    assert.equal(poll.status, 200);
    assert.equal(poll.body.resync, true, `${path} resync`);
    assert.ok(poll.body.cursor < ahead, `${path} cursor reset`);
    const again = await client.get(`${path}?since=${poll.body.cursor}`);
    assert.equal(again.body.resync, false);
  }
});

// ------------------------------------------------------------------ privacy of event payloads
test('events carry ids and versions only: no note text, PIN or QR token in any payload', async () => {
  const party = await newParty();
  const phone = party.guest;
  const watcher = openStream(manager, '/api/staff/events');
  const guestWatcher = openStream(phone, '/api/guest/events');
  await watcher.next((m) => m.event === 'hello', 'manager hello');
  await guestWatcher.next((m) => m.event === 'hello', 'guest hello');

  // Activity that stores private text or secrets next to an event.
  const orderNote = `order-secret-${key('n')} แพ้ถั่ว severe`;
  const placed = await submitSoup(phone, orderNote);
  assert.equal(placed.status, 201);
  const serviceNote = `service-secret-${key('n')} please bring a high chair`;
  secretNotes.push(serviceNote);
  const service = await phone.post('/api/guest/service', { type: 'call_staff', note: serviceNote, idempotency_key: key('svc') });
  assert.ok(service.status === 201 || service.status === 200, JSON.stringify(service.body));
  const portionNote = `portion-secret-${key('n')} end cut please`;
  secretNotes.push(portionNote);
  const portion = await phone.post('/api/guest/portions', { item_id: T.items.rib, note: portionNote, idempotency_key: key('por') });
  assert.equal(portion.status, 201, JSON.stringify(portion.body));
  // Staff weigh the cut (with a note of their own) and the guest confirms it.
  const quoteNote = `quote-secret-${key('n')} trimmed fat cap`;
  secretNotes.push(quoteNote);
  const quoted = await kitchen.post(`/api/staff/portions/${portion.body.id}/quote`, { grams: 371, note: quoteNote, version: portion.body.version });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.quote.amount_minor, 181_790); // 371 g x 49000 / 100 g
  const confirmed = await phone.post(`/api/guest/portions/${portion.body.id}/confirm`, { quote_id: quoted.body.quote.id, revision: quoted.body.quote.revision, idempotency_key: key('pcf') });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body)); // creates the order line
  assert.equal(confirmed.body.order.lines[0].line_total_minor, 181_790);
  assert.equal(confirmed.body.order.lines[0].measured_grams, 371);
  const visitVersion = (await floor.get(`/api/staff/visits/${party.visit.id}`)).body.version as number;
  const rotated = await floor.post(`/api/staff/visits/${party.visit.id}/rotate-pin`, { version: visitVersion });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.match(rotated.body.join_pin, /^\d{4}$/);
  secretPins.push(rotated.body.join_pin);

  await watcher.change((w) => w.topic === 'portion.updated' && w.visit_id === party.visit.id, 'portion event on the staff stream');
  await guestWatcher.change((w) => w.topic === 'service.updated', 'service event on the guest stream');
  await sleep(200);
  await watcher.close();
  await guestWatcher.close();

  // Every outbox row written by this whole file.
  const rows = srv.sql<{ id: number; topic: string; payload: string; entity_version: number | null; entity_id: string | null }>('SELECT id, topic, payload, entity_version, entity_id FROM events ORDER BY id');
  assert.ok(rows.length > 20, `expected a busy outbox, got ${rows.length}`);
  const forbiddenKeys = new Set(['pin', 'join_pin', 'token', 'qr_token', 'note', 'notes', 'password', 'payment_reference', 'reference_no']);
  const tokens = srv.sql<{ token: string }>('SELECT token FROM table_qr_tokens').map((t) => t.token);
  const walk = (value: unknown, path: string, topic: string): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, topic)); return; }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        assert.ok(!forbiddenKeys.has(k.toLowerCase()), `${topic}: payload key ${path}.${k} is private`);
        walk(v, `${path}.${k}`, topic);
      }
      return;
    }
    const text = String(value);
    for (const pin of secretPins) assert.notEqual(text, pin, `${topic}: ${path} equals a join PIN`);
    for (const note of secretNotes) assert.ok(!text.includes(note.slice(0, 20)), `${topic}: ${path} contains note text`);
    for (const token of tokens) assert.ok(!text.includes(token), `${topic}: ${path} contains a QR token`);
  };
  for (const r of rows) {
    walk(JSON.parse(r.payload), 'payload', r.topic);
    for (const note of secretNotes) assert.ok(!r.payload.includes(note.slice(0, 20)), `event ${r.id} (${r.topic}) leaks a note`);
    assert.ok(!r.payload.includes(party.token), `event ${r.id} leaks the QR token`);
  }
  // Order, line, service and portion events identify their entity and its version.
  for (const r of rows.filter((x) => /^(order|line|service|portion)\./.test(x.topic) && !x.payload.includes('"transferred"'))) {
    assert.ok(r.entity_id, `event ${r.id} (${r.topic}) names its entity`);
    assert.ok(Number.isInteger(r.entity_version) && (r.entity_version as number) >= 1, `event ${r.id} (${r.topic}) has a version`);
  }
  // The raw SSE text that reached clients in this file is just as clean.
  assert.ok(wireSeen.length > 10);
  for (const block of wireSeen) {
    for (const note of secretNotes) assert.ok(!block.includes(note.slice(0, 20)), 'SSE text leaks a note');
    for (const token of tokens) assert.ok(!block.includes(token), 'SSE text leaks a QR token');
    assert.ok(!/"(join_)?pin"\s*:/.test(block), 'SSE text carries a PIN field');
  }
  // The notes themselves were stored for the kitchen, so the check above is meaningful.
  assert.equal(srv.sql('SELECT id FROM order_lines WHERE note = ?', [orderNote]).length, 1);
});
