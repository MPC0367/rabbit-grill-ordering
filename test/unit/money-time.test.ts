// Pure unit tests of THE money module and the Bangkok business-time module.
// Every expected value below is computed by hand in the comment next to it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateGroupPicks, computeBill, divRoundHalfUp, formatMoney, lineTotal, measuredAmount, priceGroupPicks,
  type ChargeRule, type PricedOption,
} from '../../shared/money.ts';
import {
  addDays, businessDate, businessRangeUtc, daysBetween, isoWeekday, monthDates, splitByBusinessDay, weekDates, weekStart,
} from '../../shared/time.ts';

const HOUR = 3_600_000;

describe('divRoundHalfUp', () => {
  test('rounds exact halves up and everything else to the nearest integer', () => {
    assert.equal(divRoundHalfUp(5, 10), 1);     // 0.5  -> 1
    assert.equal(divRoundHalfUp(4, 10), 0);     // 0.4  -> 0
    assert.equal(divRoundHalfUp(6, 10), 1);     // 0.6  -> 1
    assert.equal(divRoundHalfUp(15, 10), 2);    // 1.5  -> 2
    assert.equal(divRoundHalfUp(25, 10), 3);    // 2.5  -> 3 (not banker's rounding)
    assert.equal(divRoundHalfUp(13_995_000, 10_000), 1400); // 1399.5 -> 1400
    assert.equal(divRoundHalfUp(13_994_000, 10_000), 1399); // 1399.4 -> 1399
    assert.equal(divRoundHalfUp(0, 7), 0);
    assert.equal(divRoundHalfUp(21, 7), 3);     // exact
  });

  test('is symmetric for negative numerators (half away from zero)', () => {
    assert.equal(divRoundHalfUp(-5, 10), -1);
    assert.equal(divRoundHalfUp(-15, 10), -2);
    // -0.4 rounds to (negative) zero; -0 === 0 and serialises as 0, so compare loosely.
    assert.ok(divRoundHalfUp(-4, 10) === 0);
  });

  test('refuses a zero or negative divisor', () => {
    assert.throws(() => divRoundHalfUp(1, 0));
    assert.throws(() => divRoundHalfUp(1, -10));
  });
});

describe('measuredAmount (grams x rate / basis)', () => {
  test('371 g of prime rib at 490 THB per 100 g is exactly 1,817.90 THB', () => {
    // 371 * 49000 / 100 = 181790
    assert.equal(measuredAmount(371, 49_000, 100), 181_790);
  });

  test('rounds a fractional satang half-up', () => {
    // 371 * 12345 / 100 = 45799.95 -> 45800
    assert.equal(measuredAmount(371, 12_345, 100), 45_800);
    // 1 * 50 / 100 = 0.5 -> 1 ; 1 * 49 / 100 = 0.49 -> 0
    assert.equal(measuredAmount(1, 50, 100), 1);
    assert.equal(measuredAmount(1, 49, 100), 0);
    // 250 g at 333 per 1000 g = 83.25 -> 83
    assert.equal(measuredAmount(250, 333, 1000), 83);
  });

  test('refuses non-integer or non-positive grams and basis', () => {
    assert.throws(() => measuredAmount(0, 49_000, 100));
    assert.throws(() => measuredAmount(-5, 49_000, 100));
    assert.throws(() => measuredAmount(370.5, 49_000, 100));
    assert.throws(() => measuredAmount(371, 49_000, 0));
    assert.throws(() => measuredAmount(371, 49_000, 2.5));
  });
});

describe('allocateGroupPicks (included-count allowance)', () => {
  // The fixture "test-sides" group: included_count 1.
  const sides: PricedOption[] = [
    { id: 'fries', price_delta_minor: 9000, upgrade_minor: 0 },
    { id: 'salad', price_delta_minor: 12000, upgrade_minor: 3000 },
    { id: 'mash', price_delta_minor: 12000, upgrade_minor: 0 },
  ];

  test('an included side is free and an upgraded included side pays only its upgrade', () => {
    assert.deepEqual(allocateGroupPicks(sides, ['fries'], 1), [{ id: 'fries', covered: true, charged_minor: 0 }]);
    assert.deepEqual(allocateGroupPicks(sides, ['salad'], 1), [{ id: 'salad', covered: true, charged_minor: 3000 }]);
  });

  test('a second side beyond the allowance pays its full delta; ties go to listing order', () => {
    // fries saves 9000, salad saves 12000-3000 = 9000: a tie, fries (listed first) is covered.
    assert.deepEqual(allocateGroupPicks(sides, ['salad', 'fries'], 1), [
      { id: 'fries', covered: true, charged_minor: 0 },
      { id: 'salad', covered: false, charged_minor: 12000 },
    ]);
    assert.equal(priceGroupPicks(sides, ['fries', 'salad'], 1), 12000);
  });

  test('the allowance goes where it saves the guest most, whatever the tap order', () => {
    // mash saves 12000, salad saves 9000 -> mash covered (0), salad charged 12000.
    const a = allocateGroupPicks(sides, ['salad', 'mash'], 1);
    const b = allocateGroupPicks(sides, ['mash', 'salad'], 1);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [
      { id: 'salad', covered: false, charged_minor: 12000 },
      { id: 'mash', covered: true, charged_minor: 0 },
    ]);
    // fries + mash: mash (12000) is covered, fries pays 9000 - cheaper than covering fries (12000).
    assert.equal(priceGroupPicks(sides, ['fries', 'mash'], 1), 9000);
  });

  test('no allowance charges every delta; a larger allowance charges only upgrades', () => {
    assert.equal(priceGroupPicks(sides, ['fries', 'salad'], 0), 21000);
    assert.equal(priceGroupPicks(sides, ['fries', 'salad'], 2), 3000);
    assert.equal(priceGroupPicks(sides, ['fries', 'salad', 'mash'], 5), 3000);
    assert.equal(priceGroupPicks(sides, ['fries'], -1), 9000);
    assert.equal(priceGroupPicks(sides, [], 1), 0);
  });
});

describe('lineTotal', () => {
  test('(unit + modifiers) x quantity', () => {
    assert.equal(lineTotal(59_000, 12_000, 2), 142_000);
    assert.equal(lineTotal(15_000, 0, 3), 45_000);
  });
  test('refuses zero or fractional quantities', () => {
    assert.throws(() => lineTotal(15_000, 0, 0));
    assert.throws(() => lineTotal(15_000, 0, 1.5));
  });
});

describe('computeBill (charges policy)', () => {
  const service: ChargeRule = { id: 'service', label_th: 'ค่าบริการ', label_en: 'Service charge', kind: 'percent', basis_points: 1000, inclusive: false, enabled: true, sort: 1 };
  const vat: ChargeRule = { id: 'vat', label_th: 'ภาษีมูลค่าเพิ่ม', label_en: 'VAT', kind: 'percent', basis_points: 700, inclusive: true, enabled: true, sort: 2 };

  test('no charges: total is subtotal plus adjustments', () => {
    const b = computeBill({ lineTotals: [15_000, 9_000], adjustments: [-1_005], charges: [] });
    assert.deepEqual(b, { subtotal_minor: 24_000, adjustments_minor: -1_005, charges: [], charges_added_minor: 0, total_minor: 22_995 });
  });

  test('an exclusive 10% charge is added, rounded half-up on subtotal + adjustments', () => {
    // base 15000 - 1005 = 13995; 10% = 1399.5 -> 1400; total 15395
    const b = computeBill({ lineTotals: [15_000], adjustments: [-1_005], charges: [service] });
    assert.equal(b.charges[0].amount_minor, 1_400);
    assert.equal(b.charges_added_minor, 1_400);
    assert.equal(b.total_minor, 15_395);
  });

  test('an inclusive 7% charge is shown as included and never added', () => {
    // included = 13995 - round(13995 * 10000 / 10700) = 13995 - round(13079.44) = 13995 - 13079 = 916
    const b = computeBill({ lineTotals: [15_000], adjustments: [-1_005], charges: [vat] });
    assert.equal(b.charges[0].amount_minor, 916);
    assert.equal(b.charges[0].inclusive, true);
    assert.equal(b.charges_added_minor, 0);
    assert.equal(b.total_minor, 13_995);
  });

  test('exclusive and inclusive charges each apply to the same base (no compounding)', () => {
    // base 13995: service 1400, VAT 916 (on 13995, not on 15395); total 15395
    const b = computeBill({ lineTotals: [15_000], adjustments: [-1_005], charges: [vat, service] });
    assert.deepEqual(b.charges.map((c) => [c.id, c.amount_minor, c.inclusive]), [['service', 1_400, false], ['vat', 916, true]]);
    assert.equal(b.total_minor, 15_395);
    // base 13994: service 1399.4 -> 1399; VAT 13994 - round(13078.50) = 13994 - 13079 = 915; total 15393
    const c = computeBill({ lineTotals: [15_000], adjustments: [-1_005, -1], charges: [service, vat] });
    assert.deepEqual(c.charges.map((x) => x.amount_minor), [1_399, 915]);
    assert.equal(c.total_minor, 15_393);
    // base 15000: service 1500; VAT 15000 - round(14018.69) = 981; total 16500
    const d = computeBill({ lineTotals: [15_000], adjustments: [], charges: [service, vat] });
    assert.deepEqual(d.charges.map((x) => x.amount_minor), [1_500, 981]);
    assert.equal(d.total_minor, 16_500);
  });

  test('disabled rules are ignored and fixed charges are added as-is', () => {
    const fixed: ChargeRule = { id: 'corkage', label_th: 'ค่าเปิดขวด', label_en: 'Corkage', kind: 'fixed', amount_minor: 20_000, inclusive: false, enabled: true, sort: 3 };
    const b = computeBill({ lineTotals: [10_000], adjustments: [], charges: [{ ...service, enabled: false }, fixed] });
    assert.deepEqual(b.charges.map((x) => x.id), ['corkage']);
    assert.equal(b.total_minor, 30_000);
  });

  test('an adjustment larger than the subtotal clamps the base at zero', () => {
    const b = computeBill({ lineTotals: [10_000], adjustments: [-12_000], charges: [service] });
    assert.equal(b.charges[0].amount_minor, 0);
    assert.equal(b.total_minor, 0);
  });

  test('refuses fractional money', () => {
    assert.throws(() => computeBill({ lineTotals: [100.5], adjustments: [], charges: [] }));
    assert.throws(() => computeBill({ lineTotals: [100], adjustments: [0.1], charges: [] }));
  });

  test('formatMoney shows baht with satang only when present', () => {
    assert.equal(formatMoney(118_000), '฿1,180');
    assert.equal(formatMoney(118_050), '฿1,180.50');
    assert.equal(formatMoney(-1_005), '−฿10.05');
  });
});

describe('Bangkok business dates', () => {
  test('the business day changes exactly at Bangkok midnight (17:00 UTC)', () => {
    assert.equal(businessDate('2025-12-31T16:59:59.999Z'), '2025-12-31');
    assert.equal(businessDate('2025-12-31T17:00:00Z'), '2026-01-01');
    assert.equal(businessDate('2025-12-31T17:00:00.000Z'), '2026-01-01');
    // Date and epoch inputs behave the same.
    assert.equal(businessDate(new Date('2025-12-31T17:00:00Z')), '2026-01-01');
    assert.equal(businessDate(Date.parse('2025-12-31T16:59:59.999Z')), '2025-12-31');
  });

  test('a later cutoff hour keeps the small hours on the previous business day', () => {
    // cutoff 03:00 local = 20:00 UTC
    assert.equal(businessDate('2025-12-31T19:59:59.999Z', 3), '2025-12-31');
    assert.equal(businessDate('2025-12-31T20:00:00Z', 3), '2026-01-01');
  });

  test('weekDates spans New Year Monday..Sunday', () => {
    const expected = ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    assert.deepEqual(weekDates('2025-12-29'), expected);
    assert.deepEqual(weekDates('2026-01-01'), expected);
    assert.deepEqual(weekDates('2026-01-04'), expected);
    assert.equal(weekStart('2026-01-04'), '2025-12-29');
    assert.equal(isoWeekday('2025-12-29'), 0); // Monday
    assert.equal(isoWeekday('2026-01-04'), 6); // Sunday
    assert.deepEqual(weekDates('2026-01-05')[0], '2026-01-05');
  });

  test('date arithmetic crosses month, year and leap-day boundaries', () => {
    assert.equal(addDays('2025-12-31', 1), '2026-01-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(daysBetween('2025-12-29', '2026-01-04'), 6);
    assert.equal(monthDates('2028-02-10').length, 29);
    assert.equal(monthDates('2026-02-10').length, 28);
    assert.equal(monthDates('2025-12-31').at(-1), '2025-12-31');
  });

  test('businessRangeUtc is the half-open UTC interval of local business dates', () => {
    assert.deepEqual(businessRangeUtc('2026-01-01', '2026-01-01'), { start: '2025-12-31T17:00:00.000Z', end: '2026-01-01T17:00:00.000Z' });
    assert.deepEqual(businessRangeUtc('2025-01-01', '2025-12-31'), { start: '2024-12-31T17:00:00.000Z', end: '2025-12-31T17:00:00.000Z' });
    assert.deepEqual(businessRangeUtc('2026-01-01', '2026-01-01', 3), { start: '2025-12-31T20:00:00.000Z', end: '2026-01-01T20:00:00.000Z' });
    // Every instant inside the range maps back to a date inside it; the end is excluded.
    const r = businessRangeUtc('2025-12-29', '2026-01-04');
    assert.equal(businessDate(r.start), '2025-12-29');
    assert.equal(businessDate(new Date(Date.parse(r.end) - 1)), '2026-01-04');
    assert.equal(businessDate(r.end), '2026-01-05');
  });

  test('splitByBusinessDay cuts an interval at Bangkok midnight', () => {
    // 23:30 -> 00:45 local across New Year
    assert.deepEqual(splitByBusinessDay('2025-12-31T16:30:00Z', '2025-12-31T17:45:00Z'), [
      { date: '2025-12-31', ms: 30 * 60_000 },
      { date: '2026-01-01', ms: 45 * 60_000 },
    ]);
    // 23:00 Dec 30 -> 01:00 Jan 2 local: 1 h, 24 h, 24 h, 1 h
    const chunks = splitByBusinessDay('2025-12-30T16:00:00Z', '2026-01-01T18:00:00Z');
    assert.deepEqual(chunks, [
      { date: '2025-12-30', ms: 1 * HOUR },
      { date: '2025-12-31', ms: 24 * HOUR },
      { date: '2026-01-01', ms: 24 * HOUR },
      { date: '2026-01-02', ms: 1 * HOUR },
    ]);
    assert.equal(chunks.reduce((s, c) => s + c.ms, 0), Date.parse('2026-01-01T18:00:00Z') - Date.parse('2025-12-30T16:00:00Z'));
    // Within one day: a single chunk; empty or reversed intervals: nothing.
    assert.deepEqual(splitByBusinessDay('2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z'), [{ date: '2026-01-01', ms: HOUR }]);
    assert.deepEqual(splitByBusinessDay('2026-01-01T01:00:00Z', '2026-01-01T01:00:00Z'), []);
    assert.deepEqual(splitByBusinessDay('2026-01-01T02:00:00Z', '2026-01-01T01:00:00Z'), []);
    // With a 03:00 cutoff, 01:00-04:00 local on Jan 1 splits 2 h on Dec 31 and 1 h on Jan 1.
    assert.deepEqual(splitByBusinessDay('2025-12-31T18:00:00Z', '2025-12-31T21:00:00Z', 3), [
      { date: '2025-12-31', ms: 2 * HOUR },
      { date: '2026-01-01', ms: 1 * HOUR },
    ]);
  });
});
