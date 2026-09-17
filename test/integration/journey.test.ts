// Brief 31 scenarios 1 and 2: the critical guest/staff journey over real HTTP.
//
//  1. Staff open a table, a guest joins from its QR + PIN, customises the
//     steak (required doneness, included / upgraded / paid sides), submits,
//     and follows every staff milestone on the guest tracker with the times
//     staff actually recorded (Almost done only where staff entered it).
//  2. A second device joins the same table: private carts and submissions,
//     shared rounds with per-device `mine` flags, and ONE combined bill.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, key, startServer, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';
import type { GuestBillDTO, OrderDTO, OrderLineDTO, QuoteDTO, StaffBillDTO, StaffOrderDTO, VisitDetailDTO } from '../../shared/dto.ts';

let srv: TestServer;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
const G = T.groups;
const O = T.options;

/** Steak with a doneness and the given sides. */
const steak = (quantity: number, doneness: string, sides: string[]) => ({
  item_id: T.items.steak,
  quantity,
  modifiers: [
    { group_id: G.doneness, option_ids: [doneness] },
    ...(sides.length ? [{ group_id: G.sides, option_ids: sides }] : []),
  ],
});

async function openTable(staff: Client, tableId: string, covers: number): Promise<VisitDetailDTO> {
  const r = await staff.post<VisitDetailDTO>(`/api/staff/tables/${tableId}/visits`, { covers, idempotency_key: key('open') });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function joinTable(c: Client, tableId: string, pin?: string) {
  return c.post('/api/public/qr/join', { token: T.tokens[tableId], ...(pin ? { pin } : {}) });
}

/** Move lines of one order to `to` using the versions staff currently see. */
async function advance(staff: Client, orderId: string, lineIds: string[], to: string, expectStatus = 200) {
  const cur = await staff.get<StaffOrderDTO>(`/api/staff/orders/${orderId}`);
  assert.equal(cur.status, 200, JSON.stringify(cur.body));
  const lines = lineIds.map((id) => {
    const l = cur.body.lines.find((x) => x.id === id);
    assert.ok(l, `line ${id} not on order ${orderId}`);
    return { id, version: l.version };
  });
  const res = await staff.post('/api/staff/orders/transition', { lines, to }); // { orders } or { error }
  assert.equal(res.status, expectStatus, JSON.stringify(res.body));
  return res;
}

async function guestOrder(guest: Client, orderId: string): Promise<OrderDTO> {
  const r = await guest.get<{ orders: OrderDTO[] }>('/api/guest/orders');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body.orders.find((x) => x.id === orderId);
  assert.ok(o, 'the guest tracker lists the order');
  return o;
}

const stepNames = (l: OrderLineDTO) => l.steps.map((s) => s.status);
const lineById = (o: OrderDTO, id: string) => {
  const l = o.lines.find((x) => x.id === id);
  assert.ok(l, `line ${id}`);
  return l;
};

interface LineTimes {
  id: string; status: string; submitted_at: string; accepted_at: string | null; preparing_at: string | null;
  almost_done_at: string | null; ready_at: string | null; served_at: string | null;
}
const COLUMN: Record<string, keyof LineTimes> = {
  submitted: 'submitted_at', accepted: 'accepted_at', preparing: 'preparing_at',
  almost_done: 'almost_done_at', ready: 'ready_at', served: 'served_at',
};

/** Every step the guest sees carries exactly the time stored for that milestone. */
function assertStepTimesMatchDb(o: OrderDTO) {
  const rows = srv.sql<LineTimes>(
    'SELECT id, status, submitted_at, accepted_at, preparing_at, almost_done_at, ready_at, served_at FROM order_lines WHERE order_id = ?',
    [o.id],
  );
  for (const l of o.lines) {
    const row = rows.find((r) => r.id === l.id)!;
    assert.equal(row.status, l.status);
    for (const s of l.steps) assert.equal(s.at, row[COLUMN[s.status]], `${l.id} ${s.status} time`);
    // Milestones without a step have no stored time (nothing invented).
    for (const [status, col] of Object.entries(COLUMN)) {
      if (!l.steps.some((s) => s.status === status)) assert.equal(row[col], null, `${l.id} ${status} must not have a time`);
    }
    const times = l.steps.map((s) => Date.parse(s.at));
    assert.deepEqual([...times].sort((a, b) => a - b), times, 'steps are in time order');
  }
}

// ------------------------------------------------------------------ scenario 1
test('scenario 1: a T01 guest joins by QR + PIN, orders a customised steak, and the tracker follows every staff milestone', async () => {
  const floor = await srv.staff('floor');
  const kitchen = await srv.staff('kitchen'); // a separate staff device
  const visit = await openTable(floor, 'tbl_T01', 2);
  assert.match(visit.join_pin ?? '', /^\d{4}$/);
  assert.equal(visit.table.label, 'T01');
  assert.equal(visit.table.state, 'dining');

  // Scan: the table is recognised, a PIN is needed, nothing private is revealed.
  const guest = srv.client();
  const scan = await guest.post('/api/public/qr/resolve', { token: T.tokens.tbl_T01 });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body, { table_label: 'T01', state: 'ready', pin_required: true, already_joined: false });

  const noPin = await joinTable(guest, 'tbl_T01');
  assert.equal(noPin.status, 401);
  assert.equal(noPin.body.error.code, 'pin_required');
  assert.equal(guest.cookies.has('rg_guest'), false);

  const joined = await joinTable(guest, 'tbl_T01', visit.join_pin!);
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.visit.id, visit.id);
  assert.equal(joined.body.visit.table_label, 'T01');
  assert.deepEqual(joined.body.ordering, { allowed: true, reason: null });
  assert.ok(guest.cookies.has('rg_guest'));
  // D-04: the guest credential is an HttpOnly, SameSite=Lax cookie for the whole site.
  const setCookie = joined.headers.getSetCookie().find((c) => c.startsWith('rg_guest='))!;
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\/(;|$)/i);
  const rescan = await guest.post('/api/public/qr/resolve', { token: T.tokens.tbl_T01 });
  assert.deepEqual(rescan.body, { table_label: 'T01', state: 'ready', pin_required: false, already_joined: true });
  const session = await guest.get('/api/guest/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.guest_id, joined.body.guest_id);

  // The public menu advertises the steak's choice rules.
  const menu = await guest.get('/api/public/menu');
  const menuSteak = menu.body.items.find((i: { id: string }) => i.id === T.items.steak);
  assert.equal(menuSteak.quick_add, false, 'a dish with a required choice is never quick-added');
  const groups = Object.fromEntries(menuSteak.modifier_groups.map((g: { id: string }) => [g.id, g]));
  assert.equal(groups[G.doneness].min_select, 1);
  assert.equal(groups[G.sides].included_count, 1);

  // Missing the required doneness: explained, and nothing is created.
  const incomplete = [{ item_id: T.items.steak, quantity: 1, modifiers: [{ group_id: G.sides, option_ids: [O.fries] }] }];
  const badQuote = await guest.post<QuoteDTO>('/api/guest/quote', { lines: incomplete });
  assert.equal(badQuote.status, 200);
  assert.ok(badQuote.body.issues.some((i) => i.code === 'modifier_required' && i.line_index === 0), JSON.stringify(badQuote.body.issues));
  const badSubmit = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines: incomplete, expected_subtotal_minor: 59000 });
  assert.equal(badSubmit.status, 409);
  assert.equal(badSubmit.body.error.code, 'cart_changed');
  assert.ok(badSubmit.body.error.details.quote.issues.some((i: { code: string }) => i.code === 'modifier_required'));

  // The customised cart:
  //  rare + fries + salad: one side is included (fries, upgrade 0), salad is a paid extra (120.00) -> 710.00
  //  2 x medium + salad:   the included side upgraded to salad (+30.00 each)                    -> 1,240.00
  //  iced latte (variant price replaces the base)                                                 ->    90.00
  const lines = [
    { ...steak(1, O.rare, [O.fries, O.salad]), note: '  no pepper  ' },
    steak(2, O.medium, [O.salad]),
    { item_id: T.items.coffee, variant_id: T.variants.iced, quantity: 1, modifiers: [] },
  ];
  const quote = await guest.post<QuoteDTO>('/api/guest/quote', { lines });
  assert.equal(quote.status, 200);
  assert.deepEqual(quote.body.issues, []);
  assert.deepEqual(
    quote.body.lines.map((l) => [l.unit_price_minor, l.modifiers_minor, l.quantity, l.line_total_minor]),
    [[59000, 12000, 1, 71000], [59000, 3000, 2, 124000], [9000, 0, 1, 9000]],
  );
  assert.equal(quote.body.subtotal_minor, 204000);
  assert.equal(quote.body.estimated_total_minor, 204000);

  // A stale total is refused with the fresh quote; still no order.
  const stale = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: 200000 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'cart_changed');
  assert.equal(stale.body.error.details.quote.subtotal_minor, 204000);
  assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id])[0].n, 0);

  const submit = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: 204000, locale: 'en' });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  const placed: OrderDTO = submit.body.order;
  assert.equal(submit.body.replayed, false);
  assert.equal(placed.status, 'received');
  assert.equal(placed.round_no, 1);
  assert.equal(placed.table_label, 'T01');
  assert.equal(placed.mine, true);
  assert.equal(placed.subtotal_minor, 204000);
  assert.deepEqual(placed.lines.map((l) => l.status), ['submitted', 'submitted', 'submitted']);
  assert.deepEqual(placed.lines.map((l) => l.prep_kind), ['cook', 'cook', 'prepare']);
  assert.equal(placed.lines[0].note, 'no pepper');
  const [rare, medium, latte] = placed.lines.map((l) => l.id);
  const rareMods = placed.lines[0].modifiers.flatMap((m) => m.options.map((o) => [o.name.en, o.price_minor]));
  assert.deepEqual(rareMods, [['Rare', 0], ['Fries', 0], ['Salad', 12000]]);
  assert.equal(srv.sql('SELECT count(*) n FROM order_lines WHERE order_id = ?', [placed.id])[0].n, 3);
  assert.equal(srv.sql(`SELECT count(*) n FROM events WHERE topic = 'order.created' AND visit_id = ?`, [visit.id])[0].n, 1);

  // A separate staff device sees the round with its snapshot.
  const board = await kitchen.get<{ orders: StaffOrderDTO[] }>('/api/staff/orders?scope=active');
  assert.equal(board.status, 200);
  const ticket = board.body.orders.find((o) => o.id === placed.id);
  assert.ok(ticket, 'the kitchen board shows the new round');
  assert.equal(ticket.reference, placed.reference);
  assert.equal(ticket.table_label, 'T01');
  assert.equal(ticket.guest_label, 'Guest 1');
  assert.equal(ticket.status, 'received');
  assert.equal(ticket.subtotal_minor, 204000);
  assert.deepEqual(ticket.lines.map((l) => l.modifiers), placed.lines.map((l) => l.modifiers));
  assert.ok(ticket.oldest_unaccepted_at);

  // Milestones, each reflected on the guest tracker.
  const expectGuest = async (status: string, lineStatuses: string[]) => {
    const o = await guestOrder(guest, placed.id);
    assert.equal(o.status, status);
    assert.deepEqual([rare, medium, latte].map((id) => lineById(o, id).status), lineStatuses);
    assertStepTimesMatchDb(o);
    return o;
  };

  await advance(kitchen, placed.id, [rare, medium, latte], 'accepted');
  await expectGuest('confirmed', ['accepted', 'accepted', 'accepted']);
  await advance(kitchen, placed.id, [rare, medium, latte], 'preparing');
  await expectGuest('preparing', ['preparing', 'preparing', 'preparing']);
  // Almost done is entered for the rare steak only.
  await advance(kitchen, placed.id, [rare], 'almost_done');
  await expectGuest('preparing', ['almost_done', 'preparing', 'preparing']);
  // One dish and the drink ready: the order is only as far as its slowest dish.
  await advance(kitchen, placed.id, [rare, latte], 'ready');
  await expectGuest('preparing', ['ready', 'preparing', 'ready']);
  // The medium steaks go straight from Preparing to Ready.
  await advance(kitchen, placed.id, [medium], 'ready');
  await expectGuest('ready', ['ready', 'ready', 'ready']);

  // The kitchen role cannot mark food served; nothing changes.
  const denied = await advance(kitchen, placed.id, [rare], 'served', 403);
  assert.equal(denied.body.error.code, 'forbidden');
  await expectGuest('ready', ['ready', 'ready', 'ready']);

  await advance(floor, placed.id, [rare], 'served');
  const partial = await expectGuest('partially_served', ['served', 'ready', 'ready']);
  assert.equal(partial.counts.served, 1);
  assert.equal(partial.counts.ready, 3, 'counts are by quantity: 2 steaks + 1 latte');
  await advance(floor, placed.id, [medium, latte], 'served');
  const done = await expectGuest('served', ['served', 'served', 'served']);

  // The full timelines: only staff-entered milestones appear.
  assert.deepEqual(stepNames(lineById(done, rare)), ['submitted', 'accepted', 'preparing', 'almost_done', 'ready', 'served']);
  assert.deepEqual(stepNames(lineById(done, medium)), ['submitted', 'accepted', 'preparing', 'ready', 'served'],
    'a dish that skipped Almost done has no Almost done step');
  assert.equal(srv.sql('SELECT almost_done_at FROM order_lines WHERE id = ?', [medium])[0].almost_done_at, null);
  assert.ok(srv.sql('SELECT almost_done_at FROM order_lines WHERE id = ?', [rare])[0].almost_done_at);
  // Guests never see who took a step; staff do.
  assert.ok(done.lines.every((l) => l.steps.every((s) => s.actor === null)));
  const staffView = await floor.get<StaffOrderDTO>(`/api/staff/orders/${placed.id}`);
  const rareSteps = lineById(staffView.body, rare).steps;
  assert.deepEqual(rareSteps.map((s) => s.actor), ['Guest 1', 'Test kitchen', 'Test kitchen', 'Test kitchen', 'Test kitchen', 'Test floor']);
  assert.ok(new Date(done.last_update_at).getTime() >= new Date(done.submitted_at).getTime());

  // One live signal per successful transition request (the refused one emitted nothing).
  assert.equal(srv.sql(`SELECT count(*) n FROM events WHERE topic = 'line.updated' AND visit_id = ? AND audience = 'all'`, [visit.id])[0].n, 7);
  assert.equal(srv.sql('SELECT count(*) n FROM line_events WHERE order_id = ?', [placed.id])[0].n, 3 + 3 + 3 + 1 + 2 + 1 + 1 + 2);
});

test('a dish moved Preparing -> Ready directly shows no Almost done step and no invented time', async () => {
  const floor = await srv.staff('floor');
  const visit = await openTable(floor, 'tbl_T03', 1);
  const guest = srv.client();
  assert.equal((await joinTable(guest, 'tbl_T03', visit.join_pin!)).status, 201);
  const res = await guest.post('/api/guest/orders', {
    idempotency_key: key('att'), lines: [{ item_id: T.items.soup, quantity: 1, modifiers: [] }], expected_subtotal_minor: 15000,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const order: OrderDTO = res.body.order;
  const lineId = order.lines[0].id;
  for (const to of ['accepted', 'preparing', 'ready']) await advance(floor, order.id, [lineId], to);

  const ready = await guestOrder(guest, order.id);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(stepNames(ready.lines[0]), ['submitted', 'accepted', 'preparing', 'ready']);
  assertStepTimesMatchDb(ready);

  // Once Ready, Almost done is no longer a valid step (it cannot be back-filled).
  const late = await advance(floor, order.id, [lineId], 'almost_done', 409);
  assert.equal(late.body.error.code, 'invalid_transition');
  const after = await guestOrder(guest, order.id);
  assert.deepEqual(stepNames(after.lines[0]), ['submitted', 'accepted', 'preparing', 'ready']);
  assert.equal(srv.sql('SELECT almost_done_at FROM order_lines WHERE id = ?', [lineId])[0].almost_done_at, null);
});

// ------------------------------------------------------------------ scenario 2
test('scenario 2: a second device at the same table keeps its own cart and rounds, and both land on one combined bill', async () => {
  const floor = await srv.staff('floor');
  const cashier = await srv.staff('cashier');
  const kitchen = await srv.staff('kitchen');
  const visit = await openTable(floor, 'tbl_T02', 4);
  const pin = visit.join_pin!;

  const a = srv.client();
  const b = srv.client();
  const ja = await joinTable(a, 'tbl_T02', pin);
  const jb = await joinTable(b, 'tbl_T02', pin);
  assert.equal(ja.status, 201);
  assert.equal(jb.status, 201);
  assert.notEqual(ja.body.guest_id, jb.body.guest_id);
  assert.notEqual(a.cookies.get('rg_guest'), b.cookies.get('rg_guest'));
  assert.equal(ja.body.visit.id, jb.body.visit.id);
  // Scanning again on device B does not create another member.
  const again = await joinTable(b, 'tbl_T02');
  assert.equal(again.status, 200);
  assert.equal(again.body.guest_id, jb.body.guest_id);
  const detail = await floor.get<VisitDetailDTO>(`/api/staff/visits/${visit.id}`);
  assert.deepEqual(detail.body.guests.map((g) => g.label), ['Guest 1', 'Guest 2']);

  // Private drafts: quoting is stateless and per request.
  const cartA = [{ item_id: T.items.soup, quantity: 2, modifiers: [] }];
  const cartB = [
    { item_id: T.items.coffee, variant_id: T.variants.hot, quantity: 1, modifiers: [] },
    steak(1, O.medium, [O.fries]),
  ];
  const qa = await a.post<QuoteDTO>('/api/guest/quote', { lines: cartA });
  const qb = await b.post<QuoteDTO>('/api/guest/quote', { lines: cartB });
  assert.equal(qa.body.subtotal_minor, 30000);
  assert.equal(qb.body.subtotal_minor, 67000);
  assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id])[0].n, 0, 'a quote creates nothing');

  const keyA1 = key('attA');
  const a1 = await a.post('/api/guest/orders', { idempotency_key: keyA1, lines: cartA, expected_subtotal_minor: 30000 });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  // B's draft is untouched by A's submission.
  const qb2 = await b.post<QuoteDTO>('/api/guest/quote', { lines: cartB });
  assert.deepEqual(qb2.body.lines, qb.body.lines);
  assert.equal(qb2.body.subtotal_minor, 67000);

  // Both devices submit at the same moment: two separate rounds.
  const cartA2 = [{ item_id: T.items.coffee, variant_id: T.variants.iced, quantity: 1, modifiers: [] }];
  const [b1, a2] = await Promise.all([
    b.post('/api/guest/orders', { idempotency_key: key('attB'), lines: cartB, expected_subtotal_minor: 67000 }),
    a.post('/api/guest/orders', { idempotency_key: key('attA'), lines: cartA2, expected_subtotal_minor: 9000 }),
  ]);
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  assert.equal(a2.status, 201, JSON.stringify(a2.body));
  assert.deepEqual([a1, b1, a2].map((r) => r.body.order.round_no).sort(), [1, 2, 3]);
  assert.equal(b1.body.order.subtotal_minor, 67000);
  assert.equal(a2.body.order.subtotal_minor, 9000);

  // A's retry replays A's round; B cannot reuse A's attempt for a different cart.
  const replay = await a.post('/api/guest/orders', { idempotency_key: keyA1, lines: cartA, expected_subtotal_minor: 30000 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.order.id, a1.body.order.id);
  const hijack = await b.post('/api/guest/orders', { idempotency_key: keyA1, lines: cartB, expected_subtotal_minor: 67000 });
  assert.equal(hijack.status, 409);
  assert.equal(hijack.body.error.code, 'idempotency_mismatch');
  assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id])[0].n, 3);

  // Each round is attributed to the device that sent it.
  const mineA = new Set([a1.body.order.id, a2.body.order.id]);
  const mineB = new Set([b1.body.order.id]);
  const owners = srv.sql<{ id: string; guest_session_id: string }>('SELECT id, guest_session_id FROM orders WHERE visit_id = ?', [visit.id]);
  for (const o of owners) assert.equal(o.guest_session_id, mineA.has(o.id) ? ja.body.guest_id : jb.body.guest_id);

  // Shared rounds, per-device "ordered on this device".
  const listA = await a.get<{ orders: OrderDTO[] }>('/api/guest/orders');
  const listB = await b.get<{ orders: OrderDTO[] }>('/api/guest/orders');
  const tabA = await a.clone().get<{ orders: OrderDTO[] }>('/api/guest/orders');
  assert.deepEqual(listA.body.orders.map((o) => o.round_no), [1, 2, 3]);
  assert.deepEqual(listA.body.orders.map((o) => o.id), listB.body.orders.map((o) => o.id));
  assert.deepEqual(listA.body.orders.map((o) => o.mine), listA.body.orders.map((o) => mineA.has(o.id)));
  assert.deepEqual(listB.body.orders.map((o) => o.mine), listB.body.orders.map((o) => mineB.has(o.id)));
  assert.deepEqual(tabA.body.orders.map((o) => o.mine), listA.body.orders.map((o) => o.mine), 'a second tab on device A is still device A');

  // Before staff accept anything the bill owes nothing; all four dishes are pending.
  const pending = await a.get<GuestBillDTO>('/api/guest/bill');
  assert.equal(pending.body.total_minor, 0);
  assert.equal(pending.body.pending_lines.length, 4);

  const accept = async (r: { body: { order: OrderDTO } }) =>
    advance(kitchen, r.body.order.id, r.body.order.lines.map((l) => l.id), 'accepted');
  await accept(a1);
  await accept(b1);
  await accept(a2);

  const billA = await a.get<GuestBillDTO>('/api/guest/bill');
  const billB = await b.get<GuestBillDTO>('/api/guest/bill');
  assert.equal(billA.status, 200);
  assert.match(billA.headers.get('cache-control') ?? '', /no-store/, 'a private table bill is never cached');
  assert.deepEqual(billB.body, billA.body, 'both devices see the same table bill');
  assert.equal(billA.body.table_label, 'T02');
  assert.equal(billA.body.lines.length, 4);
  assert.deepEqual(new Set(billA.body.lines.map((l) => l.order_reference)),
    new Set([a1.body.order.reference, b1.body.order.reference, a2.body.order.reference]));
  assert.equal(billA.body.pending_lines.length, 0);
  assert.equal(billA.body.subtotal_minor, 30000 + 67000 + 9000);
  assert.equal(billA.body.total_minor, 106000);

  const staffBill = await cashier.get<StaffBillDTO>(`/api/staff/visits/${visit.id}/bill`);
  assert.equal(staffBill.status, 200);
  assert.equal(staffBill.body.total_minor, 106000);
  assert.equal(staffBill.body.lines.length, 4);

  // Finalizing freezes ONE revision holding both devices' rounds.
  const fresh = await cashier.get<VisitDetailDTO>(`/api/staff/visits/${visit.id}`);
  const started = await cashier.post<StaffBillDTO>(`/api/staff/visits/${visit.id}/billing/start`, { version: fresh.body.version });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const fin = await cashier.post<StaffBillDTO>(`/api/staff/visits/${visit.id}/bill/finalize`, {
    bill_version: started.body.bill_version, expected_total_minor: 106000,
  });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const [frozenA, frozenB] = await Promise.all([a.get<GuestBillDTO>('/api/guest/bill'), b.get<GuestBillDTO>('/api/guest/bill')]);
  assert.deepEqual(frozenA.body, frozenB.body);
  assert.equal(frozenA.body.revision_no, 1);
  assert.equal(frozenA.body.total_minor, 106000);
  assert.equal(frozenA.body.lines.length, 4);
  assert.equal(srv.sql('SELECT count(*) n FROM bills WHERE visit_id = ?', [visit.id])[0].n, 1);
  const revs = srv.sql<{ total_minor: number; status: string }>('SELECT total_minor, status FROM bill_revisions WHERE visit_id = ?', [visit.id]).map((r) => ({ ...r }));
  assert.deepEqual(revs, [{ total_minor: 106000, status: 'payable' }]);
});
