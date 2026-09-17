// Staff routing table (docs/CLIENT.md) and the five destinations (brief 33).
// Routes stay granular for deep links; the visible navigation is only
// Orders, Tables, Menu, Insights and More, each filtered by permission.
import { lazy, type ReactNode } from 'react';
import type { Permission } from '../../../../shared/permissions.ts';
import type { AdminIconName } from '../../ui/admin/index.ts';
import { matchPath } from '../../lib/router.ts';
import { storage } from '../../lib/store.ts';

const OverviewPage = lazy(() => import('./OverviewPage.tsx'));
const OrdersPage = lazy(() => import('../orders/OrdersPage.tsx'));
const TablesPage = lazy(() => import('../tables/TablesPage.tsx'));
const QrPrintPage = lazy(() => import('../tables/QrPrintPage.tsx'));
const MenuPage = lazy(() => import('../menu/MenuPage.tsx'));
const InsightsPage = lazy(() => import('../insights/InsightsPage.tsx'));
const MorePage = lazy(() => import('../more/MorePage.tsx'));
const PaymentsPage = lazy(() => import('../billing/PaymentsPage.tsx'));
const ReportsPage = lazy(() => import('../more/ReportsPage.tsx'));
const TeamPage = lazy(() => import('../more/TeamPage.tsx'));
const SettingsPage = lazy(() => import('../more/SettingsPage.tsx'));
const AuditPage = lazy(() => import('../more/AuditPage.tsx'));

export type DestId = 'orders' | 'tables' | 'menu' | 'insights' | 'more';
export type AreaId = DestId | 'overview';

export interface TabDef {
  id: string;
  /** i18n key */
  label: string;
  href: string;
  /** Visible when the role has any of these. */
  perms: readonly Permission[];
}

export interface DestDef {
  id: DestId;
  label: string;
  icon: AdminIconName;
  tabs: readonly TabDef[];
  /** Where the destination itself points when not simply its first permitted tab. */
  home?: string;
}

const MENU_MANAGE: readonly Permission[] = ['menu.edit', 'menu.review', 'menu.publish'];

export const DESTINATIONS: readonly DestDef[] = [
  {
    id: 'orders',
    label: 'admin.dest.orders',
    icon: 'orders',
    tabs: [
      { id: 'board', label: 'admin.tab.board', href: '/admin/orders', perms: ['orders.view'] },
      { id: 'requests', label: 'admin.tab.requests', href: '/admin/orders/requests', perms: ['service.handle', 'portions.quote'] },
      { id: 'history', label: 'admin.tab.history', href: '/admin/orders?view=history', perms: ['orders.view'] },
    ],
  },
  {
    id: 'tables',
    label: 'admin.dest.tables',
    icon: 'tables',
    // One header tab: the Tables page switches its own Live / Manage views, and the
    // QR print sheet (/admin/tables/print) is opened from there.
    tabs: [
      { id: 'live', label: 'admin.tab.floor', href: '/admin/tables', perms: ['tables.view'] },
    ],
  },
  {
    id: 'menu',
    label: 'admin.dest.menu',
    icon: 'cutlery',
    tabs: [
      { id: 'availability', label: 'admin.tab.availability', href: '/admin/menu', perms: ['menu.availability'] },
      { id: 'catalog', label: 'admin.tab.catalog', href: '/admin/menu/catalog', perms: MENU_MANAGE },
      // Everyone who manages the menu sees the queue; only menu.review can act in it (C6 hides the actions).
      { id: 'review', label: 'admin.tab.review', href: '/admin/menu/review', perms: MENU_MANAGE },
      { id: 'import', label: 'admin.tab.import', href: '/admin/menu/import', perms: ['menu.import'] },
    ],
  },
  {
    id: 'insights',
    label: 'admin.dest.insights',
    icon: 'bars',
    tabs: [
      { id: 'orders', label: 'admin.tab.orderStats', href: '/admin/stats/orders', perms: ['stats.view'] },
      { id: 'menu', label: 'admin.tab.menuStats', href: '/admin/stats/menu', perms: ['stats.view'] },
      { id: 'engagement', label: 'admin.tab.engagement', href: '/admin/stats/engagement', perms: ['stats.engagement'] },
    ],
  },
  {
    id: 'more',
    label: 'admin.dest.more',
    icon: 'more',
    home: '/admin/more',
    tabs: [
      { id: 'payments', label: 'admin.tab.payments', href: '/admin/payments', perms: ['payments.view'] },
      { id: 'reports', label: 'admin.tab.reports', href: '/admin/reports', perms: ['reports.view'] },
      { id: 'team', label: 'admin.tab.team', href: '/admin/team', perms: ['team.manage'] },
      { id: 'settings', label: 'admin.tab.settings', href: '/admin/settings', perms: ['settings.manage'] },
      { id: 'audit', label: 'admin.tab.audit', href: '/admin/audit', perms: ['audit.view'] },
    ],
  },
];

export type CanAny = (perms: readonly Permission[]) => boolean;

export function visibleTabs(dest: DestDef, canAny: CanAny): TabDef[] {
  return dest.tabs.filter((tab) => canAny(tab.perms));
}

export function destHref(dest: DestDef, canAny: CanAny): string | null {
  const tabs = visibleTabs(dest, canAny);
  if (tabs.length === 0) return null;
  return dest.home ?? tabs[0].href;
}

export function destination(id: DestId): DestDef {
  return DESTINATIONS.find((d) => d.id === id)!;
}

// ---------------------------------------------------------------- routes
export type RouteMatch =
  | {
      kind: 'page';
      /** Page identity: focus moves to the new page's h1 only when this changes. */
      key: string;
      area: AreaId;
      /** Current subtab id within the destination. */
      tab?: string;
      /** i18n key of the page title (document title; the header shows the destination). */
      title: string;
      /** Allowed when the role has any of these; empty = anyone signed in. */
      perms: readonly Permission[];
      render: () => ReactNode;
    }
  | { kind: 'redirect'; to: string }
  | { kind: 'login' }
  | { kind: 'notfound' };

type PageRoute = Extract<RouteMatch, { kind: 'page' }>;

function page(key: string, area: AreaId, title: string, perms: readonly Permission[], render: () => ReactNode, tab?: string): PageRoute {
  return { kind: 'page', key, area, tab, title, perms, render };
}

/** Every signed-in role (More's account section, own password). */
const ANYONE: readonly Permission[] = [];

/** May this role open the page? */
export function allowed(route: { perms: readonly Permission[] }, canAny: CanAny): boolean {
  return route.perms.length === 0 || canAny(route.perms);
}

/** Resolve an /admin path. Trailing slashes and the documented aliases redirect to the canonical URL. */
export function resolveRoute(rawPath: string, search = ''): RouteMatch {
  if (rawPath.length > 6 && rawPath.endsWith('/')) return { kind: 'redirect', to: rawPath.replace(/\/+$/, '') + search };
  const path = rawPath;
  switch (path) {
    case '/admin/login': return { kind: 'login' };
    case '/admin': return page('overview', 'overview', 'admin.page.overview', ['orders.view'], () => <OverviewPage />);
    case '/admin/orders':
      // The board's history view (C4b) lives on the same page under ?view=history.
      if (new URLSearchParams(search).get('view') === 'history') {
        return page('orders:history', 'orders', 'admin.page.history', ['orders.view'], () => <OrdersPage tab="board" />, 'history');
      }
      return page('orders:board', 'orders', 'admin.page.board', ['orders.view'], () => <OrdersPage tab="board" />, 'board');
    case '/admin/orders/requests': return page('orders:requests', 'orders', 'admin.page.requests', ['service.handle', 'portions.quote'], () => <OrdersPage tab="requests" />, 'requests');
    case '/admin/service': return { kind: 'redirect', to: `/admin/orders/requests${search}` };
    case '/admin/tables': return page('tables', 'tables', 'admin.page.tables', ['tables.view'], () => <TablesPage />, 'live');
    case '/admin/tables/print': return page('tables:print', 'tables', 'admin.page.qr', ['tables.view'], () => <QrPrintPage />, 'qr');
    case '/admin/menu': return page('menu:availability', 'menu', 'admin.page.availability', ['menu.availability'], () => <MenuPage tab="availability" />, 'availability');
    case '/admin/menu/catalog': return page('menu:catalog', 'menu', 'admin.page.catalog', MENU_MANAGE, () => <MenuPage tab="catalog" />, 'catalog');
    case '/admin/menu/review': return page('menu:review', 'menu', 'admin.page.review', MENU_MANAGE, () => <MenuPage tab="review" />, 'review');
    case '/admin/menu/import': return page('menu:import', 'menu', 'admin.page.import', ['menu.import'], () => <MenuPage tab="import" />, 'import');
    case '/admin/insights':
    case '/admin/stats': return { kind: 'redirect', to: '/admin/stats/orders' };
    case '/admin/stats/orders': return page('insights:orders', 'insights', 'admin.page.orderStats', ['stats.view'], () => <InsightsPage tab="orders" />, 'orders');
    case '/admin/stats/menu': return page('insights:menu', 'insights', 'admin.page.menuStats', ['stats.view'], () => <InsightsPage tab="menu" />, 'menu');
    case '/admin/stats/engagement': return page('insights:engagement', 'insights', 'admin.page.engagement', ['stats.engagement'], () => <InsightsPage tab="engagement" />, 'engagement');
    case '/admin/more': return page('more', 'more', 'admin.page.more', ANYONE, () => <MorePage />);
    case '/admin/payments': return page('more:payments', 'more', 'admin.page.payments', ['payments.view'], () => <PaymentsPage />, 'payments');
    case '/admin/reports': return page('more:reports', 'more', 'admin.page.reports', ['reports.view'], () => <ReportsPage />, 'reports');
    case '/admin/team':
      // ?self=1 is the password change every signed-in person can reach.
      if (new URLSearchParams(search).get('self') === '1') return page('more:password', 'more', 'admin.page.password', ANYONE, () => <TeamPage />);
      return page('more:team', 'more', 'admin.page.team', ['team.manage'], () => <TeamPage />, 'team');
    case '/admin/settings': return page('more:settings', 'more', 'admin.page.settings', ['settings.manage'], () => <SettingsPage />, 'settings');
    case '/admin/audit': return page('more:audit', 'more', 'admin.page.audit', ['audit.view'], () => <AuditPage />, 'audit');
    default: break;
  }
  const table = matchPath('/admin/tables/:id', path);
  if (table && table.id !== 'print') {
    const id = table.id;
    // Same page key as /admin/tables: opening the drawer keeps focus with the drawer.
    return page('tables', 'tables', 'admin.page.tables', ['tables.view'], () => <TablesPage tableId={id} />, 'live');
  }
  const item = matchPath('/admin/menu/items/:id', path);
  if (item) {
    const id = item.id;
    return page('menu:catalog', 'menu', 'admin.page.catalog', MENU_MANAGE, () => <MenuPage tab="catalog" itemId={id} />, 'catalog');
  }
  return { kind: 'notfound' };
}

// ---------------------------------------------------------------- landing
const START_KEY = (userId: string) => `rg.admin.start.${userId}`;

/** A start page this person chose on this device (brief 33: "owner opens their saved view"). */
export function savedStart(userId: string): string | null {
  const v = storage.get<string | null>(START_KEY(userId), null);
  return typeof v === 'string' && isAdminPath(v) ? v : null;
}

export function setSavedStart(userId: string, path: string | null): void {
  if (path) storage.set(START_KEY(userId), path);
  else storage.remove(START_KEY(userId));
}

export function isAdminPath(p: string): boolean {
  return (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/admin?')) && !p.startsWith('/admin/login') && !p.startsWith('//');
}

/** Is `path` (with an optional query) a page this role can open? */
export function canOpen(path: string, canAny: CanAny): boolean {
  const url = new URL(path, 'http://x');
  let r = resolveRoute(url.pathname, url.search);
  for (let i = 0; i < 3 && r.kind === 'redirect'; i++) {
    const next = new URL(r.to, 'http://x');
    r = resolveRoute(next.pathname, next.search);
  }
  return r.kind === 'page' && allowed(r, canAny);
}

/** Where this person starts: a saved page they can still open, else the role landing from /me. */
export function landingFor(userId: string, roleLanding: string, canAny: CanAny): string {
  const saved = savedStart(userId);
  if (saved && canOpen(saved, canAny)) return saved;
  if (canOpen(roleLanding, canAny)) return roleLanding;
  // Role overrides can remove a landing permission: take the first destination left.
  for (const d of DESTINATIONS) {
    const href = destHref(d, canAny);
    if (href && canOpen(href, canAny)) return href;
  }
  return '/admin';
}
