// Key-value list (DESIGN.md §10.19 bill block, §10.21 selected-day card).
import type { ReactNode } from 'react';
import { cx } from './parts.tsx';

export interface KeyValueItem {
  key?: string;
  term: ReactNode;
  value: ReactNode;
  /** Semibold value (the line that matters most, e.g. accepted food). */
  strong?: boolean;
  /** Muted value (not charged, not included, not configured). */
  muted?: boolean;
  termLang?: string;
  valueLang?: string;
}

export interface KeyValueProps {
  items: KeyValueItem[];
  /** Tabular numerals: "ui" keeps Noto, "display" sets values in Oswald (selected-day card). */
  numeric?: 'ui' | 'display' | false;
  className?: string;
}

/** Two-column dl: muted term on the left, right-aligned value. */
export function KeyValue({ items, numeric = 'ui', className }: KeyValueProps) {
  return (
    <dl className={cx('kv', numeric === 'display' && 'kv--display', className)}>
      {items.map((it, i) => {
        const k = it.key ?? String(i);
        return (
          <div key={k} className="kv__row">
            <dt lang={it.termLang}>{it.term}</dt>
            <dd lang={it.valueLang} className={cx(numeric && 'num', it.strong && 'is-strong', it.muted && 'is-muted')}>{it.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
