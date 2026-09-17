// Authoritative pricing (brief 12, 30, 31 scenarios 7 and 8, 44-B/C; D-07):
// choice rules, included/paid/upgraded sides, variants, measured cuts,
// quantity limits, the owner-configured charge policy and catalog changes
// made while a cart is being reviewed. Money is satang; every expected
// total is computed by hand next to the cart that produces it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { key, startServer, type Client, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

let srv: TestServer;
let owner: Client;
let manager: Client;
let kitchen: Client;
let cashier: Client;

before(async () => {
  // One trusted proxy hop: each simulated phone gets its own join-rate budget.
  srv = await startServer({ env: { TRUST_PROXY_HOPS: '1' } });
  [owner, manager, kitchen, cashier] = await Promise.all([srv.staff('owner'), srv.staff('manager'), srv.staff('kitchen'), srv.staff('cashier')]);
});
after(async () => { await srv?.stop(); });

// ------------------------------------------------------------------ helpers
type Line = {
  item_id: string; variant_id?: string | null; quantity: number;
  modifiers: Array<{ group_id: string; option_ids: string[] }>; note?: string; expected_unit_minor?: number;
};
type Issue = { line_index: number; code: string; current?: { unit_price_minor?: number; line_total_minor?: number } };

const soup = (quantity = 1, extra: Partial<Line> = {}): Line => ({ item_id: T.items.soup, quantity, modifiers: [], ...extra });
const latte = (variant: string | null, quantity = 1, extra: Partial<Line> = {}): Line => ({ item_id: T.items.coffee, variant_id: variant, quantity, modifiers: [], ...extra });
const wine = (quantity = 1, extra: Partial<Line> = {}): Line => ({ item_id: T.items.wine, quantity, modifiers: [], ...extra });
const steak = (doneness: string[] | null, sides: string[] | null, quantity = 1, extra: Partial<Line> = {}): Line => ({
  item_id: T.items.steak, quantity,
  modifiers: [
    ...(doneness ? [{ group_id: T.groups.doneness, option_ids: doneness }] : []),
    ...(sides ? [{ group_id: T.groups.sides, option_ids: sides }] : []),
  ],
  ...extra,
});
const { rare, medium, fries, salad, mash } = T.options;

let tableSeq = 0;
let deviceSeq = 0;

async function newParty(covers = 2) {
  const t = await manager.post('/api/staff/tables', { label: `PRC-${++tableSeq}` });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const tableId: string = t.body.id;
  const [{ token }] = srv.sql<{ token: string }>('SELECT token FROM table_qr_tokens WHERE table_id = ? AND active = 1', [tableId]);
  const visit = await srv.openVisit(tableId, covers);
  const c = srv.client();
  const n = ++deviceSeq;
  const r = await c.request('POST', '/api/public/qr/join', { token, pin: visit.join_pin }, { 'X-Forwarded-For': `10.2.${Math.floor(n / 250)}.${n % 250}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { tableId, visit, guest: c };
}

const quote = (c: Client, lines: unknown[]) => c.post('/api/guest/quote', { lines });
const submit = (c: Client, attempt: string, lines: unknown[], expected: number) =>
  c.post('/api/guest/orders', { idempotency_key: attempt, lines, expected_subtotal_minor: expected });

function issuesAt(issues: Issue[], index: number): string[] {
  return issues.filter((i) => i.line_index === index).map((i) => i.code).sort();
}

function orderCount(visitId: string): number {
  return srv.sql('SELECT id FROM orders WHERE visit_id = ?', [visitId]).length;
}

async function acceptAll(visitId: string) {
  const lines = srv.sql<{ id: string; version: number }>(`SELECT id, version FROM order_lines WHERE visit_id = ? AND status = 'submitted'`, [visitId]);
  const r = await kitchen.post('/api/staff/orders/transition', { lines: lines.map((l) => ({ id: l.id, version: l.version })), to: 'accepted' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const itemVersion = (id: string) => srv.sql<{ version: number }>('SELECT version FROM menu_items WHERE id = ?', [id])[0].version;
const groupVersion = (id: string) => srv.sql<{ version: number }>('SELECT version FROM modifier_groups WHERE id = ?', [id])[0].version;

// ------------------------------------------------------------------ scenario 8
test('scenario 8: required, unavailable and invalid choices are reported on the exact line and block submission', async () => {
  const { visit, guest } = await newParty();
  const cart: Line[] = [
    steak(null, null),                                             // 0 doneness missing
    steak([rare], null),                                           // 1 ok: sides are optional -> 59000
    steak([rare], [mash]),                                         // 2 mash is unavailable
    steak([rare, medium], null),                                   // 3 doneness allows one
    steak([rare], [fries, fries]),                                 // 4 same option twice
    steak([rare], [rare]),                                         // 5 option from another group
    { ...steak([rare], null), modifiers: [{ group_id: T.groups.doneness, option_ids: [rare] }, { group_id: T.groups.doneness, option_ids: [medium] }] }, // 6 group sent twice
    { ...soup(1), modifiers: [{ group_id: T.groups.doneness, option_ids: [rare] }] }, // 7 soup has no doneness
    soup(1, { variant_id: T.variants.hot }),                       // 8 soup has no variants
    steak([rare], [fries, salad, mash]),                           // 9 at most two sides (and mash unavailable)
    steak([rare], ['opt_does_not_exist']),                         // 10 unknown option
    steak([], [fries]),                                            // 11 empty doneness pick is still missing
  ];
  const q = await quote(guest, cart);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const issues: Issue[] = q.body.issues;
  assert.deepEqual(issuesAt(issues, 0), ['modifier_required']);
  assert.deepEqual(issuesAt(issues, 1), []);
  assert.deepEqual(issuesAt(issues, 2), ['modifier_unavailable']);
  assert.deepEqual(issuesAt(issues, 3), ['modifier_invalid']);
  assert.deepEqual(issuesAt(issues, 4), ['modifier_invalid']);
  assert.ok(issuesAt(issues, 5).includes('modifier_invalid'));
  assert.ok(issuesAt(issues, 6).includes('modifier_invalid'));
  assert.ok(issuesAt(issues, 7).includes('modifier_invalid'));
  assert.deepEqual(issuesAt(issues, 8), ['modifier_invalid']);
  assert.deepEqual(issuesAt(issues, 9), ['modifier_invalid', 'modifier_unavailable']);
  assert.ok(issuesAt(issues, 10).includes('modifier_invalid'));
  assert.deepEqual(issuesAt(issues, 11), ['modifier_required']);
  assert.deepEqual(q.body.lines.map((l: { ok: boolean }) => l.ok), cart.map((_, i) => i === 1));
  // Only valid lines count toward the subtotal.
  assert.equal(q.body.subtotal_minor, 59_000);

  // The same cart cannot be submitted; the reply carries the same review.
  const res = await submit(guest, key('s8a'), cart, 59_000);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'cart_changed');
  assert.deepEqual(res.body.error.details.quote.issues.map((i: Issue) => [i.line_index, i.code]), issues.map((i) => [i.line_index, i.code]));

  // A lone steak without its required doneness is refused as well: all-or-nothing.
  const single = await submit(guest, key('s8b'), [steak(null, [fries]), soup(1)], 74_000);
  assert.equal(single.status, 409);
  assert.equal(single.body.error.code, 'cart_changed');
  assert.deepEqual(single.body.error.details.quote.issues.map((i: Issue) => [i.line_index, i.code]), [[0, 'modifier_required']]);
  assert.equal(orderCount(visit.id), 0);
});

test('scenario 8: variants, measured cuts, availability and quantity limits are validated by the server', async () => {
  const { visit, guest } = await newParty();
  const cart: Line[] = [
    // Lines 0, 1 and 4 also carry the price the guest saw: a line with no current
    // price must not additionally claim the price changed (to 0).
    latte(null, 1, { expected_unit_minor: 8_000 }),  // 0 variant required
    latte(T.variants.decaf, 1, { expected_unit_minor: 9_000 }), // 1 decaf has no price and is unavailable
    latte(T.variants.hot),                         // 2 ok: variant price replaces base -> 8000
    latte(T.variants.iced, 3),                     // 3 ok: 3 x 9000 = 27000
    { item_id: T.items.rib, quantity: 1, modifiers: [], expected_unit_minor: 49_000 }, // 4 measured cut is never a cart line
    steak([rare], null, 11),                       // 5 over max_qty 10
    steak([rare], null, 10),                       // 6 ok: 10 x 59000 = 590000
    soup(20),                                      // 7 ok: default max 20 -> 300000
    soup(21),                                      // 8 over max 20
    { item_id: T.items.draft, quantity: 1, modifiers: [] },   // 9 draft dish
    { item_id: T.items.dessert, quantity: 1, modifiers: [] }, // 10 unverified in live mode
    { item_id: 'itm_does_not_exist', quantity: 1, modifiers: [] }, // 11 unknown dish
    latte('var_does_not_exist'),                   // 12 unknown variant
    wine(1),                                       // 13 ok -> 25000
  ];
  const q = await quote(guest, cart);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const issues: Issue[] = q.body.issues;
  const expected: Record<number, string[]> = {
    0: ['variant_required'], 1: ['variant_unavailable'], 2: [], 3: [], 4: ['measured_weight_needs_quote'],
    5: ['quantity_invalid'], 6: [], 7: [], 8: ['quantity_invalid'], 9: ['not_orderable'], 10: ['not_orderable'],
    11: ['item_missing'], 12: ['variant_unavailable'], 13: [],
  };
  for (const [i, codes] of Object.entries(expected)) assert.deepEqual(issuesAt(issues, Number(i)), codes, `line ${i}`);
  const lines = q.body.lines as Array<{ unit_price_minor: number; line_total_minor: number; ok: boolean }>;
  assert.equal(lines[2].unit_price_minor, 8_000);
  assert.equal(lines[3].unit_price_minor, 9_000);
  assert.equal(lines[3].line_total_minor, 27_000);
  assert.equal(lines[6].line_total_minor, 590_000);
  assert.equal(lines[7].line_total_minor, 300_000);
  assert.equal(lines[13].line_total_minor, 25_000);
  // 8000 + 27000 + 590000 + 300000 + 25000
  assert.equal(q.body.subtotal_minor, 950_000);

  // Out-of-range quantities never reach pricing.
  for (const quantity of [0, -1, 100, 1.5]) {
    const bad = await quote(guest, [soup(quantity)]);
    assert.equal(bad.status, 422, `quantity ${quantity}`);
    assert.equal(bad.body.error.code, 'validation_failed');
  }
  const empty = await submit(guest, key('s8e'), [], 0);
  assert.equal(empty.status, 422);
  // Notes are limited per item (140 characters here), counted as characters, Thai included.
  const notes = await quote(guest, [soup(1, { note: 'ไม่ใส่ผักชี'.repeat(14).slice(0, 140) }), soup(1, { note: 'ก'.repeat(141) }), soup(1, { note: '   ' })]);
  assert.deepEqual([issuesAt(notes.body.issues, 0), issuesAt(notes.body.issues, 1), issuesAt(notes.body.issues, 2)], [[], ['note_too_long'], []]);

  // A measured cut is refused in a cart, alone or next to a fixed-price dish.
  const ribOnly = await submit(guest, key('s8r'), [cart[4]], 0);
  assert.equal(ribOnly.status, 409);
  assert.equal(ribOnly.body.error.code, 'cart_changed');
  assert.deepEqual(ribOnly.body.error.details.quote.issues.map((i: Issue) => i.code), ['measured_weight_needs_quote']);
  const ribAndSoup = await submit(guest, key('s8rs'), [soup(1), cart[4]], 15_000);
  assert.equal(ribAndSoup.status, 409);
  const decaf = await submit(guest, key('s8d'), [latte(T.variants.decaf)], 0);
  assert.equal(decaf.status, 409);
  assert.deepEqual(decaf.body.error.details.quote.issues.map((i: Issue) => i.code), ['variant_unavailable']);
  const tooMany = await submit(guest, key('s8q'), [steak([rare], null, 11)], 649_000);
  assert.deepEqual(tooMany.body.error.details.quote.issues.map((i: Issue) => i.code), ['quantity_invalid']);
  assert.equal(orderCount(visit.id), 0);
  assert.equal(srv.sql('SELECT id FROM order_lines WHERE visit_id = ?', [visit.id]).length, 0);

  // The largest valid quantity is accepted.
  const max = await submit(guest, key('s8m'), [steak([medium], null, 10)], 590_000);
  assert.equal(max.status, 201, JSON.stringify(max.body));
  assert.equal(max.body.order.lines[0].quantity, 10);
  assert.equal(max.body.order.subtotal_minor, 590_000);
});

test('scenario 8: included, paid and upgraded sides are charged exactly once and totals equal hand-computed satang', async () => {
  const { visit, guest } = await newParty();
  const cart: Line[] = [
    steak([rare], [fries, salad], 2, { expected_unit_minor: 71_000 }), // (59000 + fries included 0 + salad extra 12000) x 2 = 142000
    steak([medium], [salad], 1, { expected_unit_minor: 62_000 }),      // 59000 + salad as included side, upgrade 3000 = 62000
    steak([medium], [fries], 1, { expected_unit_minor: 59_000 }),      // included fries is free = 59000
    steak([rare], [], 1, { expected_unit_minor: 59_000 }),             // no side = 59000
    soup(3, { expected_unit_minor: 15_000 }),                          // 45000
    latte(T.variants.iced, 2, { expected_unit_minor: 9_000 }),         // 18000
    latte(T.variants.hot, 1, { expected_unit_minor: 8_000 }),          // 8000
    wine(1, { expected_unit_minor: 25_000 }),                          // 25000
  ];
  const expectedLines = [
    { unit: 59_000, mods: 12_000, qty: 2, total: 142_000 },
    { unit: 59_000, mods: 3_000, qty: 1, total: 62_000 },
    { unit: 59_000, mods: 0, qty: 1, total: 59_000 },
    { unit: 59_000, mods: 0, qty: 1, total: 59_000 },
    { unit: 15_000, mods: 0, qty: 3, total: 45_000 },
    { unit: 9_000, mods: 0, qty: 2, total: 18_000 },
    { unit: 8_000, mods: 0, qty: 1, total: 8_000 },
    { unit: 25_000, mods: 0, qty: 1, total: 25_000 },
  ];
  const subtotal = 418_000; // 142000 + 62000 + 59000 + 59000 + 45000 + 18000 + 8000 + 25000
  assert.equal(expectedLines.reduce((s, l) => s + l.total, 0), subtotal);

  const q = await quote(guest, cart);
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.issues, []);
  q.body.lines.forEach((l: { unit_price_minor: number; modifiers_minor: number; quantity: number; line_total_minor: number }, i: number) => {
    assert.deepEqual([l.unit_price_minor, l.modifiers_minor, l.quantity, l.line_total_minor],
      [expectedLines[i].unit, expectedLines[i].mods, expectedLines[i].qty, expectedLines[i].total], `quote line ${i}`);
  });
  assert.equal(q.body.subtotal_minor, subtotal);
  assert.deepEqual(q.body.charges_preview, []); // no charges configured: nothing is assumed
  assert.equal(q.body.estimated_total_minor, subtotal);
  // The per-option snapshot shows which side was included and which was charged.
  const sidesOf = (line: { modifiers: Array<{ group: { en: string }; options: Array<{ name: { en: string }; price_minor: number }> }> }) =>
    line.modifiers.find((m) => m.group.en === 'Test sides')!.options.map((o) => [o.name.en, o.price_minor]);
  assert.deepEqual(sidesOf(q.body.lines[0]), [['Fries', 0], ['Salad', 12_000]]);
  assert.deepEqual(sidesOf(q.body.lines[1]), [['Salad', 3_000]]);
  assert.deepEqual(sidesOf(q.body.lines[2]), [['Fries', 0]]);

  // A guest who saw a different unit price gets price_changed on that line only.
  const stale = await quote(guest, [steak([rare], [salad], 1, { expected_unit_minor: 59_000 }), soup(1, { expected_unit_minor: 15_000 })]);
  assert.deepEqual(stale.body.issues.map((i: Issue) => ({ ...i, message: undefined })), [
    { line_index: 0, code: 'price_changed', message: undefined, current: { unit_price_minor: 62_000, line_total_minor: 62_000 } },
  ]);

  // The client's total is never trusted: one satang off is a review, not a charge.
  for (const wrong of [subtotal - 1, subtotal + 1, 0]) {
    const r = await submit(guest, key('s8t'), cart, wrong);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'cart_changed');
    assert.deepEqual(r.body.error.details.quote.issues, []);
    assert.equal(r.body.error.details.quote.subtotal_minor, subtotal);
  }
  assert.equal(orderCount(visit.id), 0);

  const res = await submit(guest, key('s8ok'), cart, subtotal);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const order = res.body.order;
  assert.equal(order.subtotal_minor, subtotal);
  order.lines.forEach((l: { unit_price_minor: number; modifiers_minor: number; quantity: number; line_total_minor: number }, i: number) => {
    assert.deepEqual([l.unit_price_minor, l.modifiers_minor, l.quantity, l.line_total_minor],
      [expectedLines[i].unit, expectedLines[i].mods, expectedLines[i].qty, expectedLines[i].total], `order line ${i}`);
  });
  assert.deepEqual(sidesOf(order.lines[0]), [['Fries', 0], ['Salad', 12_000]]);
  assert.equal(order.lines[5].variant_name.en, 'Iced');

  // The database agrees to the satang.
  const [row] = srv.sql<{ subtotal_minor: number; n: number; s: number }>(
    `SELECT o.subtotal_minor, COUNT(l.id) AS n, SUM(l.line_total_minor) AS s
       FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE o.id = ? GROUP BY o.id`, [order.id]);
  assert.deepEqual({ ...row }, { subtotal_minor: subtotal, n: 8, s: subtotal });
  const [bad] = srv.sql<{ n: number }>(
    'SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ? AND line_total_minor <> (unit_price_minor + modifiers_minor) * quantity', [order.id]);
  assert.equal(bad.n, 0);

  // Staff see the same figures, and the accepted lines make the bill.
  const staffView = await cashier.get(`/api/staff/orders/${order.id}`);
  assert.equal(staffView.body.subtotal_minor, subtotal);
  await acceptAll(visit.id);
  const bill = await guest.get('/api/guest/bill');
  assert.equal(bill.body.subtotal_minor, subtotal);
  assert.deepEqual(bill.body.charges, []);
  assert.equal(bill.body.total_minor, subtotal);
});

// ------------------------------------------------------------------ charges policy
test('charges policy: a new visit applies the 10% exclusive + 7% inclusive rules half-up; an earlier visit keeps its snapshot', async () => {
  const service = { id: 'service', label_th: 'ค่าบริการ', label_en: 'Service charge', kind: 'percent', basis_points: 1000, inclusive: false, enabled: true, sort: 1 };
  const vat = { id: 'vat', label_th: 'ภาษีมูลค่าเพิ่ม', label_en: 'VAT', kind: 'percent', basis_points: 700, inclusive: true, enabled: true, sort: 2 };

  const initial = await owner.get('/api/staff/settings');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.settings.charges, [], 'no service charge or tax is assumed by default');
  assert.ok(initial.body.future_only.includes('charges'));

  const seatedBefore = await newParty();
  try {
    // Only the owner manages settings, and a malformed rule is refused whole.
    const denied = await manager.patch('/api/staff/settings', { charges: [service] });
    assert.equal(denied.status, 403);
    const malformed = await owner.patch('/api/staff/settings', { charges: [{ ...service, basis_points: undefined }] });
    assert.equal(malformed.status, 422);
    const fixedInclusive = await owner.patch('/api/staff/settings', { charges: [{ ...service, kind: 'fixed', basis_points: undefined, amount_minor: 100, inclusive: true }] });
    assert.equal(fixedInclusive.status, 422);

    const patch = await owner.patch('/api/staff/settings', { charges: [vat, service] });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.deepEqual(patch.body.settings.charges.map((c: { id: string }) => c.id).sort(), ['service', 'vat']);
    const audit = srv.sql<{ reason: string | null }>(`SELECT reason FROM audit_events WHERE action = 'settings.update' AND entity_id = 'charges'`);
    assert.equal(audit.length, 1);
    assert.match(audit[0].reason ?? '', /from now on/);

    const seatedAfter = await newParty();
    // The charge rules are snapshotted on each visit when it is seated.
    const snap = (id: string) => JSON.parse(srv.sql<{ charges_json: string }>('SELECT charges_json FROM visits WHERE id = ?', [id])[0].charges_json);
    assert.deepEqual(snap(seatedBefore.visit.id), []);
    assert.deepEqual(snap(seatedAfter.visit.id).map((c: { id: string }) => c.id).sort(), ['service', 'vat']);

    // Quotes preview the visit's own rules: 15000 -> service 1500, VAT included 15000 - round(14018.69) = 981.
    const qBefore = await quote(seatedBefore.guest, [soup(1)]);
    assert.deepEqual(qBefore.body.charges_preview, []);
    assert.equal(qBefore.body.estimated_total_minor, 15_000);
    const qAfter = await quote(seatedAfter.guest, [soup(1)]);
    assert.deepEqual(qAfter.body.charges_preview.map((c: { id: string; amount_minor: number; inclusive: boolean }) => [c.id, c.amount_minor, c.inclusive]),
      [['service', 1_500, false], ['vat', 981, true]]);
    assert.equal(qAfter.body.estimated_total_minor, 16_500);

    // Both tables order the same soup; the submitted subtotal never includes charges.
    for (const p of [seatedBefore, seatedAfter]) {
      const r = await submit(p.guest, key('chg'), [soup(1)], 15_000);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.order.subtotal_minor, 15_000);
      await acceptAll(p.visit.id);
      // A 10.05 THB discount makes the charge base end in half a satang.
      const seen = await manager.get(`/api/staff/visits/${p.visit.id}/bill`);
      const adj = await manager.post(`/api/staff/visits/${p.visit.id}/adjustments`, {
        kind: 'discount', amount_minor: -1_005, reason: 'Rounding check', idempotency_key: key('adj'), bill_version: seen.body.bill_version,
      });
      assert.equal(adj.status, 200, JSON.stringify(adj.body));
    }

    const charges = (bill: { charges: Array<{ id: string; amount_minor: number; inclusive: boolean }> }) =>
      bill.charges.map((c) => [c.id, c.amount_minor, c.inclusive]);

    // Seated after: base 15000 - 1005 = 13995; service 1399.5 -> 1400; VAT 13995 - round(13079.44) = 916; total 15395.
    const after1 = await seatedAfter.guest.get('/api/guest/bill');
    assert.equal(after1.status, 200);
    assert.equal(after1.body.subtotal_minor, 15_000);
    assert.equal(after1.body.adjustments_minor, -1_005);
    assert.deepEqual(charges(after1.body), [['service', 1_400, false], ['vat', 916, true]]);
    assert.equal(after1.body.total_minor, 15_395);

    // Seated before the change: no charges, whatever the settings say now.
    const before1 = await seatedBefore.guest.get('/api/guest/bill');
    assert.deepEqual(before1.body.charges, []);
    assert.equal(before1.body.total_minor, 13_995);

    // One more satang off: base 13994; service 1399.4 -> 1399; VAT 13994 - round(13078.50) = 915; total 15393.
    const seen2 = await manager.get(`/api/staff/visits/${seatedAfter.visit.id}/bill`);
    const adj2 = await manager.post(`/api/staff/visits/${seatedAfter.visit.id}/adjustments`, {
      kind: 'correction', amount_minor: -1, reason: 'Rounding check 2', idempotency_key: key('adj'), bill_version: seen2.body.bill_version,
    });
    assert.equal(adj2.status, 200);
    const after2 = await seatedAfter.guest.get('/api/guest/bill');
    assert.deepEqual(charges(after2.body), [['service', 1_399, false], ['vat', 915, true]]);
    assert.equal(after2.body.total_minor, 15_393);

    // The finalized revision freezes exactly that total.
    const staffBill = await cashier.get(`/api/staff/visits/${seatedAfter.visit.id}/bill`);
    assert.equal(staffBill.body.running_total_minor, 15_393);
    const start = await cashier.post(`/api/staff/visits/${seatedAfter.visit.id}/billing/start`, { version: staffBill.body.visit_version });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const wrongTotal = await cashier.post(`/api/staff/visits/${seatedAfter.visit.id}/bill/finalize`, { bill_version: start.body.bill_version, expected_total_minor: 15_394 });
    assert.equal(wrongTotal.status, 409);
    assert.equal(wrongTotal.body.error.code, 'bill_changed');
    const fin = await cashier.post(`/api/staff/visits/${seatedAfter.visit.id}/bill/finalize`, { bill_version: start.body.bill_version, expected_total_minor: 15_393 });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body.current_revision.total_minor, 15_393);
    const [rev] = srv.sql<{ subtotal_minor: number; adjustments_minor: number; total_minor: number; charges_json: string }>(
      'SELECT subtotal_minor, adjustments_minor, total_minor, charges_json FROM bill_revisions WHERE visit_id = ?', [seatedAfter.visit.id]);
    assert.equal(rev.subtotal_minor, 15_000);
    assert.equal(rev.adjustments_minor, -1_006);
    assert.equal(rev.total_minor, 15_393);
    assert.deepEqual(JSON.parse(rev.charges_json).map((c: { amount_minor: number }) => c.amount_minor), [1_399, 915]);
  } finally {
    const reset = await owner.patch('/api/staff/settings', { charges: [] });
    assert.equal(reset.status, 200);
  }
  // Removing the rules also affects only visits seated afterwards.
  const seatedLater = await newParty();
  assert.equal(srv.sql<{ charges_json: string }>('SELECT charges_json FROM visits WHERE id = ?', [seatedLater.visit.id])[0].charges_json, '[]');
});

test('scenario 8: rejected and cancelled lines leave the bill and the service charge is recomputed on the smaller base', async () => {
  const service = { id: 'service', label_th: 'ค่าบริการ', label_en: 'Service charge', kind: 'percent', basis_points: 1000, inclusive: false, enabled: true, sort: 1 };
  const set = await owner.patch('/api/staff/settings', { charges: [service] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  try {
    const { visit, guest } = await newParty();
    const lines = [steak([medium], [fries, salad]), soup(1), latte(T.variants.hot)]; // 71000 + 15000 + 8000
    const placed = await submit(guest, key('cx'), lines, 94_000);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const [steakLine, soupLine, latteLine] = placed.body.order.lines as Array<{ id: string; version: number }>;

    // The kitchen rejects the soup and accepts the rest.
    const reject = await kitchen.post('/api/staff/orders/transition', { lines: [{ id: soupLine.id, version: soupLine.version }], to: 'rejected', reason: 'Out of soup base' });
    assert.equal(reject.status, 200, JSON.stringify(reject.body));
    await acceptAll(visit.id);
    // 71000 + 8000 = 79000; service 7900; total 86900
    const bill1 = await guest.get('/api/guest/bill');
    assert.equal(bill1.body.subtotal_minor, 79_000);
    assert.deepEqual(bill1.body.charges.map((c: { amount_minor: number }) => c.amount_minor), [7_900]);
    assert.equal(bill1.body.total_minor, 86_900);
    assert.deepEqual(bill1.body.excluded_lines.map((l: { line_id: string; status: string }) => [l.line_id, l.status]), [[soupLine.id, 'rejected']]);

    // A manager cancels the not-yet-started latte (a reason is required).
    const latteVersion = srv.sql<{ version: number }>('SELECT version FROM order_lines WHERE id = ?', [latteLine.id])[0].version;
    const noReason = await manager.post('/api/staff/orders/transition', { lines: [{ id: latteLine.id, version: latteVersion }], to: 'cancelled' });
    assert.equal(noReason.status, 422, JSON.stringify(noReason.body));
    const cancel = await manager.post('/api/staff/orders/transition', { lines: [{ id: latteLine.id, version: latteVersion }], to: 'cancelled', reason: 'Guest changed mind' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    // 71000; service 7100; total 78100
    const bill2 = await guest.get('/api/guest/bill');
    assert.equal(bill2.body.subtotal_minor, 71_000);
    assert.deepEqual(bill2.body.charges.map((c: { amount_minor: number }) => c.amount_minor), [7_100]);
    assert.equal(bill2.body.total_minor, 78_100);
    assert.deepEqual(bill2.body.lines.map((l: { line_id: string }) => l.line_id), [steakLine.id]);
    assert.equal(bill2.body.excluded_lines.length, 2);

    // The round still records what was submitted; the guest sees why the soup was rejected.
    assert.equal(srv.sql<{ subtotal_minor: number }>('SELECT subtotal_minor FROM orders WHERE id = ?', [placed.body.order.id])[0].subtotal_minor, 94_000);
    const track = await guest.get('/api/guest/orders');
    const tracked = track.body.orders[0].lines as Array<{ id: string; status: string; status_reason: string | null }>;
    assert.deepEqual(tracked.map((l) => [l.status, l.status_reason]), [['accepted', null], ['rejected', 'Out of soup base'], ['cancelled', 'Guest changed mind']]);
  } finally {
    const reset = await owner.patch('/api/staff/settings', { charges: [] });
    assert.equal(reset.status, 200);
  }
});

test('manual recovery never records a dish that has no current price at 0 THB, even when its category is paused', async () => {
  const { visit } = await newParty();
  const dessert = T.items.dessert;
  const recover = (ref: string) => manager.post('/api/staff/orders/recover', {
    visit_id: visit.id, manual_reference: ref, original_time: new Date(Date.now() - 10 * 60_000).toISOString(),
    lines: [{ item_id: dessert, quantity: 2, modifiers: [] }], already: 'none', reason: 'Wi-Fi outage, paper ticket',
  });
  const catVersion = () => srv.sql<{ version: number }>('SELECT version FROM menu_categories WHERE id = ?', [T.categories.dessert])[0].version;
  try {
    // The dessert is published but its price is withdrawn, and its category is paused.
    const cleared = await manager.patch(`/api/staff/menu/items/${dessert}`, { price_minor: null, price_change_reason: 'Price under review', version: itemVersion(dessert) });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.status, 'published');
    const paused = await manager.patch(`/api/staff/menu/categories/${T.categories.dessert}`, { ordering_paused: true, version: catVersion() });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));

    const res = await recover(`PAPER-${key('p')}`.slice(0, 40));
    assert.equal(res.status, 409, `an unpriced dish must go to review, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'cart_changed');
    assert.equal(srv.sql(`SELECT id FROM order_lines WHERE visit_id = ? AND line_total_minor = 0`, [visit.id]).length, 0);
    assert.equal(orderCount(visit.id), 0);

    // With a price again, the paused-category dish can be recorded from paper (D-25).
    const priced = await manager.patch(`/api/staff/menu/items/${dessert}`, { price_minor: 18_000, price_change_reason: 'Price restored', version: itemVersion(dessert) });
    assert.equal(priced.status, 200);
    const verified = await owner.post(`/api/staff/menu/items/${dessert}/review`, { review_status: 'verified', version: itemVersion(dessert) });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const ok = await recover(`PAPER-${key('q')}`.slice(0, 40));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.order.subtotal_minor, 36_000);
  } finally {
    await manager.patch(`/api/staff/menu/categories/${T.categories.dessert}`, { ordering_paused: false, version: catVersion() });
    await manager.patch(`/api/staff/menu/items/${dessert}`, { price_minor: 18_000, price_change_reason: 'Test restore', version: itemVersion(dessert) });
    await owner.post(`/api/staff/menu/items/${dessert}/review`, { review_status: 'unverified', version: itemVersion(dessert) });
  }
});

test('paper recovery never records an unverified dish just because it is sold out or its category is paused (D-S8-19)', async () => {
  const { visit } = await newParty();
  // Live mode: the dessert is published and priced but not verified, so nobody may order it.
  const dessert = T.items.dessert;
  let n = 0;
  const recover = () => manager.post('/api/staff/orders/recover', {
    visit_id: visit.id, manual_reference: `PAPER-UV-${++n}-${key('r')}`.slice(0, 40), original_time: new Date(Date.now() - 5 * 60_000).toISOString(),
    lines: [{ item_id: dessert, quantity: 1, modifiers: [] }], already: 'served', reason: 'Card reader outage',
  });
  const catVersion = () => srv.sql<{ version: number }>('SELECT version FROM menu_categories WHERE id = ?', [T.categories.dessert])[0].version;
  const setSoldOut = (soldOut: boolean) => manager.post(`/api/staff/menu/items/${dessert}/availability`, { sold_out: soldOut, version: itemVersion(dessert) });
  const setPaused = (paused: boolean) => manager.patch(`/api/staff/menu/categories/${T.categories.dessert}`, { ordering_paused: paused, version: catVersion() });
  const refused = async (why: string) => {
    const r = await recover();
    assert.equal(r.status, 409, `${why}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'cart_changed');
    assert.equal(orderCount(visit.id), 0, why);
  };
  try {
    await refused('unverified');
    assert.equal((await setPaused(true)).status, 200);
    await refused('unverified in a paused category');
    assert.equal((await setSoldOut(true)).status, 200);
    await refused('unverified, sold out and paused');
    assert.equal((await setPaused(false)).status, 200);
    await refused('unverified and sold out');

    // Verified, the same dish may be recorded from paper while sold out and paused (D-25).
    const verified = await owner.post(`/api/staff/menu/items/${dessert}/review`, { review_status: 'verified', version: itemVersion(dessert) });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal((await setPaused(true)).status, 200);
    const ok = await recover();
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.order.subtotal_minor, 18_000);

    // A price change awaiting approval puts the dish back to review: refused again.
    const repriced = await manager.patch(`/api/staff/menu/items/${dessert}`, { price_minor: 19_000, price_change_reason: 'New supplier', version: itemVersion(dessert) });
    assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
    assert.notEqual(repriced.body.review_status, 'verified');
    const again = await recover();
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(orderCount(visit.id), 1);
  } finally {
    if (srv.sql<{ p: number }>('SELECT ordering_paused AS p FROM menu_categories WHERE id = ?', [T.categories.dessert])[0].p) await setPaused(false);
    if (srv.sql<{ s: number }>('SELECT sold_out AS s FROM menu_items WHERE id = ?', [dessert])[0].s) await setSoldOut(false);
    await manager.patch(`/api/staff/menu/items/${dessert}`, { price_minor: 18_000, price_change_reason: 'Test restore', version: itemVersion(dessert) });
    await owner.post(`/api/staff/menu/items/${dessert}/review`, { review_status: 'unverified', version: itemVersion(dessert) });
  }
});

test('a paper order cannot be dated before the previous party at the table checked out (D-S8-15)', async () => {
  const first = await newParty();
  const closed = await (await srv.staff('cashier')).post(`/api/staff/visits/${first.visit.id}/checkout`, { idempotency_key: key('co') });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const closedAt = srv.sql<{ closed_at: string }>('SELECT closed_at FROM visits WHERE id = ?', [first.visit.id])[0].closed_at;
  const next = await srv.openVisit(first.tableId);
  const recover = (ref: string, at: number) => manager.post('/api/staff/orders/recover', {
    visit_id: next.id, manual_reference: ref, original_time: new Date(at).toISOString(),
    lines: [soup()], already: 'none', reason: 'Tablet was down',
  });
  const early = await recover(`PAPER-EARLY-${key('e')}`.slice(0, 40), Date.parse(closedAt) - 20 * 60_000);
  assert.equal(early.status, 422, JSON.stringify(early.body));
  assert.equal(early.body.error.details.issues[0].message, 'before_previous_party');
  assert.equal(orderCount(next.id), 0);
  // Taken after the previous party left - even if before this visit was opened in the system - is fine.
  const fine = await recover(`PAPER-LATE-${key('l')}`.slice(0, 40), Date.parse(closedAt) + 1000);
  assert.equal(fine.status, 201, JSON.stringify(fine.body));
});

test('a category or dish can say "preparing" instead of "cooking", and each order line keeps what it was given (D-S8-18)', async () => {
  const { visit, guest } = await newParty();
  const catVersion = () => srv.sql<{ version: number }>('SELECT version FROM menu_categories WHERE id = ?', [T.categories.grill])[0].version;
  const lineKind = (orderId: string) => srv.sql<{ item_id: string; prep_kind: string }>('SELECT item_id, prep_kind FROM order_lines WHERE order_id = ? ORDER BY line_no', [orderId]).map((r) => r.prep_kind);
  try {
    const before = await submit(guest, key('pk'), [soup()], 15_000);
    assert.equal(before.status, 201);
    assert.deepEqual(lineKind(before.body.order.id), ['cook']);

    const cat = await manager.patch(`/api/staff/menu/categories/${T.categories.grill}`, { prep_kind: 'prepare', version: catVersion() });
    assert.equal(cat.status, 200, JSON.stringify(cat.body));
    assert.equal(cat.body.categories.find((c: any) => c.id === T.categories.grill).prep_kind, 'prepare');
    const item = await manager.patch(`/api/staff/menu/items/${T.items.steak}`, { prep_kind: 'cook', version: itemVersion(T.items.steak) });
    assert.equal(item.status, 200, JSON.stringify(item.body));
    assert.deepEqual([item.body.prep_kind_override, item.body.prep_kind], ['cook', 'cook']);

    const after = await submit(guest, key('pk'), [soup(), steak([rare], [])], 74_000);
    assert.equal(after.status, 201, JSON.stringify(after.body));
    assert.deepEqual(lineKind(after.body.order.id), ['prepare', 'cook']);
    assert.deepEqual(lineKind(before.body.order.id), ['cook'], 'an earlier round keeps its wording');
    const bad = await manager.patch(`/api/staff/menu/items/${T.items.soup}`, { prep_kind: 'bake', version: itemVersion(T.items.soup) });
    assert.equal(bad.status, 422);
  } finally {
    await manager.patch(`/api/staff/menu/categories/${T.categories.grill}`, { prep_kind: null, version: catVersion() });
    await manager.patch(`/api/staff/menu/items/${T.items.steak}`, { prep_kind: null, version: itemVersion(T.items.steak) });
  }
  assert.equal(orderCount(visit.id), 2);
});

// ------------------------------------------------------------------ scenario 7 (runs last: it edits the shared catalog)
test('scenario 7: catalog changes after a cart is prepared return cart_changed on the exact lines, then the re-reviewed cart is priced right', async () => {
  // A round placed before any change keeps its accepted snapshot.
  const earlier = await newParty();
  const earlierOrder = await submit(earlier.guest, key('s7e'), [soup(2), steak([medium], [salad])], 92_000); // 30000 + 62000
  assert.equal(earlierOrder.status, 201, JSON.stringify(earlierOrder.body));
  await acceptAll(earlier.visit.id);

  const { visit, guest } = await newParty();
  const cart: Line[] = [
    steak([medium], [salad], 2, { expected_unit_minor: 62_000 }),  // 0: 124000 - salad upgrade will change
    soup(3, { expected_unit_minor: 15_000 }),                      // 1: 45000  - soup price will change
    latte(T.variants.iced, 1, { expected_unit_minor: 9_000 }),     // 2: 9000   - iced will become unavailable
    latte(T.variants.hot, 2, { expected_unit_minor: 8_000 }),      // 3: 16000  - untouched
    wine(1, { expected_unit_minor: 25_000 }),                      // 4: 25000  - will sell out
    steak([rare], [fries], 1, { expected_unit_minor: 59_000 }),    // 5: 59000  - untouched (fries upgrade stays 0)
  ];
  const prepared = await quote(guest, cart);
  assert.deepEqual(prepared.body.issues, []);
  assert.equal(prepared.body.subtotal_minor, 278_000);
  const originalAttempt = key('s7a');

  try {
    // 1. Soup price rise. A published item needs a reason; the change puts it back into review.
    const noReason = await manager.patch(`/api/staff/menu/items/${T.items.soup}`, { price_minor: 16_500, version: itemVersion(T.items.soup) });
    assert.equal(noReason.status, 422, JSON.stringify(noReason.body));
    const price = await manager.patch(`/api/staff/menu/items/${T.items.soup}`, { price_minor: 16_500, price_change_reason: 'Supplier price rise', version: itemVersion(T.items.soup) });
    assert.equal(price.status, 200, JSON.stringify(price.body));
    assert.equal(price.body.review_status, 'needs_review');
    assert.equal(srv.sql(`SELECT id FROM price_history WHERE item_id = ? AND price_minor = 16500 AND reason = 'Supplier price rise'`, [T.items.soup]).length, 1);

    // While the owner has not approved the new price, the soup cannot be ordered at all (live mode).
    const unreviewed = await submit(guest, originalAttempt, cart, 278_000);
    assert.equal(unreviewed.status, 409);
    assert.equal(unreviewed.body.error.code, 'cart_changed');
    assert.deepEqual(issuesAt(unreviewed.body.error.details.quote.issues, 1), ['not_orderable', 'price_changed']);
    assert.equal(orderCount(visit.id), 0);

    const review = await owner.post(`/api/staff/menu/items/${T.items.soup}/review`, { review_status: 'verified', version: itemVersion(T.items.soup) });
    assert.equal(review.status, 200, JSON.stringify(review.body));

    // 2. The iced latte becomes unavailable (variant availability only; no price change, no review reset).
    const iced = await manager.patch(`/api/staff/menu/items/${T.items.coffee}`, {
      version: itemVersion(T.items.coffee),
      variants: [
        { id: T.variants.hot, key: 'hot', name_en: 'Hot', name_th: 'ร้อน', price_minor: 8_000, available: true },
        { id: T.variants.iced, key: 'iced', name_en: 'Iced', name_th: 'เย็น', price_minor: 9_000, available: false },
        { id: T.variants.decaf, key: 'decaf', name_en: 'Decaf', name_th: null, price_minor: null, available: false },
      ],
    });
    assert.equal(iced.status, 200, JSON.stringify(iced.body));
    assert.equal(iced.body.review_status, 'verified');

    // 3. The wine sells out (kitchen may toggle availability).
    const soldOut = await kitchen.post(`/api/staff/menu/items/${T.items.wine}/availability`, { sold_out: true });
    assert.equal(soldOut.status, 200, JSON.stringify(soldOut.body));

    // 4. The salad upgrade on the shared sides group goes from 30 to 40 THB.
    const sides = await manager.patch(`/api/staff/menu/modifier-groups/${T.groups.sides}`, {
      version: groupVersion(T.groups.sides),
      key: 'test-sides', name_en: 'Test sides', min_select: 0, max_select: 2, included_count: 1,
      options: [
        { id: fries, key: 'fries', name_en: 'Fries', price_delta_minor: 9_000, upgrade_minor: 0, available: true },
        { id: salad, key: 'salad', name_en: 'Salad', price_delta_minor: 12_000, upgrade_minor: 4_000, available: true },
        { id: mash, key: 'mash', name_en: 'Mash', price_delta_minor: 12_000, upgrade_minor: 0, available: false },
      ],
    });
    assert.equal(sides.status, 200, JSON.stringify(sides.body));

    // The prepared cart is now refused, naming exactly the affected lines with their current prices.
    const changed = await submit(guest, originalAttempt, cart, 278_000);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.error.code, 'cart_changed');
    const q = changed.body.error.details.quote;
    assert.deepEqual(q.issues.map((i: Issue) => ({ line_index: i.line_index, code: i.code, current: i.current })), [
      { line_index: 0, code: 'price_changed', current: { unit_price_minor: 63_000, line_total_minor: 126_000 } },
      { line_index: 1, code: 'price_changed', current: { unit_price_minor: 16_500, line_total_minor: 49_500 } },
      { line_index: 2, code: 'variant_unavailable', current: undefined },
      { line_index: 4, code: 'sold_out', current: undefined },
    ]);
    // The rest of the cart is untouched: every line is still there and the unchanged ones still price the same.
    assert.equal(q.lines.length, 6);
    assert.deepEqual(q.lines.map((l: { ok: boolean }) => l.ok), [false, false, false, true, false, true]);
    assert.equal(q.lines[3].line_total_minor, 16_000);
    assert.equal(q.lines[5].line_total_minor, 59_000);
    assert.equal(q.lines[0].modifiers_minor, 4_000);
    assert.equal(q.subtotal_minor, 75_000); // only the valid lines: 16000 + 59000
    assert.equal(orderCount(visit.id), 0, 'nothing was partially submitted');

    // Replaying the refused attempt does not sneak through either (it never created an order).
    const retried = await submit(guest, originalAttempt, cart, 278_000);
    assert.equal(retried.body.error.code, 'cart_changed');

    // The guest reviews: accepts the new prices, swaps iced for hot, drops the wine.
    const reviewed: Line[] = [
      steak([medium], [salad], 2, { expected_unit_minor: 63_000 }), // 126000
      soup(3, { expected_unit_minor: 16_500 }),                     // 49500
      latte(T.variants.hot, 1, { expected_unit_minor: 8_000 }),     // 8000
      latte(T.variants.hot, 2, { expected_unit_minor: 8_000 }),     // 16000
      steak([rare], [fries], 1, { expected_unit_minor: 59_000 }),   // 59000
    ];
    const newSubtotal = 258_500; // 126000 + 49500 + 8000 + 16000 + 59000
    const requote = await quote(guest, reviewed);
    assert.deepEqual(requote.body.issues, []);
    assert.equal(requote.body.subtotal_minor, newSubtotal);
    // The old expected total is still refused; the re-reviewed one is accepted.
    const oldTotal = await submit(guest, key('s7b'), reviewed, 278_000);
    assert.equal(oldTotal.body.error.code, 'cart_changed');
    const placed = await submit(guest, key('s7c'), reviewed, newSubtotal);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(placed.body.order.subtotal_minor, newSubtotal);
    assert.deepEqual(placed.body.order.lines.map((l: { unit_price_minor: number; modifiers_minor: number; line_total_minor: number }) => [l.unit_price_minor, l.modifiers_minor, l.line_total_minor]), [
      [59_000, 4_000, 126_000], [16_500, 0, 49_500], [8_000, 0, 8_000], [8_000, 0, 16_000], [59_000, 0, 59_000],
    ]);
    const [sum] = srv.sql<{ s: number }>('SELECT SUM(line_total_minor) AS s FROM order_lines WHERE visit_id = ?', [visit.id]);
    assert.equal(sum.s, newSubtotal);
    assert.equal(orderCount(visit.id), 1);

    // The earlier round kept its snapshot: 2 x 15000 soup and a 62000 steak, billed as ordered.
    const kept = await cashier.get(`/api/staff/orders/${earlierOrder.body.order.id}`);
    assert.deepEqual(kept.body.lines.map((l: { unit_price_minor: number; modifiers_minor: number; line_total_minor: number }) => [l.unit_price_minor, l.modifiers_minor, l.line_total_minor]),
      [[15_000, 0, 30_000], [59_000, 3_000, 62_000]]);
    const earlierBill = await earlier.guest.get('/api/guest/bill');
    assert.equal(earlierBill.body.subtotal_minor, 92_000);
    assert.equal(earlierBill.body.total_minor, 92_000);
  } finally {
    // Best-effort restore of the shared fixture catalog.
    await kitchen.post(`/api/staff/menu/items/${T.items.wine}/availability`, { sold_out: false });
    await manager.patch(`/api/staff/menu/items/${T.items.coffee}`, {
      version: itemVersion(T.items.coffee),
      variants: [
        { id: T.variants.hot, key: 'hot', name_en: 'Hot', name_th: 'ร้อน', price_minor: 8_000, available: true },
        { id: T.variants.iced, key: 'iced', name_en: 'Iced', name_th: 'เย็น', price_minor: 9_000, available: true },
        { id: T.variants.decaf, key: 'decaf', name_en: 'Decaf', name_th: null, price_minor: null, available: false },
      ],
    });
    await manager.patch(`/api/staff/menu/modifier-groups/${T.groups.sides}`, {
      version: groupVersion(T.groups.sides),
      key: 'test-sides', name_en: 'Test sides', min_select: 0, max_select: 2, included_count: 1,
      options: [
        { id: fries, key: 'fries', name_en: 'Fries', price_delta_minor: 9_000, upgrade_minor: 0, available: true },
        { id: salad, key: 'salad', name_en: 'Salad', price_delta_minor: 12_000, upgrade_minor: 3_000, available: true },
        { id: mash, key: 'mash', name_en: 'Mash', price_delta_minor: 12_000, upgrade_minor: 0, available: false },
      ],
    });
    await manager.patch(`/api/staff/menu/items/${T.items.soup}`, { price_minor: 15_000, price_change_reason: 'Test restore', version: itemVersion(T.items.soup) });
    await owner.post(`/api/staff/menu/items/${T.items.soup}/review`, { review_status: 'verified', version: itemVersion(T.items.soup) });
  }
});
