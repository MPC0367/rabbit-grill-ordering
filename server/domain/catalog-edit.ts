// Catalog mutations (S1): items, variants, categories, modifier groups,
// placement, review flags and the restaurant-wide ordering state.
//
// Every function here is synchronous and must run inside tx(). Each one
// re-reads the row, checks the version the client saw, writes, audits and
// emits `menu.updated` (audience 'all', so guest menus refresh) in the same
// transaction.
//
// Edit policy (docs/DECISIONS.md D-S1.1): edits apply immediately. An edit
// to a published item leaves `published_version` behind, so the editor shows
// "unpublished changes" until someone re-publishes; a price change also sets
// review_status = needs_review, which in live mode takes the item off sale
// until the owner verifies the new price.
import type { z } from 'zod';
import type { AdminCatalogDTO, AdminItemDTO, StaffOrderingDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import type { Permission } from '../../shared/permissions.ts';
import type {
  AvailabilityBody, CategoryInput, CreateItemBody, ItemStatusBody, ModifierGroupInput, OrderingStateBody,
  ReorderBody, ResolveFlagBody, ReviewBody, UpdateCategoryBody, UpdateItemBody,
} from '../../shared/schemas.ts';
import type { PricingType } from '../../shared/status.ts';
import { nowIso } from '../../shared/time.ts';
import { insert, many, one, run, updateVersioned } from '../db/index.ts';
import { audit, type Actor } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { getSettings, putSetting } from '../lib/settings.ts';
import { adminCatalog, adminItemDTO, isItemOrderable, logAvailability, publishBlockersFor } from './catalog.ts';
import { publicOrderingState, unacceptedRounds } from './guards.ts';
import { catalogVersion, getCategory, getItem, type GroupRow, type ItemRow, type OptionRow, type VariantRow } from './pricing.ts';

export type CreateItemInput = z.infer<typeof CreateItemBody>;
export type UpdateItemInput = z.infer<typeof UpdateItemBody>;
export type CategoryInputT = z.infer<typeof CategoryInput>;
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryBody>;
export type ModifierGroupInputT = z.infer<typeof ModifierGroupInput>;
export type VariantInput = NonNullable<CreateItemInput['variants']>[number];
type OptionInput = ModifierGroupInputT['options'][number];

// ------------------------------------------------------------------ helpers
/** Throw a validation error in the same shape body() uses. */
export function invalid(path: string, message: string): never {
  throw new AppError('validation_failed', message, { issues: [{ path, message, code: 'custom' }] });
}

function notFound(what: string): never {
  throw new AppError('not_found', `${what} not found`);
}

function requirePerm(staff: StaffContext, perm: Permission): void {
  if (!staff.can(perm)) throw new AppError('forbidden', 'Your role cannot do this.', { permission: perm });
}

/** Trim; blank becomes null; undefined stays undefined ("not provided"). */
export function clean(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function slugify(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

/** A key not yet used in `table` (menu_items / menu_categories / modifier_groups). */
export function uniqueKey(table: 'menu_items' | 'menu_categories' | 'modifier_groups', base: string): string {
  const root = base || `${table === 'menu_items' ? 'item' : table === 'menu_categories' ? 'category' : 'group'}-${newId('x').slice(2, 8).toLowerCase()}`;
  let key = root;
  for (let n = 2; one(`SELECT 1 AS x FROM ${table} WHERE key = ?`, [key]); n++) key = `${root}-${n}`;
  return key;
}

export function nextItemSort(categoryId: string): number {
  return (one<{ s: number | null }>('SELECT MAX(sort) AS s FROM menu_items WHERE category_id = ?', [categoryId])?.s ?? 0) + 10;
}

const flag = (v: boolean | undefined): 0 | 1 | undefined => (v === undefined ? undefined : v ? 1 : 0);

/** Keep "no unpublished changes" true across non-content writes (availability, review, status). */
function syncedPublishedVersion(item: ItemRow): number | null {
  return item.published_version === item.version ? item.version + 1 : item.published_version;
}

function emitMenu(entity: { type: string; id: string; version?: number | null }, payload: Record<string, unknown>): void {
  emit('menu.updated', { audience: 'all', entity, payload: { ...payload, catalog_version: catalogVersion() } });
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  // Internal review notes are summarised, never copied into the audit trail.
  return Object.fromEntries(keys.map((k) => [k, k === 'review_notes' ? (row[k] ? '[set]' : null) : row[k]]));
}

/**
 * Run `fn` and record availability transitions for the given items: any item
 * whose effective orderability differs afterwards gets an availability_log row.
 */
export function trackOrderability<T>(itemIds: readonly string[], reason: string, actor: Actor, fn: () => T): T {
  const before = new Map(itemIds.map((id) => [id, isItemOrderable(id)]));
  const result = fn();
  for (const id of itemIds) {
    const after = isItemOrderable(id);
    if (after !== before.get(id)) logAvailability(id, after, reason, actor);
  }
  return result;
}

function mustItem(id: string): ItemRow {
  return getItem(id) ?? notFound('Menu item');
}

export function normalizePricing(type: PricingType, price: number | null, rate: number | null, basis: number | null) {
  switch (type) {
    case 'fixed': return { price_minor: price, rate_minor: null, rate_basis_grams: null };
    case 'measured_weight': return { price_minor: null, rate_minor: rate, rate_basis_grams: basis };
    case 'variant': return { price_minor: null, rate_minor: null, rate_basis_grams: null };
  }
}

/** Who may mark a description verified, and when an edit resets it (D-S1.2). */
function nextDescVerified(requested: boolean | undefined, current: number, textChanged: boolean, canReview: boolean): 0 | 1 {
  if (canReview) {
    if (requested !== undefined) return requested ? 1 : 0;
    return textChanged ? 0 : (current as 0 | 1);
  }
  if (textChanged || requested === false) return 0;
  if (requested === true && current !== 1) {
    throw new AppError('forbidden', 'Only a reviewer can mark a description as verified.', { permission: 'menu.review' });
  }
  return current as 0 | 1;
}

export function addPriceHistory(itemId: string, variantId: string | null, price: number | null, rate: number | null, by: string, reason: string | null): void {
  insert('price_history', {
    item_id: itemId, variant_id: variantId, price_minor: price, rate_minor: rate,
    changed_at: nowIso(), changed_by: by, reason,
  });
}

// ------------------------------------------------------------------ child rows (variants, options)
interface ChildRow { id: string; key: string; archived_at: string | null; sort: number }

interface SyncResult<R> {
  changed: boolean;
  entries: Array<{ id: string; before: R | null; values: Record<string, unknown> }>;
  archived: R[];
}

/**
 * Replace a parent's child rows with `inputs` (match by id, then by key).
 * Rows not listed are archived, never deleted: orders and quotes keep
 * pointing at them. Keys are released in two phases so swaps and re-used
 * keys never trip the (parent, key) UNIQUE constraint.
 */
export function syncChildren<R extends ChildRow, I extends { id?: string | null; key: string }>(spec: {
  table: 'item_variants' | 'modifier_options';
  parentCol: 'item_id' | 'group_id';
  parentId: string;
  idPrefix: string;
  path: string;
  inputs: I[];
  values: (input: I, index: number) => Record<string, unknown>;
}): SyncResult<R> {
  const { table, parentCol, parentId, inputs } = spec;
  const existing = many<R>(`SELECT * FROM ${table} WHERE ${parentCol} = ?`, [parentId]);
  const now = nowIso();

  // 0. match inputs to rows: explicit ids first, then keys among unclaimed rows
  const keys = inputs.map((inp, i) => {
    const key = inp.key.trim();
    if (!key) invalid(`${spec.path}.${i}.key`, 'A key is required.');
    return key;
  });
  keys.forEach((k, i) => { if (keys.indexOf(k) !== i) invalid(`${spec.path}.${i}.key`, `The key "${k}" is used twice.`); });
  const claimed = new Map<number, R>();
  const claimedIds = new Set<string>();
  inputs.forEach((inp, i) => {
    if (!inp.id) return;
    const row = existing.find((e) => e.id === inp.id);
    if (!row) invalid(`${spec.path}.${i}.id`, 'This option does not belong here.');
    if (claimedIds.has(row.id)) invalid(`${spec.path}.${i}.id`, 'The same option is listed twice.');
    claimed.set(i, row);
    claimedIds.add(row.id);
  });
  inputs.forEach((inp, i) => {
    if (inp.id) return;
    const row = existing.find((e) => e.key === keys[i] && !claimedIds.has(e.id));
    if (row) { claimed.set(i, row); claimedIds.add(row.id); }
  });

  let changed = false;
  // 1. archive unlisted rows and move every key out of the way
  const archived: R[] = [];
  for (const row of existing) {
    if (claimedIds.has(row.id)) {
      run(`UPDATE ${table} SET key = :key WHERE id = :id`, { id: row.id, key: `~tmp~${row.id}` });
      continue;
    }
    if (row.archived_at === null) {
      archived.push(row);
      changed = true;
    }
    const releaseKey = keys.includes(row.key) ? `${row.key}~${row.id}` : row.key;
    run(`UPDATE ${table} SET archived_at = COALESCE(archived_at, :now), key = :key WHERE id = :id`, { id: row.id, now, key: releaseKey });
  }

  // 2. write the listed rows in order
  const entries: SyncResult<R>['entries'] = [];
  inputs.forEach((inp, i) => {
    const values: Record<string, unknown> = { ...spec.values(inp, i), sort: (i + 1) * 10 };
    const row = claimed.get(i);
    if (row) {
      const cols = Object.keys(values);
      const differs = row.key !== keys[i] || row.archived_at !== null
        || cols.some((c) => (row as unknown as Record<string, unknown>)[c] !== values[c]);
      if (differs) changed = true;
      run(
        `UPDATE ${table} SET key = :key, archived_at = NULL, ${cols.map((c) => `${c} = :v_${c}`).join(', ')} WHERE id = :id`,
        { id: row.id, key: keys[i], ...Object.fromEntries(cols.map((c) => [`v_${c}`, values[c]])) },
      );
      entries.push({ id: row.id, before: row, values });
    } else {
      const id = newId(spec.idPrefix);
      insert(table, { id, [parentCol]: parentId, key: keys[i], ...values });
      entries.push({ id, before: null, values });
      changed = true;
    }
  });
  return { changed, entries, archived };
}

export function syncVariants(itemId: string, inputs: VariantInput[], by: string, reason: string | null): { changed: boolean; priceChanged: boolean } {
  const result = syncChildren<VariantRow, VariantInput>({
    table: 'item_variants', parentCol: 'item_id', parentId: itemId, idPrefix: 'var', path: 'variants', inputs,
    values: (v) => ({
      name_th: clean(v.name_th) ?? null,
      name_en: clean(v.name_en) ?? null,
      price_minor: v.price_minor ?? null,
      available: v.available ? 1 : 0,
    }),
  });
  let priceChanged = false;
  for (const e of result.entries) {
    const price = e.values.price_minor as number | null;
    const wasLive = e.before !== null && e.before.archived_at === null;
    if (!wasLive || e.before!.price_minor !== price) {
      if (price !== null || wasLive) addPriceHistory(itemId, e.id, price, null, by, reason);
      priceChanged = true;
    }
  }
  if (result.archived.some((v) => v.price_minor !== null)) priceChanged = true;
  return { changed: result.changed, priceChanged };
}

function setItemGroups(itemId: string, groupIds: string[]): boolean {
  groupIds.forEach((gid, i) => {
    if (groupIds.indexOf(gid) !== i) invalid(`modifier_group_ids.${i}`, 'A choice group is listed twice.');
    const g = one<{ archived_at: string | null }>('SELECT archived_at FROM modifier_groups WHERE id = ?', [gid]);
    if (!g || g.archived_at) invalid(`modifier_group_ids.${i}`, 'Unknown choice group.');
  });
  const current = many<{ group_id: string }>('SELECT group_id FROM item_modifier_groups WHERE item_id = ? ORDER BY sort, group_id', [itemId]).map((r) => r.group_id);
  if (current.length === groupIds.length && current.every((g, i) => g === groupIds[i])) return false;
  run('DELETE FROM item_modifier_groups WHERE item_id = ?', [itemId]);
  groupIds.forEach((gid, i) => insert('item_modifier_groups', { item_id: itemId, group_id: gid, sort: (i + 1) * 10 }));
  return true;
}

// ------------------------------------------------------------------ items
/** New items always start as unverified drafts. */
export function createItem(input: CreateItemInput, staff: StaffContext): AdminItemDTO {
  const cat = getCategory(input.category_id) ?? invalid('category_id', 'Unknown category.');
  const canReview = staff.can('menu.review');
  if (input.pricing_type !== 'variant' && input.variants?.length) invalid('variants', 'Only variant-priced items have variants.');
  const now = nowIso();
  const id = newId('itm');
  const nameTh = clean(input.name_th) ?? null;
  const nameEn = clean(input.name_en) ?? null;
  const descTh = clean(input.desc_th) ?? null;
  const descEn = clean(input.desc_en) ?? null;
  const pricing = normalizePricing(input.pricing_type, input.price_minor ?? null, input.rate_minor ?? null, input.rate_basis_grams ?? null);
  insert('menu_items', {
    id,
    key: uniqueKey('menu_items', slugify(nameEn)),
    category_id: cat.id,
    sort: nextItemSort(cat.id),
    name_th: nameTh,
    name_en: nameEn,
    name_th_source: nameTh ? 'staff_edit' : null,
    translation_status: canReview ? 'verified' : 'needs_review',
    desc_th: descTh,
    desc_en: descEn,
    desc_verified: nextDescVerified(input.desc_verified, 0, false, canReview) && (descTh || descEn) ? 1 : 0,
    portion_note_th: clean(input.portion_note_th) ?? null,
    portion_note_en: clean(input.portion_note_en) ?? null,
    pricing_type: input.pricing_type,
    ...pricing,
    status: 'draft',
    review_status: 'unverified',
    demo_orderable: 0,
    notes_allowed: flag(input.notes_allowed) ?? 1,
    note_max: input.note_max ?? getSettings().menu.note_max_length,
    max_qty: input.max_qty ?? 20,
    station: input.station ?? cat.station,
    alcohol: flag(input.alcohol) ?? 0,
    requires_staff_confirm: flag(input.requires_staff_confirm) ?? 0,
    image: clean(input.image) ?? null,
    image_alt_th: clean(input.image_alt_th) ?? null,
    image_alt_en: clean(input.image_alt_en) ?? null,
    source_ref: 'admin',
    review_notes: clean(input.review_notes) ?? null,
    created_at: now,
    updated_at: now,
    updated_by: staff.user.id,
    version: 1,
  });
  const reason = clean(input.price_change_reason) ?? 'created';
  if (pricing.price_minor !== null || pricing.rate_minor !== null) addPriceHistory(id, null, pricing.price_minor, pricing.rate_minor, staff.user.id, reason);
  if (input.pricing_type === 'variant' && input.variants?.length) syncVariants(id, input.variants, staff.user.id, reason);
  if (input.modifier_group_ids?.length) setItemGroups(id, input.modifier_group_ids);
  audit(staff.actor, 'menu.item_created', { type: 'menu_item', id }, {
    after: { category_id: cat.id, name_th: nameTh, name_en: nameEn, pricing_type: input.pricing_type, ...pricing },
  });
  emitMenu({ type: 'menu_item', id, version: 1 }, { action: 'item_created' });
  return adminItemDTO(id);
}

const SIMPLE_FIELDS = ['portion_note_th', 'portion_note_en', 'image', 'image_alt_th', 'image_alt_en', 'review_notes'] as const;

export function updateItem(id: string, input: UpdateItemInput, staff: StaffContext): AdminItemDTO {
  const item = mustItem(id);
  if (item.version !== input.version) staleVersion(adminItemDTO(id));
  return trackOrderability([id], 'orderability', staff.actor, () => {
    const canReview = staff.can('menu.review');
    const current = item as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const set = (col: string, value: unknown) => {
      if (value !== undefined && value !== current[col]) patch[col] = value;
    };

    if (input.category_id !== undefined && input.category_id !== item.category_id) {
      const cat = getCategory(input.category_id) ?? invalid('category_id', 'Unknown category.');
      patch.category_id = cat.id;
      patch.sort = nextItemSort(cat.id);
    }

    // names and descriptions
    set('name_th', clean(input.name_th));
    set('name_en', clean(input.name_en));
    if ('name_th' in patch) patch.name_th_source = patch.name_th ? 'staff_edit' : null;
    if ('name_th' in patch || 'name_en' in patch) patch.translation_status = canReview ? 'verified' : 'needs_review';
    set('desc_th', clean(input.desc_th));
    set('desc_en', clean(input.desc_en));
    const descChanged = 'desc_th' in patch || 'desc_en' in patch;
    set('desc_verified', nextDescVerified(input.desc_verified, item.desc_verified, descChanged, canReview));
    for (const f of SIMPLE_FIELDS) set(f, clean(input[f]));

    // pricing
    const type = input.pricing_type ?? item.pricing_type;
    const pricing = normalizePricing(
      type,
      input.price_minor !== undefined ? input.price_minor : item.price_minor,
      input.rate_minor !== undefined ? input.rate_minor : item.rate_minor,
      input.rate_basis_grams !== undefined ? input.rate_basis_grams : item.rate_basis_grams,
    );
    set('pricing_type', type);
    set('price_minor', pricing.price_minor);
    set('rate_minor', pricing.rate_minor);
    set('rate_basis_grams', pricing.rate_basis_grams);
    const itemPriceChanged = ['pricing_type', 'price_minor', 'rate_minor', 'rate_basis_grams'].some((k) => k in patch);

    // service settings
    set('notes_allowed', flag(input.notes_allowed));
    set('note_max', input.note_max);
    set('max_qty', input.max_qty);
    set('station', input.station);
    set('alcohol', flag(input.alcohol));
    set('requires_staff_confirm', flag(input.requires_staff_confirm));

    // variants and choice groups
    const reason = clean(input.price_change_reason) ?? null;
    let variants = { changed: false, priceChanged: false };
    if (type !== 'variant' && input.variants?.length) invalid('variants', 'Only variant-priced items have variants.');
    if (type === 'variant' && input.variants !== undefined) {
      variants = syncVariants(id, input.variants, staff.user.id, reason);
    } else if (type !== 'variant' && item.pricing_type === 'variant') {
      // Leaving variant pricing retires the old variant prices rather than keeping hidden ones around.
      variants.changed = run('UPDATE item_variants SET archived_at = :now WHERE item_id = :id AND archived_at IS NULL', { id, now: nowIso() }).changes > 0;
    }
    const groupsChanged = input.modifier_group_ids !== undefined && setItemGroups(id, input.modifier_group_ids);

    const priceChanged = itemPriceChanged || variants.priceChanged;
    if (priceChanged) {
      if (item.status === 'published' && !reason) {
        invalid('price_change_reason', 'Give a reason for changing the price of a published item.');
      }
      if (itemPriceChanged && (pricing.price_minor !== null || pricing.rate_minor !== null || item.price_minor !== null || item.rate_minor !== null)) {
        addPriceHistory(id, null, pricing.price_minor, pricing.rate_minor, staff.user.id, reason);
      }
      patch.review_status = 'needs_review';
    }

    const changedKeys = Object.keys(patch);
    if (changedKeys.length === 0 && !variants.changed && !groupsChanged) return adminItemDTO(id);
    const now = nowIso();
    if (!updateVersioned('menu_items', id, item.version, { ...patch, updated_at: now, updated_by: staff.user.id })) {
      staleVersion(adminItemDTO(id));
    }
    audit(staff.actor, 'menu.item_updated', { type: 'menu_item', id }, {
      reason,
      before: { ...pick(current, changedKeys) },
      after: { ...pick(patch, changedKeys), variants_changed: variants.changed, groups_changed: groupsChanged },
    });
    emitMenu({ type: 'menu_item', id, version: item.version + 1 }, { action: 'item_updated', price_changed: priceChanged });
    return adminItemDTO(id);
  });
}

/** The service-friendly Sold out toggle. Setting the state it already has is a no-op. */
export function setAvailability(id: string, input: z.infer<typeof AvailabilityBody>, staff: StaffContext): AdminItemDTO {
  const item = mustItem(id);
  if (input.version !== undefined && input.version !== item.version) staleVersion(adminItemDTO(id));
  const target = input.sold_out ? 1 : 0;
  if (item.sold_out === target) return adminItemDTO(id);
  return trackOrderability([id], input.sold_out ? 'sold_out' : 'restocked', staff.actor, () => {
    const now = nowIso();
    updateVersioned('menu_items', id, item.version, {
      sold_out: target,
      sold_out_since: target ? now : null,
      published_version: syncedPublishedVersion(item),
      updated_at: now,
      updated_by: staff.user.id,
    }) || staleVersion(adminItemDTO(id));
    audit(staff.actor, input.sold_out ? 'menu.item_sold_out' : 'menu.item_restocked', { type: 'menu_item', id }, {
      before: { sold_out: item.sold_out === 1 }, after: { sold_out: input.sold_out },
    });
    emitMenu({ type: 'menu_item', id, version: item.version + 1 }, { action: 'availability', sold_out: input.sold_out });
    return adminItemDTO(id);
  });
}

/** Publish / unpublish / archive. Publishing enforces publish blockers; re-publishing clears "unpublished changes". */
export function setItemStatus(id: string, input: z.infer<typeof ItemStatusBody>, staff: StaffContext): AdminItemDTO {
  const item = mustItem(id);
  if (item.version !== input.version) staleVersion(adminItemDTO(id));
  if (input.status === 'published') {
    const blockers = publishBlockersFor(id);
    if (blockers.length) {
      throw new AppError('publish_blocked', 'This item cannot be published yet.', { blockers, current: adminItemDTO(id) });
    }
    if (item.status === 'published' && item.published_version === item.version) return adminItemDTO(id);
  } else if (item.status === input.status) {
    return adminItemDTO(id);
  }
  const reason = input.status === 'published' ? 'published' : input.status === 'archived' ? 'archived' : 'orderability';
  return trackOrderability([id], reason, staff.actor, () => {
    updateVersioned('menu_items', id, item.version, {
      status: input.status,
      published_version: input.status === 'published' ? item.version + 1 : syncedPublishedVersion(item),
      updated_at: nowIso(),
      updated_by: staff.user.id,
    }) || staleVersion(adminItemDTO(id));
    const action = input.status === 'published'
      ? (item.status === 'published' ? 'menu.item_republished' : 'menu.item_published')
      : input.status === 'archived' ? 'menu.item_archived' : 'menu.item_unpublished';
    audit(staff.actor, action, { type: 'menu_item', id }, {
      before: { status: item.status, version: item.version, published_version: item.published_version },
      after: { status: input.status },
    });
    emitMenu({ type: 'menu_item', id, version: item.version + 1 }, { action: 'status', status: input.status });
    return adminItemDTO(id);
  });
}

/** Owner review: review status, notes and the verified allergen record. */
export function reviewItem(id: string, input: z.infer<typeof ReviewBody>, staff: StaffContext): AdminItemDTO {
  const item = mustItem(id);
  if (item.version !== input.version) staleVersion(adminItemDTO(id));
  return trackOrderability([id], 'orderability', staff.actor, () => {
    const now = nowIso();
    const verified = input.review_status === 'verified';
    const patch: Record<string, unknown> = {
      review_status: input.review_status,
      reviewer: staff.user.display_name,
      approved_at: verified ? now : null,
      published_version: syncedPublishedVersion(item),
      updated_at: now,
      updated_by: staff.user.id,
    };
    if (verified && item.name_th) patch.translation_status = 'verified';
    if (input.notes !== undefined) patch.review_notes = clean(input.notes);
    if (input.allergens) {
      const seen = new Set<string>();
      input.allergens.entries.forEach((e, i) => {
        const k = e.allergen.trim().toLowerCase();
        if (!k) invalid(`allergens.entries.${i}.allergen`, 'Name the allergen.');
        if (seen.has(k)) invalid(`allergens.entries.${i}.allergen`, 'This allergen is listed twice.');
        seen.add(k);
      });
      run('DELETE FROM item_allergens WHERE item_id = ?', [id]);
      for (const e of input.allergens.entries) {
        insert('item_allergens', { item_id: id, allergen: e.allergen.trim(), state: e.state, note: clean(e.note) ?? null });
      }
      const allergensVerified = input.allergens.status === 'verified';
      patch.allergen_status = input.allergens.status;
      patch.allergen_verified_by = allergensVerified ? staff.user.display_name : null;
      patch.allergen_verified_at = allergensVerified ? now : null;
    }
    updateVersioned('menu_items', id, item.version, patch) || staleVersion(adminItemDTO(id));
    audit(staff.actor, 'menu.item_reviewed', { type: 'menu_item', id }, {
      before: { review_status: item.review_status, allergen_status: item.allergen_status },
      after: {
        review_status: input.review_status,
        allergen_status: input.allergens?.status ?? item.allergen_status,
        allergens: input.allergens?.entries.map((e) => ({ allergen: e.allergen, state: e.state })),
        notes: input.notes === undefined ? undefined : '[set]',
      },
    });
    emitMenu({ type: 'menu_item', id, version: item.version + 1 }, { action: 'review', review_status: input.review_status });
    return adminItemDTO(id);
  });
}

export function resolveFlag(flagId: string, input: z.infer<typeof ResolveFlagBody>, staff: StaffContext): AdminItemDTO | AdminCatalogDTO {
  const row = one<{ id: string; item_id: string | null; category_id: string | null; code: string; resolved_at: string | null }>(
    'SELECT id, item_id, category_id, code, resolved_at FROM item_flags WHERE id = ?', [flagId]) ?? notFound('Review flag');
  if (!row.resolved_at) {
    run('UPDATE item_flags SET resolved_at = :now, resolved_by = :by, resolution = :resolution WHERE id = :id AND resolved_at IS NULL', {
      id: flagId, now: nowIso(), by: staff.user.id, resolution: input.resolution,
    });
    const entity = row.item_id ? { type: 'menu_item', id: row.item_id } : { type: 'menu_category', id: row.category_id ?? flagId };
    audit(staff.actor, 'menu.flag_resolved', entity, { reason: input.resolution, after: { flag_id: flagId, code: row.code } });
    emitMenu(entity, { action: 'flag_resolved', flag_id: flagId });
  }
  // Category-level flags have no item to return; the editor gets the whole catalog instead.
  return row.item_id ? adminItemDTO(row.item_id) : adminCatalog();
}

// ------------------------------------------------------------------ categories
const DEFAULT_GROUPS = {
  food: { name_th: 'อาหาร', name_en: 'Food', sort: 10 },
  drinks: { name_th: 'เครื่องดื่ม', name_en: 'Drinks', sort: 20 },
} as const;

function ensureGroup(key: 'food' | 'drinks'): string {
  const row = one<{ id: string }>('SELECT id FROM menu_groups WHERE key = ?', [key]);
  if (row) return row.id;
  const id = newId('grp');
  insert('menu_groups', { id, key, ...DEFAULT_GROUPS[key] });
  return id;
}

function checkDates(from: string | null, until: string | null): void {
  for (const [path, d] of [['active_from', from], ['active_until', until]] as const) {
    if (d && Number.isNaN(Date.parse(`${d}T00:00:00Z`))) invalid(path, 'Not a real date.');
  }
  if (from && until && from > until) invalid('active_until', 'The end date is before the start date.');
}

function nextCategorySort(groupId: string): number {
  return (one<{ s: number | null }>('SELECT MAX(sort) AS s FROM menu_categories WHERE group_id = ?', [groupId])?.s ?? 0) + 10;
}

export function createCategory(input: CategoryInputT, staff: StaffContext): AdminCatalogDTO {
  if (input.ordering_paused) requirePerm(staff, 'ordering.pause');
  const groupId = ensureGroup(input.group);
  const from = input.active_from ?? null;
  const until = input.active_until ?? null;
  checkDates(from, until);
  const now = nowIso();
  const id = newId('cat');
  insert('menu_categories', {
    id,
    key: uniqueKey('menu_categories', slugify(input.name_en)),
    group_id: groupId,
    name_th: clean(input.name_th) ?? null,
    name_en: input.name_en.trim(),
    note_th: clean(input.note_th) ?? null,
    note_en: clean(input.note_en) ?? null,
    sort: nextCategorySort(groupId),
    status: input.status ?? 'draft',
    seasonal: flag(input.seasonal) ?? 0,
    active_from: from,
    active_until: until,
    station: input.station ?? 'kitchen',
    alcohol: flag(input.alcohol) ?? 0,
    ordering_paused: flag(input.ordering_paused) ?? 0,
    created_at: now,
    updated_at: now,
    updated_by: staff.user.id,
    version: 1,
  });
  audit(staff.actor, 'menu.category_created', { type: 'menu_category', id }, { after: { group: input.group, name_en: input.name_en, status: input.status ?? 'draft' } });
  emitMenu({ type: 'menu_category', id, version: 1 }, { action: 'category_created' });
  return adminCatalog();
}

/**
 * Update a category. Pausing/resuming ordering needs `ordering.pause`; every
 * other field needs `menu.edit` (a pause-only request needs only the former).
 */
export function updateCategory(id: string, input: UpdateCategoryInput, staff: StaffContext): AdminCatalogDTO {
  const cat = getCategory(id) ?? notFound('Category');
  const provided = (Object.keys(input) as Array<keyof UpdateCategoryInput>).filter((k) => k !== 'version' && input[k] !== undefined);
  const pauseOnly = provided.length > 0 && provided.every((k) => k === 'ordering_paused');
  if (!pauseOnly) requirePerm(staff, 'menu.edit');
  if (input.ordering_paused !== undefined && (input.ordering_paused ? 1 : 0) !== cat.ordering_paused) requirePerm(staff, 'ordering.pause');
  if (cat.version !== input.version) staleVersion(adminCatalog());

  const current = cat as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const set = (col: string, value: unknown) => {
    if (value !== undefined && value !== current[col]) patch[col] = value;
  };
  if (input.group !== undefined && input.group !== cat.group_key) {
    const groupId = ensureGroup(input.group);
    patch.group_id = groupId;
    patch.sort = nextCategorySort(groupId);
  }
  set('name_th', clean(input.name_th));
  if (input.name_en !== undefined) set('name_en', input.name_en.trim());
  set('note_th', clean(input.note_th));
  set('note_en', clean(input.note_en));
  set('status', input.status);
  set('seasonal', flag(input.seasonal));
  set('active_from', input.active_from);
  set('active_until', input.active_until);
  set('station', input.station);
  set('alcohol', flag(input.alcohol));
  set('ordering_paused', flag(input.ordering_paused));
  checkDates(
    (input.active_from !== undefined ? input.active_from : cat.active_from) ?? null,
    (input.active_until !== undefined ? input.active_until : cat.active_until) ?? null,
  );

  const changedKeys = Object.keys(patch);
  if (changedKeys.length === 0) return adminCatalog();
  const reason = 'ordering_paused' in patch ? 'category_paused'
    : patch.status === 'published' ? 'published'
    : patch.status === 'archived' ? 'archived'
    : ['seasonal', 'active_from', 'active_until'].some((k) => k in patch) ? 'seasonal'
    : 'orderability';
  const itemIds = many<{ id: string }>('SELECT id FROM menu_items WHERE category_id = ?', [id]).map((r) => r.id);
  return trackOrderability(itemIds, reason, staff.actor, () => {
    updateVersioned('menu_categories', id, cat.version, { ...patch, updated_at: nowIso(), updated_by: staff.user.id })
      || staleVersion(adminCatalog());
    const action = 'ordering_paused' in patch && changedKeys.length === 1
      ? (patch.ordering_paused ? 'menu.category_paused' : 'menu.category_resumed')
      : 'menu.category_updated';
    audit(staff.actor, action, { type: 'menu_category', id }, { before: pick(current, changedKeys), after: pick(patch, changedKeys) });
    emitMenu({ type: 'menu_category', id, version: cat.version + 1 }, { action: 'category_updated', ordering_paused: patch.ordering_paused === undefined ? undefined : patch.ordering_paused === 1 });
    return adminCatalog();
  });
}

/** Staff-configured display order; unlisted siblings keep their order after the listed ones. */
export function reorder(input: z.infer<typeof ReorderBody>, staff: StaffContext): AdminCatalogDTO {
  const isItem = input.entity === 'item';
  const table = isItem ? 'menu_items' : 'menu_categories';
  const parentCol = isItem ? 'category_id' : 'group_id';
  input.ids.forEach((rid, i) => { if (input.ids.indexOf(rid) !== i) invalid(`ids.${i}`, 'Listed twice.'); });
  const rows = input.ids.map((rid) => one<{ id: string; sort: number; parent: string }>(
    `SELECT id, sort, ${parentCol} AS parent FROM ${table} WHERE id = ?`, [rid]) ?? notFound(isItem ? 'Menu item' : 'Category'));
  const parent = rows[0].parent;
  if (rows.some((r) => r.parent !== parent)) {
    invalid('ids', isItem ? 'Reorder items within one category at a time.' : 'Reorder categories within one group at a time.');
  }
  const siblings = many<{ id: string; sort: number }>(`SELECT id, sort FROM ${table} WHERE ${parentCol} = ? ORDER BY sort, key`, [parent]);
  const listed = new Set(input.ids);
  const order = [...input.ids, ...siblings.filter((s) => !listed.has(s.id)).map((s) => s.id)];
  const oldSort = new Map(siblings.map((s) => [s.id, s.sort]));
  const now = nowIso();
  const moved: string[] = [];
  order.forEach((rid, i) => {
    const sort = (i + 1) * 10;
    if (oldSort.get(rid) === sort) return;
    // Placement is not a content change: no version bump, so open editors stay valid.
    run(`UPDATE ${table} SET sort = :sort, updated_at = :now WHERE id = :id`, { id: rid, sort, now });
    insert('menu_placement_log', {
      entity_type: input.entity, entity_id: rid, old_sort: oldSort.get(rid) ?? null, new_sort: sort,
      changed_at: now, changed_by: staff.user.id,
    });
    moved.push(rid);
  });
  if (moved.length) {
    const entity = { type: isItem ? 'menu_category' : 'menu_group', id: parent };
    audit(staff.actor, 'menu.reordered', entity, { after: { entity: input.entity, order } });
    emitMenu(entity, { action: 'reordered', entity: input.entity });
  }
  return adminCatalog();
}

// ------------------------------------------------------------------ modifier groups
function checkGroupInput(input: ModifierGroupInputT): void {
  if (input.min_select > input.options.length) invalid('min_select', 'More required choices than there are options.');
  if (input.included_count > input.max_select) invalid('included_count', 'More included choices than can be picked.');
  const defaults = input.options.filter((o) => o.is_default);
  if (defaults.length > input.max_select) invalid('options', 'More default options than can be picked.');
  defaults.forEach((o) => { if (!o.available) invalid('options', `The default option "${o.name_en}" is not available.`); });
}

function syncOptions(groupId: string, inputs: OptionInput[]): SyncResult<OptionRow & ChildRow> {
  return syncChildren<OptionRow & ChildRow, OptionInput>({
    table: 'modifier_options', parentCol: 'group_id', parentId: groupId, idPrefix: 'opt', path: 'options', inputs,
    values: (o) => ({
      name_th: clean(o.name_th) ?? null,
      name_en: o.name_en.trim(),
      price_delta_minor: o.price_delta_minor,
      upgrade_minor: o.upgrade_minor,
      is_default: o.is_default ? 1 : 0,
      available: o.available ? 1 : 0,
    }),
  });
}

function keyTaken(key: string, exceptId: string | null): boolean {
  return Boolean(one('SELECT 1 AS x FROM modifier_groups WHERE key = ? AND id IS NOT ?', [key, exceptId]));
}

export function createModifierGroup(input: ModifierGroupInputT, staff: StaffContext): AdminCatalogDTO {
  checkGroupInput(input);
  if (keyTaken(input.key, null)) invalid('key', 'This key is already used by another choice group.');
  const now = nowIso();
  const id = newId('mgp');
  insert('modifier_groups', {
    id, key: input.key, name_th: clean(input.name_th) ?? null, name_en: input.name_en.trim(),
    min_select: input.min_select, max_select: input.max_select, included_count: input.included_count,
    created_at: now, updated_at: now, version: 1,
  });
  syncOptions(id, input.options);
  audit(staff.actor, 'menu.modifier_group_created', { type: 'modifier_group', id }, {
    after: { key: input.key, min_select: input.min_select, max_select: input.max_select, included_count: input.included_count, options: input.options.length },
  });
  emitMenu({ type: 'modifier_group', id, version: 1 }, { action: 'modifier_group_created' });
  return adminCatalog();
}

/**
 * Replace a reusable choice group. Every item using it changes too: the
 * affected item ids are recorded in the audit and returned in the group's
 * `item_ids` so the editor can show what the change touched.
 */
export function updateModifierGroup(id: string, input: ModifierGroupInputT & { version: number }, staff: StaffContext): AdminCatalogDTO {
  const group = one<GroupRow>('SELECT * FROM modifier_groups WHERE id = ? AND archived_at IS NULL', [id]) ?? notFound('Choice group');
  if (group.version !== input.version) staleVersion(adminCatalog());
  checkGroupInput(input);
  if (input.key !== group.key && keyTaken(input.key, id)) invalid('key', 'This key is already used by another choice group.');
  const affected = many<{ item_id: string }>('SELECT item_id FROM item_modifier_groups WHERE group_id = ? ORDER BY item_id', [id]).map((r) => r.item_id);
  return trackOrderability(affected, 'orderability', staff.actor, () => {
    const beforeOptions = many<OptionRow>('SELECT * FROM modifier_options WHERE group_id = ? AND archived_at IS NULL ORDER BY sort, key', [id]);
    const options = syncOptions(id, input.options);
    const fields = {
      key: input.key, name_th: clean(input.name_th) ?? null, name_en: input.name_en.trim(),
      min_select: input.min_select, max_select: input.max_select, included_count: input.included_count,
    };
    const current = group as unknown as Record<string, unknown>;
    const changedKeys = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== current[k]);
    if (changedKeys.length === 0 && !options.changed) return adminCatalog();
    updateVersioned('modifier_groups', id, group.version, { ...fields, updated_at: nowIso() }) || staleVersion(adminCatalog());
    audit(staff.actor, 'menu.modifier_group_updated', { type: 'modifier_group', id }, {
      before: {
        ...pick(current, changedKeys),
        options: beforeOptions.map((o) => ({ key: o.key, price_delta_minor: o.price_delta_minor, upgrade_minor: o.upgrade_minor, available: o.available === 1 })),
      },
      after: {
        ...pick(fields, changedKeys),
        options: input.options.map((o) => ({ key: o.key, price_delta_minor: o.price_delta_minor, upgrade_minor: o.upgrade_minor, available: o.available })),
        affected_item_ids: affected,
      },
    });
    emitMenu({ type: 'modifier_group', id, version: group.version + 1 }, { action: 'modifier_group_updated', affected_items: affected.length });
    return adminCatalog();
  });
}

// ------------------------------------------------------------------ ordering state
export function staffOrderingState(): StaffOrderingDTO {
  const limit = getSettings().ordering.intake_limit;
  const backlog = unacceptedRounds();
  const oldest = one<{ at: string | null }>(
    `SELECT MIN(o.submitted_at) AS at FROM orders o
       JOIN order_lines l ON l.order_id = o.id JOIN visits v ON v.id = o.visit_id
      WHERE l.status = 'submitted' AND v.status <> 'closed'`)?.at ?? null;
  return {
    ...publicOrderingState(),
    intake_limit: limit,
    backlog,
    oldest_unaccepted_at: oldest,
    intake_full: limit !== null && backlog >= limit,
  };
}

/**
 * Restaurant-wide pause, guest message, honest estimated wait and intake
 * limit. Existing orders are untouched; submission re-checks on the server.
 */
export function updateOrderingState(input: z.infer<typeof OrderingStateBody>, staff: StaffContext): StaffOrderingDTO {
  const current = getSettings().ordering;
  const next = { ...current };
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.paused_message_th !== undefined) next.paused_message_th = input.paused_message_th.trim();
  if (input.paused_message_en !== undefined) next.paused_message_en = input.paused_message_en.trim();
  if (input.estimated_wait_minutes !== undefined) next.estimated_wait_minutes = input.estimated_wait_minutes;
  if (input.intake_limit !== undefined) next.intake_limit = input.intake_limit;
  if (!next.enabled && !next.paused_message_th) invalid('paused_message_th', 'Guests need a message while ordering is paused.');
  if (!next.enabled && !next.paused_message_en) invalid('paused_message_en', 'Guests need a message while ordering is paused.');

  const keys = (['enabled', 'paused_message_th', 'paused_message_en', 'estimated_wait_minutes', 'intake_limit'] as const)
    .filter((k) => next[k] !== current[k]);
  if (keys.length === 0) return staffOrderingState();
  putSetting('ordering', next, staff.user.id);
  const action = keys.includes('enabled') ? (next.enabled ? 'ordering.resumed' : 'ordering.paused') : 'ordering.updated';
  audit(staff.actor, action, { type: 'settings', id: 'ordering' }, {
    reason: clean(input.reason) ?? null,
    before: Object.fromEntries(keys.map((k) => [k, current[k]])),
    after: Object.fromEntries(keys.map((k) => [k, next[k]])),
  });
  emit('ordering.updated', {
    audience: 'all',
    entity: { type: 'settings', id: 'ordering' },
    payload: { enabled: next.enabled, estimated_wait_minutes: next.estimated_wait_minutes, changed: keys },
  });
  return staffOrderingState();
}
