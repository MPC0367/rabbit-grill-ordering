// The guest dock (DESIGN §8.1, §10.11, §10.12): the order slip above a bottom
// nav with three destinations and the labelled service key.
import { forwardRef, useRef, type HTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { linkHandler } from '../lib/router.ts';
import { money } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { useGlideMark } from './hooks.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Badge } from './Badge.tsx';
import { Button } from './Button.tsx';
import { Price } from './Price.tsx';

/** Fixed bottom container for CartBar + BottomNav. `inline` keeps it in the flow (previews). */
export function Dock({ children, inline, className }: { children: ReactNode; inline?: boolean; className?: string }) {
  return <div className={cx('dock', inline && 'dock--static', className)}>{children}</div>;
}

// ---------------------------------------------------------------- CartBar
export type CartBarState = 'idle' | 'sending' | 'review';

export interface CartBarProps {
  count: number;
  totalMinor: number;
  /** Link to the order page (preferred) or a click handler. */
  href?: string;
  onClick?: () => void;
  /** idle: "ยังไม่ได้ส่งเข้าครัว" · sending: "กำลังส่ง…" · review: alert icon + "มีรายการต้องตรวจสอบ" */
  state?: CartBarState;
  actionLabel?: string;
  className?: string;
}

/** The order slip: forest, 60px, perforated, one link. Hidden when the draft is empty. */
export const CartBar = forwardRef<HTMLElement, CartBarProps>(function CartBar(
  { count, totalMinor, href, onClick, state = 'idle', actionLabel, className },
  ref,
) {
  const { t } = useI18n();
  if (count <= 0) return null;
  const itemsText = t(count === 1 ? 'common.itemOne' : 'common.items', { n: count });
  const sub = state === 'sending' ? t('common.sending') : state === 'review' ? t('common.reviewNeeded') : t('common.notSent');
  const go = actionLabel ?? t('common.viewOrder');
  const label = `${itemsText} ${money(totalMinor)} ${sub} ${go}`;
  const body = (
    <>
      <span className="slip__main">
        <span className="slip__count" key={`${count}-${totalMinor}`}>
          {itemsText} · <Price minor={totalMinor} />
        </span>
        <span className="slip__sub">
          {state === 'review' ? <Icon name="alert" /> : null}
          {sub}
        </span>
      </span>
      <span className="slip__perf" aria-hidden="true" />
      <span className="slip__go">{go}<Icon name="chev-r" /></span>
    </>
  );
  if (href) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        className={cx('slip', className)}
        href={href}
        aria-label={label}
        aria-busy={state === 'sending' || undefined}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => { onClick?.(); linkHandler(e); }}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type="button"
      className={cx('slip', className)}
      aria-label={label}
      aria-busy={state === 'sending' || undefined}
      onClick={onClick}
    >
      {body}
    </button>
  );
});

/** Alias: the design calls the cart bar "the order slip". */
export const OrderSlip = CartBar;

// ---------------------------------------------------------------- BottomNav
export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  /** Count badge (Your order). */
  badge?: number;
  /** Words for the badge ("2 รายการ"). */
  badgeLabel?: string;
}

export interface BottomNavProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** เมนู · รายการของฉัน · ติดตาม */
  items: ReadonlyArray<NavItem>;
  current: string | null;
  label?: string;
  /** Called before routing; call e.preventDefault() to handle the navigation yourself. */
  onNavigate?: (key: string, e: MouseEvent<HTMLAnchorElement>) => void;
  /** The labelled service key (not a destination). Omit to hide it. */
  onService?: () => void;
  serviceLabel?: string;
}

/** 64px bone bar: three destinations with one gliding ember mark, plus the 88px service key. */
export const BottomNav = forwardRef<HTMLDivElement, BottomNavProps>(function BottomNav(
  { items, current, label, onNavigate, onService, serviceLabel, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const nav = useRef<HTMLElement | null>(null);
  const mark = useRef<HTMLSpanElement | null>(null);
  useGlideMark(nav, mark, '[aria-current="page"]', `${current}|${items.length}`, { width: 32 });
  return (
    <div ref={ref} className={cx('gnav', className)} style={onService ? undefined : { gridTemplateColumns: '1fr' }} {...rest}>
      <nav ref={nav} className="bnav" aria-label={label ?? t('common.nav.label')}>
        {items.map((it) => (
          <a
            key={it.key}
            className="bnav__item"
            href={it.href}
            aria-current={it.key === current ? 'page' : undefined}
            onClick={(e) => { onNavigate?.(it.key, e); linkHandler(e); }}
          >
            {it.badge ? (
              <span className="bnav__icon">
                <Icon name={it.icon} size="lg" />
                <Badge count={it.badge} ring />
              </span>
            ) : (
              <Icon name={it.icon} size="lg" />
            )}
            {it.label}
            {it.badge && it.badgeLabel ? <span className="visually-hidden">{it.badgeLabel}</span> : null}
          </a>
        ))}
        <span ref={mark} className="mark" aria-hidden="true" />
      </nav>
      {onService ? <ServiceKey onClick={onService} label={serviceLabel} /> : null}
    </div>
  );
});

// ---------------------------------------------------------------- ServiceKey
export interface ServiceKeyProps {
  onClick: () => void;
  label?: string;
  /** dock: ringed bell over the label · header: labelled outline button (desktop masthead) */
  variant?: 'dock' | 'header';
  className?: string;
}

/** บริการ: opens the service menu. Never a destination, never "current". */
export function ServiceKey({ onClick, label, variant = 'dock', className }: ServiceKeyProps) {
  const { t } = useI18n();
  const text = label ?? t('common.service');
  if (variant === 'header') {
    return (
      <Button variant="outline" icon="bell" opensDialog onClick={onClick} className={className}>
        {text}
      </Button>
    );
  }
  return (
    <button type="button" className={cx('svckey', className)} aria-haspopup="dialog" onClick={onClick}>
      <span className="svckey__ring"><Icon name="bell" /></span>
      {text}
    </button>
  );
}

// ---------------------------------------------------------------- GuestNav (desktop masthead)
export interface GuestNavProps {
  items: ReadonlyArray<NavItem>;
  current: string | null;
  label?: string;
  onNavigate?: (key: string, e: MouseEvent<HTMLAnchorElement>) => void;
}

/** The three destinations as masthead tabs from 1080px (ember underline on the current one). */
export function GuestNav({ items, current, label, onNavigate }: GuestNavProps) {
  const { t } = useI18n();
  return (
    <nav className="mast__nav" aria-label={label ?? t('common.nav.label')}>
      {items.map((it) => (
        <a
          key={it.key}
          href={it.href}
          aria-current={it.key === current ? 'page' : undefined}
          onClick={(e) => { onNavigate?.(it.key, e); linkHandler(e); }}
        >
          {it.label}
          {it.badge ? <Badge count={it.badge} label={it.badgeLabel} /> : null}
        </a>
      ))}
    </nav>
  );
}

/** The standard three guest destinations. */
export function useGuestNavItems(opts: { draftCount: number; menuHref?: string; orderHref?: string; trackHref?: string }): NavItem[] {
  const { t } = useI18n();
  return [
    { key: 'menu', label: t('common.nav.menu'), icon: 'book', href: opts.menuHref ?? '/menu' },
    {
      key: 'order', label: t('common.nav.order'), icon: 'pad', href: opts.orderHref ?? '/menu/cart',
      badge: opts.draftCount, badgeLabel: t(opts.draftCount === 1 ? 'common.itemOne' : 'common.items', { n: opts.draftCount }),
    },
    { key: 'track', label: t('common.nav.track'), icon: 'track', href: opts.trackHref ?? '/menu/orders' },
  ];
}
