// Authoritative cart pricing and orderability. Guest orders, staff-assisted
// orders, manual recovery and quotes ALL go through priceCart(): the client
// never supplies a total the server trusts.
import type { CartLineInput } from '../../shared/schemas.ts';
import type { Bilingual, QuoteDTO, QuoteIssue, QuoteLineDTO } from '../../shared/dto.ts';
import { allocateGroupPicks, computeBill, lineTotal, priceGroupPicks, type ChargeRule, type Minor } from '../../shared/money.ts';
import type { PricingType, ReviewStatus, ItemStatus, Station } from '../../shared/status.ts';
import { businessDate } from '../../shared/time.ts';
import { many, one } from '../db/index.ts';
import { getSettings, cutoffHour } from '../lib/settings.ts';

// ------------------------------------------------------------------ rows
export interface ItemRow {
  id: string; key: string; category_id: string; sort: number;
  name_th: string | null; name_en: string | null; name_th_source: string | null;
  desc_th: string | null; desc_en: string | null; desc_verified: number;
  portion_note_th: string | null; portion_note_en: string | null;
  pricing_type: PricingType; price_minor: number | null; rate_minor: number | null; rate_basis_grams: number | null;
  status: ItemStatus; review_status: ReviewStatus; demo_orderable: number;
  sold_out: number; sold_out_since: string | null;
  notes_allowed: number; note_max: number; max_qty: number;
  station: Station; alcohol: number; requires_staff_confirm: number;
  image: string | null; image_alt_th: string | null; image_alt_en: string | null;
  allergen_status: 'unknown' | 'verified'; allergen_verified_by: string | null; allergen_verified_at: string | null;
  source_url: string | null; source_ref: string | null; source_text: string | null; retrieved_at: string | null;
  translation_status: string | null; reviewer: string | null; approved_at: string | null; review_notes: string | null;
  published_version: number | null; created_at: string; updated_at: string; updated_by: string | null; version: number;
}

export interface CategoryRow {
  id: string; key: string; group_id: string; group_key: 'food' | 'drinks';
  name_th: string | null; name_en: string; note_th: string | null; note_en: string | null;
  sort: number; status: ItemStatus; seasonal: number; active_from: string | null; active_until: string | null;
  station: Station; alcohol: number; ordering_paused: number; source_note: string | null; version: number; updated_at: string;
}

export interface VariantRow {
  id: string; item_id: string; key: string; name_th: string | null; name_en: string | null;
  price_minor: number | null; available: number; archived_at: string | null; sort: number; source_text: string | null;
}

export interface GroupRow {
  id: string; key: string; name_th: string | null; name_en: string;
  min_select: number; max_select: number; included_count: number; archived_at: string | null; version: number;
}

export interface OptionRow {
  id: string; group_id: string; key: string; name_th: string | null; name_en: string;
  price_delta_minor: number; upgrade_minor: number; is_default: number; available: number; archived_at: string | null; sort: number;
}

export const bi = (th: string | null | undefined, en: string | null | undefined): Bilingual => ({ th: th ?? null, en: en ?? null });

export function getItem(id: string): ItemRow | undefined {
  return one<ItemRow>('SELECT * FROM menu_items WHERE id = ?', [id]);
}

export function getCategory(id: string): CategoryRow | undefined {
  return one<CategoryRow>(
    `SELECT c.*, g.key AS group_key FROM menu_categories c JOIN menu_groups g ON g.id = c.group_id WHERE c.id = ?`, [id]);
}

export function itemVariants(itemId: string): VariantRow[] {
  return many<VariantRow>('SELECT * FROM item_variants WHERE item_id = ? AND archived_at IS NULL ORDER BY sort, key', [itemId]);
}

export function itemGroups(itemId: string): Array<GroupRow & { options: OptionRow[] }> {
  const groups = many<GroupRow & { link_sort: number }>(
    `SELECT g.*, l.sort AS link_sort FROM item_modifier_groups l JOIN modifier_groups g ON g.id = l.group_id
      WHERE l.item_id = ? AND g.archived_at IS NULL ORDER BY l.sort, g.key`, [itemId]);
  return groups.map((g) => ({
    ...g,
    options: many<OptionRow>('SELECT * FROM modifier_options WHERE group_id = ? AND archived_at IS NULL ORDER BY sort, key', [g.id]),
  }));
}

// ------------------------------------------------------------------ orderability
export type UnavailableReason =
  | 'not_published' | 'seasonal' | 'paused' | 'alcohol_disabled' | 'sold_out' | 'price_pending' | 'not_verified';

export function hasPrice(item: ItemRow, variants: VariantRow[]): boolean {
  switch (item.pricing_type) {
    case 'fixed': return item.price_minor !== null;
    case 'variant': return variants.some((v) => v.available === 1 && v.price_minor !== null);
    case 'measured_weight': return item.rate_minor !== null && item.rate_basis_grams !== null;
  }
}

export function seasonalActive(cat: CategoryRow, today = businessDate(Date.now(), cutoffHour())): boolean {
  if (cat.seasonal !== 1) return true;
  if (cat.active_from && today < cat.active_from) return false;
  if (cat.active_until && today > cat.active_until) return false;
  return true;
}

/** Why an item cannot be ordered right now (null = orderable). Checked in priority order. */
export function unavailableReason(item: ItemRow, cat: CategoryRow, variants: VariantRow[]): UnavailableReason | null {
  const s = getSettings();
  if (item.status !== 'published' || cat.status !== 'published') return 'not_published';
  if (!seasonalActive(cat)) return 'seasonal';
  if ((item.alcohol === 1 || cat.alcohol === 1) && !s.alcohol.enabled) return 'alcohol_disabled';
  if (cat.ordering_paused === 1) return 'paused';
  if (item.sold_out === 1) return 'sold_out';
  if (!hasPrice(item, variants)) return 'price_pending';
  const verified = item.review_status === 'verified';
  if (s.operating_mode === 'live' && !verified) return 'not_verified';
  if (s.operating_mode === 'demo' && !verified && item.demo_orderable !== 1) return 'not_verified';
  return null;
}

// ------------------------------------------------------------------ catalog version
/** Changes whenever anything that affects what a guest may order or pay changes. */
export function catalogVersion(): string {
  const r = one<{ a: string | null; b: string | null; c: string | null; d: string | null; n: number }>(
    `SELECT (SELECT MAX(updated_at) FROM menu_items) AS a,
            (SELECT MAX(updated_at) FROM menu_categories) AS b,
            (SELECT MAX(updated_at) FROM modifier_groups) AS c,
            (SELECT MAX(updated_at) FROM settings) AS d,
            (SELECT COUNT(*) FROM menu_items) AS n`);
  const today = businessDate(Date.now(), cutoffHour());
  const raw = `${r?.a}|${r?.b}|${r?.c}|${r?.d}|${r?.n}|${today}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `c${(h >>> 0).toString(36)}`;
}

// ------------------------------------------------------------------ allergy detection
const ALLERGY_WORDS = [
  'แพ้', 'allerg', 'anaphyla', 'gluten', 'กลูเตน', 'celiac', 'coeliac', 'peanut', 'ถั่วลิสง', 'tree nut',
  'lactose', 'แลคโตส', 'shellfish', 'อาหารทะเล', 'epipen', 'intoleran',
];

export function looksLikeAllergyNote(note: string | null | undefined): boolean {
  if (!note) return false;
  const lower = note.toLowerCase();
  return ALLERGY_WORDS.some((w) => lower.includes(w));
}

// ------------------------------------------------------------------ priceCart
export interface PricedModifierGroup {
  group: GroupRow;
  options: OptionRow[];
  minor: Minor;
}

export interface PricedLine {
  index: number;
  input: CartLineInput;
  item: ItemRow;
  category: CategoryRow;
  variant: VariantRow | null;
  groups: PricedModifierGroup[];
  unit_price_minor: Minor;
  modifiers_minor: Minor;
  quantity: number;
  line_total_minor: Minor;
  note: string | null;
  allergy_flag: boolean;
  prep_kind: 'cook' | 'prepare';
  /** Snapshot stored on the order line. */
  modifiers_snapshot: QuoteLineDTO['modifiers'];
  /** Measured-weight line created from a confirmed portion quote (never from a guest cart). */
  measured?: { grams: number; rate_minor: Minor; rate_basis_grams: number; portion_quote_id: string };
}

export interface PriceCartResult {
  quote: QuoteDTO;
  priced: PricedLine[];
  ok: boolean;
}

export function prepKind(item: ItemRow, cat: CategoryRow): 'cook' | 'prepare' {
  return item.station === 'bar' || cat.group_key === 'drinks' || cat.key === 'dessert' ? 'prepare' : 'cook';
}

export function priceCart(lines: CartLineInput[], opts: { charges?: ChargeRule[] } = {}): PriceCartResult {
  const s = getSettings();
  const issues: QuoteIssue[] = [];
  const quoteLines: QuoteLineDTO[] = [];
  const priced: PricedLine[] = [];

  lines.forEach((input, index) => {
    const issue = (code: QuoteIssue['code'], message: string, current?: QuoteIssue['current']) => {
      issues.push({ line_index: index, code, message, current });
    };
    const before = issues.length;
    const item = getItem(input.item_id);
    if (!item) {
      issue('item_missing', 'This dish is no longer on the menu.');
      quoteLines.push({ line_index: index, ok: false, item_id: input.item_id, name: bi(null, null), variant_name: null, modifiers: [], unit_price_minor: 0, modifiers_minor: 0, quantity: input.quantity, line_total_minor: 0 });
      return;
    }
    const cat = getCategory(item.category_id)!;
    const variants = itemVariants(item.id);
    const reason = unavailableReason(item, cat, variants);
    if (reason === 'sold_out') issue('sold_out', 'Sold out right now.');
    else if (reason) issue('not_orderable', `Not available to order (${reason}).`);

    if (item.pricing_type === 'measured_weight') {
      issue('measured_weight_needs_quote', 'Staff confirm the portion and price for this cut.');
    }

    // variant
    let variant: VariantRow | null = null;
    if (item.pricing_type === 'variant') {
      if (!input.variant_id) {
        issue('variant_required', 'Please choose an option.');
      } else {
        variant = variants.find((v) => v.id === input.variant_id) ?? null;
        if (!variant || variant.available !== 1 || variant.price_minor === null) {
          issue('variant_unavailable', 'That option is not available.');
          variant = null;
        }
      }
    } else if (input.variant_id) {
      issue('modifier_invalid', 'This dish has no options of that kind.');
    }

    // quantity
    if (input.quantity < 1 || input.quantity > item.max_qty) {
      issue('quantity_invalid', `You can order up to ${item.max_qty} at a time.`);
    }

    // note (kept exactly as typed apart from surrounding whitespace)
    const note = input.note?.trim() ? input.note.trim() : null;
    if (note) {
      if (item.notes_allowed !== 1) issue('notes_not_allowed', 'Notes are not available for this item.');
      const max = Math.min(item.note_max, s.menu.note_max_length);
      if ([...note].length > max) issue('note_too_long', `Notes can be up to ${max} characters.`);
    }

    // modifiers
    const groups = itemGroups(item.id);
    const pickedGroups: PricedModifierGroup[] = [];
    const seen = new Set<string>();
    for (const pick of input.modifiers ?? []) {
      if (seen.has(pick.group_id)) { issue('modifier_invalid', 'A choice group was sent twice.'); continue; }
      seen.add(pick.group_id);
      if (!groups.some((g) => g.id === pick.group_id)) issue('modifier_invalid', 'That choice does not belong to this dish.');
    }
    for (const g of groups) {
      const pick = (input.modifiers ?? []).find((m) => m.group_id === g.id);
      const ids = pick?.option_ids ?? [];
      if (new Set(ids).size !== ids.length) { issue('modifier_invalid', 'An option was chosen twice.'); continue; }
      const chosen = ids.map((oid) => g.options.find((o) => o.id === oid));
      if (chosen.some((o) => !o)) { issue('modifier_invalid', 'That option does not belong to this choice.'); continue; }
      const opts = chosen as OptionRow[];
      if (opts.some((o) => o.available !== 1)) issue('modifier_unavailable', 'One of your choices is not available now.');
      if (opts.length < g.min_select) issue('modifier_required', `Please choose ${g.name_en}.`);
      if (opts.length > g.max_select) issue('modifier_invalid', `Choose at most ${g.max_select}.`);
      const minor = priceGroupPicks(g.options, ids, g.included_count);
      if (opts.length) pickedGroups.push({ group: g, options: g.options.filter((o) => ids.includes(o.id)), minor });
    }

    const unit = item.pricing_type === 'variant' ? (variant?.price_minor ?? 0) : (item.price_minor ?? 0);
    const modifiersMinor = pickedGroups.reduce((sum, g) => sum + g.minor, 0);
    const qty = Math.max(1, Math.min(99, input.quantity));
    const total = lineTotal(unit, modifiersMinor, qty);

    // Compare against what the guest saw only when this line HAS a current price:
    // a missing/unavailable variant or an unpriced/measured item already has its
    // own issue, and "price changed to 0" would misstate the change (T2 tests).
    const priceKnown = item.pricing_type === 'variant' ? variant !== null
      : item.pricing_type === 'fixed' ? item.price_minor !== null : false;
    if (priceKnown && input.expected_unit_minor !== undefined && input.expected_unit_minor !== null && input.expected_unit_minor !== unit + modifiersMinor) {
      issue('price_changed', 'The price has changed since you added this.', { unit_price_minor: unit + modifiersMinor, line_total_minor: total });
    }

    const snapshot: QuoteLineDTO['modifiers'] = pickedGroups.map((g) => {
      const full = groups.find((x) => x.id === g.group.id)!;
      const alloc = allocateGroupPicks(full.options, g.options.map((o) => o.id), full.included_count);
      return {
        group: bi(g.group.name_th, g.group.name_en),
        options: g.options.map((o) => ({
          name: bi(o.name_th, o.name_en),
          price_minor: alloc.find((a) => a.id === o.id)?.charged_minor ?? 0,
        })),
      };
    });

    const ok = issues.length === before;
    quoteLines.push({
      line_index: index, ok, item_id: item.id,
      name: bi(item.name_th, item.name_en),
      variant_name: variant ? bi(variant.name_th, variant.name_en) : null,
      modifiers: snapshot,
      unit_price_minor: unit, modifiers_minor: modifiersMinor, quantity: qty, line_total_minor: total,
    });
    priced.push({
      index, input, item, category: cat, variant, groups: pickedGroups,
      unit_price_minor: unit, modifiers_minor: modifiersMinor, quantity: qty, line_total_minor: total,
      note, allergy_flag: input.allergy_note === true || looksLikeAllergyNote(note),
      prep_kind: prepKind(item, cat), modifiers_snapshot: snapshot,
    });
  });

  const subtotal = quoteLines.filter((l) => l.ok).reduce((sum, l) => sum + l.line_total_minor, 0);
  const bill = computeBill({ lineTotals: [subtotal], adjustments: [], charges: opts.charges ?? s.charges });
  return {
    ok: issues.length === 0 && lines.length > 0,
    priced,
    quote: {
      lines: quoteLines,
      issues,
      subtotal_minor: subtotal,
      charges_preview: bill.charges,
      estimated_total_minor: bill.total_minor,
      catalog_version: catalogVersion(),
    },
  };
}
