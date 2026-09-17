// Scenario 15 (brief 15, 22, 30, 31; D-21, D-25): service-request
// deduplication, staff handling with versions, offline manual-entry recovery
// without a duplicate cooking instruction, and optional one-per-session feedback.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { key, startServer, type Client, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';
import { ROLES, type Role } from '../../shared/permissions.ts';

let srv: TestServer;
const staff = {} as Record<Role, Client>;

before(async () => {
  // Each simulated guest device joins from its own address (the join limit is per address).
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  for (const role of ROLES) staff[role] = await srv.staff(role);
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
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
  const r = await c.request('POST', '/api/public/qr/join', { token, pin }, { 'X-Forwarded-For': `10.15.${Math.floor(deviceSeq / 250)}.${deviceSeq % 250}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

/** A fresh table with its own QR card and an open visit, so no two tests share a party. */
async function seat(covers = 2) {
  const t = await staff.manager.post('/api/staff/tables', { label: `SV${++tableSeq}` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const cards = await staff.manager.get(`/api/staff/tables/qr-cards?ids=${t.body.id}`);
  const token = decodeURIComponent(String(cards.body.cards[0].url).split('/q/')[1]);
  const v = await staff.floor.post(`/api/staff/tables/${t.body.id}/visits`, { covers, idempotency_key: key('open') });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  return { tableId: t.body.id as string, table: t.body, visit: v.body, guest: () => join(token, v.body.join_pin) };
}

const tap = (g: Client, type: string, k = key('svc'), note?: string) =>
  g.post('/api/guest/service', { type, idempotency_key: k, ...(note ? { note } : {}) });

const serviceTransition = (c: Client, id: string, to: string, version: number, reason?: string) =>
  c.post(`/api/staff/service/${id}/transition`, { to, version, ...(reason ? { reason } : {}) });

function requestRows(visitId: string, type?: string) {
  return srv.sql<{ id: string; status: string; version: number; close_reason: string | null }>(
    `SELECT id, status, version, close_reason FROM service_requests WHERE visit_id = ? AND (? IS NULL OR type = ?) ORDER BY created_at, id`,
    [visitId, type ?? null, type ?? null]);
}

const soup = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] });
const steak = (option: string) => ({
  item_id: T.items.steak, quantity: 1,
  modifiers: [{ group_id: T.groups.doneness, option_ids: [option] }, { group_id: T.groups.sides, option_ids: [T.options.fries] }],
});
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function recover(c: Client, visitId: string, manualReference: string, lines: unknown[], already: 'none' | 'prepared' | 'served', originalTime = minutesAgo(20)) {
  return c.post('/api/staff/orders/recover', {
    visit_id: visitId, manual_reference: manualReference, original_time: originalTime, lines, already, reason: 'Tablets offline, paper ticket',
  });
}

// ------------------------------------------------------------------ service requests
test('rapid repeated taps from two devices at one table page staff once per request type', async () => {
  const { visit, tableId, guest } = await seat();
  const [a, b] = [await guest(), await guest()];
  const aTab2 = a.clone();

  // Eight near-simultaneous "Call staff" taps (fresh key per tap) plus one "Water".
  const results = await Promise.all([
    tap(a, 'call_staff'), tap(b, 'call_staff'), tap(aTab2, 'call_staff'), tap(b, 'call_staff'),
    tap(a, 'call_staff'), tap(b, 'call_staff'), tap(aTab2, 'call_staff'), tap(a, 'call_staff'),
    tap(b, 'water'),
  ]);
  const calls = results.slice(0, 8);
  for (const r of calls) assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  assert.equal(calls.filter((r) => r.status === 201).length, 1, 'exactly one tap created the request');
  assert.equal(new Set(calls.map((r) => r.body.id)).size, 1, 'every tap sees the same request');
  assert.equal(results[8].status, 201, 'another type is a separate request');

  assert.equal(requestRows(visit.id, 'call_staff').length, 1);
  assert.equal(requestRows(visit.id).length, 2);
  const id = calls[0].body.id;
  // Staff were paged once: one event and one audit entry for the call.
  assert.equal(srv.sql(`SELECT count(*) n FROM events WHERE topic = 'service.updated' AND entity_id = ?`, [id])[0].n, 1);
  assert.equal(srv.sql(`SELECT count(*) n FROM audit_events WHERE action = 'service.request' AND entity_id = ?`, [id])[0].n, 1);
  const queue = await staff.floor.get('/api/staff/service?scope=active');
  assert.equal(queue.status, 200);
  const mine = queue.body.requests.filter((r: { visit_id: string }) => r.visit_id === visit.id);
  assert.deepEqual(mine.map((r: { type: string }) => r.type).sort(), ['call_staff', 'water']);
  assert.equal(mine[0].table_label, `SV${tableSeq}`);

  // A retried tap with the same key returns the same request; the same key for another type is refused.
  const k = key('svc');
  const first = await tap(a, 'order_change', k);
  assert.equal(first.status, 201);
  const again = await tap(a, 'order_change', k);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  expectError(await tap(a, 'allergy_help', k), 409, 'idempotency_mismatch');
  assert.equal(requestRows(visit.id, 'allergy_help').length, 0);

  // The staff tile shows the call.
  const tables = await staff.floor.get('/api/staff/tables');
  const tile = tables.body.tables.find((t: { id: string }) => t.id === tableId);
  assert.ok(tile.attention.includes('service_request'));
});

test('an acknowledged request is still the active one; once completed a new request of that type is allowed', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const sent = await tap(g, 'call_staff', key('svc'), 'Need another chair');
  assert.equal(sent.status, 201);
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.note, 'Need another chair');

  const ack = await serviceTransition(staff.floor, sent.body.id, 'acknowledged', sent.body.version);
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal(ack.body.status, 'acknowledged');
  assert.equal(ack.body.acknowledged_by, 'Test floor');

  const whileAcknowledged = await tap(g, 'call_staff');
  assert.equal(whileAcknowledged.status, 200);
  assert.equal(whileAcknowledged.body.id, sent.body.id);
  assert.equal(whileAcknowledged.body.status, 'acknowledged');
  assert.equal(whileAcknowledged.body.acknowledged_by, null, 'guests never see staff names');
  const guestList = await g.get('/api/guest/service');
  assert.equal(guestList.body.requests[0].acknowledged_by, null);
  assert.ok(guestList.body.requests[0].acknowledged_at);

  const done = await serviceTransition(staff.floor, sent.body.id, 'completed', ack.body.version);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');

  const second = await tap(g, 'call_staff');
  assert.equal(second.status, 201, 'a completed request no longer blocks a new one');
  assert.notEqual(second.body.id, sent.body.id);
  assert.equal(second.body.status, 'sent');

  // Completing straight from "sent" also records the first response.
  const direct = await serviceTransition(staff.cashier, second.body.id, 'completed', second.body.version);
  assert.equal(direct.status, 200, JSON.stringify(direct.body));
  assert.ok(direct.body.acknowledged_at);
  assert.equal(direct.body.acknowledged_by, 'Test cashier');
  assert.equal(direct.body.completed_by, 'Test cashier');

  assert.equal((await tap(g, 'call_staff')).status, 201);
  assert.deepEqual(requestRows(visit.id, 'call_staff').map((r) => r.status), ['completed', 'completed', 'sent']);
});

test('a service the restaurant has switched off is refused with details.reason = service_disabled', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  // Utensils are off in the fixture settings.
  const utensils = await tap(g, 'utensils');
  expectError(utensils, 400, 'bad_request');
  assert.equal(utensils.body.error.details.reason, 'service_disabled');
  const config = await srv.client().get('/api/public/config');
  assert.ok(!config.body.services.includes('utensils'));
  assert.ok(config.body.services.includes('call_staff'));

  // The owner switches Call staff off: refused; switched back on: works again.
  const off = await staff.owner.patch('/api/staff/settings', { services: { call_staff: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  try {
    const refused = await tap(g, 'call_staff');
    expectError(refused, 400, 'bad_request');
    assert.equal(refused.body.error.details.reason, 'service_disabled');
    assert.ok(!(await g.get('/api/guest/session')).body.services.includes('call_staff'));
  } finally {
    const on = await staff.owner.patch('/api/staff/settings', { services: { call_staff: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
  }
  assert.equal(requestRows(visit.id).length, 0);
  assert.equal((await tap(g, 'call_staff')).status, 201);
});

test('staff transitions carry versions: two devices acknowledging at once get one success and one stale_version', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = (await tap(g, 'order_change', key('svc'), 'Swap fries for salad')).body;

  const [x, y] = await Promise.all([
    serviceTransition(staff.floor, req.id, 'acknowledged', req.version),
    serviceTransition(staff.cashier, req.id, 'acknowledged', req.version),
  ]);
  const ok = [x, y].filter((r) => r.status === 200);
  const stale = [x, y].filter((r) => r.status !== 200);
  assert.equal(ok.length, 1, JSON.stringify([x.body, y.body]));
  expectError(stale[0], 409, 'stale_version');
  assert.equal(stale[0].body.error.details.current.status, 'acknowledged', 'the loser is shown the current state');
  const current = stale[0].body.error.details.current;

  // Completing from the stale version is refused too; with the current one it works.
  expectError(await serviceTransition(staff.cashier, req.id, 'completed', req.version), 409, 'stale_version');
  const done = await serviceTransition(staff.cashier, req.id, 'completed', current.version);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  expectError(await serviceTransition(staff.floor, req.id, 'acknowledged', done.body.version), 409, 'invalid_transition');

  const row = requestRows(visit.id)[0];
  assert.equal(row.status, 'completed');
  assert.equal(srv.sql(`SELECT count(*) n FROM audit_events WHERE entity_id = ? AND action = 'service.acknowledged'`, [req.id])[0].n, 1);
  assert.equal(srv.sql(`SELECT count(*) n FROM audit_events WHERE entity_id = ? AND action = 'service.completed'`, [req.id])[0].n, 1);
});

test('cancelling a request needs service.cancel and a reason; kitchen does not handle the service queue', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const req = (await tap(g, 'allergy_help', key('svc'), 'Nut allergy question')).body;

  expectForbidden(await staff.kitchen.get('/api/staff/service'), 'service.handle');
  expectForbidden(await serviceTransition(staff.kitchen, req.id, 'acknowledged', req.version), 'service.handle');
  for (const role of ['floor', 'cashier'] as const) {
    expectForbidden(await serviceTransition(staff[role], req.id, 'cancelled', req.version, 'Handled at the table'), 'service.cancel');
  }
  assert.equal(requestRows(visit.id)[0].status, 'sent');

  expectError(await serviceTransition(staff.manager, req.id, 'cancelled', req.version), 422, 'validation_failed');
  const cancelled = await serviceTransition(staff.manager, req.id, 'cancelled', req.version, 'Guest asked in person');
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.cancelled_by, 'Test manager');
  assert.equal(cancelled.body.close_reason, 'Guest asked in person');

  const seen = (await g.get('/api/guest/service')).body.requests[0];
  assert.equal(seen.status, 'cancelled');
  assert.equal(seen.close_reason, 'Guest asked in person');
  assert.equal(seen.cancelled_by, null);
  assert.equal((await tap(g, 'allergy_help')).status, 201, 'a cancelled request no longer blocks a new one');
});

test('checkout resolves open requests attributably: the bill request is handled, the rest cancelled with the reason', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const call = (await tap(g, 'call_staff')).body;
  const bill = await g.post('/api/guest/bill/request', { idempotency_key: key('bill') });
  assert.equal(bill.status, 200, JSON.stringify(bill.body));
  assert.ok(bill.body.bill_requested_at);
  assert.equal(requestRows(visit.id).length, 2);

  // Nothing was ordered, so the party can be checked out straight from dining.
  const out = await staff.cashier.post(`/api/staff/visits/${visit.id}/checkout`, { idempotency_key: key('co'), request_close_reason: 'Guests left' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const rows = srv.sql<{ type: string; status: string; close_reason: string; completed_by: string | null; cancelled_by: string | null }>(
    'SELECT type, status, close_reason, completed_by, cancelled_by FROM service_requests WHERE visit_id = ? ORDER BY type', [visit.id]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { type: 'bill', status: 'completed', close_reason: 'Bill handled at checkout', completed_by: 'Test cashier', cancelled_by: null },
    { type: 'call_staff', status: 'cancelled', close_reason: 'Guests left', completed_by: null, cancelled_by: 'Test cashier' },
  ]);
  assert.equal(rows[1].type, 'call_staff');
  assert.equal(requestRows(visit.id, 'call_staff')[0].id, call.id);
  expectError(await tap(g, 'call_staff'), 410, 'visit_closed');
});

// ------------------------------------------------------------------ manual recovery
test('offline recovery: paper orders already served or prepared never reach the kitchen as new work', async () => {
  const { visit, tableId, guest } = await seat();
  const g = await guest();
  const unacceptedBefore = (await staff.manager.get('/api/staff/overview')).body.unaccepted_rounds;
  const takenAt = minutesAgo(25);

  const served = await recover(staff.manager, visit.id, 'PAPER-0001', [soup(2)], 'served', takenAt);
  assert.equal(served.status, 201, JSON.stringify(served.body));
  const prepared = await recover(staff.manager, visit.id, 'PAPER-0002', [steak(T.options.rare)], 'prepared');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));

  const s = served.body.order;
  assert.equal(s.source, 'manual_recovery');
  assert.equal(s.manual_reference, 'PAPER-0001');
  assert.equal(s.submitted_at, takenAt, 'the round keeps the time it was really taken');
  assert.equal(s.subtotal_minor, 30000);
  assert.deepEqual(s.lines.map((l: { status: string }) => l.status), ['served']);
  assert.deepEqual(prepared.body.order.lines.map((l: { status: string }) => l.status), ['ready']);

  const recoveredIds = [s.id, prepared.body.order.id];
  const lineRows = srv.sql<{ status: string; accepted_at: string | null; preparing_at: string | null; prepared_before_entry: number }>(
    `SELECT status, accepted_at, preparing_at, prepared_before_entry FROM order_lines WHERE order_id IN (?, ?)`, recoveredIds);
  assert.equal(lineRows.length, 2);
  for (const l of lineRows) {
    assert.notEqual(l.status, 'submitted', 'no cooking instruction was issued');
    assert.equal(l.accepted_at, null, 'acceptance time is not invented');
    assert.equal(l.preparing_at, null);
    assert.equal(l.prepared_before_entry, 1);
  }
  const kinds = srv.sql<{ kind: string }>(`SELECT DISTINCT kind FROM line_events WHERE order_id IN (?, ?)`, recoveredIds).map((r) => r.kind);
  assert.deepEqual(kinds, ['recovery']);

  // The kitchen's work queue (new / accepted / preparing) does not contain them; the prepared dish waits for floor.
  const work = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}&status=submitted,accepted,preparing`);
  assert.equal(work.status, 200);
  assert.deepEqual(work.body.orders, []);
  const ready = await staff.floor.get(`/api/staff/orders?scope=active&table=${tableId}&status=ready`);
  assert.deepEqual(ready.body.orders.map((o: { id: string }) => o.id), [prepared.body.order.id]);
  assert.equal((await staff.manager.get('/api/staff/overview')).body.unaccepted_rounds, unacceptedBefore);

  // Flagged in the audit trail with the paper reference.
  const audit = srv.sql<{ actor_id: string; reason: string; after_json: string }>(
    `SELECT actor_id, reason, after_json FROM audit_events WHERE action = 'order.recovered' AND entity_id = ?`, [s.id]);
  assert.equal(audit.length, 1);
  const after = JSON.parse(audit[0].after_json);
  assert.equal(after.flagged, true);
  assert.equal(after.manual_reference, 'PAPER-0001');
  assert.equal(after.already, 'served');
  assert.equal(audit[0].actor_id, 'stf_manager');
  assert.equal(audit[0].reason, 'Tablets offline, paper ticket');

  // A paper order that was NOT yet cooked goes to the kitchen normally.
  const notCooked = await recover(staff.manager, visit.id, 'PAPER-0003', [soup()], 'none');
  assert.equal(notCooked.status, 201, JSON.stringify(notCooked.body));
  assert.deepEqual(notCooked.body.order.lines.map((l: { status: string }) => l.status), ['submitted']);
  const work2 = await staff.kitchen.get(`/api/staff/orders?scope=active&table=${tableId}&status=submitted`);
  assert.deepEqual(work2.body.orders.map((o: { id: string }) => o.id), [notCooked.body.order.id]);

  // The table bill counts what was served and prepared; the uncooked round is still pending.
  const guestBill = await g.get('/api/guest/bill');
  assert.equal(guestBill.body.subtotal_minor, 30000 + 59000);
  assert.equal(guestBill.body.pending_lines.length, 1);
});

test('a manual reference is entered once: resending replays, different details or another visit conflict', async () => {
  const one = await seat();
  const other = await seat();
  const first = await recover(staff.manager, one.visit.id, 'PAD-77', [soup()], 'served', minutesAgo(40));
  assert.equal(first.status, 201);
  const originalTime = first.body.order.submitted_at;

  const again = await recover(staff.owner, one.visit.id, 'PAD-77', [soup()], 'served', originalTime);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.order.id, first.body.order.id);

  const different = await recover(staff.manager, one.visit.id, 'PAD-77', [soup(3)], 'served', originalTime);
  expectError(different, 409, 'conflict');
  assert.equal(different.body.error.details.field, 'manual_reference');
  expectError(await recover(staff.manager, other.visit.id, 'PAD-77', [soup()], 'served', originalTime), 409, 'conflict');
  assert.equal(srv.sql(`SELECT count(*) n FROM orders WHERE manual_reference = 'PAD-77'`)[0].n, 1);
  assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [other.visit.id])[0].n, 0);

  // Two managers entering the same paper ticket at the same moment: one order.
  const at = minutesAgo(10);
  const raced = await Promise.all([
    recover(staff.manager, one.visit.id, 'PAD-78', [soup(2)], 'prepared', at),
    recover(staff.owner, one.visit.id, 'PAD-78', [soup(2)], 'prepared', at),
    recover(staff.manager, one.visit.id, 'PAD-78', [soup(2)], 'prepared', at),
  ]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(raced.map((r) => r.body.order.id)).size, 1);
  assert.equal(srv.sql(`SELECT count(*) n FROM orders WHERE manual_reference = 'PAD-78'`)[0].n, 1);
  assert.equal(srv.sql(`SELECT count(*) n FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.manual_reference = 'PAD-78'`)[0].n, 1);
});

test('recovery works while ordering is paused and is forbidden for floor, cashier and kitchen', async () => {
  const { visit, table, guest } = await seat();
  const g = await guest();
  const paused = await staff.manager.patch('/api/staff/ordering', {
    enabled: false, paused_message_th: 'ครัวพักรับออร์เดอร์', paused_message_en: 'Kitchen paused', reason: 'Network outage',
  });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  try {
    expectError(await g.post('/api/guest/orders', { idempotency_key: key('att'), lines: [soup()], expected_subtotal_minor: 15000 }), 423, 'ordering_paused');
    expectError(await staff.floor.post('/api/staff/orders/assist', { visit_id: visit.id, idempotency_key: key('as'), lines: [soup()], expected_subtotal_minor: 15000 }), 423, 'ordering_paused');

    for (const role of ['floor', 'cashier', 'kitchen'] as const) {
      expectForbidden(await recover(staff[role], visit.id, `PAUSE-${role}`, [soup()], 'served'), 'orders.recover_manual');
    }
    assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id])[0].n, 0);

    const recovered = await recover(staff.manager, visit.id, 'PAUSE-OK', [soup()], 'served');
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  } finally {
    const resumed = await staff.manager.patch('/api/staff/ordering', { enabled: true });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  }

  // A paused table does not stop a paper entry either.
  const tablePause = await staff.manager.patch(`/api/staff/tables/${table.id}`, { ordering_paused: true, version: srv.sql('SELECT version FROM dining_tables WHERE id = ?', [table.id])[0].version });
  assert.equal(tablePause.status, 200, JSON.stringify(tablePause.body));
  expectError(await g.post('/api/guest/orders', { idempotency_key: key('att'), lines: [soup()], expected_subtotal_minor: 15000 }), 423, 'table_paused');
  const second = await recover(staff.manager, visit.id, 'PAUSE-TABLE', [soup()], 'prepared');
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id])[0].n, 2);
});

test('recovered orders still go through pricing review: a sold-out dish is accepted, a weighed cut or a missing choice is not', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const soupItem = (await staff.kitchen.get('/api/staff/menu')).body.items.find((i: { id: string }) => i.id === T.items.soup);
  assert.equal((await staff.kitchen.post(`/api/staff/menu/items/${T.items.soup}/availability`, { sold_out: true, version: soupItem.version })).status, 200);
  try {
    const guestTry = await g.post('/api/guest/orders', { idempotency_key: key('att'), lines: [soup()], expected_subtotal_minor: 15000 });
    expectError(guestTry, 409, 'cart_changed');
    assert.equal(guestTry.body.error.details.quote.issues[0].code, 'sold_out');
    // The paper order was taken before the soup ran out.
    const ok = await recover(staff.manager, visit.id, 'REV-SOLDOUT', [soup()], 'served');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally {
    assert.equal((await staff.kitchen.post(`/api/staff/menu/items/${T.items.soup}/availability`, { sold_out: false })).status, 200);
  }

  const cut = await recover(staff.manager, visit.id, 'REV-RIB', [{ item_id: T.items.rib, quantity: 1, modifiers: [] }], 'served');
  expectError(cut, 409, 'cart_changed');
  assert.ok(cut.body.error.details.quote.issues.some((i: { code: string }) => i.code === 'measured_weight_needs_quote'));
  const noDoneness = await recover(staff.manager, visit.id, 'REV-STEAK', [{ item_id: T.items.steak, quantity: 1, modifiers: [] }], 'served');
  expectError(noDoneness, 409, 'cart_changed');
  assert.ok(noDoneness.body.error.details.quote.issues.some((i: { code: string }) => i.code === 'modifier_required'));

  expectError(await recover(staff.manager, visit.id, 'REV-OLD', [soup()], 'served', minutesAgo(25 * 60)), 422, 'validation_failed');
  expectError(await recover(staff.manager, visit.id, 'REV-FUTURE', [soup()], 'served', minutesAgo(-10)), 422, 'validation_failed');
  expectError(await staff.manager.post('/api/staff/orders/recover', {
    visit_id: visit.id, manual_reference: 'REV-NOREASON', original_time: minutesAgo(5), lines: [soup()], already: 'served', reason: '',
  }), 422, 'validation_failed');
  assert.deepEqual(srv.sql<{ manual_reference: string }>('SELECT manual_reference FROM orders WHERE visit_id = ?', [visit.id]).map((r) => r.manual_reference), ['REV-SOLDOUT']);
});

// ------------------------------------------------------------------ feedback
test('feedback is optional, one per guest session, idempotent, and never published', async () => {
  const COMMENT = 'Lovely crust on the striploin, a bit slow tonight';
  const { visit, guest } = await seat();
  const [a, b, c] = [await guest(), await guest(), await guest()];

  // Never a prerequisite: the bill is readable without it.
  assert.equal((await c.get('/api/guest/bill')).status, 200);

  expectError(await a.post('/api/guest/feedback', { idempotency_key: key('fb') }), 422, 'validation_failed');
  expectError(await a.post('/api/guest/feedback', { rating: 6, idempotency_key: key('fb') }), 422, 'validation_failed');

  const k = key('fb');
  const sends = await Promise.all([
    a.post('/api/guest/feedback', { rating: 4, comment: COMMENT, idempotency_key: k }),
    a.clone().post('/api/guest/feedback', { rating: 4, comment: COMMENT, idempotency_key: k }),
    a.post('/api/guest/feedback', { rating: 4, comment: COMMENT, idempotency_key: k }),
  ]);
  assert.deepEqual(sends.map((r) => r.status).sort(), [200, 200, 201]);
  assert.deepEqual(sends.map((r) => r.body.ok), [true, true, true]);
  expectError(await a.post('/api/guest/feedback', { rating: 1, idempotency_key: key('fb') }), 409, 'already_done');

  const fromB = await b.post('/api/guest/feedback', { comment: 'Great service', idempotency_key: key('fb') });
  assert.equal(fromB.status, 201, JSON.stringify(fromB.body));

  const rows = srv.sql<{ rating: number | null; comment: string | null }>('SELECT rating, comment FROM feedback WHERE visit_id = ? ORDER BY created_at', [visit.id]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ rating: 4, comment: COMMENT }, { rating: null, comment: 'Great service' }]);

  // Private: never broadcast, and the audit only knows a comment exists.
  assert.equal(srv.sql(`SELECT count(*) n FROM events WHERE topic LIKE 'feedback%' OR payload LIKE ?`, [`%${COMMENT.slice(0, 20)}%`])[0].n, 0);
  const audits = srv.sql<{ after_json: string }>(`SELECT after_json FROM audit_events WHERE action = 'feedback.submit' AND visit_id = ?`, [visit.id]);
  assert.equal(audits.length, 2);
  for (const r of audits) {
    assert.ok(!r.after_json.includes('striploin') && !r.after_json.includes('Great service'), r.after_json);
    assert.equal(JSON.parse(r.after_json).has_comment, true);
  }
});
