// Menu CSV export, import template, import preview and import apply (S1).
//
// Imported spreadsheets are DATA (brief 04, 21): the text is parsed as CSV,
// validated cell by cell and stored as plain strings. Nothing in a file is
// evaluated, followed or executed, and an import never publishes anything or
// overwrites a published item. Formula injection is neutralised on export by
// server/lib/csv.ts (a leading apostrophe); the importer removes that one
// apostrophe again so an export -> import round trip is stable.
//
// File format (docs/DECISIONS.md D-S1.5): one row per item, or one row per
// variant for variant-priced items (the item columns repeat on each variant
// row, or are left blank after the first). `key` is the stable identity.
// A column that is absent keeps the current value on update; a present but
// blank text/price cell clears it.
import type { AdminCatalogDTO, Bilingual, ImportErrorDTO, ImportPreviewDTO, ImportRowDTO, ImportSummaryDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import { ALIAS_MAX, ALIASES_PER_ITEM, IMAGE_ALT_MAX } from '../../shared/schemas.ts';
import { PRICING_TYPES, STATIONS, type PricingType, type Station } from '../../shared/status.ts';
import { nowIso } from '../../shared/time.ts';
import { insert, many, one, parseJson, run, updateVersioned } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { parseCsvObjects, toCsv, type CsvColumn } from '../lib/csv.ts';
import { AppError } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { getSettings } from '../lib/settings.ts';
import { adminCatalog } from './catalog.ts';
import { addPriceHistory, nextItemSort, normalizePricing, syncVariants, trackOrderability, type VariantInput } from './catalog-edit.ts';
import { bi, catalogVersion, normalizeAliases, parseAliases, type ItemRow, type VariantRow } from './pricing.ts';

export const IMPORT_COLUMNS = [
  'key', 'category_key', 'name_th', 'name_en', 'desc_th', 'desc_en', 'pricing_type', 'price_baht', 'rate_baht',
  'rate_basis_grams', 'variant_key', 'variant_name_th', 'variant_name_en', 'variant_price_baht', 'station',
  'alcohol', 'notes_allowed', 'max_qty', 'image', 'image_alt_th', 'image_alt_en', 'aliases_th', 'aliases_en',
] as const;

/** Search aliases travel in one cell, separated by "|" (never printed on the menu). */
export const ALIAS_SEPARATOR = '|';
type Column = (typeof IMPORT_COLUMNS)[number];

/** Item-level columns: they must agree across the rows of one key. */
const ITEM_COLUMNS: readonly Column[] = IMPORT_COLUMNS.filter((c) => c !== 'key' && !c.startsWith('variant_'));
const MAX_ROWS = 2000;
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const VARIANT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const IMAGE_RE = /^[a-z0-9-]{1,80}$/;
const FORMULA_RE = /^[=+\-@]/;
const LIMITS: Partial<Record<Column, number>> = {
  name_th: 120, name_en: 120, desc_th: 400, desc_en: 400, image_alt_th: IMAGE_ALT_MAX, image_alt_en: IMAGE_ALT_MAX,
  variant_name_th: 60, variant_name_en: 60,
};

/** "grilled beef|ribeye" -> ["grilled beef", "ribeye"], or an error message. */
function parseAliasCell(text: string): { aliases: string[] } | { error: string } {
  const parts = normalizeAliases(text.split(ALIAS_SEPARATOR));
  if (parts.length > ALIASES_PER_ITEM) return { error: `Up to ${ALIASES_PER_ITEM} search aliases per dish, separated by "${ALIAS_SEPARATOR}".` };
  const tooLong = parts.find((a) => [...a].length > ALIAS_MAX);
  if (tooLong) return { error: `Keep each search alias to ${ALIAS_MAX} characters.` };
  return { aliases: parts };
}

// ------------------------------------------------------------------ money text
export function minorToBaht(minor: number | null): string {
  if (minor === null) return '';
  const whole = Math.floor(minor / 100);
  const satang = minor % 100;
  return satang ? `${whole}.${String(satang).padStart(2, '0')}` : String(whole);
}

/** "590", "1,590", "590.5", "590.50" -> satang, exactly (no float maths). null = not a price. */
export function bahtToMinorExact(text: string): number | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  const satang = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  const value = whole * 100 + satang;
  return Number.isSafeInteger(value) ? value : null;
}

// ------------------------------------------------------------------ export
interface ExportRow {
  item: ItemRow & { category_key: string };
  variant: VariantRow | null;
}

/** Full catalog as CSV: stable ids and keys, one row per item or per variant. */
export function exportCatalogCsv(): string {
  const items = many<ItemRow & { category_key: string }>(
    `SELECT i.*, c.key AS category_key FROM menu_items i
       JOIN menu_categories c ON c.id = i.category_id JOIN menu_groups g ON g.id = c.group_id
      ORDER BY g.sort, c.sort, c.key, i.sort, i.key`);
  const variants = many<VariantRow>('SELECT * FROM item_variants WHERE archived_at IS NULL ORDER BY item_id, sort, key');
  const rows: ExportRow[] = [];
  for (const item of items) {
    const own = item.pricing_type === 'variant' ? variants.filter((v) => v.item_id === item.id) : [];
    if (own.length === 0) rows.push({ item, variant: null });
    for (const v of own) rows.push({ item, variant: v });
  }
  const i = (r: ExportRow) => r.item;
  const columns: CsvColumn<ExportRow>[] = [
    { key: 'id', header: 'id', value: (r) => i(r).id },
    { key: 'key', header: 'key', value: (r) => i(r).key },
    { key: 'category_key', header: 'category_key', value: (r) => i(r).category_key },
    { key: 'name_th', header: 'name_th', value: (r) => i(r).name_th },
    { key: 'name_en', header: 'name_en', value: (r) => i(r).name_en },
    { key: 'desc_th', header: 'desc_th', value: (r) => i(r).desc_th },
    { key: 'desc_en', header: 'desc_en', value: (r) => i(r).desc_en },
    { key: 'pricing_type', header: 'pricing_type', value: (r) => i(r).pricing_type },
    { key: 'price_baht', header: 'price_baht', value: (r) => (i(r).pricing_type === 'fixed' ? minorToBaht(i(r).price_minor) : '') },
    { key: 'rate_baht', header: 'rate_baht', value: (r) => (i(r).pricing_type === 'measured_weight' ? minorToBaht(i(r).rate_minor) : '') },
    { key: 'rate_basis_grams', header: 'rate_basis_grams', value: (r) => (i(r).pricing_type === 'measured_weight' ? i(r).rate_basis_grams : null) },
    { key: 'variant_key', header: 'variant_key', value: (r) => r.variant?.key },
    { key: 'variant_name_th', header: 'variant_name_th', value: (r) => r.variant?.name_th },
    { key: 'variant_name_en', header: 'variant_name_en', value: (r) => r.variant?.name_en },
    { key: 'variant_price_baht', header: 'variant_price_baht', value: (r) => (r.variant ? minorToBaht(r.variant.price_minor) : '') },
    { key: 'station', header: 'station', value: (r) => i(r).station },
    { key: 'alcohol', header: 'alcohol', value: (r) => i(r).alcohol === 1 },
    { key: 'notes_allowed', header: 'notes_allowed', value: (r) => i(r).notes_allowed === 1 },
    { key: 'max_qty', header: 'max_qty', value: (r) => i(r).max_qty },
    { key: 'image', header: 'image', value: (r) => i(r).image },
    { key: 'image_alt_th', header: 'image_alt_th', value: (r) => i(r).image_alt_th },
    { key: 'image_alt_en', header: 'image_alt_en', value: (r) => i(r).image_alt_en },
    { key: 'aliases_th', header: 'aliases_th', value: (r) => parseAliases(i(r).aliases_th).join(ALIAS_SEPARATOR) },
    { key: 'aliases_en', header: 'aliases_en', value: (r) => parseAliases(i(r).aliases_en).join(ALIAS_SEPARATOR) },
    // Read-only context: ignored by the importer.
    { key: 'aliases_verified', header: 'aliases_verified', value: (r) => i(r).aliases_verified === 1 },
    { key: 'variant_id', header: 'variant_id', value: (r) => r.variant?.id },
    { key: 'variant_available', header: 'variant_available', value: (r) => (r.variant ? r.variant.available === 1 : null) },
    { key: 'status', header: 'status', value: (r) => i(r).status },
    { key: 'review_status', header: 'review_status', value: (r) => i(r).review_status },
    { key: 'desc_verified', header: 'desc_verified', value: (r) => i(r).desc_verified === 1 },
    { key: 'sold_out', header: 'sold_out', value: (r) => i(r).sold_out === 1 },
  ];
  return toCsv(rows, columns);
}

/** The documented import template: the header row only (no invented example dishes). */
export function importTemplateCsv(): string {
  return toCsv<never>([], IMPORT_COLUMNS.map((c) => ({ key: c, header: c, value: () => null })));
}

// ------------------------------------------------------------------ parsing
export interface ItemFields {
  name_th?: string | null; name_en?: string | null;
  desc_th?: string | null; desc_en?: string | null;
  pricing_type: PricingType;
  price_minor?: number | null; rate_minor?: number | null; rate_basis_grams?: number | null;
  station?: Station; alcohol?: 0 | 1; notes_allowed?: 0 | 1; max_qty?: number;
  image?: string | null; image_alt_th?: string | null; image_alt_en?: string | null;
  /** Search aliases, replacing the current list. Imported aliases are never published (unreviewed). */
  aliases_th?: string[]; aliases_en?: string[];
}

export interface ItemPlan {
  key: string;
  category_key: string;
  rows: number[];
  action: 'create' | 'update_draft' | 'skip_published' | 'skip_archived';
  fields: ItemFields;
  variants: Array<{ key: string; name_th: string | null; name_en: string | null; price_minor: number | null }> | null;
}

interface StoredBatch { version: 1; rows: ImportRowDTO[]; plans: ItemPlan[] }

/** Undo our own export neutralisation and drop control characters. The value stays plain text. */
function cellText(raw: string | undefined, multiline = false): string {
  let v = (raw ?? '').replace(/^'(?=[=+\-@\t\r])/, '');
  v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!multiline) v = v.replace(/\s*[\r\n]+\s*/g, ' ');
  return v.trim();
}

function parseBool(text: string): 0 | 1 | null {
  const t = text.toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(t)) return 1;
  if (['0', 'false', 'no', 'n'].includes(t)) return 0;
  return null;
}

interface ParsedRow {
  row: number;
  cells: Partial<Record<Column, string>>;
}

/**
 * Validate a CSV text and classify it against the current catalog. Pure
 * reads: the caller stores the batch.
 */
export function analyseImport(csv: string): { rows: ImportRowDTO[]; errors: ImportErrorDTO[]; plans: ItemPlan[]; summary: ImportSummaryDTO } {
  const errors: ImportErrorDTO[] = [];
  const err = (row: number, column: Column | null, code: string, message: string) => errors.push({ row, column, code, message });
  const { headers, rows: raw } = parseCsvObjects(csv);
  const has = new Set(headers);

  const emptySummary = (): ImportSummaryDTO => ({
    rows: raw.length, items: 0, variants: 0, create: 0, update_draft: 0, skip_published: 0, skip_archived: 0,
    errors: errors.length, can_apply: false,
  });
  if (headers.length === 0) {
    err(1, null, 'empty_file', 'The file is empty.');
    return { rows: [], errors, plans: [], summary: emptySummary() };
  }
  for (const col of ['key', 'category_key', 'pricing_type'] as const) {
    if (!has.has(col)) err(1, col, 'missing_column', `The column "${col}" is missing.`);
  }
  if (!has.has('name_th') && !has.has('name_en')) err(1, 'name_en', 'missing_column', 'Add a name_th or name_en column.');
  if (raw.length > MAX_ROWS) err(1, null, 'too_many_rows', `Import at most ${MAX_ROWS} rows at a time.`);
  if (raw.length === 0) err(1, null, 'empty_file', 'The file has a header but no rows.');
  if (errors.length) return { rows: [], errors, plans: [], summary: emptySummary() };

  const parsed: ParsedRow[] = raw.map((r, index) => {
    const cells: Partial<Record<Column, string>> = {};
    for (const col of IMPORT_COLUMNS) {
      if (has.has(col)) cells[col] = cellText(r[col], col === 'desc_th' || col === 'desc_en');
    }
    return { row: index + 2, cells };
  });

  // group rows by key, in file order
  const groups = new Map<string, ParsedRow[]>();
  for (const p of parsed) {
    const key = p.cells.key ?? '';
    if (!KEY_RE.test(key)) {
      err(p.row, 'key', 'bad_key', 'Use 2-60 lower-case letters, digits and hyphens for the key.');
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(p); else groups.set(key, [p]);
  }

  const categories = new Map(many<{ key: string }>('SELECT key FROM menu_categories').map((c) => [c.key, true]));
  const plans: ItemPlan[] = [];
  const notes = new Map<number, string>();

  for (const [key, list] of groups) {
    const head = list[0];
    const c = head.cells;
    const before = errors.length;
    const fields = {} as ItemFields;

    // the item ("parent") row
    if (!c.category_key && !c.pricing_type && c.variant_key) {
      err(head.row, 'variant_key', 'variant_without_parent', `The variant row for "${key}" has no item row (category and pricing type are blank).`);
      continue;
    }
    if (!c.category_key) err(head.row, 'category_key', 'unknown_category', 'The category key is missing.');
    else if (!categories.has(c.category_key)) err(head.row, 'category_key', 'unknown_category', `There is no category "${c.category_key}".`);
    const pricing = c.pricing_type as PricingType;
    if (!(PRICING_TYPES as readonly string[]).includes(c.pricing_type ?? '')) {
      err(head.row, 'pricing_type', 'bad_pricing_type', 'Pricing type must be fixed, variant or measured_weight.');
    }
    fields.pricing_type = pricing;

    for (const col of ['name_th', 'name_en', 'desc_th', 'desc_en', 'image_alt_th', 'image_alt_en'] as const) {
      const v = c[col];
      if (v === undefined) continue;
      if ([...v].length > (LIMITS[col] ?? 400)) err(head.row, col, 'too_long', `Keep ${col} to ${LIMITS[col]} characters.`);
      fields[col] = v === '' ? null : v;
      if (FORMULA_RE.test(v)) notes.set(head.row, 'Some text starts like a spreadsheet formula; it is stored as plain text.');
    }
    // A nameless draft is allowed (the editor allows it too); publishing is blocked until it has a name.
    if (!fields.name_th && !fields.name_en) notes.set(head.row, 'No name yet: the draft cannot be published until it has one.');

    const price = (col: 'price_baht' | 'rate_baht', applies: boolean): number | null | undefined => {
      const v = c[col];
      if (v === undefined) return undefined;
      if (v !== '' && !applies) {
        err(head.row, col, 'bad_value', `${col} does not apply to ${pricing} pricing.`);
        return undefined;
      }
      if (v === '') return null;
      const minor = bahtToMinorExact(v);
      if (minor === null) err(head.row, col, 'bad_number', `"${v}" is not a price in baht.`);
      return minor;
    };
    fields.price_minor = price('price_baht', pricing === 'fixed');
    fields.rate_minor = price('rate_baht', pricing === 'measured_weight');
    if (c.rate_basis_grams !== undefined) {
      const v = c.rate_basis_grams;
      if (v !== '' && pricing !== 'measured_weight') err(head.row, 'rate_basis_grams', 'bad_value', 'rate_basis_grams only applies to measured_weight pricing.');
      else if (v === '') fields.rate_basis_grams = null;
      else if (!/^\d{1,4}$/.test(v) || Number(v) < 1 || Number(v) > 1000) err(head.row, 'rate_basis_grams', 'bad_number', 'rate_basis_grams must be a whole number of grams (1-1000).');
      else fields.rate_basis_grams = Number(v);
    }
    if (c.station) {
      if ((STATIONS as readonly string[]).includes(c.station)) fields.station = c.station as Station;
      else err(head.row, 'station', 'bad_value', 'Station must be kitchen or bar.');
    }
    for (const col of ['alcohol', 'notes_allowed'] as const) {
      const v = c[col];
      if (!v) continue;
      const b = parseBool(v);
      if (b === null) err(head.row, col, 'bad_value', `${col} must be 1 or 0.`);
      else fields[col] = b;
    }
    if (c.max_qty) {
      if (!/^\d{1,2}$/.test(c.max_qty) || Number(c.max_qty) < 1) err(head.row, 'max_qty', 'bad_number', 'max_qty must be a whole number from 1 to 99.');
      else fields.max_qty = Number(c.max_qty);
    }
    for (const col of ['aliases_th', 'aliases_en'] as const) {
      const v = c[col];
      if (v === undefined) continue;
      const parsed = parseAliasCell(v);
      if ('error' in parsed) err(head.row, col, 'bad_value', parsed.error);
      else fields[col] = parsed.aliases;
    }
    if (c.image !== undefined) {
      if (c.image !== '' && !IMAGE_RE.test(c.image)) err(head.row, 'image', 'bad_value', 'Image names use lower-case letters, digits and hyphens.');
      else fields.image = c.image === '' ? null : c.image;
    }

    // variant rows
    const variants: NonNullable<ItemPlan['variants']> = [];
    const variantKeys = new Set<string>();
    for (const p of list) {
      const vk = p.cells.variant_key ?? '';
      if (p !== head) {
        if (!vk) {
          err(p.row, 'key', 'duplicate_key', `The key "${key}" is already used on row ${head.row}.`);
          continue;
        }
        for (const col of ITEM_COLUMNS) {
          const v = p.cells[col];
          if (v && v !== c[col]) err(p.row, col, 'conflicting_values', `${col} differs from row ${head.row} for the same item.`);
        }
      }
      const hasVariantData = Boolean(vk || p.cells.variant_name_th || p.cells.variant_name_en || p.cells.variant_price_baht);
      if (!hasVariantData) continue;
      if (pricing !== 'variant') {
        err(p.row, 'variant_key', 'variant_without_parent', `"${key}" is not variant-priced, so it cannot have variant rows.`);
        continue;
      }
      if (!VARIANT_KEY_RE.test(vk)) {
        err(p.row, 'variant_key', 'bad_key', 'Give each variant a key (letters, digits, dot, dash or underscore; up to 40).');
        continue;
      }
      if (variantKeys.has(vk)) {
        err(p.row, 'variant_key', 'duplicate_variant', `The variant "${vk}" is listed twice for "${key}".`);
        continue;
      }
      variantKeys.add(vk);
      for (const col of ['variant_name_th', 'variant_name_en'] as const) {
        const v = p.cells[col] ?? '';
        if ([...v].length > (LIMITS[col] ?? 60)) err(p.row, col, 'too_long', `Keep ${col} to ${LIMITS[col]} characters.`);
        if (FORMULA_RE.test(v)) notes.set(p.row, 'Some text starts like a spreadsheet formula; it is stored as plain text.');
      }
      const priceText = p.cells.variant_price_baht ?? '';
      const vp = priceText === '' ? null : bahtToMinorExact(priceText);
      if (priceText !== '' && vp === null) err(p.row, 'variant_price_baht', 'bad_number', `"${priceText}" is not a price in baht.`);
      variants.push({ key: vk, name_th: p.cells.variant_name_th || null, name_en: p.cells.variant_name_en || null, price_minor: vp });
    }
    if (pricing === 'variant' && variants.length === 0 && list.every((p) => !p.cells.variant_key)) {
      err(head.row, 'variant_key', 'missing_variants', `"${key}" is variant-priced: add one row per variant.`);
    }
    if (errors.length !== before) continue;
    plans.push({
      key,
      category_key: c.category_key!,
      rows: list.map((p) => p.row),
      action: 'create',
      fields,
      variants: pricing === 'variant' ? variants : null,
    });
  }

  // classify against the catalog as it is now
  const planByKey = new Map(plans.map((p) => [p.key, p]));
  for (const plan of plans) {
    const existing = one<{ status: string }>('SELECT status FROM menu_items WHERE key = ?', [plan.key]);
    plan.action = !existing ? 'create'
      : existing.status === 'draft' ? 'update_draft'
      : existing.status === 'published' ? 'skip_published'
      : 'skip_archived';
  }

  const errorRows = new Set(errors.map((e) => e.row));
  const rows: ImportRowDTO[] = parsed.map((p) => {
    const key = p.cells.key ?? '';
    const plan = planByKey.get(key);
    const headCells = groups.get(key)?.[0]?.cells ?? p.cells;
    const name: Bilingual = bi(headCells.name_th || null, headCells.name_en || null);
    const action = errorRows.has(p.row) || !plan ? 'error' : plan.action;
    const message = action === 'skip_published'
      ? 'Published items are never overwritten by an import. Unpublish it or edit it in the menu editor.'
      : action === 'skip_archived'
        ? 'This item is archived. Restore it in the menu editor first.'
        : notes.get(p.row) ?? null;
    return { row: p.row, key, variant_key: p.cells.variant_key || null, category_key: headCells.category_key ?? '', name, action, message };
  });

  const count = (a: ItemPlan['action']) => plans.filter((p) => p.action === a).length;
  return {
    rows,
    errors,
    plans,
    summary: {
      rows: parsed.length,
      items: groups.size,
      variants: plans.reduce((n, p) => n + (p.variants?.length ?? 0), 0),
      create: count('create'),
      update_draft: count('update_draft'),
      skip_published: count('skip_published'),
      skip_archived: count('skip_archived'),
      errors: errors.length,
      can_apply: errors.length === 0 && (count('create') + count('update_draft')) > 0,
    },
  };
}

/** Validate a file and store it as a previewed batch. Nothing in the catalog changes. */
export function previewImport(filename: string, csv: string, staff: StaffContext): ImportPreviewDTO {
  const result = analyseImport(csv);
  const id = newId('imp');
  const stored: StoredBatch = { version: 1, rows: result.rows, plans: result.plans };
  insert('menu_import_batches', {
    id,
    filename: filename.trim() || 'menu.csv',
    status: 'previewed',
    rows_json: JSON.stringify(stored),
    errors_json: JSON.stringify(result.errors),
    summary_json: JSON.stringify(result.summary),
    created_by: staff.user.id,
    created_at: nowIso(),
  });
  audit(staff.actor, 'menu.import_previewed', { type: 'menu_import', id }, {
    after: { filename, rows: result.summary.rows, errors: result.summary.errors, create: result.summary.create, update_draft: result.summary.update_draft },
  });
  return { batch_id: id, rows: result.rows, errors: result.errors, summary: result.summary };
}

// ------------------------------------------------------------------ apply
interface BatchRow {
  id: string; filename: string; status: 'previewed' | 'applied' | 'discarded';
  rows_json: string; errors_json: string; summary_json: string; created_at: string;
}

function variantInputs(itemId: string | null, planned: NonNullable<ItemPlan['variants']>): VariantInput[] {
  // The CSV has no availability column: keep what staff set on existing variants.
  const current = itemId ? many<VariantRow>('SELECT * FROM item_variants WHERE item_id = ?', [itemId]) : [];
  return planned.map((v) => ({
    key: v.key,
    name_th: v.name_th,
    name_en: v.name_en,
    price_minor: v.price_minor,
    available: (current.find((c) => c.key === v.key && c.archived_at === null)?.available ?? 1) === 1,
  }));
}

function createFromPlan(plan: ItemPlan, batch: BatchRow, categoryId: string, categoryStation: Station, staff: StaffContext): void {
  const f = plan.fields;
  const now = nowIso();
  const id = newId('itm');
  const pricing = normalizePricing(f.pricing_type, f.price_minor ?? null, f.rate_minor ?? null, f.rate_basis_grams ?? null);
  const reason = `CSV import (${batch.filename})`;
  insert('menu_items', {
    id,
    key: plan.key,
    category_id: categoryId,
    sort: nextItemSort(categoryId),
    name_th: f.name_th ?? null,
    name_en: f.name_en ?? null,
    name_th_source: f.name_th ? 'csv_import' : null,
    translation_status: 'needs_review',
    desc_th: f.desc_th ?? null,
    desc_en: f.desc_en ?? null,
    desc_verified: 0,
    pricing_type: f.pricing_type,
    ...pricing,
    status: 'draft',
    review_status: 'unverified',
    demo_orderable: 0,
    notes_allowed: f.notes_allowed ?? 1,
    note_max: getSettings().menu.note_max_length,
    max_qty: f.max_qty ?? 20,
    station: f.station ?? categoryStation,
    alcohol: f.alcohol ?? 0,
    image: f.image ?? null,
    image_alt_th: f.image_alt_th ?? null,
    image_alt_en: f.image_alt_en ?? null,
    aliases_th: JSON.stringify(f.aliases_th ?? []),
    aliases_en: JSON.stringify(f.aliases_en ?? []),
    aliases_verified: 0,
    source_ref: `csv:${batch.filename} row ${plan.rows.join(',')}`,
    retrieved_at: batch.created_at,
    created_at: now,
    updated_at: now,
    updated_by: staff.user.id,
    version: 1,
  });
  if (pricing.price_minor !== null || pricing.rate_minor !== null) addPriceHistory(id, null, pricing.price_minor, pricing.rate_minor, staff.user.id, reason);
  if (plan.variants?.length) syncVariants(id, variantInputs(null, plan.variants), staff.user.id, reason);
  audit(staff.actor, 'menu.item_imported', { type: 'menu_item', id }, { after: { key: plan.key, batch_id: batch.id, action: 'create' } });
}

/** Update a draft from the plan. Returns false when nothing changed. */
function updateFromPlan(plan: ItemPlan, batch: BatchRow, item: ItemRow, categoryId: string, staff: StaffContext): boolean {
  const f = plan.fields;
  const current = item as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const set = (col: string, value: unknown) => {
    if (value !== undefined && value !== current[col]) patch[col] = value;
  };
  if (categoryId !== item.category_id) {
    patch.category_id = categoryId;
    patch.sort = nextItemSort(categoryId);
  }
  for (const col of ['name_th', 'name_en', 'desc_th', 'desc_en', 'image', 'image_alt_th', 'image_alt_en', 'station', 'alcohol', 'notes_allowed', 'max_qty'] as const) {
    set(col, f[col]);
  }
  for (const col of ['aliases_th', 'aliases_en'] as const) {
    if (f[col] !== undefined) set(col, JSON.stringify(f[col]));
  }
  // A spreadsheet is unreviewed data: imported aliases wait for a reviewer.
  if (('aliases_th' in patch || 'aliases_en' in patch) && item.aliases_verified === 1) patch.aliases_verified = 0;
  if ('name_th' in patch) {
    patch.name_th_source = patch.name_th ? 'csv_import' : null;
    patch.translation_status = 'needs_review';
  }
  if (('desc_th' in patch || 'desc_en' in patch) && item.desc_verified === 1) patch.desc_verified = 0;
  const pricing = normalizePricing(
    f.pricing_type,
    f.price_minor !== undefined ? f.price_minor : item.price_minor,
    f.rate_minor !== undefined ? f.rate_minor : item.rate_minor,
    f.rate_basis_grams !== undefined ? f.rate_basis_grams : item.rate_basis_grams,
  );
  set('pricing_type', f.pricing_type);
  set('price_minor', pricing.price_minor);
  set('rate_minor', pricing.rate_minor);
  set('rate_basis_grams', pricing.rate_basis_grams);
  const reason = `CSV import (${batch.filename})`;
  const itemPriceChanged = ['pricing_type', 'price_minor', 'rate_minor', 'rate_basis_grams'].some((k) => k in patch);
  if (itemPriceChanged) addPriceHistory(item.id, null, pricing.price_minor, pricing.rate_minor, staff.user.id, reason);

  let variantsChanged = false;
  if (plan.variants) {
    variantsChanged = syncVariants(item.id, variantInputs(item.id, plan.variants), staff.user.id, reason).changed;
  } else if (item.pricing_type === 'variant') {
    variantsChanged = run('UPDATE item_variants SET archived_at = :now WHERE item_id = :id AND archived_at IS NULL', { id: item.id, now: nowIso() }).changes > 0;
  }
  const keys = Object.keys(patch);
  if (keys.length === 0 && !variantsChanged) return false;
  // Imported data is unreviewed data (D-09).
  patch.review_status = 'unverified';
  patch.approved_at = null;
  updateVersioned('menu_items', item.id, item.version, { ...patch, updated_at: nowIso(), updated_by: staff.user.id });
  audit(staff.actor, 'menu.item_imported', { type: 'menu_item', id: item.id }, {
    before: Object.fromEntries(keys.map((k) => [k, current[k]])),
    after: { ...Object.fromEntries(keys.map((k) => [k, patch[k]])), variants_changed: variantsChanged, batch_id: batch.id, action: 'update_draft' },
  });
  return true;
}

/**
 * Apply a previewed batch: creates and draft updates only, never publishing
 * and never touching published or archived items. Idempotent: applying an
 * applied batch returns the catalog unchanged.
 */
export function applyImport(batchId: string, staff: StaffContext): AdminCatalogDTO {
  const batch = one<BatchRow>('SELECT * FROM menu_import_batches WHERE id = ?', [batchId]);
  if (!batch) throw new AppError('not_found', 'Import not found');
  if (batch.status === 'applied') return adminCatalog();
  if (batch.status !== 'previewed') throw new AppError('conflict', 'This import was discarded. Preview the file again.');
  const errors = parseJson<ImportErrorDTO[]>(batch.errors_json, []);
  if (errors.length) {
    throw new AppError('validation_failed', 'Fix the errors in the file and preview it again.', { errors: errors.slice(0, 100) });
  }
  const stored = parseJson<StoredBatch | null>(batch.rows_json, null);
  if (!stored || stored.version !== 1) throw new AppError('conflict', 'This import cannot be applied. Preview the file again.');
  const now = nowIso();
  const claimed = run(
    `UPDATE menu_import_batches SET status = 'applied', applied_at = :now, applied_by = :by WHERE id = :id AND status = 'previewed'`,
    { id: batchId, now, by: staff.user.id },
  ).changes === 1;
  if (!claimed) return adminCatalog();

  const applied = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const plan of stored.plans) {
    const cat = one<{ id: string; station: Station }>('SELECT id, station FROM menu_categories WHERE key = ?', [plan.category_key]);
    const existing = one<ItemRow>('SELECT * FROM menu_items WHERE key = ?', [plan.key]);
    if (!cat || (existing && existing.status !== 'draft')) {
      // Re-checked at apply time: something may have been published since the preview.
      applied.skipped++;
      continue;
    }
    if (!existing) {
      createFromPlan(plan, batch, cat.id, cat.station, staff);
      applied.created++;
    } else if (trackOrderability([existing.id], 'orderability', staff.actor, () => updateFromPlan(plan, batch, existing, cat.id, staff))) {
      applied.updated++;
    } else {
      applied.unchanged++;
    }
  }
  const summary = { ...parseJson<ImportSummaryDTO>(batch.summary_json, {} as ImportSummaryDTO), applied };
  run('UPDATE menu_import_batches SET summary_json = :s WHERE id = :id', { id: batchId, s: JSON.stringify(summary) });
  audit(staff.actor, 'menu.import_applied', { type: 'menu_import', id: batchId }, { after: { filename: batch.filename, ...applied } });
  if (applied.created || applied.updated) {
    emit('menu.updated', {
      audience: 'all',
      entity: { type: 'menu_import', id: batchId },
      payload: { action: 'import_applied', created: applied.created, updated: applied.updated, catalog_version: catalogVersion() },
    });
  }
  return adminCatalog();
}
