// THE money module. Every total the guest, the staff or a report sees is
// computed here, on integer minor units (satang: 1 THB = 100).
//
// Pricing policy (documented in docs/DECISIONS.md, D-07):
//  - fixed item:     unit = item.price
//  - variant item:   unit = variant.price           (never base + variant)
//  - measured cut:   amount = round_half_up(grams * rate / basis_grams), quantity 1
//  - modifiers:      unit += sum(option.delta) for options beyond a group's
//                    included_count; included options always cost 0
//  - line total:     (unit + modifiers) * quantity
//  - charges:        owner-configured only (none by default). Percent charges
//                    apply to (subtotal + adjustments), each on that same base
//                    (no compounding), rounded half-up to the satang.
//                    Exclusive charges are added; inclusive charges are shown
//                    as "includes" and not added.

export type Minor = number;

export const THB = 'THB';

export function bahtToMinor(baht: number): Minor {
  return Math.round(baht * 100);
}

export function assertMinor(value: number, what = 'amount'): Minor {
  if (!Number.isSafeInteger(value)) throw new Error(`${what} must be an integer number of satang`);
  return value;
}

/** Round a non-negative rational a/b half-up to an integer. */
export function divRoundHalfUp(a: number, b: number): number {
  if (b <= 0) throw new Error('divisor must be positive');
  const sign = a < 0 ? -1 : 1;
  const abs = Math.abs(a);
  return sign * Math.floor((abs * 2 + b) / (2 * b));
}

export function measuredAmount(grams: number, rateMinor: Minor, basisGrams: number): Minor {
  if (!Number.isInteger(grams) || grams <= 0) throw new Error('grams must be a positive integer');
  if (!Number.isInteger(basisGrams) || basisGrams <= 0) throw new Error('basis grams must be a positive integer');
  return divRoundHalfUp(grams * rateMinor, basisGrams);
}

export interface ModifierPick {
  group_id: string;
  option_ids: string[];
}

export interface PricedOption {
  id: string;
  /** Price of the option when it is NOT covered by the group's inclusion allowance. */
  price_delta_minor: Minor;
  /** Premium charged even when the option is covered (an "upgraded" included side). */
  upgrade_minor: Minor;
}

/**
 * Price the options chosen in one group.
 *
 * A group may include `includedCount` picks in the item price. Covered picks
 * pay only their `upgrade_minor`; any further picks pay `price_delta_minor`.
 * The allowance is applied to the picks where it saves the guest the most
 * (ties broken by listing order), so an included component is never charged
 * again as an add-on and the result does not depend on tap order.
 */
export function priceGroupPicks(options: PricedOption[], pickedIds: string[], includedCount: number): Minor {
  return allocateGroupPicks(options, pickedIds, includedCount).reduce((s, p) => s + p.charged_minor, 0);
}

/** Per-option charge after applying the inclusion allowance, in listing order. */
export function allocateGroupPicks(options: PricedOption[], pickedIds: string[], includedCount: number): Array<{ id: string; covered: boolean; charged_minor: Minor }> {
  const ranked = options
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => pickedIds.includes(o.id))
    .sort((a, b) => (b.o.price_delta_minor - b.o.upgrade_minor) - (a.o.price_delta_minor - a.o.upgrade_minor) || a.index - b.index);
  const covered = new Set(ranked.slice(0, Math.max(0, includedCount)).map(({ o }) => o.id));
  return ranked
    .sort((a, b) => a.index - b.index)
    .map(({ o }) => ({ id: o.id, covered: covered.has(o.id), charged_minor: covered.has(o.id) ? o.upgrade_minor : o.price_delta_minor }));
}

export function lineTotal(unitMinor: Minor, modifiersMinor: Minor, quantity: number): Minor {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('quantity must be a positive integer');
  return (unitMinor + modifiersMinor) * quantity;
}

export interface ChargeRule {
  id: string;
  label_th: string;
  label_en: string;
  kind: 'percent' | 'fixed';
  /** Percent in basis points (10% = 1000). */
  basis_points?: number;
  amount_minor?: Minor;
  inclusive: boolean;
  enabled: boolean;
  sort: number;
}

export interface ChargeLine {
  id: string;
  label_th: string;
  label_en: string;
  inclusive: boolean;
  amount_minor: Minor;
  basis_points?: number;
}

export interface BillMath {
  subtotal_minor: Minor;
  adjustments_minor: Minor;
  charges: ChargeLine[];
  charges_added_minor: Minor;
  total_minor: Minor;
}

export function computeBill(input: {
  lineTotals: Minor[];
  adjustments: Minor[];
  charges: ChargeRule[];
}): BillMath {
  const subtotal = input.lineTotals.reduce((s, v) => s + assertMinor(v, 'line total'), 0);
  const adjustments = input.adjustments.reduce((s, v) => s + assertMinor(v, 'adjustment'), 0);
  const base = Math.max(0, subtotal + adjustments);
  const charges: ChargeLine[] = [];
  let added = 0;
  for (const rule of [...input.charges].filter((c) => c.enabled).sort((a, b) => a.sort - b.sort)) {
    let amount = 0;
    if (rule.kind === 'fixed') {
      amount = assertMinor(rule.amount_minor ?? 0, 'fixed charge');
    } else {
      const bp = rule.basis_points ?? 0;
      amount = rule.inclusive
        ? base - divRoundHalfUp(base * 10000, 10000 + bp)
        : divRoundHalfUp(base * bp, 10000);
    }
    charges.push({ id: rule.id, label_th: rule.label_th, label_en: rule.label_en, inclusive: rule.inclusive, amount_minor: amount, basis_points: rule.basis_points });
    if (!rule.inclusive) added += amount;
  }
  return {
    subtotal_minor: subtotal,
    adjustments_minor: adjustments,
    charges,
    charges_added_minor: added,
    total_minor: base + added,
  };
}

/** Display: ฿1,180 or ฿1,180.50. Uses Thai digits never; Latin digits in both locales. */
export function formatMoney(minor: Minor, opts: { sign?: boolean } = {}): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const baht = Math.floor(abs / 100);
  const satang = abs % 100;
  const whole = baht.toLocaleString('en-US');
  const body = satang ? `${whole}.${String(satang).padStart(2, '0')}` : whole;
  const sign = neg ? '−' : opts.sign ? '+' : '';
  return `${sign}฿${body}`;
}
