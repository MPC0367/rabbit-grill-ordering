// Table access and visit isolation (brief 07, 29, 30, 31 scenarios 5 and 6; D-04, D-13, D-18, D-19).
//
// Every request is real HTTP against a real server. Each phone is a `Device`
// with its own client address, so the per-address join limit applies per
// device as it would on the restaurant Wi-Fi (TRUST_PROXY_HOPS=1 trusts the
// X-Forwarded-For the device sends). One test proves that limit itself.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, key, startServer, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';
import type {
  CheckoutResultDTO, GuestBillDTO, OrderDTO, PortionRequestDTO, QrResolveDTO, ServiceRequestDTO, StaffBillDTO,
  StaffOrderDTO, TableTileDTO, TablesDTO, VisitDetailDTO,
} from '../../shared/dto.ts';

let srv: TestServer;
// LOG_REQUESTS=1 so the secrets test can prove request logging never carries tokens or PINs.
before(async () => { srv = await startServer({ env: { TRUST_PROXY_HOPS: '1', LOG_REQUESTS: '1' } }); });
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ devices and helpers
let deviceNo = 0;
class Device extends Client {
  ip: string;
  constructor(base: string, ip?: string) {
    super(base);
    deviceNo++;
    this.ip = ip ?? `10.20.${Math.floor(deviceNo / 200)}.${(deviceNo % 200) + 1}`;
  }
  override request<R = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<R>> {
    return super.request<R>(method, path, body, { 'X-Forwarded-For': this.ip, ...headers });
  }
  override clone(): Device {
    const c = new Device(this.base, this.ip);
    c.cookies = new Map(this.cookies);
    return c;
  }
}
const device = () => new Device(srv.url);

const SOUP = [{ item_id: T.items.soup, quantity: 1, modifiers: [] }];
const submitSoup = (c: Client, idempotencyKey = key('att')) =>
  c.post('/api/guest/orders', { idempotency_key: idempotencyKey, lines: SOUP, expected_subtotal_minor: 15000 });

function expectError(r: HttpResult, status: number, code: string, what = '') {
  assert.equal(r.status, status, `${what} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error?.code, code, `${what} ${JSON.stringify(r.body)}`);
}

const resolveQr = (c: Client, token: unknown) => c.post<QrResolveDTO>('/api/public/qr/resolve', { token });
const joinQr = (c: Client, token: unknown, pin?: string | null) =>
  c.post('/api/public/qr/join', { token, ...(pin !== undefined && pin !== null ? { pin } : {}) });

async function joinedDevice(token: string, pin: string): Promise<Device> {
  const d = device();
  const r = await joinQr(d, token, pin);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return d;
}

/** A fresh table created through the API, with its printed QR token. */
async function newTable(label: string): Promise<{ id: string; token: string; version: number }> {
  const manager = await srv.staff('manager');
  const r = await manager.post<TableTileDTO>('/api/staff/tables', { label });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.id, token: await currentToken(manager, r.body.id), version: r.body.version };
}

async function currentToken(staff: Client, tableId: string): Promise<string> {
  const cards = await staff.get<{ cards: Array<{ url: string }> }>(`/api/staff/tables/qr-cards?ids=${tableId}`);
  assert.equal(cards.status, 200, JSON.stringify(cards.body));
  return decodeURIComponent(new URL(cards.body.cards[0].url).pathname.split('/q/')[1]);
}

async function visitDetail(staff: Client, visitId: string): Promise<VisitDetailDTO> {
  const r = await staff.get<VisitDetailDTO>(`/api/staff/visits/${visitId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function serveAll(staff: Client, orderId: string) {
  for (const to of ['accepted', 'preparing', 'ready', 'served']) {
    const cur = await staff.get<StaffOrderDTO>(`/api/staff/orders/${orderId}`);
    const r = await staff.post('/api/staff/orders/transition', { lines: cur.body.lines.map((l) => ({ id: l.id, version: l.version })), to });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

/** The real checkout path: start checkout, finalize, cash payment, complete checkout. */
async function checkout(visitId: string): Promise<CheckoutResultDTO> {
  const cashier = await srv.staff('cashier');
  const v = await visitDetail(cashier, visitId);
  const started = await cashier.post<StaffBillDTO>(`/api/staff/visits/${visitId}/billing/start`, { version: v.version });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const fin = await cashier.post<StaffBillDTO>(`/api/staff/visits/${visitId}/bill/finalize`, {
    bill_version: started.body.bill_version, expected_total_minor: started.body.total_minor,
  });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const rev = fin.body.current_revision!;
  const paid = await cashier.post<StaffBillDTO>(`/api/staff/visits/${visitId}/payments`, {
    revision_id: rev.id, method: 'cash', amount_minor: rev.total_minor, tendered_minor: rev.total_minor, idempotency_key: key('pay'),
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.paid, true);
  const done = await cashier.post<CheckoutResultDTO>(`/api/staff/visits/${visitId}/checkout`, { idempotency_key: key('co') });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body;
}

const count = (query: string, params: unknown[] = []) => Number(srv.sql<{ n: number }>(query, params)[0].n);

// ------------------------------------------------------------------ SSE reader
interface SseEvent { event: string; id: string | null; data: any }
interface SseConn {
  status: number;
  body: any;
  events: SseEvent[];
  raw(): string;
  /** Resolves when the server ends the stream (or after close()). */
  ended: Promise<void>;
  waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  close(): Promise<void>;
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { event, id, data: parsed };
}

/** Open an SSE stream with the client's cookies and read it in the background. */
async function openStream(c: Client, path: string): Promise<SseConn> {
  const ac = new AbortController();
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (c.cookies.size) headers.Cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(srv.url + path, { headers, signal: ac.signal });
  const events: SseEvent[] = [];
  let raw = '';
  const waitFor = async (pred: (e: SseEvent) => boolean, ms = 5000) => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > until) throw new Error(`SSE event not received within ${ms} ms; got ${JSON.stringify(events.map((e) => [e.event, e.data?.topic]))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  if (res.status !== 200 || !res.body) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep */ }
    return { status: res.status, body, events, raw: () => text, ended: Promise.resolve(), waitFor, close: async () => {} };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const ended = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        raw += chunk;
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const ev = parseFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (ev) events.push(ev);
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    }
  })();
  return {
    status: res.status,
    body: null,
    events,
    raw: () => raw,
    ended,
    waitFor,
    close: async () => { ac.abort(); await ended.catch(() => {}); },
  };
}

// ------------------------------------------------------------------ state matrix: no valid authorization
test('no valid authorization: the public menu works, every guest endpoint answers 401 and a public visitor cannot order', async () => {
  const visitor = device();
  const menu = await visitor.get('/api/public/menu');
  assert.equal(menu.status, 200);
  const ids = menu.body.items.map((i: { id: string }) => i.id);
  assert.ok(ids.includes(T.items.steak));
  assert.ok(!ids.includes(T.items.draft), 'drafts are never public');
  const config = await visitor.get('/api/public/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.operating_mode, 'live');

  const before = count('SELECT count(*) n FROM orders');
  const requestsBefore = count('SELECT count(*) n FROM service_requests');
  const guestCalls: Array<[string, string, unknown?]> = [
    ['GET', '/api/guest/session'],
    ['GET', '/api/guest/orders'],
    ['GET', `/api/guest/orders/attempts/${key('att')}`],
    ['GET', '/api/guest/service'],
    ['GET', '/api/guest/bill'],
    ['GET', '/api/guest/portions'],
    ['GET', '/api/guest/events/poll?since=0'],
    ['POST', '/api/guest/quote', { lines: SOUP }],
    ['POST', '/api/guest/orders', { idempotency_key: key('att'), lines: SOUP, expected_subtotal_minor: 15000 }],
    ['POST', '/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }],
    ['POST', '/api/guest/bill/request', { idempotency_key: key('bill') }],
    ['POST', '/api/guest/portions', { item_id: T.items.rib, idempotency_key: key('por') }],
    ['POST', '/api/guest/feedback', { rating: 5, idempotency_key: key('fb') }],
  ];
  // A signed-in staff browser is not a guest either.
  const staffBrowser = await srv.staff('owner');
  for (const who of [visitor, staffBrowser]) {
    for (const [method, path, body] of guestCalls) {
      expectError(await who.request(method, path, body), 401, 'visit_access_required', `${method} ${path}`);
    }
    const stream = await openStream(who, '/api/guest/events');
    expectError({ status: stream.status, body: stream.body, headers: new Headers() }, 401, 'visit_access_required', 'SSE');
  }
  assert.equal(count('SELECT count(*) n FROM orders'), before, 'no order was created');
  assert.equal(count('SELECT count(*) n FROM service_requests'), requestsBefore);

  // Leaving without a membership is harmless.
  const leave = await visitor.post('/api/guest/leave');
  assert.equal(leave.status, 200);
});

// ------------------------------------------------------------------ copied QR, malformed, disabled, empty
test('copied permanent QR: the token alone reveals nothing private and cannot join or order', async () => {
  const t = await newTable('Copied QR');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const pin = visit.join_pin!;
  const photo = device();

  const scan = await resolveQr(photo, t.token);
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body, { table_label: 'Copied QR', state: 'ready', pin_required: true, already_joined: false });

  expectError(await joinQr(photo, t.token), 401, 'pin_required');
  expectError(await joinQr(photo, t.token, ''), 401, 'pin_required', 'an empty PIN is no PIN');
  const wrong = String((Number(pin) + 1) % 10000).padStart(4, '0');
  const bad = await joinQr(photo, t.token, wrong);
  expectError(bad, 401, 'pin_invalid');
  assert.equal(bad.body.error.details.attempts_left, 4);
  // A typing error is not counted as a guess.
  expectError(await joinQr(photo, t.token, '12ab'), 422, 'validation_failed');
  assert.equal(count('SELECT pin_failures n FROM visits WHERE id = ?', [visit.id]), 1);
  assert.equal(photo.cookies.has('rg_guest'), false);

  // Presenting the QR token itself as a guest credential does not work.
  const forged = device();
  forged.cookies.set('rg_guest', t.token);
  expectError(await forged.get('/api/guest/orders'), 401, 'visit_access_required');
  expectError(await submitSoup(forged), 401, 'visit_access_required');
  expectError(await submitSoup(photo), 401, 'visit_access_required');

  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE visit_id = ?', [visit.id]), 0);
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id]), 0);
});

test('malformed or unknown QR tokens answer qr_invalid on resolve and join', async () => {
  const cases: unknown[] = [
    undefined, '', 'short', 'x'.repeat(129), 'has spaces and symbols!!', 1234567890123456, { token: 'nested' },
    'qr_unknown_but_well_formed_token_zzzzzzzzzz',
  ];
  for (const token of cases) {
    const d = device();
    expectError(await resolveQr(d, token), 404, 'qr_invalid', `resolve ${JSON.stringify(token)}`);
    expectError(await joinQr(d, token, '1234'), 404, 'qr_invalid', `join ${JSON.stringify(token)}`);
    assert.equal(d.cookies.has('rg_guest'), false);
  }
  // A body that is not JSON at all.
  for (const path of ['/api/public/qr/resolve', '/api/public/qr/join']) {
    const res = await fetch(srv.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RG-Client': '1', 'X-Forwarded-For': device().ip },
      body: '{not json',
    });
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error.code, 'qr_invalid');
  }
});

test('join attempts are rate limited per client address', async () => {
  const d = device();
  for (let i = 0; i < 10; i++) {
    expectError(await joinQr(d, `qr_unknown_rate_limit_token_${i}_zzzzzz`, '1234'), 404, 'qr_invalid', `attempt ${i + 1}`);
  }
  const limited = await joinQr(d, T.tokens.tbl_T01, '1234');
  expectError(limited, 429, 'rate_limited');
  assert.ok(limited.body.error.details.retry_after_seconds > 0);
  // Another phone at the restaurant is unaffected.
  expectError(await joinQr(device(), 'qr_unknown_rate_limit_token_other_zzzz', '1234'), 404, 'qr_invalid');
  // Scanning (resolve) has its own, larger budget.
  const scanner = device();
  for (let i = 0; i < 30; i++) assert.equal((await resolveQr(scanner, T.tokens.tbl_T04)).status, 200, `scan ${i + 1}`);
  expectError(await resolveQr(scanner, T.tokens.tbl_T04), 429, 'rate_limited');
});

test('a table with no open visit resolves to no_open_visit and refuses joins, including after its visit closes', async () => {
  const t = await newTable('Empty Table');
  const d = device();
  const scan = await resolveQr(d, t.token);
  assert.deepEqual(scan.body, { table_label: 'Empty Table', state: 'no_open_visit', pin_required: true, already_joined: false });
  expectError(await joinQr(d, t.token), 409, 'no_open_visit');
  expectError(await joinQr(d, t.token, '1234'), 409, 'no_open_visit');

  // A party that leaves without ordering is checked out straight from dining.
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const guest = await joinedDevice(t.token, visit.join_pin!);
  const cashier = await srv.staff('cashier');
  const done = await cashier.post<CheckoutResultDTO>(`/api/staff/visits/${visit.id}/checkout`, { idempotency_key: key('co') });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.table.state, 'available');

  const after = await resolveQr(guest.clone(), t.token);
  assert.deepEqual(after.body, { table_label: 'Empty Table', state: 'no_open_visit', pin_required: true, already_joined: false });
  expectError(await guest.clone().get('/api/guest/session'), 410, 'visit_closed');
  expectError(await joinQr(guest.clone(), t.token, visit.join_pin!), 409, 'no_open_visit');
});

test('a disabled table refuses joins and new rounds while its seated party keeps its orders and bill', async () => {
  const t = await newTable('Disabled Table');
  const manager = await srv.staff('manager');
  const floor = await srv.staff('floor');
  const patch = async (enabled: boolean, version: number) => {
    const r = await manager.patch<TableTileDTO>(`/api/staff/tables/${t.id}`, { enabled, version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  let tile = await patch(false, t.version);
  assert.equal(tile.state, 'disabled');
  const d = device();
  const scan = await resolveQr(d, t.token);
  assert.deepEqual(scan.body, { table_label: 'Disabled Table', state: 'disabled', pin_required: true, already_joined: false });
  expectError(await joinQr(d, t.token, '1234'), 403, 'table_disabled');
  expectError(await floor.post(`/api/staff/tables/${t.id}/visits`, { covers: 2, idempotency_key: key('open') }), 403, 'table_disabled');

  tile = await patch(true, tile.version);
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const member = await joinedDevice(t.token, visit.join_pin!);
  assert.equal((await submitSoup(member)).status, 201);
  tile = (await manager.get<TablesDTO>('/api/staff/tables')).body.tables.find((x) => x.id === t.id)!;
  tile = await patch(false, tile.version);

  // The seated party still sees its round and bill, but cannot add to it.
  const again = await resolveQr(member, t.token);
  assert.deepEqual(again.body, { table_label: 'Disabled Table', state: 'disabled', pin_required: false, already_joined: true });
  const session = await member.get('/api/guest/session');
  assert.equal(session.status, 200);
  assert.deepEqual(session.body.ordering, { allowed: false, reason: 'table_disabled' });
  const orders = await member.get<{ orders: OrderDTO[] }>('/api/guest/orders');
  assert.equal(orders.status, 200);
  assert.equal(orders.body.orders.length, 1);
  assert.equal((await member.get<GuestBillDTO>('/api/guest/bill')).status, 200);
  expectError(await submitSoup(member), 403, 'table_disabled');
  // Nobody new joins, even with the right PIN.
  expectError(await joinQr(device(), t.token, visit.join_pin!), 403, 'table_disabled');
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id]), 1);
  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE visit_id = ?', [visit.id]), 1);
});

// ------------------------------------------------------------------ QR rotation, PIN lockout, revocation
test('QR rotation: the old printed token answers qr_disabled, joined guests keep access and the new card works', async () => {
  const t = await newTable('Rotated QR');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const member = await joinedDevice(t.token, visit.join_pin!);
  const manager = await srv.staff('manager');
  const floor = await srv.staff('floor');
  const tile = (await manager.get<TablesDTO>('/api/staff/tables')).body.tables.find((x) => x.id === t.id)!;

  expectError(await floor.post(`/api/staff/tables/${t.id}/rotate-qr`, { version: tile.version, reason: 'card photographed' }), 403, 'forbidden');
  const rotated = await manager.post<TableTileDTO>(`/api/staff/tables/${t.id}/rotate-qr`, { version: tile.version, reason: 'card photographed' });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.qr?.reprint_required, true);

  // Every card printed before is dead - distinct from an unknown code.
  expectError(await resolveQr(device(), t.token), 403, 'qr_disabled');
  expectError(await joinQr(device(), t.token, visit.join_pin!), 403, 'qr_disabled');

  // The party already seated keeps its access (it belongs to the visit, not the card).
  assert.equal((await member.get('/api/guest/session')).status, 200);
  assert.equal((await submitSoup(member)).status, 201);

  const fresh = await currentToken(manager, t.id);
  assert.notEqual(fresh, t.token);
  const scan = await resolveQr(device(), fresh);
  assert.equal(scan.body.state, 'ready');
  const newcomer = await joinedDevice(fresh, visit.join_pin!);
  assert.equal((await newcomer.get('/api/guest/session')).body.visit.id, visit.id);

  const tokens = srv.sql<{ active: number; revoked_at: string | null }>('SELECT active, revoked_at FROM table_qr_tokens WHERE table_id = ? ORDER BY created_at', [t.id]);
  assert.equal(tokens.length, 2);
  assert.equal(tokens.filter((x) => x.active === 1).length, 1);
  assert.ok(tokens.find((x) => x.active === 0)?.revoked_at);
});

test('PIN lockout: repeated wrong PINs lock joining, even the right PIN waits, until staff rotate the PIN', async () => {
  const t = await newTable('Lockout');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const pin = visit.join_pin!;
  const wrong = String((Number(pin) + 1) % 10000).padStart(4, '0');

  // Guesses from different phones count against the same visit.
  for (let i = 1; i <= 4; i++) {
    const r = await joinQr(device(), t.token, wrong);
    expectError(r, 401, 'pin_invalid', `guess ${i}`);
    assert.equal(r.body.error.details.attempts_left, 5 - i);
  }
  expectError(await joinQr(device(), t.token, 'x1y2'), 422, 'validation_failed');
  assert.equal(count('SELECT pin_failures n FROM visits WHERE id = ?', [visit.id]), 4, 'a malformed PIN is not a guess');

  const locked = await joinQr(device(), t.token, wrong);
  expectError(locked, 423, 'pin_locked');
  assert.ok(Date.parse(locked.body.error.details.until) > Date.now());
  assert.equal(locked.body.error.details.retry_after_seconds, 300);

  const right = await joinQr(device(), t.token, pin);
  expectError(right, 423, 'pin_locked', 'the right PIN also waits');
  assert.ok(right.body.error.details.retry_after_seconds > 0);
  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE visit_id = ?', [visit.id]), 0);
  assert.equal(count(`SELECT count(*) n FROM audit_events WHERE action = 'visit.pin_locked' AND entity_id = ?`, [visit.id]), 1);

  const floor = await srv.staff('floor');
  const detail = await visitDetail(floor, visit.id);
  assert.ok(detail.pin_locked_until);
  const rotated = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit.id}/rotate-pin`, { version: detail.version });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.pin_locked_until, null);
  const newPin = rotated.body.join_pin!;
  assert.notEqual(newPin, pin);

  expectError(await joinQr(device(), t.token, pin), 401, 'pin_invalid', 'the replaced PIN');
  const guest = await joinedDevice(t.token, newPin);
  assert.equal((await submitSoup(guest)).status, 201);
});

test('racing joins and racing wrong PINs: every phone gets its own membership and no guess goes uncounted', async () => {
  const t = await newTable('Join Race');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const phones = Array.from({ length: 6 }, () => device());
  const joins = await Promise.all(phones.map((p) => joinQr(p, t.token, visit.join_pin!)));
  assert.deepEqual(joins.map((r) => r.status), [201, 201, 201, 201, 201, 201]);
  assert.equal(new Set(joins.map((r) => r.body.guest_id)).size, 6);
  assert.equal(new Set(phones.map((p) => p.cookies.get('rg_guest'))).size, 6);
  const nos = srv.sql<{ guest_no: number }>('SELECT guest_no FROM guest_sessions WHERE visit_id = ? ORDER BY guest_no', [visit.id]);
  assert.deepEqual(nos.map((r) => r.guest_no), [1, 2, 3, 4, 5, 6]);

  const t2 = await newTable('Guess Race');
  const visit2: VisitDetailDTO = await srv.openVisit(t2.id);
  const wrong = String((Number(visit2.join_pin) + 7) % 10000).padStart(4, '0');
  const guesses = await Promise.all(Array.from({ length: 8 }, () => joinQr(device(), t2.token, wrong)));
  const codes = guesses.map((r) => r.body.error.code);
  assert.equal(codes.filter((c) => c === 'pin_invalid').length, 4, codes.join());
  assert.equal(codes.filter((c) => c === 'pin_locked').length, 4, codes.join());
  expectError(await joinQr(device(), t2.token, visit2.join_pin!), 423, 'pin_locked');
});

test('a PIN lockout lasts lockout_minutes, after which the right PIN joins again', async () => {
  const t = await newTable('Lock Expiry');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const pin = visit.join_pin!;
  const wrong = String((Number(pin) + 5) % 10000).padStart(4, '0');
  for (let i = 1; i <= 4; i++) expectError(await joinQr(device(), t.token, wrong), 401, 'pin_invalid');
  expectError(await joinQr(device(), t.token, wrong), 423, 'pin_locked');
  expectError(await joinQr(device(), t.token, pin), 423, 'pin_locked');
  // Five minutes pass (planted: the API cannot move time).
  srv.exec('UPDATE visits SET pin_locked_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), visit.id]);
  const guest = await joinedDevice(t.token, pin);
  assert.equal((await guest.get('/api/guest/session')).body.visit.id, visit.id);
  // The counter restarted: a new wrong guess has the full allowance minus one.
  const again = await joinQr(device(), t.token, wrong);
  expectError(again, 401, 'pin_invalid');
  assert.equal(again.body.error.details.attempts_left, 4);
});

test('PINs switched off then on again: a PIN-less visit admits nobody new until staff rotate a PIN', async () => {
  const owner = await srv.staff('owner');
  const setPins = async (on: boolean) => {
    const r = await owner.patch('/api/staff/settings', { join: { pin_required: on } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settings.join.pin_required, on);
  };
  const t = await newTable('No PIN');
  const first = device();
  let opened: VisitDetailDTO | null = null;
  await setPins(false);
  try {
    opened = (await srv.openVisit(t.id)) as VisitDetailDTO;
    assert.equal(opened.join_pin, null);
    const scan = await resolveQr(device(), t.token);
    assert.equal(scan.body.pin_required, false);
    const joined = await joinQr(first, t.token);
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
  } finally {
    await setPins(true); // other tests in this file expect the default
  }
  const visit = opened!;

  const newcomer = device();
  assert.equal((await resolveQr(newcomer, t.token)).body.pin_required, true);
  for (const pin of [undefined, '1234']) {
    const r = await joinQr(newcomer, t.token, pin);
    expectError(r, 401, 'pin_required', `pin ${pin}`);
    assert.equal(r.body.error.details.reason, 'no_pin_set');
  }
  assert.equal(count('SELECT pin_failures n FROM visits WHERE id = ?', [visit.id]), 0, 'no guess can match a PIN that does not exist');
  // The guest who joined earlier keeps access.
  assert.equal((await first.get('/api/guest/session')).status, 200);
  assert.deepEqual((await resolveQr(first, t.token)).body, { table_label: 'No PIN', state: 'ready', pin_required: false, already_joined: true });

  const floor = await srv.staff('floor');
  const rot = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit.id}/rotate-pin`, { version: (await visitDetail(floor, visit.id)).version });
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  assert.match(rot.body.join_pin ?? '', /^\d{4}$/);
  assert.equal((await joinQr(newcomer, t.token, rot.body.join_pin!)).status, 201);
});

test('leaving ends only this browser\'s membership; the other guests at the table keep theirs', async () => {
  const t = await newTable('Leave');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const leaver = await joinedDevice(t.token, visit.join_pin!);
  const stays = await joinedDevice(t.token, visit.join_pin!);
  const staleTab = leaver.clone();

  const left = await leaver.post('/api/guest/leave');
  assert.equal(left.status, 200);
  assert.equal(leaver.cookies.has('rg_guest'), false);
  expectError(await staleTab.get('/api/guest/orders'), 401, 'visit_access_revoked', 'another tab of the device that left');
  expectError(await submitSoup(leaver), 401, 'visit_access_required');
  assert.equal((await stays.get('/api/guest/session')).status, 200);
  assert.equal((await submitSoup(stays)).status, 201);

  const floor = await srv.staff('floor');
  const detail = await visitDetail(floor, visit.id);
  assert.deepEqual(detail.guests.map((g) => [g.label, g.revoked]), [['Guest 1', true], ['Guest 2', false]]);
  assert.equal(srv.sql('SELECT revoke_reason FROM guest_sessions WHERE visit_id = ? AND guest_no = 1', [visit.id])[0].revoke_reason, 'guest_left');
  // Coming back needs the PIN again.
  expectError(await joinQr(leaver, t.token), 401, 'pin_required');
  assert.equal((await joinQr(leaver, t.token, visit.join_pin!)).status, 201);
});

test('a guest session older than GUEST_SESSION_HOURS no longer grants access', async () => {
  const t = await newTable('Expired');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const guest = await joinedDevice(t.token, visit.join_pin!);
  assert.equal((await guest.get('/api/guest/session')).status, 200);
  // The session was issued 13 hours ago (planted; the default lifetime is 12 h).
  srv.exec('UPDATE guest_sessions SET created_at = ? WHERE visit_id = ?', [new Date(Date.now() - 13 * 3_600_000).toISOString(), visit.id]);
  expectError(await guest.get('/api/guest/orders'), 401, 'visit_access_required');
  expectError(await submitSoup(guest), 401, 'visit_access_required');
  assert.deepEqual((await resolveQr(guest, t.token)).body, { table_label: 'Expired', state: 'ready', pin_required: true, already_joined: false });
  expectError(await joinQr(guest, t.token), 401, 'pin_required');
  assert.equal((await joinQr(guest, t.token, visit.join_pin!)).status, 201);
  assert.equal((await guest.get('/api/guest/session')).status, 200);
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id]), 0);
});

test('rotated PIN and revoked guests: old credentials are refused, the stream ends, and rejoining needs the current PIN', async () => {
  const t = await newTable('Revoked');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const pin1 = visit.join_pin!;
  const first = await joinedDevice(t.token, pin1);
  assert.equal((await submitSoup(first)).status, 201);
  const floor = await srv.staff('floor');

  // Rotating the PIN keeps joined guests, but the old PIN admits nobody new.
  const rot = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit.id}/rotate-pin`, { version: (await visitDetail(floor, visit.id)).version });
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  const pin2 = rot.body.join_pin!;
  assert.notEqual(pin2, pin1);
  assert.ok(rot.body.pin_rotated_at);
  assert.equal((await first.get('/api/guest/session')).status, 200);
  expectError(await joinQr(device(), t.token, pin1), 401, 'pin_invalid');
  const second = await joinedDevice(t.token, pin2);

  // Revoke everyone (e.g. a QR photo and PIN were shared).
  const stream = await openStream(first, '/api/guest/events');
  assert.equal(stream.status, 200);
  await stream.waitFor((e) => e.event === 'hello');
  const rev = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit.id}/revoke-guests`, { version: rot.body.version, reason: 'QR photo shared' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const pin3 = rev.body.join_pin!;
  assert.notEqual(pin3, pin2);
  assert.deepEqual(rev.body.guests.map((g) => g.revoked), [true, true]);
  const ended = await stream.waitFor((e) => e.event === 'access');
  assert.deepEqual(ended.data, { state: 'ended' });
  await Promise.race([stream.ended, new Promise((_, rej) => setTimeout(() => rej(new Error('stream stayed open')), 3000))]);
  await stream.close();

  for (const who of [first, second]) {
    for (const [method, path, body] of [
      ['GET', '/api/guest/orders'], ['GET', '/api/guest/bill'], ['POST', '/api/guest/orders', { idempotency_key: key('att'), lines: SOUP, expected_subtotal_minor: 15000 }],
      ['POST', '/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }],
    ] as Array<[string, string, unknown?]>) {
      const tab = who.clone();
      const r = await tab.request(method, path, body);
      expectError(r, 401, 'visit_access_revoked', `${method} ${path}`);
      assert.equal(tab.cookies.has('rg_guest'), false, 'the revoked cookie is cleared');
    }
    const gone = await openStream(who, '/api/guest/events');
    expectError({ status: gone.status, body: gone.body, headers: new Headers() }, 401, 'visit_access_revoked', 'SSE');
  }
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id]), 1);
  assert.equal(count(`SELECT count(*) n FROM service_requests WHERE visit_id = ?`, [visit.id]), 0);

  // Once the cookie is cleared the browser is simply not a member any more.
  const session = await first.get('/api/guest/session');
  expectError(session, 401, 'visit_access_revoked');
  expectError(await first.get('/api/guest/session'), 401, 'visit_access_required');
  const scan = await resolveQr(first, t.token);
  assert.deepEqual(scan.body, { table_label: 'Revoked', state: 'ready', pin_required: true, already_joined: false });

  // Rejoin through current staff-provided access only.
  expectError(await joinQr(first, t.token), 401, 'pin_required');
  for (const stale of [pin1, pin2].filter((p) => p !== pin3)) expectError(await joinQr(first, t.token, stale), 401, 'pin_invalid');
  const rejoin = await joinQr(first, t.token, pin3);
  assert.equal(rejoin.status, 201, JSON.stringify(rejoin.body));
  assert.equal(rejoin.body.visit.id, visit.id);
  const again = await submitSoup(first);
  assert.equal(again.status, 201);
  const list = await first.get<{ orders: OrderDTO[] }>('/api/guest/orders');
  assert.deepEqual(list.body.orders.map((o) => o.round_no), [1, 2], 'the table history continues for the same visit');
  assert.equal(list.body.orders[1].mine, true);
  const sessions = srv.sql<{ guest_no: number; revoked: number }>(
    'SELECT guest_no, revoked_at IS NOT NULL AS revoked FROM guest_sessions WHERE visit_id = ? ORDER BY guest_no', [visit.id]);
  assert.deepEqual(sessions.map((s) => [s.guest_no, s.revoked]), [[1, 1], [2, 1], [3, 0]]);
});

test('access secrets (PINs, guest cookies, QR tokens) never reach audit rows, event payloads, staff history or request logs', async () => {
  const t = await newTable('Secrets');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const floor = await srv.staff('floor');
  const manager = await srv.staff('manager');
  const pins = [visit.join_pin!];
  const wrong = String((Number(pins[0]) + 3) % 10000).padStart(4, '0');
  const guest = await joinedDevice(t.token, pins[0]);
  const guestToken = guest.cookies.get('rg_guest')!;
  expectError(await joinQr(device(), t.token, wrong), 401, 'pin_invalid');
  assert.equal((await submitSoup(guest)).status, 201);
  const rot = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit.id}/rotate-pin`, { version: (await visitDetail(floor, visit.id)).version });
  pins.push(rot.body.join_pin!);
  const rev = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit.id}/revoke-guests`, { version: rot.body.version, reason: 'secrets test' });
  pins.push(rev.body.join_pin!);
  const tile = (await manager.get<TablesDTO>('/api/staff/tables')).body.tables.find((x) => x.id === t.id)!;
  assert.equal((await manager.post(`/api/staff/tables/${t.id}/rotate-qr`, { version: tile.version, reason: 'secrets test' })).status, 200);
  const newToken = await currentToken(manager, t.id);
  const tokens = [t.token, newToken, guestToken];

  // Stored credentials are hashes, never the cookie value.
  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE token_hash = ?', [guestToken]), 0);

  const audit = srv.sql<{ text: string }>(
    `SELECT COALESCE(before_json,'') || ' ' || COALESCE(after_json,'') || ' ' || COALESCE(reason,'') AS text FROM audit_events`).map((r) => r.text).join('\n');
  const events = srv.sql<{ text: string }>('SELECT payload AS text FROM events').map((r) => r.text).join('\n');
  // Request log lines (the startup banner lists ports and addresses, not requests).
  const logs = srv.logs().split('\n').filter((l) => !l.startsWith('[server]')).join('\n');
  assert.match(logs, /POST \/api\/public\/qr\/join 201/, 'request logging is on for this server');
  const history = JSON.stringify((await visitDetail(manager, visit.id)).history);
  for (const [where, text] of Object.entries({ audit, events, logs, history })) {
    for (const s of tokens) assert.ok(!text.includes(s), `${where} contains a token`);
    // A PIN would appear as a JSON string value, or as a bare number in a log line
    // (JSON text is not searched for bare digits: timestamps contain them by chance).
    for (const p of [...pins, wrong]) {
      assert.ok(!text.includes(`"${p}"`), `${where} contains a PIN`);
      if (where === 'logs') assert.doesNotMatch(text, new RegExp(`\\b${p}\\b`), 'the request log contains a PIN');
    }
  }
});

// ------------------------------------------------------------------ scenario 5: tampering
test('scenario 5: a T01 guest cannot read or change T02 orders, bill, service or portions by id, and staff endpoints refuse guest cookies', async () => {
  const visitA: VisitDetailDTO = await srv.openVisit('tbl_T01');
  const visitB: VisitDetailDTO = await srv.openVisit('tbl_T02');
  const a = await joinedDevice(T.tokens.tbl_T01, visitA.join_pin!);
  const b = await joinedDevice(T.tokens.tbl_T02, visitB.join_pin!);
  const kitchen = await srv.staff('kitchen');

  // T02's private activity.
  const keyB = key('attB');
  const linesB = [{ item_id: T.items.coffee, variant_id: T.variants.hot, quantity: 2, modifiers: [], note: 'T02 private note' }];
  const orderB = await b.post('/api/guest/orders', { idempotency_key: keyB, lines: linesB, expected_subtotal_minor: 16000 });
  assert.equal(orderB.status, 201, JSON.stringify(orderB.body));
  const oB: OrderDTO = orderB.body.order;
  const svcB = await b.post<ServiceRequestDTO>('/api/guest/service', { type: 'call_staff', note: 'T02 service secret', idempotency_key: key('svc') });
  assert.equal(svcB.status, 201, JSON.stringify(svcB.body));
  const porB = await b.post<PortionRequestDTO>('/api/guest/portions', { item_id: T.items.rib, preferred_grams: 300, idempotency_key: key('por') });
  assert.equal(porB.status, 201, JSON.stringify(porB.body));
  const quoted = await kitchen.post<PortionRequestDTO>(`/api/staff/portions/${porB.body.id}/quote`, { grams: 320, version: porB.body.version });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  const quoteB = quoted.body.quote!;
  assert.equal(quoteB.amount_minor, 156800);

  // T01's own round.
  const orderA = await submitSoup(a);
  assert.equal(orderA.status, 201);
  const oA: OrderDTO = orderA.body.order;

  const secrets = [visitB.id, oB.id, oB.reference, svcB.body.id, porB.body.id, quoteB.id, 'T02 private note', 'T02 service secret'];
  // (Table labels and PINs are not searched for: '2026-09-17T02:..' timestamps and ids can contain them by chance.)
  const assertNoLeak = (r: HttpResult, what: string) => {
    const text = JSON.stringify(r.body);
    for (const s of secrets) assert.ok(!text.includes(s), `${what} leaks ${s}`);
  };

  // Reads show only T01.
  const listA = await a.get<{ orders: OrderDTO[]; portions: PortionRequestDTO[] }>('/api/guest/orders');
  assert.deepEqual(listA.body.orders.map((o) => o.id), [oA.id]);
  assert.deepEqual(listA.body.portions, []);
  assertNoLeak(listA, 'orders');
  const attempt = await a.get(`/api/guest/orders/attempts/${keyB}`);
  assert.deepEqual(attempt.body, { status: 'not_found' });
  const billA = await a.get<GuestBillDTO>('/api/guest/bill');
  assert.equal(billA.body.table_label, 'T01');
  assert.deepEqual(billA.body.pending_lines.map((l) => l.order_reference), [oA.reference]);
  assertNoLeak(billA, 'bill');
  const svcA = await a.get<{ requests: ServiceRequestDTO[] }>('/api/guest/service');
  assert.deepEqual(svcA.body.requests, []);
  const porA = await a.get<{ requests: PortionRequestDTO[] }>('/api/guest/portions');
  assert.deepEqual(porA.body.requests, []);
  const sessionA = await a.get('/api/guest/session');
  assert.equal(sessionA.body.visit.id, visitA.id);
  assertNoLeak(sessionA, 'session');

  // Mutations by another table's ids are simply "not found" and change nothing.
  const pc = await a.post(`/api/guest/portions/${porB.body.id}/confirm`, { quote_id: quoteB.id, revision: quoteB.revision, idempotency_key: key('pc') });
  expectError(pc, 404, 'not_found', 'confirm');
  assertNoLeak(pc, 'confirm');
  expectError(await a.post(`/api/guest/portions/${porB.body.id}/decline`, { quote_id: quoteB.id, revision: quoteB.revision }), 404, 'not_found', 'decline');
  expectError(await a.post(`/api/guest/portions/${porB.body.id}/cancel`), 404, 'not_found', 'cancel');
  assert.equal(srv.sql('SELECT status FROM portion_requests WHERE id = ?', [porB.body.id])[0].status, 'quoted');
  assert.equal(srv.sql('SELECT status FROM portion_quotes WHERE id = ?', [quoteB.id])[0].status, 'active');
  assert.equal(count('SELECT count(*) n FROM order_lines WHERE portion_quote_id = ?', [quoteB.id]), 0);

  // Ids smuggled into a body are ignored: the round goes to the caller's own visit.
  const smuggled = await a.post('/api/guest/orders', {
    idempotency_key: key('att'), lines: SOUP, expected_subtotal_minor: 15000,
    visit_id: visitB.id, table_id: 'tbl_T02', guest_session_id: 'gst_ANYTHING', source: 'staff',
  });
  assert.equal(smuggled.status, 201, JSON.stringify(smuggled.body));
  const row = srv.sql<{ visit_id: string; table_id: string; source: string }>('SELECT visit_id, table_id, source FROM orders WHERE id = ?', [smuggled.body.order.id])[0];
  assert.deepEqual({ ...row }, { visit_id: visitA.id, table_id: 'tbl_T01', source: 'guest' });
  // T02's attempt key used at T01 is a new T01 attempt, never T02's order.
  const reused = await a.post('/api/guest/orders', { idempotency_key: keyB, lines: linesB, expected_subtotal_minor: 16000 });
  assert.equal(reused.status, 201, JSON.stringify(reused.body));
  assert.equal(reused.body.replayed, false);
  assert.notEqual(reused.body.order.id, oB.id);
  assert.equal(reused.body.order.table_label, 'T01');
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visitB.id]), 1);
  // Forged and altered guest cookies are no access at all.
  const token = a.cookies.get('rg_guest')!;
  for (const forged of [`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, 'x'.repeat(43), '']) {
    const f = device();
    f.cookies.set('rg_guest', forged);
    expectError(await f.get('/api/guest/orders'), 401, 'visit_access_required', `forged ${forged.slice(0, 6)}`);
  }

  // Staff-only endpoints refuse the guest cookie - even presented as a staff cookie.
  const lineB = oB.lines[0];
  const staffCalls: Array<[string, string, unknown?]> = [
    ['GET', '/api/staff/auth/me'],
    ['GET', '/api/staff/overview'],
    ['GET', '/api/staff/orders?scope=active'],
    ['GET', `/api/staff/orders/${oB.id}`],
    ['POST', '/api/staff/orders/transition', { lines: [{ id: lineB.id, version: lineB.version }], to: 'accepted' }],
    ['POST', `/api/staff/orders/${oB.id}/finish`, { version: oB.version, resolutions: [{ line_id: lineB.id, version: lineB.version, action: 'cancel', reason: 'tamper' }] }],
    ['POST', '/api/staff/orders/assist', { visit_id: visitB.id, idempotency_key: key('as'), lines: SOUP, expected_subtotal_minor: 15000 }],
    ['GET', '/api/staff/tables'],
    ['GET', `/api/staff/visits/${visitB.id}`],
    ['GET', `/api/staff/visits/${visitB.id}/bill`],
    ['POST', `/api/staff/visits/${visitB.id}/billing/start`, { version: visitB.version }],
    ['POST', `/api/staff/visits/${visitB.id}/rotate-pin`, { version: visitB.version }],
    ['POST', `/api/staff/visits/${visitB.id}/revoke-guests`, { version: visitB.version, reason: 'tamper' }],
    ['POST', `/api/staff/visits/${visitB.id}/checkout`, { idempotency_key: key('co'), exception_reason: 'tamper' }],
    ['GET', '/api/staff/service?scope=active'],
    ['POST', `/api/staff/service/${svcB.body.id}/transition`, { to: 'completed', version: svcB.body.version }],
    ['GET', '/api/staff/portions?scope=open'],
    ['POST', `/api/staff/portions/${porB.body.id}/quote`, { grams: 1, version: quoted.body.version }],
    ['POST', `/api/staff/portions/${porB.body.id}/confirm-in-person`, { quote_id: quoteB.id, revision: quoteB.revision, idempotency_key: key('pc') }],
    ['POST', `/api/staff/portions/${porB.body.id}/cancel`, { reason: 'tamper', version: quoted.body.version }],
    ['GET', '/api/staff/events/poll?since=0'],
  ];
  const asStaffCookie = device();
  asStaffCookie.cookies.set('rg_staff', token);
  for (const who of [a, asStaffCookie]) {
    for (const [method, path, body] of staffCalls) {
      const r = await who.request(method, path, body);
      expectError(r, 401, 'auth_required', `${method} ${path}`);
      assertNoLeak(r, `${method} ${path}`);
    }
    const s = await openStream(who, '/api/staff/events');
    expectError({ status: s.status, body: s.body, headers: new Headers() }, 401, 'auth_required', 'staff SSE');
  }
  assert.equal(a.cookies.get('rg_guest'), token, 'the guest session itself is untouched');

  // T02 is exactly as T02 left it.
  const lines = srv.sql<{ status: string; version: number }>('SELECT status, version FROM order_lines WHERE order_id = ?', [oB.id]);
  assert.deepEqual(lines.map((l) => [l.status, l.version]), [['submitted', 1]]);
  assert.equal(srv.sql('SELECT status FROM service_requests WHERE id = ?', [svcB.body.id])[0].status, 'sent');
  const vB = srv.sql<{ status: string; join_pin: string; version: number }>('SELECT status, join_pin, version FROM visits WHERE id = ?', [visitB.id])[0];
  assert.deepEqual([vB.status, vB.join_pin, vB.version], ['open', visitB.join_pin, visitB.version]);
  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE visit_id = ? AND revoked_at IS NOT NULL', [visitB.id]), 0);
  // (Staff reading a visit creates its empty bill row; it must still be untouched.)
  assert.equal(count(`SELECT count(*) n FROM bills WHERE visit_id = ? AND (status <> 'open' OR version <> 1 OR current_revision_id IS NOT NULL)`, [visitB.id]), 0);
  assert.equal(count('SELECT count(*) n FROM bill_revisions WHERE visit_id = ?', [visitB.id]), 0);
  assert.equal(count('SELECT count(*) n FROM payments WHERE visit_id = ?', [visitB.id]), 0);
  assert.equal((await b.get('/api/guest/session')).status, 200);
});

test('a valid guest cookie is useless to a cross-site page: header-less or foreign-origin mutations are refused', async () => {
  const t = await newTable('CSRF');
  const visit: VisitDetailDTO = await srv.openVisit(t.id);
  const guest = await joinedDevice(t.token, visit.join_pin!);
  const cookie = `rg_guest=${guest.cookies.get('rg_guest')}`;
  const body = JSON.stringify({ idempotency_key: key('att'), lines: SOUP, expected_subtotal_minor: 15000 });
  const attempts: Array<Record<string, string>> = [
    {}, // a plain HTML form / fetch without the client header
    { 'X-RG-Client': '1', Origin: 'https://evil.example' },
    { 'X-RG-Client': '1', 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const extra of attempts) {
    const res = await fetch(`${srv.url}/api/guest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Forwarded-For': guest.ip, ...extra },
      body,
    });
    assert.equal(res.status, 403, JSON.stringify(extra));
    assert.equal((await res.json()).error.code, 'csrf_rejected');
  }
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit.id]), 0);
  // The same request from the app itself goes through.
  assert.equal((await guest.request('POST', '/api/guest/orders', JSON.parse(body), { Origin: srv.url, 'Sec-Fetch-Site': 'same-origin' })).status, 201);
});

test('scenario 5 (subscriptions): a guest event stream and poll carry only their own visit events', async () => {
  const ta = await newTable('Stream A');
  const tb = await newTable('Stream B');
  const visitA: VisitDetailDTO = await srv.openVisit(ta.id);
  const visitB: VisitDetailDTO = await srv.openVisit(tb.id);
  const a = await joinedDevice(ta.token, visitA.join_pin!);
  const b = await joinedDevice(tb.token, visitB.join_pin!);
  const floor = await srv.staff('floor');
  const cursor = count('SELECT COALESCE(MAX(id), 0) n FROM events');

  const streamA = await openStream(a, '/api/guest/events');
  const streamB = await openStream(b, '/api/guest/events');
  assert.equal(streamA.status, 200);
  assert.equal(streamB.status, 200);
  const hello = await streamA.waitFor((e) => e.event === 'hello');
  assert.equal(typeof hello.data.cursor, 'number');
  await streamB.waitFor((e) => e.event === 'hello');

  try {
    // Activity at table B: a round, kitchen progress, a service call, a staff-only PIN rotation.
    const orderB = await submitSoup(b);
    assert.equal(orderB.status, 201);
    const oB: OrderDTO = orderB.body.order;
    await serveAll(floor, oB.id);
    assert.equal((await b.post('/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') })).status, 201);
    const rot = await floor.post(`/api/staff/visits/${visitB.id}/rotate-pin`, { version: (await visitDetail(floor, visitB.id)).version });
    assert.equal(rot.status, 200);
    // Activity at table A.
    const orderA = await submitSoup(a);
    assert.equal(orderA.status, 201);
    const oA: OrderDTO = orderA.body.order;

    const isChange = (visitId: string, topic: string) => (e: SseEvent) => e.event === 'change' && e.data.visit_id === visitId && e.data.topic === topic;
    await streamA.waitFor(isChange(visitA.id, 'order.created'));
    await streamB.waitFor(isChange(visitB.id, 'order.created'));
    await streamB.waitFor(isChange(visitB.id, 'service.updated'));
    await streamB.waitFor((e) => isChange(visitB.id, 'line.updated')(e) && e.data.payload.to === 'served');
    await new Promise((r) => setTimeout(r, 300)); // let any stray event arrive

    const changesA = streamA.events.filter((e) => e.event === 'change');
    const changesB = streamB.events.filter((e) => e.event === 'change');
    for (const e of changesA) assert.ok(e.data.visit_id === visitA.id || e.data.visit_id === null, `A got ${JSON.stringify(e.data)}`);
    for (const e of changesB) assert.ok(e.data.visit_id === visitB.id || e.data.visit_id === null, `B got ${JSON.stringify(e.data)}`);
    assert.ok(!changesA.some((e) => e.data.topic === 'line.updated'), 'A never hears B\'s kitchen progress');
    assert.ok(!streamB.events.some((e) => e.event === 'access'), 'a PIN rotation does not end the joined guests\' stream');
    // Staff-only topics and secrets never reach a guest stream.
    for (const e of [...changesA, ...changesB]) {
      assert.ok(!['table.updated', 'payment.recorded', 'visit.opened'].includes(e.data.topic), `guest got staff topic ${e.data.topic}`);
      assert.ok(!(e.data.topic === 'visit.updated' && e.data.payload.pin_rotated), 'PIN rotation is staff-only');
    }
    for (const s of [visitB.id, oB.id, oB.reference]) assert.ok(!streamA.raw().includes(s), `A's stream leaks ${s}`);
    for (const s of [visitA.id, oA.id, oA.reference]) assert.ok(!streamB.raw().includes(s), `B's stream leaks ${s}`);
    assert.ok(!/join_pin|"pin"|token/.test(streamA.raw() + streamB.raw()), 'no secrets in event payloads');

    // The polling fallback applies the same filter.
    const poll = await a.get<{ cursor: number; events: Array<{ visit_id: string | null; topic: string }>; resync: boolean }>(`/api/guest/events/poll?since=${cursor}`);
    assert.equal(poll.status, 200);
    assert.equal(poll.body.resync, false);
    assert.ok(poll.body.events.some((e) => e.visit_id === visitA.id && e.topic === 'order.created'));
    assert.ok(poll.body.events.every((e) => e.visit_id === visitA.id || e.visit_id === null), JSON.stringify(poll.body.events));
    assert.ok(poll.body.cursor >= cursor);
    // A replay from the very beginning is filtered too.
    const replay = await openStream(b, '/api/guest/events?since=0');
    await replay.waitFor(isChange(visitB.id, 'order.created'));
    await new Promise((r) => setTimeout(r, 200));
    await replay.close();
    assert.ok(replay.events.filter((e) => e.event === 'change').every((e) => e.data.visit_id === visitB.id || e.data.visit_id === null));
  } finally {
    await streamA.close();
    await streamB.close();
  }
});

// ------------------------------------------------------------------ scenario 6: table reused by a new party
test('scenario 6: after a real checkout the table is reused; the old cookie gets visit_closed everywhere, reveals nothing new and cannot order', async () => {
  const token = T.tokens.tbl_T03;
  const visit1: VisitDetailDTO = await srv.openVisit('tbl_T03', 2);
  const pin1 = visit1.join_pin!;
  const old = await joinedDevice(token, pin1);
  const first = await submitSoup(old);
  assert.equal(first.status, 201);
  const floor = await srv.staff('floor');
  await serveAll(floor, first.body.order.id);
  assert.equal((await old.post('/api/guest/service', { type: 'call_staff', note: 'old party note', idempotency_key: key('svc') })).status, 201);

  const stream = await openStream(old, '/api/guest/events');
  await stream.waitFor((e) => e.event === 'hello');
  const closed = await checkout(visit1.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.replayed, false);
  assert.equal(closed.table.state, 'available');
  assert.equal(closed.table.visit, null);
  const ended = await stream.waitFor((e) => e.event === 'access');
  assert.deepEqual(ended.data, { state: 'ended' });
  await stream.close();

  const v1 = srv.sql<{ status: string; join_pin: string | null }>('SELECT status, join_pin FROM visits WHERE id = ?', [visit1.id])[0];
  assert.deepEqual([v1.status, v1.join_pin], ['closed', null]);
  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE visit_id = ? AND revoked_at IS NULL', [visit1.id]), 0);
  const oldCookie = old.cookies.get('rg_guest')!;

  // The next party sits at the same table with a fresh PIN.
  const visit2: VisitDetailDTO = await srv.openVisit('tbl_T03', 3);
  assert.notEqual(visit2.id, visit1.id);
  let pin2 = visit2.join_pin!;
  if (pin2 === pin1) {
    // A random PIN may repeat the previous party's by chance: rotate so "the old PIN" is meaningful.
    const rot = await floor.post<VisitDetailDTO>(`/api/staff/visits/${visit2.id}/rotate-pin`, { version: visit2.version });
    pin2 = rot.body.join_pin!;
  }
  const newcomer = device();
  expectError(await joinQr(newcomer, token), 401, 'pin_required');
  expectError(await joinQr(newcomer, token, pin1), 401, 'pin_invalid', 'the previous party\'s PIN');
  const joined = await joinQr(newcomer, token, pin2);
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.visit.id, visit2.id);
  const keyNew = key('attN');
  const round = await newcomer.post('/api/guest/orders', {
    idempotency_key: keyNew, lines: [{ item_id: T.items.soup, quantity: 2, modifiers: [], note: 'new party note' }], expected_subtotal_minor: 30000,
  });
  assert.equal(round.status, 201, JSON.stringify(round.body));
  const o2: OrderDTO = round.body.order;
  const svc2 = await newcomer.post<ServiceRequestDTO>('/api/guest/service', { type: 'allergy_help', note: 'new party note', idempotency_key: key('svc') });
  assert.equal(svc2.status, 201);
  const por2 = await newcomer.post<PortionRequestDTO>('/api/guest/portions', { item_id: T.items.rib, idempotency_key: key('por') });
  assert.equal(por2.status, 201);

  // The old cookie: visit_closed on every guest endpoint, nothing about the new party.
  const secrets = [visit2.id, o2.id, o2.reference, svc2.body.id, por2.body.id, 'new party note'];
  const oldTab = () => {
    const c = old.clone();
    c.cookies.set('rg_guest', oldCookie);
    return c;
  };
  const calls: Array<[string, string, unknown?]> = [
    ['GET', '/api/guest/session'],
    ['GET', '/api/guest/orders'],
    ['GET', `/api/guest/orders/attempts/${keyNew}`],
    ['GET', '/api/guest/service'],
    ['GET', '/api/guest/bill'],
    ['GET', '/api/guest/portions'],
    ['GET', '/api/guest/events/poll?since=0'],
    ['POST', '/api/guest/quote', { lines: SOUP }],
    ['POST', '/api/guest/orders', { idempotency_key: key('att'), lines: SOUP, expected_subtotal_minor: 15000 }],
    ['POST', '/api/guest/orders', { idempotency_key: keyNew, lines: [{ item_id: T.items.soup, quantity: 2, modifiers: [], note: 'new party note' }], expected_subtotal_minor: 30000 }],
    ['POST', '/api/guest/service', { type: 'call_staff', idempotency_key: key('svc') }],
    ['POST', '/api/guest/bill/request', { idempotency_key: key('bill') }],
    ['POST', '/api/guest/portions', { item_id: T.items.rib, idempotency_key: key('por') }],
    ['POST', `/api/guest/portions/${por2.body.id}/cancel`],
    ['POST', `/api/guest/portions/${por2.body.id}/decline`, { quote_id: 'pq_whatever', revision: 1 }],
    ['POST', `/api/guest/portions/${por2.body.id}/confirm`, { quote_id: 'pq_whatever', revision: 1, idempotency_key: key('pc') }],
    ['POST', '/api/guest/feedback', { rating: 1, comment: 'old party', idempotency_key: key('fb') }],
  ];
  for (const [method, path, body] of calls) {
    const tab = oldTab();
    const r = await tab.request(method, path, body);
    expectError(r, 410, 'visit_closed', `${method} ${path}`);
    const text = JSON.stringify(r.body);
    for (const s of secrets) assert.ok(!text.includes(s), `${method} ${path} leaks ${s}`);
    assert.equal(tab.cookies.has('rg_guest'), false, `${method} ${path} clears the closed visit's cookie`);
  }
  const sse = await openStream(oldTab(), '/api/guest/events');
  expectError({ status: sse.status, body: sse.body, headers: new Headers() }, 410, 'visit_closed', 'SSE');

  // Scanning again with the old cookie: public facts only, and the new PIN is still required.
  const scan = await resolveQr(oldTab(), token);
  assert.deepEqual(scan.body, { table_label: 'T03', state: 'ready', pin_required: true, already_joined: false });
  expectError(await joinQr(oldTab(), token), 401, 'pin_required');
  expectError(await joinQr(oldTab(), token, pin1), 401, 'pin_invalid');

  // Nothing from the old device reached the new visit, and the new party sees only its own visit.
  assert.equal(count('SELECT count(*) n FROM orders WHERE visit_id = ?', [visit2.id]), 1);
  assert.equal(count('SELECT count(*) n FROM service_requests WHERE visit_id = ?', [visit2.id]), 1);
  assert.equal(count('SELECT count(*) n FROM portion_requests WHERE visit_id = ?', [visit2.id]), 1);
  assert.equal(count(`SELECT count(*) n FROM portion_requests WHERE id = ? AND status = 'requested'`, [por2.body.id]), 1);
  assert.equal(count('SELECT count(*) n FROM guest_sessions WHERE visit_id = ?', [visit2.id]), 1);
  assert.equal(count('SELECT count(*) n FROM feedback'), 0);
  const view = await newcomer.get<{ orders: OrderDTO[] }>('/api/guest/orders');
  assert.deepEqual(view.body.orders.map((o) => o.id), [o2.id]);
  assert.equal(view.body.orders[0].round_no, 1, 'the new party starts at round 1');
  const bill = await newcomer.get<GuestBillDTO>('/api/guest/bill');
  assert.deepEqual([...bill.body.lines, ...bill.body.pending_lines].map((l) => l.order_reference), [o2.reference]);
  assert.equal(bill.body.bill_status, 'open');
  assert.equal(bill.body.paid, false);
  const svcView = await newcomer.get<{ requests: ServiceRequestDTO[] }>('/api/guest/service');
  assert.deepEqual(svcView.body.requests.map((r) => r.id), [svc2.body.id]);
  const newText = JSON.stringify([view.body, bill.body, svcView.body]);
  for (const s of [visit1.id, first.body.order.reference, 'old party note']) assert.ok(!newText.includes(s), `new party sees ${s}`);

  // The closed visit's history is preserved.
  assert.equal(count(`SELECT count(*) n FROM order_lines WHERE visit_id = ? AND status = 'served'`, [visit1.id]), 1);
  assert.equal(count(`SELECT count(*) n FROM payments WHERE visit_id = ? AND status = 'confirmed'`, [visit1.id]), 1);
  assert.equal(count(`SELECT count(*) n FROM service_requests WHERE visit_id = ? AND status IN ('sent','acknowledged')`, [visit1.id]), 0);
});
