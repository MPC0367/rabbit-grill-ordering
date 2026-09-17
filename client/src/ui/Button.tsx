// Button, LinkButton, IconButton, TextLink (DESIGN §10.1, §10.2).
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { linkHandler } from '../lib/router.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Badge } from './Badge.tsx';
import { Price } from './Price.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'quiet' | 'danger' | 'danger-solid';
export type ButtonSize = 'md' | 'lg' | 'staff';

interface ButtonLookProps {
  /** primary = the one solid "next step" per view; secondary = forest outline (Add); outline = edge outline; ghost/quiet = no frame. */
  variant?: ButtonVariant;
  /** md 44 (guest) · lg 52 (sheet footer, Send order) · staff 48 */
  size?: ButtonSize;
  block?: boolean;
  /** Leading icon */
  icon?: IconName;
  /** Trailing icon (chevrons) */
  iconEnd?: IconName;
  /** 2px icon stroke (plus/minus/check) */
  iconBold?: boolean;
  /** Oswald count after the label: "Accept · 5" */
  count?: number;
  /** Price after the label: "เพิ่มในรายการ · ฿590" */
  priceMinor?: number;
  /** Shows the confirmation label ("เพิ่มแล้ว ✓") in place of the label. */
  confirmed?: boolean;
  confirmedLabel?: ReactNode;
}

function lookClass(variant: ButtonVariant, size: ButtonSize, block?: boolean, extra?: string) {
  return cx('btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block', extra);
}

function ButtonLabel({ icon, iconEnd, iconBold, count, priceMinor, confirmed, confirmedLabel, children }: ButtonLookProps & { children?: ReactNode }) {
  const { t } = useI18n();
  if (confirmed) {
    return (
      <>
        <Icon name="check" bold />
        <span>{confirmedLabel ?? t('common.added')}</span>
      </>
    );
  }
  const hasText = children !== undefined && children !== null && children !== false;
  const hasSuffix = count !== undefined || priceMinor !== undefined;
  return (
    <>
      {icon ? <Icon name={icon} bold={iconBold} /> : null}
      {hasText || hasSuffix ? (
        <span>
          {children}
          {count !== undefined ? <>{hasText ? ' · ' : null}<span className="btn__count">{count}</span></> : null}
          {priceMinor !== undefined ? <>{hasText || count !== undefined ? ' · ' : null}<Price minor={priceMinor} className="btn__price" plain /></> : null}
        </span>
      ) : null}
      {iconEnd ? <Icon name={iconEnd} bold={iconBold} /> : null}
    </>
  );
}

export interface ButtonProps extends ButtonLookProps, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Spinner, aria-busy, width kept, repeated clicks ignored. */
  loading?: boolean;
  /** Sets aria-haspopup="dialog" (the action opens a sheet or dialog). */
  opensDialog?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'outline', size = 'md', block, icon, iconEnd, iconBold, count, priceMinor, confirmed, confirmedLabel,
    loading, opensDialog, className, type = 'button', onClick, children, ...rest
  },
  ref,
) {
  const inert = loading || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <button
      ref={ref}
      type={type}
      className={lookClass(variant, size, block, cx(loading && 'is-loading', confirmed && 'is-confirmed', className))}
      aria-busy={loading || undefined}
      aria-haspopup={opensDialog ? 'dialog' : rest['aria-haspopup']}
      onClick={(e) => {
        if (inert) { e.preventDefault(); return; }
        onClick?.(e);
      }}
      {...rest}
    >
      <ButtonLabel {...{ icon, iconEnd, iconBold, count, priceMinor, confirmed, confirmedLabel }}>{children}</ButtonLabel>
    </button>
  );
});

export interface LinkButtonProps extends ButtonLookProps, AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  /** Use full page navigation instead of the in-app router. */
  external?: boolean;
}

/** An anchor that looks like a button (routes through lib/router for same-origin links). */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { variant = 'outline', size = 'md', block, icon, iconEnd, iconBold, count, priceMinor, confirmed, confirmedLabel, className, external, onClick, children, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      className={lookClass(variant, size, block, className)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (!external) linkHandler(e);
      }}
      {...rest}
    >
      <ButtonLabel {...{ icon, iconEnd, iconBold, count, priceMinor, confirmed, confirmedLabel }}>{children}</ButtonLabel>
    </a>
  );
});

export type IconButtonVariant = 'plain' | 'framed' | 'round';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** Required accessible name. */
  label: string;
  icon: IconName;
  iconSize?: 'sm' | 'md' | 'lg';
  /** plain · framed (bone + edge: ticket ⋯, previous/next) · round (close over a photo) */
  variant?: IconButtonVariant;
  /** md 44 · staff 48 · sm 32 visual with a 44px hit area */
  size?: 'md' | 'staff' | 'sm';
  /** Count badge over the icon; its words are added to the name. */
  badge?: number;
  badgeLabel?: string;
  opensDialog?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, iconSize, variant = 'plain', size = 'md', badge, badgeLabel, opensDialog, className, type = 'button', ...rest },
  ref,
) {
  const name = badge ? `${label}${badgeLabel ? `, ${badgeLabel}` : ''}` : label;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={name}
      aria-haspopup={opensDialog ? 'dialog' : rest['aria-haspopup']}
      className={cx('iconbtn', variant !== 'plain' && `iconbtn--${variant}`, size !== 'md' && `iconbtn--${size}`, className)}
      {...rest}
    >
      <Icon name={icon} size={iconSize} />
      {badge ? <Badge count={badge} ring /> : null}
    </button>
  );
});

export interface TextLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  /** Trailing icon, default chevron. Pass null for none. */
  icon?: IconName | null;
  external?: boolean;
}

/** Underlined forest link with a chevron ("ดูบิลของโต๊ะ ›"), 44px tall. */
export const TextLink = forwardRef<HTMLAnchorElement, TextLinkProps>(function TextLink(
  { icon = 'chev-r', external, className, onClick, children, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cx('textlink', className)}
      onClick={(e) => { onClick?.(e); if (!external) linkHandler(e); }}
      {...rest}
    >
      {children}
      {icon ? <Icon name={icon} size="sm" /> : null}
    </a>
  );
});
