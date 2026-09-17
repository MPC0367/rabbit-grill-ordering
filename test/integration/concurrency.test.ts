// Races between devices (brief 30, 31 scenarios 9-11, 36, 43, 44F).
//
// Each race fires real HTTP requests from separate clients with Promise.all
// and a small, rotating stagger so different iterations interleave
// differently. Whatever order the server sees, the end state must be one of
// the documented consistent outcomes; the assertions accept exactly those.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, key, startServer, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

let srv: TestServer;
let owner: Client;
let manager: Client;
let cashier: Client;
let cashier2: Client;
let floor: Client;
let floor2: Client;
let kitchen: Client;
let kitchen2: Client;

before(async () => {
  // TRUST_PROXY_HOPS=1: every simulated phone joins from its own address (the join
  // limit is 10 a minute per address and these races seat many parties).
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  [owner, manager, cashier, cashier2, floor, floor2, kitchen, kitchen2] = await Promise.all(
    (['owner', 'manager', 'cashier', 'cashier', 'floor', 'floor', 'kitchen', 'kitchen'] as const).map((r) => srv.staff(r)),
  );
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
type Line = Record<string, unknown>;
const SOUP = (quantity = 1): Line => ({ item_id: T.items.soup, quantity, modifiers: [] }); // 150 THB
const LATTE_HOT = (quantity = 1): Line => ({ item_id: T.items.coffee, variant_id: T.variants.hot, quantity, modifiers: [] }); // 80 THB
const CHARGEABLE = `('accepted','preparing','almost_done','ready','served')`;

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
function rows<R = any>(query: string, params: unknown[] = []): R[] {
  return srv.sql(query, params).map((r) => ({ ...r })) as R[];
}
const count = (query: string, params: unknown[] = []): number => Number(rows<{ n: number }>(query, params)[0].n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Fire the calls together; call j starts after delays[j] ms (0-2), so interleavings vary per iteration. */
function race(calls: Array<() => Promise<HttpResult>>, iteration: number): Promise<HttpResult[]> {
  return Promise.all(calls.map((call, j) => sleep((iteration + j) % 3).then(call)));
}

let ipSeq = 0;
async function join(token: string, pin: string | null): Promise<Client> {
  const c = srv.client();
  ipSeq++;
  const r = await c.request('POST', '/api/public/qr/join', { token, ...(pin ? { pin } : {}) }, {
    'X-Forwarded-For': `10.30.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`,
  });
  assert.ok(r.status === 201 || r.status === 200, `join: ${show(r)}`);
  return c;
}

let tableSeq = 0;
async function newTable(): Promise<{ id: string; token: string }> {
  tableSeq++;
  const t = ok(await manager.post('/api/staff/tables', { label: `C${String(tableSeq).padStart(3, '0')}`, zone: 'Race tests' }), 201);
  const [row] = rows<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [t.id]);
  return { id: t.id, token: row.token };
}

async function seat() {
  const table = await newTable();
  const visit = ok(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
  const guest = await join(table.token, visit.join_pin);
  return { table, visit, guest };
}

function submit(guest: Client, k: string, lines: Line[], subtotal: number) {
  return guest.post('/api/guest/orders', { idempotency_key: k, lines, expected_subtotal_minor: subtotal });
}
async function order(guest: Client, lines: Line[], subtotal: number): Promise<any> {
  return ok(await submit(guest, key('att'), lines, subtotal), 201).order;
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

async function bill(visitId: string): Promise<any> {
  return ok(await cashier.get(`/api/staff/visits/${visitId}/bill`));
}
async function startBilling(visitId: string): Promise<any> {
  const b = await bill(visitId);
  return ok(await floor.post(`/api/staff/visits/${visitId}/billing/start`, { version: b.visit_version }));
}
function finalizeCall(visitId: string, billVersion: number, expected: number, as: Client = cashier) {
  return as.post(`/api/staff/visits/${visitId}/bill/finalize`, { bill_version: billVersion, expected_total_minor: expected });
}
async function finalize(visitId: string, expected: number): Promise<any> {
  const b = await bill(visitId);
  const fin = ok(await finalizeCall(visitId, b.bill_version, expected));
  assert.equal(fin.current_revision.total_minor, expected);
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
/** A seated party whose food is served and whose bill is finalized (not paid). */
async function readyToPay(lines: Line[], total: number) {
  const s = await seat();
  await order(s.guest, lines, total);
  await serveAll(s.visit.id);
  await startBilling(s.visit.id);
  const fin = await finalize(s.visit.id, total);
  return { ...s, revision: fin.current_revision };
}
const visitStatus = (id: string): string => rows<{ status: string }>('SELECT status FROM visits WHERE id = ?', [id])[0].status;
const auditCount = (visitId: string, action: string) =>
  count('SELECT COUNT(*) AS n FROM audit_events WHERE visit_id = ? AND action = ?', [visitId, action]);
const chargeableIds = (visitId: string): string[] =>
  rows<{ id: string }>(`SELECT id FROM order_lines WHERE visit_id = ? AND status IN ${CHARGEABLE} ORDER BY id`, [visitId]).map((r) => r.id);
const revisionLineIds = (rev: { lines: Array<{ line_id: string }> }) => rev.lines.map((l) => l.line_id).sort();

// ------------------------------------------------------------------ scenario 9: bill vs new orders
test('Start checkout racing guest submissions always leaves a consistent bill (repeated)', async (t) => {
  const outcomes = { created: 0, refused: 0 };
  for (let i = 0; i < 12; i++) {
    const { table, visit, guest } = await seat();
    const guest2 = await join(table.token, visit.join_pin);
    await order(guest, [SOUP()], 15000);
    await acceptAll(visit.id);
    const visitVersion = (await bill(visit.id)).visit_version;

    const attempts = [
      { client: guest, key: key('race'), lines: [LATTE_HOT()], subtotal: 8000 },
      { client: guest2, key: key('race'), lines: [SOUP(2)], subtotal: 30000 },
    ];
    const [ra, rb, rs] = await race([
      () => submit(attempts[0].client, attempts[0].key, attempts[0].lines, attempts[0].subtotal),
      () => submit(attempts[1].client, attempts[1].key, attempts[1].lines, attempts[1].subtotal),
      () => floor.post(`/api/staff/visits/${visit.id}/billing/start`, { version: visitVersion }),
    ], i);
    // Guest rounds never touch the visit version, so Start checkout always goes through.
    assert.equal(ok(rs).visit_status, 'billing');

    let expected = 15000;
    const created: string[] = [];
    for (const [a, r] of [[attempts[0], ra], [attempts[1], rb]] as const) {
      const stored = () => count('SELECT COUNT(*) AS n FROM orders WHERE visit_id = ? AND idempotency_key = ?', [visit.id, a.key]);
      if (r.status === 201) {
        outcomes.created++;
        assert.equal(stored(), 1);
        expected += a.subtotal;
        created.push(...r.body.order.lines.map((l: { id: string }) => l.id));
        // A retry of a committed round replays it even though checkout has started.
        const replay = ok(await submit(a.client, a.key, a.lines, a.subtotal));
        assert.equal(replay.replayed, true);
        assert.equal(replay.order.id, r.body.order.id);
      } else {
        outcomes.refused++;
        expectError(r, 409, 'visit_billing');
        assert.equal(stored(), 0);
        assert.deepEqual(ok(await a.client.get(`/api/guest/orders/attempts/${a.key}`)), { status: 'not_found' });
        expectError(await submit(a.client, a.key, a.lines, a.subtotal), 409, 'visit_billing');
        assert.equal(stored(), 0);
      }
    }

    // Unaccepted rounds are pending (never in the amount due) and block finalize.
    let b = await bill(visit.id);
    assert.deepEqual(b.pending_lines.map((l: { line_id: string }) => l.line_id).sort(), [...created].sort());
    assert.equal(b.total_minor, 15000);
    if (created.length > 0) {
      const d = expectError(await finalizeCall(visit.id, b.bill_version, b.total_minor), 409, 'unresolved_orders');
      assert.equal(d.lines.length, created.length);
      assert.equal(count('SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ?', [visit.id]), 0);
      await acceptAll(visit.id);
    }
    const fin = await finalize(visit.id, expected);
    const rev = fin.current_revision;
    assert.deepEqual(revisionLineIds(rev), chargeableIds(visit.id));

    // Nothing can be added to the frozen bill by any route.
    const linesBefore = count('SELECT COUNT(*) AS n FROM order_lines WHERE visit_id = ?', [visit.id]);
    expectError(await submit(guest, key('late'), [SOUP()], 15000), 409, 'visit_billing');
    expectError(await floor.post('/api/staff/orders/assist', { visit_id: visit.id, idempotency_key: key('late'), lines: [SOUP()], expected_subtotal_minor: 15000 }), 409, 'visit_billing');
    expectError(await manager.post('/api/staff/orders/recover', {
      visit_id: visit.id, manual_reference: key('paper'), original_time: new Date().toISOString(), lines: [SOUP()], already: 'none', reason: 'Tablet was offline',
    }), 409, 'visit_billing');
    expectError(await guest2.post('/api/guest/portions', { item_id: T.items.rib, idempotency_key: key('late') }), 409, 'visit_billing');
    assert.equal(count('SELECT COUNT(*) AS n FROM order_lines WHERE visit_id = ?', [visit.id]), linesBefore);
    b = await bill(visit.id);
    assert.equal(b.revision_stale, false);
    assert.deepEqual(revisionLineIds(b.current_revision), revisionLineIds(rev));
    assert.equal(b.total_minor, expected);

    await serveAll(visit.id);
    ok(await pay(visit.id, rev));
    ok(await checkout(visit.id));
  }
  t.diagnostic(`guest rounds created before billing: ${outcomes.created}, refused by billing: ${outcomes.refused}`);
  assert.equal(outcomes.created + outcomes.refused, 24);
});

test('reopen racing finalize and a new order never puts the new order on a finalized revision', async (t) => {
  const seen = { ordered: 0, finalized: 0 };
  for (let i = 0; i < 9; i++) {
    const { visit, guest } = await seat();
    await order(guest, [SOUP()], 15000);
    await acceptAll(visit.id);
    await startBilling(visit.id);
    await finalize(visit.id, 15000);
    const b = await bill(visit.id);

    const k = key('race');
    const [rr, rs, rf] = await race([
      () => manager.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: b.visit_version, reason: 'Guests want a drink' }),
      () => submit(guest, k, [LATTE_HOT()], 8000),
      () => finalizeCall(visit.id, b.bill_version, 15000, cashier2),
    ], i);
    // Finalizing never changes the visit version, so the manager's reopen always lands.
    ok(rr);
    if (rs.status === 201) seen.ordered++;
    else expectError(rs, 409, 'visit_billing');
    if (rf.status === 200) seen.finalized++;
    else expectError(rf, 409, 'invalid_transition'); // the table was already ordering again

    // End state: ordering, no payable revision, every revision superseded, and the new
    // round (if any) is on none of them.
    assert.equal(visitStatus(visit.id), 'open');
    const now = await bill(visit.id);
    assert.equal(now.bill_status, 'open');
    assert.equal(now.current_revision, null);
    assert.equal(now.revisions.length, rf.status === 200 ? 2 : 1);
    assert.ok(now.revisions.every((r: { status: string }) => r.status === 'superseded'));
    if (rs.status === 201) {
      const newLine = rs.body.order.lines[0].id;
      assert.ok(now.revisions.every((r: { lines: Array<{ line_id: string }> }) => !r.lines.some((l) => l.line_id === newLine)));
      assert.deepEqual(now.pending_lines.map((l: { line_id: string }) => l.line_id), [newLine]);
    }

    // The next revision picks the round up.
    await serveAll(visit.id);
    await startBilling(visit.id);
    const total = 15000 + (rs.status === 201 ? 8000 : 0);
    const fin = await finalize(visit.id, total);
    assert.deepEqual(revisionLineIds(fin.current_revision), chargeableIds(visit.id));
    assert.equal(count(`SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ? AND status = 'payable'`, [visit.id]), 1);
    ok(await pay(visit.id, fin.current_revision));
    ok(await checkout(visit.id));
  }
  t.diagnostic(`rounds accepted after reopen: ${seen.ordered}/9, refinalized before reopen: ${seen.finalized}/9`);
});

test('two cashiers finalizing the same bill create one revision; finalize racing a cancellation stays consistent', async (t) => {
  const seen = { finalizeFirst: 0, cancelFirst: 0 };
  for (let i = 0; i < 6; i++) {
    const { visit, guest } = await seat();
    const placed = await order(guest, [SOUP(2), LATTE_HOT()], 38000);
    await acceptAll(visit.id);
    await startBilling(visit.id);
    const b = await bill(visit.id);

    const [f1, f2] = await race([
      () => finalizeCall(visit.id, b.bill_version, 38000, cashier),
      () => finalizeCall(visit.id, b.bill_version, 38000, cashier2),
    ], i);
    const wins = [f1, f2].filter((r) => r.status === 200);
    assert.equal(wins.length, 1, `${show(f1)} / ${show(f2)}`);
    expectError([f1, f2].find((r) => r.status !== 200)!, 409, 'stale_version');
    assert.equal(count('SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ?', [visit.id]), 1);
    assert.equal(auditCount(visit.id, 'bill.finalize'), 1);

    // Reopen, then race a fresh finalize against cancelling the drink.
    const now = await bill(visit.id);
    const reopened = ok(await manager.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: now.visit_version, reason: 'Check the drink' }));
    await startBilling(visit.id);
    const b2 = await bill(visit.id);
    assert.equal(reopened.bill_status, 'open');
    const latte = placed.lines.find((l: { item_id: string }) => l.item_id === T.items.coffee);
    const latteVersion = rows<{ version: number }>('SELECT version FROM order_lines WHERE id = ?', [latte.id])[0].version;
    const [rf, rc] = await race([
      () => finalizeCall(visit.id, b2.bill_version, 38000),
      () => floor.post('/api/staff/orders/transition', { lines: [{ id: latte.id, version: latteVersion }], to: 'cancelled', reason: 'Guest changed their mind' }),
    ], i);
    const latteStatus = rows<{ status: string }>('SELECT status FROM order_lines WHERE id = ?', [latte.id])[0].status;
    if (rf.status === 200) {
      seen.finalizeFirst++;
      expectError(rc, 409, 'bill_changed'); // "Reopen the bill first"
      assert.equal(latteStatus, 'accepted');
      assert.equal(rf.body.current_revision.total_minor, 38000);
    } else {
      seen.cancelFirst++;
      ok(rc);
      const d = expectError(rf, 409, 'bill_changed');
      assert.equal(d.total_minor, 30000);
      assert.equal(latteStatus, 'cancelled');
      assert.equal(count(`SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ? AND status = 'payable'`, [visit.id]), 0);
    }
    const after = await bill(visit.id);
    assert.equal(after.revision_stale, false);
    assert.equal(after.running_total_minor, rf.status === 200 ? 38000 : 30000);
  }
  t.diagnostic(`finalize first: ${seen.finalizeFirst}, cancel first: ${seen.cancelFirst}`);
});

test('duplicate staff actions on one bill apply once: start checkout, adjustment vs finalize, reopen, reversal', async (t) => {
  const seen = { finalizeFirst: 0, adjustFirst: 0 };
  for (let i = 0; i < 6; i++) {
    const { visit, guest } = await seat();
    await order(guest, [SOUP(2)], 30000);
    await acceptAll(visit.id);
    const adjustments = () => count('SELECT COUNT(*) AS n FROM bill_adjustments WHERE visit_id = ?', [visit.id]);

    // Two tablets press Start checkout: both see Checking out, it happens once.
    const b0 = await bill(visit.id);
    const starts = await race([floor, floor2].map((c) => () => c.post(`/api/staff/visits/${visit.id}/billing/start`, { version: b0.visit_version })), i);
    for (const r of starts) assert.equal(ok(r).visit_status, 'billing');
    assert.equal(auditCount(visit.id, 'visit.billing_start'), 1);

    // A discount racing finalize: either it is on the revision or it was refused.
    const b1 = await bill(visit.id);
    const [ra, rf] = await race([
      () => manager.post(`/api/staff/visits/${visit.id}/adjustments`, { kind: 'discount', amount_minor: -3000, reason: 'Regular guest' }),
      () => finalizeCall(visit.id, b1.bill_version, 30000),
    ], i);
    let total: number;
    if (rf.status === 200) {
      seen.finalizeFirst++;
      expectError(ra, 409, 'bill_changed');
      assert.equal(adjustments(), 0);
      total = 30000;
    } else {
      seen.adjustFirst++;
      ok(ra);
      expectError(rf, 409, 'stale_version'); // the discount changed the bill under the cashier
      assert.equal(count('SELECT COUNT(*) AS n FROM bill_revisions WHERE visit_id = ?', [visit.id]), 0);
      total = 27000;
      await finalize(visit.id, total);
    }
    const rev1 = (await bill(visit.id)).current_revision;
    assert.equal(rev1.total_minor, total);
    assert.equal(rev1.adjustments.length, adjustments());

    // Two managers reopen from the same version: one reopen, one stale refusal.
    const b2 = await bill(visit.id);
    const reopens = await race([manager, owner].map((c) => () => c.post(`/api/staff/visits/${visit.id}/billing/reopen`, { version: b2.visit_version, reason: 'Dessert order' })), i);
    assert.equal(reopens.filter((r) => r.status === 200).length, 1, reopens.map(show).join('\n'));
    expectError(reopens.find((r) => r.status !== 200)!, 409, 'stale_version');
    assert.equal(auditCount(visit.id, 'bill.reopen'), 1);
    assert.deepEqual(rows('SELECT status FROM bill_revisions WHERE visit_id = ?', [visit.id]), [{ status: 'superseded' }]);

    // Settle again, then two managers reverse the payment with their own keys: one reversal.
    await startBilling(visit.id);
    const rev2 = (await finalize(visit.id, total)).current_revision;
    const paymentId = ok(await pay(visit.id, rev2)).payments[0].id;
    const reversals = await race([manager, owner].map((c) => () => c.post(`/api/staff/payments/${paymentId}/reverse`, { reason: 'Card charged twice', idempotency_key: key('rev') })), i);
    for (const r of reversals) assert.equal(ok(r).paid, false);
    assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE reverses_payment_id = ?', [paymentId]), 1);
    assert.equal(auditCount(visit.id, 'payment.reverse'), 1);
    const after = await bill(visit.id);
    assert.equal(after.current_revision.id, rev2.id);
    assert.equal(after.current_revision.status, 'payable');
  }
  t.diagnostic(`finalize first: ${seen.finalizeFirst}, discount first: ${seen.adjustFirst}`);
});

// ------------------------------------------------------------------ scenario 10: payments
test('cashiers confirming the same revision at once record exactly one settlement', async () => {
  for (let i = 0; i < 6; i++) {
    const { visit, revision } = await readyToPay([SOUP(), LATTE_HOT()], 23000);
    const keys = [key('pay'), key('pay'), key('pay')];
    const devices = [cashier, cashier2, owner];
    const results = await race(devices.map((c, j) => () => pay(visit.id, revision, { idempotency_key: keys[j], tendered_minor: 50000 }, c)), i);

    const winners = results.map((r, j) => ({ r, j })).filter(({ r }) => r.status === 200);
    assert.equal(winners.length, 1, results.map(show).join('\n'));
    const winner = winners[0].j;
    for (const [j, r] of results.entries()) {
      if (j === winner) continue;
      const d = expectError(r, 409, 'already_settled');
      assert.equal(d.bill.paid, true);
    }
    const pays = rows('SELECT kind, status, amount_minor, change_minor, idempotency_key FROM payments WHERE visit_id = ?', [visit.id]);
    assert.deepEqual(pays, [{ kind: 'settlement', status: 'confirmed', amount_minor: 23000, change_minor: 27000, idempotency_key: keys[winner] }]);
    assert.equal(auditCount(visit.id, 'payment.confirm'), 1);
    assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE visit_id = ? AND topic = 'payment.recorded'`, [visit.id]), 1);

    // Response lost: the winner's retry replays; a loser's retry is still refused.
    const replay = ok(await pay(visit.id, revision, { idempotency_key: keys[winner], tendered_minor: 50000 }, devices[winner]));
    assert.equal(replay.payments.length, 1);
    const loser = (winner + 1) % 3;
    expectError(await pay(visit.id, revision, { idempotency_key: keys[loser], tendered_minor: 50000 }, devices[loser]), 409, 'already_settled');
    assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [visit.id]), 1);
    assert.equal(ok(await checkout(visit.id)).table.state, 'available');
  }

  // The same attempt sent from two tabs at once is one payment.
  const { visit, revision } = await readyToPay([SOUP()], 15000);
  const k = key('pay');
  const both = await Promise.all([pay(visit.id, revision, { idempotency_key: k }), pay(visit.id, revision, { idempotency_key: k }, cashier.clone())]);
  for (const r of both) assert.equal(ok(r).paid, true);
  assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [visit.id]), 1);
  // The same key with another amount is a different attempt, not a replay.
  expectError(await pay(visit.id, { id: revision.id, total_minor: 14000 }, { idempotency_key: k }), 409, 'idempotency_mismatch');
});

test('a payment must match the payable revision exactly and use an enabled method', async () => {
  const { visit, revision } = await readyToPay([SOUP(2)], 30000);
  const other = await readyToPay([SOUP()], 15000);
  const noPayment = () => assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [visit.id]), 0);

  let d = expectError(await pay(visit.id, { id: revision.id, total_minor: 29999 }), 409, 'amount_mismatch');
  assert.equal(d.expected_minor, 30000);
  assert.equal(d.received_minor, 29999);
  expectError(await pay(visit.id, { id: revision.id, total_minor: 30001 }), 409, 'amount_mismatch');
  d = expectError(await pay(visit.id, revision, { tendered_minor: 20000 }), 409, 'amount_mismatch');
  assert.equal(d.tendered_minor, 20000);
  expectError(await pay(visit.id, revision, { method: 'transfer' }), 422, 'validation_failed'); // configured but disabled
  expectError(await pay(visit.id, revision, { method: 'crypto' }), 422, 'validation_failed');
  expectError(await pay(visit.id, other.revision), 404, 'not_found'); // another table's bill
  expectError(await pay(visit.id, revision, {}, floor), 403, 'forbidden');
  expectError(await pay(visit.id, revision, {}, kitchen), 403, 'forbidden');
  noPayment();
  assert.equal((await bill(visit.id)).bill_status, 'finalized');

  const reference = 'slip-REF-7731';
  const paid = ok(await pay(visit.id, revision, { method: 'cash', tendered_minor: 30000, reference }));
  assert.equal(paid.payments[0].change_minor, 0);
  assert.equal(paid.payments[0].reference, reference);
  // The reference is for payments.view only: never on floor screens, the guest bill, the audit log or the event stream.
  const floorBill = ok(await floor.get(`/api/staff/visits/${visit.id}/bill`));
  assert.equal(floorBill.payments[0].reference, null);
  assert.equal(floorBill.paid, true);
  expectError(await kitchen.get(`/api/staff/visits/${visit.id}/bill`), 403, 'forbidden');
  assert.ok(!JSON.stringify(ok(await other.guest.get('/api/guest/bill'))).includes(reference));
  assert.equal(count('SELECT COUNT(*) AS n FROM audit_events WHERE visit_id = ? AND (after_json LIKE ? OR before_json LIKE ?)', [visit.id, `%${reference}%`, `%${reference}%`]), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE payload LIKE ?', [`%${reference}%`]), 0);
  assert.equal(ok(await floor.get(`/api/staff/visits/${visit.id}`)).bill.payments[0].reference, null);
});

test('a guest has no way to mark the bill paid', async () => {
  const { visit, guest, revision } = await readyToPay([SOUP()], 15000);
  const attempt = { revision_id: revision.id, method: 'cash', amount_minor: 15000, idempotency_key: key('gpay') };

  for (const path of ['/api/guest/payments', '/api/guest/bill/pay', '/api/guest/bill/paid', '/api/guest/bill/confirm',
    `/api/guest/visits/${visit.id}/payments`, `/api/guest/bill/${revision.id}/pay`, '/api/guest/checkout']) {
    expectError(await guest.post(path, attempt), 404, 'not_found');
  }
  expectError(await guest.patch('/api/guest/bill', { paid: true, bill_status: 'settled' }), 404, 'not_found');
  // Staff routes do not accept a guest cookie, even replayed as the staff cookie.
  expectError(await guest.post(`/api/staff/visits/${visit.id}/payments`, attempt), 401, 'auth_required');
  expectError(await guest.post(`/api/staff/visits/${visit.id}/checkout`, { idempotency_key: key('co') }), 401, 'auth_required');
  const forged = srv.client();
  forged.cookies.set('rg_staff', guest.cookies.get('rg_guest')!);
  expectError(await forged.post(`/api/staff/visits/${visit.id}/payments`, attempt), 401, 'auth_required');
  expectError(await srv.client().post(`/api/staff/visits/${visit.id}/payments`, attempt), 401, 'auth_required');
  // "I have paid" style extras on the bill request are ignored.
  const asked = ok(await guest.post('/api/guest/bill/request', { idempotency_key: key('bill'), paid: true, status: 'settled' }));
  assert.equal(asked.paid, false);

  assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [visit.id]), 0);
  const gb = ok(await guest.get('/api/guest/bill'));
  assert.equal(gb.paid, false);
  assert.equal(gb.bill_status, 'finalized');
  assert.equal((await bill(visit.id)).current_revision.status, 'payable');
  expectError(await checkout(visit.id), 409, 'unpaid_bill');
});

// ------------------------------------------------------------------ scenario 11: two staff, one line
test('two staff moving the same line from the same version: one wins, the other gets stale_version with the current line', async (t) => {
  const { visit, guest } = await seat();
  const wins: Record<string, number> = { preparing: 0, cancelled: 0 };
  for (let i = 0; i < 8; i++) {
    const placed = await order(guest, [SOUP()], 15000);
    const lineId: string = placed.lines[0].id;
    const events = (to: string) => count('SELECT COUNT(*) AS n FROM line_events WHERE line_id = ? AND to_status = ?', [lineId, to]);
    const version = () => rows<{ version: number; status: string }>('SELECT version, status FROM order_lines WHERE id = ?', [lineId])[0];

    // Same target from two kitchen tablets.
    const v0 = version().version;
    const accepts = await race([kitchen, kitchen2].map((c) => () => c.post('/api/staff/orders/transition', { lines: [{ id: lineId, version: v0 }], to: 'accepted' })), i);
    assert.equal(accepts.filter((r) => r.status === 200).length, 1, accepts.map(show).join('\n'));
    const staleAccept = expectError(accepts.find((r) => r.status !== 200)!, 409, 'stale_version');
    const seenLine = staleAccept.current.flatMap((o: any) => o.lines).find((l: { id: string }) => l.id === lineId);
    assert.equal(seenLine.status, 'accepted');
    assert.equal(seenLine.version, v0 + 1);
    assert.deepEqual(version(), { version: v0 + 1, status: 'accepted' });
    assert.equal(events('accepted'), 1);

    // Different targets from the same version: cooking starts while a manager cancels.
    const [rp, rc] = await race([
      () => kitchen.post('/api/staff/orders/transition', { lines: [{ id: lineId, version: v0 + 1 }], to: 'preparing' }),
      () => manager.post('/api/staff/orders/transition', { lines: [{ id: lineId, version: v0 + 1 }], to: 'cancelled', reason: 'Guest changed their mind' }),
    ], i + 1);
    const winnerTo = rp.status === 200 ? 'preparing' : 'cancelled';
    const loser = rp.status === 200 ? rc : rp;
    assert.equal([rp, rc].filter((r) => r.status === 200).length, 1, `${show(rp)} / ${show(rc)}`);
    wins[winnerTo]++;
    const d = expectError(loser, 409, 'stale_version');
    const current = d.current.flatMap((o: any) => o.lines).find((l: { id: string }) => l.id === lineId);
    assert.equal(current.status, winnerTo);
    assert.equal(current.version, v0 + 2);
    // No lost update: one change applied, recorded once, and the row agrees with its history.
    assert.deepEqual(version(), { version: v0 + 2, status: winnerTo });
    assert.equal(events('preparing') + events('cancelled'), 1);
    const [last] = rows<{ to_status: string }>('SELECT to_status FROM line_events WHERE line_id = ? ORDER BY id DESC LIMIT 1', [lineId]);
    assert.equal(last.to_status, winnerTo);
  }
  t.diagnostic(`second race winners: ${JSON.stringify(wins)}`);
});

test('a bulk transition is all-or-nothing when another tablet moved one of its lines first', async () => {
  const { visit, guest } = await seat();
  for (let i = 0; i < 6; i++) {
    const placed = await order(guest, [SOUP(), LATTE_HOT()], 23000);
    const [a, b] = placed.lines.map((l: { id: string }) => l.id);
    await acceptAll(visit.id);
    const v = (id: string) => rows<{ version: number; status: string }>('SELECT version, status FROM order_lines WHERE id = ?', [id])[0];
    const va = v(a).version;
    const vb = v(b).version;
    const [bulk, single] = await race([
      () => kitchen.post('/api/staff/orders/transition', { lines: [{ id: a, version: va }, { id: b, version: vb }], to: 'preparing' }),
      () => kitchen2.post('/api/staff/orders/transition', { lines: [{ id: b, version: vb }], to: 'preparing' }),
    ], i);
    if (bulk.status === 200) {
      expectError(single, 409, 'stale_version');
      assert.deepEqual([v(a), v(b)], [{ version: va + 1, status: 'preparing' }, { version: vb + 1, status: 'preparing' }]);
    } else {
      ok(single);
      expectError(bulk, 409, 'stale_version');
      // The bulk request applied nothing, not even the line nobody else touched.
      assert.deepEqual([v(a), v(b)], [{ version: va, status: 'accepted' }, { version: vb + 1, status: 'preparing' }]);
    }
    const prepEvents = count(`SELECT COUNT(*) AS n FROM line_events WHERE line_id IN (?, ?) AND to_status = 'preparing'`, [a, b]);
    const preparing = count(`SELECT COUNT(*) AS n FROM order_lines WHERE id IN (?, ?) AND status = 'preparing'`, [a, b]);
    assert.equal(prepEvents, preparing);
  }
});

test('two floor tablets finishing the same order finish it once', async () => {
  const { visit, guest } = await seat();
  for (let i = 0; i < 4; i++) {
    const placed = await order(guest, [SOUP()], 15000);
    await acceptAll(visit.id);
    await move(kitchen, visit.id, 'accepted', 'preparing');
    await move(kitchen, visit.id, 'preparing', 'ready');
    const o = ok(await floor.get(`/api/staff/orders/${placed.id}`));
    const line = o.lines[0];
    const body = { version: o.version, resolutions: [{ line_id: line.id, version: line.version, action: 'served' }] };
    const results = await race([floor, floor2].map((c) => () => c.post(`/api/staff/orders/${placed.id}/finish`, body)), i);
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map(show).join('\n'));
    const d = expectError(results.find((r) => r.status !== 200)!, 409, 'stale_version');
    assert.ok(d.current.finished_at, 'the stale reply carries the finished order');
    assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND action = 'order.finished'`, [placed.id]), 1);
    assert.equal(count(`SELECT COUNT(*) AS n FROM line_events WHERE line_id = ? AND to_status = 'served'`, [line.id]), 1);
  }
});

// ------------------------------------------------------------------ checkout races (brief 36, 43)
test('several devices completing checkout together close the visit once', async () => {
  for (let i = 0; i < 5; i++) {
    const { table, visit, revision } = await readyToPay([SOUP()], 15000);
    ok(await pay(visit.id, revision));
    const keys = [key('co'), key('co'), key('co')];
    const results = await race([cashier, cashier2, manager].map((c, j) => () => checkout(visit.id, { idempotency_key: keys[j] }, c)), i);
    const bodies = results.map((r) => ok(r));
    assert.equal(bodies.filter((b) => b.replayed === false).length, 1, JSON.stringify(bodies));
    const winner = bodies.findIndex((b) => b.replayed === false);
    for (const b of bodies) {
      assert.equal(b.status, 'closed');
      assert.equal(b.closed_at, bodies[winner].closed_at);
      assert.equal(b.table.state, 'available');
    }
    const [v] = rows('SELECT status, close_idempotency_key FROM visits WHERE id = ?', [visit.id]);
    assert.deepEqual(v, { status: 'closed', close_idempotency_key: keys[winner] });
    assert.equal(auditCount(visit.id, 'visit.checkout'), 1);
    assert.equal(auditCount(visit.id, 'visit.access_revoked'), 1);
    assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE visit_id = ? AND topic = 'visit.closed'`, [visit.id]), 1);
    assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE visit_id = ?', [visit.id]), 1);
    assert.equal(count(`SELECT COUNT(*) AS n FROM visits WHERE table_id = ? AND status <> 'closed'`, [table.id]), 0);
  }

  // The same key from two tabs (a double tap) is one checkout too.
  const s = await seat();
  const k = key('co');
  const pair = await Promise.all([checkout(s.visit.id, { idempotency_key: k }), checkout(s.visit.id, { idempotency_key: k }, cashier.clone())]);
  assert.deepEqual(pair.map((r) => ok(r).replayed).sort(), [false, true]);
  assert.equal(auditCount(s.visit.id, 'visit.checkout'), 1);
});

test('checkout racing a guest order ends in one consistent state', async (t) => {
  const seen = { closed: 0, ordered: 0 };
  for (let i = 0; i < 10; i++) {
    const { table, visit, guest } = await seat();
    const k = key('race');
    const [ro, rc] = await race([() => submit(guest, k, [SOUP()], 15000), () => checkout(visit.id)], i);
    if (rc.status === 200) {
      seen.closed++;
      // Visit closed first: the round is refused and nothing was created.
      expectError(ro, 410, 'visit_closed');
      assert.equal(count('SELECT COUNT(*) AS n FROM orders WHERE visit_id = ?', [visit.id]), 0);
      assert.equal(rc.body.table.state, 'available');
    } else {
      seen.ordered++;
      // The round landed first: checkout refuses, the table stays Dining.
      ok(ro, 201);
      const d = expectError(rc, 409, 'invalid_transition');
      assert.deepEqual(d.blockers, ['unresolved_orders']);
      assert.equal(visitStatus(visit.id), 'open');
      assert.equal(count('SELECT COUNT(*) AS n FROM orders WHERE visit_id = ?', [visit.id]), 1);
      await move(kitchen, visit.id, 'submitted', 'rejected', 'Kitchen closing');
      ok(await checkout(visit.id));
    }
    assert.equal(count(`SELECT COUNT(*) AS n FROM visits WHERE table_id = ? AND status <> 'closed'`, [table.id]), 0);
  }
  t.diagnostic(`checkout first: ${seen.closed}, order first: ${seen.ordered}`);
});

test('checkout racing a payment confirmation or a reversal ends consistently', async (t) => {
  const seen = { payThenClose: 0, closeRefused: 0, closedThenRefund: 0, reversedThenRefused: 0 };
  for (let i = 0; i < 6; i++) {
    // Payment vs checkout: the table is freed only if the payment committed first.
    const a = await readyToPay([SOUP()], 15000);
    const [rp, rc] = await race([() => pay(a.visit.id, a.revision), () => checkout(a.visit.id, {}, cashier2)], i);
    ok(rp);
    if (rc.status === 200) {
      seen.payThenClose++;
      const [p] = rows<{ confirmed_at: string }>('SELECT confirmed_at FROM payments WHERE visit_id = ?', [a.visit.id]);
      assert.ok(p.confirmed_at <= rc.body.closed_at);
    } else {
      seen.closeRefused++;
      const d = expectError(rc, 409, 'unpaid_bill');
      assert.equal(d.remaining.amount_due_minor, 15000);
      assert.equal(visitStatus(a.visit.id), 'billing');
      ok(await checkout(a.visit.id));
    }
    assert.equal(count(`SELECT COUNT(*) AS n FROM payments WHERE visit_id = ? AND kind = 'settlement' AND status = 'confirmed'`, [a.visit.id]), 1);

    // Reversal vs checkout: a reversal after close is only a refund record; before close it blocks checkout.
    const b = await readyToPay([LATTE_HOT()], 8000);
    const paid = ok(await pay(b.visit.id, b.revision));
    const paymentId = paid.payments[0].id;
    const [rr, rc2] = await race([
      () => manager.post(`/api/staff/payments/${paymentId}/reverse`, { reason: 'Card was declined later', idempotency_key: key('rev') }),
      () => checkout(b.visit.id),
    ], i + 1);
    ok(rr);
    const [record] = rows<{ kind: string }>('SELECT kind FROM payments WHERE reverses_payment_id = ?', [paymentId]);
    if (rc2.status === 200) {
      seen.closedThenRefund++;
      assert.equal(record.kind, 'refund_record');
      assert.equal(visitStatus(b.visit.id), 'closed');
      assert.equal(auditCount(b.visit.id, 'payment.refund_record'), 1);
    } else {
      seen.reversedThenRefused++;
      expectError(rc2, 409, 'unpaid_bill');
      assert.equal(record.kind, 'reversal');
      assert.equal(visitStatus(b.visit.id), 'billing');
      const now = await bill(b.visit.id);
      assert.equal(now.paid, false);
      assert.equal(now.current_revision.status, 'payable');
      ok(await pay(b.visit.id, now.current_revision));
      ok(await checkout(b.visit.id));
    }
    assert.equal(count('SELECT COUNT(*) AS n FROM payments WHERE reverses_payment_id = ?', [paymentId]), 1);
  }
  t.diagnostic(JSON.stringify(seen));
});

test('Start checkout racing the guest bill request: a stale refusal carries the fresh version and the retry succeeds', async () => {
  for (let i = 0; i < 4; i++) {
    const { visit, guest } = await seat();
    const vv = (await bill(visit.id)).visit_version;
    const [rq, rs] = await race([
      () => guest.post('/api/guest/bill/request', { idempotency_key: key('bill') }),
      () => floor.post(`/api/staff/visits/${visit.id}/billing/start`, { version: vv }),
    ], i);
    ok(rq); // asking for the bill works while dining or checking out
    if (rs.status !== 200) {
      // The request stamped the visit first (version bump). Documented behaviour:
      // stale_version with the current bill; the tablet retries with its version.
      const d = expectError(rs, 409, 'stale_version');
      assert.equal(d.current.visit_status, 'open');
      ok(await floor.post(`/api/staff/visits/${visit.id}/billing/start`, { version: d.current.visit_version }));
    }
    assert.equal(visitStatus(visit.id), 'billing');
    assert.equal(count(`SELECT COUNT(*) AS n FROM service_requests WHERE visit_id = ? AND type = 'bill'`, [visit.id]), 1);
    assert.ok(rows('SELECT bill_requested_at FROM visits WHERE id = ?', [visit.id])[0].bill_requested_at);
  }
});

// ------------------------------------------------------------------ brief 44F: quote approval racing checkout
test('a portion quote confirmation racing checkout ends consistently', async (t) => {
  const seen = { confirmed: 0, cancelled: 0 };
  for (let i = 0; i < 10; i++) {
    const inPerson = i % 2 === 1;
    const { table, visit, guest } = await seat();
    const req = ok(await guest.post('/api/guest/portions', { item_id: T.items.rib, preferred_grams: 300, idempotency_key: key('por') }), 201);
    const quoted = ok(await floor.post(`/api/staff/portions/${req.id}/quote`, { grams: 320, version: req.version }));
    const quote = quoted.quote;
    assert.equal(quote.amount_minor, 156800); // 320 g x 490 THB / 100 g
    const confirmKey = key('pcf');
    const confirm = () => inPerson
      ? floor2.post(`/api/staff/portions/${req.id}/confirm-in-person`, { quote_id: quote.id, revision: quote.revision, idempotency_key: confirmKey })
      : guest.clone().post(`/api/guest/portions/${req.id}/confirm`, { quote_id: quote.id, revision: quote.revision, idempotency_key: confirmKey });

    const [rq, rc] = await race([confirm, () => checkout(visit.id)], i);
    const portionLines = () => rows('SELECT status, measured_grams, line_total_minor FROM order_lines WHERE portion_quote_id = ?', [quote.id]);
    const [pr] = rows('SELECT status, resolution_reason FROM portion_requests WHERE id = ?', [req.id]);
    if (rq.status === 201) {
      seen.confirmed++;
      // Confirmed first: one real line exists and it blocks the straight-from-dining checkout.
      assert.deepEqual(portionLines(), [{ status: 'submitted', measured_grams: 320, line_total_minor: 156800 }]);
      const d = expectError(rc, 409, 'invalid_transition');
      assert.deepEqual(d.blockers, ['unresolved_orders']);
      assert.equal(visitStatus(visit.id), 'open');
      assert.equal(pr.status, 'confirmed');
      await move(kitchen, visit.id, 'submitted', 'rejected', 'Prime rib sold out');
      ok(await checkout(visit.id));
    } else {
      seen.cancelled++;
      // Checkout first: the quote was cancelled with the checkout and confirmation fails.
      ok(rc);
      assert.ok(
        (rq.status === 410 && rq.body.error.code === 'visit_closed') || (rq.status === 409 && rq.body.error.code === 'invalid_transition'),
        show(rq),
      );
      assert.deepEqual(portionLines(), []);
      assert.deepEqual(pr, { status: 'cancelled', resolution_reason: 'Visit closed at checkout' });
      assert.equal(rows('SELECT status FROM portion_quotes WHERE id = ?', [quote.id])[0].status, 'withdrawn');
      assert.equal(auditCount(visit.id, 'portion.cancelled_at_checkout'), 1);
      // A retry after the fact still creates nothing.
      const retry = await confirm();
      assert.ok(retry.status === 410 || retry.status === 409, show(retry));
      assert.deepEqual(portionLines(), []);
    }
    assert.equal(count(`SELECT COUNT(*) AS n FROM visits WHERE table_id = ? AND status <> 'closed'`, [table.id]), 0);
  }
  t.diagnostic(`confirmation first: ${seen.confirmed}, checkout first: ${seen.cancelled}`);

  // A quote still open when the table is checking out can never become a line.
  const s = await seat();
  await order(s.guest, [SOUP()], 15000);
  const req = ok(await s.guest.post('/api/guest/portions', { item_id: T.items.rib, idempotency_key: key('por') }), 201);
  const quote = ok(await floor.post(`/api/staff/portions/${req.id}/quote`, { grams: 250, version: req.version })).quote;
  await serveAll(s.visit.id);
  await startBilling(s.visit.id);
  const fin = await finalize(s.visit.id, 15000);
  ok(await pay(s.visit.id, fin.current_revision));
  const staleb = await bill(s.visit.id);
  assert.deepEqual(staleb.checkout_blockers, ['open_portions']); // informational only
  const [rq, rc] = await Promise.all([
    s.guest.clone().post(`/api/guest/portions/${req.id}/confirm`, { quote_id: quote.id, revision: quote.revision, idempotency_key: key('pcf') }),
    checkout(s.visit.id),
  ]);
  ok(rc);
  assert.ok([409, 410].includes(rq.status) && ['visit_billing', 'visit_closed', 'invalid_transition'].includes(rq.body.error.code), show(rq));
  assert.equal(count('SELECT COUNT(*) AS n FROM order_lines WHERE portion_quote_id = ?', [quote.id]), 0);
  assert.equal(rows('SELECT status FROM portion_requests WHERE id = ?', [req.id])[0].status, 'cancelled');
});
