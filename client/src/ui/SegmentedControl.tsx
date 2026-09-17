// SegmentedControl (DESIGN §10.3): a labelled group of aria-pressed buttons
// with a roving tabindex. tone="paper" is the bone-thumb control on a sunken
// track (Food/Drinks, Week/Month/Year); tone="box" is the framed square
// (language, dense admin toggles).
import { forwardRef, useRef, type ReactElement, type ReactNode, type Ref } from 'react';
import { cx } from './cx.ts';
import { rovingKeyDown } from './hooks.ts';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Oswald count after the label (board status on tablet). */
  count?: number;
  /** Set lang="en" on Latin labels so tracking applies. */
  lang?: string;
  /** Accessible name when the label is not text. */
  ariaLabel?: string;
  /** Work is waiting in this segment: the count turns into an ink chip (board "New · 3"). */
  emphasis?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Group label (aria-label). */
  label: string;
  tone?: 'paper' | 'box';
  /** md: 38 visible / 44 hit · staff: 42 / 48 */
  size?: 'md' | 'staff';
  /** Stretch to the container width. */
  block?: boolean;
  className?: string;
  id?: string;
}

function SegmentedControlInner<T extends string>(
  { options, value, onChange, label, tone = 'paper', size = 'md', block, className, id }: SegmentedControlProps<T>,
  ref: Ref<HTMLDivElement>,
) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label={label}
      className={cx('seg', tone === 'box' && 'seg--box', size === 'staff' && 'seg--staff', block && 'seg--block', className)}
      onKeyDown={(e) => {
        const next = rovingKeyDown(e, buttons.current, current);
        if (next !== null && options[next].value !== value) onChange(options[next].value);
      }}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { buttons.current[i] = el; }}
          type="button"
          lang={o.lang}
          className={o.emphasis ? 'is-attn' : undefined}
          aria-pressed={o.value === value}
          aria-label={o.ariaLabel}
          tabIndex={i === current ? 0 : -1}
          disabled={o.disabled}
          onClick={() => { if (o.value !== value) onChange(o.value); }}
        >
          {o.label}
          {o.count !== undefined ? <span className="count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export const SegmentedControl = forwardRef(SegmentedControlInner) as <T extends string>(
  props: SegmentedControlProps<T> & { ref?: Ref<HTMLDivElement> },
) => ReactElement;
