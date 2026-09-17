// Round-2 server work (docs/DECISIONS.md D-S8-20 .. D-S8-30): the fields and
// endpoints the staff and guest screens already code against.
//
//   feedback after checkout and the staff feedback list, the PIN length on a QR
//   resolve, the owner's alert-sound default, "cuts to weigh" and dish counts,
//   alcohol / staff-confirmation snapshots on order lines, weighed cuts in paper
//   recovery, the repeat-request cooldown, the settings version check, the KPI
//   filters, menu search aliases, the demo-account switch, the QR base warning
//   and the database epoch.
//
// Every test seats its own party at a table created for it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Client, key, startServer, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

let srv: TestServer;
let owner: Client;
let manager: Client;
let cashier: Client;
let floor: Client;
let kitchen: Client;

before(async () => {
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  [owner, manager, cashier, floor, kitchen] = await Promise.all(
    (['owner', 'manager', 'cashier', 'floor', 'kitchen'] as const).map((r) => srv.staff(r)),
  );
  // The repeat-request cooldown has its own test; elsewhere requests come and go in seconds.
  ok(await owner.patch('/api/staff/settings', { service_cooldown_seconds: 0 }));
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
const show = (r: HttpResult) => `${r.status} ${JSON.stringify(r.body)}`;
function ok(r: HttpResult, status = 200): any {
  assert.equal(r.status, status, show(r));
  return r.body;
}
function expectError(r: HttpResult, status: number, code: string): any {
  assert.equal(r.status, status, show(r));
  assert.equal(r.body?.error?.code, code, show(r));
  return r.body.error.details;
}
function rows<R = any>(sql: string, params: unknown[] = []): R[] {
  return srv.sql(sql, params).map((r) => ({ ...r })) as R[];
}
const count = (sql: string, params: unknown[] = []) => Number(rows<{ n: number }>(sql, params)[0].n);
const bkkDate = (ms = Date.now()) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);

let ipSeq = 0;
const nextIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
/** A new device with its own forwarded address. */
function device(ip = nextIp()): Client & { ip: string } {
  const c = srv.client() as Client & { ip: string };
  c.ip = ip;
  const request = c.request.bind(c);
  c.request = (method, path, body, headers = {}) => request(method, path, body, { 'X-Forwarded-For': ip, ...headers });
  return c;
}

let tableSeq = 0;
async function newTable(): Promise<{ id: string; label: string; token: string }> {
  const label = `R${++tableSeq}`;
  const t = ok(await manager.post('/api/staff/tables', { label }), 201);
  const [{ token }] = rows<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [t.id]);
  return { id: t.id, label, token };
}

async function seat() {
  const table = await newTable();
  const visit = ok(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
  const guest = device();
  ok(await guest.post('/api/public/qr/join', { token: table.token, pin: visit.join_pin }), 201);
  return { table, visit, guest };
}

const SOUP = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] }); // 150 THB
const WINE = (quantity = 1) => ({ item_id: T.items.wine, quantity, modifiers: [] }); // 250 THB, alcohol

async function order(guest: Client, lines: unknown[], subtotal: number): Promise<any> {
  return ok(await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: subtotal }), 201).order;
}

async function move(who: Client, visitId: string, from: string, to: string, reason?: string) {
  const lines = rows<{ id: string; version: number }>('SELECT id, version FROM order_lines WHERE visit_id = ? AND status = ?', [visitId, from]);
  if (lines.length) ok(await who.post('/api/staff/orders/transition', { lines, to, reason }));
}
async function serveAll(visitId: string) {
  await move(kitchen, visitId, 'submitted', 'accepted');
  await move(kitchen, visitId, 'accepted', 'preparing');
  await move(kitchen, visitId, 'preparing', 'ready');
  await move(floor, visitId, 'ready', 'served');
}

const bill = async (visitId: string, who: Client = manager) => ok(await who.get(`/api/staff/visits/${visitId}/bill`));

/** Serve, finalize, pay and check out, so the visit is closed like a real one. */
async function checkout(visitId: string): Promise<void> {
  await serveAll(visitId);
  const b0 = await bill(visitId);
  ok(await floor.post(`/api/staff/visits/${visitId}/billing/start`, { version: b0.visit_version }));
  const b1 = await bill(visitId);
  const fin = ok(await cashier.post(`/api/staff/visits/${visitId}/bill/finalize`, { bill_version: b1.bill_version, expected_total_minor: b1.total_minor }));
  const rev = fin.current_revision;
  if (rev.total_minor > 0) {
    ok(await cashier.post(`/api/staff/visits/${visitId}/payments`, {
      revision_id: rev.id, method: 'cash', amount_minor: rev.total_minor, idempotency_key: key('pay'),
    }));
  }
  ok(await cashier.post(`/api/staff/visits/${visitId}/checkout`, { idempotency_key: key('co') }));
}

const overview = async (who: Client = floor) => ok(await who.get('/api/staff/overview'));
const tileOf = async (tableId: string) => ok(await floor.get('/api/staff/tables')).tables.find((t: { id: string }) => t.id === tableId);

// ================================================================== guest feedback
test('feedback outlives checkout for half an hour, once per session; every other guest route stays closed (D-S8-22)', async () => {
  const { visit, guest } = await seat();
  await order(guest, [SOUP()], 15_000);

  // While the table is open the form is offered with no deadline.
  assert.deepEqual(ok(await guest.get('/api/guest/feedback/eligibility')), { eligible: true, submitted: false, until: null });

  await checkout(visit.id);
  const after = ok(await guest.get('/api/guest/feedback/eligibility'));
  assert.equal(after.eligible, true, 'the party can still say how it was');
  assert.equal(after.submitted, false);
  const closedAt = rows<{ closed_at: string }>('SELECT closed_at FROM visits WHERE id = ?', [visit.id])[0].closed_at;
  assert.equal(after.until, new Date(new Date(closedAt).getTime() + 30 * 60_000).toISOString());

  // Nothing else: the visit is over.
  expectError(await guest.get('/api/guest/session'), 410, 'visit_closed');
  expectError(await guest.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }), 410, 'visit_closed');
  assert.ok(guest.cookies.has('rg_guest'), 'the cookie is kept for the feedback window');

  ok(await guest.post('/api/guest/feedback', { rating: 5, comment: 'The ribs were excellent', idempotency_key: key('fb') }), 201);
  assert.equal(count('SELECT COUNT(*) AS n FROM feedback WHERE visit_id = ?', [visit.id]), 1);
  assert.deepEqual(ok(await guest.get('/api/guest/feedback/eligibility')), {
    eligible: false, submitted: true, until: after.until,
  });
  // One entry per guest session: a second try is refused, a retry of the same key is not a second entry.
  expectError(await guest.post('/api/guest/feedback', { rating: 1, comment: 'Changed my mind', idempotency_key: key('fb') }), 409, 'already_done');
  assert.equal(count('SELECT COUNT(*) AS n FROM feedback WHERE visit_id = ?', [visit.id]), 1);

  // Past the window the session is finished for good.
  const late = await seat();
  await order(late.guest, [SOUP()], 15_000);
  await checkout(late.visit.id);
  srv.exec('UPDATE visits SET closed_at = ? WHERE id = ?', [new Date(Date.now() - 31 * 60_000).toISOString(), late.visit.id]);
  const lateTab = late.guest.clone();
  expectError(await lateTab.get('/api/guest/feedback/eligibility'), 410, 'visit_closed');
  assert.equal(lateTab.cookies.has('rg_guest'), false, 'the cookie is cleared once feedback closes');
  expectError(await late.guest.post('/api/guest/feedback', { rating: 3, idempotency_key: key('fb') }), 410, 'visit_closed');
  assert.equal(count('SELECT COUNT(*) AS n FROM feedback WHERE visit_id = ?', [late.visit.id]), 0);
});

test('a phone staff revoked before checkout gets no feedback window (D-S8-22)', async () => {
  const { visit, guest } = await seat();
  await order(guest, [SOUP()], 15_000);
  const v = ok(await floor.get(`/api/staff/visits/${visit.id}`));
  ok(await floor.post(`/api/staff/visits/${visit.id}/revoke-guests`, { version: v.version, reason: 'PIN was shared outside the table' }));
  const revoked = guest.clone();
  expectError(await revoked.get('/api/guest/feedback/eligibility'), 401, 'visit_access_revoked');
  assert.equal(revoked.cookies.has('rg_guest'), false);
  await checkout(visit.id);
  expectError(await guest.clone().post('/api/guest/feedback', { rating: 5, idempotency_key: key('fb') }), 410, 'visit_closed');
  assert.equal(count('SELECT COUNT(*) AS n FROM feedback WHERE visit_id = ?', [visit.id]), 0, 'a revoked phone gets no window when the visit later closes');
});

test('the Reports panel reads guest feedback for a range, and only with reports.view (D-S8-22)', async () => {
  const today = bkkDate();
  const { visit, guest } = await seat();
  await order(guest, [SOUP()], 15_000);
  ok(await guest.post('/api/guest/feedback', { rating: 4, comment: 'Warm welcome', idempotency_key: key('fb') }), 201);
  const second = await seat();
  await order(second.guest, [SOUP()], 15_000);
  ok(await second.guest.post('/api/guest/feedback', { rating: 2, idempotency_key: key('fb') }), 201);

  const list = ok(await manager.get(`/api/staff/feedback?from=${today}&to=${today}`));
  assert.equal(list.from, today);
  assert.ok(list.count >= 2);
  assert.equal(list.rated, list.count);
  assert.ok(typeof list.average_rating === 'number');
  assert.equal(list.items.length, list.count);
  const mine = list.items.find((i: { comment: string | null }) => i.comment === 'Warm welcome');
  assert.ok(mine, 'the newest entries are listed');
  assert.equal(mine.table_label, visit.table.label, 'the table the party sat at');
  assert.equal(mine.business_date, today);
  assert.equal(list.distribution.find((d: { rating: number }) => d.rating === 4).count >= 1, true);
  assert.equal(list.with_comment >= 1, true);
  assert.ok(list.generated_at);
  // Newest first.
  const times = list.items.map((i: { submitted_at: string }) => i.submitted_at);
  assert.deepEqual(times, [...times].sort().reverse());

  // Demo data is excluded unless asked for.
  const demoSession = `gst_demo_${key('g')}`.slice(0, 40);
  srv.exec(`INSERT INTO guest_sessions (id, visit_id, token_hash, guest_no, created_at, last_seen_at)
            VALUES (?, ?, ?, 9, ?, ?)`, [demoSession, second.visit.id, `hash_${demoSession}`, new Date().toISOString(), new Date().toISOString()]);
  srv.exec(
    `INSERT INTO feedback (id, visit_id, guest_session_id, rating, comment, idempotency_key, created_at, business_date, is_fixture)
     VALUES (?, ?, ?, 1, 'demo only', ?, ?, ?, 1)`,
    [`fbk_fx_${key('f')}`.slice(0, 40), second.visit.id, demoSession, key('fx'), new Date().toISOString(), today],
  );
  const real = ok(await manager.get(`/api/staff/feedback?from=${today}&to=${today}`));
  const withDemo = ok(await manager.get(`/api/staff/feedback?from=${today}&to=${today}&include_fixture=1`));
  assert.equal(withDemo.count, real.count + 1);
  assert.ok(!real.items.some((i: { comment: string }) => i.comment === 'demo only'));

  // Permissions and input.
  expectError(await kitchen.get(`/api/staff/feedback?from=${today}&to=${today}`), 403, 'forbidden');
  expectError(await cashier.get(`/api/staff/feedback?from=${today}&to=${today}`), 403, 'forbidden');
  expectError(await manager.get('/api/staff/feedback'), 422, 'validation_failed');
  expectError(await manager.get(`/api/staff/feedback?from=${today}&to=2020-01-01`), 422, 'validation_failed');
  expectError(await manager.get('/api/staff/feedback?from=2020-01-01&to=2026-12-31'), 422, 'validation_failed');
  // Feedback is never pushed on the live stream.
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE topic LIKE 'feedback%'`), 0);
});

// ================================================================== join PIN length
test('a QR resolve says how many digits THIS visit\'s PIN has (D-S8-24)', async () => {
  ok(await owner.patch('/api/staff/settings', { join: { pin_digits: 6 } }));
  let table: Awaited<ReturnType<typeof newTable>>;
  let visit: any;
  try {
    table = await newTable();
    visit = ok(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
  } finally {
    ok(await owner.patch('/api/staff/settings', { join: { pin_digits: 4 } }));
  }
  assert.equal(visit.join_pin.length, 6);
  const scan = ok(await device().post('/api/public/qr/resolve', { token: table!.token }));
  assert.equal(scan.pin_required, true);
  assert.equal(scan.pin_digits, 6, 'the visit keeps the length it was opened with, not the current setting');
  // A six-digit code joins; four digits of it do not.
  const guest = device();
  expectError(await guest.post('/api/public/qr/join', { token: table!.token, pin: visit.join_pin.slice(0, 4) }), 401, 'pin_invalid');
  ok(await guest.post('/api/public/qr/join', { token: table!.token, pin: visit.join_pin }), 201);
  // Once this browser is a member no PIN is asked for, so no length is sent.
  const rescan = ok(await guest.post('/api/public/qr/resolve', { token: table!.token }));
  assert.deepEqual([rescan.already_joined, rescan.pin_required, rescan.pin_digits], [true, false, null]);
});

// ================================================================== staff screens
test('/auth/me carries the owner\'s alert-sound default (D-FX-OPS-01)', async () => {
  ok(await owner.patch('/api/staff/settings', { notifications: { sound_default: true } }));
  const me = ok(await floor.get('/api/staff/auth/me'));
  assert.equal(me.sound_default, true);
  assert.equal(me.notifications.sound_default, true);
  ok(await owner.patch('/api/staff/settings', { notifications: { sound_default: false } }));
  assert.equal(ok(await floor.get('/api/staff/auth/me')).sound_default, false);
});

test('the overview counts cuts waiting for the scale and ready food in dishes (D-S8-20)', async () => {
  const { table, visit, guest } = await seat();
  const before = await overview();
  await order(guest, [SOUP(3)], 45_000);
  await move(kitchen, visit.id, 'submitted', 'accepted');
  await move(kitchen, visit.id, 'accepted', 'preparing');
  await move(kitchen, visit.id, 'preparing', 'ready');

  const withReady = await overview();
  assert.equal(withReady.ready_lines, before.ready_lines + 1, 'one line');
  assert.equal(withReady.ready_dishes, before.ready_dishes + 3, 'three dishes, like the ticket button');
  const tile = await tileOf(table.id);
  assert.deepEqual([tile.visit.ready_lines, tile.visit.ready_dishes], [1, 3]);
  assert.deepEqual([tile.visit.unresolved_lines, tile.visit.unresolved_dishes], [1, 3]);

  // A cut waiting to be weighed is counted apart from one already quoted.
  const request = ok(await guest.post('/api/guest/portions', { item_id: T.items.rib, preferred_grams: 300, idempotency_key: key('por') }), 201);
  const waiting = await overview();
  assert.equal(waiting.portions_to_weigh, before.portions_to_weigh + 1);
  assert.equal(waiting.open_portion_requests, before.open_portion_requests + 1);
  ok(await floor.post(`/api/staff/portions/${request.id}/quote`, { grams: 320, version: request.version }));
  const quoted = await overview();
  assert.equal(quoted.portions_to_weigh, before.portions_to_weigh, 'a quoted cut is no longer waiting for the scale');
  assert.equal(quoted.open_portion_requests, before.open_portion_requests + 1, 'but it is still open');
});

test('the table grid says whether printed QR cards would open on a phone (D-S8-09)', async () => {
  const tables = ok(await floor.get('/api/staff/tables'));
  assert.equal(typeof tables.qr_base_url, 'string');
  // The test server's PUBLIC_BASE_URL is 127.0.0.1: cards printed from it open on nothing else.
  assert.equal(tables.qr_base_is_local, true);
  const cards = ok(await floor.get('/api/staff/tables/qr-cards'));
  assert.equal(cards.qr_base_is_local, tables.qr_base_is_local);
  assert.equal(cards.qr_base_url, tables.qr_base_url);
  // A card printed while PINs are off must not tell guests to ask for a table code.
  assert.equal(cards.pin_required, true);
});

// ================================================================== order-line snapshots
test('an order line keeps the alcohol and staff-confirmation flags it was sent with (D-S8-20)', async () => {
  const { visit, guest } = await seat();
  const placed = await order(guest, [WINE(), SOUP()], 40_000);
  const staffOrder = ok(await floor.get(`/api/staff/orders/${placed.id}`));
  const wine = staffOrder.lines.find((l: { item_id: string }) => l.item_id === T.items.wine);
  const soup = staffOrder.lines.find((l: { item_id: string }) => l.item_id === T.items.soup);
  assert.deepEqual([wine.alcohol, wine.requires_staff_confirm], [true, true]);
  assert.deepEqual([soup.alcohol, soup.requires_staff_confirm], [false, false]);
  // Guests are not told what staff must confirm; the menu already says what a dish is.
  const guestOrders = ok(await guest.get('/api/guest/orders'));
  const guestLine = guestOrders.orders[0].lines.find((l: { item_id: string }) => l.item_id === T.items.wine);
  assert.equal('alcohol' in guestLine, false);
  assert.equal('requires_staff_confirm' in guestLine, false);

  // Turning the owner's confirmation note off changes later rounds only.
  const wineItem = ok(await owner.get('/api/staff/menu')).items.find((i: { id: string }) => i.id === T.items.wine);
  ok(await owner.patch(`/api/staff/menu/items/${T.items.wine}`, { requires_staff_confirm: false, version: wineItem.version }));
  ok(await owner.patch('/api/staff/settings', { alcohol: { staff_confirmation_note: false } }));
  let later: any;
  try {
    later = await order(guest, [WINE()], 25_000);
  } finally {
    ok(await owner.patch('/api/staff/settings', { alcohol: { staff_confirmation_note: true } }));
  }
  const laterLine = ok(await floor.get(`/api/staff/orders/${later.id}`)).lines[0];
  assert.deepEqual([laterLine.alcohol, laterLine.requires_staff_confirm], [true, false]);
  // The first round still asks for the confirmation it was sent with.
  const again = ok(await floor.get(`/api/staff/orders/${placed.id}`)).lines
    .find((l: { item_id: string }) => l.item_id === T.items.wine);
  assert.equal(again.requires_staff_confirm, true);
  assert.equal(count('SELECT COUNT(*) AS n FROM order_lines WHERE visit_id = ? AND alcohol = 1', [visit.id]), 2);
});

// ================================================================== paper recovery of weighed cuts
test('a weighed cut can be recovered from paper at the approved rate (D-S8-21)', async () => {
  const { visit } = await seat();
  const reference = `PAPER-${key('ref').slice(-8)}`;
  // One ticket, one time: a replay must send exactly what the first attempt sent.
  const originalTime = new Date(Date.now() - 20 * 60_000).toISOString();
  const recover = (body: Record<string, unknown>) => manager.post('/api/staff/orders/recover', {
    visit_id: visit.id,
    manual_reference: reference,
    original_time: originalTime,
    already: 'served',
    reason: 'Tablets were offline; ticket written by hand',
    ...body,
  });

  // A weighed cut with no weight still needs a weighing quote.
  const blocked = expectError(await recover({ lines: [{ item_id: T.items.rib, quantity: 1, modifiers: [] }] }), 409, 'cart_changed');
  assert.deepEqual(blocked.quote.issues.map((i: { code: string }) => i.code), ['measured_weight_needs_quote']);

  // Grams belong to a dish sold by weight, one cut per line.
  const wrongDish = expectError(await recover({ lines: [{ ...SOUP(), measured: { grams: 250 } }] }), 422, 'validation_failed');
  assert.equal(wrongDish.issues[0].path, 'lines.0.measured');
  const wrongQty = expectError(await recover({ lines: [{ item_id: T.items.rib, quantity: 2, modifiers: [], measured: { grams: 250 } }] }), 422, 'validation_failed');
  assert.equal(wrongQty.issues[0].path, 'lines.0.quantity');

  // 250 g at 490 THB / 100 g = 1,225 THB.
  const result = ok(await recover({ lines: [{ item_id: T.items.rib, quantity: 1, modifiers: [], measured: { grams: 250 } }] }), 201);
  const line = result.order.lines[0];
  assert.deepEqual([line.measured_grams, line.quantity, line.rate_minor, line.rate_basis_grams], [250, 1, 49_000, 100]);
  assert.equal(line.line_total_minor, 122_500);
  assert.equal(line.status, 'served');
  assert.equal(result.order.subtotal_minor, 122_500);
  assert.equal(count('SELECT COUNT(*) AS n FROM order_lines WHERE visit_id = ? AND portion_quote_id IS NOT NULL', [visit.id]), 0);
  assert.equal((await bill(visit.id)).total_minor, 122_500);

  // The same ticket entered twice replays; a different weight is a conflict, not a second order.
  const replay = ok(await recover({ lines: [{ item_id: T.items.rib, quantity: 1, modifiers: [], measured: { grams: 250 } }] }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.id, result.order.id);
  expectError(await recover({ lines: [{ item_id: T.items.rib, quantity: 1, modifiers: [], measured: { grams: 400 } }] }), 409, 'conflict');
  assert.equal(count('SELECT COUNT(*) AS n FROM orders WHERE visit_id = ?', [visit.id]), 1);
});

// ================================================================== service-request cooldown
test('the same request cannot be sent again until the cooldown passes; the bill never waits (D-S8-23)', async () => {
  const { visit, guest } = await seat();
  ok(await owner.patch('/api/staff/settings', { service_cooldown_seconds: 45 }));
  try {
    const first = ok(await guest.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }), 201);
    // A repeated tap while it is open returns the same request, as before.
    assert.equal(ok(await guest.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') })).id, first.id);
    ok(await floor.post(`/api/staff/service/${first.id}/transition`, { to: 'completed', version: first.version }));

    const again = expectError(await guest.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }), 429, 'rate_limited');
    assert.equal(again.reason, 'service_cooldown');
    assert.equal(again.type, 'call_staff');
    assert.ok(again.retry_after_seconds > 0 && again.retry_after_seconds <= 45, JSON.stringify(again));
    assert.ok(again.available_at);
    assert.equal(count(`SELECT COUNT(*) AS n FROM service_requests WHERE visit_id = ? AND type = 'call_staff'`, [visit.id]), 1);

    // Another type is not held back, and asking for the bill never is.
    ok(await guest.post('/api/guest/service', { type: 'water', idempotency_key: key('svc') }), 201);
    ok(await guest.post('/api/guest/bill/request', { idempotency_key: key('bill') }));
    const billRequest = rows<{ id: string; version: number }>(
      `SELECT id, version FROM service_requests WHERE visit_id = ? AND type = 'bill'`, [visit.id])[0];
    ok(await floor.post(`/api/staff/service/${billRequest.id}/transition`, { to: 'completed', version: billRequest.version }));
    ok(await guest.post('/api/guest/bill/request', { idempotency_key: key('bill') }));

    // Once the wait has passed, the guest may call again.
    srv.exec(`UPDATE service_requests SET created_at = ? WHERE visit_id = ? AND type = 'call_staff'`,
      [new Date(Date.now() - 60_000).toISOString(), visit.id]);
    ok(await guest.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }), 201);
  } finally {
    ok(await owner.patch('/api/staff/settings', { service_cooldown_seconds: 0 }));
  }
});

// ================================================================== settings
test('a settings section refuses to save over a change it has not seen (D-S8-26)', async () => {
  const view = ok(await owner.get('/api/staff/settings'));
  const stamp = view.updated.portions ?? null;
  const patch = (body: Record<string, unknown>) => owner.patch('/api/staff/settings', body);

  // The draft started from what the server has: the save goes through.
  const saved = ok(await patch({ portions: { quote_expiry_minutes: 11 }, expected_updated: { portions: stamp } }));
  assert.equal(saved.settings.portions.quote_expiry_minutes, 11);

  // A second manager saved meanwhile: the older draft is refused with the current view.
  const stale = expectError(await patch({ portions: { quote_expiry_minutes: 20 }, expected_updated: { portions: stamp } }), 409, 'stale_version');
  assert.deepEqual(stale.keys, ['portions']);
  assert.equal(stale.current.settings.portions.quote_expiry_minutes, 11, 'the answer carries the settings as they are now');
  assert.equal(ok(await owner.get('/api/staff/settings')).settings.portions.quote_expiry_minutes, 11, 'nothing was written');

  // Sending the fresh stamp works; a key the section does not know is a validation error.
  const fresh = ok(await owner.get('/api/staff/settings')).updated.portions;
  ok(await patch({ portions: { quote_expiry_minutes: 10 }, expected_updated: { portions: fresh } }));
  expectError(await patch({ portions: { quote_expiry_minutes: 10 }, expected_updated: { nonsense: null } }), 422, 'validation_failed');
  // A key that was never saved is expected as null.
  expectError(await patch({ checkout: { after_checkout: 'available' }, expected_updated: { checkout: '2020-01-01T00:00:00.000Z' } }), 409, 'stale_version');
});

test('going live switches the demo accounts off in the same request, and only then (D-S8-27)', async () => {
  const username = `demo-owner-${tableSeq}`;
  srv.exec(
    `INSERT INTO staff_users (id, username, display_name, role, password_hash, active, is_fixture, created_at, updated_at)
     SELECT ?, ?, 'Demo owner', 'owner', password_hash, 1, 1, created_at, updated_at FROM staff_users WHERE id = 'stf_owner'`,
    [`stf_demo_${tableSeq}`, username],
  );
  const live = () => owner.patch('/api/staff/settings', { operating_mode: 'live' });
  const refused = expectError(await live(), 409, 'demo_accounts_active');
  assert.deepEqual(refused.usernames, [username]);
  assert.equal(refused.can_deactivate, true, 'a real owner is signed in, so the switch may be offered');
  assert.equal(refused.self, false);

  // The switch belongs to going live, not to a demo restaurant.
  expectError(await owner.patch('/api/staff/settings', { deactivate_demo_staff: true }), 422, 'validation_failed');
  expectError(await owner.patch('/api/staff/settings', { operating_mode: 'demo', deactivate_demo_staff: true }), 422, 'validation_failed');

  const done = ok(await owner.patch('/api/staff/settings', { operating_mode: 'live', deactivate_demo_staff: true }));
  assert.deepEqual(done.deactivated_demo_staff, [username]);
  assert.equal(done.settings.operating_mode, 'live');
  assert.equal(count('SELECT COUNT(*) AS n FROM staff_users WHERE username = ? AND active = 0', [username]), 1);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'team.deactivate' AND entity_id = ?`, [`stf_demo_${tableSeq}`]), 1);
  // Repeating the request is safe: there is nothing left to switch off.
  const repeat = ok(await live());
  assert.equal(repeat.deactivated_demo_staff, undefined);
});

// ================================================================== KPI filters
test('the operational report can be filtered by table, category and staff, and says what a filter does not narrow (D-S8-25)', async () => {
  const today = bkkDate();
  const a = await seat();
  const b = await seat();
  await order(a.guest, [SOUP(2)], 30_000);
  await order(b.guest, [WINE()], 25_000);
  await move(kitchen, a.visit.id, 'submitted', 'accepted');
  await move(floor, b.visit.id, 'submitted', 'accepted');
  const kpi = async (q = '') => ok(await owner.get(`/api/staff/stats/kpis?from=${today}&to=${today}${q}`));

  const all = await kpi();
  assert.deepEqual(all.filters, { table_id: null, category_id: null, staff_id: null });
  assert.deepEqual(all.unfiltered, []);
  const options = all.filter_options;
  assert.ok(options.tables.some((t: { id: string }) => t.id === a.table.id));
  assert.ok(options.categories.some((c: { id: string }) => c.id === T.categories.grill));
  assert.ok(options.staff.some((s: { id: string }) => s.id === 'stf_floor'), 'staff are listed without team.manage');
  assert.equal(options.staff.every((s: { name: string }) => typeof s.name === 'string'), true);

  // One table: its own rounds only, and every figure can follow a table.
  const byTable = await kpi(`&table_id=${a.table.id}`);
  assert.deepEqual(byTable.filters, { table_id: a.table.id, category_id: null, staff_id: null });
  assert.deepEqual(byTable.unfiltered, []);
  assert.equal(byTable.operational_errors.submitted_rounds, 1);
  assert.equal(byTable.totals.submitted_minor, 30_000);
  assert.equal(byTable.hourly.reduce((n: number, h: { rounds: number }) => n + h.rounds, 0), 1);

  // One category: line figures narrow, bill and visit figures cannot and say so.
  const byCategory = await kpi(`&category_id=${T.categories.coffee}`);
  assert.equal(byCategory.filters.category_id, T.categories.coffee);
  assert.equal(byCategory.totals.submitted_minor >= 25_000, true);
  assert.ok(byCategory.unfiltered.includes('qr_adoption'));
  assert.ok(byCategory.unfiltered.includes('open_bills'));
  assert.ok(byCategory.unfiltered.includes('totals'));
  assert.ok(!byCategory.unfiltered.includes('hourly'));
  assert.ok(!byCategory.unfiltered.includes('cancellations'));

  // One staff member: acceptance and request response follow the person.
  const byStaff = await kpi('&staff_id=stf_kitchen');
  assert.equal(byStaff.filters.staff_id, 'stf_kitchen');
  assert.ok(byStaff.unfiltered.includes('totals'));
  assert.ok(!byStaff.unfiltered.includes('accept'));
  assert.ok(!byStaff.unfiltered.includes('ack'));
  assert.ok(byStaff.staff_response.accept_sample >= 1);
  const byOtherStaff = await kpi('&staff_id=stf_cashier');
  assert.equal(byOtherStaff.staff_response.accept_sample, 0, 'the cashier accepted none of these rounds');

  // An unknown id is refused rather than quietly ignored.
  expectError(await owner.get(`/api/staff/stats/kpis?from=${today}&to=${today}&table_id=tbl_does_not_exist`), 422, 'validation_failed');

  // The per-round CSV takes the same scope.
  const csv = await owner.get(`/api/staff/stats/export.csv?view=orders&rows=order&period=custom&from=${today}&to=${today}&table_id=${a.table.id}`);
  assert.equal(csv.status, 200);
  const text = String(csv.body);
  assert.ok(text.includes(a.table.label), 'the filtered table is in the file');
  assert.ok(!text.includes(b.table.label), 'other tables are not');
});

// ================================================================== menu search aliases
test('search aliases reach the guest menu only once a reviewer approves them (D-S8-28)', async () => {
  const item = ok(await owner.get('/api/staff/menu')).items.find((i: { id: string }) => i.id === T.items.soup);
  const proposed = ok(await manager.patch(`/api/staff/menu/items/${T.items.soup}`, {
    aliases_th: ['ซุปทดสอบ', ' ซุปทดสอบ '], aliases_en: ['test broth', 'broth'], version: item.version,
  }));
  assert.deepEqual(proposed.aliases_th, ['ซุปทดสอบ'], 'repeats and blanks are dropped');
  assert.deepEqual(proposed.aliases_en, ['test broth', 'broth']);
  assert.equal(proposed.aliases_verified, false);
  const hiddenMenu = ok(await srv.client().get('/api/public/menu')).items.find((i: { id: string }) => i.id === T.items.soup);
  assert.equal(hiddenMenu.aliases_en, undefined, 'unreviewed aliases are not published');
  // A manager cannot publish them.
  expectError(await manager.patch(`/api/staff/menu/items/${T.items.soup}`, { aliases_verified: true, version: proposed.version }), 403, 'forbidden');

  const approved = ok(await owner.patch(`/api/staff/menu/items/${T.items.soup}`, { aliases_verified: true, version: proposed.version }));
  assert.equal(approved.aliases_verified, true);
  const menu = ok(await srv.client().get('/api/public/menu')).items.find((i: { id: string }) => i.id === T.items.soup);
  assert.deepEqual(menu.aliases_en, ['test broth', 'broth']);
  assert.deepEqual(menu.aliases_th, ['ซุปทดสอบ']);
  assert.equal(menu.name.en, 'Test Soup', 'printed names never change');

  // Editing the list again unpublishes it until it is reviewed once more.
  const edited = ok(await manager.patch(`/api/staff/menu/items/${T.items.soup}`, { aliases_en: ['test broth'], version: approved.version }));
  assert.equal(edited.aliases_verified, false);
  assert.equal(ok(await srv.client().get('/api/public/menu')).items.find((i: { id: string }) => i.id === T.items.soup).aliases_en, undefined);

  // The CSV round trip carries them, and an import leaves them unreviewed.
  const csv = String((await owner.get('/api/staff/menu/export.csv')).body);
  const header = csv.split('\r\n')[0];
  assert.ok(header.includes('aliases_th') && header.includes('aliases_en'));
  const preview = ok(await owner.post('/api/staff/menu/import/preview', {
    filename: 'aliases.csv',
    csv: 'key,category_key,name_en,pricing_type,price_baht,aliases_en\r\nimported-dish,test-grill,Imported Dish,fixed,120,cheap eats|house special\r\n',
  }));
  assert.equal(preview.summary.errors, 0, JSON.stringify(preview.errors));
  ok(await owner.post(`/api/staff/menu/import/${preview.batch_id}/apply`));
  const imported = rows<{ aliases_en: string; aliases_verified: number }>(
    'SELECT aliases_en, aliases_verified FROM menu_items WHERE key = ?', ['imported-dish'])[0];
  assert.deepEqual(JSON.parse(imported.aliases_en), ['cheap eats', 'house special']);
  assert.equal(imported.aliases_verified, 0);
  // Too many aliases in one cell is a row error, not a silent truncation.
  const bad = ok(await owner.post('/api/staff/menu/import/preview', {
    filename: 'aliases.csv',
    csv: `key,category_key,name_en,pricing_type,price_baht,aliases_en\r\nimported-dish-2,test-grill,Another,fixed,120,${Array.from({ length: 13 }, (_, i) => `a${i}`).join('|')}\r\n`,
  }));
  assert.equal(bad.summary.errors, 1);
  assert.equal(bad.errors[0].column, 'aliases_en');
});

// ================================================================== live stream identity
test('the live stream says which database it is, so a restored client starts over (D-K-01)', async () => {
  const epoch = rows<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'db_epoch'`)[0].value;
  assert.match(epoch, /^[0-9a-f]{16}$/);
  const poll = ok(await floor.get('/api/staff/events/poll?since=0'));
  assert.equal(poll.epoch, epoch);
  const res = await fetch(`${srv.url}/api/staff/events`, {
    headers: { Accept: 'text/event-stream', Cookie: [...floor.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let hello = '';
  for (let i = 0; i < 5 && !hello.includes('data:'); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    hello += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  assert.ok(hello.includes('event: hello'), hello);
  const data = JSON.parse(/data: (.*)/.exec(hello)![1]);
  assert.equal(data.epoch, epoch);
});

// ================================================================== seeding safety
test('an interrupted demo seed is detected instead of leaving half a database (D-S8-29)', async () => {
  const state = () => rows<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'seed_state'`)[0]?.value ?? null;
  assert.equal(state(), null, 'a test database is built by the fixtures, not by the demo seed');
  srv.exec(`INSERT INTO app_meta (key, value, updated_at) VALUES ('seed_state', 'running', ?)
            ON CONFLICT(key) DO UPDATE SET value = 'running'`, [new Date().toISOString()]);
  try {
    const result = await runSeed();
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /interrupted demo seed/i);
  } finally {
    srv.exec(`DELETE FROM app_meta WHERE key = 'seed_state'`);
  }
});

test('a bare server start never seeds demo accounts unless SEED_DEMO says so (D-S8-30)', async () => {
  const out = await runNode(['-e', "import('./server/config.ts').then((m) => console.log(JSON.stringify({ seed: m.config.seedDemo })))"], { SEED_DEMO: '' });
  assert.equal(JSON.parse(out.trim()).seed, false);
  const on = await runNode(['-e', "import('./server/config.ts').then((m) => console.log(JSON.stringify({ seed: m.config.seedDemo })))"], { SEED_DEMO: '1' });
  assert.equal(JSON.parse(on.trim()).seed, true);
});

function runNode(args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: srv.dbPath, NODE_ENV: 'test', SEED_HISTORY: '0', ...env },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`exited ${code}: ${out}`))));
  });
}

function runSeed(): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['server/db/seed.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: srv.dbPath, NODE_ENV: 'development', SEED_DEMO: '1', SEED_HISTORY: '0' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => res({ code: code ?? 1, out }));
  });
}
