// Pure unit tests for what the tables screens count (client/src/admin/tables/counts.ts).
// Round-1 finding 41: a table tile, the Orders board's ticket buttons and the
// Overview card must all count DISHES (quantities), never order lines.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { StaffBillDTO, StaffOrderDTO, TableTileDTO, VisitDetailDTO } from '../../shared/dto.ts';
import { checkoutWords, readyDishes, unresolvedDishes } from '../../client/src/admin/tables/counts.ts';

type TileVisit = NonNullable<TableTileDTO['visit']>;

/** Only the fields these functions read; the rest of the DTO is irrelevant here. */
function visit(over: Partial<TileVisit>): TileVisit {
  return {
    id: 'vis_1', status: 'open', seated_at: '2026-09-18T12:00:00.000Z', covers: 2, rounds: 1,
    unresolved_lines: 0, ready_lines: 0, unaccepted_rounds: 0, open_requests: 0, bill_requested: false,
    guests: 1, version: 1, ...over,
  } as TileVisit;
}

function order(roundNo: number, lines: Array<[status: string, quantity: number]>): StaffOrderDTO {
  return { round_no: roundNo, lines: lines.map(([status, quantity], i) => ({ id: `l${roundNo}${i}`, status, quantity })) } as unknown as StaffOrderDTO;
}

function bill(over: Partial<StaffBillDTO>): StaffBillDTO {
  return {
    visit_status: 'billing', checkout_blockers: [], total_minor: 0, running_total_minor: 0, current_revision: null,
    unresolved: { submitted_lines: 0, unserved_lines: 0, open_requests: 0, open_portion_requests: 0 },
    ...over,
  } as unknown as StaffBillDTO;
}

/** Echoes the key and its numbers, so a test reads the unit the words carry. */
const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}(${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')})` : k);

describe('a tile counts dishes, not order lines', () => {
  test('the server dish counts win when they are there', () => {
    // Two lines: one dish and two of another -> 3 dishes not served, 2 at the pass.
    const v = visit({ unresolved_lines: 2, unresolved_dishes: 3, ready_lines: 1, ready_dishes: 2 });
    assert.equal(unresolvedDishes(v), 3);
    assert.equal(readyDishes(v), 2);
  });

  test('an older server that only counts lines still gives a number', () => {
    const v = visit({ unresolved_lines: 2, ready_lines: 1 });
    assert.equal(unresolvedDishes(v), 2);
    assert.equal(readyDishes(v), 1);
  });

  test('zero is a real count, not a missing one', () => {
    const v = visit({ unresolved_lines: 4, unresolved_dishes: 0, ready_lines: 2, ready_dishes: 0 });
    assert.equal(unresolvedDishes(v), 0);
    assert.equal(readyDishes(v), 0);
  });
});

describe('what blocks checkout, in the same unit as the ticket buttons', () => {
  const detail = { orders: [order(1, [['submitted', 2], ['accepted', 1]]), order(2, [['ready', 3]])] } as unknown as VisitDetailDTO;

  test('dishes are counted by quantity, per round', () => {
    const { blockers } = checkoutWords(t, bill({ checkout_blockers: ['unresolved_orders'], unresolved: { submitted_lines: 1, unserved_lines: 3, open_requests: 0, open_portion_requests: 0 } }), detail);
    // 2 dishes to accept in round 1, 1 cooking in round 1, 3 at the pass in round 2.
    assert.deepEqual(blockers, [
      'tables.block.toAccept(n=2,r=1)',
      'tables.block.unservedOne(n=1,r=1)',
      'tables.block.unserved(n=3,r=2)',
    ]);
  });

  test('one dish takes the singular key', () => {
    const one = { orders: [order(1, [['submitted', 1]])] } as unknown as VisitDetailDTO;
    const { blockers } = checkoutWords(t, bill({ checkout_blockers: ['unresolved_orders'] }), one);
    assert.deepEqual(blockers, ['tables.block.toAcceptOne(n=1,r=1)']);
  });

  test('cancelled and served dishes are not counted', () => {
    const settled = { orders: [order(1, [['served', 4], ['cancelled', 2], ['rejected', 1], ['preparing', 2]])] } as unknown as VisitDetailDTO;
    const { blockers } = checkoutWords(t, bill({ checkout_blockers: ['unresolved_orders'] }), settled);
    assert.deepEqual(blockers, ['tables.block.unserved(n=2,r=1)']);
  });

  test('with no visit detail it falls back to the bill line count and neutral words', () => {
    const { blockers } = checkoutWords(t, bill({ checkout_blockers: ['unresolved_orders'], unresolved: { submitted_lines: 0, unserved_lines: 2, open_requests: 0, open_portion_requests: 0 } }), undefined);
    assert.deepEqual(blockers, ['tables.block.unservedAny(n=2)']);
  });

  test('bill and request blockers are unchanged', () => {
    const words = checkoutWords(t, bill({
      visit_status: 'open',
      checkout_blockers: ['bill_not_finalized', 'open_requests', 'open_portions'],
      unresolved: { submitted_lines: 0, unserved_lines: 0, open_requests: 2, open_portion_requests: 1 },
    }), undefined);
    assert.deepEqual(words.blockers, ['tables.block.notStarted']);
    assert.deepEqual(words.notices, ['tables.notice.requests(n=2)', 'tables.notice.portionsOne(n=1)']);
  });
});
