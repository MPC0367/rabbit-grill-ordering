// Staff layout (DESIGN §8.2): charcoal rail with the five destinations on
// desktop, the compact 84 px rail on tablets, and a bottom bar with the same
// five groups on phones. The workspace header carries the destination title,
// its routed subtabs, the Demo data stamp, the connection pill, the guest
// ordering control and the staff identity.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Locale } from '../../../../shared/settings.ts';
import { TIMEZONE, todayBusinessDate } from '../../../../shared/time.ts';
import { dateLabel } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive, type WireEvent } from '../../lib/live.tsx';
import { useRoute } from '../../lib/router.ts';
import { useNow } from '../../lib/store.ts';
import {
  AdminRail, announce, Banner, ConnectionIndicator, RailFooter, RailNav, SubTabs, useToast, WorkspaceHeader,
  type RailItem, type SubTabItem,
} from '../../ui/index.ts';
import { useAttention } from './attention.tsx';
import { IdentityMenu } from './IdentityMenu.tsx';
import { useLayoutMode } from './layout-mode.ts';
import { HeaderOrderingControl, PausedBanner, useOrderingActions } from './ordering.tsx';
import { DESTINATIONS, destHref, savedStart, setSavedStart, visibleTabs, type AreaId } from './routes.tsx';
import { useSessionState, useStaff } from './session.tsx';
import { useAlertSound, useOrderAlerts, type AlertKind } from './sound.ts';
import './shell.css';

export interface AdminLayoutProps {
  /** Destination the page belongs to (null: not found). */
  area: AreaId | null;
  tab?: string;
  /** Page identity: focus moves to the page heading when it changes. */
  pageKey: string;
  /** i18n key of the page name, for the document title. */
  pageTitle: string;
  /** The page can be saved as this person's start page. */
  startable: boolean;
  children: ReactNode;
}

export function AdminLayout({ area, tab, pageKey, pageTitle, startable, children }: AdminLayoutProps) {
  const { t, lang, setLang } = useI18n();
  const { me, can, canAny } = useStaff();
  const session = useSessionState();
  const live = useLive();
  const toast = useToast();
  const mode = useLayoutMode();
  const sound = useAlertSound();
  const attention = useAttention();
  const ordering = useOrderingActions();
  const { path, query } = useRoute();
  useNow(60_000); // re-render each minute so the rail date turns over at midnight
  const data = attention.data;

  // ------------------------------------------------------------ attention counts
  const handlesRequests = can('service.handle');
  const rounds = data?.unaccepted_rounds ?? 0;
  const requests = handlesRequests ? (data?.open_requests ?? 0) : 0;
  const badge = rounds + requests;
  const badgeWords = [
    rounds ? t('admin.badge.rounds', { n: rounds }) : null,
    requests ? t('admin.badge.requests', { n: requests }) : null,
  ].filter(Boolean).join(', ');

  const navItems = useMemo<RailItem[]>(() => DESTINATIONS.flatMap((d) => {
    const href = destHref(d, canAny);
    if (!href) return [];
    return [{
      id: d.id,
      label: t(d.label),
      href,
      icon: d.icon,
      current: area === d.id,
      count: d.id === 'orders' ? badge : undefined,
      countLabel: d.id === 'orders' ? badgeWords : undefined,
    }];
  }), [canAny, t, area, badge, badgeWords]);

  const dest = area && area !== 'overview' ? DESTINATIONS.find((d) => d.id === area) : undefined;
  const tabs = useMemo<SubTabItem[]>(() => {
    if (!dest) return [];
    return visibleTabs(dest, canAny).map((tb) => ({
      id: tb.id,
      label: t(tb.label),
      href: tb.href,
      current: tb.id === tab,
      count: dest.id === 'orders' && tb.id === 'requests' ? requests : undefined,
      countLabel: dest.id === 'orders' && tb.id === 'requests' ? t('admin.badge.requests', { n: requests }) : undefined,
    }));
  }, [dest, canAny, t, tab, requests]);
  const showTabs = tabs.length > 1;

  const title = area === 'overview' ? t('admin.dest.overview') : dest ? t(dest.label) : t('admin.notFound.header');

  // ------------------------------------------------------------ document title
  useEffect(() => {
    const name = t(pageTitle);
    document.title = `${badge ? `(${badge}) ` : ''}${name} · ${t('admin.docTitle')}`;
  }, [badge, pageTitle, t]);

  // ------------------------------------------------------------ alerts
  const onOrdersPage = path.startsWith('/admin/orders');
  const onAlert = useCallback((kind: AlertKind, e: WireEvent) => {
    // The board announces its own tickets; elsewhere the shell says what arrived.
    if (onOrdersPage) return;
    const table = typeof e.payload.table_label === 'string' ? e.payload.table_label : null;
    let words: string;
    if (kind === 'order') {
      const round = typeof e.payload.round_no === 'number' ? e.payload.round_no : null;
      words = table && round ? t('admin.alert.order', { table, round }) : t('admin.alert.orderShort');
    } else if (e.topic === 'portion.updated') {
      words = t('admin.alert.portion');
    } else {
      const type = typeof e.payload.type === 'string' ? t(`service.${e.payload.type}`) : t('admin.alert.requestShort');
      words = table ? t('admin.alert.request', { table, type }) : type;
    }
    announce(words, 'polite');
  }, [onOrdersPage, t]);
  useOrderAlerts({ can, serverTime: data?.server_time, onAlert });

  const testSound = useCallback(() => {
    void sound.testNow().then((ok) => {
      toast.show(ok
        ? { message: t('admin.sound.tested'), tone: 'info' }
        : { message: t('admin.sound.unavailable'), tone: 'error' });
    });
  }, [sound, toast, t]);

  // ------------------------------------------------------------ session health
  const authError = attention.error && (attention.error.status === 401 || attention.error.code === 'auth_required');
  useEffect(() => { if (authError) void session.check(); }, [authError, session.check]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevLive = useRef(live.state);
  useEffect(() => {
    // The stream dropped: make sure the session itself is still valid.
    if (live.state === 'reconnecting' && prevLive.current !== 'reconnecting') void session.check();
    prevLive.current = live.state;
  }, [live.state, session.check]); // eslint-disable-line react-hooks/exhaustive-deps

  const lock = useCallback(() => { void session.signOut('locked'); }, [session.signOut]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ start page
  const here = `${path}${query.toString() ? `?${query.toString()}` : ''}`;
  const [saved, setSaved] = useState(() => savedStart(me.user.id));
  const start = {
    isCurrent: saved === here,
    canSet: startable,
    onToggle: () => {
      const next = saved === here ? null : here;
      setSavedStart(me.user.id, next);
      setSaved(next);
      toast.show({ message: next ? t('admin.account.startSaved', { page: t(pageTitle) }) : t('admin.account.startCleared'), tone: 'info' });
    },
  };

  // ------------------------------------------------------------ focus on route change
  useRouteFocus(pageKey, area, t(pageTitle));

  const skip = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const main = document.getElementById('main');
    main?.focus();
    main?.scrollIntoView({ block: 'start' });
  };

  const showOrderingControl = (area === 'overview' || area === 'orders') && mode !== 'bar' && (mode === 'full' || ordering.canChange);
  const today = dateLabel(todayBusinessDate(), lang, { weekday: true, year: true });

  const identity = (
    <IdentityMenu full={mode === 'bar'} sound={sound} onTestSound={testSound} onLock={lock} start={start} />
  );

  return (
    <div className={`a-app ashell ashell--${mode}${mode === 'compact' ? ' a-app--compact' : ''}`}>
      <a className="skip" href="#main" onClick={skip}>{t('admin.skip')}</a>
      {mode !== 'bar' ? (
        <AdminRail
          mode={mode === 'compact' ? 'compact' : 'full'}
          homeHref="/admin"
          nav={<RailNav items={navItems} mode={mode === 'compact' ? 'compact' : 'full'} />}
          footer={(
            <RailFooter
              alertsOn={sound.enabled}
              onAlertsChange={sound.setEnabled}
              onTestAlert={testSound}
              onLock={lock}
              lang={lang}
              onLangChange={(l: Locale) => setLang(l)}
              dateLabel={today}
              timeZone={TIMEZONE}
            />
          )}
        />
      ) : null}
      <div className="ws">
        <WorkspaceHeader
          title={title}
          tabs={showTabs && mode !== 'bar' ? tabs : undefined}
          tabsLabel={t('admin.tabsLabel', { title })}
          compact={mode !== 'full'}
          demo={me.operating_mode === 'demo'}
          connection={<ConnectionIndicator variant="staff" stale={attention.stale} />}
          ordering={showOrderingControl ? <HeaderOrderingControl /> : undefined}
          identity={identity}
        />
        {showTabs && mode === 'bar' ? (
          <SubTabs className="subtabs--bar ashell__tabs" items={tabs} label={t('admin.tabsLabel', { title })} />
        ) : null}
        <div className="ashell__banners">
          {live.state === 'offline' ? (
            <Banner variant="offline" staff title={t('admin.offline.title')}>{t('admin.offline.body')}</Banner>
          ) : null}
          <PausedBanner withAction={!showOrderingControl || !ordering.canChange} />
        </div>
        <main id="main" tabIndex={-1} className="ashell__main">
          {children}
        </main>
      </div>
      {mode === 'bar' ? (
        <RailNav
          mode="bar"
          fixed
          items={navItems}
          className="ashell__bar"
          style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}
        />
      ) : null}
    </div>
  );
}

/**
 * After a navigation to a different page, move focus to that page's heading
 * (its own h1 in <main>, else the workspace title) so keyboard and screen
 * reader users start at the top of the new content. Switching subtabs from
 * the tab bar keeps focus on the tab and announces the page instead.
 */
function useRouteFocus(pageKey: string, area: AreaId | null, spoken: string) {
  // Compare with the last page rather than a first-render flag: StrictMode runs
  // mount effects twice, and the initial load must leave focus alone.
  const lastKey = useRef(pageKey);
  const lastArea = useRef(area);
  useEffect(() => {
    if (lastKey.current === pageKey) return;
    lastKey.current = pageKey;
    const sameArea = lastArea.current === area;
    lastArea.current = area;
    const active = document.activeElement as HTMLElement | null;
    if (sameArea && active?.closest('.subtabs')) {
      announce(spoken, 'polite');
      return;
    }
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const main = document.getElementById('main');
      // Wait for a lazily loaded page to replace the placeholder (up to ~2 s).
      if (main?.querySelector('.apanel--loading') && tries++ < 120) {
        raf = requestAnimationFrame(attempt);
        return;
      }
      // A page that opened its own dialog or drawer keeps that focus.
      if (document.querySelector('dialog[open]')) return;
      const target = main?.querySelector<HTMLElement>('h1') ?? document.querySelector<HTMLElement>('.wshead h1');
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps
}
