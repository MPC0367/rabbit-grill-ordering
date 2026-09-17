// Menu destination (C6): Availability · Catalog · Review · Import, plus the
// item editor at /admin/menu/items/:id. Contract: docs/CLIENT.md.
import './menu.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Permission } from '../../../../shared/permissions.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { EmptyState, SubTabs, type SubTabItem } from '../../ui/index.ts';
import { MenuDataProvider, TAB_HREF, useCan, type MenuTab } from './model.tsx';
import AvailabilityTab from './AvailabilityTab.tsx';
import CatalogTab from './CatalogTab.tsx';
import ReviewTab from './ReviewTab.tsx';
import ImportTab from './ImportTab.tsx';
import ItemEditor from './ItemEditor.tsx';

export interface MenuPageProps {
  tab: MenuTab;
  itemId?: string;
}

const CATALOG_ROLES: Permission[] = ['menu.edit', 'menu.publish', 'menu.review', 'menu.import'];

/** Which subtabs a role sees. Kitchen and floor keep a service-only view; deep links still render read-only. */
export function visibleMenuTabs(can: (p: Permission) => boolean): MenuTab[] {
  const tabs: MenuTab[] = ['availability'];
  const manages = CATALOG_ROLES.some((p) => can(p));
  if (manages) tabs.push('catalog', 'review');
  if (can('menu.import')) tabs.push('import');
  return tabs;
}

export default function MenuPage({ tab, itemId }: MenuPageProps) {
  const { t } = useI18n();
  const can = useCan();
  const tabs = visibleMenuTabs(can);
  const hostTabs = useHostHasTabs(`${tab}|${itemId ?? ''}`);
  useFocusOnViewChange(`${tab}|${itemId ?? ''}`);

  if (!can('menu.view')) {
    return (
      <div className="mn mn--pad">
        <EmptyState icon="lock" title={t('catalog.denied.title')} headingLevel={2}>
          {t('catalog.denied.body')}
        </EmptyState>
      </div>
    );
  }

  const items: SubTabItem[] = tabs.map((id) => ({
    id,
    label: t(`catalog.tab.${id}`),
    href: TAB_HREF[id],
    current: !itemId && id === tab,
  }));

  return (
    <MenuDataProvider>
      <div className="mn" data-view={itemId ? 'editor' : tab}>
        {!hostTabs && tabs.length > 1 ? (
          <SubTabs className="subtabs--bar mn-tabs" items={items} label={t('catalog.tabsLabel')} />
        ) : null}
        {itemId ? (
          <ItemEditor itemId={itemId} />
        ) : tab === 'catalog' ? (
          <CatalogTab />
        ) : tab === 'review' ? (
          <ReviewTab />
        ) : tab === 'import' ? (
          can('menu.import') ? <ImportTab /> : <NoImport />
        ) : (
          <AvailabilityTab />
        )}
      </div>
    </MenuDataProvider>
  );
}

function NoImport() {
  const { t } = useI18n();
  return (
    <section className="mn-pad" aria-labelledby="mn-noimport">
      <h2 id="mn-noimport" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.tab.import')}</h2>
      <EmptyState icon="lock" title={t('catalog.import.deniedTitle')}>{t('catalog.import.deniedBody')}</EmptyState>
    </section>
  );
}

/**
 * The admin layout (C4a) owns the workspace header and normally renders the
 * Menu subtabs there. If it does not, this page shows its own row so every
 * view stays reachable without typing a URL.
 */
function useHostHasTabs(key: string): boolean {
  const [has, setHas] = useState(false);
  useLayoutEffect(() => {
    const check = () => setHas(Boolean(document.querySelector('.subtabs:not(.mn-tabs) a[href^="/admin/menu"]')));
    check();
    const late = window.setTimeout(check, 600);
    return () => window.clearTimeout(late);
  }, [key]);
  return has;
}

/**
 * After an in-page navigation (catalog to editor and back), move focus to the
 * new view's heading. Not on first load, not while a dialog is open, and not
 * when the person switched views from the subtab bar (the shell keeps focus
 * there and announces the page).
 */
function useFocusOnViewChange(key: string): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest('.subtabs') || document.querySelector('dialog[open]')) return;
    const el = document.querySelector<HTMLElement>('.mn [data-menu-focus]');
    el?.focus({ preventScroll: true });
  }, [key]);
}
