// Staff-assisted draft for one visit, persisted on this device so a closed
// panel or a reload keeps the lines and, above all, the attempt key of a
// submission whose answer never arrived (brief 13, 22).
import { useCallback, useEffect, useState } from 'react';
import type { MenuItemDTO } from '../../../../../shared/dto.ts';
import { allocateGroupPicks, measuredAmount } from '../../../../../shared/money.ts';
import type { RecoverLineInput } from '../../../../../shared/schemas.ts';
import { storage } from '../../../lib/store.ts';

export interface DraftLine {
  uid: string;
  item_id: string;
  variant_id: string | null;
  quantity: number;
  modifiers: Array<{ group_id: string; option_ids: string[] }>;
  note: string;
  allergy_note: boolean;
  /**
   * Paper recovery only (D-S8-21): the weight staff wrote on the ticket for a
   * dish sold by weight. One cut is one line, so the quantity stays 1 and two
   * cuts never stack.
   */
  measured_grams?: number | null;
}

export interface RecoverFields {
  reference: string;
  time: string;
  already: 'none' | 'prepared' | 'served' | '';
  reason: string;
}

export interface Draft {
  lines: DraftLine[];
  /** Attempt key of the last submission that may have reached the server. */
  key: string | null;
  /** The request body the key was used with (a retry must send exactly this). */
  sentLines: DraftLine[] | null;
  /** The subtotal the first attempt expected (sent again on retry). */
  sentSubtotal: number | null;
  recover: RecoverFields;
  savedAt: number;
}

const EMPTY_RECOVER: RecoverFields = { reference: '', time: '', already: '', reason: '' };
const MAX_AGE_MS = 12 * 3_600_000;

function storageKey(mode: 'assist' | 'recover', visitId: string): string {
  return `rg.orders.draft.${mode}.${visitId}`;
}

function empty(): Draft {
  return { lines: [], key: null, sentLines: null, sentSubtotal: null, recover: { ...EMPTY_RECOVER }, savedAt: Date.now() };
}

function load(mode: 'assist' | 'recover', visitId: string): Draft {
  const d = storage.get<Draft | null>(storageKey(mode, visitId), null);
  if (!d || !Array.isArray(d.lines)) return empty();
  // An old draft with no pending attempt is not worth restoring.
  if (!d.key && Date.now() - (d.savedAt ?? 0) > MAX_AGE_MS) return empty();
  return { ...empty(), ...d, recover: { ...EMPTY_RECOVER, ...(d.recover ?? {}) } };
}

export function useDraft(mode: 'assist' | 'recover', visitId: string) {
  const [draft, setDraft] = useState<Draft>(() => load(mode, visitId));

  useEffect(() => { setDraft(load(mode, visitId)); }, [mode, visitId]);

  const update = useCallback((fn: (d: Draft) => Draft) => {
    setDraft((prev) => {
      const next = { ...fn(prev), savedAt: Date.now() };
      if (next.lines.length === 0 && !next.key && !next.recover.reference && !next.recover.reason) storage.remove(storageKey(mode, visitId));
      else storage.set(storageKey(mode, visitId), next);
      return next;
    });
  }, [mode, visitId]);

  const clear = useCallback(() => {
    storage.remove(storageKey(mode, visitId));
    setDraft(empty());
  }, [mode, visitId]);

  return { draft, update, clear };
}

export function newUid(): string {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Same dish with the same choices and note: stack quantities instead of adding a row. */
export function sameLine(a: Omit<DraftLine, 'uid' | 'quantity'>, b: Omit<DraftLine, 'uid' | 'quantity'>): boolean {
  // Two weighed cuts are two cuts, whatever they weigh: they never stack.
  if (a.measured_grams != null || b.measured_grams != null) return false;
  const mods = (m: DraftLine['modifiers']) => JSON.stringify([...m].map((g) => ({ g: g.group_id, o: [...g.option_ids].sort() })).sort((x, y) => x.g.localeCompare(y.g)));
  return a.item_id === b.item_id && a.variant_id === b.variant_id && a.note.trim() === b.note.trim()
    && a.allergy_note === b.allergy_note && mods(a.modifiers) === mods(b.modifiers);
}

/** Price per unit as this device sees it (base or variant price plus charged choices). */
export function unitPrice(item: MenuItemDTO | undefined, line: Pick<DraftLine, 'variant_id' | 'modifiers' | 'measured_grams'>): number | null {
  if (!item) return null;
  // A weighed cut from a paper ticket: grams at the dish's approved rate, the
  // same arithmetic the server uses (shared/money.ts).
  if (line.measured_grams != null) {
    if (item.rate_minor === null || item.rate_basis_grams === null) return null;
    return measuredAmount(line.measured_grams, item.rate_minor, item.rate_basis_grams);
  }
  let base: number | null = item.price_minor;
  if (item.variants.length > 0) base = item.variants.find((v) => v.id === line.variant_id)?.price_minor ?? null;
  if (base === null) return null;
  let mods = 0;
  for (const g of item.modifier_groups) {
    const picked = line.modifiers.find((m) => m.group_id === g.id)?.option_ids ?? [];
    mods += allocateGroupPicks(g.options, picked, g.included_count).reduce((s, p) => s + p.charged_minor, 0);
  }
  return base + mods;
}

export function toInput(line: DraftLine, item: MenuItemDTO | undefined): RecoverLineInput {
  const weighed = line.measured_grams != null;
  const unit = unitPrice(item, line);
  return {
    item_id: line.item_id,
    variant_id: line.variant_id,
    quantity: weighed ? 1 : line.quantity,
    modifiers: line.modifiers.filter((m) => m.option_ids.length > 0),
    note: line.note.trim() || null,
    allergy_note: line.allergy_note || null,
    // A weighed cut has no price the picker could have shown, so there is
    // nothing for the server to compare against.
    expected_unit_minor: weighed ? null : unit,
    ...(weighed ? { measured: { grams: line.measured_grams! } } : {}),
  };
}
