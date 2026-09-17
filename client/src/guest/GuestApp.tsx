// Guest interface (docs/CLIENT.md): providers and routes.
//
//   /              → /menu (replace)
//   /menu          MenuPage
//   /q/:token      JoinPage
//   /menu/cart     CartPage
//   /menu/orders   TrackPage
//   /menu/bill     BillPage
//   anything else  a friendly not-found page
//   mode 'ended'   VisitEndedPage on the visit routes (cart, orders, bill)
//
// Provider order: session → catalog → toasts → live (joined only) → sheets.
// The live stream is always mounted with url = null for public visitors, so
// joining never remounts the page underneath.
import '../i18n/guest-bundle.ts';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useConfig } from '../lib/config.tsx';
import { useI18n } from '../lib/i18n.tsx';
import { LiveProvider } from '../lib/live.tsx';
import { navigate, useRoute } from '../lib/router.ts';
import { ToastProvider } from '../ui/index.ts';
import { bindCart } from './cart/store.ts';
import MenuPage from './menu/MenuPage.tsx';
import { CatalogProvider } from './shell/catalog.tsx';
import { ErrorBoundary } from './shell/ErrorBoundary.tsx';
import { GuestShell } from './shell/GuestShell.tsx';
import { resolveGuestRoute, useGuestTracker, VISIT_ROUTES, type GuestRouteKey } from './shell/hooks.ts';
import { GuestLiveBridge } from './shell/live-bridge.tsx';
import { OverlayProvider } from './shell/overlays.tsx';
import { NotFoundPage, PageErrorPanel, PageLoading } from './shell/pages.tsx';
import { GuestSessionProvider, useGuestSession } from './shell/session.tsx';

const CartPage = lazy(() => import('./cart/CartPage.tsx'));
const JoinPage = lazy(() => import('./visit/JoinPage.tsx'));
const TrackPage = lazy(() => import('./visit/TrackPage.tsx'));
const BillPage = lazy(() => import('./visit/BillPage.tsx'));
const VisitEndedPage = lazy(() => import('./visit/VisitEndedPage.tsx'));

export default function GuestApp() {
  return (
    <GuestSessionProvider>
      <CatalogProvider>
        <ToastProvider>
          <GuestLive>
            <OverlayProvider>
              <GuestRoutes />
            </OverlayProvider>
          </GuestLive>
        </ToastProvider>
      </CatalogProvider>
    </GuestSessionProvider>
  );
}

/** One live stream while joined. A different visit (no gap in between) gets a fresh stream and tree. */
function GuestLive({ children }: { children: ReactNode }) {
  const { mode, session, markEnded } = useGuestSession();
  const visitId = mode === 'joined' && session ? session.visit.id : null;
  const [generation, setGeneration] = useState(0);
  const lastVisit = useRef<string | null>(null);
  useEffect(() => {
    if (visitId && lastVisit.current && lastVisit.current !== visitId) setGeneration((g) => g + 1);
    if (visitId) lastVisit.current = visitId;
    else if (mode !== 'loading') lastVisit.current = null;
  }, [visitId, mode]);
  return (
    <LiveProvider key={generation} url={visitId ? '/api/guest/events' : null} onEnded={() => markEnded()}>
      <GuestLiveBridge />
      {children}
    </LiveProvider>
  );
}

const TITLE_KEY: Record<GuestRouteKey, string> = {
  root: 'shell.title.menu',
  menu: 'shell.title.menu',
  cart: 'shell.title.cart',
  track: 'shell.title.track',
  bill: 'shell.title.bill',
  join: 'shell.title.join',
  notFound: 'shell.title.notFound',
};

function GuestRoutes() {
  const { path, query } = useRoute();
  const route = resolveGuestRoute(path);
  const { mode, session } = useGuestSession();
  const { t, pick, lang } = useI18n();
  const { config } = useConfig();
  const ended = mode === 'ended' && VISIT_ROUTES.has(route.key);

  // '/' → '/menu' (keep any query, e.g. ?lang=)
  useEffect(() => {
    if (route.key !== 'root') return;
    const qs = query.toString();
    navigate(`/menu${qs ? `?${qs}` : ''}`, { replace: true, keepScroll: true });
  }, [route.key, query]);

  // The device draft follows the visit (C1b clears drafts of visits that ended).
  const visitId = mode === 'joined' && session ? session.visit.id : null;
  const guestId = mode === 'joined' && session ? session.guest_id : null;
  useEffect(() => {
    if (mode === 'loading') return;
    bindCart(visitId, guestId);
  }, [mode, visitId, guestId]);

  useGuestTracker(route.key, ended);

  // Document title: "เมนู · โต๊ะ 07 · Rabbit Grill เขาใหญ่"
  const table = mode === 'joined' && session ? session.visit.table_label : null;
  const restaurantName = config
    ? pick({ th: config.restaurant.name_th, en: config.restaurant.name_en }).text
    : t('common.restaurant');
  const pageTitle = t(ended ? 'shell.title.ended' : TITLE_KEY[route.key]);
  useEffect(() => {
    document.title = table
      ? t('shell.docTitleTable', { page: pageTitle, table, restaurant: restaurantName })
      : t('shell.docTitle', { page: pageTitle, restaurant: restaurantName });
  }, [pageTitle, table, restaurantName, lang, t]);

  // Scroll: the app restores positions itself (the menu keeps one per group).
  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return;
    const prev = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = prev; };
  }, []);

  // Route change: top of the new page (the menu restores its own spot), and
  // focus moves to the new page's heading so screen readers announce it.
  const pageKey = `${route.key === 'root' ? 'menu' : route.key}|${ended ? 'ended' : ''}`;
  const shownKey = useRef(pageKey);
  useLayoutEffect(() => {
    // Compare keys (not a first-run flag): StrictMode runs effects twice on mount.
    if (shownKey.current === pageKey) return;
    shownKey.current = pageKey;
    if (route.key !== 'menu') window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    let frames = 0;
    let raf = 0;
    const focusHeading = () => {
      const root = document.getElementById('main');
      const h1 = root?.querySelector<HTMLElement>('h1');
      if (!h1 && frames++ < 90) { raf = requestAnimationFrame(focusHeading); return; }
      if (document.querySelector('dialog[open]')) return; // a sheet owns focus
      const target = h1 ?? root;
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    };
    raf = requestAnimationFrame(focusHeading);
    return () => cancelAnimationFrame(raf);
  }, [pageKey]);

  let page: ReactNode;
  if (ended) page = <VisitEndedPage />;
  else {
    switch (route.key) {
      case 'root':
      case 'menu': page = <MenuPage />; break;
      case 'cart': page = <CartPage />; break;
      case 'track': page = <TrackPage />; break;
      case 'bill': page = <BillPage />; break;
      case 'join': page = <JoinPage token={route.token ?? ''} />; break;
      default: page = <NotFoundPage />;
    }
  }

  return (
    <GuestShell route={route.key === 'root' ? 'menu' : route.key}>
      <ErrorBoundary resetKey={pageKey} fallback={() => <PageErrorPanel onRetry={() => window.location.reload()} />}>
        <Suspense fallback={<PageLoading />}>
          {page}
        </Suspense>
      </ErrorBoundary>
    </GuestShell>
  );
}
