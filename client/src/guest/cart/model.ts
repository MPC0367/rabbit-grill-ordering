// Draft-line model shared by the cart store, the item sheet and submission
// (stream C1b). Pure functions only: no React, no storage, no network.
//
// Pricing mirrors shared/money.ts exactly (variant price replaces the base
// price; included picks pay only their upgrade premium). The server re-prices
// every line on /quote and /orders; these numbers are what the guest SAW and
// are sent back as expected_unit_minor so a change surfaces as price_changed.
import type { Bilingual, MenuItemDTO, ModifierGroupDTO, QuoteLineDTO } from '../../../../shared/dto.ts';
import { allocateGroupPicks, priceGroupPicks, type ModifierPick } from '../../../../shared/money.ts';
import type { CartLineInput } from '../../../../shared/schemas.ts';

export type { ModifierPick } from '../../../../shared/money.ts';

export type DishImageInfo = MenuItemDTO['image'];

/** One private draft line on this device. */
export interface CartLine {
  uid: string;
  item_id: string;
  variant_id: string | null;
  quantity: number;
  /** Only groups with at least one pick; option ids in listing order. */
  modifiers: ModifierPick[];
  note: string | null;
  allergy_note: boolean;
  /** Per-unit price (item or variant + charged choices) the guest saw. null = not known yet (filled by the first quote). */
  expected_unit_minor: number | null;
  /** Display snapshots, used only while the live catalog or quote is not available. */
  name: Bilingual;
  variant_name: Bilingual | null;
  option_names: Array<{ group: Bilingual; options: Bilingual[] }>;
  image: DishImageInfo;
  category_id: string | null;
  max_qty: number;
  added_at: string;
  updated_at: string;
}

/** What callers pass to add(). Only item_id is required. */
export interface NewCartLine {
  item_id: string;
  variant_id?: string | null;
  /** Default 1. */
  quantity?: number;
  modifiers?: ModifierPick[];
  note?: string | null;
  allergy_note?: boolean;
  expected_unit_minor?: number | null;
  /** Snapshot source: name, image, category, limits and the expected price are taken from it when given. */
  item?: MenuItemDTO;
  name?: Bilingual;
  variant_name?: Bilingual | null;
  option_names?: Array<{ group: Bilingual; options: Bilingual[] }>;
  image?: DishImageInfo;
  category_id?: string | null;
  max_qty?: number;
  /** Added straight from a menu row without opening the dish (tracker quick_add). */
  quick_add?: boolean;
}

export const EMPTY_NAME: Bilingual = { th: null, en: null };
export const MAX_QTY_FALLBACK = 99;

/** Normalised note: trimmed, empty -> null. The text itself is never altered. */
export function cleanNote(note: string | null | undefined): string | null {
  const v = note?.trim();
  return v ? v : null;
}

/** Picks without empty groups, option ids in the item's listing order, groups in the item's order. */
export function normalizePicks(picks: ReadonlyArray<ModifierPick> | undefined, item?: MenuItemDTO): ModifierPick[] {
  const list = (picks ?? []).filter((p) => p.option_ids.length > 0);
  if (!item) {
    return list
      .map((p) => ({ group_id: p.group_id, option_ids: [...new Set(p.option_ids)] }))
      .sort((a, b) => a.group_id.localeCompare(b.group_id));
  }
  const out: ModifierPick[] = [];
  for (const g of item.modifier_groups) {
    const p = list.find((x) => x.group_id === g.id);
    if (!p) continue;
    const ids = g.options.map((o) => o.id).filter((id) => p.option_ids.includes(id));
    if (ids.length) out.push({ group_id: g.id, option_ids: ids });
  }
  return out;
}

/** Identity for merging: item, variant, choices, note and the allergy tick must all match. */
export function mergeKey(l: Pick<CartLine, 'item_id' | 'variant_id' | 'modifiers' | 'note' | 'allergy_note'>): string {
  const mods = [...l.modifiers]
    .map((m) => `${m.group_id}:${[...m.option_ids].sort().join(',')}`)
    .sort()
    .join(';');
  return JSON.stringify([l.item_id, l.variant_id ?? '', mods, cleanNote(l.note) ?? '', l.allergy_note ? 1 : 0]);
}

/** Identity for "this quote result still describes this line". */
export function quoteSig(l: CartLine): string {
  return `${mergeKey(l)}|${l.quantity}|${l.expected_unit_minor ?? ''}`;
}

/** The API shape of a draft line (shared/schemas CartLineInput). */
export function toInput(l: CartLine): CartLineInput {
  return {
    item_id: l.item_id,
    variant_id: l.variant_id ?? null,
    quantity: l.quantity,
    modifiers: l.modifiers.map((m) => ({ group_id: m.group_id, option_ids: [...m.option_ids] })),
    note: cleanNote(l.note),
    allergy_note: l.allergy_note && Boolean(cleanNote(l.note)),
    expected_unit_minor: l.expected_unit_minor ?? null,
  };
}

// ------------------------------------------------------------------ pricing (client mirror)
/** Base price for the chosen variant (or the fixed price). null when not orderable at a price. */
export function basePrice(item: MenuItemDTO, variantId: string | null): number | null {
  if (item.pricing_type === 'fixed') return item.price_minor;
  if (item.pricing_type === 'variant') {
    const v = item.variants.find((x) => x.id === variantId);
    return v && v.available ? v.price_minor : null;
  }
  return null; // measured weight: staff quote only
}

export function groupCharge(group: ModifierGroupDTO, ids: string[]): number {
  return priceGroupPicks(group.options, ids, group.included_count);
}

export function choicesCharge(item: MenuItemDTO, picks: ReadonlyArray<ModifierPick>): number {
  return item.modifier_groups.reduce((sum, g) => sum + groupCharge(g, picks.find((p) => p.group_id === g.id)?.option_ids ?? []), 0);
}

/** Per-unit price the guest sees for this selection. */
export function unitPrice(item: MenuItemDTO, variantId: string | null, picks: ReadonlyArray<ModifierPick>): number | null {
  const base = basePrice(item, variantId);
  return base === null ? null : base + choicesCharge(item, picks);
}

/**
 * The price effect to print beside one option, given the current picks:
 * what this option costs if it is (or were) chosen now.
 */
export function optionEffect(group: ModifierGroupDTO, optionId: string, pickedIds: string[]): number {
  const chosen = pickedIds.includes(optionId);
  const ids = chosen ? pickedIds : group.max_select === 1 ? [optionId] : [...pickedIds, optionId];
  return allocateGroupPicks(group.options, ids, group.included_count).find((a) => a.id === optionId)?.charged_minor ?? 0;
}

/** Default picks for a new line: the options the restaurant marked as default (never invented). */
export function defaultPicks(item: MenuItemDTO): ModifierPick[] {
  return item.modifier_groups
    .map((g) => ({ group_id: g.id, option_ids: g.options.filter((o) => o.is_default && o.available).slice(0, g.max_select).map((o) => o.id) }))
    .filter((p) => p.option_ids.length > 0);
}

/** First available variant only when it is the single available one (never a guess between several). */
export function defaultVariant(item: MenuItemDTO): string | null {
  if (item.pricing_type !== 'variant') return null;
  const open = item.variants.filter((v) => v.available && v.price_minor !== null);
  return open.length === 1 ? open[0].id : null;
}

export function optionNames(item: MenuItemDTO, picks: ReadonlyArray<ModifierPick>): CartLine['option_names'] {
  return item.modifier_groups
    .map((g) => ({
      group: g.name,
      options: g.options.filter((o) => picks.find((p) => p.group_id === g.id)?.option_ids.includes(o.id)).map((o) => o.name),
    }))
    .filter((g) => g.options.length > 0);
}

/** A ready NewCartLine for a quick add from the menu row (fixed price, no required choices). */
export function quickAddLine(item: MenuItemDTO, quantity = 1): NewCartLine {
  return { item_id: item.id, item, quantity, modifiers: defaultPicks(item), variant_id: defaultVariant(item), quick_add: true };
}

/** Display parts for a line: quote (authoritative) > live catalog > snapshot. */
export interface LineDisplay {
  name: Bilingual;
  variant: Bilingual | null;
  options: Array<{ group: Bilingual; name: Bilingual; price_minor: number | null }>;
}

export function lineDisplay(line: CartLine, item: MenuItemDTO | undefined, quoted: QuoteLineDTO | null): LineDisplay {
  const name = quoted && (quoted.name.th || quoted.name.en) ? quoted.name : item?.name ?? line.name;
  if (quoted && quoted.ok) {
    return {
      name,
      variant: quoted.variant_name,
      options: quoted.modifiers.flatMap((g) => g.options.map((o) => ({ group: g.group, name: o.name, price_minor: o.price_minor }))),
    };
  }
  if (item) {
    const variant = item.variants.find((v) => v.id === line.variant_id)?.name ?? line.variant_name;
    const options: LineDisplay['options'] = [];
    for (const g of item.modifier_groups) {
      const ids = line.modifiers.find((m) => m.group_id === g.id)?.option_ids ?? [];
      const alloc = allocateGroupPicks(g.options, ids, g.included_count);
      for (const o of g.options) {
        if (ids.includes(o.id)) options.push({ group: g.name, name: o.name, price_minor: alloc.find((a) => a.id === o.id)?.charged_minor ?? null });
      }
    }
    return { name, variant: variant ?? null, options };
  }
  return {
    name,
    variant: line.variant_name,
    options: line.option_names.flatMap((g) => g.options.map((o) => ({ group: g.group, name: o, price_minor: null }))),
  };
}

export function newUid(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return `ln_${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14)}`;
}

/** Storage keys, namespaced by visit and guest membership (DECISIONS D-05). */
export const CART_PREFIX = 'rg.cart.';
export const SUBMIT_PREFIX = 'rg.submit.';
export const cartKey = (visitId: string, guestId: string) => `${CART_PREFIX}${visitId}.${guestId}`;
export const submitKey = (visitId: string, guestId: string) => `${SUBMIT_PREFIX}${visitId}.${guestId}`;
/** The visit id inside a namespaced key (ids never contain dots). */
export const keyVisit = (key: string, prefix: string) => key.slice(prefix.length).split('.')[0] ?? '';
