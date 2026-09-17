// Harness smoke test: the server boots with fixtures and a guest can order.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { key, startServer, type TestServer } from '../helpers/harness.ts';
import { T } from '../helpers/fixtures.ts';

let srv: TestServer;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

test('guest joins a table and submits one order that staff can see', async () => {
  const visit = await srv.openVisit('tbl_T01');
  assert.match(visit.join_pin, /^\d{4}$/);
  const guest = await srv.guest('tbl_T01', visit.join_pin);
  const lines = [{ item_id: T.items.soup, quantity: 2, modifiers: [] }];
  const res = await guest.post('/api/guest/orders', { idempotency_key: key('att'), lines, expected_subtotal_minor: 30000 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const kitchen = await srv.staff('kitchen');
  const board = await kitchen.get('/api/staff/orders?scope=active');
  assert.equal(board.status, 200);
  assert.ok(board.body.orders.some((o: { reference: string }) => o.reference === res.body.order.reference));
});
