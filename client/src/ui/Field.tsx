// Form fields (DESIGN §10.9, §10.7 choice groups): TextField, TextArea with
// a counter, Select, Checkbox, Switch, RadioCard, ChoiceGroup, RequiredPill.
// Inputs are 16px (no iOS zoom), 44px tall (staff 48), bone on an edge border.
import {
  forwardRef, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type FieldsetHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { clampText, cx, mergeRefs, textLength, type LengthMeasure } from './cx.ts';
import { Icon } from './Icon.tsx';
import { Tag } from './Badge.tsx';

export interface FieldShellProps {
  label: ReactNode;
  /** true shows "ไม่บังคับ"; a node replaces the wording. */
  optional?: boolean | ReactNode;
  help?: ReactNode;
  /** Message below the field; also sets aria-invalid. */
  error?: ReactNode;
  /** guest: 17/600 label, 44px · staff: 15/600 label, 48px */
  density?: 'guest' | 'staff';
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  className?: string;
}

function useFieldIds(id?: string) {
  const auto = useId();
  const base = id ?? `f${auto.replace(/:/g, '')}`;
  return { input: base, help: `${base}-help`, error: `${base}-error`, count: `${base}-count` };
}

function FieldLabel({ htmlFor, label, optional, as = 'label' }: { htmlFor?: string; label: ReactNode; optional?: boolean | ReactNode; as?: 'label' | 'span' }) {
  const { t } = useI18n();
  const Tagname = as;
  return (
    <Tagname className="field__label" htmlFor={as === 'label' ? htmlFor : undefined}>
      {label}
      {optional ? <small>{optional === true ? t('common.optional') : optional}</small> : null}
    </Tagname>
  );
}

function FieldMessages({ ids, help, error }: { ids: ReturnType<typeof useFieldIds>; help?: ReactNode; error?: ReactNode }) {
  return (
    <>
      {error ? (
        <p className="field__error" id={ids.error}>
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      ) : null}
      {help ? <p className="field__help" id={ids.help}>{help}</p> : null}
    </>
  );
}

function describedBy(ids: ReturnType<typeof useFieldIds>, help: ReactNode, error: ReactNode, extra?: string, own?: string) {
  return [error ? ids.error : null, extra, help ? ids.help : null, own].filter(Boolean).join(' ') || undefined;
}

function shellClass(density: 'guest' | 'staff' | undefined, error: ReactNode, hideLabel: boolean | undefined, className?: string) {
  return cx('field', density === 'staff' && 'field--staff', Boolean(error) && 'field--error', hideLabel && 'field--hidden-label', className);
}

// ---------------------------------------------------------------- TextField
export interface TextFieldProps extends FieldShellProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** Text inside the box before the value (e.g. ฿). */
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, optional, help, error, density, hideLabel, className, id, prefix, suffix, style, type = 'text', 'aria-describedby': ownDescribed, ...rest },
  ref,
) {
  const ids = useFieldIds(id);
  return (
    <div className={shellClass(density, error, hideLabel, className)} style={style}>
      <FieldLabel htmlFor={ids.input} label={label} optional={optional} />
      <div className="field__box">
        {prefix ? <span className="field__affix field__affix--start" aria-hidden="true">{prefix}</span> : null}
        <input
          ref={ref}
          id={ids.input}
          type={type}
          className="field__input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, help, error, undefined, ownDescribed)}
          style={{ paddingLeft: prefix ? 36 : undefined, paddingRight: suffix ? 48 : undefined }}
          {...rest}
        />
        {suffix ? <span className="field__affix field__affix--end">{suffix}</span> : null}
      </div>
      <FieldMessages ids={ids} help={help} error={error} />
    </div>
  );
});

// ---------------------------------------------------------------- TextArea
export interface TextAreaProps extends FieldShellProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'maxLength' | 'defaultValue'> {
  value: string;
  onChange: (value: string) => void;
  /** Enforced limit; typing past it is cut at a grapheme boundary. */
  limit?: number;
  /** codepoint (default; matches the server's note check) or grapheme. */
  measure?: LengthMeasure;
  /** Show the "14 / 120" counter (default when a limit is set). */
  showCount?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, optional, help, error, density, hideLabel, className, id, value, onChange, limit, measure = 'codepoint', showCount, style, onCompositionStart, onCompositionEnd, 'aria-describedby': ownDescribed, ...rest },
  ref,
) {
  const { t } = useI18n();
  const ids = useFieldIds(id);
  const composing = useRef(false);
  const used = textLength(value, measure);
  const counted = limit !== undefined && (showCount ?? true);

  // Announce only at three thresholds (limit-20, limit-10, limit), never per keystroke.
  const [announce, setAnnounce] = useState('');
  const lastBand = useRef(-1);
  useEffect(() => {
    if (!limit) return;
    const marks = [limit - 20, limit - 10, limit].filter((m) => m > 0);
    const band = marks.filter((m) => used >= m).length;
    if (band > lastBand.current && band > 0 && lastBand.current !== -1) {
      setAnnounce(used >= limit ? t('common.charLimit', { max: limit }) : t('common.charsLeft', { n: limit - used }));
    }
    lastBand.current = band;
  }, [used, limit, t]);

  const commit = (next: string) => {
    onChange(limit !== undefined && !composing.current ? clampText(next, limit, measure) : next);
  };

  return (
    <div className={shellClass(density, error, hideLabel, className)} style={style}>
      <FieldLabel htmlFor={ids.input} label={label} optional={optional} />
      <div className="field__box">
        <textarea
          ref={ref}
          id={ids.input}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, help, error, counted ? ids.count : undefined, ownDescribed)}
          onChange={(e) => commit(e.target.value)}
          onCompositionStart={(e) => { composing.current = true; onCompositionStart?.(e); }}
          onCompositionEnd={(e) => { composing.current = false; commit(e.currentTarget.value); onCompositionEnd?.(e); }}
          style={counted ? undefined : { paddingBottom: 12 }}
          {...rest}
        />
        {counted ? (
          <span className={cx('field__count', used >= limit! && 'is-full')} id={ids.count}>
            {used} / {limit}
          </span>
        ) : null}
      </div>
      <FieldMessages ids={ids} help={help} error={error} />
      <span className="visually-hidden" aria-live="polite">{announce}</span>
    </div>
  );
});

// ---------------------------------------------------------------- Select
/**
 * `lang` marks a label that is not in the interface language - a Thai dish
 * name listed in an English filter, or the reverse - so screen readers
 * pronounce it correctly (DESIGN.md section 12).
 */
export interface SelectOption { value: string; label: string; disabled?: boolean; lang?: 'th' | 'en' }

export interface SelectProps extends FieldShellProps, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options?: ReadonlyArray<SelectOption>;
  /** Disabled first option shown while nothing is chosen. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, optional, help, error, density, hideLabel, className, id, options, placeholder, children, style, 'aria-describedby': ownDescribed, ...rest },
  ref,
) {
  const ids = useFieldIds(id);
  return (
    <div className={shellClass(density, error, hideLabel, className)} style={style}>
      <FieldLabel htmlFor={ids.input} label={label} optional={optional} />
      <div className="select">
        <select
          ref={ref}
          id={ids.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, help, error, undefined, ownDescribed)}
          {...rest}
        >
          {placeholder ? <option value="" disabled>{placeholder}</option> : null}
          {options?.map((o) => <option key={o.value} value={o.value} disabled={o.disabled} lang={o.lang}>{o.label}</option>)}
          {children}
        </select>
        <Icon name="chev-d" />
      </div>
      <FieldMessages ids={ids} help={help} error={error} />
    </div>
  );
});

// ---------------------------------------------------------------- Checkbox
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, style, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `cb${auto.replace(/:/g, '')}`;
  return (
    <label className={cx('check', className)} style={style} htmlFor={inputId}>
      <span className="check__box">
        <input ref={ref} id={inputId} type="checkbox" className="check__input" aria-describedby={description ? `${inputId}-d` : undefined} {...rest} />
        <Icon name="check" />
      </span>
      <span className="check__text">
        <span>{label}</span>
        {description ? <span className="check__desc" id={`${inputId}-d`}>{description}</span> : null}
      </span>
    </label>
  );
});

// ---------------------------------------------------------------- Switch
export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value' | 'role'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  /** Show the state in words beside the switch (default true). */
  showState?: boolean;
  onLabel?: ReactNode;
  offLabel?: ReactNode;
  density?: 'guest' | 'staff';
}

/** A square-framed switch (no pill radius). State is shape + position + words. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, showState = true, onLabel, offLabel, density, className, onClick, ...rest },
  ref,
) {
  const { t } = useI18n();
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx('switch', density === 'staff' && 'switch--staff', className)}
      onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) onChange(!checked); }}
      {...rest}
    >
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb"><Icon name="check" /></span>
      </span>
      <span>{label}</span>
      {showState ? <span className="switch__state">{checked ? (onLabel ?? t('common.on')) : (offLabel ?? t('common.off'))}</span> : null}
    </button>
  );
});

// ---------------------------------------------------------------- RadioCard
export interface RadioCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
  /** Right-hand price effect: "รวมในราคา", "+฿40". No leader. */
  aside?: ReactNode;
  type?: 'radio' | 'checkbox';
  /** Taller row that top-aligns the control (for descriptions). */
  card?: boolean;
}

/** 52px option row. Selected = forest tint fill + 2px forest edge + 600 label. */
export const RadioCard = forwardRef<HTMLInputElement, RadioCardProps>(function RadioCard(
  { label, description, aside, type = 'radio', card, className, style, disabled, ...rest },
  ref,
) {
  const { t } = useI18n();
  return (
    <label className={cx('opt', Boolean(card || description) && 'opt--card', className)} style={style}>
      <input ref={ref} type={type} disabled={disabled} {...rest} />
      <span className="opt__label">
        {label}
        {description ? <span className="opt__desc">{description}</span> : null}
      </span>
      {disabled && aside === undefined ? <span className="opt__val">{t('common.optionOut')}</span> : aside !== undefined ? <span className="opt__val">{aside}</span> : null}
    </label>
  );
});

// ---------------------------------------------------------------- RequiredPill
export function RequiredPill({ met, className }: { met: boolean; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx('reqpill', met && 'is-met', className)}>
      {met ? <Icon name="check" /> : null}
      {met ? t('common.chosen') : t('common.required')}
    </span>
  );
}

// ---------------------------------------------------------------- ChoiceGroup
export interface ChoiceGroupProps extends Omit<FieldsetHTMLAttributes<HTMLFieldSetElement>, 'children'> {
  legend: ReactNode;
  /** Placeholder configuration: shows the dashed ตัวอย่าง / Example tag (mandatory). */
  example?: boolean;
  /** Shows the required pill; `satisfied` flips it to ✓ เลือกแล้ว. */
  required?: boolean;
  satisfied?: boolean;
  /** "จำเป็น · เลือก 1 อย่าง", "เลือกได้สูงสุด 2" */
  rule?: ReactNode;
  /** Inline oxblood error (the footer should also name what is missing). */
  error?: ReactNode;
  /** Focus target for a missing required choice. */
  legendRef?: Ref<HTMLElement>;
  children: ReactNode;
}

export const ChoiceGroup = forwardRef<HTMLFieldSetElement, ChoiceGroupProps>(function ChoiceGroup(
  { legend, example, required, satisfied, rule, error, legendRef, className, children, id, ...rest },
  ref,
) {
  const auto = useId();
  const base = id ?? `cg${auto.replace(/:/g, '')}`;
  const legendEl = useRef<HTMLElement | null>(null);
  return (
    <fieldset
      ref={ref}
      id={id}
      className={cx('choice', Boolean(error) && 'is-invalid', className)}
      aria-describedby={[rule ? `${base}-rule` : null, error ? `${base}-err` : null].filter(Boolean).join(' ') || undefined}
      {...rest}
    >
      <legend className="choice__head" ref={mergeRefs(legendRef, legendEl)} tabIndex={-1}>
        <span className="choice__legend">
          {legend}
          {example ? <Tag tone="example" /> : null}
        </span>
        {required ? <RequiredPill met={Boolean(satisfied)} /> : null}
      </legend>
      {rule ? <p className="choice__rule" id={`${base}-rule`}>{rule}</p> : null}
      <div className="opts">{children}</div>
      {error ? (
        <p className="choice__error" id={`${base}-err`}>
          <Icon name="alert" />
          {error}
        </p>
      ) : null}
    </fieldset>
  );
});
