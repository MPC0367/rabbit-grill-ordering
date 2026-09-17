// Tabs: button tabs (role=tablist, roving tabindex, automatic activation)
// or routed subtabs (a <nav> of links with aria-current="page") when every
// item has an href. variant="underline" is the admin ink underline;
// variant="ember" carries the one gliding ember mark (DESIGN §9).
import { forwardRef, useId, useRef, type HTMLAttributes, type ReactElement, type ReactNode, type Ref } from 'react';
import { linkHandler } from '../lib/router.ts';
import { cx, mergeRefs } from './cx.ts';
import { rovingKeyDown, useGlideMark } from './hooks.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Badge } from './Badge.tsx';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Routed subtab: renders a link. */
  href?: string;
  /** Neutral Oswald count ("Board 12"). */
  count?: number;
  /** Attention badge ("Requests ②"). */
  badge?: number;
  badgeTone?: 'ink' | 'alert' | 'ember';
  badgeLabel?: string;
  icon?: IconName;
  lang?: string;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange?: (value: T) => void;
  /** Accessible name of the tab list / nav. */
  label: string;
  variant?: 'underline' | 'ember';
  /** Draw a hairline under the row (standalone use). */
  bar?: boolean;
  /** Prefix for tab / panel ids (button mode). Pair with <TabPanel idBase>. */
  idBase?: string;
  className?: string;
}

function TabsInner<T extends string>(
  { items, value, onChange, label, variant = 'underline', bar, idBase, className }: TabsProps<T>,
  ref: Ref<HTMLElement>,
) {
  const auto = useId();
  const base = idBase ?? `tabs${auto.replace(/:/g, '')}`;
  const box = useRef<HTMLElement | null>(null);
  const mark = useRef<HTMLSpanElement | null>(null);
  const els = useRef<Array<HTMLElement | null>>([]);
  const routed = items.length > 0 && items.every((i) => i.href);
  const itemClass = variant === 'ember' ? 'etab' : 'subtab';
  const current = Math.max(0, items.findIndex((i) => i.value === value));
  useGlideMark(box, mark, routed ? '[aria-current="page"]' : '[aria-selected="true"]', `${value}|${items.length}`);

  const inner = (it: TabItem<T>) => (
    <>
      {it.icon ? <Icon name={it.icon} size="sm" /> : null}
      <span>{it.label}</span>
      {it.count !== undefined ? <span className="count">{it.count}</span> : null}
      {it.badge ? <Badge count={it.badge} tone={it.badgeTone ?? 'alert'} label={it.badgeLabel} /> : null}
    </>
  );

  const rowClass = cx(variant === 'ember' ? 'etabs' : 'subtabs', bar && 'subtabs--bar', className);
  const markEl = variant === 'ember' ? <span ref={mark} className="mark" aria-hidden="true" /> : null;

  if (routed) {
    return (
      <nav ref={mergeRefs(ref, box)} aria-label={label} className={rowClass}>
        {items.map((it) => (
          <a
            key={it.value}
            href={it.href}
            lang={it.lang}
            className={itemClass}
            aria-current={it.value === value ? 'page' : undefined}
            onClick={(e) => { onChange?.(it.value); linkHandler(e); }}
          >
            {inner(it)}
          </a>
        ))}
        {markEl}
      </nav>
    );
  }

  return (
    <div
      ref={mergeRefs(ref, box)}
      role="tablist"
      aria-label={label}
      className={rowClass}
      onKeyDown={(e) => {
        const next = rovingKeyDown(e, els.current, current);
        if (next !== null) onChange?.(items[next].value);
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.value}
          ref={(el) => { els.current[i] = el; }}
          type="button"
          role="tab"
          id={`${base}-tab-${it.value}`}
          aria-controls={`${base}-panel-${it.value}`}
          aria-selected={it.value === value}
          tabIndex={i === current ? 0 : -1}
          disabled={it.disabled}
          lang={it.lang}
          className={itemClass}
          onClick={() => onChange?.(it.value)}
        >
          {inner(it)}
        </button>
      ))}
      {markEl}
    </div>
  );
}

export const Tabs = forwardRef(TabsInner) as <T extends string>(
  props: TabsProps<T> & { ref?: Ref<HTMLElement> },
) => ReactElement;

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  idBase: string;
  value: string;
  active: boolean;
  /** Keep the panel mounted while hidden (preserves scroll and state). */
  keepMounted?: boolean;
}

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { idBase, value, active, keepMounted, children, ...rest },
  ref,
) {
  if (!active && !keepMounted) return null;
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={`${idBase}-panel-${value}`}
      aria-labelledby={`${idBase}-tab-${value}`}
      hidden={!active}
      tabIndex={0}
      {...rest}
    >
      {children}
    </div>
  );
});
