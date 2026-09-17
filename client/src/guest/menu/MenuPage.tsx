// The guest Menu (DESIGN §8.1, §10.4–10.6; brief 09, 33, 34, 39, 42).
//
// Phone/tablet: tool row (search + Food/Drinks), sticky category row with
// "ทุกหมวด", printed-menu sections of DishRows (two columns on tablet).
// Desktop: sticky group switch + category sidebar | menu column with search |
// persistent order panel.
//
// Search matches Thai and English dish names (and category names) across
// both groups; Thai text is never altered and nothing filters mid-IME.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import { setCategoryVisible, useCategoryView } from '../../lib/tracker.ts';
import {
  AllCategoriesSheet, Banner, Button, CategoryRow, CategorySidebar, EmptyState, MenuSection, SearchField,
  SegmentedControl, Skeleton, SkeletonDishRow, Tag, useToast,
  type CategoryListGroup, type CategoryTab,
} from '../../ui/index.ts';
import { useOrderingState } from '../cart/ordering.ts';
import { noteCatalogVersion, useCart, type AddResult } from '../cart/store.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { AnalyticsNotice } from '../shell/AnalyticsNotice.tsx';
import { ReconnectSlot } from '../shell/GuestShell.tsx';
import { useOnline } from '../shell/hooks.ts';
import { useOverlays } from '../shell/overlays.tsx';
import { useGuestSession } from '../shell/session.tsx';
import { DeskOrderPanel } from './DeskOrderPanel.tsx';
import { RowActionsContext, type MenuRowActions, type RowAccess } from './actions.ts';
import { MenuDishRow } from './MenuDishRow.tsx';
import { buildMenu, searchMenu, type GroupKey, type MenuCategoryView, type MenuGroupView } from './model.ts';
import {
  menuMemory, saveMenuMemory, scrollToY, sectionTarget, stickyOffset, useCurrentSection, useRememberScroll,
} from './scroll.ts';
import './menu.css';

/** Rows in the first viewport load their photos eagerly. */
const EAGER_ROWS = 3;

export default function MenuPage() {
  const { t, pick, both, lang } = useI18n();
  const { config } = useConfig();
  const { catalog, error, stale, refresh, loading } = useCatalog();
  const { mode, session, error: sessionError } = useGuestSession();
  const overlays = useOverlays();
  const cart = useCart();
  const ordering = useOrderingState();
  const toast = useToast();
  const online = useOnline();
  const { hash } = useRoute();

  const model = useMemo(() => buildMenu(catalog, config?.sold_out_display), [catalog, config?.sold_out_display]);
  const ready = Boolean(catalog);

  useEffect(() => { noteCatalogVersion(catalog?.version); }, [catalog?.version]);

  // ------------------------------------------------------------ group + search state
  const [group, setGroup] = useState<GroupKey>(() => menuMemory.group ?? 'food');
  const [query, setQueryState] = useState(() => menuMemory.query);
  const [allOpen, setAllOpen] = useState(false);
  const [searchCleared, setSearchCleared] = useState(0);
  const sheetPick = useRef<string | null>(null);
  const searching = query.trim() !== '';
  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    menuMemory.query = q;
    saveMenuMemory();
  }, []);

  // A group with nothing published falls back to the other one (first load only).
  const settledGroup = useRef(false);
  useEffect(() => {
    if (!ready || settledGroup.current) return;
    settledGroup.current = true;
    const g = model.groups.find((x) => x.key === group);
    const other = model.groups.find((x) => x.key !== group && x.categories.length > 0);
    if (g && g.categories.length === 0 && other && menuMemory.group === null) {
      setGroup(other.key);
    }
  }, [ready, model, group]);

  const currentGroup: MenuGroupView | undefined = model.groups.find((g) => g.key === group);
  const sections = currentGroup?.categories ?? [];
  const anchors = useMemo(() => sections.map((s) => s.anchor), [sections]);

  // ------------------------------------------------------------ scroll: memory, spy, restore
  useRememberScroll(group, ready && !searching);
  const spy = useCurrentSection(anchors, ready && !searching);

  // Report the category the guest is reading (the tracker de-duplicates per session).
  const spiedCategory = spy.current ? model.byAnchor.get(spy.current)?.category.id ?? null : null;
  useEffect(() => { if (spiedCategory && !searching) setCategoryVisible(spiedCategory); }, [spiedCategory, searching]);

  const pending = useRef<{ anchor?: string; y?: number | null; focus?: boolean } | null>(null);
  const restored = useRef(false);

  const goToSection = useCallback((anchor: string, opts: { smooth: boolean; focus: boolean }) => {
    const y = sectionTarget(anchor);
    if (y === null) return;
    spy.select(anchor);
    scrollToY(y, opts.smooth);
    if (opts.focus) {
      const h = document.getElementById(`${anchor}-h`);
      if (h) {
        h.setAttribute('tabindex', '-1');
        h.focus({ preventScroll: true });
      }
    }
  }, [spy.select]);

  // First paint with content: back to where this group was (or a #category deep link).
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const fromHash = hash ? decodeURIComponent(hash.slice(1)) : '';
    const target = fromHash ? model.byAnchor.get(fromHash) : undefined;
    if (target && !searching) {
      if (target.group !== group) {
        pending.current = { anchor: target.anchor };
        setGroup(target.group);
        menuMemory.group = target.group;
      } else {
        goToSection(target.anchor, { smooth: false, focus: false });
      }
      return;
    }
    const y = menuMemory.y[group];
    if (!searching && y !== null && y > 0) scrollToY(y, false);
    // ready and model change together; restore once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // After a group switch renders: go to the requested section or the group's remembered spot.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (p.anchor) {
      goToSection(p.anchor, { smooth: false, focus: Boolean(p.focus) });
      return;
    }
    const list = document.getElementById('menu-list');
    const listTop = list ? list.getBoundingClientRect().top + window.scrollY - stickyOffset() - 8 : 0;
    if (typeof p.y === 'number') scrollToY(p.y, false);
    else if (window.scrollY > listTop) scrollToY(Math.max(0, listTop), false);
    spy.measure();
  }, [group, goToSection, spy.measure]);

  const switchGroup = useCallback((next: GroupKey, opts: { anchor?: string; focus?: boolean } = {}) => {
    if (searching) setQuery('');
    if (next === group) {
      if (opts.anchor) goToSection(opts.anchor, { smooth: true, focus: Boolean(opts.focus) });
      return;
    }
    if (!searching) menuMemory.y[group] = Math.round(window.scrollY);
    menuMemory.group = next;
    saveMenuMemory();
    pending.current = opts.anchor ? { anchor: opts.anchor, focus: opts.focus } : { y: menuMemory.y[next] };
    setGroup(next);
  }, [group, searching, setQuery, goToSection]);

  const selectCategory = useCallback((anchor: string) => {
    const view = model.byAnchor.get(anchor);
    if (!view) return;
    if (searching) {
      setQuery('');
      pending.current = { anchor, focus: true };
      if (view.group !== group) { menuMemory.group = view.group; setGroup(view.group); }
      else setSearchCleared((n) => n + 1);
      return;
    }
    if (view.group !== group) switchGroup(view.group, { anchor, focus: true });
    else goToSection(anchor, { smooth: true, focus: true });
  }, [model, searching, group, switchGroup, goToSection, setQuery]);

  // Leaving search in the same group: jump once the sections are back.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!searchCleared || !p?.anchor) return;
    pending.current = null;
    goToSection(p.anchor, { smooth: false, focus: Boolean(p.focus) });
  }, [searchCleared, goToSection]);

  // A category picked in the sheet: act once the sheet has closed (scroll lock and focus are back).
  useEffect(() => {
    if (allOpen || !sheetPick.current) return;
    const anchor = sheetPick.current;
    sheetPick.current = null;
    selectCategory(anchor);
  }, [allOpen, selectCategory]);

  // ------------------------------------------------------------ draft per dish
  const draft = useMemo(() => {
    const map = new Map<string, { qty: number; uids: string[]; frozen: boolean }>();
    for (const v of cart.views) {
      const e = map.get(v.line.item_id) ?? { qty: 0, uids: [], frozen: false };
      e.qty += v.line.quantity;
      e.uids.push(v.line.uid);
      e.frozen = e.frozen || v.frozen;
      map.set(v.line.item_id, e);
    }
    return map;
  }, [cart.views]);

  const access: RowAccess = mode === 'joined' ? 'order' : mode === 'loading' ? 'loading' : 'explain';

  // ------------------------------------------------------------ row actions (stable identity)
  const latest = useRef({ cart, overlays, toast, t, pick, sessionError, ordering });
  latest.current = { cart, overlays, toast, t, pick, sessionError, ordering };

  const actions = useMemo<MenuRowActions>(() => {
    const undoAdd = (res: AddResult) => {
      const { cart: c } = latest.current;
      const line = c.lines.find((l) => l.uid === res.uid);
      if (!line) return;
      if (res.merged && line.quantity - res.quantity >= 1) c.update(res.uid, { quantity: line.quantity - res.quantity });
      else c.remove(res.uid);
    };
    const focusRowControl = (itemId: string) => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const row = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
        row?.querySelector<HTMLElement>('.dish__foot button')?.focus({ preventScroll: true });
      });
    };
    return {
      quickAdd: (item) => {
        const { cart: c, toast: tt, t: tr, pick: pk, ordering: ord, overlays: ov } = latest.current;
        const name = pk(item.name).text;
        // Checking out: new dishes go through staff, as the dish sheet says. A
        // draft that could never be sent is not started (pauses keep drafts).
        if (ord.block?.code === 'visit_billing') {
          tt.show({
            tone: 'info',
            message: `${tr('cart.block.quickAdd')} · ${ord.block.body}`,
            action: { label: tr('cart.block.callStaff'), onClick: () => ov.openService() },
            duration: 6000,
          });
          return false;
        }
        let res: AddResult | null = null;
        try {
          res = c.add({ item_id: item.id, item, quantity: 1, quick_add: true });
        } catch (err) {
          console.error(err);
        }
        if (!res) {
          tt.show({ tone: 'error', message: tr('menu.addFailed', { name }) });
          return false;
        }
        if (res.quantity <= 0) {
          tt.show({ tone: 'info', message: tr('common.maxQty', { n: item.max_qty }) });
          return false;
        }
        const done = res;
        tt.show({
          message: tr('menu.added', { name }),
          action: { label: tr('common.undo'), onClick: () => { undoAdd(done); focusRowControl(item.id); } },
        });
        return true;
      },
      setQty: (item, uid, next) => {
        const { cart: c, toast: tt, t: tr } = latest.current;
        if (next > item.max_qty) {
          tt.show({ tone: 'info', message: tr('common.maxQty', { n: item.max_qty }) });
          return;
        }
        c.update(uid, { quantity: next });
      },
      removeLine: (item, uid) => {
        const { cart: c, toast: tt, t: tr, pick: pk } = latest.current;
        const index = c.lines.findIndex((l) => l.uid === uid);
        const removed = c.remove(uid);
        if (!removed) return;
        focusRowControl(item.id);
        tt.show({
          message: tr('menu.removed', { name: pk(item.name).text }),
          action: {
            label: tr('common.undo'),
            onClick: () => { latest.current.cart.restore(removed, index); focusRowControl(item.id); },
          },
        });
      },
      open: (item, position) => latest.current.overlays.openItem(item.id, { source: position }),
      weigh: (item) => latest.current.overlays.openPortion(item.id),
      explain: () => latest.current.overlays.openNoAccess(),
      notReady: () => {
        const { sessionError: e, toast: tt, t: tr } = latest.current;
        if (e) tt.show({ tone: 'error', message: tr(`error.${e.code}`) });
      },
    };
  }, []);

  // ------------------------------------------------------------ names
  const groupName = (g: MenuGroupView | undefined, key: GroupKey) => {
    const p = pick(g?.name);
    return p.text ? p : { text: t(`menu.group.${key}`), lang, fallback: false };
  };
  const foodName = groupName(model.groups.find((g) => g.key === 'food'), 'food');
  const drinksName = groupName(model.groups.find((g) => g.key === 'drinks'), 'drinks');
  const currentGroupName = group === 'food' ? foodName : drinksName;
  const otherGroup: GroupKey = group === 'food' ? 'drinks' : 'food';
  const otherHasItems = (model.groups.find((g) => g.key === otherGroup)?.categories.length ?? 0) > 0;

  const groupOptions = [
    { value: 'food' as const, label: foodName.text, lang: foodName.lang },
    { value: 'drinks' as const, label: drinksName.text, lang: drinksName.lang },
  ];

  const tabs: CategoryTab[] = sections.map((s) => {
    const n = pick(s.category.name);
    return { id: s.anchor, numeral: s.numeral, label: n.text, lang: n.lang };
  });

  const sheetGroups: CategoryListGroup[] = model.groups
    .filter((g) => g.categories.length > 0)
    .map((g) => {
      const gn = g.key === 'food' ? foodName : drinksName;
      return {
        key: g.key,
        label: gn.text,
        lang: gn.lang,
        categories: g.categories.map((s) => {
          const names = both(s.category.name);
          return {
            id: s.anchor,
            numeral: s.numeral,
            title: names.primary.text,
            titleLang: names.primary.lang,
            secondary: names.secondary?.text ?? null,
            secondaryLang: names.secondary?.lang,
            count: s.items.length,
          };
        }),
      };
    });

  const table = mode === 'joined' && session ? session.visit.table_label : null;
  const heading = table ? t('menu.headingTable', { table }) : t('menu.heading');

  // ------------------------------------------------------------ search
  const hits = useMemo(() => (searching ? searchMenu(model, query) : []), [model, query, searching]);
  const resultWords = searching ? t(hits.length === 1 ? 'common.resultsOne' : 'common.results', { n: hits.length }) : null;
  const searchRefs = useRef<Array<HTMLInputElement | null>>([]);
  const clearSearch = () => {
    setQuery('');
    requestAnimationFrame(() => {
      const visible = searchRefs.current.find((el) => el && el.offsetParent !== null);
      visible?.focus();
    });
  };

  // ------------------------------------------------------------ content
  let content: ReactNode;
  if (!ready) {
    content = error && !loading ? (
      <EmptyState
        icon="alert"
        headingLevel={2}
        title={t('menu.error.title')}
        action={<Button variant="primary" icon="refresh" onClick={() => void refresh()}>{t('menu.error.action')}</Button>}
      >
        {t(`error.${error.code}`)}
      </EmptyState>
    ) : (
      <MenuSkeleton label={t('menu.loading')} />
    );
  } else if (model.total === 0) {
    content = (
      <EmptyState icon="book" headingLevel={2} title={t('menu.empty.title')}>
        {t('menu.empty.body')}
      </EmptyState>
    );
  } else if (searching) {
    content = hits.length === 0 ? (
      <EmptyState
        icon="search"
        headingLevel={2}
        title={t('menu.noResults.title', { q: query.trim() })}
        action={<Button variant="outline" icon="x" onClick={clearSearch}>{t('common.clearSearch')}</Button>}
      >
        {t('menu.noResults.body')}
      </EmptyState>
    ) : (
      <section className="msearch" aria-labelledby="menu-results-h">
        <div className="msearch__head">
          <h2 id="menu-results-h">{t('menu.resultsFor', { q: query.trim() })}</h2>
          <p className="meta" aria-hidden="true">{resultWords}</p>
        </div>
        <div className="msec__list">
          {hits.map((hit, i) => {
            const d = draft.get(hit.item.id);
            const cat = both(hit.view.category.name);
            return (
              <MenuDishRow
                key={hit.item.id}
                item={hit.item}
                categoryId={hit.view.category.id}
                position={i}
                access={access}
                qty={d?.qty ?? 0}
                lineUid={d && d.uids.length === 1 && !d.frozen ? d.uids[0] : null}
                demoTag={false}
                langMarker={langMarkerFor(hit.item.name, lang, t)}
                context={(
                  <>
                    <span lang={cat.primary.lang}>{cat.primary.text}</span>
                    {cat.secondary ? <> · <span lang={cat.secondary.lang}>{cat.secondary.text}</span></> : null}
                  </>
                )}
                priority={i < EAGER_ROWS}
              />
            );
          })}
        </div>
      </section>
    );
  } else if (sections.length === 0) {
    content = (
      <EmptyState
        icon="book"
        headingLevel={2}
        title={t('menu.emptyGroup.title')}
        action={otherHasItems ? (
          <Button variant="outline" onClick={() => switchGroup(otherGroup)}>
            {t('menu.emptyGroup.action', { group: (otherGroup === 'food' ? foodName : drinksName).text })}
          </Button>
        ) : undefined}
      >
        {t('menu.emptyGroup.body')}
      </EmptyState>
    );
  } else {
    const allDemo = sections.every((s) => s.allDemo);
    content = sections.map((s, si) => (
      <CategorySection
        key={s.anchor}
        view={s}
        draft={draft}
        access={access}
        eager={si === 0}
        showDemoTags={!allDemo}
      />
    ));
  }

  const showStale = ready && stale && online;

  return (
    <RowActionsContext.Provider value={actions}>
      {showStale ? (
        <Banner
          variant="warning"
          title={t('menu.stale.title')}
          action={<Button variant="outline" icon="refresh" onClick={() => void refresh()}>{t('menu.stale.action')}</Button>}
        >
          {t('menu.stale.body')}
        </Banner>
      ) : null}
      <div className="toolrow">
        <SearchField
          ref={(el) => { searchRefs.current[0] = el; }}
          value={query}
          onChange={setQuery}
          placeholder={t('menu.searchShort')}
          label={t('common.searchScope')}
          status={resultWords}
        />
        <SegmentedControl<GroupKey>
          label={t('common.menuGroups')}
          value={group}
          onChange={(g) => switchGroup(g)}
          options={groupOptions}
        />
      </div>
      <CategoryRow
        categories={tabs}
        currentId={searching ? null : spy.current}
        onSelect={selectCategory}
        onOpenAll={() => setAllOpen(true)}
        label={t('menu.categoriesOf', { group: currentGroupName.text })}
      />
      <ReconnectSlot where="menu" />
      <div className="g-desk">
        <aside className="g-side g-desk-only" aria-label={t('common.categories')}>
          <SegmentedControl<GroupKey>
            label={t('common.menuGroups')}
            value={group}
            onChange={(g) => switchGroup(g)}
            options={groupOptions}
            size="staff"
            block
          />
          <CategorySidebar
            categories={tabs}
            currentId={searching ? null : spy.current}
            onSelect={selectCategory}
            label={t('menu.categoriesOf', { group: currentGroupName.text })}
          />
        </aside>
        <main className="g-main mmain" id="menu" aria-labelledby="menu-h1">
          <h1 id="menu-h1" className="visually-hidden">{heading}</h1>
          <div className="deskSearch g-desk-only">
            <SearchField
              ref={(el) => { searchRefs.current[1] = el; }}
              value={query}
              onChange={setQuery}
              placeholder={t('menu.searchLong')}
              label={t('common.searchScope')}
              status={resultWords}
            />
          </div>
          <div id="menu-list" className={ready ? 'mlist mlist--in' : 'mlist'} data-group={group}>
            {content}
          </div>
          {ready ? <AnalyticsNotice /> : null}
        </main>
        <aside className="g-cart g-desk-only" aria-label={t('common.nav.order')}>
          <DeskOrderPanel />
        </aside>
      </div>
      <AllCategoriesSheet
        open={allOpen}
        onClose={() => setAllOpen(false)}
        groups={sheetGroups}
        currentId={searching ? null : spy.current}
        onSelect={(anchor) => { sheetPick.current = anchor; }}
      />
    </RowActionsContext.Provider>
  );
}

// ---------------------------------------------------------------- section
function CategorySection({ view, draft, access, eager, showDemoTags }: {
  view: MenuCategoryView;
  draft: Map<string, { qty: number; uids: string[]; frozen: boolean }>;
  access: RowAccess;
  eager: boolean;
  showDemoTags: boolean;
}) {
  const { t, both, pick, lang } = useI18n();
  const sectionRef = useCategoryView<HTMLElement>(view.category.id);
  const names = both(view.category.name);
  const note = view.category.note ? pick(view.category.note) : null;
  // One language marker for the section when none of its dishes has a name in this language.
  const sectionMarker = lang === 'th' ? view.allLackThai : view.allLackEnglish;
  const markerText = sectionMarker ? langMarkerText(lang, t) : null;
  const hint = view.category.seasonal || (note && note.text) || markerText ? (
    <span className="mhint">
      {view.category.seasonal ? <Tag tone="heat">{t('menu.seasonal')}</Tag> : null}
      {note && note.text ? <span lang={note.lang}>{note.text}</span> : null}
      {markerText ? <span className="mhint__lang">{markerText}</span> : null}
    </span>
  ) : undefined;

  return (
    <MenuSection
      ref={sectionRef}
      id={view.anchor}
      numeral={view.numeral}
      title={names.primary.text}
      titleLang={names.primary.lang}
      secondary={names.secondary?.text ?? null}
      secondaryLang={names.secondary?.lang}
      hint={hint}
    >
      {view.items.map((item, i) => {
        const d = draft.get(item.id);
        return (
          <MenuDishRow
            key={item.id}
            item={item}
            categoryId={view.category.id}
            position={view.offset + i}
            access={access}
            qty={d?.qty ?? 0}
            lineUid={d && d.uids.length === 1 && !d.frozen ? d.uids[0] : null}
            demoTag={showDemoTags && item.badges.includes('demo_fixture')}
            langMarker={sectionMarker ? null : langMarkerFor(item.name, lang, t)}
            priority={eager && i < EAGER_ROWS}
          />
        );
      })}
    </MenuSection>
  );
}

// ---------------------------------------------------------------- helpers
type T = (key: string, vars?: Record<string, string | number>) => string;

function langMarkerText(lang: string, t: T): string {
  // Thai view: the restaurant printed only an English name. English view: only a Thai name.
  return lang === 'th' ? t('common.enOnly') : t('menu.thOnly');
}

function langMarkerFor(name: { th: string | null; en: string | null }, lang: string, t: T): string | null {
  const missing = lang === 'th' ? !name.th : !name.en;
  if (!missing) return null;
  return langMarkerText(lang, t);
}

function MenuSkeleton({ label }: { label: string }) {
  return (
    <div className="mskel" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="mskel__head" aria-hidden="true">
        <Skeleton width={56} height={13} />
        <Skeleton width="40%" height={30} />
      </div>
      <SkeletonDishRow />
      <SkeletonDishRow />
      <SkeletonDishRow />
      <SkeletonDishRow />
    </div>
  );
}
