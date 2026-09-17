// Workspace header (DESIGN.md §8.2, §10.30): Cormorant italic title, routed
// underline subtabs, Demo data stamp, and a right cluster with slots for the
// connection pill, the guest-ordering control and the staff identity.
import { forwardRef, useRef, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { linkHandler } from '../../lib/router.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Badge } from '../Badge.tsx';
import { mergeRefs } from '../cx.ts';
import { usePinnedEdge } from '../hooks.ts';
import { cx, Ico, initials } from './parts.tsx';

export interface SubTabItem {
  id: string;
  label: string;
  href: string;
  current?: boolean;
  /** Attention count (oxblood badge), e.g. open service requests. */
  count?: number;
  countLabel?: string;
}

export interface SubTabsProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  items: SubTabItem[];
  label: string;
  onNavigate?: (item: SubTabItem, e: MouseEvent<HTMLAnchorElement>) => void;
}

/** Routed subtabs are links (each view has its own URL), so they sit in a nav, not a tablist. */
export function SubTabs({ items, label, onNavigate, className, ...rest }: SubTabsProps) {
  return (
    <nav {...rest} className={cx('subtabs', className)} aria-label={label}>
      {items.map((item) => (
        <a
          key={item.id}
          className="subtab"
          href={item.href}
          aria-current={item.current ? 'page' : undefined}
          onClick={(e) => (onNavigate ? onNavigate(item, e) : linkHandler(e))}
        >
          {item.label}
          {item.count ? <Badge count={item.count} tone="alert" label={`, ${item.countLabel ?? item.count}`} /> : null}
        </a>
      ))}
    </nav>
  );
}

/** Compact dashed "DEMO DATA" stamp for the header while fixtures are loaded. */
export function DemoStamp({ label, className }: { label?: string; className?: string }) {
  const { t, lang } = useI18n();
  return (
    <span className={cx('demo', className)} lang={label ? undefined : lang}>
      {label ?? t('common.demoData')}
    </span>
  );
}

export interface WorkspaceHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string;
  /**
   * The workspace title is the page's h1. On a sub-route whose page writes
   * its own h1 (More › Reports), pass 'p' so the page has one h1, not two.
   */
  titleAs?: 'h1' | 'p';
  tabs?: SubTabItem[];
  /** Accessible name of the subtab nav; defaults to "{title} views". */
  tabsLabel?: string;
  onTabNavigate?: SubTabsProps['onNavigate'];
  /** Show the Demo data stamp. */
  demo?: boolean;
  /** Extra items at the start of the right cluster ("Data as of 19:52", Export CSV). */
  extra?: ReactNode;
  connection?: ReactNode;
  ordering?: ReactNode;
  identity?: ReactNode;
  /** Tablet/phone header: title + slots only; long texts hide (DESIGN.md §8.2). */
  compact?: boolean;
}

export const WorkspaceHeader = forwardRef<HTMLElement, WorkspaceHeaderProps>(function WorkspaceHeader(
  { title, titleAs = 'h1', tabs, tabsLabel, onTabNavigate, demo, extra, connection, ordering, identity, compact, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const own = useRef<HTMLElement | null>(null);
  // Focus moving up a workspace stops below this sticky header.
  usePinnedEdge(own, 'top');
  const Title = titleAs;
  return (
    <header ref={mergeRefs(ref, own)} {...rest} className={cx('wshead-cq', className)}>
      {/* The inner row is the styled header; the outer element is sticky and a size container,
          so long texts give way when the workspace is narrow, whatever the viewport. */}
      <div className={cx('wshead', compact && 'wshead--compact')}>
        <Title className={titleAs === 'p' ? 'wshead__t' : undefined}>{title}</Title>
        {tabs && tabs.length > 0 ? (
          <SubTabs items={tabs} label={tabsLabel ?? t('common.staff.views', { title })} onNavigate={onTabNavigate} />
        ) : null}
        {demo ? <DemoStamp /> : null}
        <div className="wshead__right">
          {extra}
          {connection}
          {ordering}
          {identity}
        </div>
      </div>
    </header>
  );
});

export interface OrderingControlProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  paused: boolean;
  /** "by Nok 19:40" style detail shown while paused. */
  pausedDetail?: string;
  /** Opens the pause dialog (reason + duration). Never pauses in one tap. */
  onPause?: () => void;
  /** Opens the resume confirmation. */
  onResume?: () => void;
  busy?: boolean;
}

/** "Guest ordering ✓ Open | Pause…" joined in one frame; paused turns the frame ink. */
export const OrderingControl = forwardRef<HTMLDivElement, OrderingControlProps>(function OrderingControl(
  { paused, pausedDetail, onPause, onResume, busy, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const action = paused ? onResume : onPause;
  return (
    <div ref={ref} {...rest} className={cx('ordering', paused && 'is-paused', className)} role="group" aria-label={t('common.staff.guestOrdering')}>
      <span className="ordering__state" role="status">
        <span className="ordering__k">{t('common.staff.guestOrdering')}</span>
        <b>
          <Ico name={paused ? 'pause' : 'check'} size="sm" />
          {paused ? t('common.staff.orderingPaused') : t('common.staff.orderingOpen')}
        </b>
        {paused && pausedDetail ? <span className="ordering__by">{pausedDetail}</span> : null}
      </span>
      {action ? (
        <button
          type="button"
          className={cx('ordering__btn', busy && 'is-busy')}
          aria-haspopup="dialog"
          aria-busy={busy || undefined}
          onClick={() => { if (!busy) action(); }}
        >
          {paused ? null : <Ico name="pause" size="sm" />}
          {paused ? t('common.staff.resume') : t('common.staff.pause')}
        </button>
      ) : null}
    </div>
  );
});

export interface StaffChipProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  name: string;
  role: string;
  initials?: string;
  /** Opens the identity menu (switch user, sign out). */
  onOpen?: () => void;
  menuLabel?: string;
}

/** Avatar (forest circle, Oswald initials) + name + role. */
export function StaffChip({ name, role, initials: ini, onOpen, menuLabel, className, ...rest }: StaffChipProps) {
  const body = (
    <>
      <span className="avatar" aria-hidden="true">{ini ?? initials(name)}</span>
      <span className="who__text">
        <span className="who__n">{name}</span>
        <span className="who__r">{role}</span>
      </span>
    </>
  );
  if (onOpen) {
    return (
      <button type="button" {...rest} className={cx('who who--button', className)} onClick={onOpen} aria-haspopup="menu" aria-label={menuLabel ? `${name}, ${role}. ${menuLabel}` : undefined}>
        {body}
      </button>
    );
  }
  return (
    <div {...rest} className={cx('who', className)}>
      {body}
    </div>
  );
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string;
  /** Parent link for secondary pages (More › Reports). */
  back?: { label: string; href: string; onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void };
  description?: ReactNode;
  actions?: ReactNode;
  demo?: boolean;
}

/** Header for secondary staff pages that sit under a destination (Reports, Team, Audit…). */
export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  { title, back, description, actions, demo, className, ...rest },
  ref,
) {
  return (
    <header ref={ref} {...rest} className={cx('apage', className)}>
      {back ? (
        <a className="apage__back" href={back.href} onClick={(e) => (back.onNavigate ? back.onNavigate(e) : linkHandler(e))}>
          <Ico name="chev-l" size="sm" />
          {back.label}
        </a>
      ) : null}
      <div className="apage__main">
        <div className="apage__t">
          <h1>{title}</h1>
          {demo ? <DemoStamp /> : null}
        </div>
        {description ? <p className="apage__d">{description}</p> : null}
      </div>
      {actions ? <div className="apage__actions">{actions}</div> : null}
    </header>
  );
});

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Cormorant italic display title (Menu Stats). */
  display?: boolean;
  level?: 2 | 3;
}

/** In-page section head: title, one-line description, right-aligned actions. */
export function SectionHeader({ title, titleId, description, actions, display, level = 2, className, ...rest }: SectionHeaderProps) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div {...rest} className={cx('section-h', display && 'section-h--display', className)}>
      <H id={titleId}>{title}</H>
      {description ? <p>{description}</p> : null}
      {actions ? <div className="right">{actions}</div> : null}
    </div>
  );
}
