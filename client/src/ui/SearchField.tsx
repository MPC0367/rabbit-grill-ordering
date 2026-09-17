// SearchField (DESIGN §10.5). Thai IME safe: while a composition is in
// progress the field updates locally and `onChange` waits for the committed
// text, so a list never filters on half-typed syllables.
import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { cx, mergeRefs } from './cx.ts';
import { Icon } from './Icon.tsx';
import { IconButton } from './Button.tsx';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size' | 'type'> {
  value: string;
  /** Committed text (never mid-composition). Normalise with normalizeSearch() before matching. */
  onChange: (value: string) => void;
  /** Visually hidden label that states the scope ("ค้นหาเมนู ไทย หรือ English"). */
  label?: string;
  /** md 44 (guest) · staff 48 */
  size?: 'md' | 'staff';
  onClear?: () => void;
  clearLabel?: string;
  /** Polite result count under the field ("พบ 3 รายการ"). Pass null to render nothing. */
  status?: ReactNode;
  statusHidden?: boolean;
  className?: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, label, size = 'md', onClear, clearLabel, placeholder, status, statusHidden = true, className, style, id, onKeyDown, ...rest },
  ref,
) {
  const { t } = useI18n();
  const auto = useId();
  const inputId = id ?? `s${auto.replace(/:/g, '')}`;
  const input = useRef<HTMLInputElement | null>(null);
  const composing = useRef(false);
  const [draft, setDraft] = useState(value);

  // Follow the controlled value unless the user is mid-composition.
  useEffect(() => {
    if (!composing.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next !== value) onChange(next);
  };

  const clear = () => {
    setDraft('');
    commit('');
    onClear?.();
    input.current?.focus();
  };

  return (
    <div className={cx('search', size === 'staff' && 'search--staff', draft !== '' && 'has-value', className)} style={style} role="search">
      <label className="visually-hidden" htmlFor={inputId}>{label ?? t('common.searchScope')}</label>
      <Icon name="search" />
      <input
        ref={mergeRefs(ref, input)}
        id={inputId}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder ?? t('common.searchMenu')}
        value={draft}
        aria-describedby={status !== undefined && status !== null ? `${inputId}-status` : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          const native = e.nativeEvent as InputEvent;
          if (!composing.current && !native.isComposing) commit(next);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => {
          composing.current = false;
          const next = e.currentTarget.value;
          setDraft(next);
          commit(next);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Escape' && draft !== '' && !composing.current) {
            e.preventDefault();
            e.stopPropagation();
            clear();
          }
        }}
        {...rest}
      />
      {draft !== '' ? (
        <IconButton
          className="search__clear"
          icon="x"
          label={clearLabel ?? t('common.clearSearch')}
          size={size === 'staff' ? 'staff' : 'md'}
          onClick={clear}
        />
      ) : null}
      {status !== undefined && status !== null ? (
        <p id={`${inputId}-status`} role="status" className={statusHidden ? 'visually-hidden' : 'search__status'}>{status}</p>
      ) : null}
    </div>
  );
});
