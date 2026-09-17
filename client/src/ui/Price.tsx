// Price and the leader line, the system's signature (DESIGN §4.2, §9).
import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { money } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';

export type PriceSize = 'sm' | 'md' | 'total' | 'xl' | 'lg';

export interface PriceProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Integer satang. null/undefined shows the pending text (never a zero). */
  minor: number | null | undefined;
  /** sm 17 · md 20 (default) · total 22 · xl 24 · lg 26 (sheet) */
  size?: PriceSize;
  /** Always shown for by-weight prices: "ต่อ 100 กรัม". */
  unit?: ReactNode;
  /** Stack the unit under the amount, right-aligned (DishRow). */
  stackUnit?: boolean;
  /** Prefix + for positive amounts (option price effects). */
  sign?: boolean;
  /** Text when the amount is unknown. Default "รอยืนยันราคา". */
  pending?: ReactNode;
  /** Omit the base .price class (for .btn__price). */
  plain?: boolean;
  as?: 'span' | 'p' | 'dd' | 'data' | 'strong';
}

/** "<span class=baht>฿</span>590": the baht sign renders from Noto Sans Thai before the Oswald number. Never struck through. */
export const Price = forwardRef<HTMLElement, PriceProps>(function Price(
  { minor, size, unit, stackUnit, sign, pending, plain, as = 'span', className, ...rest },
  ref,
) {
  const { t } = useI18n();
  if (minor === null || minor === undefined || !Number.isFinite(minor)) {
    return createElement(as, { ref, className: cx(!plain && 'price', 'is-pending', className), ...rest }, pending ?? t('common.pricePending'));
  }
  const text = money(minor, { sign });
  const at = text.indexOf('฿');
  const lead = at > 0 ? text.slice(0, at) : '';
  const digits = at >= 0 ? text.slice(at + 1) : text;
  const amount = (
    <>
      {lead}<span className="baht">฿</span>{digits}
    </>
  );
  if (unit && stackUnit) {
    return createElement(
      as,
      { ref, className: cx('lead__val--unit', className), ...rest },
      <span className={cx(!plain && 'price', size && `price--${size}`)}>{amount}</span>,
      <span className="price-unit">{unit}</span>,
    );
  }
  return createElement(
    as,
    { ref, className: cx(!plain && 'price', size && `price--${size}`, className), ...rest },
    amount,
    unit ? <span className="price-unit">{unit}</span> : null,
  );
});

export interface LeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  label: ReactNode;
  /** No value, no leader (DESIGN §9). */
  value?: ReactNode;
  as?: 'div' | 'li' | 'p';
  /** dt/dd pair inside a <dl> */
  definition?: boolean;
  labelAs?: 'span' | 'h3' | 'h4' | 'p' | 'dt';
  valueAs?: 'span' | 'p' | 'time' | 'dd';
  labelId?: string;
  labelClassName?: string;
  valueClassName?: string;
  /** Emphasised row (16/600), e.g. running totals. */
  strong?: boolean;
}

/**
 * label ··· value. Flex on the FIRST baseline so a wrapping Thai label keeps
 * the value on line one. The dots are decorative and aria-hidden.
 */
export const Leader = forwardRef<HTMLElement, LeaderProps>(function Leader(
  { label, value, as = 'div', definition, labelAs, valueAs, labelId, labelClassName, valueClassName, strong, className, ...rest },
  ref,
) {
  const L = labelAs ?? (definition ? 'dt' : 'span');
  const V = valueAs ?? (definition ? 'dd' : 'span');
  const hasValue = value !== undefined && value !== null && value !== false && value !== '';
  return createElement(
    as,
    { ref, className: cx('lead', strong && 'lead--strong', className), ...rest },
    createElement(L, { id: labelId, className: labelClassName }, label),
    hasValue ? <span className="lead__dots" aria-hidden="true" /> : null,
    hasValue ? createElement(V, { className: cx('lead__val', valueClassName) }, value) : null,
  );
});
