// Staff toolbar controls (DESIGN.md §10.30 toolbar): one 48px row style.
// FilterChips (joined, pressed = ink), SelectButton (native select dressed as
// "Table All ⌄"), CheckButton, StaffSearch, and the staff segmented switch.
import { forwardRef, useId, type ChangeEvent, type HTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { IconButton } from '../Button.tsx';
import { cx, Ico, roveIndex, roveKeys, safeId, type AdminIconName } from './parts.tsx';

export type TableSwatch = 'avail' | 'dining' | 'bill' | 'off';

export interface ChipOption<V extends string = string> {
  value: V;
  label: ReactNode;
  count?: number;
  swatch?: TableSwatch;
  lang?: string;
  ariaLabel?: string;
}

export interface FilterChipsProps<V extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: ReadonlyArray<ChipOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Group name read by screen readers ("Station"). */
  label: string;
}

/** Joined single-choice chips. Arrow keys move focus; Enter/Space choose. */
export function FilterChips<V extends string>({ options, value, onChange, label, className, ...rest }: FilterChipsProps<V>) {
  const active = options.findIndex((o) => o.value === value);
  return (
    <div {...rest} className={cx('fchips', className)} role="group" aria-label={label} onKeyDown={(e) => roveKeys(e)}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          data-rove=""
          tabIndex={roveIndex(i, active)}
          aria-pressed={o.value === value}
          aria-label={o.ariaLabel}
          lang={o.lang}
          onClick={() => onChange(o.value)}
        >
          {o.swatch ? <i className={cx('sw', `sw--${o.swatch}`)} aria-hidden="true" /> : null}
          {o.label}
          {o.count != null ? <span className="count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface SelectButtonProps<V extends string> {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  icon?: AdminIconName;
  disabled?: boolean;
  className?: string;
}

/** "Table  All ⌄": a native select (keyboard, screen reader and touch friendly) dressed as a toolbar button. */
export function SelectButton<V extends string>({ label, value, options, onChange, icon, disabled, className }: SelectButtonProps<V>) {
  const current = options.find((o) => o.value === value)?.label ?? '';
  return (
    <label className={cx('selectbtn selectfield', disabled && 'is-disabled', className)}>
      {icon ? <Ico name={icon} className="selectfield__icon" /> : null}
      <span className="selectfield__k">{label}</span>
      <b aria-hidden="true">{current}</b>
      <Ico name="chev-d" />
      <select
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as V)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export interface CheckButtonProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onChange'> {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  count?: number;
}

/** Toggle with a visible box: "☐ Show rejected · cancelled". */
export function CheckButton({ label, checked, onChange, count, className, ...rest }: CheckButtonProps) {
  return (
    <button {...rest} type="button" className={cx('checkbtn', className)} aria-pressed={checked} onClick={() => onChange(!checked)}>
      <span className="box" aria-hidden="true">{checked ? <Ico name="check" size="xs" /> : null}</span>
      {label}
      {count != null ? <b className="checkbtn__count">{count}</b> : null}
    </button>
  );
}

export interface StaffSearchProps {
  /** Visually hidden label that states the scope. */
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  className?: string;
  id?: string;
}

/** 48px staff search with a 44px clear button once there is a value. */
export const StaffSearch = forwardRef<HTMLInputElement, StaffSearchProps>(function StaffSearch(
  { label, placeholder, value, onChange, onSubmit, className, id },
  ref,
) {
  const { t } = useI18n();
  const auto = safeId(useId());
  const inputId = id ?? `ss-${auto}`;
  return (
    <div className={cx('search search--staff', value && 'has-value', className)} role="search">
      <label className="sr" htmlFor={inputId}>{label}</label>
      <Ico name="search" />
      <input
        ref={ref}
        id={inputId}
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit?.(value);
          if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); }
        }}
      />
      {value ? (
        <IconButton className="search__clear" size="staff" icon="x" iconSize="sm" label={t('common.staff.clearSearch')} onClick={() => onChange('')} />
      ) : null}
    </div>
  );
});
