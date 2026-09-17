// Guest composites (DESIGN §8.1, §10.13, §10.14, §10.30): masthead, page
// head, list rows and the service menu, allergy notice, order lines, the
// unsent-draft nudge and the running total. Presentational only.
import { createElement, forwardRef, useRef, type AnchorHTMLAttributes, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import type { AllergenInfoDTO } from '../../../shared/dto.ts';
import { dateLabel } from '../lib/format.ts';
import { linkHandler } from '../lib/router.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx, mergeRefs } from './cx.ts';
import { usePinnedEdge } from './hooks.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Button } from './Button.tsx';
import { Leader, Price } from './Price.tsx';
import { Tag } from './Badge.tsx';
import { LangToggle, TableTag, Wordmark } from './Brand.tsx';
import { DishImage, type DishImageSource } from './DishImage.tsx';

// ---------------------------------------------------------------- GuestHeader
export interface GuestHeaderProps extends HTMLAttributes<HTMLElement> {
  /** "07"; null keeps the slot empty (public menu). */
  tableLabel?: string | null;
  homeHref?: string;
  /** Desktop destinations (GuestNav). Hidden below 1080px by CSS. */
  nav?: ReactNode;
  /** Right-side extras before the language box (desktop service button). */
  actions?: ReactNode;
  /** Language control; default <LangToggle/>. Pass null to hide. */
  langControl?: ReactNode;
}

/** Sticky 60px masthead with the double rule: table tag · wordmark · language. */
export const GuestHeader = forwardRef<HTMLElement, GuestHeaderProps>(function GuestHeader(
  { tableLabel, homeHref = '/menu', nav, actions, langControl, className, ...rest },
  ref,
) {
  const own = useRef<HTMLElement | null>(null);
  usePinnedEdge(own, 'top');
  return (
    <header ref={mergeRefs(ref, own)} className={cx('mast', className)} {...rest}>
      <div className="mast__in">
        <TableTag label={tableLabel} />
        <Wordmark href={homeHref} />
        {nav ?? <span className="mast__nav" aria-hidden="true" />}
        <div className="mast__right">
          {actions}
          {langControl === undefined ? <LangToggle /> : langControl}
        </div>
      </div>
    </header>
  );
});

// ---------------------------------------------------------------- PageHead (guest; the staff kit has its own PageHeader)
export interface PageHeadProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** "โต๊ะ 07 · ส่งแล้ว 2 รอบ" on a hairline */
  kicker?: ReactNode;
  title: ReactNode;
  titleLang?: string;
  /** Italic English beside the Thai title ("Track"). */
  secondary?: ReactNode;
  secondaryLang?: string;
  /** Row of pills (live status). */
  row?: ReactNode;
  /** One supporting sentence. */
  support?: ReactNode;
}

export const PageHead = forwardRef<HTMLDivElement, PageHeadProps>(function PageHead(
  { kicker, title, titleLang, secondary, secondaryLang = 'en', row, support, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('pagehead', className)} {...rest}>
      {kicker ? <p className="pagehead__kick">{kicker}</p> : null}
      <div className="pagehead__t">
        <h1 lang={titleLang}>{title}</h1>
        {secondary ? <p className="en" lang={secondaryLang}>{secondary}</p> : null}
      </div>
      {row ? <div className="pagehead__row">{row}</div> : null}
      {support ? <p className="support pagehead__support">{support}</p> : null}
      {children}
    </div>
  );
});

// ---------------------------------------------------------------- Card
export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'aside';
  /** 18px padding */
  padded?: boolean;
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card({ as = 'div', padded, className, ...rest }, ref) {
  return createElement(as, { ref, className: cx('card', padded && 'card--pad', className), ...rest });
});

// ---------------------------------------------------------------- ListRow
export interface ListRowProps {
  icon?: IconName;
  title: ReactNode;
  sub?: ReactNode;
  /** Right side: a pill, a count, or the default chevron for actionable rows. */
  trailing?: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  opensDialog?: boolean;
  className?: string;
  lang?: string;
}

/** 60px row: ringed icon, title with a meta line, trailing chevron or status. */
export function ListRow({ icon, title, sub, trailing, onClick, href, disabled, opensDialog, className, lang }: ListRowProps) {
  const actionable = Boolean(onClick || href) && !disabled;
  const inner = (
    <>
      {icon ? <span className="srow__ic" aria-hidden="true"><Icon name={icon} /></span> : null}
      <span className="srow__txt">
        <span className="srow__t" lang={lang}>{title}</span>
        {sub ? <span className="srow__s">{sub}</span> : null}
      </span>
      {trailing ?? (actionable ? <Icon name="chev-r" /> : null)}
    </>
  );
  if (href && !disabled) {
    return (
      <a className={cx('srow', className)} href={href} onClick={(e: MouseEvent<HTMLAnchorElement>) => { onClick?.(); linkHandler(e); }}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    // aria-disabled, not `disabled`: a row that turns unavailable under the
    // pointer (a request just sent) keeps focus, so the reader stays in place
    // and hears the status that follows instead of dropping to <body>.
    return (
      <button
        type="button"
        className={cx('srow', className)}
        onClick={() => { if (!disabled) onClick(); }}
        aria-disabled={disabled || undefined}
        aria-haspopup={opensDialog ? 'dialog' : undefined}
      >
        {inner}
      </button>
    );
  }
  return <div className={cx('srow', className)}>{inner}</div>;
}

// ---------------------------------------------------------------- ServiceMenu
export interface ServiceMenuItem extends Omit<ListRowProps, 'className'> {
  key: string;
}

export interface ServiceMenuProps {
  /** Only the services the restaurant enabled. */
  items: ReadonlyArray<ServiceMenuItem>;
  /** Offline: only the in-person fallback is shown. */
  offline?: boolean;
  fallback?: ReactNode;
}

/** Content of the service sheet ("บริการที่โต๊ะ 07"). Put it inside a <Sheet>. */
export function ServiceMenu({ items, offline, fallback }: ServiceMenuProps) {
  const { t } = useI18n();
  return (
    <>
      {offline ? null : (
        <ul>
          {items.map(({ key, ...row }) => <li key={key}><ListRow {...row} /></li>)}
        </ul>
      )}
      <p className="handnote"><Icon name="hand" />{fallback ?? t('common.serviceFallback')}</p>
    </>
  );
}

// ---------------------------------------------------------------- AllergyNotice
export interface AllergyNoticeProps extends HTMLAttributes<HTMLDivElement> {
  allergens: AllergenInfoDTO;
  onCallStaff?: () => void;
  callStaffLabel?: string;
}

/** Alert-tint notice with a triangle. Unknown never reads as "free from". */
export const AllergyNotice = forwardRef<HTMLDivElement, AllergyNoticeProps>(function AllergyNotice(
  { allergens, onCallStaff, callStaffLabel, className, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  const verified = allergens.status === 'verified';
  const contains = verified ? allergens.entries.filter((e) => e.state === 'contains') : [];
  const may = verified ? allergens.entries.filter((e) => e.state === 'may_contain') : [];
  return (
    <div ref={ref} role="note" className={cx('notice', className)} {...rest}>
      <Icon name="alert" />
      <p className="notice__t">{t('common.allergy.title')}</p>
      {verified ? (
        <>
          {contains.length ? (
            <div className="notice__tags">
              <span className="meta">{t('common.allergy.contains')}</span>
              {contains.map((e) => <Tag key={e.allergen} tone="alert">{e.allergen}</Tag>)}
            </div>
          ) : null}
          {may.length ? (
            <div className="notice__tags">
              <span className="meta">{t('common.allergy.mayContain')}</span>
              {may.map((e) => <Tag key={e.allergen} tone="heat">{e.allergen}</Tag>)}
            </div>
          ) : null}
          <p className="notice__b">
            {t('common.allergy.verified', { date: allergens.verified_at ? dateLabel(allergens.verified_at.slice(0, 10), lang, { year: true }) : '—' })}
          </p>
        </>
      ) : (
        <p className="notice__b">{t('common.allergy.unknown')}</p>
      )}
      {onCallStaff ? (
        <Button variant="outline" icon="bell" onClick={onCallStaff}>{callStaffLabel ?? t('service.call_staff')}</Button>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------- OrderLine
export interface OrderLineProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title'> {
  name: ReactNode;
  nameLang?: string;
  image?: DishImageSource | null;
  quantity: number;
  totalMinor: number | null;
  /** Chosen options ("มีเดียม"), variant chips, Example tags. */
  options?: ReactNode;
  /** Guest note, shown with the note icon. */
  note?: string | null;
  /** A quote issue for this line (price changed, sold out). */
  issue?: ReactNode;
  /** Stepper, Edit, Remove. */
  actions?: ReactNode;
  /** Larger rows for the Your order page. */
  size?: 'md' | 'lg';
}

/** A draft or bill line: plate, name ··· total, options, note, actions. */
export const OrderLine = forwardRef<HTMLLIElement, OrderLineProps>(function OrderLine(
  { name, nameLang, image, quantity, totalMinor, options, note, issue, actions, size = 'md', className, ...rest },
  ref,
) {
  return (
    <li ref={ref} className={cx('cartline', !image && 'cartline--noimg', size === 'lg' && 'cartline--lg', className)} {...rest}>
      {image ? <DishImage image={image} variant="thumb" decorative /> : null}
      <div>
        <Leader
          label={<span className="cartline__name" lang={nameLang}>{name}</span>}
          value={<Price minor={totalMinor} />}
        />
        <p className="meta cartline__opts">
          <span>× {quantity}</span>
          {options ? <><span aria-hidden="true">·</span>{options}</> : null}
        </p>
        {note ? <p className="meta cartline__note"><Icon name="note" size="sm" /><span>{note}</span></p> : null}
        {issue ? <p className="cartline__issue" role="status"><Icon name="alert" /><span>{issue}</span></p> : null}
        {actions ? <div className="cartline__acts">{actions}</div> : null}
      </div>
    </li>
  );
});

// ---------------------------------------------------------------- UnsentCard
export interface UnsentCardProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'title'> {
  /** Items still in this device's draft. */
  count: number;
  /** The round number they would be sent as (N+1). */
  nextRound: number;
  href: string;
}

/** Track nudge: "มี 2 รายการที่ยังไม่ได้ส่ง · ส่งเป็นรอบที่ 3 ได้เลย". */
export const UnsentCard = forwardRef<HTMLAnchorElement, UnsentCardProps>(function UnsentCard(
  { count, nextRound, href, className, onClick, ...rest },
  ref,
) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <a
      ref={ref}
      href={href}
      className={cx('nudge', className)}
      onClick={(e) => { onClick?.(e); linkHandler(e); }}
      {...rest}
    >
      <span>
        <span className="nudge__t">{t(count === 1 ? 'common.unsent.titleOne' : 'common.unsent.title', { n: count })}</span>
        <span className="nudge__s">{t('common.unsent.sub', { round: nextRound })}</span>
      </span>
      <Icon name="chev-r" />
    </a>
  );
});

// ---------------------------------------------------------------- RunningTotal
export interface RunningTotalProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** "ค่าอาหารที่ส่งแล้ว · 2 รอบ" */
  label: ReactNode;
  totalMinor: number;
  /** Honest note: what is excluded, who confirms the final amount. */
  note?: ReactNode;
  /** A TextLink or a primary Button. */
  action?: ReactNode;
  /** Price size (Track 24, cart panel 22). */
  size?: 'total' | 'xl';
}

/** Ink rule, label ··· total, an honest note. */
export const RunningTotal = forwardRef<HTMLElement, RunningTotalProps>(function RunningTotal(
  { label, totalMinor, note, action, size, className, ...rest },
  ref,
) {
  return (
    <section ref={ref} className={cx('bill', className)} {...rest}>
      <Leader label={label} value={<Price minor={totalMinor} size={size} />} />
      {note ? <p className="bill__note">{note}</p> : null}
      {action}
    </section>
  );
});
