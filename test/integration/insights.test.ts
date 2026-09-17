// Insights (brief 37, 38, 40, 43, 44F): Order Stats and Menu Stats, read
// through the staff stats API as the owner.
//
// History the API cannot backdate (past visits, rounds, lines, guest sessions,
// availability changes) is planted with explicit UTC timestamps and business
// dates. Every planted row keeps the schema's invariants (closed visits have
// no PIN and revoked guest sessions, chargeable lines carry their milestone
// times, one active visit per table) and is_fixture = 0 unless the test is
// about demo data. Today's behaviour is driven through the real guest API and
// measured as before/after deltas, so the tests stay independent.
//
// Planted timeline (Bangkok business dates):
//   2025-12-30 Tue  V1  covers 2   1 guest round                (first operating date)
//   2025-12-31 Wed  V2  covers 4   guest round at 16:59Z (= 23:59 local, counts in 2025)
//   2026-01-01 Thu  V2             guest round at 17:00Z (= 00:00 local, counts in 2026)
//   2026-01-02 Fri  V3  no covers  staff round (served) + staff round (rejected)
//   2026-01-12..18                 nothing (prior week of WZ)
//   2026-01-19..25  WZ             rounds Mon, Tue, Thu, Fri; Wednesday closed (a real 0)
//   2026-01-26..02-01 WP           one round (steak) on Tue
//   2026-02-02..08  WM             the menu-ranking week (see the ranking tests)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { key, startServer, type Client, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';
import { businessDate } from '../../shared/time.ts';

let srv: TestServer;
let owner: Client;
let joins = 0;

// ------------------------------------------------------------------ dates (independent of shared/time.ts)
/** Bangkok business date of a UTC instant (UTC+7, cutoff 00:00). */
const bkkDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
/** UTC instant of a Bangkok wall-clock time. */
const bkk = (date: string, hm: string) => new Date(`${date}T${hm}:00.000+07:00`).toISOString();
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (date: string) => plusDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const today = () => bkkDate(new Date().toISOString());

// ------------------------------------------------------------------ planting helpers
let seq = 0;
const uid = (p: string) => `${p}_P${(++seq).toString().padStart(4, '0')}${randomBytes(3).toString('hex')}`;

function ins(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  srv.exec(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
}

const ITEM = {
  steak: { id: T.items.steak, cat: T.categories.grill, station: 'kitchen', prep: 'cook', type: 'fixed', price: 59000, en: 'Test Striploin', th: 'สันนอกทดสอบ' },
  soup: { id: T.items.soup, cat: T.categories.grill, station: 'kitchen', prep: 'cook', type: 'fixed', price: 15000, en: 'Test Soup', th: 'ซุปทดสอบ' },
  rib: { id: T.items.rib, cat: T.categories.grill, station: 'kitchen', prep: 'cook', type: 'measured_weight', price: 0, en: 'Test Prime Rib', th: 'ไพร์มริบทดสอบ' },
  coffee: { id: T.items.coffee, cat: T.categories.coffee, station: 'bar', prep: 'prepare', type: 'variant', price: 0, en: 'Test Latte', th: 'ลาเต้ทดสอบ' },
  hist: { id: 'itm_hist', cat: T.categories.grill, station: 'kitchen', prep: 'cook', type: 'fixed', price: 20000, en: 'Test Old Special', th: 'จานพิเศษเก่า' },
} as const;

type LineStatus = 'submitted' | 'accepted' | 'served' | 'rejected' | 'cancelled';
interface PlantLine { item: keyof typeof ITEM; qty?: number; status: LineStatus; variant?: 'hot' | 'iced'; grams?: number; nameEn?: string; nameTh?: string; reason?: string }
interface PlantOrder {
  visit: string; table: string; at: string; source: 'guest' | 'staff' | 'manual_recovery' | 'portion_quote';
  guest?: string | null; fixture?: 0 | 1; bd?: string; lines: PlantLine[];
}

function plantVisit(v: { table: string; seatedAt: string; covers: number | null; closedAt?: string; fixture?: 0 | 1 }): string {
  const id = uid('vis');
  const closedAt = v.closedAt ?? new Date(Date.parse(v.seatedAt) + 2 * 3_600_000).toISOString();
  ins('visits', {
    id, table_id: v.table, status: 'closed', join_pin: null, covers: v.covers, charges_json: '[]',
    seated_at: v.seatedAt, seated_business_date: bkkDate(v.seatedAt), opened_by: 'stf_floor',
    closed_at: closedAt, closed_by: 'stf_cashier', close_business_date: bkkDate(closedAt),
    is_fixture: v.fixture ?? 0, created_at: v.seatedAt, updated_at: closedAt,
  });
  return id;
}

function plantGuest(visitId: string, at: string): string {
  const id = uid('gst');
  const no = srv.sql<{ n: number }>('SELECT COALESCE(MAX(guest_no), 0) + 1 AS n FROM guest_sessions WHERE visit_id = ?', [visitId])[0].n;
  const closedAt = srv.sql<{ closed_at: string | null }>('SELECT closed_at FROM visits WHERE id = ?', [visitId])[0].closed_at;
  ins('guest_sessions', {
    id, visit_id: visitId, token_hash: randomBytes(32).toString('hex'), guest_no: no, created_at: at, last_seen_at: at,
    revoked_at: closedAt, revoke_reason: closedAt ? 'checkout' : null,
  });
  return id;
}

let refs = 0;
function plantOrder(o: PlantOrder): { id: string; lines: string[] } {
  const id = uid('ord');
  const round = srv.sql<{ n: number }>('SELECT COALESCE(MAX(round_no), 0) + 1 AS n FROM orders WHERE visit_id = ?', [o.visit])[0].n;
  const label = srv.sql<{ label: string }>('SELECT label FROM dining_tables WHERE id = ?', [o.table])[0].label;
  const t0 = Date.parse(o.at);
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const fixture = o.fixture ?? 0;
  const priced = o.lines.map((l) => {
    const it = ITEM[l.item];
    const qty = it.type === 'measured_weight' ? 1 : (l.qty ?? 1);
    const unit = it.type === 'variant' ? (l.variant === 'iced' ? 9000 : 8000)
      : it.type === 'measured_weight' ? Math.floor((l.grams! * 49000 + 50) / 100) : it.price;
    return { l, it, qty, unit };
  });
  const everAccepted = (s: LineStatus) => s === 'accepted' || s === 'served' || s === 'cancelled';
  ins('orders', {
    id, reference: `RG-P${(++refs).toString().padStart(3, '0')}`, visit_id: o.visit, table_id: o.table, table_label: label,
    round_no: round, source: o.source, guest_session_id: o.guest ?? null,
    staff_user_id: o.source === 'staff' ? 'stf_floor' : o.source === 'manual_recovery' ? 'stf_manager' : null,
    idempotency_key: uid('att'), payload_hash: 'planted', locale: 'th', submitted_at: o.at,
    business_date: o.bd ?? bkkDate(o.at),
    manual_reference: o.source === 'manual_recovery' ? uid('paper') : null,
    manual_original_time: o.source === 'manual_recovery' ? o.at : null,
    subtotal_minor: priced.reduce((s, p) => s + p.unit * p.qty, 0),
    first_accepted_at: o.source !== 'manual_recovery' && priced.some((p) => everAccepted(p.l.status)) ? at(60) : null,
    is_fixture: fixture, updated_at: at(660),
  });
  const lines = priced.map((p, i) => {
    const lid = uid('lin');
    const s = p.l.status;
    ins('order_lines', {
      id: lid, order_id: id, visit_id: o.visit, line_no: i + 1, item_id: p.it.id,
      variant_id: p.l.variant ? `var_coffee_${p.l.variant}` : null, category_id: p.it.cat,
      name_th: p.l.nameTh ?? p.it.th, name_en: p.l.nameEn ?? p.it.en,
      variant_name_th: p.l.variant ? (p.l.variant === 'iced' ? 'เย็น' : 'ร้อน') : null,
      variant_name_en: p.l.variant ? (p.l.variant === 'iced' ? 'Iced' : 'Hot') : null,
      station: p.it.station, prep_kind: p.it.prep, pricing_type: p.it.type,
      unit_price_minor: p.unit, modifiers_json: '[]', modifiers_minor: 0, quantity: p.qty,
      measured_grams: p.l.grams ?? null, rate_minor: p.l.grams ? 49000 : null, rate_basis_grams: p.l.grams ? 100 : null,
      line_total_minor: p.unit * p.qty, allergy_flag: 0, status: s, status_reason: p.l.reason ?? null,
      submitted_at: o.at,
      accepted_at: everAccepted(s) ? at(60) : null,
      preparing_at: s === 'served' ? at(120) : null,
      ready_at: s === 'served' ? at(600) : null,
      served_at: s === 'served' ? at(660) : null,
      rejected_at: s === 'rejected' ? at(60) : null,
      cancelled_at: s === 'cancelled' ? at(300) : null,
      is_fixture: fixture, updated_at: at(660),
    });
    if (s === 'rejected' || s === 'cancelled') {
      ins('line_events', {
        line_id: lid, order_id: id, visit_id: o.visit, from_status: s === 'rejected' ? 'submitted' : 'accepted', to_status: s,
        kind: s === 'rejected' ? 'reject' : 'cancel', actor_type: 'staff', actor_id: 'stf_manager', reason: p.l.reason ?? 'planted', created_at: at(60),
      });
    }
    return lid;
  });
  return { id, lines };
}

/** A prime-rib portion request with its quote revisions; a confirmed quote points at its order line. */
function plantPortion(visitId: string, guest: string, at: string, status: 'confirmed' | 'cancelled', quotes: Array<[number, 'confirmed' | 'superseded', string | null]>): void {
  const id = uid('prq');
  const t = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();
  const table = srv.sql<{ table_id: string }>('SELECT table_id FROM visits WHERE id = ?', [visitId])[0].table_id;
  ins('portion_requests', {
    id, visit_id: visitId, table_id: table, item_id: T.items.rib, guest_session_id: guest, status, idempotency_key: uid('prk'),
    created_at: at, business_date: bkkDate(at), resolved_at: t(600), resolved_by: status === 'cancelled' ? 'stf_floor' : null,
    resolution_reason: status === 'cancelled' ? 'guest changed their mind' : null, is_fixture: 0, updated_at: t(600),
  });
  quotes.forEach(([grams, qs, lineId], i) => {
    const qid = uid('pqt');
    ins('portion_quotes', {
      id: qid, request_id: id, revision: i + 1, grams, rate_minor: 49000, rate_basis_grams: 100,
      amount_minor: Math.floor((grams * 49000 + 50) / 100), choices_json: '[]', expires_at: t(1200 + i * 60), status: qs,
      created_by: 'stf_kitchen', created_at: t(120 + i * 60),
      confirmed_at: qs === 'confirmed' ? t(300) : null, confirmed_via: qs === 'confirmed' ? 'guest' : null,
      confirmed_guest_session_id: qs === 'confirmed' ? guest : null, confirm_idempotency_key: qs === 'confirmed' ? uid('pck') : null,
      order_line_id: lineId,
    });
    if (lineId) srv.exec('UPDATE order_lines SET portion_quote_id = ? WHERE id = ?', [qid, lineId]);
  });
}

function plantAvailability(itemId: string, available: 0 | 1, at: string, reason = 'published'): void {
  ins('availability_log', { item_id: itemId, available, reason, changed_at: at, changed_by: 'test' });
}

// ------------------------------------------------------------------ API helpers
async function join(tableId: string, pin: string | null): Promise<Client> {
  // Distinct forwarded addresses keep the per-address join limit out of the way.
  const c = srv.client();
  const r = await c.request('POST', '/api/public/qr/join', { token: T.tokens[tableId], ...(pin ? { pin } : {}) }, { 'X-Forwarded-For': `10.9.0.${++joins}` });
  assert.ok(r.status === 201 || r.status === 200, `join ${tableId}: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

async function submit(g: Client, lines: unknown[], expected: number): Promise<{ id: string; reference: string }> {
  const r = await g.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: expected });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.order;
}

async function get(path: string, who: Client = owner): Promise<any> {
  const r = await who.get(path);
  assert.equal(r.status, 200, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const orderStats = (q: string) => get(`/api/staff/stats/orders?${q}`);
const menuStats = (q: string) => get(`/api/staff/stats/menu?${q}`);
const bucket = (s: any, date: string) => {
  const b = s.buckets.find((x: any) => x.date === date);
  assert.ok(b, `no bucket ${date} in ${s.from}..${s.to}`);
  return b;
};
const row = (m: any, itemId: string) => m.rows.find((r: any) => r.item_id === itemId);
const SOUP = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] });

// ------------------------------------------------------------------ fixture history
const WM = '2026-02-04'; // any date in the menu-ranking week 2026-02-02..08
let sorbetId = 'itm_sorbet';

function plantHistory(): void {
  // Catalog facts: an archived dish that sold in the past, and a dessert that
  // was sold out for almost the whole ranking week.
  ins('menu_items', {
    id: ITEM.hist.id, key: 'test-old-special', category_id: T.categories.grill, sort: 9, name_en: ITEM.hist.en, name_th: ITEM.hist.th,
    pricing_type: 'fixed', price_minor: 20000, status: 'archived', review_status: 'verified', demo_orderable: 0,
    created_at: '2025-11-01T00:00:00.000Z', updated_at: '2026-03-01T00:00:00.000Z', approved_at: '2025-11-01T00:00:00.000Z', published_version: 1,
  });
  ins('menu_items', {
    id: sorbetId, key: 'test-sorbet', category_id: T.categories.dessert, sort: 5, name_en: 'Test Sorbet', name_th: 'ซอร์เบทีทดสอบ',
    pricing_type: 'fixed', price_minor: 12000, status: 'published', review_status: 'verified', demo_orderable: 0,
    created_at: '2026-01-30T00:00:00.000Z', updated_at: '2026-01-30T00:00:00.000Z', approved_at: '2026-01-30T00:00:00.000Z', published_version: 1,
  });
  for (const id of [T.items.steak, T.items.soup, T.items.coffee, T.items.rib, T.items.wine]) plantAvailability(id, 1, '2025-12-01T00:00:00.000Z');
  plantAvailability(sorbetId, 1, bkk('2026-02-02', '00:00'));
  plantAvailability(sorbetId, 0, bkk('2026-02-02', '10:00'), 'sold_out');

  // Cross-year week.
  const v1 = plantVisit({ table: 'tbl_T01', seatedAt: bkk('2025-12-30', '19:00'), covers: 2 });
  plantOrder({ visit: v1, table: 'tbl_T01', at: bkk('2025-12-30', '19:10'), source: 'guest', guest: plantGuest(v1, bkk('2025-12-30', '19:05')), lines: [{ item: 'soup', status: 'served' }] });
  const v2 = plantVisit({ table: 'tbl_T02', seatedAt: '2025-12-31T16:30:00.000Z', covers: 4, closedAt: '2025-12-31T18:00:00.000Z' });
  const g2 = plantGuest(v2, '2025-12-31T16:35:00.000Z');
  // Business dates hard-coded: 16:59Z is 23:59 on 31 Dec in Bangkok, 17:00Z is midnight of 1 Jan.
  plantOrder({ visit: v2, table: 'tbl_T02', at: '2025-12-31T16:59:00.000Z', bd: '2025-12-31', source: 'guest', guest: g2, lines: [{ item: 'steak', status: 'served' }] });
  plantOrder({ visit: v2, table: 'tbl_T02', at: '2025-12-31T17:00:00.000Z', bd: '2026-01-01', source: 'guest', guest: g2, lines: [{ item: 'soup', qty: 2, status: 'served' }] });
  const v3 = plantVisit({ table: 'tbl_T03', seatedAt: bkk('2026-01-02', '12:00'), covers: null });
  plantOrder({ visit: v3, table: 'tbl_T03', at: bkk('2026-01-02', '12:10'), source: 'staff', lines: [{ item: 'soup', status: 'served' }] });
  plantOrder({ visit: v3, table: 'tbl_T03', at: bkk('2026-01-02', '12:20'), source: 'staff', lines: [{ item: 'soup', status: 'rejected', reason: 'kitchen closed' }] });

  // WZ: 2026-01-19..25, closed on Wednesday 21st.
  const zDays: Array<[string, string, number | null, keyof typeof ITEM, number]> = [
    ['2026-01-19', 'tbl_T01', 2, 'steak', 1], ['2026-01-20', 'tbl_T02', 3, 'soup', 1],
    ['2026-01-22', 'tbl_T03', 2, 'soup', 2], ['2026-01-23', 'tbl_T01', null, 'steak', 1],
  ];
  for (const [date, table, covers, item, qty] of zDays) {
    const v = plantVisit({ table, seatedAt: bkk(date, '19:00'), covers });
    plantOrder({ visit: v, table, at: bkk(date, '19:10'), source: 'staff', lines: [{ item, qty, status: 'served' }] });
  }

  // WP: one steak on Tue 2026-01-27.
  const v8 = plantVisit({ table: 'tbl_T01', seatedAt: bkk('2026-01-27', '19:00'), covers: 2 });
  plantOrder({ visit: v8, table: 'tbl_T01', at: bkk('2026-01-27', '19:10'), source: 'staff', lines: [{ item: 'steak', status: 'served' }] });

  // WM: 2026-02-02..08.
  const v9 = plantVisit({ table: 'tbl_T01', seatedAt: bkk('2026-02-02', '18:00'), covers: 2 });
  const g9 = plantGuest(v9, bkk('2026-02-02', '18:05'));
  plantOrder({
    visit: v9, table: 'tbl_T01', at: bkk('2026-02-02', '18:10'), source: 'guest', guest: g9,
    lines: [{ item: 'steak', qty: 2, status: 'served' }, { item: 'steak', status: 'rejected', reason: 'ran out' }],
  });
  plantOrder({
    visit: v9, table: 'tbl_T01', at: bkk('2026-02-02', '18:40'), source: 'guest', guest: g9,
    lines: [{ item: 'soup', status: 'served', nameEn: 'Old Soup Name', nameTh: 'ซุปชื่อเดิม' }],
  });
  const v10 = plantVisit({ table: 'tbl_T02', seatedAt: bkk('2026-02-04', '19:00'), covers: 3 });
  plantOrder({
    visit: v10, table: 'tbl_T02', at: bkk('2026-02-04', '19:15'), source: 'staff',
    lines: [
      { item: 'steak', status: 'served' },
      { item: 'soup', qty: 2, status: 'served', nameEn: 'Old Soup Name', nameTh: 'ซุปชื่อเดิม' },
      { item: 'coffee', variant: 'hot', status: 'served' },
      { item: 'coffee', variant: 'iced', status: 'served' },
    ],
  });
  const v11 = plantVisit({ table: 'tbl_T03', seatedAt: bkk('2026-02-06', '20:00'), covers: 2 });
  const g11 = plantGuest(v11, bkk('2026-02-06', '20:05'));
  const cut1 = plantOrder({ visit: v11, table: 'tbl_T03', at: bkk('2026-02-06', '20:30'), source: 'portion_quote', guest: g11, lines: [{ item: 'rib', grams: 350, status: 'served' }] });
  const cut2 = plantOrder({ visit: v11, table: 'tbl_T03', at: bkk('2026-02-06', '20:40'), source: 'portion_quote', guest: g11, lines: [{ item: 'rib', grams: 420, status: 'served' }] });
  plantOrder({ visit: v11, table: 'tbl_T03', at: bkk('2026-02-06', '20:45'), source: 'staff', lines: [{ item: 'hist', status: 'served' }] });
  // The weighed-cut funnel behind those two rounds: two confirmed requests (one
  // re-quoted), and one request cancelled before any weighing.
  plantPortion(v11, g11, bkk('2026-02-06', '20:15'), 'confirmed', [[350, 'confirmed', cut1.lines[0]]]);
  plantPortion(v11, g11, bkk('2026-02-06', '20:20'), 'confirmed', [[400, 'superseded', null], [420, 'confirmed', cut2.lines[0]]]);
  plantPortion(v11, g11, bkk('2026-02-06', '20:25'), 'cancelled', []);
  // Demo data in the same week: excluded unless include_fixture=1.
  const v12 = plantVisit({ table: 'tbl_T04', seatedAt: bkk('2026-02-07', '19:00'), covers: 2, fixture: 1 });
  plantOrder({ visit: v12, table: 'tbl_T04', at: bkk('2026-02-07', '19:10'), source: 'staff', fixture: 1, lines: [{ item: 'steak', qty: 5, status: 'served' }] });

  // Seven days before the real today: a party seated just after midnight and
  // one seated just before the next midnight (same elapsed span comparison).
  const d7 = plusDays(today(), -7);
  const at = (hm: string, s: number) => new Date(Date.parse(bkk(d7, hm)) + s * 1000).toISOString();
  const early = plantVisit({ table: 'tbl_T04', seatedAt: at('00:00', 10), covers: 2 });
  plantOrder({ visit: early, table: 'tbl_T04', at: at('00:00', 30), source: 'staff', lines: [{ item: 'soup', status: 'served' }] });
  const late = plantVisit({ table: 'tbl_T04', seatedAt: at('23:59', 0), covers: 3 });
  plantOrder({ visit: late, table: 'tbl_T04', at: at('23:59', 30), source: 'staff', lines: [{ item: 'soup', status: 'served' }] });
}

before(async () => {
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  owner = await srv.staff('owner');
  plantHistory();
});
after(async () => { await srv?.stop(); });

// ================================================================== live rounds (today)
async function todayFigures() {
  const out: Record<string, any> = {};
  for (const metric of ['rounds', 'visits', 'devices', 'diners', 'items']) out[metric] = await orderStats(`metric=${metric}`);
  return out;
}

test('three rounds from one visit count as three rounds and one ordering visit; a party of four is four recorded diners, not twelve', async () => {
  const before = await todayFigures();
  const visit = await srv.openVisit('tbl_T01', 4);
  const guest = await join('tbl_T01', visit.join_pin);
  const references: string[] = [];
  for (let i = 0; i < 3; i++) references.push((await submit(guest, [SOUP()], 15000)).reference);
  const after = await todayFigures();
  const d = today();

  const delta = (m: string) => after[m].total - before[m].total;
  assert.equal(delta('rounds'), 3);
  assert.equal(delta('visits'), 1, 'repeat rounds never add distinct visits');
  assert.equal(delta('diners'), 4, 'covers are counted once per visit, never per round');
  assert.equal(delta('devices'), 1);
  assert.equal(delta('items'), 0, 'submitted, not yet accepted, rounds add no accepted items');

  const b0 = bucket(before.rounds, d).breakdown;
  const b1 = bucket(after.rounds, d).breakdown;
  assert.equal(b1.submitted - b0.submitted, 3);
  assert.equal(b1.visits - b0.visits, 1);
  assert.equal(b1.diners - b0.diners, 4);
  assert.deepEqual(
    { with_covers: b1.diners_coverage.with_covers - b0.diners_coverage.with_covers, visits: b1.diners_coverage.visits - b0.diners_coverage.visits },
    { with_covers: 1, visits: 1 },
  );

  const c0 = before.rounds.cards;
  const c1 = after.rounds.cards;
  assert.equal(c1.orders_today - c0.orders_today, 3);
  assert.equal(c1.visits_ordering_today - c0.visits_ordering_today, 1);
  assert.equal(c1.diners_today - c0.diners_today, 4);
  assert.equal(c1.unresolved_orders - c0.unresolved_orders, 3);

  // The day drill-down lists the actual references with the table-at-order snapshot.
  const day = await get(`/api/staff/stats/orders/day?date=${d}`);
  const listed = day.orders.filter((o: any) => references.includes(o.reference));
  assert.equal(listed.length, 3);
  assert.ok(listed.every((o: any) => o.table_label === 'T01' && o.source === 'guest' && o.items === 1 && o.subtotal_minor === 15000));
});

test('two guests sharing one phone are one device and never two people; a visit without covers stays visible in coverage', async () => {
  const before = await todayFigures();
  const visit = await srv.openVisit('tbl_T02', null);
  assert.equal(visit.covers, null);
  const phone = await join('tbl_T02', visit.join_pin);
  const steak = { item_id: T.items.steak, quantity: 1, modifiers: [{ group_id: T.groups.doneness, option_ids: [T.options.rare] }] };
  await submit(phone, [steak], 59000); // first person
  await submit(phone, [SOUP()], 15000); // second person, same phone
  await submit(phone.clone(), [SOUP()], 15000); // a second tab of the same browser
  const mid = await todayFigures();
  const d = today();
  assert.equal(mid.rounds.total - before.rounds.total, 3);
  assert.equal(mid.devices.total - before.devices.total, 1, 'one browser is one device however many people use it');
  assert.equal(mid.visits.total - before.visits.total, 1);
  assert.equal(mid.diners.total - before.diners.total, 0, 'people are never inferred from devices or rounds');
  const cov0 = bucket(before.diners, d).breakdown.diners_coverage;
  const cov1 = bucket(mid.diners, d).breakdown.diners_coverage;
  assert.equal(cov1.visits - cov0.visits, 1, 'the uncounted visit is still in the coverage denominator');
  assert.equal(cov1.with_covers - cov0.with_covers, 0);
  assert.equal(mid.rounds.cards.diners_coverage_today.visits - before.rounds.cards.diners_coverage_today.visits, 1);

  // Only staff input creates recorded diners.
  const floor = await srv.staff('floor');
  const current = await get(`/api/staff/visits/${visit.id}`, floor);
  const patched = await floor.patch(`/api/staff/visits/${visit.id}`, { covers: 2, version: current.version });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const end = await todayFigures();
  assert.equal(end.diners.total - before.diners.total, 2);
  assert.equal(bucket(end.diners, d).breakdown.diners_coverage.with_covers - cov0.with_covers, 1);
  assert.equal(end.devices.total - before.devices.total, 1);
});

test('weekly bars: today is partial, later days are future with null values, and next week is entirely future', async () => {
  const d = today();
  const week = await orderStats('period=week');
  assert.equal(week.from, mondayOf(d));
  assert.equal(week.to, plusDays(mondayOf(d), 6));
  assert.deepEqual(week.buckets.map((b: any) => b.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  for (const b of week.buckets) {
    if (b.date < d) {
      assert.equal(b.state, 'complete', b.date);
      assert.equal(typeof b.value, 'number');
    } else if (b.date === d) {
      assert.equal(b.state, 'partial');
      assert.equal(typeof b.value, 'number');
    } else {
      assert.equal(b.state, 'future', b.date);
      assert.equal(b.value, null, 'a future day is not a zero day');
    }
  }
  // Comparison uses the same elapsed span of the previous week.
  assert.equal(week.previous.from, plusDays(mondayOf(d), -7));
  assert.equal(week.previous.note, 'same_elapsed_span');
  assert.equal(week.first_operating_date, '2025-12-30');

  const next = await orderStats(`period=week&anchor=${plusDays(d, 7)}`);
  assert.equal(next.buckets.length, 7);
  assert.ok(next.buckets.every((b: any) => b.state === 'future' && b.value === null));
  assert.equal(next.total, 0);
  assert.equal(next.previous.total, null);
  assert.equal(next.previous.note, 'future_period');
  assert.deepEqual(next.change, { absolute: null, percent: null, label: 'no_baseline' });
});

test('the current week is compared with the same elapsed span of the previous week, cut at the same local time', async (t) => {
  const minutes = (Date.now() + 7 * 3_600_000) % 86_400_000 / 60_000;
  if (minutes < 1 || minutes > 23 * 60 + 58) {
    t.skip('too close to Bangkok midnight for the planted 00:00:30 / 23:59:30 rounds');
    return;
  }
  const d = today();
  const rounds = await orderStats('period=week');
  assert.deepEqual(rounds.previous, {
    from: plusDays(mondayOf(d), -7), to: plusDays(mondayOf(d), -1), total: 1, comparable: true, note: 'same_elapsed_span',
  });
  const diners = await orderStats('period=week&metric=diners');
  assert.equal(diners.previous.total, 2, 'covers are cut on seated_at at the same local time');
  // A completed week in the past is compared in full.
  const lastWeek = await orderStats(`period=week&anchor=${plusDays(d, -7)}`);
  assert.equal(lastWeek.total, 2);
  assert.equal(lastWeek.previous.note, null);
});

// ================================================================== planted weeks
test('a closed day inside an operating week is a real zero, and a zero prior week gives no baseline instead of an infinite percentage', async () => {
  const wz = await orderStats('period=week&anchor=2026-01-21');
  assert.equal(wz.from, '2026-01-19');
  assert.deepEqual(
    wz.buckets.map((b: any) => [b.date, b.state, b.value]),
    [
      ['2026-01-19', 'complete', 1], ['2026-01-20', 'complete', 1], ['2026-01-21', 'complete', 0],
      ['2026-01-22', 'complete', 1], ['2026-01-23', 'complete', 1], ['2026-01-24', 'complete', 0], ['2026-01-25', 'complete', 0],
    ],
  );
  assert.equal(wz.total, 4);
  assert.deepEqual(wz.previous, { from: '2026-01-12', to: '2026-01-18', total: 0, comparable: true, note: null });
  assert.deepEqual(wz.change, { absolute: 4, percent: null, label: 'no_baseline' });

  const diners = await orderStats('period=week&anchor=2026-01-21&metric=diners');
  assert.equal(diners.total, 7);
  assert.deepEqual(bucket(diners, '2026-01-23').breakdown.diners_coverage, { with_covers: 0, visits: 1 });
  assert.equal(bucket(diners, '2026-01-23').value, 0);

  // A normal comparison: WM (6 rounds) against WP (1 round).
  const wm = await orderStats(`period=week&anchor=${WM}`);
  assert.equal(wm.total, 6);
  assert.equal(wm.previous.total, 1);
  assert.equal(wm.previous.comparable, true);
  assert.deepEqual(wm.change, { absolute: 5, percent: 500, label: 'up' });

  // The text/table equivalent carries the same states and the period total.
  const csv = await owner.get('/api/staff/stats/export.csv?view=orders&period=week&anchor=2026-01-21');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  const lines = String(csv.body).replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines.length, 9);
  assert.match(lines[3], /^2026-01-21,complete,0,0,/);
  assert.match(lines[8], /^2026-01-19\.\.2026-01-25,period_total,4,/);
});

test('a day before the first operating date is missing, not zero', async () => {
  const s = await orderStats('period=week&anchor=2026-01-01');
  assert.equal(s.first_operating_date, '2025-12-30');
  assert.deepEqual([bucket(s, '2025-12-29').state, bucket(s, '2025-12-29').value], ['missing', null]);
  assert.deepEqual([bucket(s, '2025-12-30').state, bucket(s, '2025-12-30').value], ['complete', 1]);
  // The week before holds no operating day at all: nothing to compare with.
  assert.deepEqual(s.previous, { from: '2025-12-22', to: '2025-12-28', total: null, comparable: false, note: 'no_prior_data' });
  assert.equal(s.change.label, 'no_baseline');
  assert.equal(s.change.percent, null);

  const year2025 = await orderStats('period=year&anchor=2025-06-15');
  for (const b of year2025.buckets.slice(0, 11)) assert.deepEqual([b.state, b.value], ['missing', null], b.date);
});

test('a week that crosses New Year stays seven days long and recomputes distinct visits and devices for the whole week', async () => {
  const s = await orderStats('period=week&anchor=2026-01-01');
  assert.equal(s.from, '2025-12-29');
  assert.equal(s.to, '2026-01-04');
  assert.deepEqual(s.buckets.map((b: any) => b.date), ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.deepEqual(s.buckets.map((b: any) => b.value), [null, 1, 1, 1, 2, 0, 0]);
  assert.equal(s.total, 5);
  const fri = bucket(s, '2026-01-02').breakdown;
  assert.deepEqual([fri.submitted, fri.accepted, fri.rejected, fri.cancelled], [2, 1, 1, 0]);

  const visits = await orderStats('period=week&anchor=2026-01-01&metric=visits');
  const dailyVisits = visits.buckets.reduce((sum: number, b: any) => sum + b.breakdown.visits, 0);
  assert.equal(dailyVisits, 4, 'the visit that ordered either side of midnight appears on two days');
  assert.equal(visits.total, 3, 'but it is one visit in the week');

  const devices = await orderStats('period=week&anchor=2026-01-01&metric=devices');
  assert.equal(devices.buckets.reduce((sum: number, b: any) => sum + b.breakdown.devices, 0), 3);
  assert.equal(devices.total, 2, 'staff rounds are not devices; one guest phone across midnight is one device');

  const diners = await orderStats('period=week&anchor=2026-01-01&metric=diners');
  assert.equal(diners.total, 6);
  assert.deepEqual(bucket(diners, '2026-01-01').breakdown.diners_coverage, { with_covers: 0, visits: 0 }, 'covers count on the seated date');
  assert.deepEqual(bucket(diners, '2025-12-31').breakdown.diners_coverage, { with_covers: 1, visits: 1 });

  const items = await orderStats('period=week&anchor=2026-01-01&metric=items');
  assert.equal(items.total, 5);
});

test('the year view is clipped to [1 Jan, next 1 Jan): 16:59Z on 31 Dec counts in 2025 and 17:00Z counts in 2026', async () => {
  assert.equal(businessDate('2025-12-31T16:59:59.999Z'), '2025-12-31');
  assert.equal(businessDate('2025-12-31T17:00:00.000Z'), '2026-01-01');

  const y25 = await orderStats('period=year&anchor=2025-12-31');
  assert.equal(y25.from, '2025-01-01');
  assert.equal(y25.to, '2025-12-31');
  assert.equal(y25.buckets.length, 12);
  assert.deepEqual(y25.buckets.map((b: any) => b.date), Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual([y25.buckets[11].state, y25.buckets[11].value], ['complete', 2]);
  assert.equal(y25.total, 2);
  assert.equal(y25.previous.note, 'no_prior_data');

  const y26 = await orderStats('period=year&anchor=2026-01-01');
  assert.equal(y26.from, '2026-01-01');
  assert.equal(y26.to, '2026-12-31');
  // January: the 00:00 round, V3's two rounds, WZ's four and WP's one.
  assert.deepEqual([y26.buckets[0].state, y26.buckets[0].value], ['complete', 8]);
  assert.deepEqual([y26.buckets[1].state, y26.buckets[1].value], ['complete', 6]);
  const visits25 = await orderStats('period=year&anchor=2025-12-31&metric=visits');
  assert.equal(visits25.total, 2);

  // The day drill-downs place the two rounds on either side of midnight.
  const d31 = await get('/api/staff/stats/orders/day?date=2025-12-31');
  assert.equal(d31.orders.length, 1);
  assert.equal(d31.orders[0].submitted_at, '2025-12-31T16:59:00.000Z');
  assert.equal(d31.orders[0].table_label, 'T02');
  assert.deepEqual(d31.hourly.find((h: any) => h.hour === 23), { hour: 23, rounds: 1, items: 1 });
  const d01 = await get('/api/staff/stats/orders/day?date=2026-01-01');
  assert.equal(d01.orders.length, 1);
  assert.equal(d01.orders[0].submitted_at, '2025-12-31T17:00:00.000Z');
  assert.deepEqual(d01.hourly.find((h: any) => h.hour === 0), { hour: 0, rounds: 1, items: 2 });
  assert.equal(d01.hourly[0].hour, 0, 'hours are listed from the business-day cutoff');
});

// ================================================================== menu rankings (week 2026-02-02..08)
test('least ordered lists eligible zero-order items and never the draft or an unverified live item', async () => {
  const m = await menuStats(`period=week&anchor=${WM}&direction=least`);
  assert.equal(m.from, '2026-02-02');
  assert.equal(m.direction, 'least');
  const ids = m.rows.map((r: any) => r.item_id);
  assert.ok(!ids.includes(T.items.draft), 'drafts never appear');
  assert.ok(!ids.includes(T.items.dessert), 'an unverified item cannot be ordered in live mode');
  const wine = row(m, T.items.wine);
  assert.ok(wine, 'a published, priced, available item with no orders is listed');
  assert.deepEqual(
    [wine.rank, wine.net_qty, wine.orders, wine.available_days, wine.period_days, wine.availability, wine.quality],
    [1, 0, 0, 7, 7, 'full', 'never_ordered_despite_availability'],
  );
  assert.deepEqual(m.rows.map((r: any) => [r.rank, r.item_id]), [
    [1, sorbetId], [1, T.items.wine], [3, ITEM.hist.id], [4, T.items.coffee], [4, T.items.rib], [6, T.items.soup], [6, T.items.steak],
  ]);
  assert.deepEqual(m.totals, { net_qty: 11, items_ranked: 7, zero_order_items: 2 });
});

test('equal quantities share a competition rank and keep a stable name order', async () => {
  const first = await menuStats(`period=week&anchor=${WM}`);
  const again = await menuStats(`period=week&anchor=${WM}`);
  const shape = (m: any) => m.rows.map((r: any) => [r.rank, r.item_id, r.net_qty]);
  assert.deepEqual(shape(first), [
    [1, T.items.soup, 3], [1, T.items.steak, 3], [3, T.items.coffee, 2], [3, T.items.rib, 2],
    [5, ITEM.hist.id, 1], [6, sorbetId, 0], [6, T.items.wine, 0],
  ]);
  assert.deepEqual(shape(again), shape(first), 'tied rows keep their order between requests');
  assert.match(first.tie_policy, /competition ranking/i);

  const steak = row(first, T.items.steak);
  assert.deepEqual([steak.submitted_qty, steak.orders, steak.visits, steak.share], [4, 2, 2, 0.2727]);
  assert.deepEqual(steak.change, { previous: 1, label: 'up', delta: 2 });
  assert.equal(steak.per_available_day, 0.43);
  const coffee = row(first, T.items.coffee);
  assert.deepEqual(coffee.variants, [{ name: { th: 'ร้อน', en: 'Hot' }, net_qty: 1 }, { name: { th: 'เย็น', en: 'Iced' }, net_qty: 1 }]);
  assert.deepEqual(coffee.change, { previous: 0, label: 'no_baseline', delta: 2 });

  // Units per available day: the item without an availability log goes last.
  const perDay = await menuStats(`period=week&anchor=${WM}&measure=per_available_day`);
  assert.deepEqual(perDay.rows.map((r: any) => [r.rank, r.item_id]), [
    [1, T.items.soup], [1, T.items.steak], [3, T.items.coffee], [3, T.items.rib], [5, sorbetId], [5, T.items.wine], [7, ITEM.hist.id],
  ]);

  // Category share is of the selected category's quantity.
  const drinks = await menuStats(`period=week&anchor=${WM}&category=${T.categories.coffee}`);
  assert.deepEqual(drinks.rows.map((r: any) => [r.item_id, r.share]), [[T.items.coffee, 1], [T.items.wine, 0]]);
});

test('an archived item with past orders stays in its period and a renamed item keeps one history row', async () => {
  const menu = await get('/api/staff/menu');
  const soup = menu.items.find((i: any) => i.id === T.items.soup);
  // Renamed after the orders were placed: history follows the stable item id.
  const renamed = await owner.patch(`/api/staff/menu/items/${T.items.soup}`, { name_en: 'Test Soup Renamed', version: soup.version });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const m = await menuStats(`period=week&anchor=${WM}`);
  const hist = row(m, ITEM.hist.id);
  assert.ok(hist, 'the archived dish is still ranked for the week it sold');
  assert.deepEqual([hist.archived, hist.net_qty, hist.availability, hist.quality], [true, 1, 'unknown', null]);
  assert.equal(hist.change.label, 'new');

  const soupRows = m.rows.filter((r: any) => r.item_id === T.items.soup);
  assert.equal(soupRows.length, 1);
  assert.equal(soupRows[0].net_qty, 3, 'lines ordered under the old name count in the same row');
  assert.equal(soupRows[0].name.en, 'Test Soup Renamed');
  assert.ok(!m.rows.some((r: any) => r.name.en === 'Old Soup Name'));

  // With no sales in the period, an archived item is not an eligible zero-order row.
  const later = await menuStats('period=week&anchor=2026-03-04&direction=least');
  assert.ok(!later.rows.some((r: any) => r.item_id === ITEM.hist.id));
  assert.ok(later.rows.some((r: any) => r.item_id === T.items.wine));
});

test('a dish sold out for most of the week is marked insufficient availability, not proven unpopular', async () => {
  const m = await menuStats(`period=week&anchor=${WM}&direction=least`);
  const sorbet = row(m, sorbetId);
  assert.ok(sorbet);
  assert.deepEqual(
    [sorbet.net_qty, sorbet.available_days, sorbet.period_days, sorbet.availability, sorbet.quality, sorbet.per_available_day],
    [0, 1, 7, 'insufficient', 'insufficient_availability', 0],
  );
  assert.equal(sorbet.change.label, 'new', 'first available inside the period');
  assert.notEqual(sorbet.quality, row(m, T.items.wine).quality, 'separated from never-ordered-despite-availability');

  // A week in which it was never available at all does not list it.
  const later = await menuStats('period=week&anchor=2026-03-04&direction=least');
  assert.ok(!later.rows.some((r: any) => r.item_id === sorbetId));
});

test('measured-weight cuts count servings, and grams are a separate measure that never ranks plates', async () => {
  const m = await menuStats(`period=week&anchor=${WM}`);
  const rib = row(m, T.items.rib);
  assert.deepEqual([rib.measured_weight, rib.net_qty, rib.submitted_qty, rib.grams, rib.orders, rib.visits], [true, 2, 2, 770, 2, 1]);
  assert.equal(row(m, T.items.steak).grams, null);

  const grams = await menuStats(`period=week&anchor=${WM}&measure=grams`);
  assert.deepEqual(grams.rows.map((r: any) => [r.rank, r.item_id, r.grams, r.net_qty]), [[1, T.items.rib, 770, 2]]);

  const items = await orderStats(`period=week&anchor=${WM}&metric=items`);
  assert.equal(items.total, 11, 'a weighed cut is one item, not 350 or 420');
  assert.deepEqual(bucket(items, '2026-02-06').value, 3);
  const devices = await orderStats(`period=week&anchor=${WM}&metric=devices`);
  assert.equal(devices.total, 1, 'portion rounds are not devices');
});

test('the item detail shows a weekly trend from the first operating week, the variant split and the weighed-cut funnel', async () => {
  const steak = await get(`/api/staff/stats/menu/items/${T.items.steak}?period=week&anchor=${WM}`);
  assert.deepEqual(steak.weekly, [
    { week_start: '2025-12-29', net_qty: 1 }, { week_start: '2026-01-05', net_qty: 0 }, { week_start: '2026-01-12', net_qty: 0 },
    { week_start: '2026-01-19', net_qty: 2 }, { week_start: '2026-01-26', net_qty: 1 }, { week_start: '2026-02-02', net_qty: 3 },
  ], 'no weeks before records began and no fabricated history');
  assert.equal(steak.portion_funnel, null);
  assert.deepEqual([steak.availability_days, steak.period_days], [7, 7]);
  assert.deepEqual(steak.engagement, { impressions: 0, detail_opens: 0, detail_active_ms_median: null, adds: 0, add_rate: null, submitted_orders: 0, sample_sessions: 0 });

  const coffee = await get(`/api/staff/stats/menu/items/${T.items.coffee}?period=week&anchor=${WM}`);
  assert.deepEqual(coffee.variants.map((v: any) => [v.name.en, v.net_qty]), [['Hot', 1], ['Iced', 1]]);

  // Requests, quotes and confirmations are separate stages; only confirmed cuts are servings.
  const rib = await get(`/api/staff/stats/menu/items/${T.items.rib}?period=week&anchor=${WM}`);
  assert.deepEqual(rib.portion_funnel, { requests: 3, quoted: 2, confirmed: 2, grams_total: 770 });
  assert.equal(rib.weekly.at(-1).net_qty, 2);

  const missing = await owner.get(`/api/staff/stats/menu/items/itm_nope_nope?period=week&anchor=${WM}`);
  assert.equal(missing.status, 404);
});

test('include_fixture=0 excludes demo rows and include_fixture=1 adds them, labelled', async () => {
  const real = await menuStats(`period=week&anchor=${WM}`);
  const demo = await menuStats(`period=week&anchor=${WM}&include_fixture=1`);
  assert.equal(real.include_fixture, false);
  assert.equal(demo.include_fixture, true);
  assert.equal(row(real, T.items.steak).net_qty, 3);
  assert.equal(row(demo, T.items.steak).net_qty, 8);
  assert.equal(demo.rows[0].item_id, T.items.steak);
  assert.equal(demo.totals.net_qty, 16);

  const o = await orderStats(`period=week&anchor=${WM}`);
  const od = await orderStats(`period=week&anchor=${WM}&include_fixture=1`);
  assert.deepEqual([bucket(o, '2026-02-07').value, bucket(od, '2026-02-07').value], [0, 1]);
  assert.deepEqual([o.total, od.total], [6, 7]);
  const dinersReal = await orderStats(`period=week&anchor=${WM}&metric=diners`);
  const dinersDemo = await orderStats(`period=week&anchor=${WM}&metric=diners&include_fixture=1`);
  assert.deepEqual([dinersReal.total, dinersDemo.total], [7, 9]);

  const day = await get('/api/staff/stats/orders/day?date=2026-02-07');
  assert.equal(day.orders.length, 0);
  const dayDemo = await get('/api/staff/stats/orders/day?date=2026-02-07&include_fixture=1');
  assert.equal(dayDemo.orders.length, 1);

  const csv = await owner.get(`/api/staff/stats/export.csv?view=menu&period=week&anchor=${WM}&include_fixture=1`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition') ?? '', /-incl-demo\.csv/);
});

test('stats need stats.view: kitchen, floor and cashier are refused', async () => {
  for (const role of ['kitchen', 'floor', 'cashier'] as const) {
    const c = await srv.staff(role);
    const r = await c.get(`/api/staff/stats/orders?period=week&anchor=${WM}`);
    assert.equal(r.status, 403, role);
    assert.equal(r.body.error.code, 'forbidden');
    const m = await c.get(`/api/staff/stats/menu?period=week&anchor=${WM}`);
    assert.equal(m.status, 403, role);
  }
  const manager = await srv.staff('manager');
  assert.equal((await manager.get(`/api/staff/stats/orders?period=week&anchor=${WM}`)).status, 200);
});
