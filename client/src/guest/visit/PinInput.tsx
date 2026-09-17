// Four digit boxes drawn over ONE real input: numeric keyboard, one-time-code
// autofill, paste of "8 3 7 1" or "8371", Backspace, screen readers hear a
// single labelled field. Local to stream C2 (the kit has no code field).
import { forwardRef, useId, type ClipboardEvent } from 'react';
import { cx } from '../../ui/index.ts';

export interface PinInputProps {
  value: string;
  onChange: (digits: string) => void;
  /** Called once when the last digit arrives. */
  onComplete?: (digits: string) => void;
  length?: number;
  label: string;
  /** id of the element with the error / hint text. */
  describedBy?: string;
  error?: boolean;
  disabled?: boolean;
}

export const PinInput = forwardRef<HTMLInputElement, PinInputProps>(function PinInput(
  { value, onChange, onComplete, length = 4, label, describedBy, error, disabled },
  ref,
) {
  const id = useId();
  const digits = value.replace(/\D/g, '').slice(0, length);
  const active = Math.min(digits.length, length - 1);

  const accept = (raw: string) => {
    const next = raw.replace(/\D/g, '').slice(0, length);
    if (next === digits) return;
    onChange(next);
    if (next.length === length && digits.length < length) onComplete?.(next);
  };

  return (
    <div className={cx('vpin', error && 'is-error', disabled && 'is-disabled')}>
      {Array.from({ length }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cx('vpin__box', i < digits.length && 'is-filled', i === active && !disabled && 'is-active')}
        >
          {digits[i] ?? ''}
        </span>
      ))}
      <input
        ref={ref}
        id={id}
        className="vpin__input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        enterKeyHint="go"
        maxLength={length}
        spellCheck={false}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        value={digits}
        disabled={disabled}
        onChange={(e) => accept(e.target.value)}
        onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
          const text = e.clipboardData.getData('text');
          if (!text) return;
          e.preventDefault();
          accept(text);
        }}
        onFocus={(e) => {
          // Keep the caret at the end: boxes fill left to right.
          const el = e.currentTarget;
          requestAnimationFrame(() => {
            try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* type without selection */ }
          });
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          if (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length) {
            try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ }
          }
        }}
      />
    </div>
  );
});
