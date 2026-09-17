// WeekBarChart (DESIGN.md §10.21): SVG bars from zero with integer ticks.
// Completed, today (partial), upcoming (never zero), real zero, missing,
// selected, and the same-point-last-week tick. Bars are real buttons laid
// over the drawing; "Show as table" swaps in the text equivalent.
// Works for a week (7 bars), a month (28–31) and a year (12).
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { num } from '../../lib/format.ts';
import { DataTable, type DataColumn } from './DataTable.tsx';
import { cx, Ico, roveIndex, roveKeys, safeId } from './parts.tsx';

export type BucketState = 'complete' | 'partial' | 'future' | 'missing';

export interface ChartBucket {
  key: string;
  /** Axis word: "Mon", "Jan", "14". Today's bar reads "Today" when there is room. */
  label: string;
  /** Second axis line for completed days: "14 Sep". */
  sublabel?: string;
  /** Full spoken date: "Monday 14 September". */
  spoken: string;
  state: BucketState;
  /** null for future and missing buckets; a real zero is 0. */
  value: number | null;
  /** Same point in the previous period (tick). */
  prior?: number | null;
  /** Spoken breakdown: "37 accepted, 1 rejected, 1 cancelled". */
  detail?: string;
}

export interface WeekBarChartProps {
  /** Caps title above the plot ("Submitted order rounds per day"). */
  title: string;
  buckets: ChartBucket[];
  /** Unit words for labels and the table ("order rounds"). */
  unit: string;
  /** Name of the bar list ("Order rounds by day"). */
  listLabel?: string;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onRetry?: (key: string) => void;
  /** Legend text for the prior tick (defaults to "Same point last week"). */
  priorLabel?: string;
  /** Spoken prefix for the prior value ("last week"). */
  priorSpoken?: string;
  /** Controlled view; uncontrolled when omitted. */
  view?: 'chart' | 'table';
  onViewChange?: (view: 'chart' | 'table') => void;
  /** Plot height in px (300 on desktop). */
  height?: number;
  legend?: boolean;
  /** Dense views: label every Nth bar. */
  labelEvery?: number;
  format?: (n: number) => string;
  className?: string;
  /** Extra controls in the chart head (e.g. CSV). */
  actions?: ReactNode;
  /** Axis word for the partial bucket when there is room ("Today"; "This month" in a year view). */
  currentLabel?: string;
}

const AXIS = 44;
const PAD = 12;
const TOP = 28;
const BAR_MAX = 64;

function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const s = m * p;
    if (s >= raw && Number.isInteger(s)) return s;
  }
  return 10 * p;
}

function topRounded(x: number, yTop: number, w: number, yBottom: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, (yBottom - yTop) / 2));
  return `M${x},${yBottom}V${yTop + rr}Q${x},${yTop} ${x + rr},${yTop}H${x + w - rr}Q${x + w},${yTop} ${x + w},${yTop + rr}V${yBottom}Z`;
}

export function WeekBarChart({
  title, buckets, unit, listLabel, selectedKey, onSelect, onRetry, priorLabel, priorSpoken,
  view: viewProp, onViewChange, height = 300, legend = true, labelEvery, format = num, className, actions, currentLabel,
}: WeekBarChartProps) {
  const { t, lang } = useI18n();
  const uid = safeId(useId());
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [ownView, setOwnView] = useState<'chart' | 'table'>('chart');
  const view = viewProp ?? ownView;
  const setView = (v: 'chart' | 'table') => {
    if (viewProp === undefined) setOwnView(v);
    onViewChange?.(v);
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const n = Math.max(1, buckets.length);
  const gap = n > 16 ? 4 : n > 8 ? 10 : 18;
  const plotW = Math.max(0, width - AXIS - PAD * 2);
  const slot = Math.max(4, (plotW - gap * (n - 1)) / n);
  const barW = Math.min(slot, BAR_MAX);
  const H = height;
  const base = TOP + H;
  const dense = slot < 44;
  const every = labelEvery ?? (dense ? Math.ceil(n / 10) : 1);

  const shown = buckets.flatMap((b) => [b.value ?? 0, b.state === 'future' ? 0 : b.prior ?? 0]);
  const max = Math.max(0, ...shown);
  const step = max === 0 ? 1 : niceStep(max / 4);
  const top = max === 0 ? 4 : Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const y = (v: number) => base - (v / top) * H;

  const x0 = (i: number) => AXIS + PAD + i * (slot + gap);
  const cxOf = (i: number) => x0(i) + slot / 2;
  const valueSize = slot < 30 ? 12 : 16;
  const showValues = slot >= 16;
  const priorWord = priorSpoken ?? t('common.chart.priorSpoken');

  const interactive = (b: ChartBucket) => b.state === 'complete' || b.state === 'partial';

  // Axis labels: today and the selected bar always; the rest every Nth bar unless it would touch one of those.
  const minApart = Math.max(1, Math.ceil((dense ? 26 : 60) / (slot + gap)));
  const forced = buckets.map((b, i) => (b.state === 'partial' || (b.key === selectedKey && interactive(b)) ? i : -1)).filter((i) => i >= 0);
  const labelled = new Set<number>(forced);
  buckets.forEach((_, i) => {
    if (i % every !== 0 || labelled.has(i)) return;
    if ([...labelled].some((j) => Math.abs(i - j) < minApart)) return;
    labelled.add(i);
  });
  const selectable = buckets.filter(interactive);
  const activeIdx = selectable.findIndex((b) => b.key === selectedKey);

  const spokenFor = (b: ChartBucket) => {
    const parts: string[] = [b.spoken];
    if (b.state === 'future') parts.push(t('common.chart.ariaFuture'));
    else if (b.state === 'missing') parts.push(t('common.chart.ariaMissing'));
    else {
      parts.push(`${format(b.value ?? 0)} ${unit}`);
      if (b.state === 'partial') parts.push(t('common.chart.ariaPartial'));
      if (b.prior != null) parts.push(`${priorWord} ${format(b.prior)}`);
      if (b.detail) parts.push(b.detail);
    }
    return parts.join(lang === 'th' ? ' ' : ', ');
  };

  const clip = `wbc-clip-${uid}`;
  const hatch = `wbc-hatch-${uid}`;

  const table = () => {
    type Row = ChartBucket;
    const stateWord = (b: Row) => b.state === 'future' ? t('common.chart.upcoming')
      : b.state === 'missing' ? t('common.chart.noData')
      : b.state === 'partial' ? t('common.chart.livePartial')
      : t('common.chart.complete');
    const columns: Array<DataColumn<Row>> = [
      { key: 'day', header: t('common.chart.day'), cell: (b) => b.spoken },
      { key: 'value', header: unit, numeric: true, cell: (b) => (b.value == null ? '—' : format(b.value)) },
      ...(buckets.some((b) => b.prior != null)
        ? [{ key: 'prior', header: priorLabel ?? t('common.chart.lgPrior'), numeric: true, cell: (b: Row) => (b.prior == null || b.state === 'future' ? '—' : format(b.prior)) }]
        : []),
      { key: 'state', header: t('common.chart.state'), cell: stateWord },
    ];
    return (
      <DataTable<Row>
        className="wbc__table"
        caption={title}
        columns={columns}
        rows={buckets}
        rowKey={(b) => b.key}
        selectedKey={selectedKey ?? null}
      />
    );
  };

  return (
    <div className={cx('chart', className)}>
      <div className="chart__top">
        <p className="cap" lang={lang}>{title}</p>
        <div className="chart__actions">
          {actions}
          <button type="button" className="btn btn--ghost btn--staff" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
            <Ico name={view === 'chart' ? 'table-view' : 'bars'} />
            {view === 'chart' ? t('common.chart.showTable') : t('common.chart.showChart')}
          </button>
        </div>
      </div>

      {view === 'table' ? table() : (
        <div
          className={cx('wbc', dense && 'wbc--dense')}
          ref={box}
          style={{ height: base + 2 + (dense ? 30 : onRetry && buckets.some((b) => b.state === 'missing') ? 100 : slot < 96 ? 68 : 50) }}
        >
          <svg className="wbc__svg" width={width} height={base + 2} aria-hidden="true" focusable="false">
            <defs>
              <clipPath id={clip}><rect x="0" y="0" width={width} height={base} /></clipPath>
              <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" className="wbc__hatch" />
              </pattern>
            </defs>

            {ticks.map((v) => (
              <g key={v}>
                {v > 0 ? <line className="wbc__grid" x1={AXIS} x2={width} y1={y(v)} y2={y(v)} /> : null}
                <text className="wbc__tick" x={AXIS - 10} y={y(v) + 4.5} textAnchor="end">{format(v)}</text>
              </g>
            ))}

            {buckets.map((b, i) => {
              if (b.key !== selectedKey || !interactive(b)) return null;
              const g2 = Math.min(9, gap / 2 + 1);
              return <path key="plinth" className="wbc__plinth" d={topRounded(x0(i) - g2, TOP - 22, slot + g2 * 2, base + 1, 6)} />;
            })}

            <g clipPath={`url(#${clip})`}>
              {buckets.map((b, i) => {
                const x = cxOf(i) - barW / 2;
                if (b.state === 'future' || b.state === 'missing') {
                  return (
                    <rect
                      key={b.key}
                      className={b.state === 'future' ? 'wbc__future' : 'wbc__missing'}
                      x={x + 0.75}
                      y={TOP + 0.75}
                      width={Math.max(0, barW - 1.5)}
                      height={H + 4}
                      rx="2"
                      fill={b.state === 'future' ? `url(#${hatch})` : 'none'}
                    />
                  );
                }
                const v = b.value ?? 0;
                const h = (v / top) * H;
                const yTop = y(v);
                return (
                  <g key={b.key}>
                    {v > 0 ? (
                      <rect className="wbc__bar" x={x} y={yTop} width={barW} height={h + 3} rx="2" style={{ y: yTop, height: h + 3 }} />
                    ) : (
                      <rect className="wbc__zero" x={x} y={base - 3} width={barW} height="3" />
                    )}
                    {b.state === 'partial' && v > 0 ? (
                      <rect className="wbc__cap" x={x} y={yTop} width={barW} height="3" style={{ y: yTop }} />
                    ) : null}
                    {b.state === 'partial' ? (
                      <rect
                        className="wbc__today"
                        x={x - 5}
                        y={(v > 0 ? yTop : base - 3) - 5}
                        width={barW + 10}
                        height={(v > 0 ? h : 3) + 5 + 4}
                        rx="3"
                        style={{ y: (v > 0 ? yTop : base - 3) - 5, height: (v > 0 ? h : 3) + 9 }}
                      />
                    ) : null}
                  </g>
                );
              })}
            </g>

            <line className="wbc__base" x1={AXIS} x2={width} y1={base + 0.5} y2={base + 0.5} />

            {buckets.map((b, i) => {
              if (b.state === 'future' || b.prior == null || b.prior === 0) return null;
              const w = barW + Math.min(14, gap + 4);
              return <line key={`p-${b.key}`} className="wbc__prior" x1={cxOf(i) - w / 2} x2={cxOf(i) + w / 2} y1={y(b.prior)} y2={y(b.prior)} />;
            })}

            {showValues ? buckets.map((b, i) => {
              const cx0 = cxOf(i);
              if (b.state === 'future' || b.state === 'missing') {
                const text = b.state === 'missing' && slot >= 60 ? t('common.chart.noData') : '—';
                return <text key={`v-${b.key}`} className="wbc__val is-muted" x={cx0} y={TOP - 9} textAnchor="middle" style={{ fontSize: valueSize }}>{text}</text>;
              }
              const v = b.value ?? 0;
              const yy = (v > 0 ? y(v) : base - 3) - (b.state === 'partial' ? 11 : 8);
              return <text key={`v-${b.key}`} className="wbc__val" x={cx0} y={yy} textAnchor="middle" style={{ fontSize: valueSize, y: yy }}>{format(v)}</text>;
            }) : null}
          </svg>

          <ul className="wbc__hits" aria-label={listLabel ?? title} onKeyDown={(e) => roveKeys(e)}>
            {buckets.map((b, i) => {
              const style = { left: x0(i) - gap / 2, width: slot + gap, height: base + 1 };
              if (!interactive(b)) {
                return <li key={b.key} style={style}><span className="sr">{spokenFor(b)}</span></li>;
              }
              const idx = selectable.indexOf(b);
              return (
                <li key={b.key} style={style}>
                  <button
                    type="button"
                    className="wbc__hit"
                    data-rove=""
                    tabIndex={onSelect ? roveIndex(idx, activeIdx) : -1}
                    aria-pressed={onSelect ? b.key === selectedKey : undefined}
                    aria-label={spokenFor(b)}
                    onClick={onSelect ? () => onSelect(b.key) : undefined}
                    style={{ top: TOP - 22 }}
                  />
                </li>
              );
            })}
          </ul>

          <div className="wbc__x" style={{ top: base + 10 }}>
            {buckets.map((b, i) => {
              const isSel = b.key === selectedKey && interactive(b);
              const showLabel = labelled.has(i);
              const word = b.state === 'partial' && slot >= 56 ? currentLabel ?? t('common.chart.today') : b.label;
              const sub = b.state === 'future' ? t('common.chart.upcoming')
                : b.state === 'partial' ? t('common.chart.livePartial')
                : b.state === 'missing' ? t('common.chart.noData')
                : b.sublabel;
              return (
                <div
                  key={b.key}
                  className={cx('wbc__lbl', b.state === 'partial' && 'is-today', isSel && 'is-selected', b.state === 'missing' && 'is-missing')}
                  style={{ left: x0(i) - gap / 2, width: slot + gap }}
                >
                  {showLabel ? <b aria-hidden="true">{word}</b> : null}
                  {!dense && sub ? <span aria-hidden="true" className={b.state === 'partial' ? 'live' : undefined}>{sub}</span> : null}
                  {dense && b.state === 'partial' ? <span aria-hidden="true" className="live live--dot" /> : null}
                  {b.state === 'missing' && onRetry && !dense ? (
                    <button type="button" className="textlink wbc__retry" onClick={() => onRetry(b.key)}>
                      {t('common.retry')}
                      <span className="sr"> · {b.spoken}</span>
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {legend && view === 'chart' ? <ChartLegend priorLabel={priorLabel} /> : null}
    </div>
  );
}

/** The six marks, in words. */
export function ChartLegend({ priorLabel, className }: { priorLabel?: string; className?: string }) {
  const { t } = useI18n();
  const items: Array<[string, string]> = [
    ['l-done', t('common.chart.lgDone')],
    ['l-today', t('common.chart.lgToday')],
    ['l-future', t('common.chart.lgFuture')],
    ['l-zero', t('common.chart.lgZero')],
    ['l-missing', t('common.chart.lgMissing')],
    ['l-prior', priorLabel ?? t('common.chart.lgPrior')],
  ];
  return (
    <ul className={cx('chart__legend', className)} aria-label={t('common.chart.legend')}>
      {items.map(([cls, text]) => (
        <li key={cls} className="lg">
          <i className={cls} aria-hidden="true" />
          {text}
        </li>
      ))}
    </ul>
  );
}
