// Annual archive (brief 40, 41, 43; D-S7-01..06): year rollover, the data
// export, revisions after late corrections, the PDF, and report permissions.
//
// Run from PowerShell: the annual PDF is printed by the installed Edge/Chrome.
// The PDF assertions skip when the job fails with browser_unavailable.
//
// The year-end rollover is the operator command the runner also calls at
// start and every 10 minutes (`npm run jobs -- rollover`), run here against
// this test database while the server keeps serving. Everything else goes
// through the staff API; history the API cannot backdate is planted.
//
// Planted records (Bangkok dates):
//   2025-06-10  R1  T01 covers 2   guest round: 2x soup (with a private note) + steak;
//                                  guest round: iced latte rejected; bill 890 THB paid (payment reference set)
//   2025-12-31  R2  T02 no covers  staff round: prime rib 300 g; bill paid
//   2025-12-31  R3  T04 covers 3   STILL OPEN (a visit spanning New Year): staff round, steak accepted
//   2026-03-05  R4  T03 covers 2   guest round: soup; bill paid
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { key, startServer, type Client, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const NOTE = 'SECRET-NOTE-a1b2 no onions please';
const PAYREF = 'PAYREF-SECRET-77';

let srv: TestServer;
let owner: Client;
let manager: Client;
let kitchen: Client;
let spanningLineId: string;

const bkkDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
const bkk = (date: string, hm: string) => new Date(`${date}T${hm}:00.000+07:00`).toISOString();
const currentYear = () => Number(bkkDate(new Date().toISOString()).slice(0, 4));
const rnd = (n = 8) => randomBytes(n).toString('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ planting
let pseq = 0;
const uid = (p: string) => `${p}_R${(++pseq).toString().padStart(4, '0')}${rnd(3)}`;
function ins(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  srv.exec(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
}

function plantVisit(table: string, seatedAt: string, covers: number | null, open = false): string {
  const id = uid('vis');
  const closedAt = open ? null : new Date(Date.parse(seatedAt) + 2 * 3_600_000).toISOString();
  ins('visits', {
    id, table_id: table, status: open ? 'open' : 'closed', join_pin: null, covers, charges_json: '[]', seated_at: seatedAt,
    seated_business_date: bkkDate(seatedAt), opened_by: 'stf_floor', closed_at: closedAt, closed_by: open ? null : 'stf_cashier',
    close_business_date: closedAt ? bkkDate(closedAt) : null, is_fixture: 0, created_at: seatedAt, updated_at: closedAt ?? seatedAt,
  });
  return id;
}

function plantGuest(visitId: string, at: string): string {
  const id = uid('gst');
  const closedAt = srv.sql<{ closed_at: string | null }>('SELECT closed_at FROM visits WHERE id = ?', [visitId])[0].closed_at;
  ins('guest_sessions', {
    id, visit_id: visitId, token_hash: rnd(32), guest_no: 1, created_at: at, last_seen_at: at,
    revoked_at: closedAt, revoke_reason: closedAt ? 'checkout' : null,
  });
  return id;
}

interface Line { item: string; cat: string; en: string; th: string; unit: number; qty?: number; status: string; grams?: number; note?: string; reason?: string; variant?: string; station?: string }
const SOUP: Omit<Line, 'status'> = { item: T.items.soup, cat: T.categories.grill, en: 'Test Soup', th: 'ซุปทดสอบ', unit: 15000 };
const STEAK: Omit<Line, 'status'> = { item: T.items.steak, cat: T.categories.grill, en: 'Test Striploin', th: 'สันนอกทดสอบที่ชื่อยาวมากเพื่อทดสอบการตัดบรรทัดภาษาไทย', unit: 59000 };
const ICED: Omit<Line, 'status'> = { item: T.items.coffee, cat: T.categories.coffee, en: 'Test Latte', th: 'ลาเต้ทดสอบ', unit: 9000, variant: T.variants.iced, station: 'bar' };
const RIB300: Omit<Line, 'status'> = { item: T.items.rib, cat: T.categories.grill, en: 'Test Prime Rib', th: 'ไพร์มริบทดสอบ', unit: 147000, grams: 300 };

function plantRound(visitId: string, table: string, at: string, source: 'guest' | 'staff', lines: Line[], guest: string | null = null): { id: string; lines: string[] } {
  const id = uid('ord');
  const t = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();
  const label = srv.sql<{ label: string }>('SELECT label FROM dining_tables WHERE id = ?', [table])[0].label;
  const round = srv.sql<{ n: number }>('SELECT COALESCE(MAX(round_no), 0) + 1 AS n FROM orders WHERE visit_id = ?', [visitId])[0].n;
  const accepted = lines.some((l) => l.status !== 'rejected' && l.status !== 'submitted');
  ins('orders', {
    id, reference: `RG-R${pseq}`, visit_id: visitId, table_id: table, table_label: label, round_no: round, source,
    guest_session_id: guest, staff_user_id: source === 'staff' ? 'stf_floor' : null, idempotency_key: uid('att'),
    payload_hash: 'planted', locale: 'th', submitted_at: at, business_date: bkkDate(at),
    subtotal_minor: lines.reduce((s, l) => s + l.unit * (l.qty ?? 1), 0), first_accepted_at: accepted ? t(60) : null,
    is_fixture: 0, updated_at: t(660),
  });
  const ids = lines.map((l, i) => {
    const lid = uid('lin');
    const served = l.status === 'served';
    ins('order_lines', {
      id: lid, order_id: id, visit_id: visitId, line_no: i + 1, item_id: l.item, variant_id: l.variant ?? null, category_id: l.cat,
      name_th: l.th, name_en: l.en, variant_name_en: l.variant ? 'Iced' : null, variant_name_th: l.variant ? 'เย็น' : null,
      station: l.station ?? 'kitchen', prep_kind: l.station === 'bar' ? 'prepare' : 'cook',
      pricing_type: l.grams ? 'measured_weight' : l.variant ? 'variant' : 'fixed', unit_price_minor: l.unit, modifiers_json: '[]',
      modifiers_minor: 0, quantity: l.qty ?? 1, measured_grams: l.grams ?? null, rate_minor: l.grams ? 49000 : null,
      rate_basis_grams: l.grams ? 100 : null, line_total_minor: l.unit * (l.qty ?? 1), note: l.note ?? null, allergy_flag: 0,
      status: l.status, status_reason: l.reason ?? null, submitted_at: at,
      accepted_at: l.status === 'accepted' || served ? t(60) : null, preparing_at: served ? t(120) : null,
      ready_at: served ? t(600) : null, served_at: served ? t(660) : null, rejected_at: l.status === 'rejected' ? t(60) : null,
      is_fixture: 0, updated_at: t(660),
    });
    if (l.status === 'rejected') {
      ins('line_events', { line_id: lid, order_id: id, visit_id: visitId, from_status: 'submitted', to_status: 'rejected', kind: 'reject', actor_type: 'staff', actor_id: 'stf_kitchen', reason: l.reason, created_at: t(60) });
    }
    return lid;
  });
  return { id, lines: ids };
}

function plantPaidBill(visitId: string, total: number, at: string, reference: string | null = null): void {
  const billId = uid('bil');
  const revId = uid('rev');
  ins('bills', { id: billId, visit_id: visitId, status: 'settled', current_revision_id: revId, created_at: at, updated_at: at });
  ins('bill_revisions', {
    id: revId, bill_id: billId, visit_id: visitId, revision_no: 1, status: 'settled', lines_json: '[]', excluded_json: '[]',
    adjustments_json: '[]', subtotal_minor: total, adjustments_minor: 0, charges_json: '[]', total_minor: total,
    finalized_at: at, finalized_by: 'stf_cashier', business_date: bkkDate(at), is_fixture: 0,
  });
  ins('payments', {
    id: uid('pay'), visit_id: visitId, bill_revision_id: revId, kind: 'settlement', method: 'cash', amount_minor: total,
    tendered_minor: total, change_minor: 0, reference, status: 'confirmed', idempotency_key: uid('pk'),
    confirmed_by: 'stf_cashier', confirmed_at: at, business_date: bkkDate(at), is_fixture: 0,
  });
}

const ANALYTICS_SESSION = `ans_report_${rnd(6)}`;

function plantYears(): void {
  const r1 = plantVisit('tbl_T01', bkk('2025-06-10', '19:00'), 2);
  const g1 = plantGuest(r1, bkk('2025-06-10', '19:05'));
  // The guest's phone sent telemetry, and its first round names that session.
  ins('analytics_sessions', {
    id: ANALYTICS_SESSION, kind: 'dining', visit_id: r1, guest_session_id: g1, locale: 'th', opted_out: 0,
    started_at: bkk('2025-06-10', '19:05'), first_join_at: bkk('2025-06-10', '19:05'), last_event_at: bkk('2025-06-10', '19:09'),
    business_date: '2025-06-10', is_fixture: 0,
  });
  for (const [type, extra] of [['menu_view', {}], ['item_impression', { item_id: T.items.soup }], ['cart_add', { item_id: T.items.soup, quantity_delta: 2, quick_add: 1 }]] as const) {
    ins('analytics_events', {
      event_id: `evt_${rnd(8)}`, session_id: ANALYTICS_SESSION, type, visit_id: r1, route: 'menu', client_seq: 1, client_elapsed_ms: 60_000,
      received_at: bkk('2025-06-10', '19:08'), business_date: '2025-06-10', is_fixture: 0, ...extra,
    });
  }
  const first = plantRound(r1, 'tbl_T01', bkk('2025-06-10', '19:10'), 'guest', [{ ...SOUP, qty: 2, status: 'served', note: NOTE }, { ...STEAK, status: 'served' }], g1);
  srv.exec('UPDATE orders SET analytics_session_id = ? WHERE id = ?', [ANALYTICS_SESSION, first.id]);
  plantRound(r1, 'tbl_T01', bkk('2025-06-10', '19:40'), 'guest', [{ ...ICED, status: 'rejected', reason: 'machine broken' }], g1);
  plantPaidBill(r1, 89000, bkk('2025-06-10', '20:50'), PAYREF);

  const r2 = plantVisit('tbl_T02', bkk('2025-12-31', '20:00'), null);
  plantRound(r2, 'tbl_T02', bkk('2025-12-31', '20:10'), 'staff', [{ ...RIB300, status: 'served' }]);
  plantPaidBill(r2, 147000, bkk('2025-12-31', '21:30'));

  const r3 = plantVisit('tbl_T04', '2025-12-31T16:00:00.000Z', 3, true);
  spanningLineId = plantRound(r3, 'tbl_T04', '2025-12-31T16:30:00.000Z', 'staff', [{ ...STEAK, status: 'accepted' }]).lines[0];

  const r4 = plantVisit('tbl_T03', bkk('2026-03-05', '12:00'), 2);
  plantRound(r4, 'tbl_T03', bkk('2026-03-05', '12:10'), 'guest', [{ ...SOUP, status: 'served' }], plantGuest(r4, bkk('2026-03-05', '12:02')));
  plantPaidBill(r4, 15000, bkk('2026-03-05', '13:00'));

  // 2024 holds demo data only: the rollover must not produce a "final" year from it.
  const demo = plantVisit('tbl_T02', bkk('2024-11-20', '19:00'), 2);
  srv.exec('UPDATE visits SET is_fixture = 1 WHERE id = ?', [demo]);
  const demoRound = plantRound(demo, 'tbl_T02', bkk('2024-11-20', '19:10'), 'staff', [{ ...SOUP, status: 'served' }]);
  srv.exec('UPDATE orders SET is_fixture = 1 WHERE id = ?', [demoRound.id]);
  srv.exec('UPDATE order_lines SET is_fixture = 1 WHERE order_id = ?', [demoRound.id]);
}

// ------------------------------------------------------------------ helpers
function runCli(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['server/jobs/cli.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: srv.dbPath, REPORTS_DIR: join(dirname(srv.dbPath), 'reports'), SEED_DEMO: '0', SEED_HISTORY: '0', NODE_ENV: 'test' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`jobs ${args.join(' ')} exited ${code}: ${out}`))));
  });
}

async function get(path: string, who: Client = owner): Promise<any> {
  const r = await who.get(path);
  assert.equal(r.status, 200, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function requestJob(who: Client, body: Record<string, unknown>): Promise<any> {
  const r = await who.post('/api/staff/reports/jobs', body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return r.body;
}

async function waitJob(id: string, timeoutMs = 120_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = await get(`/api/staff/reports/jobs/${id}`);
    if (job.status === 'ready' || job.status === 'failed') return job;
    if (Date.now() > until) throw new Error(`report ${id} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function download(who: Client, id: string): Promise<{ status: number; headers: Headers; bytes: Buffer; json: any }> {
  const cookie = [...who.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${srv.url}/api/staff/reports/jobs/${id}/download`, { headers: { Cookie: cookie } });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(bytes.toString('utf8'));
  return { status: res.status, headers: res.headers, bytes, json };
}

/** Minimal ZIP reader (central directory + raw deflate). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'zip end record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + csize);
    const content = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    assert.equal(content.length, usize, `${name} size`);
    out.set(name, content);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function parseCsv(text: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const src = text.replace(/^﻿/, '');
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); table.push(row); row = []; field = ''; } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); table.push(row); }
  const [headers, ...body] = table;
  return { headers, rows: body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))) };
}

const csvOf = (files: Map<string, Buffer>, name: string) => {
  const f = files.get(name);
  assert.ok(f, `${name} is in the export`);
  return parseCsv(f.toString('utf8'));
};
const sum = (rows: Array<Record<string, string>>, col: string) => rows.reduce((s, r) => s + Number(r[col] || 0), 0);

async function yearStats(year: number): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const m of ['rounds', 'accepted_rounds', 'visits', 'devices', 'diners', 'items']) {
    out[m] = await get(`/api/staff/stats/orders?period=year&anchor=${year}-06-01&metric=${m}`);
  }
  return out;
}

function tableCounts(): Record<string, number> {
  const tables = ['orders', 'order_lines', 'line_events', 'visits', 'guest_sessions', 'bills', 'bill_revisions', 'payments',
    'analytics_sessions', 'analytics_events', 'menu_items', 'menu_categories', 'item_variants', 'dining_tables', 'table_qr_tokens',
    'staff_users', 'availability_log', 'service_requests', 'portion_requests', 'settings'];
  return Object.fromEntries(tables.map((t) => [t, srv.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)[0].n]));
}

/** The year-end rollover, run once and shared: final PDF + final data export for 2025. */
let finals: Promise<{ pdf: any; csv: any; output: string }> | null = null;
function finalReports() {
  finals ??= (async () => {
    const output = await runCli(['rollover']);
    const ids = output.match(/rpt_[A-Z0-9]+/g) ?? [];
    assert.equal(ids.length, 2, output);
    const jobs = await Promise.all(ids.map((id) => get(`/api/staff/reports/jobs/${id}`)));
    const pdf = jobs.find((j) => j.kind === 'annual_pdf');
    const csv = jobs.find((j) => j.kind === 'annual_csv');
    return { pdf: await waitJob(pdf.id), csv: await waitJob(csv.id), output };
  })();
  return finals;
}

before(async () => {
  srv = await startServer();
  owner = await srv.staff('owner');
  manager = await srv.staff('manager');
  kitchen = await srv.staff('kitchen');
  plantYears();
});
after(async () => { await srv?.stop(); });

// ================================================================== rollover
test('the New Year rollover queues final reports for the completed year and deletes nothing, logs nobody out and changes no open order', async () => {
  // A party is dining right now.
  const visit = await srv.openVisit('tbl_T01', 2);
  const guest = await srv.guest('tbl_T01', visit.join_pin);
  const placed = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines: [{ item_id: T.items.soup, quantity: 1, modifiers: [] }], expected_subtotal_minor: 15000 });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));

  const counts0 = tableCounts();
  const lines0 = srv.sql('SELECT id, status, version FROM order_lines ORDER BY id');
  const active0 = srv.sql('SELECT id, status, join_pin, version FROM visits WHERE status <> \'closed\' ORDER BY id');
  const guests0 = srv.sql('SELECT id FROM guest_sessions WHERE revoked_at IS NULL ORDER BY id');
  const jobs0 = srv.sql<{ n: number }>('SELECT COUNT(*) AS n FROM report_jobs')[0].n;

  const { pdf, csv, output } = await finalReports();
  assert.match(output, /queued rpt_/);
  for (const j of [pdf, csv]) {
    assert.deepEqual([j.year, j.label, j.revision, j.include_fixture, j.financial], [2025, 'final', 1, false, true]);
    assert.equal(j.requested_by, 'System (year-end rollover)');
  }
  assert.equal(csv.status, 'ready', csv.error);
  assert.equal(csv.raw_events, true);

  // The current year is only ever provisional.
  const year = currentYear();
  const prov = await requestJob(owner, { year, kind: 'annual_csv' });
  assert.deepEqual([prov.year, prov.label, prov.revision, prov.status], [year, 'provisional', 1, 'queued']);
  assert.equal((await waitJob(prov.id)).status, 'ready');

  // Running the rollover again queues nothing: every completed year has its final jobs.
  assert.match(await runCli(['rollover']), /every completed year already has its final report jobs/);

  assert.deepEqual(tableCounts(), counts0, 'no business record was deleted or added');
  assert.deepEqual(srv.sql('SELECT id, status, version FROM order_lines ORDER BY id'), lines0, 'open orders are untouched');
  assert.deepEqual(srv.sql('SELECT id, status, join_pin, version FROM visits WHERE status <> \'closed\' ORDER BY id'), active0);
  assert.deepEqual(srv.sql('SELECT id FROM guest_sessions WHERE revoked_at IS NULL ORDER BY id'), guests0);
  assert.equal(srv.sql<{ n: number }>('SELECT COUNT(*) AS n FROM report_jobs')[0].n, jobs0 + 3);
  assert.equal((await guest.get('/api/guest/session')).status, 200, 'the dining guest is still signed in');
  const mine = await guest.get('/api/guest/orders');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.orders.map((o: any) => o.status), ['received']);

  const years = (await get('/api/staff/reports/years')).years;
  const y25 = years.find((y: any) => y.year === 2025);
  const now = years.find((y: any) => y.year === year);
  assert.equal(y25.state, 'completed');
  assert.deepEqual(y25.coverage, { first_date: '2025-06-10', last_date: '2025-12-31', order_rounds: 4, visits: 3, telemetry_since: bkk('2025-06-10', '19:05') });
  assert.equal(now.state, 'current');
  const y24 = years.find((y: any) => y.year === 2024);
  assert.ok(y24, 'the demo-only year is listed');
  assert.deepEqual([y24.coverage.order_rounds, y24.fixture_order_rounds, y24.jobs.length], [0, 1, 0], 'but gets no final report');
  assert.ok(now.jobs.some((j: any) => j.id === prov.id && j.label === 'provisional'));
});

// ================================================================== data export
test('the annual data export is a zip of complete CSV files whose totals match the stats year view, with no notes, PINs or tokens', async () => {
  const { csv } = await finalReports();
  assert.equal(csv.status, 'ready', csv.error);

  const denied = await download(kitchen, csv.id);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'forbidden');
  assert.equal((await kitchen.get('/api/staff/reports/years')).status, 403);

  const file = await download(owner, csv.id);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/zip');
  assert.match(file.headers.get('content-disposition') ?? '', /rabbit-grill-annual-data-2025-final-r1\.zip/);
  assert.equal(file.headers.get('x-content-sha256'), sha256(file.bytes));
  assert.equal(file.bytes.length, csv.file_bytes);
  assert.match(file.headers.get('cache-control') ?? '', /no-store/);

  const files = unzip(file.bytes);
  assert.deepEqual([...files.keys()].sort(), [
    'README.txt', 'bills.csv', 'corrections.csv', 'daily.csv', 'engagement_daily.csv', 'engagement_events.csv', 'items_ranking.csv',
    'order_lines.csv', 'orders.csv', 'payments.csv', 'periods.csv', 'portion_requests.csv', 'service_requests.csv', 'visits.csv',
  ]);

  // Totals reconcile with the dashboard's year view of the same (unchanged) data.
  const stats = await yearStats(2025);
  const daily = csvOf(files, 'daily.csv');
  assert.equal(daily.rows.length, 365);
  assert.equal(sum(daily.rows, 'submitted_rounds'), stats.rounds.total);
  assert.equal(sum(daily.rows, 'accepted_rounds'), stats.accepted_rounds.total);
  assert.equal(sum(daily.rows, 'recorded_diners'), stats.diners.total);
  assert.equal(sum(daily.rows, 'items_net'), stats.items.total);
  const seated = stats.diners.buckets.reduce((s: number, b: any) => s + b.breakdown.diners_coverage.visits, 0);
  assert.equal(sum(daily.rows, 'visits_seated'), seated);
  assert.deepEqual([stats.rounds.total, stats.accepted_rounds.total, stats.diners.total, stats.items.total, seated], [4, 3, 5, 5, 3]);
  const byDate = new Map(daily.rows.map((r) => [r.date, r]));
  assert.equal(byDate.get('2025-06-09')!.state, 'before_records');
  assert.deepEqual([byDate.get('2025-06-10')!.state, byDate.get('2025-06-10')!.submitted_rounds, byDate.get('2025-06-10')!.rejected_rounds], ['complete', '2', '1']);
  const periods = csvOf(files, 'periods.csv');
  const yearRow = periods.rows.find((r) => r.period === 'year')!;
  assert.equal(Number(yearRow.ordering_visits_distinct), stats.visits.total);
  assert.equal(Number(yearRow.ordering_devices_distinct), stats.devices.total);
  assert.deepEqual([stats.visits.total, stats.devices.total], [3, 1]);
  assert.equal(csvOf(files, 'orders.csv').rows.length, 4);
  assert.equal(csvOf(files, 'order_lines.csv').rows.length, 5);
  const ribLine = csvOf(files, 'order_lines.csv').rows.find((r) => r.item_id === T.items.rib)!;
  assert.deepEqual([ribLine.quantity, ribLine.measured_grams, ribLine.line_total_minor], ['1', '300', '147000']);
  const ranking = csvOf(files, 'items_ranking.csv');
  assert.ok(!ranking.rows.some((r) => r.item_id === T.items.draft), 'drafts are not ranked');
  assert.equal(csvOf(files, 'payments.csv').rows.length, 2);

  // Engagement rows and the round they led to are joined by a per-export pseudonym, never the session id.
  const attributed = csvOf(files, 'orders.csv').rows.filter((r) => r.analytics_session_ref !== '');
  assert.equal(attributed.length, 1);
  assert.match(attributed[0].analytics_session_ref, /^[0-9a-f]{12}$/);
  assert.match(attributed[0].device_ref, /^[0-9a-f]{12}$/);
  const events = csvOf(files, 'engagement_events.csv');
  assert.equal(events.rows.length, 3);
  assert.ok(events.rows.every((e) => e.session_ref === attributed[0].analytics_session_ref));
  const engDay = csvOf(files, 'engagement_daily.csv').rows.find((r) => r.date === '2025-06-10')!;
  assert.deepEqual([engDay.sessions, engDay.dining_sessions, engDay.item_impressions, engDay.cart_adds], ['1', '1', '1', '1']);

  // Privacy: no note text, payment reference, PIN, token, password or raw session id anywhere.
  const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
  const secrets = [NOTE, 'no onions', PAYREF, 'scrypt$', 'test-password', ANALYTICS_SESSION, ...Object.values(T.tokens),
    ...srv.sql<{ token_hash: string; id: string }>('SELECT token_hash, id FROM guest_sessions').flatMap((g) => [g.token_hash, g.id])];
  for (const s of secrets) assert.ok(!all.includes(s), `export must not contain ${s.slice(0, 12)}…`);
  for (const [name, content] of files) {
    if (!name.endsWith('.csv')) continue;
    const { headers } = parseCsv(content.toString('utf8'));
    for (const h of headers) assert.doesNotMatch(h, /pin|token|password|secret|^note$/i, `${name}: ${h}`);
  }
  assert.ok(!csvOf(files, 'payments.csv').headers.includes('reference'));
  const noted = csvOf(files, 'order_lines.csv').rows.find((r) => r.item_id === T.items.soup)!;
  assert.equal(noted.has_note, '1');
  assert.match(files.get('README.txt')!.toString('utf8'), /Payment references: not needed for reporting/);
});

test('a manager requesting a report gets no payment figures, and neither PINs nor tokens appear in the current-year export', async () => {
  const visit = await srv.openVisit('tbl_T02', 2);
  assert.match(visit.join_pin, /^\d{4}$/);
  const job = await requestJob(manager, { year: currentYear(), kind: 'annual_csv' });
  assert.deepEqual([job.label, job.financial, job.raw_events], ['provisional', false, false]);
  const ready = await waitJob(job.id);
  assert.equal(ready.status, 'ready', ready.error);

  const file = await download(manager, job.id);
  assert.equal(file.status, 200);
  const files = unzip(file.bytes);
  for (const name of ['payments.csv', 'bills.csv', 'engagement_events.csv']) assert.ok(!files.has(name), `${name} needs more than a manager's scope`);
  for (const [name, content] of files) {
    if (!name.endsWith('.csv')) continue;
    for (const h of parseCsv(content.toString('utf8')).headers) assert.doesNotMatch(h, /_minor$/, `${name} must not carry money (${h})`);
  }
  assert.match(files.get('README.txt')!.toString('utf8'), /Money: +excluded/);
  const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
  assert.ok(!all.includes(PAYREF));
  for (const token of Object.values(T.tokens)) assert.ok(!all.includes(token));
  const visits = csvOf(files, 'visits.csv');
  const open = visits.rows.find((r) => r.visit_id === visit.id);
  assert.ok(open, 'the open visit is exported');
  assert.ok(!Object.values(open).includes(visit.join_pin), 'the visit PIN is never exported');

  // The owner may open the manager's copy; the kitchen may not.
  assert.equal((await download(owner, job.id)).status, 200);
  assert.equal((await download(kitchen, job.id)).status, 403);
});

test('a manager cannot download a financial report requested by someone else', async () => {
  const { csv, pdf } = await finalReports();
  const seen = await get(`/api/staff/reports/jobs/${csv.id}`, manager);
  assert.equal(seen.financial, true);
  assert.equal(seen.download_url, null);
  const refused = await download(manager, csv.id);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, 'forbidden');
  assert.equal(refused.json.error.details.permission, 'reports.financial');
  if (pdf.status === 'ready') assert.equal((await download(manager, pdf.id)).status, 403);
  const retry = await manager.post(`/api/staff/reports/jobs/${csv.id}/retry`, {});
  assert.equal(retry.status, 403);
  assert.equal((await download(owner, csv.id)).status, 200);
  const unknown = await download(owner, 'rpt_DOESNOTEXIST0000');
  assert.equal(unknown.status, 404);
  // No public URL: without a staff session the file is not served at all.
  const anonymous = await download(srv.client(), csv.id);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'auth_required');
});

// ================================================================== revisions
test('a late cancellation of a previous-year line bumps the data version and the archive shows the year needs revision', async () => {
  const { csv } = await finalReports();
  const version = () => srv.sql<{ version: number }>('SELECT version FROM report_data_versions WHERE year = 2025')[0]?.version ?? 0;
  const v0 = version();
  assert.equal(csv.data_version, v0);
  let y25 = (await get('/api/staff/reports/years')).years.find((y: any) => y.year === 2025);
  assert.equal(y25.needs_revision, false);

  const line = srv.sql<{ version: number; status: string }>('SELECT version, status FROM order_lines WHERE id = ?', [spanningLineId])[0];
  assert.equal(line.status, 'accepted');
  const cancelled = await manager.post('/api/staff/orders/transition', {
    lines: [{ id: spanningLineId, version: line.version }], to: 'cancelled', reason: 'Guest cancelled; entered after New Year',
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  assert.equal(version(), v0 + 1);
  y25 = (await get('/api/staff/reports/years')).years.find((y: any) => y.year === 2025);
  assert.equal(y25.needs_revision, true);
  assert.equal(y25.data_version, v0 + 1);
  // The dashboards follow the change at once; the round itself still counts as submitted.
  const stats = await yearStats(2025);
  assert.deepEqual([stats.rounds.total, stats.accepted_rounds.total, stats.items.total], [4, 2, 4]);
});

test('a revised report needs a reason, gets label revised and revision 2, and the original file stays downloadable unchanged', async () => {
  const { csv } = await finalReports();
  if (srv.sql<{ status: string }>('SELECT status FROM order_lines WHERE id = ?', [spanningLineId])[0].status !== 'cancelled') {
    // Independent of test order: make the late change here if it has not happened yet.
    const v = srv.sql<{ version: number }>('SELECT version FROM order_lines WHERE id = ?', [spanningLineId])[0].version;
    const r = await manager.post('/api/staff/orders/transition', { lines: [{ id: spanningLineId, version: v }], to: 'cancelled', reason: 'Late cancellation' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  for (const reason of [undefined, '   ']) {
    const refused = await owner.post('/api/staff/reports/jobs', { year: 2025, kind: 'annual_csv', ...(reason !== undefined ? { reason } : {}) });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'validation_failed');
    assert.equal(refused.body.error.details.issues[0].path, 'reason');
  }

  const reason = 'Late cancellation of a 31 Dec 2025 order';
  const revised = await requestJob(owner, { year: 2025, kind: 'annual_csv', reason });
  assert.deepEqual([revised.label, revised.revision, revised.reason, revised.supersedes_job_id], ['revised', 2, reason, csv.id]);
  const done = await waitJob(revised.id);
  assert.equal(done.status, 'ready', done.error);
  const dataVersion = srv.sql<{ version: number }>('SELECT version FROM report_data_versions WHERE year = 2025')[0].version;
  assert.equal(done.data_version, dataVersion);

  const stats = await yearStats(2025);
  const newFile = await download(owner, revised.id);
  assert.equal(newFile.status, 200);
  assert.match(newFile.headers.get('content-disposition') ?? '', /2025-revised-r2\.zip/);
  const newDaily = csvOf(unzip(newFile.bytes), 'daily.csv');
  assert.equal(sum(newDaily.rows, 'accepted_rounds'), stats.accepted_rounds.total);
  assert.equal(sum(newDaily.rows, 'cancelled_rounds'), 1);
  assert.equal(sum(newDaily.rows, 'items_net'), stats.items.total);
  assert.match(unzip(newFile.bytes).get('README.txt')!.toString('utf8'), new RegExp(`revised \\(revision 2\\) - reason: ${reason}`));

  // The original is still there, byte for byte, with its original totals.
  const original = await download(owner, csv.id);
  assert.equal(original.status, 200);
  const storedSha = srv.sql<{ file_sha256: string }>('SELECT file_sha256 FROM report_jobs WHERE id = ?', [csv.id])[0].file_sha256;
  assert.equal(sha256(original.bytes), storedSha);
  assert.notEqual(sha256(newFile.bytes), storedSha);
  const oldDaily = csvOf(unzip(original.bytes), 'daily.csv');
  assert.deepEqual([sum(oldDaily.rows, 'accepted_rounds'), sum(oldDaily.rows, 'cancelled_rounds')], [3, 0]);

  const y25 = (await get('/api/staff/reports/years')).years.find((y: any) => y.year === 2025);
  assert.equal(y25.needs_revision, false);
  const csvJobs = y25.jobs.filter((j: any) => j.kind === 'annual_csv').map((j: any) => [j.label, j.revision, j.download_url !== null]);
  assert.deepEqual(csvJobs.sort(), [['final', 1, true], ['revised', 2, true]]);
});

// ================================================================== PDF
/** Code points a PDF's ToUnicode maps cover, from every Flate stream. */
function pdfText(buf: Buffer): { fontNames: string[]; unicode: Set<number> } {
  const latin = buf.toString('latin1');
  const chunks = [latin];
  for (let i = latin.indexOf('stream'); i !== -1; i = latin.indexOf('stream', i + 6)) {
    if (latin.startsWith('endstream', i - 3)) continue;
    let start = i + 6;
    if (latin[start] === '\r') start++;
    if (latin[start] === '\n') start++;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    try { chunks.push(inflateSync(buf.subarray(start, end)).toString('latin1')); } catch { /* not a Flate stream */ }
    i = end;
  }
  const fontNames = new Set<string>();
  const unicode = new Set<number>();
  const hexChars = (hex: string) => {
    const cps: number[] = [];
    for (let k = 0; k + 4 <= hex.length; k += 4) cps.push(parseInt(hex.slice(k, k + 4), 16));
    return cps;
  };
  for (const c of chunks) {
    for (const m of c.matchAll(/\/FontName\s*\/([A-Za-z0-9+_.-]+)/g)) fontNames.add(m[1]);
    for (const block of c.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) hexChars(m[2]).forEach((cp) => unicode.add(cp));
    }
    for (const block of c.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
        const lo = parseInt(m[1], 16);
        const hi = parseInt(m[2], 16);
        if (m[3]) {
          const base = parseInt(m[3].slice(-4), 16);
          for (let k = 0; k <= hi - lo; k++) unicode.add(base + k);
        } else {
          for (const d of m[4].matchAll(/<([0-9A-Fa-f]+)>/g)) hexChars(d[1]).forEach((cp) => unicode.add(cp));
        }
      }
    }
  }
  return { fontNames: [...fontNames], unicode };
}

/** Only the self-hosted faces are embedded: no glyph fell back to a font installed on the server. */
function assertOwnFontsOnly(fontNames: string[]): void {
  const families = [...new Set(fontNames.map((n) => n.replace(/^[A-Z]{6}\+/, '')))];
  assert.ok(families.some((n) => /^Noto-?Sans-?Thai/i.test(n)), `embedded fonts: ${families.join(', ')}`);
  for (const f of families) assert.match(f, /^(Noto-?Sans-?Thai|Oswald|Cormorant)/i, `system font fallback in the PDF: ${f}`);
}

test('the annual PDF is generated with embedded Noto Sans Thai and real Thai text', async (t) => {
  const { pdf } = await finalReports();
  if (pdf.status === 'failed' && /browser_unavailable/.test(pdf.error ?? '')) {
    t.skip(`no Chromium-family browser to print the PDF: ${pdf.error}`);
    return;
  }
  assert.equal(pdf.status, 'ready', pdf.error);
  assert.ok(pdf.file_bytes > 0);

  const file = await download(owner, pdf.id);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition') ?? '', /rabbit-grill-annual-report-2025-final-r1\.pdf/);
  assert.equal(file.bytes.length, pdf.file_bytes);
  assert.equal(file.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(file.bytes.subarray(-32).toString('latin1'), /%%EOF\s*$/);

  const { fontNames, unicode } = pdfText(file.bytes);
  assertOwnFontsOnly(fontNames);
  // Thai letters from the dish names (and the restaurant name) are real text in the file.
  for (const ch of 'สันนอกทดสอบซุป') assert.ok(unicode.has(ch.codePointAt(0)!), `Thai ${ch} (U+${ch.codePointAt(0)!.toString(16)}) is mapped`);
});

test('an identical request while a report is generating returns the same job, and live ordering is not blocked meanwhile', async (t) => {
  const visit = await srv.openVisit('tbl_T03', 2);
  const guest = await srv.guest('tbl_T03', visit.join_pin);
  const year = currentYear();
  const [a, b] = await Promise.all([
    requestJob(owner, { year, kind: 'annual_pdf' }),
    requestJob(owner, { year, kind: 'annual_pdf' }),
  ]);
  assert.equal(a.id, b.id, 'one job for one scope while it is pending');
  assert.equal(a.label, 'provisional');

  let job = await get(`/api/staff/reports/jobs/${a.id}`);
  const until = Date.now() + 20_000;
  while (job.status === 'queued' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    job = await get(`/api/staff/reports/jobs/${a.id}`);
  }
  if (job.status === 'generating') {
    const started = Date.now();
    const placed = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines: [{ item_id: T.items.soup, quantity: 1, modifiers: [] }], expected_subtotal_minor: 15000 });
    const took = Date.now() - started;
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.ok(took < 2000, `an order took ${took} ms while the PDF was generating`);
    const board = await kitchen.get('/api/staff/orders?scope=active');
    assert.ok(board.body.orders.some((o: any) => o.reference === placed.body.order.reference));
    t.diagnostic(`order placed in ${took} ms while the PDF was generating`);
  } else {
    // The job finished before we could observe it generating: only the dedupe
    // and the PDF itself are proven in this run.
    t.diagnostic(`non-blocking check not exercised: job was already ${job.status}`);
  }
  const done = await waitJob(a.id);
  if (done.status === 'failed' && /browser_unavailable/.test(done.error ?? '')) {
    t.skip(`no Chromium-family browser to print the PDF: ${done.error}`);
    return;
  }
  assert.equal(done.status, 'ready', done.error);
  assert.equal(job.status === 'generating' || job.status === 'ready', true, `observed ${job.status}`);
  // The provisional current-year PDF (live data, open visits) embeds only its own fonts too.
  const file = await download(owner, a.id);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') ?? '', new RegExp(`annual-report-${year}-provisional-r1\\.pdf`));
  assertOwnFontsOnly(pdfText(file.bytes).fontNames);
});
