// Draft catalog import from data-src/catalog.json (audited against the
// restaurant's own menu scans - docs/source-audit.md).
//
// Rules (brief 04, 44; D-09):
//  - nothing is owner-verified: review_status is `unverified`, or
//    `needs_review` when a flag says the record itself is uncertain;
//  - an item is published only when its category publishes;
//  - demo_orderable comes from the audit (`orderable_in_demo`);
//  - no descriptions, allergens, doneness options or modifiers are invented.
//    The single sourced modifier is the coffee page's "SPECIAL BLEND (+30 THB)",
//    attached for the demo to espresso drinks and flagged for owner review.
import { readFileSync } from 'node:fs';
import { bahtToMinor } from '../../../shared/money.ts';
import type { PricingType, Station } from '../../../shared/status.ts';
import type { Rng, Writer } from './util.ts';

// ------------------------------------------------------------------ source shapes
interface SourceFlag { code: string; detail: string }

interface SourceVariant {
  key: string;
  name_th: string | null;
  name_en: string | null;
  price_baht: number | null;
  available: boolean;
  source_text: string | null;
}

interface SourceItem {
  key: string;
  category: string;
  sort: number;
  name_th: string | null;
  name_en: string | null;
  name_th_source: string | null;
  source_text: string | null;
  source_ref: string | null;
  desc_th: string | null;
  desc_en: string | null;
  pricing_type: PricingType;
  price_baht: number | null;
  rate_baht: number | null;
  rate_basis_grams: number | null;
  portion_note_th: string | null;
  portion_note_en: string | null;
  variants: SourceVariant[];
  image: string | null;
  image_alt_th: string | null;
  image_alt_en: string | null;
  station: Station;
  alcohol: boolean;
  flags: SourceFlag[];
  orderable_in_demo: boolean;
}

interface SourceCategory {
  key: string;
  group: 'food' | 'drinks';
  name_th: string | null;
  name_en: string;
  note_th: string | null;
  note_en: string | null;
  sort: number;
  publish: boolean;
  seasonal: boolean;
  station: Station;
  alcohol: boolean;
  source_note: string | null;
}

interface SourceCatalog {
  source: { reference_url: string; retrieved_at: string };
  groups: Array<{ key: 'food' | 'drinks'; name_th: string; name_en: string; sort: number }>;
  categories: SourceCategory[];
  items: SourceItem[];
}

interface MediaManifest {
  dish: Record<string, { sizes: number[]; w: number; h: number }>;
}

const CATALOG_URL = new URL('../../../data-src/catalog.json', import.meta.url);
const MANIFEST_URL = new URL('../../../public/media/manifest.json', import.meta.url);

/** Flags that make the record itself uncertain (not just incomplete). */
const NEEDS_REVIEW_CODES = new Set([
  'ambiguous_price', 'needs_owner_explanation', 'seasonal_unconfirmed',
  'volume_in_wrong_field', 'unspecified_variant', 'duplicate_name',
]);

/**
 * Espresso-based drinks on bev-01 that get the demo "Beans" choice. "Ice Coffee"
 * is left out: the scan does not show whether it is an espresso drink.
 */
const ESPRESSO_COFFEES = [
  'short-black', 'long-black', 'long-black-coconut', 'long-black-longan', 'piccolo-latte',
  'latte', 'cappuccino', 'mocha', 'dirty-coffee', 'caramel-latte', 'biscoff-latte', 'black-orange',
];

const MODIFIER_FLAG_DETAIL =
  'Demo fixture: the coffee page (bev-01) prints "SPECIAL BLEND / Balanced Blend - Bluetamp (+30 THB)" but not which coffees can take it. ' +
  'The Beans choice is attached to this espresso drink for the demo only; the owner must confirm which coffees offer the blend before live use.';

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function loadManifest(): MediaManifest {
  try {
    return readJson<MediaManifest>(MANIFEST_URL);
  } catch {
    // No processed photos yet (npm run assets): every dish imports without an image.
    return { dish: {} };
  }
}

export interface CatalogSeedResult {
  groups: number;
  categories: number;
  items: number;
  published: number;
  demoOrderable: number;
  needsReview: number;
  flags: number;
  missingImages: number;
}

/**
 * Insert groups, categories, items, variants, flags, price and availability
 * history, and the one sourced modifier group. Runs inside the caller's tx.
 *
 * `availableSince` stamps the initial availability rows. With fixture history
 * this is the start of that history, so rankings see the dishes as available
 * for the whole synthetic period; otherwise it is the import time.
 * `introducedLater` lists item keys the fixture history introduces part-way
 * through: they start unavailable and the history logs when they arrive.
 */
export function seedCatalog(w: Writer, r: Rng, opts: { now: string; availableSince: string; introducedLater?: readonly string[] }): CatalogSeedResult {
  const src = readJson<SourceCatalog>(CATALOG_URL);
  const manifest = loadManifest();
  const { now } = opts;
  const result: CatalogSeedResult = { groups: 0, categories: 0, items: 0, published: 0, demoOrderable: 0, needsReview: 0, flags: 0, missingImages: 0 };

  // ---- groups
  const groupIds = new Map<string, string>();
  for (const g of src.groups) {
    const id = r.id('mgr');
    groupIds.set(g.key, id);
    w.put('menu_groups', { id, key: g.key, name_th: g.name_th, name_en: g.name_en, sort: g.sort });
    result.groups++;
  }

  // ---- categories
  const categories = new Map<string, { id: string; published: boolean; station: Station; alcohol: boolean }>();
  for (const c of src.categories) {
    const groupId = groupIds.get(c.group);
    if (!groupId) throw new Error(`catalog.json: category ${c.key} has unknown group ${c.group}`);
    const id = r.id('cat');
    categories.set(c.key, { id, published: c.publish, station: c.station, alcohol: c.alcohol });
    w.put('menu_categories', {
      id, key: c.key, group_id: groupId,
      name_th: c.name_th, name_en: c.name_en, note_th: c.note_th, note_en: c.note_en,
      sort: c.sort, status: c.publish ? 'published' : 'draft',
      seasonal: c.seasonal, active_from: null, active_until: null,
      station: c.station, alcohol: c.alcohol, ordering_paused: 0,
      source_note: c.source_note,
      created_at: now, updated_at: now, updated_by: null, version: 1,
    });
    result.categories++;
  }

  // ---- the sourced coffee modifier
  const beansGroupId = r.id('mgp');
  w.put('modifier_groups', {
    id: beansGroupId, key: 'coffee-beans', name_th: 'เมล็ดกาแฟ', name_en: 'Beans',
    min_select: 0, max_select: 1, included_count: 0, archived_at: null,
    created_at: now, updated_at: now, version: 1,
  });
  // Option names are the printed bean names; the menu prints no Thai names for them.
  w.put('modifier_options', {
    id: r.id('mop'), group_id: beansGroupId, key: 'house', name_th: null, name_en: 'Laos Bolaven single-origin',
    price_delta_minor: 0, upgrade_minor: 0, is_default: 1, available: 1, archived_at: null, sort: 10,
  });
  w.put('modifier_options', {
    id: r.id('mop'), group_id: beansGroupId, key: 'special-blend', name_th: null, name_en: 'Balanced Blend - Bluetamp',
    price_delta_minor: bahtToMinor(30), upgrade_minor: 0, is_default: 0, available: 1, archived_at: null, sort: 20,
  });

  // ---- items
  const addFlag = (itemId: string, code: string, detail: string) => {
    w.put('item_flags', { id: r.id('flg'), item_id: itemId, category_id: null, code, detail, created_at: now });
    result.flags++;
  };

  for (const it of src.items) {
    const cat = categories.get(it.category);
    if (!cat) throw new Error(`catalog.json: item ${it.key} has unknown category ${it.category}`);
    const id = r.id('itm');
    const published = cat.published;
    const codes = new Set(it.flags.map((f) => f.code));
    const needsReview = it.flags.some((f) => NEEDS_REVIEW_CODES.has(f.code));
    const media = it.image ? manifest.dish[it.image] : undefined;
    const image = media ? it.image : null;
    const hasDesc = Boolean(it.desc_th || it.desc_en);
    const demoOrderable = it.orderable_in_demo === true;

    w.put('menu_items', {
      id, key: it.key, category_id: cat.id, sort: it.sort,
      name_th: it.name_th, name_en: it.name_en, name_th_source: it.name_th_source,
      desc_th: it.desc_th, desc_en: it.desc_en, desc_verified: hasDesc ? 1 : 0,
      portion_note_th: it.portion_note_th, portion_note_en: it.portion_note_en,
      pricing_type: it.pricing_type,
      price_minor: it.pricing_type === 'fixed' && it.price_baht !== null ? bahtToMinor(it.price_baht) : null,
      rate_minor: it.pricing_type === 'measured_weight' && it.rate_baht !== null ? bahtToMinor(it.rate_baht) : null,
      rate_basis_grams: it.pricing_type === 'measured_weight' ? it.rate_basis_grams : null,
      status: published ? 'published' : 'draft',
      review_status: needsReview ? 'needs_review' : 'unverified',
      demo_orderable: demoOrderable,
      sold_out: 0, sold_out_since: null,
      notes_allowed: 1, note_max: 140, max_qty: 20,
      station: it.station, alcohol: it.alcohol, requires_staff_confirm: it.alcohol,
      image, image_alt_th: image ? it.image_alt_th : null, image_alt_en: image ? it.image_alt_en : null,
      allergen_status: 'unknown',
      source_url: src.source.reference_url, source_ref: it.source_ref, source_text: it.source_text,
      retrieved_at: src.source.retrieved_at, translation_status: it.name_th_source,
      reviewer: null, approved_at: null, review_notes: null,
      published_version: published ? 1 : null,
      created_at: now, updated_at: now, updated_by: null, version: 1,
    });
    result.items++;
    if (published) result.published++;
    if (demoOrderable) result.demoOrderable++;
    if (needsReview) result.needsReview++;

    // variants (an unavailable printed dash keeps a null price - never "free")
    let sort = 10;
    const variantPrices: Array<{ id: string; price: number | null }> = [];
    for (const v of it.variants) {
      const vid = r.id('var');
      const price = v.available && v.price_baht !== null ? bahtToMinor(v.price_baht) : null;
      w.put('item_variants', {
        id: vid, item_id: id, key: v.key, name_th: v.name_th, name_en: v.name_en,
        price_minor: price, available: v.available && price !== null, archived_at: null,
        sort, source_text: v.source_text,
      });
      variantPrices.push({ id: vid, price });
      sort += 10;
    }

    // flags: every audit flag, plus the photo gap when the manifest lacks the dish
    for (const f of it.flags) addFlag(id, f.code, f.detail);
    if (!image) {
      result.missingImages++;
      if (!codes.has('missing_image')) {
        addFlag(id, 'missing_image', it.image
          ? `The audit maps this dish to photo "${it.image}", but public/media/manifest.json has no processed image for it (run npm run assets).`
          : 'No verified photo of this item exists.');
      }
    }

    // price history: the imported price(s) as printed
    const history = (price: number | null, rate: number | null, variantId: string | null) => w.put('price_history', {
      item_id: id, variant_id: variantId, price_minor: price, rate_minor: rate,
      changed_at: now, changed_by: null, reason: 'imported from menu scan',
    });
    if (it.pricing_type === 'variant') {
      for (const v of variantPrices) if (v.price !== null) history(v.price, null, v.id);
    } else if (it.pricing_type === 'measured_weight') {
      history(null, it.rate_baht !== null ? bahtToMinor(it.rate_baht) : null, null);
    } else {
      history(it.price_baht !== null ? bahtToMinor(it.price_baht) : null, null, null);
    }

    // availability: what a guest could order in demo mode from the start
    const available = published && demoOrderable && !opts.introducedLater?.includes(it.key);
    w.put('availability_log', {
      item_id: id, available, reason: available ? 'published' : 'orderability',
      changed_at: opts.availableSince, changed_by: null,
    });

    if (it.category === 'coffee' && ESPRESSO_COFFEES.includes(it.key)) {
      w.put('item_modifier_groups', { item_id: id, group_id: beansGroupId, sort: 10 });
      addFlag(id, 'demo_modifier_attachment', MODIFIER_FLAG_DETAIL);
    }
  }

  w.put('audit_events', {
    actor_type: 'system', actor_id: null, actor_label: 'seed', action: 'menu.seed_import',
    entity_type: 'catalog', entity_id: null, visit_id: null,
    reason: 'Development fixtures: draft catalog imported from data-src/catalog.json',
    before_json: null,
    after_json: JSON.stringify({ items: result.items, categories: result.categories, retrieved_at: src.source.retrieved_at }),
    created_at: now,
  });
  return result;
}
