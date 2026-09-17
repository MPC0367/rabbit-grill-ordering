// Billing, payment records and Complete checkout (brief 16, 23, 30, 36, 43; D-12, D-13).
//
// Every test seats its own party at a table created for it, so tests stay
// independent while sharing one server. Money is asserted in exact satang.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, key, startServer, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

let srv: TestServer;
let owner: Client;
let manager: Client;
let cashier: Client;
let floor: Client;
let kitchen: Client;

before(async () => {
  // TRUST_PROXY_HOPS=1 lets each simulated phone join from its own address, so the
  // per-address join limit (10 a minute) does not throttle a file that seats many parties.
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  [owner, manager, cashier, floor, kitchen] = await Promise.all(
    (['owner', 'manager', 'cashier', 'floor', 'kitchen'] as const).map((r) => srv.staff(r)),
  );
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
type Line = Record<string, unknown>;
const SOUP = (quantity = 1): Line => ({ item_id: T.items.soup, quantity, modifiers: [] }); // 150 THB
const LATTE_HOT = (quantity = 1): Line => ({ item_id: T.items.coffee, variant_id: T.variants.hot, quantity, modifiers: [] }); // 80 THB
// 590 THB steak, salad as the included side: pays only its 30 THB upgrade.
const STEAK_SALAD: Line = {
  item_id: T.items.steak, quantity: 1,
  modifiers: [{ group_id: T.groups.doneness, option_ids: [T.options.rare] }, { group_id: T.groups.sides, option_ids: [T.options.salad] }],
};

const show = (r: HttpResult) => `${r.status} ${JSON.stringify(r.body)}`;
function expectError(r: HttpResult, status: number, code: string): any {
  assert.equal(r.status, status, show(r));
  assert.equal(r.body?.error?.code, code, show(r));
  return r.body.error.details;
}
function ok(r: HttpResult, status = 200): any {
  assert.equal(r.status, status, show(r));
  return r.body;
}
/** node:sqlite rows have a null prototype; copy them into plain objects for deepEqual. */
function rows<R = any>(query: string, params: unknown[] = []): R[] {
  return srv.sql(query, params).map((r) => ({ ...r })) as R[];
}
const count = (query: string, params: unknown[] = []): number => Number(rows<{ n: number }>(query, params)[0].n);

let ipSeq = 0;
/** A new phone joins with the table QR and PIN, from its own address. */
async function join(token: string, pin: string | null): Promise<Client> {
  const c = srv.client();
  ipSeq++;
  const r = await c.request('POST', '/api/public/qr/join', { token, ...(pin ? { pin } : {}) }, {
    'X-Forwarded-For': `10.20.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`,
  });
  assert.ok(r.status === 201 || r.status === 200, `join: ${show(r)}`);
  return c;
}

let tableSeq = 0;
async function newTable(): Promise<{ id: string; label: string; token: string }> {
  tableSeq++;
  const label = `B${String(tableSeq).padStart(2, '0')}`;
  const t = ok(await manager.post('/api/staff/tables', { label, zone: 'Billing tests' }), 201);
  const [row] = rows<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [t.id]);
  return { id: t.id, label, token: row.token };
}

async function openVisit(tableId: string): Promise<any> {
  return ok(await floor.post(`/api/staff/tables/${tableId}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
}

/** A new table with a seated party and one joined phone. */
async function seat() {
  const table = await newTable();
  const visit = await openVisit(table.id);
  const guest = await join(table.token, visit.join_pin);
  return { table, visit, guest };
}

async function order(guest: Client, lines: Line[], subtotal: number): Promise<any> {
  const r = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: subtotal });
  return ok(r, 201).order;
}

function lineRefs(visitId: string, status: string): Array<{ id: string; version: number }> {
  return rows('SELECT id, version FROM order_lines WHERE visit_id = ? AND status = ? ORDER BY submitted_at, line_no', [visitId, status]);
}

async function move(staff: Client, visitId: string, from: string, to: string, reason?: string): Promise<void> {
  const lines = lineRefs(visitId, from);
  if (lines.length === 0) return;
  ok(await staff.post('/api/staff/orders/transition', { lines, to, reason }));
}
const acceptAll = (visitId: string) => move(kitchen, visitId, 'submitted', 'accepted');
async function serveAll(visitId: string): Promise<void> {
  await acceptAll(visitId);
  await move(kitchen, visitId, 'accepted', 'preparing');
  await move(kitchen, visitId, 'preparing', 'ready');
  await move(floor, visitId, 'ready', 'served');
}

async function bill(visitId: string, as: Client = cashier): Promise<any> {
  return ok(await as.get(`/api/staff/visits/${visitId}/bill`));
}
async function startBilling(visitId: string): Promise<any> {
  const b = await bill(visitId);
  return ok(await floor.post(`/api/staff/visits/${visitId}/billing/start`, { version: b.visit_version }));
}
async function finalize(visitId: string, expectedTotal: number): Promise<any> {
  const b = await bill(visitId);
  const fin = ok(await cashier.post(`/api/staff/visits/${visitId}/bill/finalize`, { bill_version: b.bill_version, expected_total_minor: expectedTotal }));
  assert.equal(fin.current_revision.status, 'payable');
  assert.equal(fin.current_revision.total_minor, expectedTotal);
  return fin;
}
function pay(visitId: string, revision: { id: string; total_minor: number }, extra: Record<string, unknown> = {}, as: Client = cashier) {
  return as.post(`/api/staff/visits/${visitId}/payments`, {
    revision_id: revision.id, method: 'cash', amount_minor: revision.total_minor, idempotency_key: key('pay'), ...extra,
  });
}
function checkout(visitId: string, extra: Record<string, unknown> = {}, as: Client = cashier) {
  return as.post(`/api/staff/visits/${visitId}/checkout`, { idempotency_key: key('co'), ...extra });
}
async function tile(tableId: string, as: Client = floor): Promise<any> {
  const t = ok(await as.get('/api/staff/tables')).tables.find((x: { id: string }) => x.id === tableId);
  assert.ok(t, `table ${tableId} missing from the grid`);
  return t;
}
const visitRow = (id: string): any => rows('SELECT * FROM visits WHERE id = ?', [id])[0];

/** Open a live event stream as `c` and collect its text until closed. */
async function watchStream(c: Client, path: string) {
  const ctrl = new AbortController();
  const res = await fetch(srv.url + path, {
    headers: { Accept: 'text/event-stream', Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  return {
    text: () => text,
    ended: () => ended,
    async waitFor(pred: (t: string) => boolean, ms = 5000) {
      const until = Date.now() + ms;
      while (!pred(text)) {
        if (Date.now() > until) throw new Error(`stream ${path} never matched; received:\n${text}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close() { ctrl.abort(); await pump; },
  };
}
const auditCount = (visitId: string, action: string) =>
  count('SELECT COUNT(*) AS n FROM audit_events WHERE visit_id = ? AND action = ?', [visitId, action]);

// ------------------------------------------------------------------ checkout blockers
test('checkout refuses with the exact remaining blockers at every step and keeps the table occupied', async () => {
  const { table, visit, guest } = await seat();
  await order(guest, [SOUP(2), LATTE_HOT()], 38000);

  // Still dining, food not accepted: Start checkout comes first, and the reply says what remains.
  let d = expectError(await checkout(visit.id), 409, 'invalid_transition');
  assert.deepEqual(d.blockers, ['unresolved_orders']);
  assert.equal(d.remaining.unresolved_lines.length, 2);
  assert.equal((await tile(table.id)).state, 'dining');

  await acceptAll(visit.id);
  await startBilling(visit.id);
  assert.equal((await tile(table.id)).state, 'checking_out');

  d = expectError(await checkout(visit.id), 409, 'unresolved_orders');
  assert.deepEqual(d.blockers, ['unresolved_orders', 'bill_not_finalized', 'unpaid_bill']);
  assert.equal(d.remaining.amount_due_minor, 38000);
  assert.equal(d.remaining.revision_no, null);
  assert.equal(d.remaining.unresolved_lines.length, 2);

  await finalize(visit.id, 38000);
  d = expectError(await checkout(visit.id), 409, 'unresolved_orders');
  assert.deepEqual(d.blockers, ['unresolved_orders', 'unpaid_bill']);
  assert.equal(d.remaining.revision_no, 1);
  assert.equal(d.remaining.revision_status, 'payable');
  assert.equal(d.remaining.amount_due_minor, 38000);

  // The staff bill reports the same blockers the checkout action enforces.
  const b = await bill(visit.id);
  assert.equal(b.can_checkout, false);
  assert.deepEqual(b.checkout_blockers, ['unresolved_orders', 'unpaid_bill']);
  assert.equal(b.unresolved.unserved_lines, 2);
  assert.equal(b.unresolved.submitted_lines, 0);

  await serveAll(visit.id);
  d = expectError(await checkout(visit.id), 409, 'unpaid_bill');
  assert.deepEqual(d.blockers, ['unpaid_bill']);
  assert.deepEqual(d.remaining.unresolved_lines, []);
  assert.equal(d.remaining.amount_due_minor, 38000);

  // Nothing moved: the party keeps the table, its PIN and its access.
  const v = visitRow(visit.id);
  assert.equal(v.status, 'billing');
  assert.equal(v.join_pin, visit.join_pin);
  assert.equal(v.closed_at, null);
  assert.equal((await tile(table.id)).state, 'checking_out');
  const gb = ok(await guest.get('/api/guest/bill'));
  assert.equal(gb.paid, false);
  assert.equal(gb.total_minor, 38000);
  assert.equal(gb.revision_no, 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM guest_sessions WHERE visit_id = ? AND revoked_at IS NOT NULL', [visit.id]), 0);
  assert.equal(auditCount(visit.id, 'visit.checkout'), 0);
});

test('payment confirmed before the food is served does not free the table', async () => {
  const { table, visit, guest } = await seat();
  await order(guest, [SOUP(), STEAK_SALAD], 15000 + 62000);
  await acceptAll(visit.id);
  await startBilling(visit.id);
  const fin = await finalize(visit.id, 77000);

  const paid = ok(await pay(visit.id, fin.current_revision, { tendered_minor: 100000 }));
  assert.equal(paid.paid, true);
  assert.equal(paid.bill_status, 'settled');
  assert.equal(paid.current_revision.status, 'settled');
  assert.equal(paid.payments.length, 1);
  assert.equal(paid.payments[0].amount_minor, 77000);
  assert.equal(paid.payments[0].tendered_minor, 100000);
  assert.equal(paid.payments[0].change_minor, 23000);
  assert.equal(paid.payments[0].confirmed_by, 'Test cashier');

  // Paying does not serve food, close the visit or free the table.
  assert.equal(count(`SELECT COUNT(*) AS n FROM order_lines WHERE visit_id = ? AND status = 'accepted'`, [visit.id]), 2);
  assert.equal(visitRow(visit.id).status, 'billing');
  const t = await tile(table.id);
  assert.equal(t.state, 'checking_out');
  assert.equal(t.visit.unresolved_lines, 2);
  const d = expectError(await checkout(visit.id), 409, 'unresolved_orders');
  assert.deepEqual(d.blockers, ['unresolved_orders']);
  assert.equal(d.remaining.amount_due_minor, 0);
  const gb = ok(await guest.get('/api/guest/bill'));
  assert.equal(gb.paid, true);
  assert.equal(gb.checkout_complete, false);

  await serveAll(visit.id);
  const co = ok(await checkout(visit.id));
  assert.equal(co.table.state, 'available');
  assert.equal(co.replayed, false);
});

// ------------------------------------------------------------------ the checkout transaction
test('complete checkout closes the visit, revokes every guest, clears the PIN, resolves requests attributably and frees the table', async () => {
  const { table, visit, guest } = await seat();
  const guest2 = await join(table.token, visit.join_pin);
  await order(guest, [SOUP()], 15000);

  // Open requests: water (sent), call staff (acknowledged) and the bill request.
  ok(await guest2.post('/api/guest/service', { type: 'water', idempotency_key: key('svc') }), 201);
  const call = ok(await guest.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }), 201);
  ok(await floor.post(`/api/staff/service/${call.id}/transition`, { to: 'acknowledged', version: call.version }));
  const requested = ok(await guest.post('/api/guest/bill/request', { idempotency_key: key('bill') }));
  assert.ok(requested.bill_requested_at);

  await serveAll(visit.id);
  await startBilling(visit.id);
  const fin = await finalize(visit.id, 15000);
  ok(await pay(visit.id, fin.current_revision));

  const before = await tile(table.id);
  assert.equal(before.state, 'checking_out');
  assert.equal(before.visit.open_requests, 3);
  assert.equal(before.visit.guests, 2);
  const b = await bill(visit.id);
  assert.equal(b.can_checkout, true);
  assert.deepEqual(b.checkout_blockers, ['open_requests']); // informational, closed by checkout

  const staleTab = guest.clone(); // a second tab that has not heard about the checkout yet
  // A connected phone and a staff tablet are listening live.
  const guestStream = await watchStream(guest2, '/api/guest/events');
  const staffStream = await watchStream(floor, '/api/staff/events');
  await guestStream.waitFor((s) => s.includes('event: hello'));
  await staffStream.waitFor((s) => s.includes('event: hello'));

  const closeKey = key('co');
  const co = ok(await checkout(visit.id, { idempotency_key: closeKey, request_close_reason: 'Party left before staff reached them' }));

  // After commit: the phone is told its visit ended and the stream closes; staff get visit.closed.
  await guestStream.waitFor((s) => /event: access\s*\ndata: \{"state":"ended"\}/.test(s));
  await guestStream.waitFor(() => guestStream.ended());
  await staffStream.waitFor((s) => s.includes('"topic":"visit.closed"') && s.includes(visit.id));
  for (const s of [guestStream.text(), staffStream.text()]) assert.ok(!/pin|token/i.test(s), 'streams never carry PINs or tokens');
  await Promise.all([guestStream.close(), staffStream.close()]);
  assert.equal(co.status, 'closed');
  assert.equal(co.visit_id, visit.id);
  assert.equal(co.replayed, false);
  assert.equal(co.table.state, 'available');
  assert.equal(co.table.visit, null);
  assert.deepEqual(co.table.attention, []);

  // The visit row: closed, attributed, PIN gone.
  const v = visitRow(visit.id);
  assert.equal(v.status, 'closed');
  assert.equal(v.join_pin, null);
  assert.equal(v.closed_by, 'stf_cashier');
  assert.equal(v.closed_at, co.closed_at);
  assert.equal(v.close_idempotency_key, closeKey);
  assert.equal(v.close_exception, null);
  assert.equal(count('SELECT COUNT(*) AS n FROM guest_sessions WHERE visit_id = ? AND revoked_at IS NULL', [visit.id]), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM guest_sessions WHERE visit_id = ? AND revoke_reason = 'checkout'`, [visit.id]), 2);

  // Requests: the bill was handled; the rest are cancelled with the given reason, by the cashier.
  const reqs = rows('SELECT type, status, close_reason, completed_by, cancelled_by FROM service_requests WHERE visit_id = ? ORDER BY type', [visit.id]);
  assert.deepEqual(reqs, [
    { type: 'bill', status: 'completed', close_reason: 'Bill handled at checkout', completed_by: 'Test cashier', cancelled_by: null },
    { type: 'call_staff', status: 'cancelled', close_reason: 'Party left before staff reached them', completed_by: null, cancelled_by: 'Test cashier' },
    { type: 'water', status: 'cancelled', close_reason: 'Party left before staff reached them', completed_by: null, cancelled_by: 'Test cashier' },
  ]);

  // Audit and outbox: one checkout, published once.
  assert.equal(auditCount(visit.id, 'visit.checkout'), 1);
  assert.equal(auditCount(visit.id, 'service.cancelled_at_checkout'), 2);
  assert.equal(auditCount(visit.id, 'service.completed_at_checkout'), 1);
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE visit_id = ? AND topic = 'visit.closed'`, [visit.id]), 1);

  // Old credentials: visit ended, nothing readable or writable. (The harness drops a
  // cookie the server clears, so each probe uses a fresh copy of the stale tab.)
  const stale = () => staleTab.clone();
  expectError(await stale().get('/api/guest/bill'), 410, 'visit_closed');
  expectError(await stale().get('/api/guest/orders'), 410, 'visit_closed');
  expectError(await stale().post('/api/guest/orders', { idempotency_key: key('att'), lines: [SOUP()], expected_subtotal_minor: 15000 }), 410, 'visit_closed');
  expectError(await guest2.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }), 410, 'visit_closed');
  expectError(await guest2.post('/api/guest/bill/request', { idempotency_key: key('bill') }), 401, 'visit_access_required'); // cookie was cleared

  // History is kept for staff.
  const detail = ok(await manager.get(`/api/staff/visits/${visit.id}`));
  assert.equal(detail.status, 'closed');
  assert.equal(detail.join_pin, null);
  assert.equal(detail.orders.length, 1);
  assert.equal(detail.bill.paid, true);
  assert.equal(detail.bill.payments.length, 1);
  assert.equal(detail.bill.checkout_complete, true);

  // The next party at the same QR gets a fresh visit; the old phone is not carried over.
  const next = await openVisit(table.id);
  assert.notEqual(next.id, visit.id);
  expectError(await stale().get('/api/guest/session'), 410, 'visit_closed');
  expectError(await stale().post('/api/guest/orders', { idempotency_key: key('att'), lines: [SOUP()], expected_subtotal_minor: 15000 }), 410, 'visit_closed');
  if (next.join_pin !== visit.join_pin) {
    // The old PIN does not open the new visit (PINs are random; skip the 1-in-10,000 repeat).
    const r = await srv.client().request('POST', '/api/public/qr/join', { token: table.token, pin: visit.join_pin }, { 'X-Forwarded-For': '10.99.0.1' });
    expectError(r, 401, 'pin_invalid');
  }
  const fresh = ok(await manager.get(`/api/staff/visits/${next.id}`));
  assert.deepEqual(fresh.orders, []);
  assert.deepEqual(fresh.guests, []);
  assert.equal(fresh.bill.total_minor, 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM orders WHERE visit_id = ?', [next.id]), 0);
});

test('a lost checkout response is recovered by replaying the same key', async () => {
  const { table, visit } = await seat();
  const k = key('co');
  const first = ok(await checkout(visit.id, { idempotency_key: k }));
  assert.equal(first.replayed, false);

  const again = ok(await checkout(visit.id, { idempotency_key: k }, manager));
  assert.equal(again.replayed, true);
  assert.equal(again.closed_at, first.closed_at);
  assert.equal(again.table.state, 'available');
  // A second device with its own key also just sees the closed result.
  const other = ok(await checkout(visit.id));
  assert.equal(other.replayed, true);
  assert.equal(other.closed_at, first.closed_at);
  assert.equal(auditCount(visit.id, 'visit.checkout'), 1);

  // The key belongs to that visit: it cannot close the next party's visit.
  const next = await openVisit(table.id);
  expectError(await checkout(next.id, { idempotency_key: k }), 409, 'idempotency_mismatch');
  assert.equal(visitRow(next.id).status, 'open');
  assert.equal((await tile(table.id)).state, 'dining');
});

test('finish order changes fulfilment only: the table stays occupied and the bill untouched', async () => {
  const { table, visit, guest } = await seat();
  const placed = await order(guest, [SOUP()], 15000);
  await acceptAll(visit.id);
  await move(kitchen, visit.id, 'accepted', 'preparing');
  await move(kitchen, visit.id, 'preparing', 'ready');

  const o = ok(await floor.get(`/api/staff/orders/${placed.id}`));
  const [line] = lineRefs(visit.id, 'ready');
  const finished = ok(await floor.post(`/api/staff/orders/${placed.id}/finish`, {
    version: o.version, resolutions: [{ line_id: line.id, version: line.version, action: 'served' }],
  }));
  assert.ok(finished.finished_at);
  assert.equal(finished.status, 'served');

  assert.equal(visitRow(visit.id).status, 'open');
  const t = await tile(table.id);
  assert.equal(t.state, 'dining');
  const b = await bill(visit.id);
  assert.equal(b.bill_status, 'open');
  assert.equal(b.current_revision, null);
  assert.deepEqual(b.payments, []);
  assert.equal(b.total_minor, 15000);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE visit_id = ? AND (action LIKE 'bill.%' OR action LIKE 'payment.%' OR action LIKE 'visit.checkout%')`, [visit.id]), 0);

  // After payment, finishing again is refused and still touches nothing.
  await startBilling(visit.id);
  const fin = await finalize(visit.id, 15000);
  ok(await pay(visit.id, fin.current_revision));
  const o2 = ok(await floor.get(`/api/staff/orders/${placed.id}`));
  expectError(await floor.post(`/api/staff/orders/${placed.id}/finish`, { version: o2.version, resolutions: [] }), 409, 'already_done');
  assert.equal((await bill(visit.id)).bill_status, 'settled');
  assert.equal((await tile(table.id)).state, 'checking_out');

  assert.equal(ok(await checkout(visit.id)).table.state, 'available');
});

test('a disabled table stays Disabled after checkout', async () => {
  const { table, visit, guest } = await seat();
  await order(guest, [SOUP()], 15000);
  await serveAll(visit.id);

  // Disabling a table with a party at it keeps their bill; it only blocks new orders.
  const t0 = await tile(table.id);
  const disabled = ok(await manager.patch(`/api/staff/tables/${table.id}`, { enabled: false, version: t0.version }));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.state, 'dining');
  expectError(await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines: [SOUP()], expected_subtotal_minor: 15000 }), 403, 'table_disabled');

  await startBilling(visit.id);
  assert.equal((await tile(table.id)).state, 'checking_out');
  const fin = await finalize(visit.id, 15000);
  ok(await pay(visit.id, fin.current_revision));
  const co = ok(await checkout(visit.id));
  assert.equal(co.table.state, 'disabled');

  const grid = ok(await floor.get('/api/staff/tables'));
  assert.equal(grid.tables.find((x: { id: string }) => x.id === table.id).state, 'disabled');
  expectError(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 403, 'table_disabled');
  const scan = ok(await srv.client().post('/api/public/qr/resolve', { token: table.token }));
  assert.equal(scan.state, 'disabled');
});

test('a party with nothing to pay is checked out straight from Dining, and a zero bill is recorded as settled', async () => {
  // Nothing ordered at all.
  const a = await seat();
  const coA = ok(await checkout(a.visit.id));
  assert.equal(coA.table.state, 'available');
  assert.equal(count('SELECT COUNT(*) AS n FROM guest_sessions WHERE visit_id = ? AND revoked_at IS NULL', [a.visit.id]), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ?', [a.visit.id]), 0);
  const [auditA] = rows(`SELECT after_json FROM audit_events WHERE visit_id = ? AND action = 'visit.checkout'`, [a.visit.id]);
  assert.equal(JSON.parse(auditA.after_json).amount_due_minor, 0);

  // Everything ordered was rejected: nothing chargeable, nothing unresolved.
  const b = await seat();
  await order(b.guest, [SOUP()], 15000);
  await move(kitchen, b.visit.id, 'submitted', 'rejected', 'Soup is finished for today');
  assert.equal(ok(await checkout(b.visit.id)).table.state, 'available');

  // A finalized zero bill needs no payment and is not left as an unpaid exception.
  const c = await seat();
  await order(c.guest, [SOUP()], 15000);
  await move(kitchen, c.visit.id, 'submitted', 'rejected', 'Soup is finished for today');
  await startBilling(c.visit.id);
  const fin = await finalize(c.visit.id, 0);
  assert.deepEqual(fin.current_revision.lines, []);
  assert.equal(fin.excluded_lines.length, 1);
  assert.deepEqual(fin.checkout_blockers, []);
  const kpiExceptions = async () => ok(await owner.get('/api/staff/stats/kpis')).payment_exceptions; // this week, owner sees money
  const exceptionsBefore = await kpiExceptions();
  const coC = ok(await checkout(c.visit.id));
  assert.equal(coC.table.state, 'available');
  assert.deepEqual(rows('SELECT status FROM bills WHERE visit_id = ?', [c.visit.id]), [{ status: 'settled' }]);
  assert.deepEqual(rows('SELECT status, total_minor FROM bill_revisions WHERE visit_id = ?', [c.visit.id]), [{ status: 'settled', total_minor: 0 }]);
  assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [c.visit.id]), 0);
  const list = ok(await manager.get('/api/staff/payments'));
  assert.equal(list.exceptions.filter((e: { visit_id: string }) => e.visit_id === c.visit.id).length, 0);
  // The KPI "payment exceptions" agree with the payments screen: a settled zero bill is not one.
  assert.deepEqual(await kpiExceptions(), exceptionsBefore);
});

test('a manager can close a visit with a recorded exception; a cashier cannot', async () => {
  const { table, visit, guest } = await seat();
  await order(guest, [SOUP()], 15000);
  await acceptAll(visit.id);
  const reason = 'Guest left without paying; manager informed';
  // Current behaviour (reported as a product question): a table still Dining with food on it
  // must be moved to Checking out first; the exception applies only from there.
  expectError(await checkout(visit.id, { exception_reason: reason }, manager), 409, 'invalid_transition');
  await startBilling(visit.id);
  await finalize(visit.id, 15000);

  let d = expectError(await checkout(visit.id, { exception_reason: reason }), 403, 'forbidden');
  assert.equal(d.permission, 'visits.close_exception');
  expectError(await checkout(visit.id, {}, floor), 403, 'forbidden'); // floor cannot complete checkout at all
  d = expectError(await checkout(visit.id, {}, manager), 409, 'unresolved_orders'); // no reason, no exception
  assert.deepEqual(d.blockers, ['unresolved_orders', 'unpaid_bill']);
  expectError(await checkout(visit.id, { exception_reason: '   ' }, manager), 409, 'unresolved_orders');
  assert.equal(visitRow(visit.id).status, 'billing');
  assert.equal((await tile(table.id)).state, 'checking_out');
  const kpiExceptions = async () => ok(await owner.get('/api/staff/stats/kpis')).payment_exceptions;
  const exceptionsBefore = await kpiExceptions();

  const co = ok(await checkout(visit.id, { exception_reason: reason }, manager));
  assert.equal(co.table.state, 'available');
  const v = visitRow(visit.id);
  assert.equal(v.status, 'closed');
  assert.equal(v.close_exception, reason);
  assert.equal(v.closed_by, 'stf_manager');

  const [exc] = rows(`SELECT actor_label, reason, after_json FROM audit_events WHERE visit_id = ? AND action = 'visit.close_exception'`, [visit.id]);
  assert.equal(exc.actor_label, 'Test manager');
  assert.equal(exc.reason, reason);
  const after = JSON.parse(exc.after_json);
  assert.deepEqual(after.blockers, ['unresolved_orders', 'unpaid_bill']);
  assert.equal(after.remaining.amount_due_minor, 15000);
  assert.deepEqual(rows(`SELECT reason FROM audit_events WHERE visit_id = ? AND action = 'visit.checkout'`, [visit.id]), [{ reason }]);

  // The dish that never came is resolved (D-S8-16): cancelled with the exception as its reason and a
  // cancel step, so it no longer counts as sold. The bill stays unpaid and the exception is listed.
  assert.deepEqual(rows('SELECT status, status_reason FROM order_lines WHERE visit_id = ?', [visit.id]),
    [{ status: 'cancelled', status_reason: `Closed by manager exception: ${reason}` }]);
  assert.equal(count(`SELECT COUNT(*) AS n FROM line_events WHERE visit_id = ? AND kind = 'cancel' AND actor_id = 'stf_manager'`, [visit.id]), 1);
  assert.equal(JSON.parse(rows(`SELECT after_json FROM audit_events WHERE visit_id = ? AND action = 'visit.checkout'`, [visit.id])[0].after_json).lines_resolved, 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [visit.id]), 0);
  const list = ok(await manager.get('/api/staff/payments'));
  const listed = list.exceptions.filter((e: { visit_id: string }) => e.visit_id === visit.id);
  assert.deepEqual(listed.map((e: any) => [e.kind, e.amount_minor, e.reason]), [['closed_with_exception', 15000, reason]]);
  // The unpaid, closed revision is one payment exception worth its total on the KPI screen.
  const exceptionsAfter = await kpiExceptions();
  assert.equal(exceptionsAfter.count, exceptionsBefore.count + 1);
  assert.equal(exceptionsAfter.value_minor, exceptionsBefore.value_minor + 15000);
});

// ------------------------------------------------------------------ reopen, reversal, adjustments
test('reopening needs a manager and a reason, supersedes the payable revision and keeps its history', async () => {
  const { table, visit, guest } = await seat();
  await order(guest, [SOUP()], 15000);
  await acceptAll(visit.id);
  await startBilling(visit.id);
  const rev1 = (await finalize(visit.id, 15000)).current_revision;
  expectError(await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines: [LATTE_HOT()], expected_subtotal_minor: 8000 }), 409, 'visit_billing');

  const b = await bill(visit.id);
  const reopen = (as: Client, body: Record<string, unknown>) => as.post(`/api/staff/visits/${visit.id}/billing/reopen`, body);
  expectError(await reopen(cashier, { version: b.visit_version, reason: 'Guests want another drink' }), 403, 'forbidden');
  expectError(await reopen(manager, { version: b.visit_version }), 422, 'validation_failed');
  expectError(await reopen(manager, { version: b.visit_version, reason: 'no' }), 422, 'validation_failed');
  expectError(await reopen(manager, { version: b.visit_version - 1, reason: 'Guests want another drink' }), 409, 'stale_version');

  const reopened = ok(await reopen(manager, { version: b.visit_version, reason: 'Guests want another drink' }));
  assert.equal(reopened.visit_status, 'open');
  assert.equal(reopened.bill_status, 'open');
  assert.equal(reopened.current_revision, null);
  assert.equal(reopened.revision_no, null);
  assert.equal(reopened.revisions.length, 1);
  assert.equal(reopened.revisions[0].id, rev1.id);
  assert.equal(reopened.revisions[0].status, 'superseded');
  assert.equal(reopened.revisions[0].supersede_reason, 'Guests want another drink');
  assert.equal(reopened.revisions[0].total_minor, 15000);
  assert.equal((await tile(table.id)).state, 'dining');
  assert.deepEqual(rows(`SELECT actor_label, reason FROM audit_events WHERE visit_id = ? AND action = 'bill.reopen'`, [visit.id]),
    [{ actor_label: 'Test manager', reason: 'Guests want another drink' }]);

  // The superseded revision can no longer be paid.
  expectError(await pay(visit.id, rev1), 409, 'bill_changed');

  const latte = await order(guest, [LATTE_HOT()], 8000);
  await acceptAll(visit.id);
  await startBilling(visit.id);
  const fin2 = await finalize(visit.id, 23000);
  const rev2 = fin2.current_revision;
  assert.equal(rev2.revision_no, 2);
  assert.deepEqual(fin2.revisions.map((r: any) => [r.revision_no, r.status, r.total_minor]), [[2, 'payable', 23000], [1, 'superseded', 15000]]);
  // Revision 1 is frozen: the drink ordered after it is not on it.
  const rev1Now = fin2.revisions[1];
  assert.equal(rev1Now.lines.length, 1);
  assert.ok(!rev1Now.lines.some((l: { line_id: string }) => l.line_id === latte.lines[0].id));
  assert.ok(rev2.lines.some((l: { line_id: string }) => l.line_id === latte.lines[0].id));
  assert.equal(count(`SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ? AND status = 'payable'`, [visit.id]), 1);

  const gb = ok(await guest.get('/api/guest/bill'));
  assert.equal(gb.revision_no, 2);
  assert.equal(gb.total_minor, 23000);
  assert.equal(ok(await pay(visit.id, rev2)).paid, true);
});

test('reopen is refused after settlement until the payment is reversed; reversal then re-pay works', async () => {
  const { visit, guest } = await seat();
  await order(guest, [SOUP(2)], 30000);
  await serveAll(visit.id);
  await startBilling(visit.id);
  const rev = (await finalize(visit.id, 30000)).current_revision;
  const firstKey = key('pay');
  const paid = ok(await pay(visit.id, rev, { idempotency_key: firstKey }));
  const paymentId = paid.payments[0].id;

  const b = await bill(visit.id);
  expectError(await manager.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: b.visit_version, reason: 'Add a dessert' }), 409, 'already_settled');
  expectError(await cashier.post(`/api/staff/visits/${visit.id}/bill/finalize`, { bill_version: b.bill_version, expected_total_minor: 30000 }), 409, 'already_settled');
  assert.equal(visitRow(visit.id).status, 'billing');

  const reverse = (as: Client, body: Record<string, unknown>) => as.post(`/api/staff/payments/${paymentId}/reverse`, body);
  expectError(await reverse(cashier, { reason: 'Charged the wrong table', idempotency_key: key('rev') }), 403, 'forbidden');
  expectError(await reverse(manager, { idempotency_key: key('rev') }), 422, 'validation_failed');

  const revKey = key('rev');
  const reversed = ok(await reverse(manager, { reason: 'Charged the wrong table', idempotency_key: revKey }));
  assert.equal(reversed.paid, false);
  assert.equal(reversed.bill_status, 'finalized');
  assert.equal(reversed.current_revision.id, rev.id);
  assert.equal(reversed.current_revision.status, 'payable');
  const original = reversed.payments.find((p: { id: string }) => p.id === paymentId);
  assert.equal(original.status, 'reversed');
  const record = reversed.payments.find((p: { kind: string }) => p.kind === 'reversal');
  assert.equal(record.reverses_payment_id, paymentId);
  assert.equal(record.amount_minor, 30000);
  assert.equal(record.reason, 'Charged the wrong table');

  // Replays and a second device converge on the single reversal.
  ok(await reverse(manager, { reason: 'Charged the wrong table', idempotency_key: revKey }));
  ok(await reverse(owner, { reason: 'Charged the wrong table', idempotency_key: key('rev') }));
  assert.equal(count(`SELECT COUNT(*) AS n FROM payments WHERE visit_id = ? AND kind = 'reversal'`, [visit.id]), 1);
  const d = expectError(await checkout(visit.id), 409, 'unpaid_bill');
  assert.equal(d.remaining.amount_due_minor, 30000);

  // Re-pay the same revision; replaying the first (reversed) attempt creates nothing.
  const repaid = ok(await pay(visit.id, rev));
  assert.equal(repaid.paid, true);
  ok(await pay(visit.id, rev, { idempotency_key: firstKey }));
  assert.deepEqual(
    rows(`SELECT kind, status, COUNT(*) AS n FROM payments WHERE visit_id = ? GROUP BY kind, status ORDER BY kind, status`, [visit.id]),
    [{ kind: 'reversal', status: 'confirmed', n: 1 }, { kind: 'settlement', status: 'confirmed', n: 1 }, { kind: 'settlement', status: 'reversed', n: 1 }],
  );

  // Once the re-payment is reversed too, a manager may reopen, and the history stays.
  const second = repaid.payments.find((p: { kind: string; status: string }) => p.kind === 'settlement' && p.status === 'confirmed');
  ok(await manager.post(`/api/staff/payments/${second.id}/reverse`, { reason: 'Guest wants to add dessert first', idempotency_key: key('rev') }));
  const b2 = await bill(visit.id);
  const reopened = ok(await manager.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: b2.visit_version, reason: 'Add a dessert' }));
  assert.equal(reopened.visit_status, 'open');
  assert.deepEqual(reopened.revisions.map((r: any) => r.status), ['superseded']);
  assert.equal(reopened.payments.length, 4);

  await startBilling(visit.id);
  const rev2 = (await finalize(visit.id, 30000)).current_revision;
  assert.equal(rev2.revision_no, 2);
  ok(await pay(visit.id, rev2));
  assert.equal(ok(await checkout(visit.id)).table.state, 'available');

  const list = ok(await manager.get('/api/staff/payments'));
  const mine = list.exceptions.filter((e: { visit_id: string }) => e.visit_id === visit.id);
  assert.deepEqual(mine.map((e: { kind: string }) => e.kind).sort(), ['reversal', 'reversal']);
});

test('a refund recorded after checkout is kept as history and never reopens the visit or the table', async () => {
  const { table, visit, guest } = await seat();
  await order(guest, [SOUP()], 15000);
  await serveAll(visit.id);
  await startBilling(visit.id);
  const rev = (await finalize(visit.id, 15000)).current_revision;
  const paymentId = ok(await pay(visit.id, rev)).payments[0].id;
  ok(await checkout(visit.id));
  const kpiExceptions = async () => ok(await owner.get('/api/staff/stats/kpis')).payment_exceptions;
  const kpiRefunds = async (): Promise<{ count: number; value_minor: number }> => ok(await owner.get('/api/staff/stats/kpis')).refunds_after_checkout;
  const exceptionsBefore = await kpiExceptions();
  const refundsBefore = await kpiRefunds();
  assert.equal((await bill(visit.id, manager)).payment_state, 'paid');

  expectError(await cashier.post(`/api/staff/payments/${paymentId}/reverse`, { reason: 'Refunded at the door', idempotency_key: key('rev') }), 403, 'forbidden');
  const refunded = ok(await manager.post(`/api/staff/payments/${paymentId}/reverse`, { reason: 'Refunded at the door', idempotency_key: key('rev') }));
  const record = refunded.payments.find((p: { kind: string }) => p.kind === 'refund_record');
  assert.equal(record.reverses_payment_id, paymentId);
  assert.equal(record.amount_minor, 15000);
  assert.equal(refunded.payments.find((p: { id: string }) => p.id === paymentId).status, 'reversed');
  // A refund record cannot itself be reversed.
  expectError(await manager.post(`/api/staff/payments/${record.id}/reverse`, { reason: 'Undo', idempotency_key: key('rev') }), 409, 'invalid_transition');

  // The visit stays closed and the table free; nothing can be re-billed on the closed visit.
  assert.equal(visitRow(visit.id).status, 'closed');
  assert.equal((await tile(table.id)).state, 'available');
  expectError(await pay(visit.id, rev), 409, 'invalid_transition');
  expectError(await manager.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: visitRow(visit.id).version, reason: 'Re-bill' }), 409, 'invalid_transition');
  expectError(await manager.post(`/api/staff/visits/${visit.id}/adjustments`, { kind: 'comp', amount_minor: -100, reason: 'Late comp' }), 409, 'invalid_transition');
  assert.equal(auditCount(visit.id, 'payment.refund_record'), 1);

  const list = ok(await manager.get('/api/staff/payments'));
  assert.deepEqual(list.exceptions.filter((e: { visit_id: string }) => e.visit_id === visit.id).map((e: any) => [e.kind, e.amount_minor, e.reason]),
    [['refund_record', 15000, 'Refunded at the door']]);
  // D-S8-04: a refund after checkout is explained, not an unexplained payment exception. The KPI
  // reports it on its own line, and the payments list shows it once, as the refund record.
  assert.deepEqual(await kpiExceptions(), exceptionsBefore);
  assert.deepEqual(await kpiRefunds(), { count: refundsBefore.count + 1, value_minor: refundsBefore.value_minor + 15000 });
  // The settled revision stays as history, but the bill no longer reads paid: it was refunded.
  const closedBill = await bill(visit.id, manager);
  assert.equal(closedBill.bill_status, 'settled');
  assert.equal(closedBill.current_revision.status, 'settled');
  assert.equal(closedBill.paid, false);
  assert.equal(closedBill.payment_state, 'refunded');
  assert.equal(closedBill.refund.amount_minor, 15000);
  assert.equal(closedBill.refund.reason, 'Refunded at the door');
  assert.equal(closedBill.refund.by, 'Test manager');
});

test('adjustments are refused while a payable revision exists', async () => {
  const { visit, guest } = await seat();
  const placed = await order(guest, [SOUP(2)], 30000);
  await acceptAll(visit.id);

  const adjust = (as: Client, body: Record<string, unknown>) => as.post(`/api/staff/visits/${visit.id}/adjustments`, body);
  expectError(await adjust(floor, { kind: 'discount', amount_minor: -5000, reason: 'Birthday' }), 403, 'forbidden');
  expectError(await adjust(cashier, { kind: 'discount', amount_minor: -5000, reason: 'Birthday' }), 403, 'forbidden');
  const discounted = ok(await adjust(manager, { kind: 'discount', amount_minor: -5000, reason: 'Birthday' }));
  assert.equal(discounted.subtotal_minor, 30000);
  assert.equal(discounted.adjustments_minor, -5000);
  assert.equal(discounted.total_minor, 25000);
  expectError(await adjust(manager, { kind: 'comp', amount_minor: -30000, reason: 'Too much' }), 422, 'validation_failed');

  await startBilling(visit.id);
  const b = await bill(visit.id);
  const d = expectError(await cashier.post(`/api/staff/visits/${visit.id}/bill/finalize`, { bill_version: b.bill_version, expected_total_minor: 30000 }), 409, 'bill_changed');
  assert.equal(d.total_minor, 25000);
  const fin = await finalize(visit.id, 25000);
  assert.equal(fin.current_revision.adjustments_minor, -5000);
  assert.equal(fin.current_revision.adjustments.length, 1);

  expectError(await adjust(manager, { kind: 'discount', amount_minor: -1000, reason: 'Late discount' }), 409, 'bill_changed');
  assert.equal(count('SELECT COUNT(*) AS n FROM bill_adjustments WHERE visit_id = ?', [visit.id]), 1);
  assert.equal((await bill(visit.id)).total_minor, 25000);

  // Reopen, then the comp is accepted and the next revision carries both adjustments.
  ok(await manager.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: fin.visit_version, reason: 'Comp one soup' }));
  const comped = ok(await adjust(manager, { kind: 'comp', amount_minor: -2000, reason: 'Soup was cold', order_line_id: placed.lines[0].id }));
  assert.equal(comped.total_minor, 23000);
  await startBilling(visit.id);
  const fin2 = await finalize(visit.id, 23000);
  assert.equal(fin2.current_revision.adjustments.length, 2);
  ok(await pay(visit.id, fin2.current_revision));
  expectError(await adjust(manager, { kind: 'discount', amount_minor: -1000, reason: 'After payment' }), 409, 'already_settled');
  assert.equal(count('SELECT COUNT(*) AS n FROM bill_adjustments WHERE visit_id = ?', [visit.id]), 2);
});

test('configured charges are snapshotted at seating and the bill is exact to the satang', async () => {
  const before = await seat(); // seated while no charges are configured
  const charges = [
    { id: 'service', label_th: 'ค่าบริการ', label_en: 'Service charge', kind: 'percent', basis_points: 1000, inclusive: false, enabled: true, sort: 1 },
    { id: 'vat', label_th: 'รวมภาษีมูลค่าเพิ่ม', label_en: 'VAT included', kind: 'percent', basis_points: 700, inclusive: true, enabled: true, sort: 2 },
    { id: 'corkage', label_th: 'ค่าเปิดขวด', label_en: 'Corkage', kind: 'fixed', amount_minor: 5000, inclusive: false, enabled: true, sort: 3 },
    { id: 'old', label_th: 'เลิกใช้', label_en: 'Retired', kind: 'fixed', amount_minor: 99900, inclusive: false, enabled: false, sort: 4 },
  ];
  ok(await owner.patch('/api/staff/settings', { charges }));
  let party: Awaited<ReturnType<typeof seat>>;
  try {
    party = await seat(); // seated with the charges above
  } finally {
    ok(await owner.patch('/api/staff/settings', { charges: [] })); // later visits (and other tests) see none
  }
  const { visit, guest } = party;

  // 150 + (590 steak with salad as the included side: +30 upgrade) + 80 = 850 THB.
  await order(guest, [SOUP(), STEAK_SALAD, LATTE_HOT()], 85000);
  await acceptAll(visit.id);
  ok(await manager.post(`/api/staff/visits/${visit.id}/adjustments`, { kind: 'discount', amount_minor: -1234, reason: 'Loyalty discount' }));

  // Base 837.66: service 10% = 83.766 -> 83.77 (half-up); VAT 7% included = 54.80 (shown, not added);
  // corkage 50.00; the disabled rule is not snapshotted. Total 837.66 + 83.77 + 50.00 = 971.43.
  const expectCharges = (list: any[]) => assert.deepEqual(
    list.map((c) => [c.id, c.inclusive, c.amount_minor]),
    [['service', false, 8377], ['vat', true, 5480], ['corkage', false, 5000]],
  );
  const b = await bill(visit.id);
  assert.equal(b.subtotal_minor, 85000);
  assert.equal(b.adjustments_minor, -1234);
  expectCharges(b.charges);
  assert.equal(b.total_minor, 97143);
  const gb = ok(await guest.get('/api/guest/bill'));
  expectCharges(gb.charges);
  assert.equal(gb.total_minor, 97143);

  await startBilling(visit.id);
  const fin = await finalize(visit.id, 97143);
  expectCharges(fin.current_revision.charges);
  assert.equal(fin.current_revision.subtotal_minor, 85000);
  expectError(await pay(visit.id, { id: fin.current_revision.id, total_minor: 97142 }), 409, 'amount_mismatch');
  const paid = ok(await pay(visit.id, fin.current_revision, { tendered_minor: 100000 }));
  assert.equal(paid.payments[0].change_minor, 2857);
  // Settings changed after seating never reprice this bill.
  assert.equal((await bill(visit.id)).total_minor, 97143);

  // The party seated before the change pays no charges at all.
  await order(before.guest, [SOUP()], 15000);
  await acceptAll(before.visit.id);
  const plain = await bill(before.visit.id);
  assert.deepEqual(plain.charges, []);
  assert.equal(plain.total_minor, 15000);
});

// ------------------------------------------------------------------ table grid (brief 43)
test('Available, Dining and Checking out counts reconcile with the tiles across two staff clients', async () => {
  const floor2 = await srv.staff('floor'); // a second floor tablet
  const tally = (tiles: Array<{ state: string }>) => {
    const c: Record<string, number> = { available: 0, dining: 0, checking_out: 0, disabled: 0 };
    for (const t of tiles) c[t.state] += 1;
    return c;
  };
  async function snapshot() {
    const [a, b, oa, ob] = await Promise.all([
      floor.get('/api/staff/tables'), cashier.get('/api/staff/tables'), floor2.get('/api/staff/overview'), cashier.get('/api/staff/overview'),
    ]);
    const ta = ok(a);
    const tb = ok(b);
    for (const grid of [ta, tb]) assert.deepEqual(grid.counts, tally(grid.tables));
    assert.deepEqual(ta.counts, tb.counts);
    assert.deepEqual(
      ta.tables.map((t: any) => [t.id, t.state]),
      tb.tables.map((t: any) => [t.id, t.state]),
    );
    assert.deepEqual(ok(oa).counts, ta.counts);
    assert.deepEqual(ok(ob).counts, ta.counts);
    return { counts: ta.counts as Record<string, number>, state: new Map<string, string>(ta.tables.map((t: any) => [t.id, t.state])) };
  }

  const dining = await seat();
  const checking = await seat();
  await startBilling(checking.visit.id);
  const off = await newTable();
  const offTile = await tile(off.id);
  ok(await manager.patch(`/api/staff/tables/${off.id}`, { enabled: false, version: offTile.version }));
  const free = await newTable();

  const s0 = await snapshot();
  assert.equal(s0.state.get(dining.table.id), 'dining');
  assert.equal(s0.state.get(checking.table.id), 'checking_out');
  assert.equal(s0.state.get(off.id), 'disabled');
  assert.equal(s0.state.get(free.id), 'available');
  for (const s of ['available', 'dining', 'checking_out', 'disabled']) assert.ok(s0.counts[s] >= 1, `no ${s} table`);

  // Seat a party from the second tablet: the first tablet sees one fewer Available, one more Dining.
  const seated = ok(await floor2.post(`/api/staff/tables/${free.id}/visits`, { covers: 4, idempotency_key: key('open') }), 201);
  const s1 = await snapshot();
  assert.equal(s1.state.get(free.id), 'dining');
  assert.equal(s1.counts.available, s0.counts.available - 1);
  assert.equal(s1.counts.dining, s0.counts.dining + 1);

  // Cashier starts checkout on one and completes an empty visit on another.
  await startBilling(seated.id);
  ok(await checkout(dining.visit.id));
  const s2 = await snapshot();
  assert.equal(s2.state.get(free.id), 'checking_out');
  assert.equal(s2.state.get(dining.table.id), 'available');
  assert.equal(s2.counts.dining, s1.counts.dining - 2);
  assert.equal(s2.counts.checking_out, s1.counts.checking_out + 1);
  assert.equal(s2.counts.available, s1.counts.available + 1);
  assert.equal(s2.counts.disabled, s1.counts.disabled);
});
