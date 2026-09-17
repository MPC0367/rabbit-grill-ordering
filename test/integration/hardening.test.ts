// Review fixes on the server (docs/DECISIONS.md, D-S8-*): bill adjustments,
// payment history in the annual snapshot, data retention, request limits,
// session revocation on live streams, PIN and sign-in budgets, demo accounts,
// the availability log and report-data versions.
//
// Every test seats its own party at a table created for it. One trusted proxy
// hop lets each simulated device use its own address.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { Client, key, startServer, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { PASSWORD, T } from '../helpers/fixtures.ts';
import { hashPassword } from '../../server/lib/auth.ts';

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
const nextIp = () => `10.44.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
/** A new device with its own forwarded address. */
function device(ip = nextIp()): Client & { ip: string } {
  const c = srv.client() as Client & { ip: string };
  c.ip = ip;
  const request = c.request.bind(c);
  c.request = (method, path, body, headers = {}) => request(method, path, body, { 'X-Forwarded-For': ip, ...headers });
  return c;
}

let tableSeq = 0;
async function newTable(): Promise<{ id: string; token: string }> {
  const t = ok(await manager.post('/api/staff/tables', { label: `H${++tableSeq}` }), 201);
  const [{ token }] = rows<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [t.id]);
  return { id: t.id, token };
}

async function seat() {
  const table = await newTable();
  const visit = ok(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
  const guest = device();
  ok(await guest.post('/api/public/qr/join', { token: table.token, pin: visit.join_pin }), 201);
  return { table, visit, guest };
}

const SOUP = (quantity = 1) => ({ item_id: T.items.soup, quantity, modifiers: [] }); // 150 THB
const LATTE = (quantity = 1) => ({ item_id: T.items.coffee, variant_id: T.variants.hot, quantity, modifiers: [] }); // 80 THB

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
const adjust = (visitId: string, body: Record<string, unknown>, who: Client = manager) =>
  who.post(`/api/staff/visits/${visitId}/adjustments`, body);

/** Serve, finalize, pay in cash; returns the settlement id. */
async function settle(visitId: string): Promise<string> {
  await serveAll(visitId);
  const b0 = await bill(visitId);
  ok(await floor.post(`/api/staff/visits/${visitId}/billing/start`, { version: b0.visit_version }));
  const b1 = await bill(visitId);
  const fin = ok(await cashier.post(`/api/staff/visits/${visitId}/bill/finalize`, { bill_version: b1.bill_version, expected_total_minor: b1.total_minor }));
  const rev = fin.current_revision;
  const paid = ok(await cashier.post(`/api/staff/visits/${visitId}/payments`, {
    revision_id: rev.id, method: 'cash', amount_minor: rev.total_minor, idempotency_key: key('pay'),
  }));
  return paid.payments.find((p: any) => p.kind === 'settlement' && p.status === 'confirmed').id;
}

function runNode(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: srv.dbPath, REPORTS_DIR: join(dirname(srv.dbPath), 'reports'), SEED_DEMO: '0', SEED_HISTORY: '0', NODE_ENV: 'test' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`${args.join(' ')} exited ${code}: ${out}${err}`))));
  });
}
const snapshot = async (year: number) => JSON.parse(await runNode(['test/integration/snapshot-probe.ts', String(year)]));
const kpiPaid = async (from: string, to: string) => {
  const q = from.endsWith('-01-01') && to.endsWith('-12-31') ? `period=year&anchor=${from}` : `from=${from}&to=${to}`;
  return ok(await owner.get(`/api/staff/stats/kpis?${q}&include_fixture=1`)).totals.paid_minor as number;
};

// ================================================================== bill adjustments
test('a comp linked to a dish is voided when the dish is cancelled, so the rest of the table is not undercharged (D-S8-01)', async () => {
  const { visit, guest } = await seat();
  const placed = await order(guest, [SOUP(), LATTE()], 23_000);
  await move(kitchen, visit.id, 'submitted', 'accepted');
  const soupLine = placed.lines.find((l: any) => l.item_id === T.items.soup).id;

  let b = await bill(visit.id);
  b = ok(await adjust(visit.id, { kind: 'comp', amount_minor: -15_000, reason: 'Soup was cold', order_line_id: soupLine, idempotency_key: key('adj'), bill_version: b.bill_version }));
  assert.deepEqual([b.subtotal_minor, b.adjustments_minor, b.total_minor], [23_000, -15_000, 8_000]);
  assert.equal(b.adjustments.length, 1);

  const line = rows<{ version: number }>('SELECT version FROM order_lines WHERE id = ?', [soupLine])[0];
  ok(await manager.post('/api/staff/orders/transition', { lines: [{ id: soupLine, version: line.version }], to: 'cancelled', reason: 'Never came out' }));
  b = await bill(visit.id);
  assert.deepEqual([b.subtotal_minor, b.adjustments_minor, b.total_minor], [8_000, 0, 8_000], 'only the latte is owed');
  assert.deepEqual(b.adjustments, []);
  assert.equal(b.voided_adjustments.length, 1);
  assert.equal(b.voided_adjustments[0].void_reason, 'Dish cancelled: Never came out');
  assert.equal(b.voided_adjustments[0].voided_by, 'Test manager');
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE visit_id = ? AND action = 'bill.adjust_void'`, [visit.id]), 1);
  assert.equal(ok(await guest.get('/api/guest/bill')).total_minor, 8_000);

  // A comp cannot be linked to a dish that is not on the bill.
  expectError(await adjust(visit.id, { kind: 'comp', amount_minor: -1_000, reason: 'Late comp', order_line_id: soupLine }), 409, 'invalid_transition');

  // Backstop for rows written before the rule: a linked adjustment only counts while its dish is on the bill.
  srv.exec(`INSERT INTO bill_adjustments (id, visit_id, kind, amount_minor, reason, order_line_id, created_by, created_at)
            VALUES (?, ?, 'comp', -5000, 'Legacy comp', ?, 'stf_manager', ?)`, [`adj_legacy_${key('l')}`.slice(0, 60), visit.id, soupLine, new Date().toISOString()]);
  assert.equal((await bill(visit.id)).total_minor, 8_000);
});

test('a manager can void an adjustment entered in error; the bill version must be current (D-S8-01)', async () => {
  const { visit, guest } = await seat();
  await order(guest, [SOUP(2)], 30_000);
  await move(kitchen, visit.id, 'submitted', 'accepted');
  let b = await bill(visit.id);
  b = ok(await adjust(visit.id, { kind: 'discount', amount_minor: -1_000, reason: 'Wrong table', idempotency_key: key('adj'), bill_version: b.bill_version }));
  assert.equal(b.total_minor, 29_000);
  const adj = b.adjustments[0];
  const stale = b.bill_version - 1;
  expectError(await manager.post(`/api/staff/visits/${visit.id}/adjustments/${adj.id}/void`, { bill_version: stale, reason: 'Entered on the wrong table' }), 409, 'stale_version');
  expectError(await cashier.post(`/api/staff/visits/${visit.id}/adjustments/${adj.id}/void`, { bill_version: b.bill_version, reason: 'Entered on the wrong table' }), 403, 'forbidden');
  expectError(await manager.post(`/api/staff/visits/${visit.id}/adjustments/${adj.id}/void`, { bill_version: b.bill_version, reason: 'x' }), 422, 'validation_failed');
  const voided = ok(await manager.post(`/api/staff/visits/${visit.id}/adjustments/${adj.id}/void`, { bill_version: b.bill_version, reason: 'Entered on the wrong table' }));
  assert.equal(voided.total_minor, 30_000);
  assert.equal(voided.voided_adjustments[0].id, adj.id);
  // Voiding again changes nothing.
  const again = ok(await manager.post(`/api/staff/visits/${visit.id}/adjustments/${adj.id}/void`, { bill_version: voided.bill_version, reason: 'Entered on the wrong table' }));
  assert.equal(again.bill_version, voided.bill_version);
  expectError(await manager.post(`/api/staff/visits/${visit.id}/adjustments/adj_unknown_000/void`, { bill_version: voided.bill_version, reason: 'Nope nope' }), 404, 'not_found');
});

test('an adjustment is applied once: retries replay, a reused key is refused, a stale bill is refused (D-S8-01)', async () => {
  const { visit, guest } = await seat();
  await order(guest, [SOUP(2)], 30_000);
  await move(kitchen, visit.id, 'submitted', 'accepted');
  const b = await bill(visit.id);
  const k = key('adj');
  const body = { kind: 'discount', amount_minor: -5_000, reason: 'Regular guest discount', idempotency_key: k, bill_version: b.bill_version };
  // Two tablets (or a timed-out request and its retry) send the same attempt at once.
  const [r1, r2] = await Promise.all([adjust(visit.id, body), adjust(visit.id, body, owner)]);
  assert.deepEqual([r1.status, r2.status], [200, 200], `${show(r1)} ${show(r2)}`);
  assert.equal(ok(await adjust(visit.id, body)).total_minor, 25_000, 'a late replay returns the bill');
  assert.equal(count('SELECT COUNT(*) AS n FROM bill_adjustments WHERE visit_id = ?', [visit.id]), 1);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE visit_id = ? AND action = 'bill.adjust'`, [visit.id]), 1);
  expectError(await adjust(visit.id, { ...body, amount_minor: -6_000 }), 409, 'idempotency_mismatch');

  // A second discount from a screen that has not seen the first one is refused and shows the new bill.
  const d = expectError(await adjust(visit.id, { ...body, idempotency_key: key('adj') }), 409, 'stale_version');
  assert.equal(d.current.adjustments_minor, -5_000);
  assert.equal(count('SELECT COUNT(*) AS n FROM bill_adjustments WHERE visit_id = ?', [visit.id]), 1);

  // Two different discounts from the same bill version: exactly one lands.
  const fresh = await bill(visit.id);
  const race = await Promise.all([1, 2].map((i) => adjust(visit.id, { kind: 'discount', amount_minor: -1_000, reason: `Race ${i}`, idempotency_key: key('adj'), bill_version: fresh.bill_version })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(count('SELECT COUNT(*) AS n FROM bill_adjustments WHERE visit_id = ?', [visit.id]), 2);
});

// ================================================================== payments in the annual snapshot
test('the annual snapshot counts a refund after checkout and a reversal in a later month or year once, matching the KPI paid total (D-S8-03)', async () => {
  const year = Number(bkkDate().slice(0, 4));
  const last = year - 1;

  // Refunded after checkout, today.
  const refunded = await seat();
  await order(refunded.guest, [SOUP()], 15_000);
  const refundedPay = await settle(refunded.visit.id);
  ok(await cashier.post(`/api/staff/visits/${refunded.visit.id}/checkout`, { idempotency_key: key('co') }));
  ok(await manager.post(`/api/staff/payments/${refundedPay}/reverse`, { reason: 'Refunded at the door', idempotency_key: key('rev') }));

  // Settled on 31 August last year, reversed on 1 September.
  const crossMonth = await seat();
  await order(crossMonth.guest, [LATTE()], 8_000);
  const crossMonthPay = await settle(crossMonth.visit.id);
  ok(await manager.post(`/api/staff/payments/${crossMonthPay}/reverse`, { reason: 'Charged twice', idempotency_key: key('rev') }));
  // Settled on 31 December last year, reversed on 1 January this year.
  const crossYear = await seat();
  await order(crossYear.guest, [SOUP(2)], 30_000);
  const crossYearPay = await settle(crossYear.visit.id);
  ok(await manager.post(`/api/staff/payments/${crossYearPay}/reverse`, { reason: 'Wrong card', idempotency_key: key('rev') }));
  const plant = (paymentId: string, settledOn: string, reversedOn: string) => {
    srv.exec('UPDATE payments SET business_date = ?, confirmed_at = ? WHERE id = ?', [settledOn, `${settledOn}T05:00:00.000Z`, paymentId]);
    srv.exec('UPDATE payments SET business_date = ?, confirmed_at = ? WHERE reverses_payment_id = ?', [reversedOn, `${reversedOn}T05:00:00.000Z`, paymentId]);
  };
  plant(crossMonthPay, `${last}-08-31`, `${last}-09-01`);
  plant(crossYearPay, `${last}-12-31`, `${year}-01-01`);

  const now = await snapshot(year);
  assert.equal(now.net_paid_minor, now.settled_minor - now.reversal_minor - now.refund_minor);
  assert.equal(now.net_paid_minor, await kpiPaid(`${year}-01-01`, `${year}-12-31`), 'this year: settlements still in force');
  assert.equal(now.net_paid_minor, 0, 'the one refunded sale nets to zero; the January reversal belongs to last year');
  assert.deepEqual([now.refunds, now.refund_minor], [1, 15_000]);
  const refundRows = now.exceptions.filter((e: any) => e.visit_id === refunded.visit.id);
  assert.deepEqual(refundRows.map((e: any) => e.kind), ['refund_record'], 'listed once, as the refund');
  assert.equal(now.exception_count, 0);

  const prev = await snapshot(last);
  assert.deepEqual([prev.settlements, prev.settled_minor, prev.reversals, prev.reversal_minor, prev.net_paid_minor], [2, 38_000, 2, 38_000, 0]);
  assert.equal(prev.net_paid_minor, await kpiPaid(`${last}-01-01`, `${last}-12-31`));
  for (const m of prev.monthly) assert.equal(m.paid_minor, 0, `${m.key} nets to zero`);
  assert.equal(await kpiPaid(`${last}-08-01`, `${last}-08-31`), 0);
  assert.deepEqual(prev.exceptions.filter((e: any) => e.kind === 'reversed').map((e: any) => e.amount_minor).sort((a: number, b: number) => a - b), [8_000, 30_000]);
});

test('settling or reversing a bill finalized in an earlier year marks that year as changed (D-S8-03)', async () => {
  const last = Number(bkkDate().slice(0, 4)) - 1;
  const version = () => rows<{ version: number }>('SELECT version FROM report_data_versions WHERE year = ?', [last])[0]?.version ?? 0;
  const { visit, guest } = await seat();
  await order(guest, [SOUP()], 15_000);
  await serveAll(visit.id);
  const b0 = await bill(visit.id);
  ok(await floor.post(`/api/staff/visits/${visit.id}/billing/start`, { version: b0.visit_version }));
  const b1 = await bill(visit.id);
  const rev = ok(await cashier.post(`/api/staff/visits/${visit.id}/bill/finalize`, { bill_version: b1.bill_version, expected_total_minor: 15_000 })).current_revision;
  srv.exec('UPDATE bill_revisions SET business_date = ? WHERE id = ?', [`${last}-12-31`, rev.id]);
  const v0 = version();
  const paid = ok(await cashier.post(`/api/staff/visits/${visit.id}/payments`, { revision_id: rev.id, method: 'cash', amount_minor: 15_000, idempotency_key: key('pay') }));
  assert.equal(version(), v0 + 1);
  ok(await manager.post(`/api/staff/payments/${paid.payments[0].id}/reverse`, { reason: 'Wrong amount keyed', idempotency_key: key('rev') }));
  assert.equal(version(), v0 + 2);
});

// ================================================================== retention
test('the retention task removes old notes, comments, raw events and audit rows, keeps totals, and records its run (D-S8-02)', async () => {
  const { visit, guest } = await seat();
  const placed = await order(guest, [{ ...SOUP(), note: 'No coriander please', allergy_note: true }], 15_000);
  await move(kitchen, visit.id, 'submitted', 'accepted');
  ok(await guest.post('/api/guest/service', { type: 'call_staff', note: 'Please bring a high chair', idempotency_key: key('svc') }), 201);
  ok(await guest.post('/api/guest/feedback', { rating: 4, comment: 'Lovely ribs', idempotency_key: key('fb') }), 201);
  const old = '2020-01-06';
  srv.exec('UPDATE orders SET business_date = ? WHERE visit_id = ?', [old, visit.id]);
  srv.exec('UPDATE service_requests SET business_date = ? WHERE visit_id = ?', [old, visit.id]);
  srv.exec('UPDATE feedback SET business_date = ? WHERE visit_id = ?', [old, visit.id]);
  const session = `ans_ret_${key('s')}`.slice(0, 60);
  srv.exec(`INSERT INTO analytics_sessions (id, kind, started_at, last_event_at, business_date) VALUES (?, 'public', '2020-01-06T05:00:00.000Z', '2020-01-06T05:00:00.000Z', ?)`, [session, old]);
  for (const [i, type] of ['item_impression', 'cart_add', 'menu_view'].entries()) {
    srv.exec(`INSERT INTO analytics_events (event_id, session_id, type, route, item_id, received_at, business_date) VALUES (?, ?, ?, 'menu', ?, '2020-01-06T05:00:00.000Z', ?)`,
      [`evt_ret_${i}_${key('e')}`.slice(0, 60), session, type, type === 'menu_view' ? null : T.items.steak, old]);
  }
  srv.exec(`INSERT INTO audit_events (actor_type, action, entity_type, created_at) VALUES ('system', 'test.ancient', 'test', '2012-01-01T00:00:00.000Z')`);
  srv.exec(`INSERT INTO staff_sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, 'stf_floor', '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z', '2019-01-02T00:00:00.000Z')`, [`sess_${key('x')}`]);
  const ordersBefore = count('SELECT COUNT(*) AS n FROM orders');
  const statsYear = async () => ok(await owner.get('/api/staff/stats/orders?period=year&anchor=2020-06-01&metric=items&include_fixture=1')).total;
  const itemsBefore = await statsYear();
  assert.equal(itemsBefore, 1);
  const notesBefore = (await snapshot(2020)).lines_with_note;
  assert.equal(notesBefore, 1);

  const dry = await runNode(['server/jobs/cli.ts', 'retention', '--dry-run']);
  assert.match(dry, /would remove/);
  assert.equal(rows('SELECT note FROM order_lines WHERE id = ?', [placed.lines[0].id])[0].note, 'No coriander please', 'a dry run changes nothing');

  const out = await runNode(['server/jobs/cli.ts', 'retention']);
  const result = JSON.parse(out.slice(out.indexOf('{')));
  assert.ok(result.order_line_notes >= 1 && result.service_request_notes >= 1 && result.feedback_comments >= 1, out);
  assert.ok(result.raw_events >= 3 && result.audit_entries >= 1 && result.staff_sessions >= 1, out);

  const [line] = rows('SELECT note, note_removed_at, allergy_flag FROM order_lines WHERE id = ?', [placed.lines[0].id]);
  assert.equal(line.note, null);
  assert.ok(line.note_removed_at);
  assert.equal(line.allergy_flag, 1, 'the allergy flag stays');
  assert.deepEqual(rows('SELECT note FROM service_requests WHERE visit_id = ?', [visit.id]), [{ note: null }]);
  assert.deepEqual(rows('SELECT rating, comment FROM feedback WHERE visit_id = ?', [visit.id]), [{ rating: 4, comment: null }]);
  assert.equal(count('SELECT COUNT(*) AS n FROM analytics_events WHERE session_id = ?', [session]), 0);
  // The day's item totals were built before its raw events went.
  assert.deepEqual(rows('SELECT impressions, adds FROM agg_item_daily WHERE business_date = ? AND item_id = ?', [old, T.items.steak]), [{ impressions: 1, adds: 1 }]);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'test.ancient'`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'retention.run'`), 1);

  // Nothing that reports count was removed.
  assert.equal(count('SELECT COUNT(*) AS n FROM orders'), ordersBefore);
  assert.equal(await statsYear(), itemsBefore);
  assert.equal((await snapshot(2020)).lines_with_note, 1, 'a removed note still counts as a line with a note');

  const view = ok(await owner.get('/api/staff/settings'));
  assert.ok(view.retention_status.last_run_at);
  assert.ok(view.retention_status.raw_events_purged_through >= old);
  const eng = ok(await owner.get('/api/staff/stats/engagement?from=2020-01-01&to=2020-01-31'));
  assert.equal(eng.coverage.note === 'raw_events_retention' || eng.coverage.note === 'no_telemetry', true, eng.coverage.note);

  // Running again removes nothing more.
  const again = JSON.parse((await runNode(['server/jobs/cli.ts', 'retention'])).replace(/^[^{]*/, ''));
  assert.deepEqual([again.order_line_notes, again.feedback_comments, again.raw_events], [0, 0, 0]);
});

// ================================================================== request limits
/**
 * POST a raw body and read the reply. The server answers 413 from the
 * Content-Length header without reading the body and may close the socket
 * while the upload is still going, so write errors are ignored once a reply
 * has arrived.
 */
function postRaw(c: Client & { ip?: string }, path: string, body: string): Promise<{ status: number; json: any }> {
  const url = new URL(srv.url + path);
  return new Promise((res, rej) => {
    let answered = false;
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-RG-Client': '1',
        ...(c.ip ? { 'X-Forwarded-For': c.ip } : {}),
        ...(c.cookies.size ? { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
    }, (reply) => {
      answered = true;
      let text = '';
      reply.on('data', (d) => { text += d; });
      reply.on('end', () => res({ status: reply.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      reply.on('error', () => res({ status: reply.statusCode ?? 0, json: null }));
    });
    req.on('error', (err) => { if (!answered) rej(err); });
    req.end(body);
  });
}

test('oversized request bodies are refused before they are read (D-S8-09)', async () => {
  const { table, visit } = await seat();
  const wrongPin = String((Number(visit.join_pin) + 1) % 10000).padStart(4, '0');
  const failures = () => rows<{ pin_failures: number }>('SELECT pin_failures FROM visits WHERE id = ?', [visit.id])[0].pin_failures;
  const big = await postRaw(device(), '/api/public/qr/join', JSON.stringify({ token: table.token, pin: wrongPin, pad: 'x'.repeat(1024 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'payload_too_large');
  assert.equal(failures(), 0, 'the oversized join was never processed');
  const staffBig = await postRaw(manager, '/api/staff/orders/transition', JSON.stringify({ lines: [{ id: 'oln_x', version: 1 }], to: 'accepted', reason: 'y'.repeat(300 * 1024) }));
  assert.equal(staffBig.status, 413);
  // A normal-sized request still works, and the menu import keeps its larger allowance.
  expectError(await device().post('/api/public/qr/join', { token: table.token, pin: wrongPin }), 401, 'pin_invalid');
  const thai = 'ชื่อ,สลัดผักรวมกับซอสบัลซามิก\n'.repeat(20_000); // about 1.8 MB of UTF-8
  assert.ok(Buffer.byteLength(thai) > 1_500_000);
  const preview = await owner.post('/api/staff/menu/import/preview', { filename: 'menu.csv', csv: thai });
  assert.notEqual(preview.status, 413, show(preview));
});

// ================================================================== live streams
async function openStream(c: Client) {
  const ctrl = new AbortController();
  const res = await fetch(`${srv.url}/api/staff/events`, {
    headers: { Accept: 'text/event-stream', Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  let text = '';
  let ended = false;
  const done = (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; stream so far:\n${text}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return {
    text: () => text,
    ended: () => ended,
    until,
    close: async () => { ctrl.abort(); await done; },
  };
}

test('a staff live stream ends as soon as the account is deactivated, signed out or its role changes (D-S8-08)', async () => {
  const makeUser = async (role: string) => {
    const username = `sse-${role}-${++tableSeq}`;
    const created = ok(await owner.post('/api/staff/team', { username, display_name: `SSE ${role}`, role, password: 'correct-horse-9' }), 201);
    const c = srv.client();
    ok(await c.post('/api/staff/auth/login', { username, password: 'correct-horse-9' }));
    return { id: created.id as string, c, version: created.version as number };
  };

  const cashierUser = await makeUser('cashier');
  const s1 = await openStream(cashierUser.c);
  await s1.until(() => s1.text().includes('event: hello'), 'hello');
  ok(await owner.patch(`/api/staff/team/${cashierUser.id}`, { active: false, version: cashierUser.version }));
  await s1.until(() => s1.ended(), 'the stream to end after deactivation');
  assert.match(s1.text(), /event: access\ndata: {"state":"ended"}/);
  // Nothing created after the deactivation reached the stream.
  const { visit } = await seat();
  ok(await floor.patch(`/api/staff/visits/${visit.id}`, { covers: 3, version: ok(await floor.get(`/api/staff/visits/${visit.id}`)).version }));
  assert.doesNotMatch(s1.text(), new RegExp(visit.id));
  await s1.close();

  // A manager demoted to kitchen: the stream (which carried bill. topics) ends.
  const mgr = await makeUser('manager');
  const s2 = await openStream(mgr.c);
  await s2.until(() => s2.text().includes('event: hello'), 'hello');
  ok(await owner.patch(`/api/staff/team/${mgr.id}`, { role: 'kitchen', version: mgr.version }));
  await s2.until(() => s2.ended(), 'the stream to end after the role change');
  await s2.close();

  // Signing out ends the stream of that session.
  const flr = await makeUser('floor');
  const s3 = await openStream(flr.c);
  await s3.until(() => s3.text().includes('event: hello'), 'hello');
  ok(await flr.c.post('/api/staff/auth/logout', {}));
  await s3.until(() => s3.ended(), 'the stream to end after sign-out');
  assert.match(s3.text(), /event: access\ndata: {"state":"ended"}/);
  await s3.close();

  // A permission change keeps the session: the stream asks the client to reconnect for the new topics.
  const other = await makeUser('cashier');
  const s4 = await openStream(other.c);
  await s4.until(() => s4.text().includes('event: hello'), 'hello');
  ok(await owner.patch('/api/staff/settings', { role_permissions: { 'billing.adjust': ['owner', 'manager', 'cashier'] } }));
  try {
    await s4.until(() => s4.ended(), 'the stream to end after the permission change');
    assert.match(s4.text(), /event: access\ndata: {"state":"changed"}/);
    const s5 = await openStream(other.c);
    await s5.until(() => s5.text().includes('event: hello'), 'a new stream with the new permissions');
    await s5.close();
  } finally {
    ok(await owner.patch('/api/staff/settings', { role_permissions: {} }));
  }
  await s4.close();
});

// ================================================================== PIN and sign-in budgets
test('join-PIN lockouts escalate and the third holds until staff rotate the PIN (D-S8-07)', async () => {
  const table = await newTable();
  const visit = ok(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
  const wrong = String((Number(visit.join_pin) + 3) % 10000).padStart(4, '0');
  const join = (pin: string) => device().post('/api/public/qr/join', { token: table.token, pin });
  const lockOut = async () => {
    for (let i = 1; i < 5; i++) expectError(await join(wrong), 401, 'pin_invalid');
    return expectError(await join(wrong), 423, 'pin_locked');
  };
  const expire = () => srv.exec('UPDATE visits SET pin_locked_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), visit.id]);

  assert.deepEqual(await lockOut(), { until: (await lockDetails()).until, retry_after_seconds: 300, staff_unlock_required: false });
  expire();
  assert.equal((await lockOut()).retry_after_seconds, 900, 'the second lockout lasts three times as long');
  expire();
  const third = await lockOut();
  assert.deepEqual(third, { until: null, retry_after_seconds: null, staff_unlock_required: true });
  const right = expectError(await join(visit.join_pin), 423, 'pin_locked');
  assert.equal(right.staff_unlock_required, true, 'even the right PIN waits for staff');

  const detail = ok(await floor.get(`/api/staff/visits/${visit.id}`));
  assert.deepEqual([detail.pin_lock_requires_rotation, detail.pin_locked_until], [true, null]);
  const tile = ok(await floor.get('/api/staff/tables')).tables.find((t: any) => t.id === table.id);
  assert.equal(tile.visit.pin_locked, true);

  const rotated = ok(await floor.post(`/api/staff/visits/${visit.id}/rotate-pin`, { version: detail.version }));
  assert.deepEqual([rotated.pin_lock_requires_rotation, rotated.pin_locked_until], [false, null]);
  assert.equal(rows<{ n: number }>('SELECT pin_lockouts AS n FROM visits WHERE id = ?', [visit.id])[0].n, 0);
  ok(await join(rotated.join_pin), 201);
  // The count starts again: the next lockout is a short one.
  assert.equal((await lockOut()).retry_after_seconds, 300);

  async function lockDetails() {
    const until = rows<{ pin_locked_until: string }>('SELECT pin_locked_until FROM visits WHERE id = ?', [visit.id])[0].pin_locked_until;
    return { until };
  }
});

test('failed sign-ins look the same for known and unknown usernames, and a guesser elsewhere does not lock the tablet out (D-S8-10)', async () => {
  const attacker = nextIp();
  const tablet = nextIp();
  const login = (username: string, password: string, ip: string) =>
    srv.client().request('POST', '/api/staff/auth/login', { username, password }, { 'X-Forwarded-For': ip });
  for (const username of ['cashier', 'nobody-here']) {
    for (let i = 0; i < 5; i++) expectError(await login(username, 'wrong-password', attacker), 401, 'invalid_credentials');
    const sixth = await login(username, 'wrong-password', attacker);
    expectError(sixth, 429, 'rate_limited');
    assert.ok(sixth.body.error.details.retry_after_seconds > 0);
  }
  // The real cashier, on the restaurant tablet, still signs in.
  ok(await login('cashier', PASSWORD('cashier'), tablet));
  // The account lock (20 failures from anywhere) answers like a rate limit, never "account locked".
  srv.exec('UPDATE staff_users SET locked_until = ? WHERE id = ?', [new Date(Date.now() + 60_000).toISOString(), 'stf_kitchen']);
  try {
    const locked = await login('kitchen', PASSWORD('kitchen'), nextIp());
    expectError(locked, 429, 'rate_limited');
  } finally {
    srv.exec('UPDATE staff_users SET locked_until = NULL WHERE id = ?', ['stf_kitchen']);
  }
});

test('a busy seating wave behind one address can join; only failed joins use the address budget (D-S8-10)', async () => {
  const shared = nextIp();
  const tables = await Promise.all([1, 2, 3, 4].map(() => newTable()));
  for (const t of tables) {
    const v = ok(await floor.post(`/api/staff/tables/${t.id}/visits`, { covers: 3, idempotency_key: key('open') }), 201);
    for (let phone = 0; phone < 4; phone++) ok(await device(shared).post('/api/public/qr/join', { token: t.token, pin: v.join_pin }), 201);
  }
  for (let i = 0; i < 10; i++) expectError(await device(shared).post('/api/public/qr/join', { token: `qr_nope_${i}_zzzzzzzzzzzz`, pin: '1234' }), 404, 'qr_invalid');
  expectError(await device(shared).post('/api/public/qr/join', { token: tables[0].token, pin: '1234' }), 429, 'rate_limited');
});

// ================================================================== demo accounts
test('demo staff accounts cannot sign in to a live restaurant, and going live switches them off (D-S8-11)', async () => {
  srv.exec(`INSERT INTO staff_users (id, username, display_name, role, password_hash, active, is_fixture, created_at, updated_at)
            VALUES ('usr_demo_cashier', 'demo-cashier', 'Demo cashier', 'cashier', ?, 1, 1, ?, ?)`,
  [hashPassword('rabbit-cashier-demo'), new Date().toISOString(), new Date().toISOString()]);
  const demoLogin = () => srv.client().request('POST', '/api/staff/auth/login', { username: 'demo-cashier', password: 'rabbit-cashier-demo' }, { 'X-Forwarded-For': nextIp() });
  try {
    expectError(await demoLogin(), 401, 'invalid_credentials');

    ok(await owner.patch('/api/staff/settings', { operating_mode: 'demo' }));
    const demo = srv.client();
    ok(await demo.request('POST', '/api/staff/auth/login', { username: 'demo-cashier', password: 'rabbit-cashier-demo' }, { 'X-Forwarded-For': nextIp() }));
    ok(await demo.get('/api/staff/auth/me'));

    const refused = expectError(await owner.patch('/api/staff/settings', { operating_mode: 'live' }), 409, 'demo_accounts_active');
    assert.deepEqual(refused.usernames, ['demo-cashier']);
    expectError(await owner.patch('/api/staff/settings', { operating_mode: 'live', deactivate_demo_staff: 'yes' }), 422, 'validation_failed');
    assert.equal(ok(await owner.get('/api/staff/settings')).settings.operating_mode, 'demo');

    const live = ok(await owner.patch('/api/staff/settings', { operating_mode: 'live', deactivate_demo_staff: true }));
    assert.equal(live.settings.operating_mode, 'live');
    assert.equal(rows<{ active: number }>(`SELECT active FROM staff_users WHERE id = 'usr_demo_cashier'`)[0].active, 0);
    expectError(await demo.get('/api/staff/auth/me'), 401, 'auth_required');
    expectError(await demoLogin(), 401, 'invalid_credentials');
    assert.equal(count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'team.deactivate' AND entity_id = 'usr_demo_cashier'`), 1);
  } finally {
    if (ok(await owner.get('/api/staff/settings')).settings.operating_mode !== 'live') {
      srv.exec(`UPDATE staff_users SET active = 0 WHERE id = 'usr_demo_cashier'`);
      ok(await owner.patch('/api/staff/settings', { operating_mode: 'live' }));
    }
  }
});

// ================================================================== availability log
test('switching alcohol off or the operating mode is written to the availability log (D-S8-12)', async () => {
  const logRows = (itemId: string) => rows<{ available: number; reason: string }>(
    `SELECT available, reason FROM availability_log WHERE item_id = ? AND reason = 'settings' ORDER BY id`, [itemId]);
  ok(await owner.patch('/api/staff/settings', { alcohol: { enabled: false } }));
  try {
    assert.deepEqual(logRows(T.items.wine), [{ available: 0, reason: 'settings' }]);
    assert.deepEqual(logRows(T.items.soup), [], 'dishes without alcohol are untouched');
  } finally {
    ok(await owner.patch('/api/staff/settings', { alcohol: { enabled: true } }));
  }
  assert.deepEqual(logRows(T.items.wine), [{ available: 0, reason: 'settings' }, { available: 1, reason: 'settings' }]);
  // A setting that does not change orderability writes nothing.
  ok(await owner.patch('/api/staff/settings', { service_cooldown_seconds: 0 }));
  assert.equal(logRows(T.items.wine).length, 2);
});

// ================================================================== permissions and cards
test('staff without "see prices on orders" get no amounts from the order API (D-S8-17)', async () => {
  const { visit, guest } = await seat();
  const placed = await order(guest, [SOUP(2)], 30_000);
  const k = ok(await kitchen.get(`/api/staff/orders/${placed.id}`));
  assert.equal(k.money_hidden, true);
  assert.deepEqual([k.subtotal_minor, k.lines[0].unit_price_minor, k.lines[0].line_total_minor], [0, 0, 0]);
  const moved = ok(await kitchen.post('/api/staff/orders/transition', { lines: [{ id: k.lines[0].id, version: k.lines[0].version }], to: 'accepted' }));
  assert.equal(moved.orders[0].money_hidden, true);
  assert.equal(moved.orders[0].lines[0].line_total_minor, 0);
  const f = ok(await floor.get(`/api/staff/orders/${placed.id}`));
  assert.deepEqual([f.money_hidden, f.subtotal_minor], [undefined, 30_000]);
  // The owner can grant the permission; the server follows the setting.
  ok(await owner.patch('/api/staff/settings', { role_permissions: { 'orders.view_bill_values': ['owner', 'manager', 'cashier', 'floor', 'kitchen'] } }));
  try {
    assert.equal(ok(await kitchen.get(`/api/staff/orders/${placed.id}`)).subtotal_minor, 30_000);
  } finally {
    ok(await owner.patch('/api/staff/settings', { role_permissions: {} }));
  }
  assert.equal(visit.status, 'open');
});

test('the QR print batch says when its address only works on this computer (D-S8-09)', async () => {
  const table = await newTable();
  const cards = ok(await manager.get(`/api/staff/tables/qr-cards?ids=${table.id}`));
  assert.equal(cards.qr_base_is_local, true, 'the test server prints http://127.0.0.1 cards');
  assert.equal(cards.qr_base_url, srv.url);
});

// ================================================================== guest access races
test('a guest revoked while an order is still uploading creates nothing (D-S8-08)', async () => {
  const { visit, guest } = await seat();
  const body = JSON.stringify({ idempotency_key: key('att'), lines: [SOUP()], expected_subtotal_minor: 15_000 });
  const url = new URL(srv.url);
  const half = Math.floor(body.length / 2);
  const reply = new Promise<{ status: number; text: string }>((res, rej) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: '/api/guest/orders', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-RG-Client': '1',
        Cookie: [...guest.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'X-Forwarded-For': guest.ip,
      },
    }, (res2) => {
      let text = '';
      res2.on('data', (d) => { text += d; });
      res2.on('end', () => res({ status: res2.statusCode ?? 0, text }));
    });
    req.on('error', rej);
    req.write(body.slice(0, half));
    (async () => {
      const detail = ok(await floor.get(`/api/staff/visits/${visit.id}`));
      ok(await floor.post(`/api/staff/visits/${visit.id}/revoke-guests`, { version: detail.version, reason: 'Wrong party joined' }));
      req.end(body.slice(half));
    })().catch(rej);
  });
  const r = await reply;
  assert.equal(r.status, 401, r.text);
  assert.equal(JSON.parse(r.text).error.code, 'visit_access_revoked');
  assert.equal(count('SELECT COUNT(*) AS n FROM orders WHERE visit_id = ?', [visit.id]), 0);
});
