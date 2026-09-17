// Measured-weight portions and grill-specific ordering (brief 44A, 44B, 44D,
// 44F; D-08, D-22). Prime rib is 490 THB per 100 g in the fixtures
// (rate_minor 49000, basis 100 g); every amount below is exact satang.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { key, startServer, type Client, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';
import { ROLES, type Role } from '../../shared/permissions.ts';
import { addDays, todayBusinessDate } from '../../shared/time.ts';

let srv: TestServer;
const staff = {} as Record<Role, Client>;

before(async () => {
  // Each simulated guest device joins from its own address (the join limit is per address).
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  for (const role of ROLES) staff[role] = await srv.staff(role);
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
const RIB = T.items.rib;
let tableSeq = 0;
let deviceSeq = 0;

function expectError(res: HttpResult, status: number, code: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.error?.code, code, JSON.stringify(res.body));
}

function expectForbidden(res: HttpResult, permission: string): void {
  expectError(res, 403, 'forbidden');
  assert.equal(res.body.error.details?.permission, permission, JSON.stringify(res.body));
}

async function join(token: string, pin: string): Promise<Client> {
  const c = srv.client();
  deviceSeq++;
  const r = await c.request('POST', '/api/public/qr/join', { token, pin }, { 'X-Forwarded-For': `10.44.${Math.floor(deviceSeq / 250)}.${deviceSeq % 250}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

/** A fresh table with its own QR card and an open visit, so no two tests share a party. */
async function seat(covers = 2) {
  const t = await staff.manager.post('/api/staff/tables', { label: `PR${++tableSeq}` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const cards = await staff.manager.get(`/api/staff/tables/qr-cards?ids=${t.body.id}`);
  const token = decodeURIComponent(String(cards.body.cards[0].url).split('/q/')[1]);
  const v = await staff.floor.post(`/api/staff/tables/${t.body.id}/visits`, { covers, idempotency_key: key('open') });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  return { tableId: t.body.id as string, visit: v.body, guest: () => join(token, v.body.join_pin) };
}

interface Req { id: string; version: number; status: string; quote: { id: string; revision: number; grams?: number; rate_minor?: number; amount_minor?: number } | null }

function requestCut(g: Client, k = key('por'), extra: Record<string, unknown> = {}) {
  return g.post('/api/guest/portions', { item_id: RIB, idempotency_key: k, ...extra });
}

async function newRequest(g: Client, extra: Record<string, unknown> = {}): Promise<Req> {
  const r = await requestCut(g, key('por'), extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

function quote(c: Client, requestId: string, grams: number, version: number, extra: Record<string, unknown> = {}) {
  return c.post(`/api/staff/portions/${requestId}/quote`, { grams, version, ...extra });
}

async function quoted(c: Client, requestId: string, grams: number, extra: Record<string, unknown> = {}): Promise<Req> {
  const r = await quote(c, requestId, grams, portionRow(requestId).version, extra);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function confirm(g: Client, req: Req, k = key('pc'), extra: Record<string, unknown> = {}) {
  return g.post(`/api/guest/portions/${req.id}/confirm`, { quote_id: req.quote!.id, revision: req.quote!.revision, idempotency_key: k, ...extra });
}

function inPerson(c: Client, req: Req, k = key('pp'), extra: Record<string, unknown> = {}) {
  return c.post(`/api/staff/portions/${req.id}/confirm-in-person`, { quote_id: req.quote!.id, revision: req.quote!.revision, idempotency_key: k, ...extra });
}

function checkout(c: Client, visitId: string) {
  return c.post(`/api/staff/visits/${visitId}/checkout`, { idempotency_key: key('co') });
}

function portionRow(id: string) {
  return srv.sql<{ status: string; version: number; resolution_reason: string | null; resolved_by: string | null }>(
    'SELECT status, version, resolution_reason, resolved_by FROM portion_requests WHERE id = ?', [id])[0];
}

function quoteRows(requestId: string) {
  return srv.sql<{ id: string; revision: number; status: string; grams: number; amount_minor: number }>(
    'SELECT id, revision, status, grams, amount_minor FROM portion_quotes WHERE request_id = ? ORDER BY revision', [requestId]).map((r) => ({ ...r }));
}

function visitLines(visitId: string) {
  return srv.sql<{ id: string; item_id: string; status: string; quantity: number; measured_grams: number | null; rate_minor: number | null; line_total_minor: number; portion_quote_id: string | null }>(
    'SELECT id, item_id, status, quantity, measured_grams, rate_minor, line_total_minor, portion_quote_id FROM order_lines WHERE visit_id = ? ORDER BY submitted_at, line_no', [visitId]);
}

const orderCount = (visitId: string) => srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visitId])[0].n as number;

/** Move lines forward (reading their current versions from the database). */
async function advance(c: Client, lineIds: string[], to: string): Promise<void> {
  const refs = lineIds.map((id) => ({ id, version: srv.sql('SELECT version FROM order_lines WHERE id = ?', [id])[0].version }));
  const r = await c.post('/api/staff/orders/transition', { lines: refs, to });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function submit(g: Client, lines: unknown[], subtotal: number) {
  return g.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: subtotal });
}

async function ribRanking(measure: 'net' | 'grams' = 'net') {
  const r = await staff.manager.get(`/api/staff/stats/menu?measure=${measure}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Rankings cover the whole business day (other tests in this file order prime rib too): compare deltas.
  const row = r.body.rows.find((x: { item_id: string }) => x.item_id === RIB) as { net_qty: number; submitted_qty: number; grams: number | null; orders: number } | undefined;
  return { net: row?.net_qty ?? 0, submitted: row?.submitted_qty ?? 0, grams: row?.grams ?? 0, orders: row?.orders ?? 0 };
}

/** 44F funnel stages for prime rib today: requests, quoted, confirmed, confirmed grams. */
async function ribFunnel(): Promise<{ requests: number; quoted: number; confirmed: number; grams_total: number }> {
  const r = await staff.manager.get(`/api/staff/stats/menu/items/${RIB}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.portion_funnel;
}

async function adminItem(id: string) {
  return (await staff.manager.get('/api/staff/menu')).body.items.find((i: { id: string }) => i.id === id);
}

const soup = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] });
const latte = (variant: string, quantity = 1) => ({ item_id: T.items.coffee, variant_id: variant, quantity, modifiers: [] });
const steak = (doneness: string[], sides: string[] = [], quantity = 1) => ({
  item_id: T.items.steak, quantity,
  modifiers: [{ group_id: T.groups.doneness, option_ids: doneness }, ...(sides.length ? [{ group_id: T.groups.sides, option_ids: sides }] : [])],
});

// ------------------------------------------------------------------ 44A steps 1-3
test('a portion request is idempotent and is not an order: no kitchen ticket, no sale, no bill line', async () => {
  const { visit, tableId, guest } = await seat();
  const g = await guest();
  const rankBefore = await ribRanking();
  const funnelBefore = await ribFunnel();

  // Step 1: the guest sees the verified rate and its basis, never a fixed plate price.
  const menu = await g.get('/api/public/menu');
  const rib = menu.body.items.find((i: { id: string }) => i.id === RIB);
  assert.equal(rib.pricing_type, 'measured_weight');
  assert.equal(rib.rate_minor, 49000);
  assert.equal(rib.rate_basis_grams, 100);
  assert.equal(rib.price_minor, null);
  assert.equal(rib.quick_add, false);
  // A weighed cut is never a cart line.
  const cartQuote = await g.post('/api/guest/quote', { lines: [{ item_id: RIB, quantity: 1, modifiers: [] }] });
  assert.ok(cartQuote.body.issues.some((i: { code: string }) => i.code === 'measured_weight_needs_quote'));
  expectError(await submit(g, [{ item_id: RIB, quantity: 1, modifiers: [] }], 49000), 409, 'cart_changed');

  // Steps 2-3: repeated taps (two tabs) create one request scoped to the visit.
  const k = key('por');
  const ask = { preferred_grams: 400, note: 'Medium rare, end cut' };
  const sends = await Promise.all([requestCut(g, k, ask), requestCut(g.clone(), k, ask), requestCut(g, k, ask)]);
  assert.deepEqual(sends.map((r) => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(sends.map((r) => r.body.id)).size, 1);
  const req = sends[0].body;
  assert.equal(req.status, 'requested');
  assert.equal(req.quote, null);
  assert.equal(req.preferred_grams, 400);
  assert.equal(req.source, 'guest');
  expectError(await requestCut(g, k, { preferred_grams: 500 }), 409, 'idempotency_mismatch');
  const fixed = await g.post('/api/guest/portions', { item_id: T.items.soup, idempotency_key: key('por') });
  expectError(fixed, 400, 'bad_request');
  assert.equal(fixed.body.error.details.reason, 'not_measured_weight');
  assert.equal(srv.sql('SELECT count(*) n FROM portion_requests WHERE visit_id = ?', [visit.id])[0].n, 1);

  // Not an order: nothing for the kitchen, the bill or the rankings.
  assert.equal(orderCount(visit.id), 0);
  assert.deepEqual(visitLines(visit.id), []);
  const board = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}`);
  assert.deepEqual(board.body.orders, []);
  const bill = await g.get('/api/guest/bill');
  assert.deepEqual([bill.body.lines, bill.body.pending_lines, bill.body.total_minor], [[], [], 0]);
  const track = await g.get('/api/guest/orders');
  assert.deepEqual(track.body.orders, []);
  assert.deepEqual(track.body.portions.map((p: Req) => [p.id, p.status]), [[req.id, 'requested']]);
  assert.deepEqual(await ribRanking(), rankBefore, 'an unconfirmed request is not a sale');
  const funnel = await ribFunnel();
  assert.deepEqual([funnel.requests - funnelBefore.requests, funnel.quoted, funnel.confirmed, funnel.grams_total],
    [1, funnelBefore.quoted, funnelBefore.confirmed, funnelBefore.grams_total], 'the request is only the first funnel stage');

  // Staff see a cut waiting to be weighed.
  const queue = await staff.kitchen.get('/api/staff/portions?scope=open');
  const waiting = queue.body.requests.find((p: Req) => p.id === req.id);
  assert.equal(waiting.status, 'requested');
  assert.deepEqual(waiting.current_rate, { rate_minor: 49000, rate_basis_grams: 100 });
  assert.equal(waiting.note, 'Medium rare, end cut');
  const tile = (await staff.floor.get('/api/staff/tables')).body.tables.find((t: { id: string }) => t.id === tableId);
  assert.ok(tile.attention.includes('portion_request'));
});

test('the guest cannot supply the weight, the rate or the amount', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const sneaky = await requestCut(g, key('por'), { grams: 5, rate_minor: 1, amount_minor: 1, status: 'confirmed', quote: { grams: 5, amount_minor: 1 } });
  assert.equal(sneaky.status, 201, JSON.stringify(sneaky.body));
  assert.equal(sneaky.body.status, 'requested');
  assert.equal(sneaky.body.quote, null);
  assert.deepEqual(quoteRows(sneaky.body.id), []);
  expectError(await requestCut(g, key('por'), { preferred_grams: 10 }), 422, 'validation_failed');

  // Quoting is staff-only; confirming needs a real staff quote.
  expectError(await g.post(`/api/staff/portions/${sneaky.body.id}/quote`, { grams: 5, version: sneaky.body.version }), 401, 'auth_required');
  expectError(await g.post(`/api/guest/portions/${sneaky.body.id}/confirm`, { quote_id: 'pqt_NOT_A_REAL_QUOTE', revision: 1, idempotency_key: key('pc') }), 404, 'not_found');

  const staffQuote = await quoted(staff.kitchen, sneaky.body.id, 350);

  // Another table's guest can neither see nor confirm it.
  const other = await seat();
  const stranger = await other.guest();
  expectError(await confirm(stranger, staffQuote), 404, 'not_found');
  assert.deepEqual((await stranger.get('/api/guest/portions')).body.requests, []);

  // Extra fields on the confirmation are ignored: the staff measurement decides the amount.
  const conf = await confirm(g, staffQuote, key('pc'), { grams: 1, rate_minor: 1, amount_minor: 1 });
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  const line = conf.body.order.lines[0];
  assert.deepEqual([line.measured_grams, line.rate_minor, line.line_total_minor], [350, 49000, 171500]);
  assert.equal(visitLines(visit.id).length, 1);
  assert.equal(orderCount(other.visit.id), 0);
});

// ------------------------------------------------------------------ 44A steps 4-6
test('staff quote then guest confirmation creates exactly one measured line that goes through normal acceptance', async () => {
  const NOTE = 'Medium rare please, outside cut';
  const { visit, tableId, guest } = await seat();
  const g = await guest();
  const rankBefore = await ribRanking();
  const gramsBefore = (await ribRanking('grams')).grams;
  const funnelBefore = await ribFunnel();
  const req = await newRequest(g, { note: NOTE });

  // Step 4: staff weigh 350 g; the server snapshots the approved rate and computes the amount.
  const quotedAt = Date.now();
  const q = await quote(staff.kitchen, req.id, 350, req.version);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.status, 'quoted');
  const shown = q.body.quote;
  assert.deepEqual(
    [shown.revision, shown.grams, shown.rate_minor, shown.rate_basis_grams, shown.amount_minor, shown.measured_minor, shown.modifiers_minor, shown.status],
    [1, 350, 49000, 100, 171500, 171500, 0, 'active'],
  );
  const expiresIn = Date.parse(shown.expires_at) - quotedAt;
  assert.ok(expiresIn > 9.5 * 60_000 && expiresIn <= 10 * 60_000 + 5_000, `default expiry is 10 minutes, got ${expiresIn} ms`);

  // Step 5: the guest sees the same weight, exact amount, time and expiry.
  const seen = (await g.get('/api/guest/portions')).body.requests[0];
  assert.equal(seen.status, 'quoted');
  for (const f of ['id', 'revision', 'grams', 'amount_minor', 'created_at', 'expires_at'] as const) assert.equal(seen.quote[f], shown[f], f);

  // Step 6: confirmation creates one real order line.
  const conf = await confirm(g, q.body);
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  assert.equal(conf.body.replayed, false);
  assert.equal(conf.body.request.status, 'confirmed');
  assert.equal(conf.body.request.quote.status, 'confirmed');
  assert.equal(conf.body.request.quote.confirmed_via, 'guest');
  const order = conf.body.order;
  assert.equal(conf.body.request.order_reference, order.reference);
  assert.equal(order.source, 'portion_quote');
  assert.equal(order.mine, true);
  assert.equal(order.subtotal_minor, 171500);
  assert.equal(order.lines.length, 1);
  const line = order.lines[0];
  assert.deepEqual(
    [line.item_id, line.quantity, line.measured_grams, line.rate_minor, line.rate_basis_grams, line.unit_price_minor, line.modifiers_minor, line.line_total_minor],
    [RIB, 1, 350, 49000, 100, 171500, 0, 171500],
  );
  assert.equal(line.status, 'submitted');
  assert.equal(line.note, NOTE, "the guest's request note reaches the kitchen ticket");
  assert.deepEqual([line.station, line.prep_kind], ['kitchen', 'cook']);
  const rows = visitLines(visit.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].portion_quote_id, shown.id);
  assert.equal(orderCount(visit.id), 1);
  const audit = srv.sql<{ after_json: string }>(`SELECT after_json FROM audit_events WHERE action = 'portion.confirm' AND entity_id = ?`, [req.id]);
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].after_json).amount_minor, 171500);

  // Submitted, not yet accepted: shown as pending, not in the amount due.
  let bill = (await g.get('/api/guest/bill')).body;
  assert.deepEqual([bill.lines.length, bill.pending_lines.length, bill.total_minor], [0, 1, 0]);
  assert.equal(bill.pending_lines[0].measured_grams, 350);

  // Then the normal kitchen workflow.
  const board = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}&status=submitted`);
  assert.deepEqual(board.body.orders.map((o: { id: string }) => o.id), [order.id]);
  await advance(staff.kitchen, [line.id], 'accepted');
  await advance(staff.kitchen, [line.id], 'preparing');
  await advance(staff.kitchen, [line.id], 'ready');
  await advance(staff.floor, [line.id], 'served');
  bill = (await g.get('/api/guest/bill')).body;
  assert.equal(bill.total_minor, 171500);
  assert.deepEqual(bill.lines.map((l: { measured_grams: number; line_total_minor: number; status: string }) => [l.measured_grams, l.line_total_minor, l.status]), [[350, 171500, 'served']]);

  // One confirmed cut is ONE serving with its grams, never 350 "items".
  const rank = await ribRanking();
  assert.deepEqual(
    [rank.net - rankBefore.net, rank.submitted - rankBefore.submitted, rank.grams - rankBefore.grams, rank.orders - rankBefore.orders],
    [1, 1, 350, 1],
  );
  assert.equal((await ribRanking('grams')).grams - gramsBefore, 350);
  const funnel = await ribFunnel();
  assert.deepEqual(
    [funnel.requests - funnelBefore.requests, funnel.quoted - funnelBefore.quoted, funnel.confirmed - funnelBefore.confirmed, funnel.grams_total - funnelBefore.grams_total],
    [1, 1, 1, 350],
  );
});

// ------------------------------------------------------------------ double confirmation / response loss
test('double confirmation: the same key replays, any other confirmation is refused, and there is one line', async () => {
  const { visit, guest } = await seat();
  const [a, b] = [await guest(), await guest()];
  const req = await newRequest(a);
  const q = await quoted(staff.kitchen, req.id, 420);

  const K = key('pc');
  const same = await Promise.all([confirm(a, q, K), confirm(a.clone(), q, K), confirm(a, q, K)]);
  assert.deepEqual(same.map((r) => r.status).sort(), [200, 200, 201], JSON.stringify(same.map((r) => r.body)));
  assert.equal(new Set(same.map((r) => r.body.order.id)).size, 1);
  assert.deepEqual(same.map((r) => r.body.replayed).sort(), [false, true, true]);

  const otherGuest = await confirm(b, q, key('pc'));
  expectError(otherGuest, 409, 'already_done');
  assert.equal(otherGuest.body.error.details.current.status, 'confirmed');
  expectError(await inPerson(staff.floor, q), 409, 'already_done');
  expectError(await confirm(a, { ...q, quote: { ...q.quote!, revision: 2 } }, K), 409, 'idempotency_mismatch');
  assert.equal(visitLines(visit.id).length, 1);
  assert.equal(visitLines(visit.id)[0].line_total_minor, 205800);

  // Different devices confirming a second cut at the same moment: exactly one wins.
  const req2 = await newRequest(b);
  const q2 = await quoted(staff.kitchen, req2.id, 300);
  const raced = await Promise.all([confirm(a, q2), confirm(b, q2), inPerson(staff.floor, q2)]);
  assert.equal(raced.filter((r) => r.status === 201).length, 1, JSON.stringify(raced.map((r) => r.body)));
  for (const r of raced.filter((x) => x.status !== 201)) expectError(r, 409, 'already_done');
  assert.equal(srv.sql('SELECT count(*) n FROM order_lines WHERE portion_quote_id = ?', [q2.quote!.id])[0].n, 1);
  assert.equal(visitLines(visit.id).length, 2);
  assert.equal(orderCount(visit.id), 2);
});

test('response lost after confirmation: re-sending the confirmation returns the same order, even after the kitchen moved on', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = await newRequest(g);
  const q = await quoted(staff.kitchen, req.id, 380);
  const K = key('pc');
  const lost = await confirm(g, q, K); // the phone never sees this response
  assert.equal(lost.status, 201);

  const retry = await confirm(g.clone(), q, K);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.order.id, lost.body.order.id);
  assert.equal(retry.body.order.reference, lost.body.order.reference);

  await advance(staff.kitchen, [lost.body.order.lines[0].id], 'accepted');
  const later = await confirm(g, q, K);
  assert.equal(later.status, 200);
  assert.equal(later.body.order.id, lost.body.order.id);
  assert.equal(later.body.order.lines[0].status, 'accepted');

  const track = (await g.get('/api/guest/orders')).body;
  assert.equal(track.orders.length, 1);
  assert.equal(track.portions[0].order_reference, lost.body.order.reference);
  assert.equal(orderCount(visit.id), 1);
  assert.equal(visitLines(visit.id).length, 1);
});

// ------------------------------------------------------------------ 44A step 8, expiry, concurrent staff edits
test('a re-quote supersedes the old revision: confirming the old one is refused and the agreed values cannot change afterwards', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = await newRequest(g);
  const rev1 = await quoted(staff.kitchen, req.id, 300);
  assert.equal(rev1.quote!.revision, 1);
  const rev2 = await quoted(staff.floor, req.id, 320);
  assert.equal(rev2.quote!.revision, 2);
  assert.deepEqual(quoteRows(req.id).map((r) => [r.revision, r.status, r.grams, r.amount_minor]), [
    [1, 'superseded', 300, 147000],
    [2, 'active', 320, 156800],
  ]);

  const stale = await confirm(g, rev1);
  expectError(stale, 409, 'quote_superseded');
  assert.equal(stale.body.error.details.current.quote.revision, 2);
  assert.equal(stale.body.error.details.current.quote.amount_minor, 156800);
  expectError(await confirm(g, { ...rev2, quote: { id: rev2.quote!.id, revision: 1 } }), 409, 'quote_superseded');
  assert.deepEqual(visitLines(visit.id), []);
  const requote = srv.sql<{ before_json: string; after_json: string }>(`SELECT before_json, after_json FROM audit_events WHERE action = 'portion.requote' AND entity_id = ?`, [req.id]);
  assert.equal(requote.length, 1);
  assert.equal(JSON.parse(requote[0].before_json).amount_minor, 147000);
  assert.equal(JSON.parse(requote[0].after_json).amount_minor, 156800);

  const conf = await confirm(g, rev2);
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  assert.deepEqual([conf.body.order.lines[0].measured_grams, conf.body.order.lines[0].line_total_minor], [320, 156800]);

  // Step 7: nobody can silently change a guest-confirmed quote.
  const version = portionRow(req.id).version;
  expectError(await quote(staff.manager, req.id, 500, version), 409, 'already_done');
  expectError(await staff.manager.post(`/api/staff/portions/${req.id}/cancel`, { reason: 'Changed weight', version }), 409, 'already_done');
  expectError(await g.post(`/api/guest/portions/${req.id}/cancel`), 409, 'already_done');
  assert.equal(quoteRows(req.id).length, 2);
  assert.deepEqual(visitLines(visit.id).map((l) => l.line_total_minor), [156800]);
});

test('an expired quote cannot be confirmed; the request returns to staff to weigh again', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = await newRequest(g);
  const q = await quoted(staff.kitchen, req.id, 250, { expires_minutes: 5 });
  assert.equal(q.quote!.revision, 1);
  srv.exec('UPDATE portion_quotes SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), q.quote!.id]);

  // Shown as expired at once, before any sweep runs.
  const view = (await g.get('/api/guest/portions')).body.requests[0];
  assert.equal(view.quote.status, 'expired');
  assert.equal(view.status, 'requested');

  const late = await confirm(g, q);
  expectError(late, 409, 'quote_expired');
  assert.equal(late.body.error.details.current.status, 'requested');
  assert.equal(quoteRows(req.id)[0].status, 'expired', 'the expiry is committed even though the request failed');
  assert.equal(portionRow(req.id).status, 'requested');
  expectError(await confirm(g, q), 409, 'quote_expired');
  assert.deepEqual(visitLines(visit.id), []);
  assert.equal(srv.sql(`SELECT count(*) n FROM audit_events WHERE action = 'portion.quote_expired' AND entity_id = ?`, [req.id])[0].n, 1);
  const queue = await staff.kitchen.get('/api/staff/portions?scope=open');
  assert.equal(queue.body.requests.find((p: Req) => p.id === req.id)?.status, 'requested');

  const fresh = await quoted(staff.kitchen, req.id, 260);
  assert.equal(fresh.quote!.revision, 2);
  const conf = await confirm(g, fresh);
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  assert.equal(conf.body.order.lines[0].line_total_minor, 127400);
  assert.deepEqual(quoteRows(req.id).map((r) => r.status), ['expired', 'confirmed']);
});

test('two staff quoting the same request at once: one revision wins, the other gets stale_version', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = await newRequest(g);
  const [x, y] = await Promise.all([quote(staff.kitchen, req.id, 300, req.version), quote(staff.floor, req.id, 310, req.version)]);
  const winner = [x, y].find((r) => r.status === 200);
  const loser = [x, y].find((r) => r.status !== 200);
  assert.ok(winner && loser, JSON.stringify([x.body, y.body]));
  expectError(loser, 409, 'stale_version');
  assert.equal(loser.body.error.details.current.quote.grams, winner.body.quote.grams, 'the loser is shown what the other device saved');
  assert.equal(quoteRows(req.id).length, 1);

  // The second member of staff re-weighs knowingly, from the current version.
  const loserGrams = winner.body.quote.grams === 300 ? 310 : 300;
  const retry = await quote(loser === x ? staff.kitchen : staff.floor, req.id, loserGrams, loser.body.error.details.current.version);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(quoteRows(req.id).map((r) => [r.revision, r.status]), [[1, 'superseded'], [2, 'active']]);
  const conf = await confirm(g, retry.body);
  assert.equal(conf.status, 201);
  assert.equal(conf.body.order.lines[0].measured_grams, loserGrams);
  assert.equal(visitLines(visit.id).length, 1);
});

// ------------------------------------------------------------------ closure, billing, in person
test('checkout while a portion is pending cancels it with a reason; a late confirmation is refused', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = await newRequest(g);
  const q = await quoted(staff.kitchen, req.id, 300);

  // Unconfirmed requests never block checkout (nothing was ordered).
  const out = await checkout(staff.cashier, visit.id);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual({ ...portionRow(req.id), version: undefined }, { status: 'cancelled', version: undefined, resolution_reason: 'Visit closed at checkout', resolved_by: 'Test cashier' });
  assert.deepEqual(quoteRows(req.id).map((r) => r.status), ['withdrawn']);
  assert.equal(srv.sql(`SELECT count(*) n FROM audit_events WHERE action = 'portion.cancelled_at_checkout' AND entity_id = ?`, [req.id])[0].n, 1);

  expectError(await confirm(g, q), 410, 'visit_closed');
  expectError(await inPerson(staff.floor, q), 409, 'invalid_transition');
  assert.deepEqual(visitLines(visit.id), []);
});

test('billing blocks new portion requests, quotes and confirmations; a confirmation racing checkout leaves one consistent state', async () => {
  const one = await seat();
  const g = await one.guest();
  const order = (await submit(g, [soup()], 15000)).body.order;
  await advance(staff.kitchen, [order.lines[0].id], 'accepted');
  const req = await newRequest(g);
  const q = await quoted(staff.kitchen, req.id, 300);
  const started = await staff.cashier.post(`/api/staff/visits/${one.visit.id}/billing/start`, { version: srv.sql('SELECT version FROM visits WHERE id = ?', [one.visit.id])[0].version });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  expectError(await confirm(g, q), 409, 'visit_billing');
  expectError(await quote(staff.kitchen, req.id, 310, portionRow(req.id).version), 409, 'visit_billing');
  expectError(await requestCut(g), 409, 'visit_billing');
  assert.deepEqual(visitLines(one.visit.id).map((l) => l.item_id), [T.items.soup]);

  // Quote approval racing checkout (44F): whichever commits first, the state is consistent.
  const two = await seat();
  const g2 = await two.guest();
  const req2 = await newRequest(g2);
  const q2 = await quoted(staff.kitchen, req2.id, 300);
  const [conf, out] = await Promise.all([confirm(g2, q2), checkout(staff.cashier, two.visit.id)]);
  const visitStatus = srv.sql('SELECT status FROM visits WHERE id = ?', [two.visit.id])[0].status;
  if (out.status === 200) {
    assert.equal(visitStatus, 'closed');
    assert.ok(conf.status === 410 || conf.status === 409, JSON.stringify(conf.body));
    assert.equal(portionRow(req2.id).status, 'cancelled');
    assert.deepEqual(visitLines(two.visit.id), []);
  } else {
    expectError(out, 409, 'invalid_transition');
    assert.equal(conf.status, 201, JSON.stringify(conf.body));
    assert.equal(visitStatus, 'open');
    assert.equal(portionRow(req2.id).status, 'confirmed');
    assert.deepEqual(visitLines(two.visit.id).map((l) => l.status), ['submitted']);
  }
});

test('a quote confirmed in person is recorded by floor staff with the agreed values; kitchen and cashier cannot record it', async () => {
  const { visit, tableId, guest } = await seat();
  // The party has no phone: floor staff start the request for them.
  const started = await staff.floor.post('/api/staff/portions', { visit_id: visit.id, item_id: RIB, note: 'Guest has no phone', idempotency_key: key('por') });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.source, 'staff');
  const q = await quoted(staff.kitchen, started.body.id, 380);

  expectForbidden(await inPerson(staff.kitchen, q), 'portions.confirm_in_person');
  expectForbidden(await inPerson(staff.cashier, q), 'portions.confirm_in_person');
  assert.deepEqual(visitLines(visit.id), []);

  const conf = await inPerson(staff.floor, q, key('pp'), { note: 'Agreed at the table', grams: 999, amount_minor: 1 });
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  assert.equal(conf.body.order.source, 'portion_quote');
  assert.equal(conf.body.order.staff_name, 'Test floor');
  assert.deepEqual([conf.body.order.lines[0].measured_grams, conf.body.order.lines[0].line_total_minor], [380, 186200]);
  assert.equal(conf.body.request.quote.confirmed_via, 'in_person');
  const stored = srv.sql<{ confirmed_via: string; confirmed_staff_id: string; confirmed_guest_session_id: string | null }>(
    'SELECT confirmed_via, confirmed_staff_id, confirmed_guest_session_id FROM portion_quotes WHERE id = ?', [q.quote!.id]).map((r) => ({ ...r }));
  assert.deepEqual(stored, [{ confirmed_via: 'in_person', confirmed_staff_id: 'stf_floor', confirmed_guest_session_id: null }]);
  const audit = srv.sql<{ actor_id: string; reason: string; after_json: string }>(
    `SELECT actor_id, reason, after_json FROM audit_events WHERE action = 'portion.confirm_in_person' AND entity_id = ?`, [started.body.id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, 'stf_floor');
  assert.equal(audit[0].reason, 'Agreed at the table');
  assert.equal(JSON.parse(audit[0].after_json).grams, 380);

  // A guest joining later cannot confirm it a second time; the kitchen gets the ticket once.
  const g = await guest();
  expectError(await confirm(g, q), 409, 'already_done');
  const board = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}&status=submitted`);
  assert.deepEqual(board.body.orders.map((o: { id: string }) => o.id), [conf.body.order.id]);
  assert.equal(visitLines(visit.id).length, 1);
});

test('fixed-price dishes can be ordered while a portion request is pending', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = await newRequest(g);
  const q = await quoted(staff.kitchen, req.id, 300);

  const soupRound = await submit(g, [soup(2)], 30000);
  assert.equal(soupRound.status, 201, JSON.stringify(soupRound.body));
  assert.deepEqual(soupRound.body.order.lines.map((l: { item_id: string }) => l.item_id), [T.items.soup]);
  const track = (await g.get('/api/guest/orders')).body;
  assert.equal(track.orders.length, 1);
  assert.deepEqual(track.portions.map((p: Req) => p.status), ['quoted']);
  await advance(staff.kitchen, [soupRound.body.order.lines[0].id], 'accepted');
  let bill = (await g.get('/api/guest/bill')).body;
  assert.deepEqual([bill.total_minor, bill.lines.length, bill.pending_lines.length], [30000, 1, 0]);

  const conf = await confirm(g, q);
  assert.equal(conf.status, 201);
  assert.equal(conf.body.order.round_no, 2);
  bill = (await g.get('/api/guest/bill')).body;
  assert.deepEqual([bill.total_minor, bill.lines.length, bill.pending_lines.length], [30000, 1, 1], 'the cut counts once staff accept it');
  await advance(staff.kitchen, [conf.body.order.lines[0].id], 'accepted');
  bill = (await g.get('/api/guest/bill')).body;
  assert.equal(bill.total_minor, 30000 + 147000);
  assert.equal(orderCount(visit.id), 2);
});

// ------------------------------------------------------------------ 44F realistic cases
test('one shared cut plus separately prepared drinks: each line carries its own station and preparation wording', async () => {
  const { visit, tableId, guest } = await seat(4);
  const [a, b] = [await guest(), await guest()];
  const req = await newRequest(a, { note: 'For the table to share' });
  const q = await quoted(staff.kitchen, req.id, 600);
  // Anyone at the table may confirm the shared cut.
  const cut = await confirm(b, q);
  assert.equal(cut.status, 201, JSON.stringify(cut.body));
  const cutLine = cut.body.order.lines[0];
  assert.deepEqual([cutLine.quantity, cutLine.line_total_minor, cutLine.station, cutLine.prep_kind], [1, 294000, 'kitchen', 'cook']);

  const drinks = await submit(b, [latte(T.variants.iced, 2), latte(T.variants.hot)], 2 * 9000 + 8000);
  assert.equal(drinks.status, 201, JSON.stringify(drinks.body));
  const drinkLines = drinks.body.order.lines;
  assert.deepEqual(drinkLines.map((l: { variant_name: { en: string }; unit_price_minor: number; line_total_minor: number; station: string; prep_kind: string }) =>
    [l.variant_name.en, l.unit_price_minor, l.line_total_minor, l.station, l.prep_kind]), [
    ['Iced', 9000, 18000, 'bar', 'prepare'],
    ['Hot', 8000, 8000, 'bar', 'prepare'],
  ]);
  const decaf = await submit(b, [latte(T.variants.decaf)], 0);
  expectError(decaf, 409, 'cart_changed');
  assert.equal(decaf.body.error.details.quote.issues[0].code, 'variant_unavailable');

  // The bar and the grill each see only their own work.
  const bar = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}&station=bar`);
  assert.deepEqual(bar.body.orders.map((o: { id: string }) => o.id), [drinks.body.order.id]);
  const grill = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}&station=kitchen`);
  assert.deepEqual(grill.body.orders.map((o: { id: string }) => o.id), [cut.body.order.id]);

  // A ready drink does not make its round ready while the other drink is still being made.
  await advance(staff.kitchen, [cutLine.id, ...drinkLines.map((l: { id: string }) => l.id)], 'accepted');
  await advance(staff.kitchen, [cutLine.id, ...drinkLines.map((l: { id: string }) => l.id)], 'preparing');
  await advance(staff.kitchen, [drinkLines[0].id], 'ready');
  const round = (await a.get('/api/guest/orders')).body.orders.find((o: { id: string }) => o.id === drinks.body.order.id);
  assert.equal(round.status, 'preparing');

  // One shared bill for the table: one serving of the cut, never four.
  for (const g of [a, b]) {
    const bill = (await g.get('/api/guest/bill')).body;
    assert.equal(bill.total_minor, 294000 + 26000);
  }
  assert.deepEqual(visitLines(visit.id).map((l) => l.quantity), [1, 2, 1]);
});

test('different doneness on two steaks and included versus upgraded sides are separate, correctly priced lines', async () => {
  const { visit, guest } = await seat(4);
  const g = await guest();
  const round = [
    steak([T.options.rare], [T.options.fries]),                   // included side: 59000
    steak([T.options.medium], [T.options.salad]),                 // included side with its upgrade: 59000 + 3000
    steak([T.options.rare], [T.options.fries, T.options.salad]),  // one included (fries), one charged extra: 59000 + 12000
    steak([T.options.medium], [], 2),                             // two plates, no side: 2 x 59000
  ];
  const quoteRes = await g.post('/api/guest/quote', { lines: round });
  assert.deepEqual(quoteRes.body.issues, []);
  assert.equal(quoteRes.body.subtotal_minor, 310000);

  // A screen that treated the salad upgrade as free is refused, not charged differently.
  const wrong = await submit(g, round, 307000);
  expectError(wrong, 409, 'cart_changed');
  assert.equal(wrong.body.error.details.quote.subtotal_minor, 310000);
  assert.equal(orderCount(visit.id), 0);

  const res = await submit(g, round, 310000);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const lines = res.body.order.lines as Array<{ id: string; quantity: number; modifiers_minor: number; line_total_minor: number; modifiers: Array<{ group: { en: string }; options: Array<{ name: { en: string }; price_minor: number }> }> }>;
  assert.equal(lines.length, 4, 'different choices never merge into one line');
  assert.deepEqual(lines.map((l) => [l.quantity, l.modifiers_minor, l.line_total_minor]), [[1, 0, 59000], [1, 3000, 62000], [1, 12000, 71000], [2, 0, 118000]]);
  const choices = lines.map((l) => l.modifiers.map((m) => `${m.group.en}: ${m.options.map((o) => `${o.name.en} ${o.price_minor}`).join(', ')}`));
  assert.deepEqual(choices, [
    ['Test doneness: Rare 0', 'Test sides: Fries 0'],
    ['Test doneness: Medium 0', 'Test sides: Salad 3000'],
    ['Test doneness: Rare 0', 'Test sides: Fries 0, Salad 12000'],
    ['Test doneness: Medium 0'],
  ]);
  // The kitchen ticket shows each plate's doneness.
  const ticket = await staff.kitchen.get(`/api/staff/orders/${res.body.order.id}`);
  assert.deepEqual(ticket.body.lines.map((l: typeof lines[number]) => l.modifiers[0].options[0].name.en), ['Rare', 'Medium', 'Rare', 'Medium']);

  // Invalid choices are refused before anything reaches the kitchen.
  const refused = async (line: unknown, code: string) => {
    const r = await submit(g, [line], 59000);
    expectError(r, 409, 'cart_changed');
    assert.ok(r.body.error.details.quote.issues.some((i: { code: string }) => i.code === code), JSON.stringify(r.body.error.details.quote.issues));
  };
  await refused({ item_id: T.items.steak, quantity: 1, modifiers: [] }, 'modifier_required');
  await refused(steak([T.options.rare, T.options.medium]), 'modifier_invalid');
  await refused(steak([T.options.rare], [T.options.mash]), 'modifier_unavailable');
  await refused(steak([T.options.rare], [T.options.fries, T.options.salad, T.options.mash]), 'modifier_invalid');
  assert.equal(orderCount(visit.id), 1);
});

test('an item that goes out of season or sells out while in a draft triggers cart_changed; accepted orders keep their snapshot', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const dessert = { item_id: T.items.dessert, quantity: 1, modifiers: [] };
  const item = await adminItem(T.items.dessert);
  const reviewed = await staff.owner.post(`/api/staff/menu/items/${T.items.dessert}/review`, { review_status: 'verified', version: item.version });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));

  const first = await submit(g, [dessert, soup()], 18000 + 15000);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await advance(staff.kitchen, first.body.order.lines.map((l: { id: string }) => l.id), 'accepted');

  // The season ends while the guest has dessert in a new draft.
  const catalog = (await staff.manager.get('/api/staff/menu')).body;
  const category = catalog.categories.find((c: { id: string }) => c.id === T.categories.dessert);
  const today = todayBusinessDate(0);
  const ended = await staff.manager.patch(`/api/staff/menu/categories/${T.categories.dessert}`, {
    seasonal: true, active_from: addDays(today, -30), active_until: addDays(today, -1), version: category.version,
  });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));

  const draft = [{ ...dessert, quantity: 2 }, soup()];
  const review = await g.post('/api/guest/quote', { lines: draft });
  assert.deepEqual(review.body.issues.map((i: { line_index: number; code: string }) => [i.line_index, i.code]), [[0, 'not_orderable']]);
  assert.equal(review.body.subtotal_minor, 15000, 'the rest of the draft is still valid');
  const blocked = await submit(g, draft, 36000 + 15000);
  expectError(blocked, 409, 'cart_changed');
  assert.equal(blocked.body.error.details.quote.issues[0].line_index, 0);
  expectError(await staff.floor.post('/api/staff/orders/assist', { visit_id: visit.id, idempotency_key: key('as'), lines: [dessert], expected_subtotal_minor: 18000 }), 409, 'cart_changed');
  assert.equal(orderCount(visit.id), 1);
  const rest = await submit(g, [soup()], 15000);
  assert.equal(rest.status, 201, JSON.stringify(rest.body));

  // Sold out mid-draft behaves the same way.
  const soupItem = await adminItem(T.items.soup);
  assert.equal((await staff.kitchen.post(`/api/staff/menu/items/${T.items.soup}/availability`, { sold_out: true, version: soupItem.version })).status, 200);
  try {
    const soldOut = await submit(g, [soup()], 15000);
    expectError(soldOut, 409, 'cart_changed');
    assert.equal(soldOut.body.error.details.quote.issues[0].code, 'sold_out');
  } finally {
    assert.equal((await staff.kitchen.post(`/api/staff/menu/items/${T.items.soup}/availability`, { sold_out: false })).status, 200);
  }
  assert.equal(orderCount(visit.id), 2);

  // The accepted dessert keeps its price and place on the bill.
  const bill = (await g.get('/api/guest/bill')).body;
  const dessertLine = bill.lines.find((l: { name: { en: string } }) => l.name.en === 'Test Tiramisu');
  assert.deepEqual([dessertLine?.line_total_minor, dessertLine?.status], [18000, 'accepted']);
  assert.equal(bill.total_minor, 33000);
  assert.equal(bill.pending_lines.length, 1);
});

test('quote choices are validated like a cart line, and a charged choice is part of the agreed amount', async () => {
  // The owner attaches the (test) doneness and sides groups to the cut; the rate stays approved.
  const rib = await adminItem(RIB);
  const linked = await staff.manager.patch(`/api/staff/menu/items/${RIB}`, { modifier_group_ids: [T.groups.doneness, T.groups.sides], version: rib.version });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.review_status, 'verified');
  try {
    const { visit, guest } = await seat();
    const g = await guest();
    const req = await newRequest(g);
    const v = req.version;
    const choice = (doneness: string[], sides: string[]) => [
      { group_id: T.groups.doneness, option_ids: doneness },
      ...(sides.length ? [{ group_id: T.groups.sides, option_ids: sides }] : []),
    ];
    expectError(await quote(staff.kitchen, req.id, 300, v), 422, 'validation_failed');
    expectError(await quote(staff.kitchen, req.id, 300, v, { choices: choice([T.options.rare], [T.options.mash]) }), 422, 'validation_failed');
    expectError(await quote(staff.kitchen, req.id, 300, v, { choices: [...choice([T.options.rare], []), { group_id: 'mgr_not_linked', option_ids: [T.options.rare] }] }), 422, 'validation_failed');
    assert.deepEqual(quoteRows(req.id), []);

    // Medium, salad as the included side with its 30 THB upgrade: 300 g = 1,470 THB + 30 THB.
    const q = await quote(staff.kitchen, req.id, 300, v, { choices: choice([T.options.medium], [T.options.salad]) });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const shown = q.body.quote;
    assert.deepEqual([shown.measured_minor, shown.modifiers_minor, shown.amount_minor], [147000, 3000, 150000]);
    assert.deepEqual(shown.choices.map((c: { group: { en: string }; options: Array<{ name: { en: string } }> }) => [c.group.en, c.options.map((o) => o.name.en)]),
      [['Test doneness', ['Medium']], ['Test sides', ['Salad']]]);
    const conf = await confirm(g, q.body);
    assert.equal(conf.status, 201, JSON.stringify(conf.body));
    const line = conf.body.order.lines[0];
    assert.deepEqual([line.measured_grams, line.unit_price_minor, line.modifiers_minor, line.line_total_minor], [300, 147000, 3000, 150000]);
    assert.deepEqual(line.modifiers.map((m: { options: Array<{ name: { en: string }; price_minor: number }> }) => m.options.map((o) => [o.name.en, o.price_minor])),
      [[['Medium', 0]], [['Salad', 3000]]]);

    // Two sides: fries is the included one, salad becomes a full-price extra (250 g = 1,225 THB + 120 THB).
    const req2 = await newRequest(g);
    const q2 = await quoted(staff.floor, req2.id, 250, { choices: choice([T.options.rare], [T.options.salad, T.options.fries]) });
    assert.equal(q2.quote!.amount_minor, 134500);
    assert.equal((await confirm(g, q2)).status, 201);
    assert.deepEqual(visitLines(visit.id).map((l) => l.line_total_minor), [150000, 134500]);
  } finally {
    const current = await adminItem(RIB);
    const unlinked = await staff.manager.patch(`/api/staff/menu/items/${RIB}`, { modifier_group_ids: [], version: current.version });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
  }
});

// Last: it changes the prime rib rate for the rest of this file.
test('a rate change needs owner approval; a quote keeps the rate it was approved at and new quotes round half-up', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const early = await quoted(staff.kitchen, (await newRequest(g)).id, 333);
  assert.equal(early.quote!.amount_minor, 163170);
  const later = await newRequest(g);
  const small = await newRequest(g);

  const rib = await adminItem(RIB);
  const repriced = await staff.manager.patch(`/api/staff/menu/items/${RIB}`, { rate_minor: 49050, price_change_reason: 'New supplier price', version: rib.version });
  assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
  assert.equal(repriced.body.review_status, 'needs_review');

  // Not quotable at an unapproved rate.
  const unapproved = await quote(staff.kitchen, later.id, 333, later.version);
  expectError(unapproved, 409, 'item_unavailable');
  assert.equal(unapproved.body.error.details.reason, 'not_verified');

  // The earlier quote was made at an approved rate and keeps its snapshot (D-22).
  const earlyConf = await confirm(g, early);
  assert.equal(earlyConf.status, 201, JSON.stringify(earlyConf.body));
  assert.deepEqual([earlyConf.body.order.lines[0].rate_minor, earlyConf.body.order.lines[0].line_total_minor], [49000, 163170]);

  const approved = await staff.owner.post(`/api/staff/menu/items/${RIB}/review`, { review_status: 'verified', version: repriced.body.version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  // 333 g x 490.50 / 100 g = 1,633.365 THB -> 163336.5 satang -> 163337 (half-up).
  const laterQ = await quoted(staff.kitchen, later.id, 333);
  assert.deepEqual([laterQ.quote!.rate_minor, laterQ.quote!.amount_minor], [49050, 163337]);
  // 101 g -> 49540.5 satang -> 49541.
  const smallQ = await quoted(staff.floor, small.id, 101);
  assert.equal(smallQ.quote!.amount_minor, 49541);

  for (const q of [laterQ, smallQ]) assert.equal((await confirm(g, q)).status, 201);
  const rows = visitLines(visit.id);
  assert.deepEqual(rows.map((l) => [l.measured_grams, l.rate_minor, l.line_total_minor]), [[333, 49000, 163170], [333, 49050, 163337], [101, 49050, 49541]]);
  await advance(staff.kitchen, rows.map((l) => l.id), 'accepted');
  assert.equal((await g.get('/api/guest/bill')).body.total_minor, 163170 + 163337 + 49541);
});
