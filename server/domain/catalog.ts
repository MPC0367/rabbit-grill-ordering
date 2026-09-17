// Catalog read models (S1): the guest menu, the admin catalog, item DTOs,
// public configuration, image lookup and the availability log.
//
// Everything here is a synchronous read (logAvailability excepted) and is
// safe inside or outside tx(). The whole catalog is loaded with a handful of
// set queries and assembled in memory, so a 100-item menu costs a few
// milliseconds rather than hundreds of per-item queries.
//
// Truth rules (brief 04, 09, 11, D-09):
//  - guests only ever see published items in published, in-season categories;
//  - in live mode an unverified item never shows a price as current;
//  - descriptions are public only once verified; allergen entries only once
//    verified (unknown never means allergen-free);
//  - badges are evidence-based: demo_fixture, staff_confirms_portion, alcohol.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdminCatalogDTO, AdminItemDTO, AllergenState, Bilingual, CatalogDTO, MenuCategoryDTO, MenuItemDTO,
  ModifierGroupDTO, PublicConfigDTO,
} from '../../shared/dto.ts';
import { SERVICE_TYPES } from '../../shared/status.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import { config } from '../config.ts';
import { insert, many, one } from '../db/index.ts';
import type { Actor } from '../lib/audit.ts';
import { AppError } from '../lib/errors.ts';
import { cutoffHour, getSettings } from '../lib/settings.ts';
import { publicOrderingState } from './guards.ts';
import {
  bi, catalogVersion, getCategory, hasPrice, getItem, itemGroups, itemVariants, seasonalActive, unavailableReason,
  type CategoryRow, type GroupRow, type ItemRow, type OptionRow, type VariantRow,
} from './pricing.ts';

export type GroupWithOptions = GroupRow & { options: OptionRow[] };

interface MenuGroupRow { id: string; key: 'food' | 'drinks'; name_th: string; name_en: string; sort: number }
interface AllergenRow { item_id: string; allergen: string; state: AllergenState; note: string | null }
interface FlagRow {
  id: string; item_id: string | null; category_id: string | null; code: string; detail: string;
  created_at: string; resolved_at: string | null; resolved_by: string | null; resolution: string | null;
}
interface PriceHistoryRow {
  id: number; item_id: string; variant_id: string | null; price_minor: number | null; rate_minor: number | null;
  changed_at: string; changed_by: string | null; reason: string | null;
  by_name: string | null; variant_key: string | null; variant_name_th: string | null; variant_name_en: string | null;
}

/** Name sources that count as an approved Thai name (see D-S1.3). */
export const TRUSTED_THAI_SOURCES = ['menu_scan'] as const;

// ------------------------------------------------------------------ images
interface ManifestEntry { sizes: number[]; w: number; h: number }
export interface ImageInfo { name: string; w: number; h: number; sizes: number[] }

const MANIFEST_PATH = join(config.publicDir, 'media', 'manifest.json');
const MANIFEST_RECHECK_MS = 10_000;
let manifest: { checkedAt: number; mtimeMs: number; dish: Record<string, ManifestEntry> } | null = null;

/** The processed-photo manifest (`npm run assets`), re-read when the file changes. Missing = no photos. */
function dishManifest(): Record<string, ManifestEntry> {
  const now = Date.now();
  if (manifest && now - manifest.checkedAt < MANIFEST_RECHECK_MS) return manifest.dish;
  let mtimeMs = -1;
  try { mtimeMs = statSync(MANIFEST_PATH).mtimeMs; } catch { /* no manifest: text-led cards */ }
  if (manifest && manifest.mtimeMs === mtimeMs) {
    manifest.checkedAt = now;
    return manifest.dish;
  }
  let dish: Record<string, ManifestEntry> = {};
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { dish?: unknown };
      if (parsed && typeof parsed.dish === 'object' && parsed.dish !== null) dish = parsed.dish as Record<string, ManifestEntry>;
    } catch (err) {
      console.warn('[catalog] media manifest unreadable:', (err as Error).message);
    }
  }
  manifest = { checkedAt: now, mtimeMs, dish };
  return dish;
}

/**
 * Processed photo for a dish image name, or null when no usable asset exists
 * (the card then falls back to text). Files are served at
 * `/media/dish/<name>-<size>.webp` for each size.
 */
export function imageInfo(name: string | null | undefined): ImageInfo | null {
  if (!name) return null;
  const dish = dishManifest();
  if (!Object.hasOwn(dish, name)) return null;
  const e = dish[name];
  if (!e || !Array.isArray(e.sizes) || e.sizes.length === 0 || !Number.isFinite(e.w) || !Number.isFinite(e.h)) return null;
  return { name, w: e.w, h: e.h, sizes: e.sizes.filter((s) => Number.isFinite(s)) };
}

// ------------------------------------------------------------------ loading
interface CatalogData {
  groups: MenuGroupRow[];
  categories: CategoryRow[];
  categoryById: Map<string, CategoryRow>;
  items: ItemRow[];
  variants: Map<string, VariantRow[]>;
  links: Map<string, string[]>;
  modGroups: Map<string, GroupWithOptions>;
  allergens: Map<string, AllergenRow[]>;
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

/** Load the catalog (or one item's slice of it) in display order. */
function loadCatalog(itemId?: string): CatalogData {
  const byItem = itemId !== undefined;
  const p = byItem ? { id: itemId } : undefined;
  const groups = many<MenuGroupRow>('SELECT id, key, name_th, name_en, sort FROM menu_groups ORDER BY sort, key');
  const categories = many<CategoryRow>(
    `SELECT c.*, g.key AS group_key FROM menu_categories c JOIN menu_groups g ON g.id = c.group_id
      ORDER BY g.sort, c.sort, c.key`);
  const items = many<ItemRow>(
    `SELECT i.* FROM menu_items i
       JOIN menu_categories c ON c.id = i.category_id JOIN menu_groups g ON g.id = c.group_id
      ${byItem ? 'WHERE i.id = :id' : ''}
      ORDER BY g.sort, c.sort, c.key, i.sort, i.key`, p);
  const variants = many<VariantRow>(
    `SELECT * FROM item_variants WHERE archived_at IS NULL ${byItem ? 'AND item_id = :id' : ''}
      ORDER BY item_id, sort, key`, p);
  const links = many<{ item_id: string; group_id: string }>(
    `SELECT l.item_id, l.group_id FROM item_modifier_groups l JOIN modifier_groups g ON g.id = l.group_id
      WHERE g.archived_at IS NULL ${byItem ? 'AND l.item_id = :id' : ''}
      ORDER BY l.item_id, l.sort, g.key`, p);
  const groupRows = many<GroupRow>('SELECT * FROM modifier_groups WHERE archived_at IS NULL ORDER BY key');
  const options = groupBy(
    many<OptionRow>('SELECT * FROM modifier_options WHERE archived_at IS NULL ORDER BY group_id, sort, key'),
    (o) => o.group_id,
  );
  const allergens = many<AllergenRow>(
    `SELECT item_id, allergen, state, note FROM item_allergens ${byItem ? 'WHERE item_id = :id' : ''}
      ORDER BY item_id, allergen`, p);
  return {
    groups,
    categories,
    categoryById: new Map(categories.map((c) => [c.id, c])),
    items,
    variants: groupBy(variants, (v) => v.item_id),
    links: new Map([...groupBy(links, (l) => l.item_id)].map(([k, v]) => [k, v.map((l) => l.group_id)])),
    modGroups: new Map(groupRows.map((g) => [g.id, { ...g, options: options.get(g.id) ?? [] }])),
    allergens: groupBy(allergens, (a) => a.item_id),
  };
}

function itemGroupsFrom(data: CatalogData, itemId: string): GroupWithOptions[] {
  return (data.links.get(itemId) ?? []).map((id) => data.modGroups.get(id)).filter((g): g is GroupWithOptions => Boolean(g));
}

// ------------------------------------------------------------------ orderability
/**
 * Foundation unavailableReason() plus two catalog refinements, so the menu
 * never shows an item as orderable when submission would certainly fail:
 *  - a variant item whose priced variants are all switched off is sold out
 *    (not "price pending");
 *  - an item whose required choice has too few available options is sold out.
 */
export function orderReason(item: ItemRow, cat: CategoryRow, variants: VariantRow[], groups: GroupWithOptions[]): string | null {
  const base = unavailableReason(item, cat, variants);
  if (base === 'price_pending' && item.pricing_type === 'variant'
      && variants.some((v) => v.price_minor !== null)
      && !variants.some((v) => v.available === 1 && v.price_minor !== null)) {
    return 'sold_out';
  }
  if (base === null && groups.some((g) => g.min_select > 0 && availableOptions(g) < g.min_select)) return 'sold_out';
  if (getSettings().operating_mode === 'live' && item.review_status !== 'verified'
      && (base === null || base === 'price_pending' || base === 'not_verified')) {
    return 'not_verified';
  }
  return base;
}

function availableOptions(g: GroupWithOptions): number {
  return g.options.filter((o) => o.available === 1).length;
}

/** Current effective orderability of one item (fresh queries; use inside tx for before/after checks). */
export function isItemOrderable(itemId: string): boolean {
  const item = getItem(itemId);
  if (!item) return false;
  const cat = getCategory(item.category_id);
  if (!cat) return false;
  return orderReason(item, cat, itemVariants(item.id), itemGroups(item.id)) === null;
}

/**
 * Reasons an item cannot be published (brief 21). Image absence never blocks.
 * Codes: missing_name, missing_price, missing_rate, no_priced_variant,
 * required_choice_unavailable, not_verified (live mode only).
 */
export function publishBlockers(item: ItemRow, variants: VariantRow[], groups: GroupWithOptions[]): string[] {
  const blockers: string[] = [];
  if (!item.name_th && !item.name_en) blockers.push('missing_name');
  switch (item.pricing_type) {
    case 'fixed':
      if (item.price_minor === null) blockers.push('missing_price');
      break;
    case 'measured_weight':
      if (item.rate_minor === null || item.rate_basis_grams === null) blockers.push('missing_rate');
      break;
    case 'variant':
      if (!variants.some((v) => v.available === 1 && v.price_minor !== null)) blockers.push('no_priced_variant');
      break;
  }
  if (groups.some((g) => g.min_select > 0 && availableOptions(g) < g.min_select)) blockers.push('required_choice_unavailable');
  if (getSettings().operating_mode === 'live' && item.review_status !== 'verified') blockers.push('not_verified');
  return blockers;
}

export function publishBlockersFor(itemId: string): string[] {
  const item = getItem(itemId);
  if (!item) return ['missing_item'];
  return publishBlockers(item, itemVariants(item.id), itemGroups(item.id));
}

// ------------------------------------------------------------------ availability log
/**
 * Record a change in an item's effective orderability (brief 44D: fair
 * least-ordered rankings). Consecutive duplicates are skipped so each row is a
 * real transition. Reasons: sold_out | restocked | published | archived |
 * seasonal | category_paused | orderability.
 */
export function logAvailability(itemId: string, available: boolean, reason: string, actor: Actor | string | null): void {
  const last = one<{ available: number }>('SELECT available FROM availability_log WHERE item_id = ? ORDER BY id DESC LIMIT 1', [itemId]);
  if (last && (last.available === 1) === available) return;
  const by = actor === null ? 'system' : typeof actor === 'string' ? actor : actor.type === 'staff' ? actor.id : (actor.label ?? actor.type);
  insert('availability_log', {
    item_id: itemId,
    available: available ? 1 : 0,
    reason,
    changed_at: nowIso(),
    changed_by: by,
  });
}

// ------------------------------------------------------------------ DTO assembly
const optionalBi = (th: string | null, en: string | null): Bilingual | null => (th || en ? bi(th, en) : null);

function groupDTO(g: GroupWithOptions): ModifierGroupDTO {
  return {
    id: g.id,
    name: bi(g.name_th, g.name_en),
    min_select: g.min_select,
    max_select: g.max_select,
    included_count: g.included_count,
    options: g.options.map((o) => ({
      id: o.id,
      name: bi(o.name_th, o.name_en),
      price_delta_minor: o.price_delta_minor,
      upgrade_minor: o.upgrade_minor,
      is_default: o.is_default === 1,
      available: o.available === 1,
    })),
  };
}

function buildMenuItem(item: ItemRow, cat: CategoryRow, data: CatalogData, audience: 'public' | 'admin'): MenuItemDTO {
  const s = getSettings();
  const variants = data.variants.get(item.id) ?? [];
  const groups = itemGroupsFrom(data, item.id);
  const verified = item.review_status === 'verified';
  const reason = orderReason(item, cat, variants, groups);
  // Live mode: an unverified price is never presented to guests as current.
  const hidePrices = audience === 'public' && s.operating_mode === 'live' && !verified;
  const allergenRows = data.allergens.get(item.id) ?? [];
  const showAllergenEntries = audience === 'admin' || item.allergen_status === 'verified';
  const img = imageInfo(item.image);
  const badges: string[] = [];
  if (s.operating_mode === 'demo' && !verified) badges.push('demo_fixture');
  if (item.pricing_type === 'measured_weight') badges.push('staff_confirms_portion');
  if (item.alcohol === 1 || cat.alcohol === 1) badges.push('alcohol');
  const orderable = reason === null;
  return {
    id: item.id,
    key: item.key,
    category_id: item.category_id,
    name: bi(item.name_th, item.name_en),
    description: item.desc_verified === 1 ? optionalBi(item.desc_th, item.desc_en) : null,
    portion_note: optionalBi(item.portion_note_th, item.portion_note_en),
    pricing_type: item.pricing_type,
    price_minor: item.pricing_type === 'fixed' && !hidePrices ? item.price_minor : null,
    rate_minor: item.pricing_type === 'measured_weight' && !hidePrices ? item.rate_minor : null,
    rate_basis_grams: item.pricing_type === 'measured_weight' ? item.rate_basis_grams : null,
    variants: item.pricing_type === 'variant'
      ? variants.map((v) => ({
        id: v.id,
        key: v.key,
        name: bi(v.name_th, v.name_en),
        price_minor: hidePrices ? null : v.price_minor,
        available: v.available === 1,
      }))
      : [],
    modifier_groups: groups.map(groupDTO),
    image: img ? { ...img, alt: bi(item.image_alt_th, item.image_alt_en) } : null,
    station: item.station,
    alcohol: item.alcohol === 1 || cat.alcohol === 1,
    notes_allowed: item.notes_allowed === 1,
    note_max: Math.min(item.note_max, s.menu.note_max_length),
    max_qty: item.max_qty,
    sold_out: item.sold_out === 1,
    orderable,
    unavailable_reason: reason,
    quick_add: orderable && item.pricing_type === 'fixed' && !groups.some((g) => g.min_select > 0),
    allergens: {
      status: item.allergen_status,
      entries: showAllergenEntries ? allergenRows.map((a) => ({ allergen: a.allergen, state: a.state, note: a.note })) : [],
      verified_at: item.allergen_status === 'verified' ? item.allergen_verified_at : null,
    },
    badges,
    sort: item.sort,
    version: item.version,
  };
}

function buildCategory(cat: CategoryRow, itemIds: string[]): MenuCategoryDTO {
  return {
    id: cat.id,
    key: cat.key,
    group: cat.group_key,
    name: bi(cat.name_th, cat.name_en),
    note: optionalBi(cat.note_th, cat.note_en),
    seasonal: cat.seasonal === 1,
    alcohol: cat.alcohol === 1,
    sort: cat.sort,
    item_ids: itemIds,
  };
}

// ------------------------------------------------------------------ public menu
/** The guest menu: published, in-season, non-empty categories only. */
export function publicCatalog(): CatalogDTO {
  const s = getSettings();
  const data = loadCatalog();
  const today = businessDate(Date.now(), cutoffHour());
  const visible = new Set(data.categories.filter((c) => c.status === 'published' && seasonalActive(c, today)).map((c) => c.id));
  const itemsByCat = new Map<string, MenuItemDTO[]>();
  for (const item of data.items) {
    if (item.status !== 'published' || !visible.has(item.category_id)) continue;
    const cat = data.categoryById.get(item.category_id)!;
    const dto = buildMenuItem(item, cat, data, 'public');
    if (s.menu.sold_out_display === 'hide' && (item.sold_out === 1 || dto.unavailable_reason === 'sold_out')) continue;
    const list = itemsByCat.get(cat.id);
    if (list) list.push(dto); else itemsByCat.set(cat.id, [dto]);
  }
  const categories = data.categories
    .filter((c) => itemsByCat.has(c.id))
    .map((c) => buildCategory(c, itemsByCat.get(c.id)!.map((i) => i.id)));
  const groups = data.groups
    .map((g) => ({ key: g.key, name: bi(g.name_th, g.name_en), category_ids: categories.filter((c) => c.group === g.key).map((c) => c.id) }))
    .filter((g) => g.category_ids.length > 0);
  return {
    version: catalogVersion(),
    groups,
    categories,
    items: categories.flatMap((c) => itemsByCat.get(c.id)!),
    generated_at: nowIso(),
  };
}

/** One item as guests see it (published or not: callers decide what to do with it). */
export function menuItemDTO(itemId: string): MenuItemDTO {
  const data = loadCatalog(itemId);
  const item = data.items[0];
  if (!item) throw new AppError('not_found', 'Menu item not found');
  return buildMenuItem(item, data.categoryById.get(item.category_id)!, data, 'public');
}

export function publicConfig(): PublicConfigDTO {
  const s = getSettings();
  return {
    restaurant: { ...s.restaurant },
    operating_mode: s.operating_mode,
    default_locale: s.default_locale,
    ordering: publicOrderingState(),
    services: SERVICE_TYPES.filter((t) => s.services[t]),
    analytics: {
      enabled: s.analytics.enabled,
      idle_threshold_seconds: s.analytics.idle_threshold_seconds,
      heartbeat_seconds: s.analytics.heartbeat_seconds,
    },
    notes_max_length: s.menu.note_max_length,
    sold_out_display: s.menu.sold_out_display,
    server_time: nowIso(),
  };
}

// ------------------------------------------------------------------ admin catalog
interface AdminExtras {
  flags: Map<string, FlagRow[]>;
  history: Map<string, PriceHistoryRow[]>;
}

function loadAdminExtras(itemId?: string): AdminExtras {
  const byItem = itemId !== undefined;
  const p = byItem ? { id: itemId } : undefined;
  const flags = many<FlagRow>(
    `SELECT * FROM item_flags WHERE item_id IS NOT NULL ${byItem ? 'AND item_id = :id' : ''} ORDER BY created_at, id`, p);
  const history = many<PriceHistoryRow>(
    `SELECT p.*, COALESCE(u.display_name, p.changed_by) AS by_name,
            v.key AS variant_key, v.name_th AS variant_name_th, v.name_en AS variant_name_en
       FROM price_history p
       LEFT JOIN staff_users u ON u.id = p.changed_by
       LEFT JOIN item_variants v ON v.id = p.variant_id
      ${byItem ? 'WHERE p.item_id = :id' : ''}
      ORDER BY p.changed_at DESC, p.id DESC`, p);
  return { flags: groupBy(flags, (f) => f.item_id!), history: groupBy(history, (h) => h.item_id) };
}

function buildAdminItem(item: ItemRow, cat: CategoryRow, data: CatalogData, extras: AdminExtras): AdminItemDTO {
  const base = buildMenuItem(item, cat, data, 'admin');
  const variants = data.variants.get(item.id) ?? [];
  const groups = itemGroupsFrom(data, item.id);
  const history = extras.history.get(item.id) ?? [];
  return {
    ...base,
    status: item.status,
    review_status: item.review_status,
    demo_orderable: item.demo_orderable === 1,
    description_admin: bi(item.desc_th, item.desc_en),
    desc_verified: item.desc_verified === 1,
    name_th_source: item.name_th_source,
    translation_status: item.translation_status,
    source: { url: item.source_url, ref: item.source_ref, text: item.source_text, retrieved_at: item.retrieved_at },
    reviewer: item.reviewer,
    approved_at: item.approved_at,
    review_notes: item.review_notes,
    flags: (extras.flags.get(item.id) ?? []).map((f) => ({
      id: f.id, code: f.code, detail: f.detail, resolved_at: f.resolved_at, resolution: f.resolution,
    })),
    price_history: history.filter((h) => h.variant_id === null).map((h) => ({
      at: h.changed_at, price_minor: h.price_minor, rate_minor: h.rate_minor, by: h.by_name, reason: h.reason,
    })),
    publish_blockers: publishBlockers(item, variants, groups),
    unpublished_changes: item.published_version !== item.version,
    requires_staff_confirm: item.requires_staff_confirm === 1,
    modifier_group_ids: groups.map((g) => g.id),
    updated_at: item.updated_at,
    variant_price_history: history.filter((h) => h.variant_id !== null).map((h) => ({
      at: h.changed_at,
      variant_id: h.variant_id!,
      variant_key: h.variant_key,
      variant_name: h.variant_key === null ? null : bi(h.variant_name_th, h.variant_name_en),
      price_minor: h.price_minor,
      by: h.by_name,
      reason: h.reason,
    })),
  };
}

export function adminItemDTO(itemId: string): AdminItemDTO {
  const data = loadCatalog(itemId);
  const item = data.items[0];
  if (!item) throw new AppError('not_found', 'Menu item not found');
  return buildAdminItem(item, data.categoryById.get(item.category_id)!, data, loadAdminExtras(itemId));
}

/** True when the Thai name is missing or not yet approved (review queue counter). */
export function thaiNameNeedsReview(item: Pick<ItemRow, 'name_th' | 'name_th_source' | 'translation_status'>): boolean {
  if (!item.name_th) return true;
  if ((TRUSTED_THAI_SOURCES as readonly string[]).includes(item.name_th_source ?? '')) return false;
  return item.translation_status !== 'verified';
}

/** Everything the menu editor needs, including drafts, archived records and the review queue. */
export function adminCatalog(): AdminCatalogDTO {
  const data = loadCatalog();
  const extras = loadAdminExtras();
  const today = businessDate(Date.now(), cutoffHour());
  const items = data.items.map((item) => buildAdminItem(item, data.categoryById.get(item.category_id)!, data, extras));
  const itemIdsByCat = groupBy(data.items, (i) => i.category_id);
  const itemIdsByGroup = new Map<string, string[]>();
  for (const [itemId, groupIds] of data.links) {
    for (const g of groupIds) {
      const list = itemIdsByGroup.get(g);
      if (list) list.push(itemId); else itemIdsByGroup.set(g, [itemId]);
    }
  }

  // Review queue (brief 34, 44E). `imported` counts every record; the rest
  // ignore archived records, which have left the review workflow.
  const live = data.items.filter((i) => i.status !== 'archived');
  const openFlags = many<FlagRow>('SELECT * FROM item_flags WHERE resolved_at IS NULL');
  const ambiguous = new Set(openFlags.filter((f) => f.code === 'ambiguous_price' && f.item_id).map((f) => f.item_id));
  const review: AdminCatalogDTO['review'] = {
    imported: data.items.length,
    live_ready: live.filter((i) => i.status === 'published' && i.review_status === 'verified'
      && hasPrice(i, data.variants.get(i.id) ?? [])).length,
    demo_orderable: live.filter((i) => i.demo_orderable === 1).length,
    missing_photo: live.filter((i) => imageInfo(i.image) === null).length,
    missing_description: live.filter((i) => i.desc_verified !== 1 || (!i.desc_th && !i.desc_en)).length,
    missing_thai: live.filter(thaiNameNeedsReview).length,
    ambiguous_price: live.filter((i) => ambiguous.has(i.id)).length,
    pending_portion_rules: live.filter((i) => i.pricing_type === 'measured_weight' && i.review_status !== 'verified').length,
    seasonal_disabled: live.filter((i) => {
      const cat = data.categoryById.get(i.category_id)!;
      if (cat.seasonal !== 1) return false;
      return !(i.status === 'published' && cat.status === 'published' && seasonalActive(cat, today));
    }).length,
    open_flags: openFlags.length,
  };

  return {
    groups: data.groups.map((g) => ({
      key: g.key,
      name: bi(g.name_th, g.name_en),
      category_ids: data.categories.filter((c) => c.group_id === g.id).map((c) => c.id),
    })),
    categories: data.categories.map((c) => ({
      ...buildCategory(c, (itemIdsByCat.get(c.id) ?? []).map((i) => i.id)),
      status: c.status,
      ordering_paused: c.ordering_paused === 1,
      station: c.station,
      active_from: c.active_from,
      active_until: c.active_until,
      source_note: c.source_note,
      version: c.version,
    })),
    items,
    modifier_groups: [...data.modGroups.values()].map((g) => ({
      ...groupDTO(g),
      key: g.key,
      item_ids: itemIdsByGroup.get(g.id) ?? [],
      version: g.version,
    })),
    review,
  };
}
