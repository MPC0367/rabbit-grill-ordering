// CategoryRow and AllCategoriesSheet (DESIGN §10.4), plus the section-spy
// helpers a menu page needs. The IntersectionObserver only UPDATES the
// current tab; it never reveals or hides content.
import { forwardRef, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { cx, prefersReducedMotion } from './cx.ts';
import { scrollIntoViewInline, useGlideMark } from './hooks.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

export interface CategoryTab {
  id: string;
  /** Display numeral of the published categories ("01"); aria-hidden. */
  numeral: string;
  label: string;
  lang?: string;
  /** Anchor target; default "#<id>". */
  href?: string;
}

export interface CategoryRowProps {
  categories: ReadonlyArray<CategoryTab>;
  currentId: string | null;
  onSelect: (id: string) => void;
  onOpenAll: () => void;
  /** nav label, e.g. "หมวดอาหาร" */
  label?: string;
  allLabel?: string;
  className?: string;
}

/** Sticky 52px row: fixed "ทุกหมวด" button + a scroller of tabs with one gliding ember mark. */
export const CategoryRow = forwardRef<HTMLDivElement, CategoryRowProps>(function CategoryRow(
  { categories, currentId, onSelect, onOpenAll, label, allLabel, className },
  ref,
) {
  const { t } = useI18n();
  const scroller = useRef<HTMLElement | null>(null);
  const mark = useRef<HTMLSpanElement | null>(null);
  useGlideMark(scroller, mark, '[aria-current="true"]', `${currentId}|${categories.length}`, { inset: 12 });

  // The current tab scrolls itself into view (horizontal only).
  useEffect(() => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>('[aria-current="true"]') ?? null;
    scrollIntoViewInline(box, el);
  }, [currentId]);

  return (
    <div ref={ref} className={cx('catrow', className)}>
      <button type="button" className="catrow__all" aria-haspopup="dialog" onClick={onOpenAll}>
        <Icon name="list" />
        {allLabel ?? t('common.allCategories')}
      </button>
      <nav ref={scroller} className="catrow__scroll" aria-label={label ?? t('common.categories')}>
        {categories.map((c) => (
          <a
            key={c.id}
            className="cattab"
            href={c.href ?? `#${c.id}`}
            lang={c.lang}
            aria-current={c.id === currentId ? 'true' : undefined}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onSelect(c.id);
            }}
          >
            <span className="cattab__n" aria-hidden="true">{c.numeral}</span>
            {c.label}
          </a>
        ))}
        <span ref={mark} className="mark" aria-hidden="true" />
      </nav>
    </div>
  );
});

// ---------------------------------------------------------------- sidebar (desktop)
export interface CategorySidebarProps {
  categories: ReadonlyArray<CategoryTab>;
  currentId: string | null;
  onSelect: (id: string) => void;
  label?: string;
  className?: string;
  children?: ReactNode;
}

/** Desktop category list (numeral + Thai name, 3px ember bar on the current one). */
export function CategorySidebar({ categories, currentId, onSelect, label, className, children }: CategorySidebarProps) {
  const { t } = useI18n();
  return (
    <nav className={cx('sidecats', className)} aria-label={label ?? t('common.categories')}>
      {categories.map((c) => (
        <a
          key={c.id}
          href={c.href ?? `#${c.id}`}
          lang={c.lang}
          aria-current={c.id === currentId ? 'true' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onSelect(c.id);
          }}
        >
          <span className="cattab__n" aria-hidden="true">{c.numeral}</span>
          {c.label}
        </a>
      ))}
      {children}
    </nav>
  );
}

// ---------------------------------------------------------------- AllCategoriesSheet
export interface CategoryListItem {
  id: string;
  numeral: string;
  title: string;
  titleLang?: string;
  /** Secondary name (English italic when viewing Thai). */
  secondary?: string | null;
  secondaryLang?: string;
  count: number;
}

export interface CategoryListGroup {
  key: string;
  label: string;
  lang?: string;
  categories: ReadonlyArray<CategoryListItem>;
}

export interface AllCategoriesSheetProps {
  open: boolean;
  onClose: () => void;
  /** Food and Drinks. Hide unpublished and empty categories before passing them. */
  groups: ReadonlyArray<CategoryListGroup>;
  currentId: string | null;
  /** Switch group if needed and scroll; the sheet closes itself afterwards. */
  onSelect: (id: string, groupKey: string) => void;
  title?: string;
  inline?: boolean;
}

export function AllCategoriesSheet({ open, onClose, groups, currentId, onSelect, title, inline }: AllCategoriesSheetProps) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onClose={onClose} title={title ?? t('common.allCategories')} inline={inline}>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <p className="catlist__grp" aria-hidden="true"><span lang={g.lang}>{g.label}</span></p>
          <ul>
            {g.categories.map((c) => (
              <li key={c.id}>
                <a
                  className="srow catlist__row"
                  href={`#${c.id}`}
                  aria-current={c.id === currentId ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    onClose();
                    onSelect(c.id, g.key);
                  }}
                >
                  <span className="catlist__n" aria-hidden="true">{c.numeral}</span>
                  <span className="srow__txt">
                    <span className="srow__t" lang={c.titleLang}>{c.title}</span>
                    {c.secondary ? <span className="en" lang={c.secondaryLang ?? 'en'}>{c.secondary}</span> : null}
                  </span>
                  <span className="catlist__count">
                    <span aria-hidden="true">{c.count}</span>
                    <span className="visually-hidden">{t('common.itemCount', { n: c.count })}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Sheet>
  );
}

// ---------------------------------------------------------------- section spy
/**
 * Current section id while the page scrolls. `offset` is the sticky chrome
 * height (header + category row). Only reports; never changes the DOM.
 */
export function useActiveSection(ids: ReadonlyArray<string>, offset: number): string | null {
  const [current, setCurrent] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  useEffect(() => {
    const list = key ? key.split('|') : [];
    if (!list.length || typeof IntersectionObserver === 'undefined') return;
    const pick = () => {
      // The last section whose top has crossed the sticky line wins.
      let best: string | null = null;
      for (const id of list) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - offset - 12 <= 0) best = id;
      }
      setCurrent(best ?? list[0]);
    };
    const io = new IntersectionObserver(() => pick(), { rootMargin: `-${offset}px 0px -40% 0px`, threshold: [0, 0.01, 0.5, 1] });
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    pick();
    return () => io.disconnect();
  }, [key, offset]);
  return current;
}

/** Scroll the page so section `id` sits under the sticky chrome. */
export function scrollToSection(id: string, offset: number): void {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

