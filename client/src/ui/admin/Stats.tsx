// Insights pieces (DESIGN.md §10.20 StatCard, §10.21 headline column).
import { forwardRef, useCallback, useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { roveIndex, roveKeys, cx, Ico, safeId } from './parts.tsx';
import { KeyValue, type KeyValueItem } from './KeyValue.tsx';
import { Pill } from '../Badge.tsx';
import { Skeleton } from '../Feedback.tsx';

// ------------------------------------------------------------------ definition popover

export interface DefinitionButtonProps {
  /** Metric name, used in the button's label ("Definition: orders today"). */
  label: string;
  children: ReactNode;
  className?: string;
}

/** 32px "i" (44px hit) that opens a light-dismiss popover with the metric definition. */
export function DefinitionButton({ label, children, className }: DefinitionButtonProps) {
  const { t } = useI18n();
  const id = `def-${safeId(useId())}`;
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const b = btn.current;
    const p = pop.current;
    if (!b || !p) return;
    const r = b.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12));
    p.style.width = `${w}px`;
    p.style.left = `${left}px`;
    const below = r.bottom + 8;
    p.style.top = `${below}px`;
    const h = p.offsetHeight;
    if (below + h > window.innerHeight - 12 && r.top - h - 8 > 12) p.style.top = `${r.top - h - 8}px`;
  }, []);

  useEffect(() => {
    const p = pop.current;
    if (!p) return;
    const onToggle = (e: Event) => {
      const open = (e as Event & { newState?: string }).newState === 'open';
      btn.current?.setAttribute('aria-expanded', String(open));
      if (open) place();
    };
    p.addEventListener('toggle', onToggle);
    return () => p.removeEventListener('toggle', onToggle);
  }, [place]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx('iconbtn defbtn', className)}
        aria-label={t('common.staff.definition', { label })}
        aria-controls={id}
        aria-expanded="false"
        popoverTarget={id}
      >
        <Ico name="info" size="sm" />
      </button>
      <div ref={pop} id={id} popover="auto" className="defpop" role="note">
        <p className="defpop__t">{label}</p>
        <div className="defpop__b">{children}</div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ stat card

export interface Comparison {
  /** up / down draw ▲ / ▼; flat draws "= 0"; none shows the words only (no prior baseline). */
  direction: 'up' | 'down' | 'flat' | 'none';
  /** Absolute change as text ("1", "6"). Never a percentage against a zero baseline. */
  delta?: string;
  /** "vs last Thursday at 19:52" */
  text: ReactNode;
}

export interface StatCardProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  label: string;
  /** Preformatted value; use `parts` for mixed units ("2m 10s"). */
  value?: ReactNode;
  parts?: Array<{ n: string; unit?: string }>;
  /** Small unit after the value ("this week"). */
  unit?: string;
  /** Only when the value comes from the live pipeline. */
  live?: boolean;
  comparison?: Comparison | null;
  note?: ReactNode;
  definition?: ReactNode;
  /** Coverage meter for metrics that depend on staff input. */
  coverage?: { ratio: number; text: ReactNode } | null;
  state?: 'ready' | 'loading' | 'error';
  onRetry?: () => void;
}

export function ComparisonLine({ comparison, className }: { comparison: Comparison; className?: string }) {
  const { t } = useI18n();
  const { direction, delta, text } = comparison;
  const glyph = direction === 'up' ? '▲' : direction === 'down' ? '▼' : direction === 'flat' ? '=' : null;
  const spoken = direction === 'up' ? t('common.stats.up', { n: delta ?? '' })
    : direction === 'down' ? t('common.stats.down', { n: delta ?? '' })
    : direction === 'flat' ? t('common.stats.noChange')
    : null;
  return (
    <p className={cx('stat__c', className)}>
      {glyph ? (
        <>
          <b className={cx('stat__delta', direction === 'up' && 'is-up', direction === 'down' && 'is-down')} aria-hidden="true">
            {glyph} {direction === 'flat' ? '0' : delta}
          </b>
          <span className="sr">{spoken}</span>{' '}
        </>
      ) : null}
      {direction === 'none' ? t('common.stats.noBaseline') : text}
    </p>
  );
}

export const StatCard = forwardRef<HTMLElement, StatCardProps>(function StatCard(
  { label, value, parts, unit, live, comparison, note, definition, coverage, state = 'ready', onRetry, className, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  return (
    <article ref={ref} {...rest} className={cx('stat', state !== 'ready' && `is-${state}`, className)} aria-busy={state === 'loading' || undefined}>
      <div className="stat__k">
        <h3>{label}</h3>
        {definition ? <DefinitionButton label={label}>{definition}</DefinitionButton> : null}
      </div>
      {state === 'loading' ? (
        <p className="stat__v"><Skeleton shape="block" width={76} height={40} /><span className="sr">{t('common.loading')}</span></p>
      ) : state === 'error' ? (
        <p className="stat__err" role="alert">
          <Ico name="alert" size="sm" />
          {t('common.staff.loadFailed')}
          {onRetry ? (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" className="textlink" onClick={onRetry}>{t('common.retry')}</button>
            </>
          ) : null}
        </p>
      ) : (
        <>
          <p className="stat__v">
            {parts
              ? parts.map((p, i) => (
                  <span key={i} className="stat__part">
                    {p.n}
                    {p.unit ? <small>{p.unit}</small> : null}
                  </span>
                ))
              : value}
            {unit ? <small>{unit}</small> : null}
            {live ? <Pill tone="ok" live size="sm" className="stat__live" lang={lang}>{t('common.stats.live')}</Pill> : null}
          </p>
          {coverage ? (
            <>
              <div className="coverage" aria-hidden="true"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, coverage.ratio)) * 100)}%` }} /></div>
              <p className="stat__c">{coverage.text}</p>
            </>
          ) : null}
          {comparison ? <ComparisonLine comparison={comparison} /> : null}
          {note ? <p className="stat__c">{note}</p> : null}
        </>
      )}
    </article>
  );
});

/** Five across on desktop, fewer as the container narrows. */
export function StatGrid({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('stats', className)}>{children}</div>;
}

// ------------------------------------------------------------------ headline column

export interface HeroMetricProps {
  label: string;
  labelId?: string;
  value: string;
  /** "submitted order rounds, Mon 14 to Thu 17 at 19:52" (exact coverage). */
  unit: ReactNode;
  comparison?: { direction: 'up' | 'down' | 'flat' | 'none'; delta?: string; text: ReactNode; sub?: ReactNode } | null;
  /** The selected day's breakdown (a polite live region). */
  selected?: { title: ReactNode; tag?: string; items: KeyValueItem[] } | null;
  className?: string;
}

/** Dark-panel headline: caps label, Oswald 72 value, unit sentence, comparison, selected-day card. */
export function HeroMetric({ label, labelId, value, unit, comparison, selected, className }: HeroMetricProps) {
  const { t, lang } = useI18n();
  const c = comparison;
  const glyph = c ? (c.direction === 'up' ? '▲' : c.direction === 'down' ? '▼' : c.direction === 'flat' ? '=' : null) : null;
  return (
    <div className={cx('headline', className)}>
      <p className="cap" id={labelId} lang={lang}>{label}</p>
      <p className="headline__v">{value}</p>
      <p className="headline__u">{unit}</p>
      {c ? (
        <div className="cmp">
          {glyph ? (
            <span className={cx('cmp__d', c.direction === 'down' && 'is-down', c.direction === 'flat' && 'is-flat')}>
              <span aria-hidden="true">{glyph} {c.direction === 'flat' ? '0' : c.delta}</span>
              <span className="sr">
                {c.direction === 'up' ? t('common.stats.up', { n: c.delta ?? '' }) : c.direction === 'down' ? t('common.stats.down', { n: c.delta ?? '' }) : t('common.stats.noChange')}
              </span>
            </span>
          ) : null}
          <div>
            {c.direction === 'none' ? t('common.stats.noBaseline') : c.text}
            {c.sub ? <small>{c.sub}</small> : null}
          </div>
        </div>
      ) : null}
      {selected ? (
        <div className="selday" aria-live="polite">
          <h3>
            {selected.title}
            {selected.tag ? <span className="selday__tag"> · {selected.tag}</span> : null}
          </h3>
          <KeyValue items={selected.items} numeric="display" />
        </div>
      ) : null}
    </div>
  );
}

export interface ChartPanelProps extends HTMLAttributes<HTMLElement> {
  /** id of the headline label that names the panel. */
  labelledBy?: string;
  /** Chart only, without the headline column. */
  solo?: boolean;
  /** Light variant (print, PDF, light cards): ink bars on bone. */
  tone?: 'dark' | 'light';
}

/** The charcoal analytics panel: headline column + chart. */
export function ChartPanel({ labelledBy, solo, tone = 'dark', className, children, ...rest }: ChartPanelProps) {
  return (
    <div className="panel-cq">
      <section
        {...rest}
        className={cx('panel panel--chart', solo && 'panel--solo', tone === 'light' && 'panel--light', className)}
        data-surface={tone === 'dark' ? 'dark' : undefined}
        aria-labelledby={labelledBy}
      >
        {children}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ metric selector

export interface MetricSwitchProps<V extends string> {
  options: ReadonlyArray<{ value: V; label: string }>;
  value: V;
  onChange: (value: V) => void;
  /** "What each metric counts" */
  onExplain?: () => void;
  label?: string;
  className?: string;
}

/** Underline metric selector (Order rounds · Accepted rounds · …) with the explainer at the end. */
export function MetricSwitch<V extends string>({ options, value, onChange, onExplain, label, className }: MetricSwitchProps<V>) {
  const { t } = useI18n();
  const active = options.findIndex((o) => o.value === value);
  return (
    <div className={cx('metrics', className)}>
      <div className="metrics__group" role="group" aria-label={label ?? t('common.stats.metric')} onKeyDown={(e) => roveKeys(e)}>
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            className="metric"
            data-rove=""
            tabIndex={roveIndex(i, active)}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {onExplain ? (
        <button type="button" className="metric metrics__explain" aria-haspopup="dialog" onClick={onExplain}>
          <Ico name="info" />
          {t('common.stats.whatCounts')}
        </button>
      ) : null}
    </div>
  );
}
