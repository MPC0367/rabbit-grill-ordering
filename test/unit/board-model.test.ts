// Pure unit tests of the Orders board placement rules (client/src/admin/orders/board/model.ts).
// A round sits in the column of its least-advanced dish (D-C4b-01); dishes that are
// already ready on such a round still reach the Ready column (D-FX-OPS-01).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrderLineDTO } from '../../shared/dto.ts';
import type { LineStatus } from '../../shared/status.ts';
import { placementOf, readyPartOf, readyRoundCount, stageLines } from '../../client/src/admin/orders/board/model.ts';

let seq = 0;
function line(status: LineStatus, quantity = 1, station: 'kitchen' | 'bar' = 'kitchen'): OrderLineDTO {
  seq += 1;
  return {
    id: `l${seq}`, item_id: `i${seq}`, name: { th: null, en: `Dish ${seq}` }, variant_name: null, modifiers: [],
    quantity, unit_price_minor: 10000, modifiers_minor: 0, line_total_minor: 10000 * quantity,
    measured_grams: null, rate_minor: null, rate_basis_grams: null, note: null, allergy_flag: false,
    station, prep_kind: 'cook', status, status_reason: null,
    steps: [{ status, at: '2026-09-17T12:00:00.000Z', kind: 'forward', reason: null, actor: 'Demo' }],
    version: 1,
  };
}

describe('board placement with dishes at different stages', () => {
  // Table 04 in the seed: squid almost done, mushrooms and two beers ready.
  const squid = line('almost_done');
  const mushrooms = line('ready');
  const beer = line('ready', 2, 'bar');
  const round = [squid, mushrooms, beer];

  test('the round stays in its least-advanced column', () => {
    assert.equal(placementOf(round), 'almost_done');
    assert.deepEqual(stageLines(round, 'almost_done').map((l) => l.id), [squid.id]);
  });

  test('its ready dishes form a ready part', () => {
    assert.deepEqual(readyPartOf(round, placementOf(round)).map((l) => l.id), [mushrooms.id, beer.id]);
  });

  test('a round placed in Ready, served or void has no separate ready part', () => {
    const allReady = [line('ready'), line('ready')];
    assert.equal(placementOf(allReady), 'ready');
    assert.deepEqual(readyPartOf(allReady, 'ready'), []);
    const served = [line('served'), line('rejected')];
    assert.equal(placementOf(served), 'served');
    assert.deepEqual(readyPartOf(served, 'served'), []);
    const voided = [line('rejected'), line('cancelled')];
    assert.equal(placementOf(voided), 'void');
    assert.deepEqual(readyPartOf(voided, 'void'), []);
  });

  test('served and ready dishes: the round is in Ready, not in a ready part', () => {
    const lines = [line('served'), line('ready')];
    assert.equal(placementOf(lines), 'ready');
    assert.deepEqual(readyPartOf(lines, 'ready'), []);
  });

  test('the Ready column counts every round with a dish at the pass once', () => {
    // Table 06: dessert ready, salad still preparing.
    const t06 = [line('ready'), line('preparing')];
    const t02 = [line('ready'), line('ready', 2, 'bar')];
    const t07 = [line('preparing'), line('accepted')];
    const rows = [round, t06, t02, t07].map((lines) => ({ lines, placement: placementOf(lines) }));
    assert.deepEqual(rows.map((r) => r.placement), ['almost_done', 'preparing', 'ready', 'accepted']);
    assert.equal(readyRoundCount(rows), 3);
  });

  test('a station filter changes what counts as ready', () => {
    // Bar view of table 04: only the beers, which are all ready, so the whole ticket is in Ready.
    const bar = round.filter((l) => l.station === 'bar');
    assert.equal(placementOf(bar), 'ready');
    // Kitchen view: squid almost done with mushrooms ready.
    const kitchen = round.filter((l) => l.station === 'kitchen');
    assert.equal(placementOf(kitchen), 'almost_done');
    assert.deepEqual(readyPartOf(kitchen, 'almost_done').map((l) => l.id), [mushrooms.id]);
  });
});
