// Pure unit tests of the guest menu search (client/src/guest/menu/model.ts):
// Thai and English names, the item key, category names, and owner-verified
// aliases (brief 09, 44E). Printed names are never altered.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogDTO, MenuItemDTO } from '../../shared/dto.ts';
import { buildMenu, itemAliases, normalizeQuery, searchMenu } from '../../client/src/guest/menu/model.ts';

function item(id: string, name: { th: string | null; en: string | null }, category: string, extra: Record<string, unknown> = {}): MenuItemDTO {
  return {
    id, key: id, category_id: category, name, description: null, portion_note: null,
    pricing_type: 'fixed', price_minor: 9000, rate_minor: null, rate_basis_grams: null,
    variants: [], modifier_groups: [], image: null, station: 'bar', alcohol: false,
    notes_allowed: true, note_max: 120, max_qty: 20, sold_out: false, orderable: true,
    unavailable_reason: null, quick_add: true,
    allergens: { status: 'unknown', entries: [], verified_at: null },
    badges: [], sort: 0, version: 1,
    ...extra,
  } as MenuItemDTO;
}

function catalog(items: MenuItemDTO[]): CatalogDTO {
  return {
    version: 'v1',
    generated_at: '2026-09-17T12:00:00.000Z',
    groups: [
      { key: 'food', name: { th: 'อาหาร', en: 'Food' }, category_ids: ['c-steak'] },
      { key: 'drinks', name: { th: 'เครื่องดื่ม', en: 'Drinks' }, category_ids: ['c-coffee'] },
    ],
    categories: [
      { id: 'c-steak', key: 'steak', group: 'food', name: { th: 'สเต็ก', en: 'Steaks' }, note: null, seasonal: false, alcohol: false, sort: 1, item_ids: items.filter((i) => i.category_id === 'c-steak').map((i) => i.id) },
      { id: 'c-coffee', key: 'coffee', group: 'drinks', name: { th: null, en: 'Coffee' }, note: null, seasonal: false, alcohol: false, sort: 2, item_ids: items.filter((i) => i.category_id === 'c-coffee').map((i) => i.id) },
    ],
    items,
  };
}

const latte = item('latte', { th: null, en: 'Latte' }, 'c-coffee', { aliases_th: ['ลาเต้'] });
const piccolo = item('piccolo-latte', { th: null, en: 'Piccolo Latte' }, 'c-coffee', { aliases_th: ['พิคโคโล่ ลาเต้'], aliases_en: [] });
const americano = item('americano', { th: null, en: 'Americano' }, 'c-coffee');
const ribeye = item('ribeye', { th: 'ริบอาย', en: 'Ribeye' }, 'c-steak', { aliases_en: ['rib eye'] });
const model = buildMenu(catalog([latte, piccolo, americano, ribeye]));

describe('guest menu search', () => {
  test('finds English-only dishes by a verified Thai alias', () => {
    const hits = searchMenu(model, 'ลาเต้');
    assert.deepEqual(hits.map((h) => h.item.id), ['latte', 'piccolo-latte']);
    // Alias prefix outranks alias contains.
    assert.ok(hits[0].rank < hits[1].rank);
  });

  test('a name match still ranks before an alias match', () => {
    const hits = searchMenu(model, 'rib');
    assert.equal(hits[0].item.id, 'ribeye');
    assert.equal(hits[0].rank, 0);
  });

  test('reads the reviewed aliases of the menu API, in both languages, ignoring blanks', () => {
    assert.deepEqual(itemAliases(latte), ['ลาเต้']);
    assert.deepEqual(itemAliases(piccolo), ['พิคโคโล่ ลาเต้']);
    assert.deepEqual(itemAliases(ribeye), ['rib eye']);
    assert.deepEqual(
      itemAliases(item('x', { th: null, en: 'X' }, 'c-coffee', { aliases_th: ['เอ็กซ์'], aliases_en: ['', '  ', 'ex'] })),
      ['เอ็กซ์', 'ex'],
    );
    assert.deepEqual(itemAliases(americano), []);
    // Only the fields the public menu sends count: nothing else is searched.
    assert.deepEqual(itemAliases(item('y', { th: null, en: 'Y' }, 'c-coffee', { aliases: ['why'], aliases_verified: true })), []);
  });

  test('without aliases, Thai text for an English-only dish finds nothing', () => {
    assert.deepEqual(searchMenu(model, 'อเมริกาโน่').map((h) => h.item.id), []);
  });

  test('category names still match', () => {
    const hits = searchMenu(model, 'สเต็ก');
    assert.deepEqual(hits.map((h) => [h.item.id, h.rank]), [['ribeye', 3]]);
  });

  test('normalisation leaves Thai untouched and folds Latin', () => {
    assert.equal(normalizeQuery('  Café   LATTE '), 'cafe latte');
    assert.equal(normalizeQuery('ลาเต้'), 'ลาเต้');
  });
});
