// Order submission safety (brief 13, 30, 31 scenarios 3 and 4; D-06, D-23):
// idempotent attempts, lost responses, concurrent rounds from two devices,
// and the "kitchen intake paused" / "bill being finalized" states.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { key, startServer, type Client, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

let srv: TestServer;
let manager: Client;
let kitchen: Client;
let floor: Client;
let cashier: Client;

before(async () => {
  // Every test client connects from 127.0.0.1; one trusted proxy hop lets each
  // simulated phone present its own address to the per-address join limit.
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  [manager, kitchen, floor, cashier] = await Promise.all([srv.staff('manager'), srv.staff('kitchen'), srv.staff('floor'), srv.staff('cashier')]);
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
type Line = { item_id: string; variant_id?: string | null; quantity: number; modifiers: Array<{ group_id: string; option_ids: string[] }>; note?: string };

const soup = (quantity = 1, note?: string): Line => ({ item_id: T.items.soup, quantity, modifiers: [], ...(note ? { note } : {}) });
const latte = (variant: string, quantity = 1): Line => ({ item_id: T.items.coffee, variant_id: variant, quantity, modifiers: [] });
const steak = (doneness: string, sides: string[], quantity = 1): Line => ({
  item_id: T.items.steak, quantity,
  modifiers: [{ group_id: T.groups.doneness, option_ids: [doneness] }, { group_id: T.groups.sides, option_ids: sides }],
});

let tableSeq = 0;
let deviceSeq = 0;

/** A fresh table with an open visit and one joined guest device (tests never share a visit). */
async function newParty(covers = 2) {
  const t = await manager.post('/api/staff/tables', { label: `ORD-${++tableSeq}` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const tableId: string = t.body.id;
  const [{ token }] = srv.sql<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [tableId]);
  const visit = await srv.openVisit(tableId, covers);
  const join = async (): Promise<Client> => {
    const c = srv.client();
    const n = ++deviceSeq;
    const r = await c.request('POST', '/api/public/qr/join', { token, pin: visit.join_pin }, { 'X-Forwarded-For': `10.1.${Math.floor(n / 250)}.${n % 250}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return c;
  };
  return { tableId, visit, join, guest: await join() };
}

function submit(c: Client, attempt: string, lines: Line[], expected: number) {
  return c.post('/api/guest/orders', { idempotency_key: attempt, lines, expected_subtotal_minor: expected });
}

function assist(visitId: string, attempt: string, lines: Line[], expected: number) {
  return floor.post('/api/staff/orders/assist', { visit_id: visitId, idempotency_key: attempt, lines, expected_subtotal_minor: expected });
}

function orderRows(visitId: string) {
  return srv.sql<{ id: string; reference: string; round_no: number; idempotency_key: string; subtotal_minor: number; guest_session_id: string | null }>(
    'SELECT id, reference, round_no, idempotency_key, subtotal_minor, guest_session_id FROM orders WHERE visit_id = ? ORDER BY round_no', [visitId]);
}

function visitLines(visitId: string) {
  return srv.sql<{ id: string; version: number; status: string; order_id: string }>(
    'SELECT id, version, status, order_id FROM order_lines WHERE visit_id = ? ORDER BY order_id, line_no', [visitId]);
}

async function transition(staff: Client, lineIds: string[], to: string) {
  const current = new Map(srv.sql<{ id: string; version: number }>(
    'SELECT id, version FROM order_lines WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(lineIds)]).map((r) => [r.id, r.version]));
  return staff.post('/api/staff/orders/transition', { lines: lineIds.map((id) => ({ id, version: current.get(id) })), to });
}

async function until<V>(probe: () => V | undefined | null | false, what: string, ms = 5_000): Promise<V> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ scenario 3
test('scenario 3: the same attempt sent 8 times concurrently and again later creates exactly one order', async () => {
  const { visit, guest } = await newParty();
  const attempt = key('att');
  const lines = [soup(2), latte(T.variants.iced)]; // 2 x 15000 + 9000
  const tabs = [guest, ...Array.from({ length: 7 }, () => guest.clone())];

  const results = await Promise.all(tabs.map((tab) => submit(tab, attempt, lines, 39_000)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201], JSON.stringify(results.map((r) => r.body)));
  assert.equal(results.filter((r) => r.body.replayed === false).length, 1, 'exactly one creation');
  assert.equal(new Set(results.map((r) => r.body.order.reference)).size, 1, 'one reference for every reply');
  assert.equal(new Set(results.map((r) => r.body.order.id)).size, 1);
  const [first] = results;
  assert.match(first.body.order.reference, /^RG-[2-9A-HJKMNP-TV-Z]{4,8}$/);
  assert.equal(first.body.order.subtotal_minor, 39_000);
  assert.equal(first.body.order.round_no, 1);

  // Exactly one order row with its two lines, one creation audit and one event.
  const rows = orderRows(visit.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].idempotency_key, attempt);
  assert.equal(visitLines(visit.id).length, 2);
  assert.equal(srv.sql('SELECT id FROM line_events WHERE visit_id = ?', [visit.id]).length, 2);
  assert.equal(srv.sql(`SELECT id FROM audit_events WHERE action = 'order.created' AND entity_id = ?`, [rows[0].id]).length, 1);
  assert.equal(srv.sql(`SELECT id FROM events WHERE topic = 'order.created' AND entity_id = ?`, [rows[0].id]).length, 1);

  // The same attempt again, later (a retry after a reconnect): same order back.
  await sleep(300);
  const again = await submit(guest.clone(), attempt, lines, 39_000);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.order.reference, rows[0].reference);
  assert.equal(again.body.order.id, rows[0].id);
  // Expected prices are not part of the attempt identity: a stale total still replays.
  const staleTotal = await submit(guest, attempt, lines, 1);
  assert.equal(staleTotal.status, 200);
  assert.equal(staleTotal.body.order.reference, rows[0].reference);

  assert.equal(orderRows(visit.id).length, 1);
  const list = await guest.get('/api/guest/orders');
  assert.equal(list.status, 200);
  assert.equal(list.body.orders.length, 1);
  assert.equal(list.body.orders[0].mine, true);
});

/**
 * Send a submission on a raw socket and never read the reply: the connection
 * is dropped once the server has committed (the phone lost signal just after
 * pressing Place order).
 */
async function sendAndDrop(c: Client, path: string, payload: unknown, committed: () => boolean): Promise<void> {
  const url = new URL(c.base + path);
  const data = JSON.stringify(payload);
  const req = http.request({
    host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-RG-Client': '1', Accept: 'application/json',
      Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Connection: 'close',
    },
  });
  req.on('error', () => { /* the dropped connection is the point */ });
  // No 'response' listener: Node discards the reply entirely.
  req.end(data);
  try {
    await until(committed, 'the dropped submission to commit');
  } finally {
    req.destroy();
  }
}

test('scenario 3: a lost response is recovered through GET /api/guest/orders/attempts/:key', async () => {
  const { visit, guest, join } = await newParty();

  // Before anything is sent, an unknown attempt is a definitive "not found".
  const unknown = await guest.get(`/api/guest/orders/attempts/${key('never')}`);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { status: 'not_found' });

  const attempt = key('lost');
  const lines = [steak(T.options.rare, [T.options.fries]), soup(1)]; // 59000 + 15000
  await sendAndDrop(guest, '/api/guest/orders', { idempotency_key: attempt, lines, expected_subtotal_minor: 74_000 },
    () => orderRows(visit.id).some((o) => o.idempotency_key === attempt));
  const [row] = orderRows(visit.id);

  // The page reloads (same browser) and first asks what happened to the attempt.
  const tab = guest.clone();
  const lookup = await tab.get(`/api/guest/orders/attempts/${attempt}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.status, 'created');
  assert.equal(lookup.body.order.reference, row.reference);
  assert.equal(lookup.body.order.id, row.id);
  assert.equal(lookup.body.order.subtotal_minor, 74_000);
  assert.equal(lookup.body.order.lines.length, 2);
  assert.equal(lookup.body.order.mine, true);

  // Re-sending the pending attempt returns the same order instead of a second one.
  const retry = await submit(tab, attempt, lines, 74_000);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.order.reference, row.reference);

  // Another phone at the same table sees the round, but not as its own.
  const other = await join();
  const seen = await other.get(`/api/guest/orders/attempts/${attempt}`);
  assert.equal(seen.body.status, 'created');
  assert.equal(seen.body.order.mine, false);

  // A guest of a different visit cannot resolve (or learn about) this attempt.
  const stranger = await newParty();
  const foreign = await stranger.guest.get(`/api/guest/orders/attempts/${attempt}`);
  assert.equal(foreign.status, 200);
  assert.deepEqual(foreign.body, { status: 'not_found' });
  // Without visit access the lookup is refused outright.
  const anonymous = await srv.client().get(`/api/guest/orders/attempts/${attempt}`);
  assert.equal(anonymous.status, 401);
  // A malformed key is a validation error, not "not found".
  const malformed = await guest.get('/api/guest/orders/attempts/short');
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.error.code, 'validation_failed');

  assert.equal(orderRows(visit.id).length, 1);
  assert.equal(visitLines(visit.id).length, 2);
});

test('scenario 3: the same key with a different payload is refused with idempotency_mismatch', async () => {
  const { visit, guest } = await newParty();
  const attempt = key('mm');
  const lines = [steak(T.options.rare, [T.options.fries, T.options.salad])]; // 59000 + 0 + 12000
  const first = await submit(guest, attempt, lines, 71_000);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const reference = first.body.order.reference;

  // The same food with its choices listed in another order is the same attempt.
  const reordered: Line[] = [{
    item_id: T.items.steak, quantity: 1,
    modifiers: [{ group_id: T.groups.sides, option_ids: [T.options.salad, T.options.fries] }, { group_id: T.groups.doneness, option_ids: [T.options.rare] }],
  }];
  const same = await submit(guest, attempt, reordered, 71_000);
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.order.reference, reference);

  const variants: Array<[string, Line[], number]> = [
    ['different quantity', [steak(T.options.rare, [T.options.fries, T.options.salad], 2)], 142_000],
    ['different choice', [steak(T.options.medium, [T.options.fries, T.options.salad])], 71_000],
    ['added note', [{ ...lines[0], note: 'no pepper' }], 71_000],
    ['different dish', [soup(1)], 15_000],
    ['extra line', [...lines, soup(1)], 86_000],
  ];
  // Sent concurrently from several tabs: every one is refused, none creates anything.
  const replies = await Promise.all(variants.map(([, l, total]) => submit(guest.clone(), attempt, l, total)));
  replies.forEach((r, i) => {
    assert.equal(r.status, 409, `${variants[i][0]}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'idempotency_mismatch', variants[i][0]);
    assert.equal(r.body.error.details.reference, reference);
  });

  const rows = orderRows(visit.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subtotal_minor, 71_000);
  const dbLines = srv.sql<{ quantity: number; note: string | null; item_id: string }>('SELECT quantity, note, item_id FROM order_lines WHERE visit_id = ?', [visit.id]);
  assert.deepEqual(dbLines.map((r) => ({ ...r })), [{ quantity: 1, note: null, item_id: T.items.steak }]);

  // A deliberate new round uses a new key and is accepted.
  const next = await submit(guest, key('mm2'), [soup(1)], 15_000);
  assert.equal(next.status, 201);
  assert.equal(next.body.order.round_no, 2);

  // Keys are scoped to the dining visit: another table reusing the same key places its own order.
  const elsewhere = await newParty();
  const theirs = await submit(elsewhere.guest, attempt, [soup(1)], 15_000);
  assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
  assert.notEqual(theirs.body.order.reference, reference);
  assert.equal(orderRows(visit.id).length, 2);
});

// ------------------------------------------------------------------ scenario 4
test('scenario 4: two devices submitting different attempts concurrently get separate rounds on one bill', async () => {
  const party = await newParty(4);
  const phoneA = party.guest;
  const phoneB = await party.join();
  const sends: Array<{ phone: Client; attempt: string; lines: Line[]; total: number; who: 'A' | 'B' }> = [
    { phone: phoneA, attempt: key('a1'), lines: [soup(1)], total: 15_000, who: 'A' },
    { phone: phoneB, attempt: key('b1'), lines: [latte(T.variants.hot, 2)], total: 16_000, who: 'B' },
    { phone: phoneA, attempt: key('a2'), lines: [latte(T.variants.iced)], total: 9_000, who: 'A' },
    { phone: phoneB, attempt: key('b2'), lines: [steak(T.options.medium, [T.options.salad])], total: 62_000, who: 'B' },
    { phone: phoneA.clone(), attempt: key('a3'), lines: [soup(2)], total: 30_000, who: 'A' },
    { phone: phoneB.clone(), attempt: key('b3'), lines: [soup(1), latte(T.variants.hot)], total: 23_000, who: 'B' },
  ];
  const replies = await Promise.all(sends.map((s) => submit(s.phone, s.attempt, s.lines, s.total)));
  replies.forEach((r) => {
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.replayed, false);
  });
  assert.equal(new Set(replies.map((r) => r.body.order.reference)).size, 6, 'no attempt was suppressed');
  assert.deepEqual(replies.map((r) => r.body.order.round_no).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  replies.forEach((r, i) => assert.equal(r.body.order.subtotal_minor, sends[i].total));

  const rows = orderRows(party.visit.id);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.round_no), [1, 2, 3, 4, 5, 6]);
  for (const s of sends) {
    const row = rows.find((r) => r.idempotency_key === s.attempt);
    assert.ok(row, `round for ${s.attempt}`);
    assert.equal(row.subtotal_minor, s.total);
  }
  // Two distinct guest sessions placed them (A: 3 rounds, B: 3 rounds).
  const bySession = new Map<string | null, number>();
  for (const r of rows) bySession.set(r.guest_session_id, (bySession.get(r.guest_session_id) ?? 0) + 1);
  assert.deepEqual([...bySession.values()].sort(), [3, 3]);

  // Both phones see the whole table's rounds, oldest first, each marked "mine" correctly.
  for (const [phone, who] of [[phoneA, 'A'], [phoneB, 'B']] as const) {
    const list = await phone.get('/api/guest/orders');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.orders.map((o: { round_no: number }) => o.round_no), [1, 2, 3, 4, 5, 6]);
    for (const o of list.body.orders as Array<{ reference: string; mine: boolean }>) {
      const i = replies.findIndex((r) => r.body.order.reference === o.reference);
      assert.equal(o.mine, sends[i].who === who, `${who} sees ${o.reference}`);
    }
  }

  // One shared bill: waiting lines are shown separately, then counted once accepted.
  const pending = await phoneA.get('/api/guest/bill');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.pending_lines.length, 7);
  assert.equal(pending.body.subtotal_minor, 0);
  const accept = await transition(kitchen, visitLines(party.visit.id).map((l) => l.id), 'accepted');
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  const billA = await phoneA.get('/api/guest/bill');
  const billB = await phoneB.get('/api/guest/bill');
  const expectedTotal = sends.reduce((s, x) => s + x.total, 0); // 155000
  assert.equal(expectedTotal, 155_000);
  for (const bill of [billA, billB]) {
    assert.equal(bill.body.pending_lines.length, 0);
    assert.equal(bill.body.lines.length, 7);
    assert.equal(bill.body.subtotal_minor, 155_000);
    assert.equal(bill.body.total_minor, 155_000);
  }
});

test('scenario 4: identical carts sent as different attempts are separate rounds, never deduplicated by content', async () => {
  const party = await newParty(2);
  const phoneA = party.guest;
  const phoneB = await party.join();
  const same = [soup(1), latte(T.variants.hot)]; // 23000
  const replies = await Promise.all([
    submit(phoneA, key('same'), same, 23_000),
    submit(phoneB, key('same'), same, 23_000),
    submit(phoneA.clone(), key('same'), same, 23_000), // the same guest deliberately ordering it again
  ]);
  replies.forEach((r) => assert.equal(r.status, 201, JSON.stringify(r.body)));
  assert.equal(new Set(replies.map((r) => r.body.order.id)).size, 3);
  assert.equal(orderRows(party.visit.id).length, 3);
  assert.equal(visitLines(party.visit.id).length, 6);
});

test('state matrix: a restaurant pause racing with submissions leaves a consistent state', async () => {
  const party = await newParty();
  const phones = [party.guest, await party.join(), await party.join()];
  try {
    const racers = Array.from({ length: 9 }, (_, i) => submit(phones[i % 3], key('race'), [soup(1)], 15_000));
    const pause = manager.patch('/api/staff/ordering', { enabled: false, reason: 'Race check' });
    const results = await Promise.all([...racers, pause]);
    const pauseReply = results.pop()!;
    assert.equal(pauseReply.status, 200, JSON.stringify(pauseReply.body));
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);
    for (const r of refused) {
      assert.equal(r.status, 423, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'ordering_paused');
    }
    // Exactly the accepted submissions exist, all committed before the pause.
    const rows = orderRows(party.visit.id);
    assert.equal(rows.length, created.length);
    assert.deepEqual(rows.map((r) => r.reference).sort(), created.map((r) => r.body.order.reference).sort());
    const [pausedAt] = srv.sql<{ created_at: string }>(`SELECT created_at FROM audit_events WHERE action = 'ordering.paused' ORDER BY id DESC LIMIT 1`);
    for (const r of created) assert.ok(r.body.order.submitted_at <= pausedAt.created_at, 'no order was created after the pause committed');
    // After the pause, nothing gets through.
    const late = await submit(party.guest, key('race-late'), [soup(1)], 15_000);
    assert.equal(late.body.error.code, 'ordering_paused');
  } finally {
    const resume = await manager.patch('/api/staff/ordering', { enabled: true });
    assert.equal(resume.status, 200);
  }
});

// ------------------------------------------------------------------ state matrix: kitchen intake paused
test('state matrix: kitchen intake paused blocks new rounds while existing work and replays continue', async () => {
  const party = await newParty();
  const neighbour = await newParty();
  const before = key('pre');
  const pre = await submit(party.guest, before, [soup(1)], 15_000);
  assert.equal(pre.status, 201);

  // Only a role with ordering.pause may pause intake.
  const denied = await floor.patch('/api/staff/ordering', { enabled: false, reason: 'try' });
  assert.equal(denied.status, 403);

  try {
    const pause = await manager.patch('/api/staff/ordering', { enabled: false, reason: 'Kitchen is backed up' });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    assert.equal(pause.body.enabled, false);
    const config = await srv.client().get('/api/public/config');
    assert.equal(config.body.ordering.enabled, false);
    assert.ok(config.body.ordering.paused_message.en.length > 0, 'guests get the pause message');

    // New submissions are clearly blocked, for every table and for staff-assisted rounds.
    const blocked = await Promise.all([
      submit(party.guest, key('p1'), [soup(1)], 15_000),
      submit(neighbour.guest, key('p2'), [latte(T.variants.hot)], 8_000),
      assist(party.visit.id, key('p3'), [soup(1)], 15_000),
    ]);
    for (const r of blocked) {
      assert.equal(r.status, 423, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'ordering_paused');
    }
    // A pause is shown before any cart review, even for a cart that would not price.
    const staleCart = await submit(party.guest, key('p4'), [soup(1)], 1);
    assert.equal(staleCart.body.error.code, 'ordering_paused');

    // Replaying the pre-pause attempt still returns its order.
    const replay = await submit(party.guest, before, [soup(1)], 15_000);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.order.reference, pre.body.order.reference);

    // Existing work keeps moving through the kitchen.
    const [line] = visitLines(party.visit.id);
    for (const to of ['accepted', 'preparing', 'almost_done', 'ready']) {
      const r = await transition(kitchen, [line.id], to);
      assert.equal(r.status, 200, `${to}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.orders[0].lines[0].status, to);
    }
    const served = await transition(floor, [line.id], 'served');
    assert.equal(served.status, 200);

    assert.equal(orderRows(party.visit.id).length, 1);
    assert.equal(orderRows(neighbour.visit.id).length, 0);
  } finally {
    const resume = await manager.patch('/api/staff/ordering', { enabled: true, reason: 'Caught up' });
    assert.equal(resume.status, 200);
    assert.equal(resume.body.enabled, true);
  }

  const afterResume = await submit(party.guest, key('post'), [soup(1)], 15_000);
  assert.equal(afterResume.status, 201);
  assert.equal(afterResume.body.order.round_no, 2);
  assert.ok(srv.sql(`SELECT id FROM audit_events WHERE action = 'ordering.paused'`).length >= 1);
  assert.ok(srv.sql(`SELECT id FROM audit_events WHERE action = 'ordering.resumed'`).length >= 1);
  assert.ok(srv.sql(`SELECT id FROM events WHERE topic = 'ordering.updated' AND audience = 'all'`).length >= 2);
});

test('state matrix: the intake limit pauses new rounds automatically until the backlog is accepted', async () => {
  const party = await newParty();
  const first = key('il');
  assert.equal((await submit(party.guest, first, [soup(1)], 15_000)).status, 201);
  // Earlier tests left unaccepted rounds on open visits: the limit is set relative to the live backlog.
  const state = await floor.get('/api/staff/ordering');
  assert.equal(state.status, 200);
  const backlog: number = state.body.backlog;
  assert.ok(backlog >= 1);
  try {
    const set = await manager.patch('/api/staff/ordering', { intake_limit: backlog + 1, reason: 'Busy night' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.intake_limit, backlog + 1);
    assert.equal(set.body.intake_full, false);

    assert.equal((await submit(party.guest, key('il2'), [soup(1)], 15_000)).status, 201);
    const full = await floor.get('/api/staff/ordering');
    assert.equal(full.body.backlog, backlog + 1);
    assert.equal(full.body.intake_full, true);

    const [guestTry, staffTry, replay] = await Promise.all([
      submit(party.guest, key('il3'), [soup(1)], 15_000),
      assist(party.visit.id, key('il4'), [soup(1)], 15_000),
      submit(party.guest, first, [soup(1)], 15_000),
    ]);
    assert.equal(guestTry.status, 423);
    assert.equal(guestTry.body.error.code, 'intake_full');
    assert.equal(staffTry.status, 423);
    assert.equal(staffTry.body.error.code, 'intake_full');
    assert.equal(replay.status, 200, 'a replay is never blocked by the limit');
    assert.equal(orderRows(party.visit.id).length, 2);

    // Accepting this table's two rounds frees capacity.
    assert.equal((await transition(kitchen, visitLines(party.visit.id).map((l) => l.id), 'accepted')).status, 200);
    const freed = await submit(party.guest, key('il5'), [soup(1)], 15_000);
    assert.equal(freed.status, 201, JSON.stringify(freed.body));
  } finally {
    const reset = await manager.patch('/api/staff/ordering', { intake_limit: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.intake_limit, null);
  }
});

test('state matrix: a paused table answers table_paused while other tables keep ordering', async () => {
  const paused = await newParty();
  const open = await newParty();
  const before = key('tp');
  assert.equal((await submit(paused.guest, before, [soup(1)], 15_000)).status, 201);
  const tileVersion = async () => {
    const tables = await manager.get('/api/staff/tables');
    return tables.body.tables.find((t: { id: string }) => t.id === paused.tableId).version as number;
  };

  const denied = await floor.patch(`/api/staff/tables/${paused.tableId}`, { ordering_paused: true, version: await tileVersion() });
  assert.equal(denied.status, 403);

  try {
    const pause = await manager.patch(`/api/staff/tables/${paused.tableId}`, { ordering_paused: true, version: await tileVersion() });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    assert.equal(pause.body.ordering_paused, true);

    const [guestTry, staffTry, otherTable, replay] = await Promise.all([
      submit(paused.guest, key('tp1'), [soup(1)], 15_000),
      assist(paused.visit.id, key('tp2'), [soup(1)], 15_000),
      submit(open.guest, key('tp3'), [soup(1)], 15_000),
      submit(paused.guest, before, [soup(1)], 15_000),
    ]);
    assert.equal(guestTry.status, 423);
    assert.equal(guestTry.body.error.code, 'table_paused');
    assert.equal(staffTry.status, 423);
    assert.equal(staffTry.body.error.code, 'table_paused');
    assert.equal(otherTable.status, 201, JSON.stringify(otherTable.body));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(orderRows(paused.visit.id).length, 1);
  } finally {
    const resume = await manager.patch(`/api/staff/tables/${paused.tableId}`, { ordering_paused: false, version: await tileVersion() });
    assert.equal(resume.status, 200);
  }
  const later = await submit(paused.guest, key('tp4'), [soup(1)], 15_000);
  assert.equal(later.status, 201);
});

// ------------------------------------------------------------------ state matrix: bill being finalized
test('state matrix: a visit in billing refuses new rounds until a manager reopens it', async () => {
  const party = await newParty();
  const second = await party.join();
  const before = key('bf');
  assert.equal((await submit(party.guest, before, [soup(1)], 15_000)).status, 201);
  assert.equal((await transition(kitchen, visitLines(party.visit.id).map((l) => l.id), 'accepted')).status, 200);

  const visitVersion = (await floor.get(`/api/staff/visits/${party.visit.id}`)).body.version as number;
  const start = await cashier.post(`/api/staff/visits/${party.visit.id}/billing/start`, { version: visitVersion });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.visit_status, 'billing');

  // Every new attempt, from any device or from staff, is refused; nothing is created.
  const tries = await Promise.all([
    submit(party.guest, key('bf1'), [soup(1)], 15_000),
    submit(second, key('bf2'), [latte(T.variants.iced)], 9_000),
    submit(second.clone(), key('bf3'), [soup(2)], 30_000),
    assist(party.visit.id, key('bf4'), [soup(1)], 15_000),
  ]);
  for (const r of tries) {
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'visit_billing');
  }
  // A retry of the attempt made before checkout started still gets its order.
  const replay = await submit(party.guest, before, [soup(1)], 15_000);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);

  const finalize = await cashier.post(`/api/staff/visits/${party.visit.id}/bill/finalize`, { bill_version: start.body.bill_version, expected_total_minor: 15_000 });
  assert.equal(finalize.status, 200, JSON.stringify(finalize.body));
  assert.equal(finalize.body.revision_no, 1);
  const stillBlocked = await submit(second, key('bf5'), [soup(1)], 15_000);
  assert.equal(stillBlocked.body.error.code, 'visit_billing');
  const guestBill = await second.get('/api/guest/bill');
  assert.equal(guestBill.body.visit_status, 'billing');
  assert.equal(guestBill.body.total_minor, 15_000);
  assert.equal(orderRows(party.visit.id).length, 1);

  // Reopening needs a manager and a reason; then the table can order again.
  const cashierReopen = await cashier.post(`/api/staff/visits/${party.visit.id}/billing/reopen`, { version: finalize.body.visit_version, reason: 'Guests want dessert' });
  assert.equal(cashierReopen.status, 403);
  const reopen = await manager.post(`/api/staff/visits/${party.visit.id}/billing/reopen`, { version: finalize.body.visit_version, reason: 'Guests want dessert' });
  assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
  assert.equal(reopen.body.visit_status, 'open');
  const afterReopen = await submit(second, key('bf6'), [soup(1)], 15_000);
  assert.equal(afterReopen.status, 201, JSON.stringify(afterReopen.body));
  assert.equal(afterReopen.body.order.round_no, 2);
  assert.equal(orderRows(party.visit.id).length, 2);
});
