// Identity pieces: Wordmark, TableTag, LangToggle (DESIGN §8.1, §10.3, §10.30).
import { forwardRef, type HTMLAttributes, type MouseEvent, type Ref } from 'react';
import type { Locale } from '../../../shared/settings.ts';
import { linkHandler } from '../lib/router.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { SegmentedControl } from './SegmentedControl.tsx';

export interface WordmarkProps extends HTMLAttributes<HTMLElement> {
  /** guest: centred RABBIT GRILL / KHAO YAI · staff: left aligned, ember-light KHAO YAI · STAFF */
  variant?: 'guest' | 'staff';
  /** Makes it a 44px link. */
  href?: string;
  /** Accessible name (the letter spans are aria-hidden). */
  label?: string;
  /** Lockup line; default "Khao Yai" (guest) / "Khao Yai · Staff" (staff). */
  sub?: string;
}

/** Typographic lockup: Cormorant caps name over Oswald tracked KHAO YAI. */
export const Wordmark = forwardRef<HTMLElement, WordmarkProps>(function Wordmark(
  { variant = 'guest', href, label, sub, className, onClick, ...rest },
  ref,
) {
  const { t } = useI18n();
  const name = label ?? t('common.restaurant');
  const inner = (
    <>
      <span className="wordmark__name" lang="en" aria-hidden="true">Rabbit Grill</span>
      <span className="wordmark__sub" lang="en" aria-hidden="true">{sub ?? (variant === 'staff' ? 'Khao Yai · Staff' : 'Khao Yai')}</span>
    </>
  );
  const cls = cx('wordmark', variant === 'staff' && 'wordmark--staff', className);
  if (href) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        aria-label={name}
        className={cls}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => { onClick?.(e); linkHandler(e); }}
        {...rest}
      >
        {inner}
      </a>
    );
  }
  return (
    <p ref={ref as Ref<HTMLParagraphElement>} role="img" aria-label={name} className={cls} {...rest}>
      {inner}
    </p>
  );
});

export interface TableTagProps extends HTMLAttributes<HTMLParagraphElement> {
  /** Table label ("07"). null keeps the slot (invisible) so the masthead grid holds. */
  label: string | null | undefined;
}

/** Framed 44px table tag: "โต๊ะ" + Oswald 24 numeral. A label, not a button. */
export const TableTag = forwardRef<HTMLParagraphElement, TableTagProps>(function TableTag({ label, className, ...rest }, ref) {
  const { t, lang } = useI18n();
  if (!label) return <p ref={ref} className={cx('tabletag tabletag--empty', className)} aria-hidden="true" {...rest} />;
  return (
    <p ref={ref} className={cx('tabletag', className)} aria-label={t('common.table', { label })} {...rest}>
      <span className="tabletag__k" aria-hidden="true" lang={lang}>{t('common.tableWord')}</span>
      <span className="tabletag__n" aria-hidden="true">{label}</span>
    </p>
  );
});

export interface LangToggleProps {
  className?: string;
  /** Staff rail uses the same framed box. */
  size?: 'md' | 'staff';
}

/**
 * ไทย / EN framed box (44×44 segments). Switching keeps all state.
 * Below 360px it collapses to the single language you can switch to.
 */
export function LangToggle({ className }: LangToggleProps) {
  const { lang, setLang, t } = useI18n();
  return (
    <SegmentedControl<Locale>
      tone="box"
      className={cx('seg--lang', className)}
      label={`${t('common.language')} · Language`}
      value={lang}
      onChange={setLang}
      options={[
        { value: 'th', label: 'ไทย', lang: 'th' },
        { value: 'en', label: 'EN', lang: 'en', ariaLabel: 'English' },
      ]}
    />
  );
}
