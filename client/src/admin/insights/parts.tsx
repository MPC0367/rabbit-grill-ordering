// Pieces shared by the three insights views. Kit components do the drawing;
// the few things the kit does not have (a horizontal share list, a funnel,
// a chart legend with our own wording, the custom-range fields) are built
// here from the kit's classes and tokens.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { StatsPeriod } from '../../../../shared/dto.ts';
import { ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive, useLiveEvent, useResource, type Resource } from '../../lib/live.tsx';
import { useNow } from '../../lib/store.ts';
import { clock, num } from '../../lib/format.ts';
import {
  Banner, Button, DateRangeNav, EmptyState, Icon, LinkButton, Skeleton, Switch, TextField, cx,
  type IconName,
} from '../../ui/index.ts';
import {
  MAX_CUSTOM_DAYS, changePeriodKind, contains, isDate, nowMs, periodsAgo, pushQuery, periodPatch, rangeDays,
  resolveRange, shiftPeriod, today, type PeriodState, type Range,
} from './query.ts';
import { fullDate, monthYear, rangeLabel, spanLabel } from './labels.ts';
import { daysBetween } from '../../../../shared/time.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

// ------------------------------------------------------------------ data

export interface Sticky<T> extends Resource<T> {
  /** Data to draw: the latest response, or the previous one while a new view loads. */
  shown: T | undefined;
  /** A new view is loading over older data (dim it; bars transition when it lands). */
  refreshing: boolean;
  /** The view failed to load and there is nothing current to show. */
  failed: boolean;
}

export interface LiveOpts { topics?: string[]; debounceMs?: number; intervalMs?: number }

/**
 * useResource with the live refetch wired here. lib/live.tsx useResource
 * keeps its debounce timer in an effect that re-runs whenever the provider
 * value changes, which it does on every event, so the pending refetch is
 * cleared before it fires. This hook keeps its own timer (reported to C0/foundation).
 */
export function useLiveResource<T>(path: string | null, opts: LiveOpts = {}): Resource<T> {
  const r = useResource<T>(path, { intervalMs: opts.intervalMs });
  const live = useLive();
  const refreshRef = useRef(r.refresh);
  refreshRef.current = r.refresh;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topics = opts.topics ?? [];
  const active = Boolean(path) && topics.length > 0;
  const debounce = opts.debounceMs ?? 150;
  useLiveEvent(topics.length > 0 ? topics : ['~no-topic~'], () => {
    if (!active) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void refreshRef.current();
    }, debounce);
  });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, [path]);
  // Refetch after every (re)connect: events may have been missed.
  useEffect(() => {
    if (!active) return;
    return live.onResync(() => void refreshRef.current());
  }, [active, live.onResync]);
  return r;
}

/**
 * Live resource that keeps the last response on screen while the next view
 * loads, so period and metric switches transition instead of flashing empty.
 */
export function useSticky<T>(path: string | null, opts: LiveOpts = {}): Sticky<T> {
  const r = useLiveResource<T>(path, opts);
  const last = useRef<T | undefined>(undefined);
  if (r.data !== undefined) last.current = r.data;
  const failed = Boolean(r.error) && r.data === undefined && !r.loading;
  const shown = failed ? undefined : (r.data ?? last.current);
  return { ...r, shown, refreshing: r.loading && shown !== undefined, failed };
}

/** Translated error sentence, with the details the API sends for range problems. */
export function errorText(err: ApiError | null, t: T, has: (k: string) => boolean): string {
  if (!err) return '';
  const key = `error.${err.code}`;
  const base = has(key) ? t(key) : t('error.internal');
  const d = err.details as { max_days?: number; fields?: string[]; field?: string } | null | undefined;
  if (err.code === 'validation_failed' && d) {
    if (typeof d.max_days === 'number') return `${base} ${t('insights.range.tooLong', { n: d.max_days })}`;
    if (d.fields || d.field) return `${base} ${t('insights.range.invalid')}`;
  }
  return base;
}

// ------------------------------------------------------------------ states

export function ErrorPanel({ error, onRetry, compact, dark }: { error: ApiError | null; onRetry?: () => void; compact?: boolean; dark?: boolean }) {
  const { t, has } = useI18n();
  const offline = error?.code === 'network_error' || error?.code === 'timeout';
  return (
    <div className={cx('insx-state', dark && 'insx-state--dark')} role="alert" data-surface={dark ? 'dark' : undefined}>
      <EmptyState
        compact={compact}
        icon={offline ? 'wifi-off' : 'alert'}
        title={t('insights.state.loadFailed')}
        action={onRetry ? <Button variant="outline" size="staff" icon="refresh" onClick={onRetry}>{t('insights.state.retry')}</Button> : undefined}
      >
        {errorText(error, t, has)}
      </EmptyState>
    </div>
  );
}

export function PermissionPanel({ need }: { need: 'stats' | 'engagement' }) {
  const { t } = useI18n();
  return (
    <div className="insx-state insx-state--page">
      <EmptyState icon="lock" headingLevel={2} title={t('insights.perm.title')}>
        {t(need === 'stats' ? 'insights.perm.stats' : 'insights.perm.engagement')}
      </EmptyState>
    </div>
  );
}

export function LoadingBlock({ label, height = 240 }: { label: string; height?: number }) {
  return (
    <div className="insx-loading" role="status" aria-label={label}>
      <Skeleton shape="block" width="100%" height={height} />
    </div>
  );
}

// ------------------------------------------------------------------ demo notice and page bar

/** The demo-data notice: why fixtures are (or are not) counted, and how exports are labelled. */
export function DemoNotice({ demoMode, included }: { demoMode: boolean; included: boolean }) {
  const { t } = useI18n();
  if (!demoMode && !included) return null;
  const body = demoMode
    ? (included ? t('insights.demo.includedDemo') : t('insights.demo.excludedDemo'))
    : t('insights.demo.includedLive');
  return (
    <Banner variant={demoMode ? 'demo' : 'warning'} staff role="note" title={included ? t('insights.demo.titleIncluded') : t('insights.demo.titleExcluded')}>
      {body}
    </Banner>
  );
}

export interface ExportLink { href: string; label: string }

/** Freshness ("Data as of 19:52 · refreshed 1 min ago"), the demo-data switch and the CSV exports. */
export function PageBar({
  generatedAt, fetchedAt, stale, failed, onRetry, includeFixture, exports,
}: {
  generatedAt?: string | null;
  fetchedAt: number | null;
  stale?: boolean;
  /** The current view failed to load (nothing to date). */
  failed?: boolean;
  onRetry?: () => void;
  includeFixture: boolean;
  exports: ExportLink[];
}) {
  const { t } = useI18n();
  const live = useLive();
  const now = useNow(30_000);
  let fresh: ReactNode = null;
  if (generatedAt && fetchedAt) {
    const mins = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
    fresh = (
      <>
        {t('insights.fresh.asOf')} <b>{clock(generatedAt)}</b>
        <span aria-hidden="true"> · </span>
        {mins < 1 ? t('insights.fresh.justNow') : t('insights.fresh.ago', { n: mins })}
      </>
    );
  }
  const offline = live.state === 'offline' || live.state === 'reconnecting';
  return (
    <div className="insx-bar">
      <p className="insx-bar__fresh">
        {fresh ?? (failed ? null : <span className="insx-muted">{t('insights.fresh.loading')}</span>)}
        {failed && !fresh ? (
          <span className="insx-bar__warn"><Icon name="alert" size="sm" />{t('insights.fresh.failed')}</span>
        ) : null}
        {stale || (offline && fresh) ? (
          <span className="insx-bar__warn">
            <Icon name={offline ? 'wifi-off' : 'alert'} size="sm" />
            {offline ? t('insights.fresh.offline') : t('insights.fresh.stale')}
            {onRetry && !offline ? <button type="button" className="textlink" onClick={onRetry}>{t('insights.state.retry')}</button> : null}
          </span>
        ) : null}
      </p>
      <div className="insx-bar__tools">
        <Switch
          density="staff"
          checked={includeFixture}
          onChange={(next) => pushQuery({ include_fixture: next ? '1' : '0' })}
          label={t('insights.demo.switch')}
          onLabel={t('insights.demo.on')}
          offLabel={t('insights.demo.off')}
        />
        {exports.map((e, i) => (
          <LinkButton key={e.href} external download variant={i === 0 ? 'outline' : 'ghost'} size="staff" icon="download" href={e.href}>
            {e.label}
          </LinkButton>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ period bar

export interface PeriodBarProps {
  ps: PeriodState;
  periods?: ReadonlyArray<StatsPeriod>;
  layout?: 'stats' | 'ranking';
  /** Earliest date worth showing (first operating date). */
  minDate?: string | null;
  /** The API says there is nothing before this period. */
  prevDisabled?: boolean;
  children?: ReactNode;
}

function relativeLabel(ps: PeriodState, r: Range, t: T, lang: 'th' | 'en'): string {
  const ago = periodsAgo(ps, r);
  switch (ps.period) {
    case 'week':
      if (ago === 0) return t('common.period.thisWeek');
      if (ago === 1) return t('insights.period.lastWeek');
      return t('insights.period.weeksAgo', { n: ago ?? 0 });
    case 'month':
      if (ago === 0) return t('common.period.thisMonth');
      if (ago === 1) return t('insights.period.lastMonth');
      return monthYear(r.from, lang);
    case 'year':
      if (ago === 0) return t('common.period.thisYear');
      if (ago === 1) return t('insights.period.lastYear');
      return r.from.slice(0, 4);
    case 'custom':
      return t('insights.period.customDays', { n: rangeDays(r) });
  }
}

/** Exact dates of a period: "Mon 14 – Sun 20 Sep 2026", "1 – 30 Sep 2026", "1 Jan – 31 Dec 2025". */
export function exactRange(ps: PeriodState, r: Range, lang: 'th' | 'en'): string {
  if (ps.period === 'week' || ps.period === 'custom') return rangeLabel(r, lang);
  return `${spanLabel(r.from, r.to, lang)} ${r.to.slice(0, 4)}`;
}

/** The phrase used in headlines: "this week so far", "last week", "September 2026". */
export function periodPhrase(ps: PeriodState, r: Range, t: T, lang: 'th' | 'en'): string {
  const current = contains(r, today());
  const ago = periodsAgo(ps, r);
  switch (ps.period) {
    case 'week':
      if (current) return t('insights.phrase.thisWeekSoFar');
      if (ago === 1) return t('insights.phrase.lastWeek');
      return t('insights.phrase.weekOf', { date: fullDate(r.from, lang) });
    case 'month':
      return current ? t('insights.phrase.thisMonthSoFar') : monthYear(r.from, lang);
    case 'year':
      return current ? t('insights.phrase.thisYearSoFar', { year: r.from.slice(0, 4) }) : r.from.slice(0, 4);
    case 'custom':
      return rangeLabel(r, lang);
  }
}

export function PeriodBar({ ps, periods = ['week', 'month', 'year', 'custom'], layout = 'stats', minDate, prevDisabled, children }: PeriodBarProps) {
  const { t, lang } = useI18n();
  const now = today();
  const r = resolveRange(ps, now);
  const current = contains(r, now);
  const go = (next: PeriodState) => pushQuery(periodPatch(next));
  const nextDisabled = r.to >= now;
  const beforeStart = Boolean(minDate && r.from <= minDate);

  let label = relativeLabel(ps, r, t, lang);
  let range = exactRange(ps, r, lang);
  if (layout === 'ranking') {
    // Menu Stats leads with the dates actually counted ("Mon 14 – Thu 17 Sep 2026").
    const upTo = current && ps.period !== 'custom' ? { from: r.from, to: now } : r;
    const exact = ps.period === 'week' || ps.period === 'custom' ? rangeLabel(upTo, lang) : `${spanLabel(upTo.from, upTo.to, lang)} ${upTo.to.slice(0, 4)}`;
    range = current && ps.period !== 'custom' ? t('insights.period.soFar', { label }) : label;
    label = exact;
  }

  return (
    <>
      <DateRangeNav
        layout={layout}
        period={ps.period}
        periods={periods}
        onPeriod={(p) => { if (p !== ps.period) go(changePeriodKind(ps, r, p, now)); }}
        label={label}
        range={range}
        timeZone={layout === 'stats' ? 'Asia/Bangkok' : undefined}
        onPrev={() => go(shiftPeriod(ps, r, -1))}
        onNext={() => go(shiftPeriod(ps, r, 1))}
        prevDisabled={prevDisabled || beforeStart}
        nextDisabled={nextDisabled}
        onCurrent={ps.period === 'custom' || (layout === 'ranking' && current) ? undefined : () => go({ ...ps, anchor: null })}
        isCurrent={current}
        date={ps.period === 'custom' ? undefined : (ps.anchor ?? now)}
        onPickDate={ps.period === 'custom' || (layout === 'ranking' && current) ? undefined : (d) => go({ ...ps, anchor: d > now ? now : d })}
        minDate={minDate ?? undefined}
        maxDate={now}
      >
        {children}
      </DateRangeNav>
      {ps.period === 'custom' ? <CustomRange range={r} minDate={minDate} /> : null}
    </>
  );
}

/** Two date fields and an apply button for a custom range (the kit has a single-date picker only). */
function CustomRange({ range, minDate }: { range: Range; minDate?: string | null }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setFrom(range.from); setTo(range.to); setError(null); }, [range.from, range.to]);
  const now = today();
  const apply = () => {
    if (!isDate(from) || !isDate(to)) return setError(t('insights.range.invalid'));
    if (from > to) return setError(t('insights.range.order'));
    if (daysBetween(from, to) + 1 > MAX_CUSTOM_DAYS) return setError(t('insights.range.tooLong', { n: MAX_CUSTOM_DAYS }));
    setError(null);
    pushQuery(periodPatch({ period: 'custom', anchor: null, from, to }));
  };
  const errId = useId();
  return (
    <form
      className="insx-custom"
      onSubmit={(e) => { e.preventDefault(); apply(); }}
      aria-label={t('insights.range.label')}
    >
      <TextField density="staff" type="date" label={t('insights.range.from')} value={from} min={minDate ?? undefined} max={now} onChange={(e) => setFrom(e.target.value)} aria-describedby={error ? errId : undefined} />
      <TextField density="staff" type="date" label={t('insights.range.to')} value={to} min={minDate ?? undefined} max={now} onChange={(e) => setTo(e.target.value)} aria-describedby={error ? errId : undefined} />
      <Button type="submit" variant="outline" size="staff">{t('insights.range.apply')}</Button>
      <p className={cx('insx-custom__note', error && 'is-error')} id={errId} role={error ? 'alert' : undefined}>
        {error ?? t('insights.range.hint', { n: MAX_CUSTOM_DAYS })}
      </p>
    </form>
  );
}

// ------------------------------------------------------------------ chart legend

/** The six chart marks in our own words (missing = before records began, or failed to load). */
export function Legend({ priorLabel, showPrior }: { priorLabel: string; showPrior: boolean }) {
  const { t } = useI18n();
  const items: Array<[string, string]> = [
    ['l-done', t('insights.legend.done')],
    ['l-today', t('insights.legend.today')],
    ['l-future', t('insights.legend.future')],
    ['l-zero', t('insights.legend.zero')],
    ['l-missing', t('insights.legend.missing')],
  ];
  if (showPrior) items.push(['l-prior', priorLabel]);
  return (
    <ul className="chart__legend insx-legend" aria-label={t('common.chart.legend')}>
      {items.map(([cls, text]) => (
        <li key={cls} className="lg">
          <i className={cls} aria-hidden="true" />
          {text}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ horizontal share list

export interface HBarItem {
  key: string;
  label: ReactNode;
  lang?: string;
  value: number;
  /** Right-hand figure ("1,914"). */
  valueText?: string;
  /** Small text after the figure ("95%"). */
  note?: string;
  /** 0..1 meter width; defaults to value / max. */
  ratio?: number;
  muted?: boolean;
}

/** Labelled horizontal meters (category exposure, scroll depth, funnel). A real list; figures are text. */
export function HBars({ items, label, tone = 'ink', className }: { items: HBarItem[]; label: string; tone?: 'ink' | 'ok'; className?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cx('insx-hbars', tone === 'ok' && 'insx-hbars--ok', className)} aria-label={label}>
      {items.map((i) => {
        const w = Math.round(Math.max(0, Math.min(1, i.ratio ?? i.value / max)) * 1000) / 10;
        return (
          <li key={i.key} className={cx('insx-hbar', i.muted && 'is-muted')}>
            <span className="insx-hbar__label" lang={i.lang}>{i.label}</span>
            <span className="insx-hbar__fig">
              <b>{i.valueText ?? num(i.value)}</b>
              {i.note ? <small>{i.note}</small> : null}
            </span>
            <span className="insx-hbar__track" aria-hidden="true"><i style={{ width: `${w}%` }} /></span>
          </li>
        );
      })}
    </ul>
  );
}

/** Two-part split meter ("attributed / unattributed", "dining / public"). */
export function SplitMeter({ parts, label }: { parts: Array<{ key: string; value: number; text: string; tone: 'ink' | 'soft' }>; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="insx-split">
      <div className="insx-split__bar" aria-hidden="true">
        {parts.map((p) => (
          <i key={p.key} className={`is-${p.tone}`} style={{ width: `${total > 0 ? (p.value / total) * 100 : 0}%` }} />
        ))}
      </div>
      <ul className="insx-split__legend" aria-label={label}>
        {parts.map((p) => (
          <li key={p.key}><i className={`is-${p.tone}`} aria-hidden="true" />{p.text}</li>
        ))}
      </ul>
    </div>
  );
}

/** A titled card on the paper canvas. */
export function Card({ title, titleId, aside, children, className, icon }: { title: ReactNode; titleId?: string; aside?: ReactNode; children: ReactNode; className?: string; icon?: IconName }) {
  const auto = useId();
  const id = titleId ?? `c${auto.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <section className={cx('insx-card', className)} aria-labelledby={id}>
      <div className="insx-card__head">
        <h3 id={id}>{icon ? <Icon name={icon} size="sm" /> : null}{title}</h3>
        {aside ? <div className="insx-card__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Milliseconds since the server's "now" (used for "same time last week"). */
export function serverNow(): number {
  return nowMs();
}
