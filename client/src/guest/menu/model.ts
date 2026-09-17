// Menu view model: groups → numbered categories → items, and name search.
// Pure functions; no React.
import type { Bilingual, CatalogDTO, MenuCategoryDTO, MenuItemDTO } from '../../../../shared/dto.ts';

export type GroupKey = 'food' | 'drinks';

export interface MenuCategoryView {
  /** DOM anchor of the section ("cat-beef-selection"). The kit's category lists use it as the id. */
  anchor: string;
  category: MenuCategoryDTO;
  group: GroupKey;
  /** Display position among the visible categories of its group: "01". */
  numeral: string;
  items: MenuItemDTO[];
  /** Position of the first item in the group's laid-out list (engagement positions). */
  offset: number;
  /** Every item lacks a Thai name (one marker for the section instead of one per row). */
  allLackThai: boolean;
  allLackEnglish: boolean;
  /** Every item carries the demo_fixture badge (the demo banner says it once). */
  allDemo: boolean;
}

export interface MenuGroupView {
  key: GroupKey;
  name: Bilingual;
  categories: MenuCategoryView[];
  itemCount: number;
}

export interface MenuModel {
  groups: MenuGroupView[];
  byAnchor: Map<string, MenuCategoryView>;
  byCategoryId: Map<string, MenuCategoryView>;
  total: number;
}

const DEFAULT_GROUP_NAMES: Record<GroupKey, Bilingual> = {
  food: { th: 'อาหาร', en: 'Food' },
  drinks: { th: 'เครื่องดื่ม', en: 'Drinks' },
};

function anchorFor(c: MenuCategoryDTO): string {
  const slug = (c.key || c.id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `cat-${slug || c.id}`;
}

export function buildMenu(catalog: CatalogDTO | undefined, soldOutDisplay: 'show_disabled' | 'hide' = 'show_disabled'): MenuModel {
  const model: MenuModel = { groups: [], byAnchor: new Map(), byCategoryId: new Map(), total: 0 };
  if (!catalog) return model;
  const items = new Map(catalog.items.map((i) => [i.id, i] as const));
  const cats = new Map(catalog.categories.map((c) => [c.id, c] as const));
  const keys: GroupKey[] = ['food', 'drinks'];

  for (const key of keys) {
    const declared = catalog.groups.find((g) => g.key === key);
    const ids = declared?.category_ids
      ?? catalog.categories.filter((c) => c.group === key).sort((a, b) => a.sort - b.sort).map((c) => c.id);
    const group: MenuGroupView = { key, name: declared?.name ?? DEFAULT_GROUP_NAMES[key], categories: [], itemCount: 0 };
    let offset = 0;
    for (const id of ids) {
      const category = cats.get(id);
      if (!category) continue;
      const list = category.item_ids
        .map((itemId) => items.get(itemId))
        .filter((i): i is MenuItemDTO => Boolean(i) && !(soldOutDisplay === 'hide' && i!.sold_out));
      if (!list.length) continue; // empty public categories are hidden
      const view: MenuCategoryView = {
        anchor: anchorFor(category),
        category,
        group: key,
        numeral: String(group.categories.length + 1).padStart(2, '0'),
        items: list,
        offset,
        allLackThai: list.every((i) => !i.name.th),
        allLackEnglish: list.every((i) => !i.name.en),
        allDemo: list.every((i) => i.badges.includes('demo_fixture')),
      };
      offset += list.length;
      group.categories.push(view);
      model.byAnchor.set(view.anchor, view);
      model.byCategoryId.set(category.id, view);
    }
    group.itemCount = offset;
    model.total += offset;
    model.groups.push(group);
  }
  return model;
}

// ---------------------------------------------------------------- search
/**
 * Search normalisation (DESIGN §10.5): drop invisible joiners, trim and
 * collapse whitespace, case-fold Latin and strip Latin accents. Thai text is
 * never altered (its vowels and tone marks are not in the Latin mark range).
 */
export function normalizeQuery(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/([A-Za-z])[̀-ͯ]+/g, '$1')
    .normalize('NFC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchHit {
  item: MenuItemDTO;
  view: MenuCategoryView;
  /**
   * 0 name starts with the query · 1 name contains it, or a verified alias
   * starts with it · 2 every word found, or an alias contains it · 3 its
   * category matched
   */
  rank: number;
}

/**
 * Owner-verified search aliases of a dish (brief 09, 44E): other spellings and
 * transliterations such as "ลาเต้" for Latte. The public menu carries only
 * reviewed ones (MenuItemDTO.aliases_th / aliases_en); the printed Thai and
 * English names are never changed.
 */
export function itemAliases(item: MenuItemDTO): string[] {
  const out: string[] = [];
  for (const list of [item.aliases_th, item.aliases_en]) {
    if (!Array.isArray(list)) continue;
    for (const a of list) if (typeof a === 'string' && a.trim()) out.push(a);
  }
  return out;
}

export function searchMenu(model: MenuModel, rawQuery: string): SearchHit[] {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];
  const words = q.split(' ');
  const hits: SearchHit[] = [];
  for (const group of model.groups) {
    for (const view of group.categories) {
      const catNames = [view.category.name.th, view.category.name.en, view.category.key.replace(/-/g, ' ')].map(normalizeQuery);
      const catMatch = catNames.some((n) => n && n.includes(q));
      for (const item of view.items) {
        const names = [item.name.th, item.name.en].map(normalizeQuery).filter(Boolean);
        const aliases = itemAliases(item).map(normalizeQuery).filter(Boolean);
        const key = normalizeQuery(item.key.replace(/-/g, ' '));
        let rank = -1;
        if (names.some((n) => n.startsWith(q))) rank = 0;
        else if (names.some((n) => n.includes(q)) || aliases.some((a) => a.startsWith(q))) rank = 1;
        else if (words.every((w) => names.some((n) => n.includes(w)) || key.includes(w)) || aliases.some((a) => a.includes(q))) rank = 2;
        else if (catMatch) rank = 3;
        if (rank >= 0) hits.push({ item, view, rank });
      }
    }
  }
  // Stable: rank first, then menu order.
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => a.h.rank - b.h.rank || a.i - b.i)
    .map((x) => x.h);
}
