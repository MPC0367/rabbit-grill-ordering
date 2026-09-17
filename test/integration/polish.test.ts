// Final-polish server work (docs/DECISIONS.md D-F-01 .. D-F-06):
//
//   the staff quote pricing a weighed cut on the server, the staff-scoped
//   orderability view the paper-recovery picker needs, the named `ping` on the
//   live stream, the guest ratings in the annual export, and the fixture
//   search aliases that make alias search demonstrable.
//
// Every test seats its own party at a table created for it. The server runs
// with a one-second stream heartbeat so a ping can be observed in a second
// instead of fifteen; nothing else in this file depends on the interval.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client, key, startServer, type HttpResult, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

const PING_MS = 1_000;

let srv: TestServer;
let owner: Client;
let manager: Client;
let cashier: Client;
let floor: Client;
let kitchen: Client;

before(async () => {
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1', STREAM_PING_MS: String(PING_MS) } });
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

let ipSeq = 0;
const nextIp = () => `10.91.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
function device(ip = nextIp()): Client {
  const c = srv.client();
  const request = c.request.bind(c);
  c.request = (method, path, body, headers = {}) => request(method, path, body, { 'X-Forwarded-For': ip, ...headers });
  return c;
}

let tableSeq = 0;
async function seat() {
  const label = `F${++tableSeq}`;
  const table = ok(await manager.post('/api/staff/tables', { label }), 201);
  const [{ token }] = rows<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [table.id]);
  const visit = ok(await floor.post(`/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: key('open') }), 201);
  const guest = device();
  ok(await guest.post('/api/public/qr/join', { token, pin: visit.join_pin }), 201);
  return { table, visit, guest };
}

async function until<V>(probe: () => V | undefined | null | false, what: string, ms = 5_000): Promise<V> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Set a category's ordering pause and hand back a restore function. */
async function pauseCategory(categoryId: string): Promise<() => Promise<void>> {
  const before = ok(await manager.get('/api/staff/menu')).categories.find((c: { id: string }) => c.id === categoryId);
  ok(await manager.patch(`/api/staff/menu/categories/${categoryId}`, { ordering_paused: true, version: before.version }));
  return async () => {
    const now = ok(await manager.get('/api/staff/menu')).categories.find((c: { id: string }) => c.id === categoryId);
    ok(await manager.patch(`/api/staff/menu/categories/${categoryId}`, { ordering_paused: false, version: now.version }));
  };
}

// ================================================================== D-F-01 staff quotes price weighed cuts
test('the staff quote prices a weighed cut on the server, and only for staff who may record one (D-F-01)', async () => {
  const { visit, guest } = await seat();
  const cut = (grams: number | null) => ({
    item_id: T.items.rib,
    quantity: 1,
    modifiers: [],
    ...(grams === null ? {} : { measured: { grams } }),
  });
  const quote = (who: Client, lines: unknown[]) => who.post('/api/staff/orders/quote', { visit_id: visit.id, lines });

  // 250 g at 490 THB / 100 g = 1,225 THB, priced by the server, quantity 1.
  const priced = ok(await quote(manager, [cut(250)]));
  assert.deepEqual(priced.issues, [], show({ status: 200, body: priced } as HttpResult));
  assert.deepEqual(
    [priced.lines[0].measured_grams, priced.lines[0].quantity, priced.lines[0].unit_price_minor, priced.lines[0].line_total_minor],
    [250, 1, 122_500, 122_500],
  );
  assert.equal(priced.lines[0].ok, true);
  assert.equal(priced.subtotal_minor, 122_500);

  // The same cut with no weight still needs a weighing, as before.
  const unweighed = ok(await quote(manager, [cut(null)]));
  assert.deepEqual(unweighed.issues.map((i: { code: string }) => i.code), ['measured_weight_needs_quote']);
  assert.equal(unweighed.lines[0].measured_grams, null);
  assert.equal(unweighed.subtotal_minor, 0);

  // A cashier may take a staff-assisted round but may not record a paper
  // ticket, so their quote will not price a cut either.
  const byCashier = ok(await quote(cashier, [cut(250)]));
  assert.deepEqual(byCashier.issues.map((i: { code: string }) => i.code), ['measured_weight_needs_quote']);
  assert.equal(byCashier.lines[0].measured_grams, null);

  // A guest cart has no place to put a weight at all: it is dropped, and the
  // guest still gets the weighing issue (D-S8-21).
  const guestQuote = ok(await guest.post('/api/guest/quote', { lines: [cut(250)] }));
  assert.deepEqual(guestQuote.issues.map((i: { code: string }) => i.code), ['measured_weight_needs_quote']);
  assert.equal(guestQuote.lines[0].measured_grams, null);
  assert.equal(guestQuote.subtotal_minor, 0);

  // The quote checks weights exactly as the recovery endpoint does, so a
  // preview never shows a price the submission would refuse.
  const wrongDish = expectError(await quote(manager, [{ item_id: T.items.soup, quantity: 1, modifiers: [], measured: { grams: 250 } }]), 422, 'validation_failed');
  assert.equal(wrongDish.issues[0].path, 'lines.0.measured');
  assert.equal(wrongDish.issues[0].code, 'not_measured_weight');
  const wrongQty = expectError(await quote(manager, [{ item_id: T.items.rib, quantity: 2, modifiers: [], measured: { grams: 250 } }]), 422, 'validation_failed');
  assert.equal(wrongQty.issues[0].path, 'lines.0.quantity');

  // And the price the preview shows is the price the recovered order stores.
  const recovered = ok(await manager.post('/api/staff/orders/recover', {
    visit_id: visit.id,
    manual_reference: `QUOTE-${key('ref').slice(-8)}`,
    original_time: new Date(Date.now() - 15 * 60_000).toISOString(),
    already: 'served',
    reason: 'Tablets were offline; ticket written by hand',
    lines: [cut(250)],
  }), 201);
  assert.equal(recovered.order.lines[0].line_total_minor, priced.lines[0].line_total_minor);
  assert.equal(recovered.order.subtotal_minor, priced.subtotal_minor);
});

// ================================================================== D-F-02 staff orderability view
test('the staff orderability view carries the reason the guest menu hides, and mirrors what recovery accepts (D-F-02)', async () => {
  const { visit } = await seat();
  const state = async (who: Client = manager) => {
    const body = ok(await who.get('/api/staff/menu/orderability'));
    return new Map<string, any>(body.items.map((i: { item_id: string }) => [i.item_id, i]));
  };

  // Nothing paused: the dishes say what the guest menu says.
  const quiet = await state();
  assert.equal(quiet.get(T.items.soup).orderable, true);
  assert.equal(quiet.get(T.items.soup).reason, null);
  assert.equal(quiet.get(T.items.soup).recoverable, true);
  assert.equal(quiet.get(T.items.rib).measured_weight, true);
  // A draft dish is in the staff view (a picker on a stale menu can say why).
  assert.deepEqual(
    [quiet.get(T.items.draft).orderable, quiet.get(T.items.draft).reason, quiet.get(T.items.draft).recoverable],
    [false, 'not_published', false],
  );

  const restoreGrill = await pauseCategory(T.categories.grill);
  const restoreDessert = await pauseCategory(T.categories.dessert);
  try {
    const paused = await state();
    const soup = paused.get(T.items.soup);
    const dessert = paused.get(T.items.dessert);

    // Both dishes report the SAME first reason - which is exactly why the
    // public menu is not enough for a paper-recovery picker.
    assert.equal(soup.reason, 'paused');
    assert.equal(dessert.reason, 'paused');
    assert.equal(ok(await manager.get('/api/public/menu')).items.find((i: { id: string }) => i.id === T.items.soup)?.unavailable_reason, 'paused');

    // The staff view says which of the two may still be entered from paper.
    assert.deepEqual([soup.recoverable, soup.recovery_blocked_reason, soup.category_paused], [true, null, true]);
    assert.deepEqual([dessert.recoverable, dessert.recovery_blocked_reason, dessert.review_status], [false, 'not_verified', 'unverified']);

    // ... and the recovery endpoint agrees, line for line (D-S8-19).
    const recover = (lines: unknown[]) => manager.post('/api/staff/orders/recover', {
      visit_id: visit.id,
      manual_reference: `STATE-${key('ref').slice(-8)}`,
      original_time: new Date(Date.now() - 12 * 60_000).toISOString(),
      already: 'served',
      reason: 'Tablets were offline; ticket written by hand',
      lines,
    });
    ok(await recover([{ item_id: T.items.soup, quantity: 1, modifiers: [] }]), 201);
    const refused = expectError(await recover([{ item_id: T.items.dessert, quantity: 1, modifiers: [] }]), 409, 'cart_changed');
    assert.deepEqual(refused.quote.issues.map((i: { code: string }) => i.code), ['not_orderable']);
  } finally {
    await restoreDessert();
    await restoreGrill();
  }

  // Every signed-in role reads it (the kitchen tablet picks too); nobody else does.
  const byKitchen = await state(kitchen);
  assert.equal(byKitchen.get(T.items.soup).orderable, true);
  assert.equal((await srv.client().get('/api/staff/menu/orderability')).status, 401);

  // It never touches the public DTO.
  const publicItem = ok(await srv.client().get('/api/public/menu')).items.find((i: { id: string }) => i.id === T.items.soup);
  assert.equal(Object.hasOwn(publicItem, 'recoverable'), false);
  assert.equal(Object.hasOwn(publicItem, 'review_status'), false);
});

// ================================================================== D-F-03 live-stream heartbeat
interface SseBlock { event: string; id: string | null; data: string }

/** Minimal EventSource-like reader that also keeps the raw bytes (comments included). */
function openStream(c: Client, path: string) {
  const controller = new AbortController();
  const blocks: SseBlock[] = [];
  let raw = '';
  let failure: Error | null = null;
  const pump = (async () => {
    const res = await fetch(c.base + path, {
      headers: { Accept: 'text/event-stream', Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      signal: controller.signal,
    });
    assert.equal(res.status, 200, `stream ${path} answered ${res.status}`);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += value;
      buffer = (buffer + value).replace(/\r\n/g, '\n');
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const msg: SseBlock = { event: 'message', id: null, data: '' };
        const data: string[] = [];
        let fields = 0;
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue; // a comment keep-alive
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          fields++;
          if (field === 'event') msg.event = value;
          else if (field === 'id') msg.id = value;
          else if (field === 'data') data.push(value);
        }
        if (fields === 0) continue;
        msg.data = data.join('\n');
        blocks.push(msg);
      }
    }
  })().catch((err: Error) => { if (err.name !== 'AbortError') failure = err; });
  return {
    blocks,
    get raw() { return raw; },
    next: (pred: (b: SseBlock) => boolean, what: string, ms: number) => until(() => blocks.find(pred), what, ms),
    async close() {
      controller.abort();
      await pump;
      assert.equal(failure, null, `stream ${path} failed: ${(failure as Error | null)?.message}`);
    },
  };
}

test('a live stream says how often it pings and then pings, so the silence watchdog can arm (D-F-03)', async () => {
  const stream = openStream(kitchen, '/api/staff/events');
  try {
    const hello = await stream.next((b) => b.event === 'hello', 'hello', 5_000);
    const helloData = JSON.parse(hello.data);
    assert.equal(helloData.ping_ms, PING_MS, 'hello publishes the server\'s own heartbeat interval');

    // The contract the client codes against: a ping inside ping_ms * 2.
    const ping = await stream.next((b) => b.event === 'ping', 'a named ping event', PING_MS * 2);
    assert.equal(ping.id, null, 'a ping must not move the client\'s Last-Event-ID');
    assert.equal(JSON.parse(ping.data).ping_ms, PING_MS);
    assert.ok(typeof JSON.parse(ping.data).at === 'string');

    // The comment keep-alive proxies need is still sent alongside it.
    assert.ok(stream.raw.includes(': keep-alive'), 'the comment keep-alive is still written');

    // It keeps pinging, so a watchdog that restarts on every ping stays armed.
    await until(() => stream.blocks.filter((b) => b.event === 'ping').length >= 2, 'a second ping', PING_MS * 3);

    // A ping is not an event: it must not disturb the cursor the client holds.
    assert.equal(stream.blocks.filter((b) => b.id !== null).every((b) => b.event === 'hello' || b.event === 'change'), true);
  } finally {
    await stream.close();
  }
});

test('a guest stream pings on the same interval (D-F-03)', async () => {
  const { guest } = await seat();
  const stream = openStream(guest, '/api/guest/events');
  try {
    const hello = await stream.next((b) => b.event === 'hello', 'hello', 5_000);
    assert.equal(JSON.parse(hello.data).ping_ms, PING_MS);
    await stream.next((b) => b.event === 'ping', 'a named ping event', PING_MS * 2);
  } finally {
    await stream.close();
  }
});

// ================================================================== D-F-06 guest ratings in the annual export
function runNode(args: string[], dbPath = srv.dbPath): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: dbPath, REPORTS_DIR: join(dirname(dbPath), 'reports'), SEED_DEMO: '0', SEED_HISTORY: '0', NODE_ENV: 'test' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`${args.join(' ')} exited ${code}: ${out}${err}`))));
  });
}

test('the annual snapshot carries the guest ratings with the sample they came from (D-F-06)', async () => {
  const a = await seat();
  const b = await seat();
  // Two ratings and one comment-only entry; one per phone, as the product allows.
  ok(await a.guest.post('/api/guest/feedback', { rating: 4, comment: 'อร่อยมาก', idempotency_key: key('fbk') }), 201);
  ok(await b.guest.post('/api/guest/feedback', { rating: 5, idempotency_key: key('fbk') }), 201);
  const commentOnly = device();
  ok(await commentOnly.post('/api/public/qr/join', {
    token: rows<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [b.table.id])[0].token,
    pin: b.visit.join_pin,
  }), 201);
  ok(await commentOnly.post('/api/guest/feedback', { comment: 'ที่จอดรถหายาก', idempotency_key: key('fbk') }), 201);

  const year = Number(rows<{ d: string }>('SELECT business_date AS d FROM feedback ORDER BY created_at DESC LIMIT 1')[0].d.slice(0, 4));
  const list = ok(await owner.get(`/api/staff/feedback?from=${year}-01-01&to=${year}-12-31&include_fixture=1`));
  const snap = JSON.parse(await runNode(['test/integration/snapshot-probe.ts', String(year)]));
  const fb = snap.feedback;

  // The export and the owner's own panel count exactly the same thing.
  assert.deepEqual(
    [fb.entries, fb.rated, fb.average_rating, fb.with_comment],
    [list.count, list.rated, list.average_rating, list.with_comment],
  );
  assert.equal(fb.rated, 2);
  assert.equal(fb.entries, 3, 'a comment with no rating is an entry but not a rating');
  assert.equal(fb.average_rating, 4.5);
  assert.deepEqual(fb.distribution, [
    { rating: 5, count: 1 }, { rating: 4, count: 1 }, { rating: 3, count: 0 }, { rating: 2, count: 0 }, { rating: 1, count: 0 },
  ]);
  assert.equal(fb.distribution.reduce((s: number, d: { count: number }) => s + d.count, 0), fb.rated);

  // The sample is named wherever the average goes, so nobody reads it as the year's verdict.
  assert.ok(
    snap.notes.some((n: string) => n.includes('2 ratings guests chose to send')),
    `the notes say where the average came from: ${JSON.stringify(snap.notes)}`,
  );
});

// ================================================================== D-F-05 fixture search aliases
test('the catalog fixture publishes a few reviewed search aliases, deterministically (D-F-05)', async () => {
  const seedOnce = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-seed-'));
    try {
      return JSON.parse(await runNode(['test/integration/seed-catalog-probe.ts', join(dir, 'catalog.db')], join(dir, 'catalog.db')));
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
    }
  };
  const first = await seedOnce();
  const reviewed = first.rows.filter((r: { aliases_verified: number }) => r.aliases_verified === 1);
  assert.deepEqual(
    reviewed.map((r: { key: string }) => r.key).sort(),
    ['basil-beef-rice', 'grilled-river-prawns', 'thai-tea'],
    'three dishes carry reviewed aliases, so alias search is demonstrable',
  );

  // A dish printed only in English is findable in Thai, and vice versa.
  const byKey = new Map(first.rows.map((r: { key: string }) => [r.key, r]));
  assert.deepEqual(JSON.parse((byKey.get('thai-tea') as any).aliases_th), ['ชาไทย', 'ชาเย็น']);
  assert.ok(JSON.parse((byKey.get('basil-beef-rice') as any).aliases_en).includes('pad kra pao'));

  // Everything else keeps the column default: no aliases, and unreviewed.
  for (const row of first.rows as Array<{ key: string; aliases_th: string; aliases_en: string; aliases_verified: number }>) {
    if (row.aliases_verified === 1) continue;
    assert.deepEqual([row.aliases_th, row.aliases_en], ['[]', '[]'], `${row.key} has no draft aliases`);
  }

  // The approval is the fixture's, and the trail says so.
  assert.equal(first.audits.length, 1);
  assert.match(first.audits[0].reason, /Development fixtures/);
  assert.match(first.audits[0].reason, /owner has approved no aliases/);

  // Seeding again reproduces the same catalog, byte for byte.
  const second = await seedOnce();
  assert.deepEqual(second.rows, first.rows);
  assert.deepEqual(second.audits, first.audits);
  assert.equal(second.items, first.items);
});
