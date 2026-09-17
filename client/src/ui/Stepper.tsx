// Stepper (DESIGN §10.8). Tinted (in your order) or plain (sheet footer).
// At the minimum, "−" either removes the line (DishRow) or is disabled (sheet).
// At the maximum, "+" is disabled and a polite status says why.
import { forwardRef, useEffect, useState, type HTMLAttributes } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';

export interface StepperProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** Group label, names the dish: "จำนวน ซี่โครงหมูย่าง ในรายการ". */
  label: string;
  /** tint = in-your-order (forest tint) · plain = bone + edge (sheet footer) */
  variant?: 'tint' | 'plain';
  /** md 44 · lg 52 */
  size?: 'md' | 'lg';
  /** At the minimum, "−" calls onRemove instead of being disabled. */
  onRemove?: () => void;
  disabled?: boolean;
  decrementLabel?: string;
  incrementLabel?: string;
  removeLabel?: string;
}

export const Stepper = forwardRef<HTMLDivElement, StepperProps>(function Stepper(
  { value, onChange, min = 1, max = 99, label, variant = 'tint', size = 'md', onRemove, disabled, decrementLabel, incrementLabel, removeLabel, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const atMin = value <= min;
  const atMax = value >= max;
  const removes = atMin && Boolean(onRemove);
  const [notice, setNotice] = useState('');
  useEffect(() => { if (!atMax) setNotice(''); }, [atMax]);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cx('stepper', variant === 'plain' && 'stepper--plain', size === 'lg' && 'stepper--lg', className)}
      {...rest}
    >
      <button
        type="button"
        aria-label={removes ? (removeLabel ?? t('common.removeLine')) : (decrementLabel ?? t('common.decrease'))}
        disabled={disabled || (atMin && !removes)}
        onClick={() => {
          if (removes) onRemove?.();
          else if (!atMin) onChange(value - 1);
        }}
      >
        <Icon name="minus" />
      </button>
      <output aria-live="polite" aria-atomic="true">{value}</output>
      <button
        type="button"
        aria-label={incrementLabel ?? t('common.increase')}
        aria-disabled={disabled || atMax ? true : undefined}
        disabled={disabled}
        onClick={() => {
          if (atMax) { setNotice(t('common.maxQty', { n: max })); return; }
          onChange(value + 1);
        }}
      >
        <Icon name="plus" />
      </button>
      <span className="visually-hidden" role="status">{atMax ? notice || t('common.maxQty', { n: max }) : ''}</span>
    </div>
  );
});
