// Digit boxes drawn over ONE real input: numeric keyboard, one-time-code
// autofill, paste of "8 3 7 1" or "8371", Backspace, screen readers hear a
// single labelled field. Local to stream C2 (the kit has no code field).
//
// The restaurant sets the code length (4 to 8 digits, Settings > Joining).
// With a known `length` the boxes match it and the last digit submits. When
// the length is unknown (`length` null) the field takes up to `maxLength`
// digits, grows a box per digit past `minLength`, and never submits by itself.
import { forwardRef, useId, type CSSProperties, type ClipboardEvent } from 'react';
import { cx } from '../../ui/index.ts';

export const PIN_MIN = 4;
export const PIN_MAX = 8;

export interface PinInputProps {
  value: string;
  onChange: (digits: string) => void;
  /** Called once when the last digit arrives (known length only). */
  onComplete?: (digits: string) => void;
  /** Exact code length, or null when the length is not known. */
  length?: number | null;
  label: string;
  /** id of the element with the error / hint text. */
  describedBy?: string;
  error?: boolean;
  disabled?: boolean;
}

export const PinInput = forwardRef<HTMLInputElement, PinInputProps>(function PinInput(
  { value, onChange, onComplete, length = PIN_MIN, label, describedBy, error, disabled },
  ref,
) {
  const id = useId();
  const fixed = typeof length === 'number' && length > 0 ? length : null;
  const max = fixed ?? PIN_MAX;
  const digits = value.replace(/\D/g, '').slice(0, max);
  const boxes = fixed ?? Math.min(PIN_MAX, Math.max(PIN_MIN, digits.length));
  const active = Math.min(digits.length, boxes - 1);

  const accept = (raw: string) => {
    const next = raw.replace(/\D/g, '').slice(0, max);
    if (next === digits) return;
    onChange(next);
    if (fixed && next.length === fixed && digits.length < fixed) onComplete?.(next);
  };

  return (
    <div
      className={cx('vpin', boxes > PIN_MIN && 'vpin--long', error && 'is-error', disabled && 'is-disabled')}
      style={{ '--pin-n': boxes } as CSSProperties}
      data-length={fixed ?? 'any'}
    >
      {Array.from({ length: boxes }, (_, i) => (
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
        maxLength={max}
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
