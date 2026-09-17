// Engagement telemetry and KPIs (brief 26, 39, 43; D-S6-08..10, D-INT-03).
//
// Telemetry goes through the real POST /api/analytics/batch with the guest
// cookie a joined browser holds; figures are read back through the staff
// Engagement and KPI endpoints (as before/after deltas for today's data, as
// exact values for planted past weeks). The one exception is the midnight
// split: the server's receive time is the reporting time and a running server
// cannot be moved to midnight, so that test calls the same ingestion function
// in a child process against this test database with its documented clock
// override (IngestContext.now), then reads the result over HTTP.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { key, startServer, type Client, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

let srv: TestServer;
let owner: Client;
let manager: Client;
let floor: Client;

const bkkDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
const bkk = (date: string, hm: string) => new Date(`${date}T${hm}:00.000+07:00`).toISOString();
const today = () => bkkDate(new Date().toISOString());
const rnd = (n = 8) => randomBytes(n).toString('hex');
const sid = () => `ans_${rnd(9)}`;

// ------------------------------------------------------------------ API helpers
async function get(path: string, who: Client = owner): Promise<any> {
  const r = await who.get(path);
  assert.equal(r.status, 200, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

let tables = 0;
let addresses = 0;
/** A fresh table with an open visit (the four fixture tables are not enough for independent tests). */
async function seat(covers: number | null = 2): Promise<{ tableId: string; token: string; visit: any }> {
  const label = `E${++tables}`;
  const t = await manager.post('/api/staff/tables', { label });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const cards = await get(`/api/staff/tables/qr-cards?ids=${t.body.id}`, manager);
  const token = decodeURIComponent(cards.cards[0].url.split('/q/')[1]);
  const v = await floor.post(`/api/staff/tables/${t.body.id}/visits`, { covers, idempotency_key: key('open') });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  return { tableId: t.body.id, token, visit: v.body };
}

async function join(token: string, pin: string | null): Promise<Client> {
  // Distinct forwarded addresses keep the per-address join limit out of the way.
  const c = srv.client();
  const r = await c.request('POST', '/api/public/qr/join', { token, ...(pin ? { pin } : {}) }, { 'X-Forwarded-For': `10.8.0.${++addresses}` });
  assert.ok(r.status === 201 || r.status === 200, `join: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

let seq = 0;
function ev(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { event_id: `evt_${rnd(10)}`, type, seq: ++seq, elapsed_ms: 600_000, route: 'menu', ...extra };
}

async function batch(c: Client, sessionId: string, events: unknown[], optedOut = false) {
  return c.post('/api/analytics/batch', { session_id: sessionId, locale: 'en', opted_out: optedOut, events });
}

async function sendOk(c: Client, sessionId: string, events: unknown[], expected: { accepted: number; duplicates: number; rejected: number }, optedOut = false) {
  const r = await batch(c, sessionId, events, optedOut);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, expected);
}

async function order(g: Client, lines: unknown[], expected: number, analytics?: string | null) {
  const r = await g.post('/api/guest/orders', {
    idempotency_key: key('att'), lines, expected_subtotal_minor: expected,
    ...(analytics !== undefined ? { analytics_session_id: analytics } : {}),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.order;
}

const engagement = (q = '') => get(`/api/staff/stats/engagement?${q}`);
const itemRow = (e: any, itemId: string) => e.items.find((r: any) => r.item_id === itemId) ?? { impressions: 0, detail_opens: 0, adds: 0, submitted: 0 };
const dayRow = (e: any, date: string) => e.daily.find((d: any) => d.date === date) ?? { sessions: 0, active_ms: 0 };
const SOUP = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] });
const STEAK = { item_id: T.items.steak, quantity: 1, modifiers: [{ group_id: T.groups.doneness, option_ids: [T.options.medium] }] };
const eventsOf = (sessionId: string) => srv.sql<any>('SELECT * FROM analytics_events WHERE session_id = ? ORDER BY business_date, event_id', [sessionId]);
const sessionRow = (sessionId: string) => srv.sql<any>('SELECT * FROM analytics_sessions WHERE id = ?', [sessionId])[0];

// ------------------------------------------------------------------ planting (KPI week 2026-03-02..08)
let pseq = 0;
const uid = (p: string) => `${p}_K${(++pseq).toString().padStart(4, '0')}${rnd(3)}`;
function ins(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  srv.exec(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
}

function plantVisit(table: string, seatedAt: string, covers: number | null, closeException: string | null = null): string {
  const id = uid('vis');
  const closedAt = new Date(Date.parse(seatedAt) + 2 * 3_600_000).toISOString();
  ins('visits', {
    id, table_id: table, status: 'closed', join_pin: null, covers, charges_json: '[]', seated_at: seatedAt,
    seated_business_date: bkkDate(seatedAt), opened_by: 'stf_floor', closed_at: closedAt, closed_by: 'stf_manager',
    close_business_date: bkkDate(closedAt), close_exception: closeException, is_fixture: 0, created_at: seatedAt, updated_at: closedAt,
  });
  return id;
}

function plantGuest(visitId: string, at: string, no: number): string {
  const id = uid('gst');
  const closedAt = srv.sql<{ closed_at: string }>('SELECT closed_at FROM visits WHERE id = ?', [visitId])[0].closed_at;
  ins('guest_sessions', {
    id, visit_id: visitId, token_hash: rnd(32), guest_no: no, created_at: at, last_seen_at: at, revoked_at: closedAt, revoke_reason: 'checkout',
  });
  return id;
}

const PRODUCTS = {
  soup: { id: T.items.soup, cat: T.categories.grill, en: 'Test Soup', unit: 15000, type: 'fixed' },
  steak: { id: T.items.steak, cat: T.categories.grill, en: 'Test Striploin', unit: 59000, type: 'fixed' },
  rib300: { id: T.items.rib, cat: T.categories.grill, en: 'Test Prime Rib', unit: 147000, type: 'measured_weight' },
} as const;

function plantRound(visitId: string, table: string, at: string, source: string, product: keyof typeof PRODUCTS, round: number, guest: string | null = null): void {
  const id = uid('ord');
  const p = PRODUCTS[product];
  const t = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();
  const label = srv.sql<{ label: string }>('SELECT label FROM dining_tables WHERE id = ?', [table])[0].label;
  const manual = source === 'manual_recovery';
  ins('orders', {
    id, reference: `RG-K${pseq}`, visit_id: visitId, table_id: table, table_label: label, round_no: round, source,
    guest_session_id: guest, staff_user_id: source === 'staff' ? 'stf_floor' : manual ? 'stf_manager' : null,
    idempotency_key: uid('att'), payload_hash: 'planted', locale: 'th', submitted_at: at, business_date: bkkDate(at),
    manual_reference: manual ? uid('paper') : null, manual_original_time: manual ? at : null,
    subtotal_minor: p.unit, first_accepted_at: manual ? null : t(60), is_fixture: 0, updated_at: t(660),
  });
  ins('order_lines', {
    id: uid('lin'), order_id: id, visit_id: visitId, line_no: 1, item_id: p.id, category_id: p.cat, name_en: p.en,
    station: 'kitchen', prep_kind: 'cook', pricing_type: p.type, unit_price_minor: p.unit, modifiers_json: '[]', modifiers_minor: 0,
    quantity: 1, measured_grams: product === 'rib300' ? 300 : null, rate_minor: product === 'rib300' ? 49000 : null,
    rate_basis_grams: product === 'rib300' ? 100 : null, line_total_minor: p.unit, allergy_flag: 0, status: 'served',
    submitted_at: at, accepted_at: manual ? null : t(60), preparing_at: manual ? null : t(120), ready_at: t(600), served_at: t(660),
    prepared_before_entry: manual ? 1 : 0, is_fixture: 0, updated_at: t(660),
  });
}

function plantBill(visitId: string, total: number, finalizedAt: string, paid: number | null): void {
  const billId = uid('bil');
  const revId = uid('rev');
  const settled = paid !== null;
  ins('bills', { id: billId, visit_id: visitId, status: settled ? 'settled' : 'finalized', current_revision_id: revId, created_at: finalizedAt, updated_at: finalizedAt });
  ins('bill_revisions', {
    id: revId, bill_id: billId, visit_id: visitId, revision_no: 1, status: settled ? 'settled' : 'payable', lines_json: '[]', excluded_json: '[]',
    adjustments_json: '[]', subtotal_minor: total, adjustments_minor: 0, charges_json: '[]', total_minor: total,
    finalized_at: finalizedAt, finalized_by: 'stf_cashier', business_date: bkkDate(finalizedAt), is_fixture: 0,
  });
  if (settled) {
    const at = new Date(Date.parse(finalizedAt) + 300_000).toISOString();
    ins('payments', {
      id: uid('pay'), visit_id: visitId, bill_revision_id: revId, kind: 'settlement', method: 'cash', amount_minor: paid,
      tendered_minor: paid, change_minor: 0, status: 'confirmed', idempotency_key: uid('pk'), confirmed_by: 'stf_cashier',
      confirmed_at: at, business_date: bkkDate(at), is_fixture: 0,
    });
  }
}

function plantKpiWeek(): void {
  // VA: a guest round (joined 12:01, ordered 12:03), bill paid in full.
  const va = plantVisit('tbl_T01', bkk('2026-03-02', '12:00'), 2);
  plantRound(va, 'tbl_T01', bkk('2026-03-02', '12:03'), 'guest', 'soup', 1, plantGuest(va, bkk('2026-03-02', '12:01'), 1));
  plantBill(va, 15000, bkk('2026-03-02', '13:00'), 15000);
  // VB: staff-assisted only; finalized bill never settled (closed by a manager exception).
  const vb = plantVisit('tbl_T02', bkk('2026-03-03', '12:00'), 2, 'guest left without paying');
  plantRound(vb, 'tbl_T02', bkk('2026-03-03', '12:05'), 'staff', 'steak', 1);
  plantBill(vb, 59000, bkk('2026-03-03', '13:00'), null);
  // VC: a paper order recovered after an outage: the QR could not be used, so not eligible.
  const vc = plantVisit('tbl_T03', bkk('2026-03-04', '12:00'), 2);
  plantRound(vc, 'tbl_T03', bkk('2026-03-04', '12:05'), 'manual_recovery', 'soup', 1);
  // VD: a weighed cut confirmed by the guest's phone (customer origin).
  const vd = plantVisit('tbl_T04', bkk('2026-03-05', '19:00'), 2);
  plantRound(vd, 'tbl_T04', bkk('2026-03-05', '19:20'), 'portion_quote', 'rib300', 1, plantGuest(vd, bkk('2026-03-05', '19:02'), 1));
  // VE: staff round first, then the guest's own round (joined 19:01, ordered 19:06); paid 250 THB of 300.
  const ve = plantVisit('tbl_T01', bkk('2026-03-06', '19:00'), 3);
  plantRound(ve, 'tbl_T01', bkk('2026-03-06', '19:02'), 'staff', 'soup', 1);
  plantRound(ve, 'tbl_T01', bkk('2026-03-06', '19:06'), 'guest', 'soup', 2, plantGuest(ve, bkk('2026-03-06', '19:01'), 1));
  plantBill(ve, 30000, bkk('2026-03-06', '20:00'), 25000);
}

/** Run the real ingestion function in a child process with a clock override. */
function ingestAt(now: string, body: unknown): Promise<any> {
  const script = `
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(ROOT)};
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const { openDatabase, closeDatabase } = await load('server/db/index.ts');
    openDatabase(${JSON.stringify(srv.dbPath)});
    const { ingestAnalytics } = await load('server/domain/analytics.ts');
    let out;
    try {
      out = ingestAnalytics(${JSON.stringify(body)}, { guest: null, guestError: null, now: ${JSON.stringify(now)} });
    } finally {
      closeDatabase();
    }
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
  `;
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, env: { ...process.env, DATABASE_PATH: srv.dbPath, SEED_DEMO: '0', NODE_ENV: 'test' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`ingest child exited ${code}: ${err}`))));
  });
}

before(async () => {
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  owner = await srv.staff('owner');
  manager = await srv.staff('manager');
  floor = await srv.staff('floor');
  plantKpiWeek();
});
after(async () => { await srv?.stop(); });

// ================================================================== ingestion
test('a retried batch stores each event id once and counts the rest as duplicates', async () => {
  const { token, visit } = await seat();
  const guest = await join(token, visit.join_pin);
  const s = sid();
  const before = await engagement();
  const view = ev('menu_view');
  const seen = ev('item_impression', { item_id: T.items.steak, category_id: T.categories.grill, position: 1 });
  await sendOk(guest, s, [view, seen], { accepted: 2, duplicates: 0, rejected: 0 });
  await sendOk(guest, s, [view, seen], { accepted: 0, duplicates: 2, rejected: 0 });
  const again = ev('item_impression', { item_id: T.items.steak, category_id: T.categories.grill, position: 1 });
  await sendOk(guest, s, [again, again, seen], { accepted: 1, duplicates: 2, rejected: 0 });

  assert.equal(eventsOf(s).length, 3);
  const row = sessionRow(s);
  assert.deepEqual([row.kind, row.visit_id, row.opted_out, row.is_fixture], ['dining', visit.id, 0, 0]);
  assert.ok(row.guest_session_id);
  const after = await engagement();
  assert.equal(itemRow(after, T.items.steak).impressions - itemRow(before, T.items.steak).impressions, 2);
  assert.equal(after.coverage.measured_sessions - before.coverage.measured_sessions, 1);
  assert.equal(after.coverage.dining_sessions - before.coverage.dining_sessions, 1);
  assert.equal(after.coverage.public_sessions - before.coverage.public_sessions, 0);
});

test('an over-long active chunk is capped at 120 s and impossible or empty durations are rejected', async () => {
  const { token, visit } = await seat();
  const guest = await join(token, visit.join_pin);
  const s = sid();
  const capped = ev('active_time_chunk', { active_ms: 150_000, interaction_ref: 'ivl_cap' });
  const detail = ev('item_detail_active_time', { route: 'item', item_id: T.items.steak, active_ms: 30_000, interaction_ref: 'dop_1' });
  const r = await batch(guest, s, [
    capped,
    ev('active_time_chunk', { active_ms: 25 * 3_600_000 }), // not a foreground interval at all
    ev('active_time_chunk', { active_ms: 60_000, elapsed_ms: 10_000 }), // longer than the session has existed
    ev('active_time_chunk', { active_ms: 0 }),
    detail,
    ev('item_impression', {}), // no item
    ev('item_impression', { item_id: 'itm_does_not_exist' }),
    ev('category_view', { category_id: T.categories.grill, interaction_ref: 'note: allergy to nuts' }),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { accepted: 3, duplicates: 0, rejected: 5 });
  const rows = eventsOf(s);
  const chunkMs = rows.filter((e: any) => e.event_id === capped.event_id || e.event_id === `${capped.event_id}~2`).reduce((a: number, e: any) => a + e.active_ms, 0);
  assert.equal(chunkMs, 120_000);
  assert.equal(rows.find((e: any) => e.event_id === detail.event_id).active_ms, 30_000);
  // Free text never survives in a reference field.
  assert.equal(rows.find((e: any) => e.type === 'category_view').interaction_ref, null);

  // The envelope itself is still validated as a whole.
  const bad = await guest.post('/api/analytics/batch', { session_id: 'x', events: [] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'validation_failed');
});

test('active time comes only from active chunks, never from how long the party has been seated', async () => {
  const { token, visit } = await seat();
  // The party sat down three hours ago.
  const seatedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  srv.exec('UPDATE visits SET seated_at = ?, seated_business_date = ? WHERE id = ?', [seatedAt, bkkDate(seatedAt), visit.id]);
  const guest = await join(token, visit.join_pin);
  const s = sid();
  const d = today();
  const before = await engagement();
  const long = { elapsed_ms: 2 * 3_600_000 };
  await sendOk(guest, s, [
    ev('menu_view', long),
    ev('active_time_chunk', { ...long, active_ms: 30_000, interaction_ref: 'ivl_a' }),
    ev('active_time_chunk', { ...long, active_ms: 12_000, interaction_ref: 'ivl_b' }),
    ev('active_time_chunk', { ...long, route: 'cart', active_ms: 20_000, interaction_ref: 'ivl_c' }),
  ], { accepted: 4, duplicates: 0, rejected: 0 });
  const after = await engagement();
  assert.equal(dayRow(after, d).active_ms - dayRow(before, d).active_ms, 62_000, 'exactly the chunks sent, nothing else');
  assert.equal(after.active_menu_ms.sample - before.active_menu_ms.sample, 1);
  const menuMs = srv.sql<{ ms: number }>(`SELECT SUM(active_ms) AS ms FROM analytics_events WHERE session_id = ? AND type = 'active_time_chunk' AND route = 'menu'`, [s])[0].ms;
  assert.equal(menuMs, 42_000);
});

test('a chunk that spans Bangkok midnight is split across the two business dates and never double counted', async () => {
  const s = sid();
  const chunk = { event_id: `evt_${rnd(10)}`, type: 'active_time_chunk', seq: 1, elapsed_ms: 100_000, route: 'menu', active_ms: 90_000 };
  const body = { session_id: s, locale: 'th', opted_out: false, events: [chunk] };
  // Received 30 s after midnight on 1 March (Bangkok): 60 s belong to 28 Feb, 30 s to 1 Mar.
  const now = '2026-02-28T17:00:30.000Z';
  assert.deepEqual(await ingestAt(now, body), { accepted: 1, duplicates: 0, rejected: 0 });
  assert.deepEqual(await ingestAt(now, body), { accepted: 0, duplicates: 1, rejected: 0 });
  assert.deepEqual(
    eventsOf(s).map((e: any) => [e.event_id, e.business_date, e.active_ms]),
    [[chunk.event_id, '2026-02-28', 60_000], [`${chunk.event_id}~2`, '2026-03-01', 30_000]],
  );
  assert.equal(sessionRow(s).kind, 'public');

  const both = await engagement('from=2026-02-28&to=2026-03-01');
  assert.deepEqual(both.daily, [
    { date: '2026-02-28', sessions: 1, active_ms: 60_000 },
    { date: '2026-03-01', sessions: 1, active_ms: 30_000 },
  ]);
  assert.deepEqual(both.active_menu_ms, { median: 90_000, p90: 90_000, sample: 1 });
  assert.equal(both.coverage.measured_sessions, 1);
  assert.equal(both.coverage.public_sessions, 1);
  const march = await engagement('from=2026-03-01&to=2026-03-01');
  assert.deepEqual(march.active_menu_ms, { median: 30_000, p90: 30_000, sample: 1 });
});

test('an opted-out browser stores no events, its rounds stay unattributed, and the latest preference wins', async () => {
  const { token, visit } = await seat();
  const guest = await join(token, visit.join_pin);
  const s = sid();
  const before = await engagement();
  await sendOk(guest, s, [ev('session_end'), ev('menu_view')], { accepted: 0, duplicates: 0, rejected: 2 }, true);
  assert.equal(eventsOf(s).length, 0);
  assert.equal(sessionRow(s).opted_out, 1);
  await order(guest, [SOUP()], 15000, s);
  const after = await engagement();
  assert.equal(after.coverage.opted_out_sessions - before.coverage.opted_out_sessions, 1);
  assert.equal(after.coverage.measured_sessions - before.coverage.measured_sessions, 0);
  assert.equal(after.funnel.attributed_orders - before.funnel.attributed_orders, 0);
  assert.equal(after.funnel.unattributed_orders - before.funnel.unattributed_orders, 1);

  // Another browser opts out and then back in: only what it sends afterwards is kept.
  const other = await join(token, visit.join_pin);
  const s2 = sid();
  await sendOk(other, s2, [ev('menu_view')], { accepted: 0, duplicates: 0, rejected: 1 }, true);
  await sendOk(other, s2, [ev('menu_view')], { accepted: 1, duplicates: 0, rejected: 0 });
  assert.equal(sessionRow(s2).opted_out, 0);
  assert.equal(eventsOf(s2).length, 1);
});

test('a browser without a table cookie is a public session and never enters the dining funnel', async () => {
  const browser = srv.client();
  const s = sid();
  const before = await engagement();
  await sendOk(browser, s, [
    ev('menu_view'),
    ev('category_view', { category_id: T.categories.grill }),
    ev('scroll_depth', { depth: 50, layout_version: 'menu-v1:ps' }),
    ev('item_impression', { item_id: T.items.soup, category_id: T.categories.grill }),
  ], { accepted: 4, duplicates: 0, rejected: 0 });
  const row = sessionRow(s);
  assert.deepEqual([row.kind, row.visit_id, row.guest_session_id], ['public', null, null]);
  assert.ok(eventsOf(s).every((e: any) => e.visit_id === null));

  const after = await engagement();
  assert.equal(after.coverage.public_sessions - before.coverage.public_sessions, 1);
  assert.equal(after.coverage.dining_sessions - before.coverage.dining_sessions, 0);
  assert.equal(after.funnel.sessions - before.funnel.sessions, 0);
  assert.equal(after.funnel.impression_sessions - before.funnel.impression_sessions, 0);
  const cat = (e: any) => e.categories.find((c: any) => c.category_id === T.categories.grill).sessions_exposed;
  assert.equal(cat(after) - cat(before), 1);
  const reached = (e: any, t: number) => e.scroll.find((x: any) => x.threshold === t).sessions;
  assert.equal(reached(after, 50) - reached(before, 50), 1);
  assert.equal(reached(after, 75) - reached(before, 75), 0);
});

test('a public session that joins a table becomes a dining session for that visit, and loses it with its access', async () => {
  const { token, visit } = await seat();
  const browser = srv.client();
  const s = sid();
  const before = await engagement();
  const browsing = ev('menu_view');
  await sendOk(browser, s, [browsing], { accepted: 1, duplicates: 0, rejected: 0 });
  assert.equal(sessionRow(s).kind, 'public');

  const joined = await browser.request('POST', '/api/public/qr/join', { token, pin: visit.join_pin }, { 'X-Forwarded-For': `10.8.1.${++addresses}` });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const seen = ev('item_impression', { item_id: T.items.soup, category_id: T.categories.grill });
  await sendOk(browser, s, [seen], { accepted: 1, duplicates: 0, rejected: 0 });
  const row = sessionRow(s);
  assert.deepEqual([row.kind, row.visit_id], ['dining', visit.id]);
  assert.ok(row.guest_session_id && row.first_join_at);
  const stored = new Map(eventsOf(s).map((e: any) => [e.event_id, e.visit_id]));
  assert.equal(stored.get(browsing.event_id), null, 'browsing before the join is not re-linked to the visit');
  assert.equal(stored.get(seen.event_id), visit.id);
  const after = await engagement();
  assert.equal(after.coverage.dining_sessions - before.coverage.dining_sessions, 1);
  assert.equal(after.coverage.public_sessions - before.coverage.public_sessions, 0);

  // Staff remove the table's guests: the device no longer holds access, so its batches are refused.
  const current = await get(`/api/staff/visits/${visit.id}`, floor);
  const revoked = await floor.post(`/api/staff/visits/${visit.id}/revoke-guests`, { version: current.version, reason: 'strangers joined the table' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  await sendOk(browser, s, [ev('menu_view')], { accepted: 0, duplicates: 0, rejected: 1 });
  await sendOk(srv.client(), s, [ev('menu_view')], { accepted: 0, duplicates: 0, rejected: 1 });
  assert.equal(eventsOf(s).length, 2);
});

test('the batch endpoint refuses oversized bodies and more than 120 batches a minute for one session', async () => {
  const c = srv.client();
  const s = sid();
  const big = await c.post('/api/analytics/batch', { session_id: s, events: [], padding: 'x'.repeat(130 * 1024) });
  assert.equal(big.status, 413);
  for (let sent = 0; sent < 120; sent += 20) {
    const replies = await Promise.all(Array.from({ length: 20 }, () => c.post('/api/analytics/batch', { session_id: s, events: [] })));
    assert.ok(replies.every((r) => r.status === 200), JSON.stringify(replies.find((r) => r.status !== 200)?.body));
  }
  const over = await c.post('/api/analytics/batch', { session_id: s, events: [ev('menu_view')] });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'rate_limited');
  assert.ok(over.body.error.details.retry_after_seconds > 0);
  assert.equal(eventsOf(s).length, 0);
  // Other browsers are not affected.
  await sendOk(c, sid(), [ev('menu_view')], { accepted: 1, duplicates: 0, rejected: 0 });
});

test('events for a closed visit are accepted only within the grace window and never linked to a new visit', async () => {
  const cashier = await srv.staff('cashier');
  const { tableId, token, visit } = await seat();
  const guest = await join(token, visit.join_pin);
  const s = sid();
  await sendOk(guest, s, [ev('menu_view')], { accepted: 1, duplicates: 0, rejected: 0 });
  const closed = await cashier.post(`/api/staff/visits/${visit.id}/checkout`, { idempotency_key: key('co') });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  // Asked from a second tab: a 410 clears that tab's cookie, the tracker's tab keeps its own.
  assert.equal((await guest.clone().get('/api/guest/session')).status, 410);

  // The tracker's final flush right after checkout is kept, on the old visit.
  const last = ev('active_time_chunk', { active_ms: 4_000 });
  await sendOk(guest, s, [last, ev('session_end')], { accepted: 2, duplicates: 0, rejected: 0 });
  assert.ok(eventsOf(s).every((e: any) => e.visit_id === visit.id));
  // A cookie for the closed visit never starts a new session.
  const fresh = sid();
  await sendOk(guest, fresh, [ev('menu_view')], { accepted: 0, duplicates: 0, rejected: 1 });
  assert.equal(sessionRow(fresh), undefined);

  // The table is reused by a new party: the old session id cannot join it.
  const next = await floor.post(`/api/staff/tables/${tableId}/visits`, { covers: 2, idempotency_key: key('open') });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  const newGuest = await join(token, next.body.join_pin);
  await sendOk(newGuest, s, [ev('menu_view')], { accepted: 0, duplicates: 0, rejected: 1 });
  assert.equal(sessionRow(s).visit_id, visit.id);
  assert.equal(srv.sql<{ n: number }>('SELECT COUNT(*) AS n FROM analytics_events WHERE visit_id = ?', [next.body.id])[0].n, 0);
  const own = sid();
  await sendOk(newGuest, own, [ev('menu_view')], { accepted: 1, duplicates: 0, rejected: 0 });
  assert.equal(sessionRow(own).visit_id, next.body.id);

  // Sixteen minutes after checkout the grace window is over.
  const longAgo = new Date(Date.now() - 16 * 60_000).toISOString();
  srv.exec('UPDATE visits SET closed_at = ?, close_business_date = ? WHERE id = ?', [longAgo, bkkDate(longAgo), visit.id]);
  const before = eventsOf(s).length;
  await sendOk(guest, s, [ev('session_end')], { accepted: 0, duplicates: 0, rejected: 1 });
  await sendOk(srv.client(), s, [ev('session_end')], { accepted: 0, duplicates: 0, rejected: 1 });
  assert.equal(eventsOf(s).length, before);
});

test('funnel attribution handles quick-add, two devices, missing telemetry and staff-assisted rounds without changing order totals', async () => {
  const { visit, token } = await seat(3);
  const a = await join(token, visit.join_pin);
  const b = await join(token, visit.join_pin);
  const c = await join(token, visit.join_pin);
  const sa = sid();
  const sb = sid();
  const e0 = await engagement();
  const o0 = await get('/api/staff/stats/orders?metric=rounds');

  // Device A: impression -> detail -> add -> submit.
  await sendOk(a, sa, [
    ev('item_impression', { item_id: T.items.steak, category_id: T.categories.grill, position: 0 }),
    ev('item_detail_open', { route: 'item', item_id: T.items.steak, interaction_ref: 'dop_a1' }),
    ev('item_detail_active_time', { route: 'item', item_id: T.items.steak, active_ms: 5_000, interaction_ref: 'dop_a1' }),
    ev('item_detail_active_time', { route: 'item', item_id: T.items.steak, active_ms: 3_000, interaction_ref: 'dop_a1' }),
    ev('cart_add', { route: 'item', item_id: T.items.steak, quantity_delta: 1, quick_add: false, interaction_ref: 'dop_a1' }),
  ], { accepted: 5, duplicates: 0, rejected: 0 });
  const orderA = await order(a, [STEAK], 59000, sa);
  // Device B: quick-add straight from the list, no detail open.
  await sendOk(b, sb, [
    ev('item_impression', { item_id: T.items.soup, category_id: T.categories.grill, position: 3 }),
    ev('cart_add', { item_id: T.items.soup, quantity_delta: 2, quick_add: true }),
  ], { accepted: 2, duplicates: 0, rejected: 0 });
  await order(b, [SOUP(2)], 30000, sb);
  // Device C never delivered telemetry: once without a session id, once with one that never arrived.
  const orderC = await order(c, [SOUP()], 15000);
  await order(c, [SOUP()], 15000, 'ans_never_delivered_1');
  // Staff-assisted round on the same visit.
  const assisted = await floor.post('/api/staff/orders/assist', {
    visit_id: visit.id, idempotency_key: key('asst'), lines: [SOUP()], expected_subtotal_minor: 15000,
  });
  assert.equal(assisted.status, 201, JSON.stringify(assisted.body));

  const e1 = await engagement();
  const o1 = await get('/api/staff/stats/orders?metric=rounds');
  const f = (k: string) => e1.funnel[k] - e0.funnel[k];
  assert.deepEqual(
    { sessions: f('sessions'), impression: f('impression_sessions'), detail: f('detail_sessions'), add: f('add_sessions'), quick: f('quick_add_sessions'), submit: f('submit_sessions') },
    { sessions: 2, impression: 2, detail: 1, add: 2, quick: 1, submit: 2 },
  );
  assert.equal(f('attributed_orders'), 2);
  assert.equal(f('unattributed_orders'), 3);
  assert.equal(o1.total - o0.total, 5, 'missing telemetry never reduces the round count');
  assert.equal(o1.cards.orders_today - o0.cards.orders_today, 5);

  const d = (id: string, k: string) => itemRow(e1, id)[k] - itemRow(e0, id)[k];
  assert.deepEqual([d(T.items.steak, 'impressions'), d(T.items.steak, 'detail_opens'), d(T.items.steak, 'adds'), d(T.items.steak, 'submitted')], [1, 1, 1, 1]);
  assert.deepEqual([d(T.items.soup, 'impressions'), d(T.items.soup, 'detail_opens'), d(T.items.soup, 'adds'), d(T.items.soup, 'submitted')], [1, 0, 1, 2]);
  assert.equal(e1.active_detail_ms.sample - e0.active_detail_ms.sample, 1, 'one detail open is one dwell value (5 s + 3 s)');

  assert.equal(srv.sql<any>('SELECT analytics_session_id FROM orders WHERE id = ?', [orderA.id])[0].analytics_session_id, sa);
  assert.equal(srv.sql<any>('SELECT analytics_session_id FROM orders WHERE id = ?', [orderC.id])[0].analytics_session_id, null);
});

// ================================================================== KPIs (planted week 2026-03-02..08)
test('QR adoption counts staff-only visits in the denominator only and ignores paper-only visits', async () => {
  const k = await get('/api/staff/stats/kpis?from=2026-03-02&to=2026-03-08');
  assert.equal(k.from, '2026-03-02');
  assert.deepEqual(k.qr_adoption, { value: 0.75, numerator: 3, denominator: 4 });
  assert.deepEqual(k.guest_order_time, { median_s: 210, p90_s: 300, sample: 2 });
  assert.deepEqual(k.average_order_value, { value_minor: 44333, rounds: 6 });
  assert.equal(k.totals.accepted_minor, 266000);
  assert.equal(k.include_fixture, false);
});

test('payment figures are only filled in for the owner (reports.financial)', async () => {
  const q = '/api/staff/stats/kpis?from=2026-03-02&to=2026-03-08';
  const own = await get(q, owner);
  assert.equal(own.financial_visible, true);
  assert.deepEqual(own.payment_exceptions, { count: 2, value_minor: 64000 });
  assert.equal(own.totals.paid_minor, 40000);
  assert.equal(own.totals.finalized_minor, 104000);
  assert.deepEqual(own.average_table_value, { value_minor: 34667, visits: 3 });

  const mgr = await get(q, manager);
  assert.equal(mgr.financial_visible, false);
  assert.deepEqual(mgr.payment_exceptions, { count: 0, value_minor: 0 });
  assert.equal(mgr.totals.paid_minor, 0);
  assert.equal(mgr.totals.finalized_minor, 104000);
  assert.deepEqual(mgr.qr_adoption, own.qr_adoption);

  const kitchen = await srv.staff('kitchen');
  const denied = await kitchen.get(q);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
  const cashier = await srv.staff('cashier');
  assert.equal((await cashier.get('/api/staff/stats/engagement')).status, 403);
});

// ================================================================== analytics off / unreachable
test('an order goes through when the analytics endpoint was never reached', async () => {
  const { token, visit } = await seat();
  const guest = await join(token, visit.join_pin);
  const before = srv.sql<{ n: number }>('SELECT COUNT(*) AS n FROM orders')[0].n;
  const o = await order(guest, [SOUP()], 15000, sid());
  assert.equal(srv.sql<{ n: number }>('SELECT COUNT(*) AS n FROM orders')[0].n, before + 1);
  assert.equal(srv.sql<{ n: number }>('SELECT COUNT(*) AS n FROM analytics_sessions WHERE visit_id = ?', [visit.id])[0].n, 0);
  assert.ok(o.reference);
});

test('ordering keeps working when analytics is switched off, and nothing is stored meanwhile', async () => {
  const off = await owner.patch('/api/staff/settings', { analytics: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  try {
    const config = await get('/api/public/config', srv.client());
    assert.equal(config.analytics.enabled, false);
    const { token, visit } = await seat();
    const guest = await join(token, visit.join_pin);
    const s = sid();
    await sendOk(guest, s, [ev('menu_view'), ev('active_time_chunk', { active_ms: 10_000 })], { accepted: 0, duplicates: 0, rejected: 2 });
    assert.equal(sessionRow(s), undefined);
    const o = await order(guest, [SOUP(2)], 30000, s);
    assert.equal(o.subtotal_minor, 30000);
    const e = await engagement();
    assert.equal(e.coverage.note, 'analytics_disabled');
  } finally {
    const on = await owner.patch('/api/staff/settings', { analytics: { enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
  }
  // Switching it on records when measurement started (server time, never typed in),
  // and the page says the telemetry started inside the period when it did.
  const view = await get('/api/staff/settings');
  assert.ok(Date.now() - Date.parse(view.settings.analytics.instrumentation_started_at) < 60_000);
  const e = await engagement();
  assert.equal(e.coverage.telemetry_since, today());
  assert.equal(e.coverage.note, today() > e.from ? 'telemetry_started_in_period' : null);
});
