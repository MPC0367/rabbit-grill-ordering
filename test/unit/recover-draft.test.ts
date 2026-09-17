// Pure unit tests for two admin-ops rules that decide what reaches the server:
//  - paper recovery of a weighed cut (client/src/admin/orders/assist/draft.ts):
//    grams from the ticket, priced at the approved rate, one cut per line (D-S8-21);
//  - the staff-confirmation snapshot a ticket reads off its line
//    (client/src/admin/orders/board/model.ts, D-FX-OPS-02 / D-S8-20).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MenuItemDTO, OrderLineDTO } from '../../shared/dto.ts';
import { sameLine, toInput, unitPrice, type DraftLine } from '../../client/src/admin/orders/assist/draft.ts';
import { staffConfirmOf } from '../../client/src/admin/orders/board/model.ts';

function item(over: Partial<MenuItemDTO> = {}): MenuItemDTO {
  return {
    id: 'i1', key: 'prime_rib', category_id: 'c1', name: { th: null, en: 'Prime rib' }, description: null,
    portion_note: null, pricing_type: 'measured_weight', price_minor: null, rate_minor: 45000, rate_basis_grams: 100,
    variants: [], modifier_groups: [], image: null, station: 'kitchen', alcohol: false, notes_allowed: true,
    note_max: 140, max_qty: 20, sold_out: false, orderable: true, unavailable_reason: null, quick_add: false,
    allergens: { status: 'unknown', entries: [], verified_at: null }, badges: [], sort: 1, version: 1,
    ...over,
  };
}

function draftLine(over: Partial<DraftLine> = {}): DraftLine {
  return { uid: 'l1', item_id: 'i1', variant_id: null, quantity: 1, modifiers: [], note: '', allergy_note: false, ...over };
}

describe('a weighed cut entered from a paper ticket', () => {
  test('is priced at the approved rate, half-up like the server', () => {
    // 380 g at 450.00 per 100 g = 1,710.00
    assert.equal(unitPrice(item(), draftLine({ measured_grams: 380 })), 171000);
    // 333 g at 450.00 per 100 g = 1,498.50
    assert.equal(unitPrice(item(), draftLine({ measured_grams: 333 })), 149850);
  });

  test('has no price at all while the rate is not approved', () => {
    assert.equal(unitPrice(item({ rate_minor: null }), draftLine({ measured_grams: 380 })), null);
  });

  test('is sent as one cut, with its grams and no expected price', () => {
    const input = toInput(draftLine({ measured_grams: 380, quantity: 3 }), item());
    assert.deepEqual(input.measured, { grams: 380 });
    assert.equal(input.quantity, 1);
    assert.equal(input.expected_unit_minor, null);
  });

  test('a dish with no weight is sent unchanged', () => {
    const fixed = item({ pricing_type: 'fixed', price_minor: 32000, rate_minor: null, rate_basis_grams: null });
    const input = toInput(draftLine({ quantity: 2 }), fixed);
    assert.equal(input.measured, undefined);
    assert.equal(input.quantity, 2);
    assert.equal(input.expected_unit_minor, 32000);
  });

  test('two cuts never stack into one line, whatever they weigh', () => {
    const a = draftLine({ measured_grams: 380 });
    const b = draftLine({ uid: 'l2', measured_grams: 380 });
    assert.equal(sameLine(a, b), false);
    // Two portions of the same fixed-price dish still stack.
    assert.equal(sameLine(draftLine(), draftLine({ uid: 'l2' })), true);
  });
});

describe('staff confirmation comes from the line, not from today’s menu', () => {
  const line = (over: Partial<OrderLineDTO>): OrderLineDTO => ({
    id: 'ol1', item_id: 'i1', name: { th: null, en: 'Dish' }, variant_name: null, modifiers: [], quantity: 1,
    unit_price_minor: 1000, modifiers_minor: 0, line_total_minor: 1000, measured_grams: null, rate_minor: null,
    rate_basis_grams: null, note: null, allergy_flag: false, station: 'kitchen', prep_kind: 'cook',
    status: 'accepted', status_reason: null, steps: [], version: 1, ...over,
  });

  test('an alcohol line that needs confirming gets the alcohol row', () => {
    assert.deepEqual(staffConfirmOf(line({ alcohol: true, requires_staff_confirm: true })), { alcohol: true, chip: false });
  });

  test('another flagged dish gets the chip instead', () => {
    assert.deepEqual(staffConfirmOf(line({ alcohol: false, requires_staff_confirm: true })), { alcohol: false, chip: true });
  });

  test('alcohol the owner does not ask staff to confirm shows nothing', () => {
    assert.deepEqual(staffConfirmOf(line({ alcohol: true, requires_staff_confirm: false })), { alcohol: false, chip: false });
  });

  test('a line from before the snapshot (no flags) shows nothing', () => {
    assert.deepEqual(staffConfirmOf(line({})), { alcohol: false, chip: false });
  });
});
