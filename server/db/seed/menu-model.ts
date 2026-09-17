// What fixture guests can order, how popular each dish is in the synthetic
// history, how long it takes, and when it was unavailable.
//
// Everything here is FIXTURE behaviour for the insights screens. The weights
// and timings are invented demo parameters, not facts about the restaurant.
import { many } from '../index.ts';
import type { PricingType, Station } from '../../../shared/status.ts';
import { addDays } from '../../../shared/time.ts';
import { bangkokMs, type Rng } from './util.ts';

export type Course = 'main' | 'starter' | 'side' | 'dessert' | 'drink' | 'alcohol';

export interface ModelVariant {
  id: string;
  key: string;
  name_th: string | null;
  name_en: string | null;
  price_minor: number;
}

export interface ModelOption {
  id: string;
  key: string;
  name_th: string | null;
  name_en: string;
  price_delta_minor: number;
}

export interface BeansGroup {
  group_id: string;
  name_th: string | null;
  name_en: string;
  house: ModelOption;
  blend: ModelOption;
}

export interface ModelItem {
  id: string;
  key: string;
  category_id: string;
  category_key: string;
  name_th: string | null;
  name_en: string | null;
  pricing_type: PricingType;
  price_minor: number | null;
  rate_minor: number | null;
  rate_basis_grams: number | null;
  variants: ModelVariant[];
  beans: BeansGroup | null;
  station: Station;
  prep_kind: 'cook' | 'prepare';
  course: Course;
  weight: number;
  /** Preparation time range in minutes once started. */
  cook: [number, number];
  /** Orderable in demo mode (published, priced, demo_orderable). */
  orderable: boolean;
  /** Guest-facing menu order, for impressions and scroll positions. */
  menu_index: number;
}

export interface MenuModel {
  /** Every published item in a published category, in menu order (what a guest can see). */
  visible: ModelItem[];
  orderable: ModelItem[];
  byCourse: Record<Course, ModelItem[]>;
  byKey: Map<string, ModelItem>;
  primeRib: ModelItem | null;
  /** Published categories in menu order with their visible items. */
  categories: Array<{ id: string; key: string; items: ModelItem[] }>;
}

// ------------------------------------------------------------------ fixture parameters
/** Relative popularity within a course (default 2). Zero = never ordered in the fixture history. */
const WEIGHTS: Record<string, number> = {
  // mains
  'australian-striploin': 10, 'wagyu-tenderloin': 3, 'grilled-tongue': 5, 'beef-tongue-stew': 4,
  'grilled-baby-chicken': 7, 'grilled-pork': 6, 'grilled-pork-ribs': 9, 'fish-and-chips': 5,
  'grilled-river-prawns': 5, 'grilled-squid': 4, 'grilled-fish': 4,
  'basil-beef-rice': 6, 'american-fried-rice': 3, 'beef-fried-rice': 5,
  // starters and salads
  'corn-rib': 9, 'nashville-hot-chicken': 7, 'fried-sweet-potato': 6, 'beef-tartare-bone-marrow': 3,
  'calamari-tartar-sauce': 6, 'grilled-caesar-salad': 5, 'green-beans-peas-salad': 2,
  'green-salad-balsamic': 3, 'tomato-salad': 1.5, 'burrata-tomato-salad': 4,
  // sides
  'mashed-potato': 6, 'sauteed-potato': 3, 'french-fries': 8, 'sauteed-green-beans-bacon': 3,
  'garlic-confit': 0.3, 'sauteed-mini-broccoli': 3, 'sauteed-mushrooms': 4,
  // desserts
  'creme-brulee-lemon': 5, 'tiramisu': 6,
  // drinks
  'clear-matcha': 2, 'coconut-matcha': 3, 'coconut-matcha-cold-foam': 3, 'matcha-latte-special': 4,
  'strawberry-matcha-latte': 3, 'earl-grey-matcha-latte': 2, 'red-bean-matcha-latte': 2,
  'biscoff-matcha-latte': 3, 'nutella-matcha-latte': 3, 'longan-matcha': 2, 'orange-matcha': 2, 'dirty-matcha': 2,
  'short-black': 1.5, 'long-black': 3, 'long-black-coconut': 3, 'long-black-longan': 2, 'piccolo-latte': 1.5,
  'latte': 5, 'cappuccino': 3, 'mocha': 2, 'ice-coffee': 3, 'dirty-coffee': 2, 'caramel-latte': 3,
  'biscoff-latte': 3, 'black-orange': 2,
  'rosemary-tea': 0, // "never ordered despite availability" in the fixture rankings
  'caramel-fresh-milk': 2, 'chocolate': 3, 'strawberry-cocao': 2, 'matcha-latte-milky': 3, 'thai-tea': 5,
  'strawberry-soda': 3, 'blueberry-soda': 2, 'apple-soda': 2,
  'cold-pressed-watermelon': 4, 'orange-juice-fresh': 4, 'coconut-water-fresh': 5, 'longan-juice': 3,
  'mont-fleur': 4, 'soda-singha': 4, 'singha-lemon-soda': 2, 'pepsi-original': 5, 'pepsi-zero': 3, 'sprite': 3,
  // alcohol
  'beer-budweiser': 3, 'beer-singha': 6, 'beer-chang-classic': 5, 'regency': 1,
};

const COURSE_BY_CATEGORY: Record<string, Course> = {
  'beef-selection': 'main', 'from-the-grill': 'main', 'rice': 'main',
  'appetizers': 'starter', 'salads': 'starter', 'seasonal-avocado': 'starter',
  'side-dishes': 'side', 'dessert': 'dessert',
};

const COOK_MINUTES: Record<string, [number, number]> = {
  'beef-selection': [16, 26], 'from-the-grill': [14, 24], 'rice': [8, 14],
  'appetizers': [7, 14], 'salads': [5, 10], 'seasonal-avocado': [6, 12],
  'side-dishes': [6, 12], 'dessert': [4, 9],
  'bottled-beer': [1, 3], 'whiskey': [2, 4], 'soft-drinks': [1, 2],
};

/** Dishes introduced part-way through the fixture history (rankings show them as New). Local dates. */
export const INTRODUCED: Record<string, string> = {
  'biscoff-latte': '2026-03-02',
  'black-orange': '2026-03-02',
};
/** Local time a newly introduced or restocked dish becomes available. */
export const OPENING_PREP_MINUTES = 10 * 60 + 30;

/** Fixture sold-out spells: Wagyu out for a full week in July 2025. */
export const STATIC_SOLD_OUT: Array<{ key: string; from: string; to: string; reason: string }> = [
  { key: 'wagyu-tenderloin', from: '2025-07-07', to: '2025-07-14', reason: 'Supplier delivery missed' },
];

/** Fixture evenings when Grilled River Prawns ran out (marked sold out by the kitchen). */
export const PRAWN_SELL_OUTS = [
  '2025-02-15', '2025-04-12', '2025-06-21', '2025-08-16', '2025-10-11',
  '2025-12-27', '2026-02-14', '2026-05-16', '2026-08-15',
];

// ------------------------------------------------------------------ loading
interface ItemQueryRow {
  id: string; key: string; category_id: string; category_key: string; group_key: string;
  name_th: string | null; name_en: string | null; pricing_type: PricingType;
  price_minor: number | null; rate_minor: number | null; rate_basis_grams: number | null;
  station: Station; alcohol: number; demo_orderable: number;
}

/** Build the model from the freshly seeded catalog (same connection, inside the seed tx is fine). */
export function loadMenuModel(): MenuModel {
  const rows = many<ItemQueryRow>(
    `SELECT i.id, i.key, i.category_id, c.key AS category_key, g.key AS group_key,
            i.name_th, i.name_en, i.pricing_type, i.price_minor, i.rate_minor, i.rate_basis_grams,
            i.station, i.alcohol, i.demo_orderable
       FROM menu_items i JOIN menu_categories c ON c.id = i.category_id JOIN menu_groups g ON g.id = c.group_id
      WHERE i.status = 'published' AND c.status = 'published'
      ORDER BY g.sort, c.sort, i.sort, i.key`);
  const variants = many<ModelVariant & { item_id: string }>(
    `SELECT id, item_id, key, name_th, name_en, price_minor FROM item_variants
      WHERE available = 1 AND price_minor IS NOT NULL AND archived_at IS NULL ORDER BY sort`);
  const beansRows = many<{ item_id: string; group_id: string; g_th: string | null; g_en: string; id: string; key: string; name_th: string | null; name_en: string; price_delta_minor: number }>(
    `SELECT l.item_id, g.id AS group_id, g.name_th AS g_th, g.name_en AS g_en,
            o.id, o.key, o.name_th, o.name_en, o.price_delta_minor
       FROM item_modifier_groups l JOIN modifier_groups g ON g.id = l.group_id JOIN modifier_options o ON o.group_id = g.id
      WHERE g.key = 'coffee-beans'`);

  const beansByItem = new Map<string, BeansGroup>();
  for (const b of beansRows) {
    const option: ModelOption = { id: b.id, key: b.key, name_th: b.name_th, name_en: b.name_en, price_delta_minor: b.price_delta_minor };
    const entry = beansByItem.get(b.item_id) ?? { group_id: b.group_id, name_th: b.g_th, name_en: b.g_en, house: option, blend: option };
    if (b.key === 'house') entry.house = option;
    if (b.key === 'special-blend') entry.blend = option;
    beansByItem.set(b.item_id, entry);
  }

  const model: MenuModel = {
    visible: [], orderable: [], byKey: new Map(), primeRib: null, categories: [],
    byCourse: { main: [], starter: [], side: [], dessert: [], drink: [], alcohol: [] },
  };
  rows.forEach((row, index) => {
    const drinks = row.group_key === 'drinks';
    const course: Course = row.alcohol === 1 ? 'alcohol' : drinks ? 'drink' : (COURSE_BY_CATEGORY[row.category_key] ?? 'starter');
    const itemVariants = variants.filter((v) => v.item_id === row.id).map(({ item_id: _ignored, ...v }) => v);
    const priced = row.pricing_type === 'fixed' ? row.price_minor !== null
      : row.pricing_type === 'variant' ? itemVariants.length > 0
        : row.rate_minor !== null && row.rate_basis_grams !== null;
    const item: ModelItem = {
      id: row.id, key: row.key, category_id: row.category_id, category_key: row.category_key,
      name_th: row.name_th, name_en: row.name_en, pricing_type: row.pricing_type,
      price_minor: row.price_minor, rate_minor: row.rate_minor, rate_basis_grams: row.rate_basis_grams,
      variants: itemVariants, beans: beansByItem.get(row.id) ?? null,
      station: row.station,
      prep_kind: row.station === 'bar' || drinks || row.category_key === 'dessert' ? 'prepare' : 'cook',
      course,
      weight: WEIGHTS[row.key] ?? 2,
      cook: COOK_MINUTES[row.category_key] ?? (drinks ? [3, 8] : [8, 16]),
      orderable: row.demo_orderable === 1 && priced,
      menu_index: index,
    };
    model.visible.push(item);
    model.byKey.set(item.key, item);
    let cat = model.categories.at(-1);
    if (!cat || cat.id !== item.category_id) {
      cat = { id: item.category_id, key: item.category_key, items: [] };
      model.categories.push(cat);
    }
    cat.items.push(item);
    if (!item.orderable) return;
    if (item.pricing_type === 'measured_weight') {
      if (item.key === 'prime-rib') model.primeRib = item;
      return; // measured cuts are only ever ordered through a confirmed portion quote
    }
    model.orderable.push(item);
    model.byCourse[course].push(item);
  });
  return model;
}

// ------------------------------------------------------------------ availability over time
interface Spell { from: number; to: number }

/**
 * Sold-out / not-yet-introduced intervals per item. Static spells are known up
 * front; "sold out tonight" spells are added while a day is simulated.
 */
export class Availability {
  private spells = new Map<string, Spell[]>();

  add(itemId: string, from: number, to: number): void {
    const list = this.spells.get(itemId) ?? [];
    list.push({ from, to });
    this.spells.set(itemId, list);
  }

  isAvailable(itemId: string, at: number): boolean {
    const list = this.spells.get(itemId);
    if (!list) return true;
    for (const s of list) if (at >= s.from && at < s.to) return false;
    return true;
  }
}

/** Static spells: introductions and the known sell-outs (dynamic ones are added per day). */
export function staticAvailability(model: MenuModel, historyStart: number): Availability {
  const av = new Availability();
  for (const [key, date] of Object.entries(INTRODUCED)) {
    const item = model.byKey.get(key);
    if (item) av.add(item.id, historyStart, bangkokMs(date, OPENING_PREP_MINUTES));
  }
  for (const s of STATIC_SOLD_OUT) {
    const item = model.byKey.get(s.key);
    if (item) av.add(item.id, bangkokMs(s.from, OPENING_PREP_MINUTES), bangkokMs(s.to, OPENING_PREP_MINUTES));
  }
  return av;
}

// ------------------------------------------------------------------ picking
/** Pick an orderable item of `course` that is available at `at`, avoiding `exclude`. */
export function pickItem(r: Rng, model: MenuModel, av: Availability, course: Course, at: number, exclude: Set<string>): ModelItem | null {
  const pool = model.byCourse[course];
  if (pool.length === 0) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const item = r.weighted(pool, (i) => i.weight);
    if (item.weight <= 0) continue;
    if (exclude.has(item.id) || !av.isAvailable(item.id, at)) continue;
    return item;
  }
  return null;
}

/** An evening sell-out is restocked at the next day’s prep time. */
export function nextMorning(date: string): number {
  return bangkokMs(addDays(date, 1), OPENING_PREP_MINUTES);
}
