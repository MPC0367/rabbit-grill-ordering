// Item editor form model (C6): text inputs <-> AdminItemDTO, the minimal
// PATCH body (only what changed), price-change detection and validation.
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import type { PricingType, Station } from '../../../../shared/status.ts';
import { bahtTextToMinor, intText, minorToBahtText } from './model.tsx';

export interface VariantForm {
  uid: string;
  id: string | null;
  key: string;
  name_th: string;
  name_en: string;
  price: string;
  available: boolean;
}

export interface ItemForm {
  name_th: string;
  name_en: string;
  desc_th: string;
  desc_en: string;
  desc_verified: boolean;
  category_id: string;
  pricing_type: PricingType;
  price: string;
  rate: string;
  basis: string;
  variants: VariantForm[];
  portion_note_th: string;
  portion_note_en: string;
  image: string;
  image_alt_th: string;
  image_alt_en: string;
  notes_allowed: boolean;
  note_max: string;
  max_qty: string;
  station: Station;
  alcohol: boolean;
  requires_staff_confirm: boolean;
  modifier_group_ids: string[];
  review_notes: string;
  price_change_reason: string;
}

let seq = 0;
export const newUid = () => `v${++seq}`;

export function variantFormOf(v: AdminItemDTO['variants'][number]): VariantForm {
  return {
    uid: `var-${v.id}`,
    id: v.id,
    key: v.key,
    name_th: v.name.th ?? '',
    name_en: v.name.en ?? '',
    price: minorToBahtText(v.price_minor),
    available: v.available,
  };
}

export function blankVariant(n: number): VariantForm {
  return { uid: newUid(), id: null, key: `option-${n}`, name_th: '', name_en: '', price: '', available: true };
}

export function formOf(item: AdminItemDTO): ItemForm {
  return {
    name_th: item.name.th ?? '',
    name_en: item.name.en ?? '',
    desc_th: item.description_admin.th ?? '',
    desc_en: item.description_admin.en ?? '',
    desc_verified: item.desc_verified,
    category_id: item.category_id,
    pricing_type: item.pricing_type,
    price: minorToBahtText(item.price_minor),
    rate: minorToBahtText(item.rate_minor),
    basis: item.rate_basis_grams === null ? (item.pricing_type === 'measured_weight' ? '' : '100') : String(item.rate_basis_grams),
    variants: item.variants.map(variantFormOf),
    portion_note_th: item.portion_note?.th ?? '',
    portion_note_en: item.portion_note?.en ?? '',
    image: item.image?.name ?? '',
    image_alt_th: item.image?.alt.th ?? '',
    image_alt_en: item.image?.alt.en ?? '',
    notes_allowed: item.notes_allowed,
    note_max: String(item.note_max),
    max_qty: String(item.max_qty),
    station: item.station,
    alcohol: item.alcohol,
    requires_staff_confirm: item.requires_staff_confirm,
    modifier_group_ids: [...item.modifier_group_ids],
    review_notes: item.review_notes ?? '',
    price_change_reason: '',
  };
}

const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

export type FormErrors = Partial<Record<string, string>>;

export interface PatchResult {
  body: Record<string, unknown>;
  /** Field names (form keys) that differ from the base. */
  changed: string[];
  priceChanged: boolean;
  errors: FormErrors;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

const sameVariants = (a: VariantForm[], b: VariantForm[]) =>
  a.length === b.length && a.every((v, i) => v.id === b[i].id && v.key.trim() === b[i].key.trim()
    && v.name_th.trim() === b[i].name_th.trim() && v.name_en.trim() === b[i].name_en.trim()
    && bahtTextToMinor(v.price) === bahtTextToMinor(b[i].price) && v.available === b[i].available);

/**
 * Compare the form with the item it was loaded from and build the smallest
 * valid PATCH body. `note_max` is compared against the stored value, not the
 * guest-capped one.
 */
export function buildPatch(form: ItemForm, base: AdminItemDTO, opts: { canReview: boolean; t: T }): PatchResult {
  const { t } = opts;
  const was = formOf(base);
  const errors: FormErrors = {};
  const body: Record<string, unknown> = {};
  const changed: string[] = [];
  const text = (k: keyof ItemForm, api: string = k) => {
    const now = orNull(form[k] as string);
    const before = orNull(was[k] as string);
    if (now !== before) { body[api] = now; changed.push(k); }
  };

  text('name_th');
  text('name_en');
  if (!orNull(form.name_th) && !orNull(form.name_en) && base.status === 'published') errors.name_th = t('catalog.editor.nameNeeded');
  text('desc_th');
  text('desc_en');
  if (opts.canReview && form.desc_verified !== was.desc_verified) { body.desc_verified = form.desc_verified; changed.push('desc_verified'); }
  if (form.category_id !== was.category_id) { body.category_id = form.category_id; changed.push('category_id'); }

  // pricing
  let priceChanged = false;
  const type = form.pricing_type;
  if (type !== was.pricing_type) { body.pricing_type = type; changed.push('pricing_type'); priceChanged = true; }
  if (type === 'fixed') {
    const price = bahtTextToMinor(form.price);
    if (price === undefined) errors.price = t('catalog.editor.priceRule');
    else if (price !== bahtTextToMinor(was.price) || type !== was.pricing_type) {
      body.price_minor = price;
      if (price !== bahtTextToMinor(was.price)) { changed.push('price'); priceChanged = true; }
    }
  }
  if (type === 'measured_weight') {
    const rate = bahtTextToMinor(form.rate);
    const basis = intText(form.basis, 1, 1000);
    if (rate === undefined) errors.rate = t('catalog.editor.priceRule');
    if (basis === undefined) errors.basis = t('catalog.editor.basisRule');
    if (rate !== undefined && (rate !== bahtTextToMinor(was.rate) || type !== was.pricing_type)) {
      body.rate_minor = rate;
      if (rate !== bahtTextToMinor(was.rate)) { changed.push('rate'); priceChanged = true; }
    }
    if (basis !== undefined && (basis !== intText(was.basis, 1, 1000) || type !== was.pricing_type)) {
      body.rate_basis_grams = basis;
      if (basis !== intText(was.basis, 1, 1000)) { changed.push('basis'); priceChanged = true; }
    }
  }
  if (type === 'variant') {
    const keys = new Set<string>();
    form.variants.forEach((v, i) => {
      const key = v.key.trim();
      if (!key) errors[`variants.${i}.key`] = t('catalog.editor.keyNeeded');
      else if (key.length > 40) errors[`variants.${i}.key`] = t('catalog.editor.keyLong');
      else if (keys.has(key)) errors[`variants.${i}.key`] = t('catalog.groups.keyTwice');
      keys.add(key);
      if (bahtTextToMinor(v.price) === undefined) errors[`variants.${i}.price`] = t('catalog.editor.priceRule');
    });
    if (form.variants.length > 12) errors.variants = t('catalog.editor.tooManyVariants');
    const variantsChanged = !sameVariants(form.variants, was.variants) || type !== was.pricing_type;
    if (variantsChanged) {
      body.variants = form.variants.map((v) => ({
        id: v.id,
        key: v.key.trim(),
        name_th: orNull(v.name_th),
        name_en: orNull(v.name_en),
        price_minor: bahtTextToMinor(v.price) ?? null,
        available: v.available,
      }));
      changed.push('variants');
      // A new priced variant, a removed priced variant or a changed price is a price change.
      const before = new Map(base.variants.map((v) => [v.id, v.price_minor]));
      const now = new Map(form.variants.filter((v) => v.id).map((v) => [v.id as string, bahtTextToMinor(v.price) ?? null]));
      const touched = form.variants.some((v) => (v.id ? before.get(v.id) !== (bahtTextToMinor(v.price) ?? null) : bahtTextToMinor(v.price) !== null))
        || base.variants.some((v) => !now.has(v.id) && v.price_minor !== null);
      if (touched) priceChanged = true;
    }
  }

  text('portion_note_th');
  text('portion_note_en');
  if (form.image !== was.image) { body.image = form.image || null; changed.push('image'); }
  text('image_alt_th');
  text('image_alt_en');

  if (form.notes_allowed !== was.notes_allowed) { body.notes_allowed = form.notes_allowed; changed.push('notes_allowed'); }
  const noteMax = intText(form.note_max, 0, 500);
  if (noteMax === undefined || noteMax === null) errors.note_max = t('catalog.groups.numberRule', { min: 0, max: 500 });
  else if (noteMax !== intText(was.note_max, 0, 500)) { body.note_max = noteMax; changed.push('note_max'); }
  const maxQty = intText(form.max_qty, 1, 99);
  if (maxQty === undefined || maxQty === null) errors.max_qty = t('catalog.groups.numberRule', { min: 1, max: 99 });
  else if (maxQty !== intText(was.max_qty, 1, 99)) { body.max_qty = maxQty; changed.push('max_qty'); }
  if (form.station !== was.station) { body.station = form.station; changed.push('station'); }
  if (form.alcohol !== was.alcohol) { body.alcohol = form.alcohol; changed.push('alcohol'); }
  if (form.requires_staff_confirm !== was.requires_staff_confirm) { body.requires_staff_confirm = form.requires_staff_confirm; changed.push('requires_staff_confirm'); }
  if (form.modifier_group_ids.join('|') !== was.modifier_group_ids.join('|')) { body.modifier_group_ids = form.modifier_group_ids; changed.push('modifier_group_ids'); }
  if (!opts.canReview) text('review_notes');

  if (priceChanged) {
    const reason = orNull(form.price_change_reason);
    if (reason) body.price_change_reason = reason;
    else if (base.status === 'published') errors.price_change_reason = t('catalog.editor.reasonRequired');
  }

  return { body, changed, priceChanged, errors };
}

/** Human value of one form field, for the conflict comparison. */
export function fieldValue(form: ItemForm, key: string, t: T, groupName: (id: string) => string, categoryName: (id: string) => string): string {
  const v = (form as unknown as Record<string, unknown>)[key];
  if (key === 'variants') {
    return form.variants.map((x) => `${x.name_en || x.name_th || x.key} ${x.price ? `฿${x.price}` : '—'}${x.available ? '' : ` (${t('common.optionOut')})`}`).join(', ') || '—';
  }
  if (key === 'modifier_group_ids') return form.modifier_group_ids.map(groupName).join(', ') || '—';
  if (key === 'category_id') return categoryName(form.category_id);
  if (key === 'pricing_type') return t(`catalog.pricing.${form.pricing_type}`);
  if (key === 'station') return t(`catalog.station.${form.station}`);
  if (key === 'price' || key === 'rate') return v ? `฿${String(v)}` : '—';
  if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
  return typeof v === 'string' && v.trim() ? v : '—';
}

/** Form keys whose values differ between two forms. */
export function diffForms(a: ItemForm, b: ItemForm): string[] {
  const keys = Object.keys(a).filter((k) => k !== 'price_change_reason') as Array<keyof ItemForm>;
  return keys.filter((k) => {
    if (k === 'variants') return !sameVariants(a.variants, b.variants);
    if (k === 'modifier_group_ids') return a.modifier_group_ids.join('|') !== b.modifier_group_ids.join('|');
    const x = a[k];
    const y = b[k];
    return typeof x === 'string' && typeof y === 'string' ? x.trim() !== y.trim() : x !== y;
  });
}
