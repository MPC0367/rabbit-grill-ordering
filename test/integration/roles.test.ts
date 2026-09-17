// Scenario 14 (brief 18, 31): the role matrix is enforced by the SERVER, not by
// hidden navigation. Every refusal below is a real request with a valid body
// that another role completes successfully, and the database proves the
// refused request changed nothing.
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
  const r = await c.request('POST', '/api/public/qr/join', { token, pin }, { 'X-Forwarded-For': `10.14.${Math.floor(deviceSeq / 250)}.${deviceSeq % 250}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

/** A fresh table with its own QR card and an open visit, so no two tests share a party. */
async function seat(covers = 2) {
  const t = await staff.manager.post('/api/staff/tables', { label: `RL${++tableSeq}` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const cards = await staff.manager.get(`/api/staff/tables/qr-cards?ids=${t.body.id}`);
  assert.equal(cards.status, 200, JSON.stringify(cards.body));
  const token = decodeURIComponent(String(cards.body.cards[0].url).split('/q/')[1]);
  const v = await staff.floor.post(`/api/staff/tables/${t.body.id}/visits`, { covers, idempotency_key: key('open') });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  return { tableId: t.body.id as string, visit: v.body, guest: () => join(token, v.body.join_pin) };
}

async function submit(guest: Client, lines: unknown[], subtotal: number) {
  const r = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: subtotal });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.order;
}

const ref = (l: { id: string; version: number }) => ({ id: l.id, version: l.version });

/** Current id/version/status of order lines, straight from the database. */
function lines(...ids: string[]): Array<{ id: string; version: number; status: string; status_reason: string | null }> {
  return ids.map((id) => srv.sql('SELECT id, version, status, status_reason FROM order_lines WHERE id = ?', [id])[0]);
}

function transition(c: Client, refs: Array<{ id: string; version: number }>, to: string, reason?: string | null) {
  return c.post('/api/staff/orders/transition', { lines: refs, to, ...(reason === undefined ? {} : { reason }) });
}

function visitVersion(visitId: string): number {
  return srv.sql<{ version: number }>('SELECT version FROM visits WHERE id = ?', [visitId])[0].version;
}

const soup = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] });
const latteHot = () => ({ item_id: T.items.coffee, variant_id: T.variants.hot, quantity: 1, modifiers: [] });
const steakRare = () => ({
  item_id: T.items.steak, quantity: 1,
  modifiers: [{ group_id: T.groups.doneness, option_ids: [T.options.rare] }, { group_id: T.groups.sides, option_ids: [T.options.fries] }],
});

// ------------------------------------------------------------------ tests
test('kitchen and floor cannot finalize bills, confirm payments or read payment references; cashier can', async () => {
  const REF = 'SLIP-7731-XYZ';
  const { visit, guest } = await seat();
  const g = await guest();
  const order = await submit(g, [soup(2)], 30000);
  assert.equal((await transition(staff.kitchen, order.lines.map(ref), 'accepted')).status, 200);

  // Floor may start checkout (billing.start) but not finalize or take money.
  const started = await staff.floor.post(`/api/staff/visits/${visit.id}/billing/start`, { version: visitVersion(visit.id) });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const finalizeBody = { bill_version: started.body.bill_version, expected_total_minor: 30000 };

  expectForbidden(await staff.kitchen.get(`/api/staff/visits/${visit.id}/bill`), 'billing.view');
  expectForbidden(await staff.kitchen.post(`/api/staff/visits/${visit.id}/bill/finalize`, finalizeBody), 'billing.finalize');
  expectForbidden(await staff.floor.post(`/api/staff/visits/${visit.id}/bill/finalize`, finalizeBody), 'billing.finalize');
  assert.equal(srv.sql('SELECT count(*) n FROM bill_revisions WHERE visit_id = ?', [visit.id])[0].n, 0);

  const finalized = await staff.cashier.post(`/api/staff/visits/${visit.id}/bill/finalize`, finalizeBody);
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.current_revision.total_minor, 30000);

  const pay = { revision_id: finalized.body.current_revision.id, method: 'cash', amount_minor: 30000, tendered_minor: 50000, reference: REF, idempotency_key: key('pay') };
  expectForbidden(await staff.kitchen.post(`/api/staff/visits/${visit.id}/payments`, pay), 'payments.confirm');
  expectForbidden(await staff.floor.post(`/api/staff/visits/${visit.id}/payments`, pay), 'payments.confirm');
  assert.equal(srv.sql('SELECT count(*) n FROM payments WHERE visit_id = ?', [visit.id])[0].n, 0);

  const paid = await staff.cashier.post(`/api/staff/visits/${visit.id}/payments`, pay);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.paid, true);
  assert.equal(paid.body.payments.length, 1);
  assert.equal(paid.body.payments[0].reference, REF);
  assert.equal(paid.body.payments[0].change_minor, 20000);
  assert.equal(srv.sql(`SELECT count(*) n FROM payments WHERE visit_id = ? AND status = 'confirmed'`, [visit.id])[0].n, 1);

  // Payment references: only payments.view (owner, manager, cashier).
  expectForbidden(await staff.kitchen.get('/api/staff/payments'), 'payments.view');
  expectForbidden(await staff.floor.get('/api/staff/payments'), 'payments.view');
  const list = await staff.cashier.get('/api/staff/payments');
  assert.equal(list.status, 200);
  assert.equal(list.body.payments.find((p: { visit_id: string }) => p.visit_id === visit.id)?.reference, REF);

  const floorBill = await staff.floor.get(`/api/staff/visits/${visit.id}/bill`);
  assert.equal(floorBill.status, 200);
  assert.equal(floorBill.body.payments[0].amount_minor, 30000);
  assert.equal(floorBill.body.payments[0].reference, null, 'floor sees the payment but not its reference');
  const floorVisit = await staff.floor.get(`/api/staff/visits/${visit.id}`);
  assert.equal(floorVisit.status, 200);
  assert.ok(!JSON.stringify(floorVisit.body).includes(REF), 'the visit detail (bill + history) never carries the reference for floor');
  const cashierBill = await staff.cashier.get(`/api/staff/visits/${visit.id}/bill`);
  assert.equal(cashierBill.body.payments[0].reference, REF);

  // Kitchen gets no visit/bill data at all; corrections and checkout are not theirs either.
  expectForbidden(await staff.kitchen.get(`/api/staff/visits/${visit.id}`), 'tables.view');
  const paymentId = paid.body.payments[0].id;
  for (const role of ['kitchen', 'floor', 'cashier'] as const) {
    expectForbidden(await staff[role].post(`/api/staff/payments/${paymentId}/reverse`, { reason: 'Wrong table', idempotency_key: key('rev') }), 'payments.correct');
  }
  for (const role of ['kitchen', 'floor'] as const) {
    expectForbidden(await staff[role].post(`/api/staff/visits/${visit.id}/checkout`, { idempotency_key: key('co') }), 'checkout.complete');
  }
  assert.equal(srv.sql(`SELECT status FROM payments WHERE id = ?`, [paymentId])[0].status, 'confirmed');
  assert.equal(srv.sql(`SELECT status FROM visits WHERE id = ?`, [visit.id])[0].status, 'billing');

  // The reference never leaks into the widely readable audit log or the event outbox.
  assert.equal(srv.sql(`SELECT count(*) n FROM audit_events WHERE coalesce(after_json,'') || coalesce(before_json,'') || coalesce(reason,'') LIKE ?`, [`%${REF}%`])[0].n, 0);
  assert.equal(srv.sql('SELECT count(*) n FROM events WHERE payload LIKE ?', [`%${REF}%`])[0].n, 0);
});

test('only the owner manages the team and settings; kitchen, floor and cashier cannot open stats, reports or audit', async () => {
  const usersBefore = srv.sql('SELECT count(*) n FROM staff_users')[0].n;
  const kitchenVersion = srv.sql(`SELECT version FROM staff_users WHERE id = 'stf_kitchen'`)[0].version;

  for (const role of ['kitchen', 'floor', 'cashier', 'manager'] as const) {
    const c = staff[role];
    expectForbidden(await c.get('/api/staff/team'), 'team.manage');
    expectForbidden(await c.post('/api/staff/team', { username: `made-by-${role}`, display_name: 'Nope', role: 'owner', password: 'long-enough-password-1' }), 'team.manage');
    expectForbidden(await c.patch('/api/staff/team/stf_kitchen', { role: 'owner', version: kitchenVersion }), 'team.manage');
    expectForbidden(await c.post('/api/staff/team/stf_owner/password', { password: 'long-enough-password-2' }), 'team.manage');
    expectForbidden(await c.post('/api/staff/team/stf_owner/revoke-sessions'), 'team.manage');
    expectForbidden(await c.get('/api/staff/settings'), 'settings.manage');
    expectForbidden(await c.patch('/api/staff/settings', { service_cooldown_seconds: 5 }), 'settings.manage');
  }
  for (const role of ['kitchen', 'floor', 'cashier'] as const) {
    const c = staff[role];
    expectForbidden(await c.get('/api/staff/stats/orders'), 'stats.view');
    expectForbidden(await c.get('/api/staff/stats/menu'), 'stats.view');
    expectForbidden(await c.get('/api/staff/stats/kpis'), 'stats.view');
    expectForbidden(await c.get('/api/staff/stats/engagement'), 'stats.engagement');
    expectForbidden(await c.get('/api/staff/stats/export.csv?view=orders'), 'stats.view');
    expectForbidden(await c.get('/api/staff/reports/years'), 'reports.view');
    expectForbidden(await c.post('/api/staff/reports/jobs', { year: 2026, kind: 'annual_csv' }), 'reports.generate');
    expectForbidden(await c.get('/api/staff/audit'), 'audit.view');
  }
  // Nothing above changed anything.
  assert.equal(srv.sql('SELECT count(*) n FROM staff_users')[0].n, usersBefore);
  assert.equal(srv.sql(`SELECT role FROM staff_users WHERE id = 'stf_kitchen'`)[0].role, 'kitchen');
  assert.equal(srv.sql(`SELECT count(*) n FROM settings WHERE key = 'service_cooldown_seconds'`)[0].n, 0);
  assert.equal(srv.sql('SELECT count(*) n FROM report_jobs')[0].n, 0);
  // The owner's session still works (the refused revoke did nothing).
  assert.equal((await staff.owner.get('/api/staff/auth/me')).status, 200);

  // Managers do get the insight screens.
  assert.equal((await staff.manager.get('/api/staff/stats/orders')).status, 200);
  assert.equal((await staff.manager.get('/api/staff/audit')).status, 200);

  // The owner can do all of it.
  const team = await staff.owner.get('/api/staff/team');
  assert.equal(team.status, 200);
  assert.equal(team.body.users.length, usersBefore);
  const created = await staff.owner.post('/api/staff/team', { username: 'second-cook', display_name: 'Second Cook', role: 'kitchen', password: 'grill-station-pass-9' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(srv.sql('SELECT count(*) n FROM staff_users')[0].n, usersBefore + 1);
  const patched = await staff.owner.patch('/api/staff/settings', { service_cooldown_seconds: 30 });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.settings.service_cooldown_seconds, 30);

  // Permissions are configurable and enforced server-side, but team/settings can never leave the owner.
  const grabTeam = await staff.owner.patch('/api/staff/settings', { role_permissions: { 'team.manage': ['owner', 'manager'] } });
  expectError(grabTeam, 422, 'validation_failed');
  expectForbidden(await staff.manager.get('/api/staff/team'), 'team.manage');

  const grant = await staff.owner.patch('/api/staff/settings', { role_permissions: { 'stats.view': ['owner', 'manager', 'floor'] } });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await staff.floor.get('/api/staff/stats/orders')).status, 200, 'an owner override takes effect at once');
  expectForbidden(await staff.kitchen.get('/api/staff/stats/orders'), 'stats.view');
  const revoke = await staff.owner.patch('/api/staff/settings', { role_permissions: {} });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  expectForbidden(await staff.floor.get('/api/staff/stats/orders'), 'stats.view');
});

test('floor, cashier and kitchen cannot change menu prices, publish or pause ordering; a manager price change waits for owner review', async () => {
  const item = async (id: string) => {
    const menu = await staff.manager.get('/api/staff/menu');
    assert.equal(menu.status, 200);
    return menu.body.items.find((i: { id: string }) => i.id === id);
  };
  const wine = await item(T.items.wine);
  const draft = await item(T.items.draft);
  const dessert = await item(T.items.dessert);

  for (const role of ['floor', 'cashier', 'kitchen'] as const) {
    const c = staff[role];
    expectForbidden(await c.patch(`/api/staff/menu/items/${T.items.wine}`, { price_minor: 100, price_change_reason: 'cheaper', version: wine.version }), 'menu.edit');
    expectForbidden(await c.post('/api/staff/menu/items', { category_id: T.categories.grill, name_en: 'Sneaky dish', pricing_type: 'fixed', price_minor: 100 }), 'menu.edit');
    expectForbidden(await c.post(`/api/staff/menu/items/${T.items.draft}/status`, { status: 'published', version: draft.version }), 'menu.publish');
    expectForbidden(await c.post(`/api/staff/menu/items/${T.items.wine}/review`, { review_status: 'verified', version: wine.version }), 'menu.review');
    expectForbidden(await c.patch('/api/staff/ordering', { enabled: false, paused_message_th: 'พัก', paused_message_en: 'Paused' }), 'ordering.pause');
  }
  // A category pause needs ordering.pause as well (the domain checks it per field).
  const catalog = await staff.floor.get('/api/staff/menu');
  const grill = catalog.body.categories.find((c: { id: string }) => c.id === T.categories.grill);
  expectForbidden(await staff.floor.patch(`/api/staff/menu/categories/${T.categories.grill}`, { ordering_paused: true, version: grill.version }), 'ordering.pause');
  // Sold out is a kitchen control, not a floor or cashier one.
  expectForbidden(await staff.floor.post(`/api/staff/menu/items/${T.items.dessert}/availability`, { sold_out: true }), 'menu.availability');
  expectForbidden(await staff.cashier.post(`/api/staff/menu/items/${T.items.dessert}/availability`, { sold_out: true }), 'menu.availability');
  const soldOut = await staff.kitchen.post(`/api/staff/menu/items/${T.items.dessert}/availability`, { sold_out: true, version: dessert.version });
  assert.equal(soldOut.status, 200, JSON.stringify(soldOut.body));
  assert.equal(soldOut.body.sold_out, true);
  assert.equal((await staff.kitchen.post(`/api/staff/menu/items/${T.items.dessert}/availability`, { sold_out: false })).status, 200);

  const rows = () => srv.sql<{ id: string; price_minor: number; status: string; review_status: string }>(
    'SELECT id, price_minor, status, review_status FROM menu_items WHERE id IN (?, ?) ORDER BY id', [T.items.draft, T.items.wine]).map((r) => ({ ...r }));
  assert.deepEqual(rows(), [
    { id: T.items.draft, price_minor: 10000, status: 'draft', review_status: 'unverified' },
    { id: T.items.wine, price_minor: 25000, status: 'published', review_status: 'verified' },
  ]);
  assert.equal(srv.sql(`SELECT value FROM settings WHERE key = 'ordering'`).length, 0, 'ordering was never paused');
  assert.equal(srv.sql(`SELECT ordering_paused FROM menu_categories WHERE id = ?`, [T.categories.grill])[0].ordering_paused, 0);

  // Manager: a price change on a published item needs a reason and sends it back to the owner.
  expectError(await staff.manager.patch(`/api/staff/menu/items/${T.items.wine}`, { price_minor: 26000, version: wine.version }), 422, 'validation_failed');
  const repriced = await staff.manager.patch(`/api/staff/menu/items/${T.items.wine}`, { price_minor: 26000, price_change_reason: 'Supplier price rise', version: wine.version });
  assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
  assert.equal(repriced.body.review_status, 'needs_review');
  const publicWine = async () => (await srv.client().get('/api/public/menu')).body.items.find((i: { id: string }) => i.id === T.items.wine);
  assert.equal((await publicWine()).orderable, false, 'live mode never sells an unapproved price');
  expectForbidden(await staff.manager.post(`/api/staff/menu/items/${T.items.wine}/review`, { review_status: 'verified', version: repriced.body.version }), 'menu.review');
  const approved = await staff.owner.post(`/api/staff/menu/items/${T.items.wine}/review`, { review_status: 'verified', version: repriced.body.version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const nowPublic = await publicWine();
  assert.equal(nowPublic.orderable, true);
  assert.equal(nowPublic.price_minor, 26000);

  // Manager publishing: authorised, but the owner's verification is still a blocker in live mode.
  const blocked = await staff.manager.post(`/api/staff/menu/items/${T.items.draft}/status`, { status: 'published', version: draft.version });
  expectError(blocked, 409, 'publish_blocked');
  assert.ok(blocked.body.error.details.blockers.includes('not_verified'));
  const verified = await staff.owner.post(`/api/staff/menu/items/${T.items.draft}/review`, { review_status: 'verified', version: draft.version });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const published = await staff.manager.post(`/api/staff/menu/items/${T.items.draft}/status`, { status: 'published', version: verified.body.version });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.status, 'published');
});

test('cancelling needs orders.cancel_unstarted for accepted lines and orders.cancel_started once preparation began; cashier can do neither', async () => {
  const { guest } = await seat();
  const g = await guest();
  const order = await submit(g, [soup(), latteHot(), steakRare()], 15000 + 8000 + 59000);
  const [soupLine, latteLine, steakLine] = order.lines as Array<{ id: string; version: number }>;
  assert.equal((await transition(staff.kitchen, order.lines.map(ref), 'accepted')).status, 200);

  // Accepted, not started: floor may cancel; cashier and kitchen may not.
  const reason = 'Guest changed their mind';
  expectForbidden(await transition(staff.cashier, lines(soupLine.id).map(ref), 'cancelled', reason), 'orders.cancel_unstarted');
  expectForbidden(await transition(staff.kitchen, lines(soupLine.id).map(ref), 'cancelled', reason), 'orders.cancel_unstarted');

  assert.equal((await transition(staff.kitchen, lines(latteLine.id, steakLine.id).map(ref), 'preparing')).status, 200);

  // One request mixing an unstarted and a started line is refused as a whole.
  const mixed = await transition(staff.floor, lines(soupLine.id, steakLine.id).map(ref), 'cancelled', reason);
  expectForbidden(mixed, 'orders.cancel_started');
  assert.deepEqual(lines(soupLine.id, steakLine.id).map((l) => l.status), ['accepted', 'preparing']);

  const floorCancel = await transition(staff.floor, lines(soupLine.id).map(ref), 'cancelled', reason);
  assert.equal(floorCancel.status, 200, JSON.stringify(floorCancel.body));
  assert.equal(lines(soupLine.id)[0].status, 'cancelled');
  assert.equal(lines(soupLine.id)[0].status_reason, reason);

  // Preparing: only managers (and the owner).
  for (const role of ['floor', 'cashier', 'kitchen'] as const) {
    expectForbidden(await transition(staff[role], lines(steakLine.id).map(ref), 'cancelled', 'Burnt, remaking'), 'orders.cancel_started');
  }
  assert.equal(lines(steakLine.id)[0].status, 'preparing');
  // Finish order is not a way around it: resolving started dishes as "cancel" needs the same permission.
  const finishBody = () => ({
    version: srv.sql('SELECT version FROM orders WHERE id = ?', [order.id])[0].version,
    resolutions: lines(latteLine.id, steakLine.id).map((l) => ({ line_id: l.id, version: l.version, action: 'cancel', reason: 'Table left' })),
  });
  for (const role of ['floor', 'cashier'] as const) {
    expectForbidden(await staff[role].post(`/api/staff/orders/${order.id}/finish`, finishBody()), 'orders.cancel_started');
  }
  expectForbidden(await staff.kitchen.post(`/api/staff/orders/${order.id}/finish`, finishBody()), 'orders.serve');
  assert.deepEqual(lines(latteLine.id, steakLine.id).map((l) => l.status), ['preparing', 'preparing']);
  assert.equal(srv.sql('SELECT finished_at FROM orders WHERE id = ?', [order.id])[0].finished_at, null);
  const managerCancel = await transition(staff.manager, lines(steakLine.id).map(ref), 'cancelled', 'Burnt, remaking');
  assert.equal(managerCancel.status, 200, JSON.stringify(managerCancel.body));
  assert.equal(lines(steakLine.id)[0].status, 'cancelled');

  // Moving a line backwards is a manager correction.
  for (const role of ['floor', 'cashier', 'kitchen'] as const) {
    expectForbidden(await transition(staff[role], lines(latteLine.id).map(ref), 'accepted', 'Wrong ticket'), 'orders.correct');
  }
  const corrected = await transition(staff.manager, lines(latteLine.id).map(ref), 'accepted', 'Wrong ticket');
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(lines(latteLine.id)[0].status, 'accepted');

  // History: who cancelled what, and why.
  const cancels = srv.sql<{ line_id: string; actor_id: string; reason: string }>(
    `SELECT line_id, actor_id, reason FROM line_events WHERE order_id = ? AND kind = 'cancel' ORDER BY id`, [order.id]).map((r) => ({ ...r }));
  assert.deepEqual(cancels, [
    { line_id: soupLine.id, actor_id: 'stf_floor', reason },
    { line_id: steakLine.id, actor_id: 'stf_manager', reason: 'Burnt, remaking' },
  ]);
  const guestView = await g.get('/api/guest/orders');
  const seen = guestView.body.orders[0].lines.find((l: { id: string }) => l.id === soupLine.id);
  assert.equal(seen.status, 'cancelled');
  assert.equal(seen.status_reason, reason, 'guests see why a dish was cancelled');
});

test('reject, cancel, correction and a cancel resolution in Finish order all require a reason', async () => {
  const { guest } = await seat();
  const g = await guest();
  const order = await submit(g, [soup(), latteHot(), soup(3)], 15000 + 8000 + 45000);
  const [a, b, c] = order.lines as Array<{ id: string; version: number }>;
  const eventsFor = (id: string) => srv.sql('SELECT count(*) n FROM line_events WHERE line_id = ?', [id])[0].n;

  for (const missing of [undefined, null, '   ', 'no']) {
    expectError(await transition(staff.manager, lines(a.id).map(ref), 'rejected', missing), 422, 'validation_failed');
  }
  assert.equal(lines(a.id)[0].status, 'submitted');
  assert.equal(eventsFor(a.id), 1);
  const rejected = await transition(staff.manager, lines(a.id).map(ref), 'rejected', 'Kitchen closed early');
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

  assert.equal((await transition(staff.manager, lines(b.id).map(ref), 'accepted')).status, 200);
  expectError(await transition(staff.manager, lines(b.id).map(ref), 'cancelled'), 422, 'validation_failed');
  expectError(await transition(staff.manager, lines(b.id).map(ref), 'submitted'), 422, 'validation_failed');
  assert.equal(lines(b.id)[0].status, 'accepted');
  const back = await transition(staff.manager, lines(b.id).map(ref), 'submitted', 'Accepted by mistake');
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(lines(b.id)[0].status, 'submitted');

  // Finish order: resolving an unstarted dish as "cancel" is a rejection and needs a reason too.
  const orderVersion = () => srv.sql('SELECT version FROM orders WHERE id = ?', [order.id])[0].version;
  const resolutions = (reason?: string) => lines(b.id, c.id).map((l) => ({ line_id: l.id, version: l.version, action: 'cancel', ...(reason ? { reason } : {}) }));
  expectError(await staff.manager.post(`/api/staff/orders/${order.id}/finish`, { version: orderVersion(), resolutions: resolutions() }), 422, 'validation_failed');
  assert.deepEqual(lines(b.id, c.id).map((l) => l.status), ['submitted', 'submitted']);
  const finished = await staff.manager.post(`/api/staff/orders/${order.id}/finish`, { version: orderVersion(), resolutions: resolutions('Table left') });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(lines(a.id, b.id, c.id).map((l) => l.status), ['rejected', 'rejected', 'rejected']);
  assert.ok(finished.body.finished_at);
});

test("kitchen's staff event stream hides payment and bill topics that the cashier receives", async () => {
  const cursor = srv.sql<{ id: number | null }>('SELECT MAX(id) id FROM events')[0].id ?? 0;
  const { visit, guest } = await seat();
  const g = await guest();
  const order = await submit(g, [soup()], 15000);
  assert.equal((await transition(staff.kitchen, order.lines.map(ref), 'accepted')).status, 200);
  const started = await staff.cashier.post(`/api/staff/visits/${visit.id}/billing/start`, { version: visitVersion(visit.id) });
  assert.equal(started.status, 200);
  const fin = await staff.cashier.post(`/api/staff/visits/${visit.id}/bill/finalize`, { bill_version: started.body.bill_version, expected_total_minor: 15000 });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const paid = await staff.cashier.post(`/api/staff/visits/${visit.id}/payments`, {
    revision_id: fin.body.current_revision.id, method: 'cash', amount_minor: 15000, reference: 'CASH-DRAWER-2', idempotency_key: key('pay'),
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const written = srv.sql<{ topic: string }>('SELECT topic FROM events WHERE id > ? AND visit_id = ?', [cursor, visit.id]).map((e) => e.topic);
  assert.ok(written.includes('payment.recorded') && written.includes('bill.updated'), `outbox: ${written.join(',')}`);

  const hidden = (topic: string) => topic.startsWith('payment.') || topic.startsWith('bill.');
  const kitchenPoll = await staff.kitchen.get(`/api/staff/events/poll?since=${cursor}`);
  assert.equal(kitchenPoll.status, 200);
  assert.equal(kitchenPoll.body.resync, false);
  const kitchenTopics = (kitchenPoll.body.events as Array<{ topic: string }>).map((e) => e.topic);
  assert.ok(kitchenTopics.includes('order.created') && kitchenTopics.includes('line.updated'), kitchenTopics.join(','));
  assert.deepEqual(kitchenTopics.filter(hidden), []);

  const cashierPoll = await staff.cashier.get(`/api/staff/events/poll?since=${cursor}`);
  const cashierTopics = (cashierPoll.body.events as Array<{ topic: string }>).map((e) => e.topic);
  assert.ok(cashierTopics.includes('payment.recorded') && cashierTopics.includes('bill.updated'), cashierTopics.join(','));

  // The live SSE stream applies the same filter (replayed from Last-Event-ID).
  const lastVisible = Math.max(...(kitchenPoll.body.events as Array<{ id: number }>).map((e) => e.id));
  const streamed = await readStream(staff.kitchen, '/api/staff/events', cursor, lastVisible);
  assert.ok(streamed.length > 0);
  assert.deepEqual(streamed.map((e) => e.topic), kitchenTopics);
});

test('a long run of events the kitchen may not see never stalls its stream', async () => {
  const cursor = srv.sql<{ id: number | null }>('SELECT MAX(id) id FROM events')[0].id ?? 0;
  // 200 owner changes to a staff-only setting: 200 consecutive `settings.updated`
  // events, all hidden from the kitchen (as a long run of bill./payment. events would be).
  for (let i = 0; i < 200; i++) {
    const r = await staff.owner.patch('/api/staff/settings', { notifications: { sound_default: i % 2 === 0 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const burst = srv.sql<{ topic: string }>('SELECT DISTINCT topic FROM events WHERE id > ?', [cursor]).map((r) => r.topic);
  assert.deepEqual(burst, ['settings.updated']);
  const { guest } = await seat();
  const order = await submit(await guest(), [soup()], 15000);
  const orderEvent = srv.sql<{ id: number }>(`SELECT id FROM events WHERE topic = 'order.created' AND entity_id = ?`, [order.id])[0].id;

  // Polling: the kitchen either receives the new order or is told to resync; its cursor moves on.
  const poll = await staff.kitchen.get(`/api/staff/events/poll?since=${cursor}`);
  assert.equal(poll.status, 200);
  const delivered = (poll.body.events as Array<{ entity: { id: string } }>).some((e) => e.entity.id === order.id);
  assert.ok(delivered || poll.body.resync === true, `kitchen poll is stuck: ${JSON.stringify(poll.body)}`);
  assert.ok(poll.body.cursor > cursor, 'the cursor must move past events the kitchen may not see');
  const next = await staff.kitchen.get(`/api/staff/events/poll?since=${poll.body.cursor}`);
  assert.equal(next.body.resync, false);

  // Streaming from the same point (a reconnect with Last-Event-ID) is not stuck either.
  const streamed = await readStream(staff.kitchen, '/api/staff/events', cursor, orderEvent);
  assert.ok(streamed.some((e) => e.topic === 'resync' || e.id >= orderEvent), JSON.stringify(streamed));
});

test('signed-out browsers and guest cookies never reach staff endpoints', async () => {
  const { visit, guest } = await seat();
  const g = await guest();
  const anonymous = srv.client();
  for (const c of [anonymous, g]) {
    expectError(await c.get('/api/staff/orders'), 401, 'auth_required');
    expectError(await c.get('/api/staff/service'), 401, 'auth_required');
    expectError(await c.post('/api/staff/orders/recover', {
      visit_id: visit.id, manual_reference: 'P-ANON', original_time: new Date().toISOString(), lines: [soup()], already: 'served', reason: 'offline',
    }), 401, 'auth_required');
  }
  const shortLived = await srv.staff('cashier');
  // Keep the old cookie (a copied/stolen one): after sign-out the server refuses it.
  const stale = shortLived.clone();
  assert.equal((await shortLived.post('/api/staff/auth/logout')).status, 200);
  expectError(await stale.get('/api/staff/payments'), 401, 'auth_required');
  assert.equal(srv.sql('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id])[0].n, 0);
});

// ------------------------------------------------------------------ SSE reader
interface StreamEvent { id: number; topic: string }

/** Read `change` events from an SSE endpoint, replaying after `since`, until `untilId` arrives. */
async function readStream(c: Client, path: string, since: number, untilId: number, timeoutMs = 5000): Promise<StreamEvent[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events: StreamEvent[] = [];
  try {
    const res = await fetch(srv.url + path, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(since), Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const field = (name: string) => block.split('\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim();
        if (field('event') === 'resync') {
          // "Replay window exceeded, refetch everything": the client recovers from here.
          events.push({ id: Number(field('id')), topic: 'resync' });
          return events;
        }
        if (field('event') !== 'change') continue;
        const data = JSON.parse(field('data') ?? '{}') as StreamEvent;
        events.push({ id: data.id, topic: data.topic });
        if (data.id >= untilId) return events;
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
    assert.fail(`stream did not deliver event ${untilId} within ${timeoutMs} ms (got ${events.map((e) => e.id).join(',')})`);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return events;
}
