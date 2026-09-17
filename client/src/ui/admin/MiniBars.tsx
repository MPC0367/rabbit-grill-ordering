// MiniBars: the compact hourly breakdown under the day drill-down.
// Bars from zero, value on top, every value also spoken as list text.
import type { CSSProperties } from 'react';
import { num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { cx } from './parts.tsx';

export interface MiniBarDatum {
  key: string;
  /** Axis text: "11", "12:00". */
  label: string;
  value: number;
  /** Spoken text; defaults to "label, value unit". */
  spoken?: string;
}

export interface MiniBarsProps {
  data: ReadonlyArray<MiniBarDatum>;
  title: string;
  unit: string;
  /** Emphasised bar (the current hour). */
  highlightKey?: string | null;
  /** Label every Nth bar on the axis. */
  labelEvery?: number;
  /** Plot height in px. */
  height?: number;
  className?: string;
}

export function MiniBars({ data, title, unit, highlightKey, labelEvery = 1, height = 88, className }: MiniBarsProps) {
  const { lang } = useI18n();
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure className={cx('minibars', className)}>
      <figcaption className="cap" lang={lang}>{title}</figcaption>
      <ol className="minibars__plot" style={{ height }}>
        {data.map((d) => (
          <li
            key={d.key}
            className={cx(d.value === 0 && 'is-zero', d.key === highlightKey && 'is-hi')}
            style={{ ['--v' as string]: d.value / max } as CSSProperties}
          >
            <span className="minibars__val" aria-hidden="true">{d.value > 0 ? num(d.value) : '0'}</span>
            <span className="minibars__bar" aria-hidden="true" />
            <span className="sr">{d.spoken ?? `${d.label}, ${num(d.value)} ${unit}`}</span>
          </li>
        ))}
      </ol>
      <div className="minibars__x" aria-hidden="true">
        {data.map((d, i) => <span key={d.key}>{i % labelEvery === 0 ? d.label : ''}</span>)}
      </div>
    </figure>
  );
}
