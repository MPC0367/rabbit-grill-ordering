// Admin rail (DESIGN.md §8.2): charcoal sidebar with the five destinations,
// compact 84px tablet mode, and the phone bottom-bar fallback. Presentational:
// the shell passes items, current state, counts and callbacks.
import { forwardRef, useRef, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { linkHandler } from '../../lib/router.ts';
import { useI18n } from '../../lib/i18n.tsx';
import type { Locale } from '../../../../shared/settings.ts';
import { Badge } from '../Badge.tsx';
import { mergeRefs } from '../cx.ts';
import { usePinnedEdge } from '../hooks.ts';
import { SegmentedControl } from '../SegmentedControl.tsx';
import { cx, Ico, type AdminIconName } from './parts.tsx';

export type RailMode = 'full' | 'compact' | 'bar';

export interface RailItem {
  id: string;
  label: string;
  href: string;
  icon: AdminIconName;
  /** Attention count shown as an ember badge (0 or undefined hides it). */
  count?: number;
  /** Spoken text for the count, e.g. "2 new". Defaults to the number. */
  countLabel?: string;
  current?: boolean;
}

export interface RailNavProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  items: RailItem[];
  mode?: RailMode;
  /** Pin the phone bar to the bottom of the viewport (mode "bar"). */
  fixed?: boolean;
  /** Intercept navigation (call e.preventDefault() to route yourself). Defaults to client-side routing. */
  onNavigate?: (item: RailItem, e: MouseEvent<HTMLAnchorElement>) => void;
}

/** The five staff destinations. In "bar" mode it renders its own charcoal band. */
export const RailNav = forwardRef<HTMLElement, RailNavProps>(function RailNav(
  { items, mode = 'full', fixed, onNavigate, className, 'aria-label': ariaLabel, ...rest },
  ref,
) {
  const { t } = useI18n();
  const own = useRef<HTMLElement | null>(null);
  // The fixed phone bar: keyboard focus scrolls clear of it.
  usePinnedEdge(own, 'bottom', mode === 'bar' && Boolean(fixed));
  return (
    <nav
      ref={mergeRefs(ref, own)}
      {...rest}
      className={cx('rnav', mode === 'bar' && 'rnav--bar', mode === 'bar' && fixed && 'rnav--fixed', className)}
      aria-label={ariaLabel ?? t('common.staff.nav')}
      data-surface={mode === 'bar' ? 'dark' : undefined}
    >
      {items.map((item) => (
        <a
          key={item.id}
          className="rnav__item"
          href={item.href}
          aria-current={item.current ? 'page' : undefined}
          onClick={(e) => (onNavigate ? onNavigate(item, e) : linkHandler(e))}
        >
          <Ico name={item.icon} />
          <span className="rnav__label">{item.label}</span>
          {item.count ? <Badge count={item.count} tone="ember" label={`, ${item.countLabel ?? item.count}`} /> : null}
        </a>
      ))}
    </nav>
  );
});

export interface AdminRailProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  mode?: Exclude<RailMode, 'bar'>;
  /** Wordmark link target. */
  homeHref?: string;
  nav: ReactNode;
  footer?: ReactNode;
}

/** The charcoal rail frame: wordmark, destinations, footer. */
export const AdminRail = forwardRef<HTMLElement, AdminRailProps>(function AdminRail(
  { mode = 'full', homeHref = '/admin', nav, footer, className, 'aria-label': ariaLabel, ...rest },
  ref,
) {
  const { t } = useI18n();
  return (
    <aside
      ref={ref}
      {...rest}
      className={cx('rail', mode === 'compact' && 'rail--compact', className)}
      data-surface="dark"
      aria-label={ariaLabel ?? t('common.staff.nav')}
    >
      <a className="wordmark" href={homeHref} onClick={linkHandler} aria-label={t('common.staff.home')}>
        <span className="wordmark__name" aria-hidden="true" lang="en">Rabbit Grill</span>
        <span className="wordmark__sub" aria-hidden="true" lang="en">Khao Yai · Staff</span>
      </a>
      {nav}
      {footer}
    </aside>
  );
});

export interface RailFooterProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  alertsOn: boolean;
  onAlertsChange?: (next: boolean) => void;
  onTestAlert?: () => void;
  /** Lock screen: a callback (button) or a link. */
  onLock?: () => void;
  lockHref?: string;
  lang: Locale;
  onLangChange: (lang: Locale) => void;
  /** "Thu 17 Sep 2026" */
  dateLabel?: string;
  timeZone?: string;
}

/** Rail foot: alerts toggle + Test, lock screen, language box, service date and time zone. */
export const RailFooter = forwardRef<HTMLDivElement, RailFooterProps>(function RailFooter(
  { alertsOn, onAlertsChange, onTestAlert, onLock, lockHref, lang, onLangChange, dateLabel, timeZone, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  return (
    <div ref={ref} {...rest} className={cx('rail__foot', className)}>
      <div className="rail__row">
        <button
          type="button"
          className="rail__switch"
          aria-pressed={alertsOn}
          onClick={() => onAlertsChange?.(!alertsOn)}
          disabled={!onAlertsChange}
        >
          <Ico name="sound" className={alertsOn ? undefined : 'is-muted'} />
          <span>{alertsOn ? t('common.staff.alertsOn') : t('common.staff.alertsOff')}</span>
        </button>
        {onTestAlert ? (
          <button type="button" className="textbtn" onClick={onTestAlert} aria-label={t('common.staff.alertsTestLabel')}>
            {t('common.staff.alertsTest')}
          </button>
        ) : null}
      </div>
      {onLock ? (
        <button type="button" className="rail__row rail__row--link" onClick={onLock}>
          <Ico name="lock" />
          <span>{t('common.staff.lock')}</span>
        </button>
      ) : lockHref ? (
        <a className="rail__row rail__row--link" href={lockHref} onClick={linkHandler}>
          <Ico name="lock" />
          <span>{t('common.staff.lock')}</span>
        </a>
      ) : null}
      {/* Deliberately bilingual: whoever cannot read the current language can still find the switch. */}
      <SegmentedControl<Locale>
        tone="box"
        label={lang === 'th' ? 'ภาษา · Language' : 'Language · ภาษา'}
        value={lang}
        onChange={onLangChange}
        options={[
          { value: 'th', label: 'ไทย', lang: 'th' },
          { value: 'en', label: 'EN', lang: 'en', ariaLabel: 'English' },
        ]}
      />
      {dateLabel || timeZone ? (
        <p className="rail__time">
          {dateLabel}
          {dateLabel && timeZone ? <br /> : null}
          {timeZone ? <span lang="en">{timeZone}</span> : null}
        </p>
      ) : null}
    </div>
  );
});
