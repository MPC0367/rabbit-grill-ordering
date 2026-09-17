// Order Stats (brief 37, DESIGN §10.20–10.21): period bar, metric selector,
// the charcoal headline + day chart, today's cards and the day drill-down.
// Totals are the server's period-level figures (distinct counts are never
// summed from days); comparisons follow D-S6-04 and say so in words.
import { useEffect, useRef, useState } from 'react';
import type { DayBucketDTO, DayDrilldownDTO, OrderMetric, OrderStatsDTO } from '../../../../shared/dto.ts';
import { addDays, daysBetween } from '../../../../shared/time.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive } from '../../lib/live.tsx';
import { useRoute } from '../../lib/router.ts';
import { useMedia, useNow } from '../../lib/store.ts';
import { clock, num, weekdayShort } from '../../lib/format.ts';
import {
  Button, ChartPanel, HeroMetric, MetricSwitch, Sheet, StatCard, StatGrid, WeekBarChart, announce, cx,
  type ChartBucket, type HeroMetricProps, type KeyValueItem,
} from '../../ui/index.ts';
import {
  ErrorPanel, Legend, PageBar, PeriodBar, exactRange, periodPhrase, useLiveResource, useSticky, type Sticky,
} from './parts.tsx';
import {
  METRICS, contains, periodParams, pushQuery, queryString, readMetric, readPeriod, replaceQuery, resolveRange,
  today, nowMs, type PeriodState,
} from './query.ts';
import { dayMonth, dayShort, durationParts, fullDate, monthShort, monthYear, signed, signedPct, spanLabel, spokenDate, weekdaySpan } from './labels.ts';
import { DayDrilldown } from './DayDrilldown.tsx';

const TOPICS = ['order.', 'line.', 'visit.', 'portion.', 'report.'];

export const METRIC_KEY: Record<OrderMetric, string> = {
  rounds: 'rounds', accepted_rounds: 'accepted', visits: 'visits', devices: 'devices', diners: 'diners', items: 'items',
};

type T = (key: string, vars?: Record<string, string | number>) => string;

function selectableKey(b: DayBucketDTO): boolean {
  return b.state === 'complete' || b.state === 'partial';
}

function defaultSelection(buckets: DayBucketDTO[]): string | null {
  const sel = buckets.filter(selectableKey);
  const partial = sel.find((b) => b.state === 'partial');
  if (partial) return partial.date;
  const withValue = [...sel].reverse().find((b) => (b.value ?? 0) > 0);
  return withValue?.date ?? sel[sel.length - 1]?.date ?? null;
}

export default function OrderStats({ includeFixture, headingId }: { includeFixture: boolean; headingId: string }) {
  const { t, lang } = useI18n();
  const { query } = useRoute();
  const live = useLive();
  const narrow = useMedia('(max-width: 767px)');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [guideOpen, setGuideOpen] = useState(false);

  const ps = readPeriod(query);
  const metric = readMetric(query);
  const mk = METRIC_KEY[metric];
  const now = today();
  const range = resolveRange(ps, now);
  const current = contains(range, now);
  const fx = includeFixture ? '1' : '0';
  const path = `/api/staff/stats/orders${queryString({ metric, ...periodParams(ps), include_fixture: fx })}`;
  const stats = useSticky<OrderStatsDTO>(path, { topics: TOPICS, debounceMs: 2000, intervalMs: current ? 60_000 : undefined });
  const data = stats.shown;
  const fresh = stats.data;

  // Same day / date / month in the previous period, for the prior ticks (full values).
  const priorPs: PeriodState | null = fresh && fresh.previous.total !== null
    ? (ps.period === 'custom'
      ? { period: 'custom', anchor: null, from: fresh.previous.from, to: fresh.previous.to }
      : { period: ps.period, anchor: fresh.previous.from, from: null, to: null })
    : null;
  const prior = useLiveResource<OrderStatsDTO>(
    priorPs ? `/api/staff/stats/orders${queryString({ metric, ...periodParams(priorPs), include_fixture: fx })}` : null,
    { topics: ['report.'] },
  );

  // Orders today vs the same weekday last week, up to the same time.
  const lastWeekDay = addDays(now, -7);
  const lastWeek = useLiveResource<DayDrilldownDTO>(`/api/staff/stats/orders/day${queryString({ date: lastWeekDay, include_fixture: fx })}`, { topics: ['report.'] });
  const tick = useNow(60_000);

  // Announce a newly loaded view (never the whole list, never a live refresh).
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!fresh) return;
    if (announced.current !== null && announced.current !== path) {
      announce(t('insights.announce.view', { metric: t(`insights.metric.${mk}`), period: periodPhrase(ps, range, t, lang), n: num(fresh.total) }));
    }
    announced.current = path;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  const buckets = data?.buckets ?? [];
  const urlDay = query.get('day');
  const selectedKey = buckets.find((b) => b.date === urlDay && selectableKey(b))?.date ?? defaultSelection(buckets);
  const selectedBucket = buckets.find((b) => b.date === selectedKey) ?? null;
  const isYear = data ? data.period === 'year' : ps.period === 'year';

  const exportHref = `/api/staff/stats/export.csv${queryString({ view: 'orders', metric, ...periodParams(ps), include_fixture: fx })}`;
  const metricOptions = METRICS.map((m) => ({ value: m, label: t(`insights.metric.${METRIC_KEY[m]}`) }));

  const chartTitle = t(isYear ? 'insights.chart.perMonth' : 'insights.chart.perDay', { what: t(`insights.metric.${mk}.chart`) });
  const unitWord = t(`insights.metric.${mk}.spoken`);
  const priorLabel = t(`insights.legend.prior.${ps.period}`);
  const priorBuckets = prior.data && fresh && prior.data.buckets.length > 0 ? prior.data.buckets : null;

  const chartBuckets: ChartBucket[] = buckets.map((b, i) => {
    const bd = b.breakdown;
    const p = priorBuckets?.[i];
    const priorValue = b.state === 'complete' && p && p.state === 'complete' ? p.value : null;
    const detailParts = [
      t('insights.chart.detail', { accepted: num(bd.accepted), rejected: num(bd.rejected), cancelled: num(bd.cancelled), visits: num(bd.visits) }),
    ];
    if (metric === 'diners') detailParts.push(t('insights.hero.coverage', { n: num(bd.diners_coverage.with_covers), m: num(bd.diners_coverage.visits) }));
    if (isYear) {
      return {
        key: b.date,
        label: monthShort(b.date, lang),
        spoken: monthYear(b.date, lang),
        state: b.state,
        value: b.value,
        prior: priorValue,
        detail: detailParts.join(lang === 'th' ? ' ' : ', '),
      };
    }
    const monthView = data?.period === 'month' || (data?.period === 'custom' && buckets.length > 14);
    return {
      key: b.date,
      label: monthView ? String(Number(b.date.slice(8))) : weekdayShort(b.date, lang),
      sublabel: monthView ? undefined : dayMonth(b.date, lang, false),
      spoken: spokenDate(b.date, lang),
      state: b.state,
      value: b.value,
      prior: priorValue,
      detail: detailParts.join(lang === 'th' ? ' ' : ', '),
    };
  });

  const hero = data ? heroProps(data, ps, t, lang, selectedBucket, metric) : null;

  return (
    <div className="insx-view" data-view="orders">
      <PageBar
        generatedAt={data?.generated_at}
        fetchedAt={stats.fetchedAt}
        stale={stats.stale}
        failed={stats.failed}
        onRetry={() => void stats.refresh()}
        includeFixture={includeFixture}
        exports={[{ href: exportHref, label: t('insights.export.view') }]}
      />
      <PeriodBar
        ps={ps}
        minDate={fresh?.first_operating_date ?? null}
        prevDisabled={fresh ? fresh.previous.note === 'no_prior_data' || fresh.previous.note === 'no_data_yet' : false}
      />
      <MetricSwitch
        label={t('insights.metric.label')}
        options={metricOptions}
        value={metric}
        onChange={(m) => pushQuery({ metric: m === 'rounds' ? null : m })}
        onExplain={() => setGuideOpen(true)}
      />

      {stats.failed ? (
        <ChartPanel solo labelledBy={headingId}>
          <ErrorPanel error={stats.error} onRetry={() => void stats.refresh()} dark />
        </ChartPanel>
      ) : !data || !hero ? (
        <ChartPanel labelledBy={headingId} className="insx-panel-loading" aria-busy="true">
          <div className="headline"><p className="cap">{t(`insights.metric.${mk}`)}</p><p className="headline__v insx-skel-v">—</p><p className="headline__u">{t('insights.state.loading')}</p></div>
          <div className="chart"><div className="insx-skel-plot" /></div>
        </ChartPanel>
      ) : (
        <ChartPanel labelledBy="insx-hero-label" className={cx(stats.refreshing && 'is-refreshing')} aria-busy={stats.refreshing || undefined}>
          <HeroMetric {...hero} labelId="insx-hero-label" />
          <div className="insx-chartcol">
            <WeekBarChart
              title={chartTitle}
              unit={unitWord}
              listLabel={t(isYear ? 'insights.chart.listMonths' : 'insights.chart.listDays', { what: t(`insights.metric.${mk}`) })}
              buckets={chartBuckets}
              selectedKey={selectedKey}
              onSelect={(key) => replaceQuery({ day: key })}
              view={view}
              onViewChange={setView}
              height={narrow ? 200 : 300}
              legend={false}
              priorLabel={priorLabel}
              priorSpoken={t(`insights.legend.priorSpoken.${ps.period}`)}
              currentLabel={isYear ? monthShort(buckets.find((b) => b.state === 'partial')?.date ?? '2000-01', lang) : undefined}
            />
            {view === 'chart' ? <Legend priorLabel={priorLabel} showPrior={Boolean(priorBuckets)} /> : null}
            {data.first_operating_date === null || buckets.every((b) => b.state === 'missing' || b.state === 'future') ? (
              <p className="insx-chart-note">{t(includeFixture ? 'insights.chart.noneYet' : 'insights.chart.noneReal')}</p>
            ) : null}
          </div>
        </ChartPanel>
      )}

      <TodayCards stats={stats} lastWeek={lastWeek.data ?? null} tick={tick} liveOk={live.state === 'live'} />

      {isYear ? (
        selectedBucket ? (
          <section className="insx-section insx-monthcue" aria-labelledby="insx-month-h">
            <h2 id="insx-month-h" className="insx-h2">{monthYear(selectedBucket.date, lang)}</h2>
            <p className="insx-muted">{t('insights.year.cue')}</p>
            <Button variant="outline" size="staff" iconEnd="chev-r" onClick={() => pushQuery({ period: 'month', anchor: `${selectedBucket.date}-01`, day: null })}>
              {t('insights.year.openMonth', { month: monthYear(selectedBucket.date, lang) })}
            </Button>
          </section>
        ) : null
      ) : selectedKey && data ? (
        <DayDrilldown
          date={selectedKey}
          includeFixture={includeFixture}
          metric={metric}
          isToday={selectedBucket?.state === 'partial'}
        />
      ) : null}

      <MetricGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  );
}

// ------------------------------------------------------------------ headline

function heroProps(data: OrderStatsDTO, ps: PeriodState, t: T, lang: 'th' | 'en', sel: DayBucketDTO | null, metric: OrderMetric): HeroMetricProps & { label: string } {
  const mk = METRIC_KEY[metric];
  const range = { from: data.from, to: data.to };
  const partial = data.buckets.find((b) => b.state === 'partial');
  const todayDate = partial ? (data.period === 'year' ? today() : partial.date) : null;
  const time = clock(data.generated_at);
  const unit = t(`insights.metric.${mk}.unit`);
  let sentence: string;
  if (todayDate) {
    const shortOf = (d: string) => (data.period === 'week' ? dayShort(d, lang) : dayMonth(d, lang, false));
    sentence = t('insights.hero.soFar', { unit, from: shortOf(range.from), to: shortOf(todayDate), time });
  } else {
    sentence = t('insights.hero.span', { unit, range: exactRange({ ...ps, period: data.period }, range, lang) });
  }
  if (metric === 'diners') {
    const cov = data.buckets.reduce((acc, b) => ({ n: acc.n + b.breakdown.diners_coverage.with_covers, m: acc.m + b.breakdown.diners_coverage.visits }), { n: 0, m: 0 });
    sentence = t('insights.hero.withNote', { sentence, note: t('insights.hero.coverageFull', { n: num(cov.n), m: num(cov.m) }) });
  }
  if (metric === 'devices') sentence = t('insights.hero.withNote', { sentence, note: t('insights.hero.devicesNote') });

  const c = data.change;
  const p = data.previous;
  const prevWord = t(`insights.prev.${data.period}`);
  let comparison: HeroMetricProps['comparison'];
  if (c.label === 'no_baseline') {
    let sub: string | undefined;
    if (p.total === 0) sub = t('insights.cmp.zeroPrior', { prev: prevWord, change: signed(c.absolute ?? data.total) });
    else if (p.note === 'no_prior_data') sub = t('insights.cmp.noPrior', { date: data.first_operating_date ? fullDate(data.first_operating_date, lang) : '—' });
    else if (p.note === 'no_data_yet') sub = t('insights.cmp.noData');
    else if (p.note === 'future_period') sub = t('insights.cmp.future');
    comparison = { direction: 'none', text: '', sub };
  } else {
    const abs = c.absolute ?? 0;
    const direction = c.label === 'unequal_coverage' ? (abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat') : c.label;
    // The server cuts the previous total at the same elapsed point whenever the period contains today (D-S6-04).
    const sameSpan = todayDate !== null;
    const text = sameSpan
      ? t('insights.cmp.vsSamePoint', { n: num(p.total ?? 0), prev: prevWord })
      : t('insights.cmp.vs', { n: num(p.total ?? 0), prev: prevWord });
    let span: string;
    if (sameSpan && todayDate) {
      const elapsed = daysBetween(range.from, todayDate);
      let equiv = data.period === 'year' ? `${p.from.slice(0, 4)}${todayDate.slice(4)}` : addDays(p.from, elapsed);
      if (equiv.endsWith('-02-29') && data.period === 'year') equiv = `${p.from.slice(0, 4)}-02-28`;
      if (equiv > p.to) equiv = p.to;
      const s = data.period === 'week' ? weekdaySpan(p.from, equiv, lang) : `${spanLabel(p.from, equiv, lang)}${data.period === 'year' ? ` ${p.from.slice(0, 4)}` : ''}`;
      span = t('insights.cmp.spanTo', { span: s, time: clock(data.generated_at) });
    } else {
      span = exactRange({ ...ps, period: data.period }, { from: p.from, to: p.to }, lang);
    }
    const sub = c.label === 'unequal_coverage'
      ? `${span} · ${t('insights.cmp.unequal', { date: data.first_operating_date ? fullDate(data.first_operating_date, lang) : '—' })}`
      : c.percent !== null ? `${span} · ${signedPct(c.percent)}` : span;
    comparison = { direction, delta: num(Math.abs(abs)), text, sub };
  }

  let selected: HeroMetricProps['selected'] = null;
  if (sel) {
    const bd = sel.breakdown;
    const items: KeyValueItem[] = [
      { key: 'sub', term: t('insights.sel.submitted'), value: num(bd.submitted) },
      { key: 'acc', term: t('insights.sel.accepted'), value: num(bd.accepted) },
      { key: 'rc', term: t('insights.sel.rejectedCancelled'), value: `${num(bd.rejected)} · ${num(bd.cancelled)}` },
    ];
    const pending = bd.submitted - bd.accepted - bd.rejected - bd.cancelled;
    if (pending > 0) items.push({ key: 'pend', term: t('insights.sel.pending'), value: num(pending) });
    items.push({ key: 'vis', term: t('insights.sel.visits'), value: num(bd.visits) });
    if (metric === 'devices') items.push({ key: 'dev', term: t('insights.sel.devices'), value: num(bd.devices) });
    if (metric === 'diners') {
      items.push({ key: 'din', term: t('insights.sel.diners'), value: num(bd.diners) });
      items.push({ key: 'cov', term: t('insights.sel.coverage'), value: `${num(bd.diners_coverage.with_covers)}/${num(bd.diners_coverage.visits)}` });
    }
    if (metric === 'items') items.push({ key: 'itm', term: t('insights.sel.items'), value: num(bd.items) });
    const isMonth = data.period === 'year';
    selected = {
      title: isMonth ? monthYear(sel.date, lang) : dayMonth(sel.date, lang),
      tag: sel.state === 'partial' ? t(isMonth ? 'insights.sel.thisMonthSoFar' : 'insights.sel.todaySoFar') : t('common.stats.selected'),
      items,
    };
  }

  return {
    label: `${t(`insights.metric.${mk}`)} · ${periodPhrase({ ...ps, period: data.period }, range, t, lang)}`,
    value: num(data.total),
    unit: sentence,
    comparison,
    selected,
  };
}

// ------------------------------------------------------------------ today cards

function TodayCards({ stats, lastWeek, tick, liveOk }: {
  stats: Sticky<OrderStatsDTO>;
  lastWeek: DayDrilldownDTO | null;
  tick: number;
  liveOk: boolean;
}) {
  const { t, lang } = useI18n();
  const state: 'ready' | 'loading' | 'error' = stats.failed ? 'error' : stats.shown ? 'ready' : 'loading';
  const retry = () => void stats.refresh();
  const cards = stats.shown?.cards;
  void tick;

  let ordersCmp = null;
  if (cards && lastWeek) {
    const cut = nowMs() - 7 * 86_400_000;
    const n = lastWeek.orders.filter((o) => Date.parse(o.submitted_at) < cut).length;
    const d = cards.orders_today - n;
    ordersCmp = {
      direction: d > 0 ? 'up' as const : d < 0 ? 'down' as const : 'flat' as const,
      delta: num(Math.abs(d)),
      text: t('insights.card.ordersCmp', { n: num(n), day: weekdayShort(lastWeek.date, lang), time: clock(new Date(nowMs()).toISOString()) }),
    };
  }

  const cov = cards?.diners_coverage_today;
  const accept = cards ? durationParts(cards.median_accept_seconds === null ? null : cards.median_accept_seconds * 1000, t) : null;

  return (
    <StatGrid role="group" aria-label={t('insights.card.group')}>
      <StatCard
        label={t('insights.card.ordersToday')}
        state={state}
        onRetry={retry}
        value={cards ? num(cards.orders_today) : undefined}
        live={liveOk}
        comparison={ordersCmp}
        note={!liveOk && cards ? t('insights.card.notLive') : undefined}
        definition={<p>{t('insights.def.ordersToday')}</p>}
      />
      <StatCard
        label={t('insights.card.visitsToday')}
        state={state}
        onRetry={retry}
        value={cards ? num(cards.visits_ordering_today) : undefined}
        unit={t('insights.card.today')}
        note={t('insights.card.visitsNote')}
        definition={<p>{t('insights.def.visits')}</p>}
      />
      <StatCard
        label={t('insights.card.dinersToday')}
        state={state}
        onRetry={retry}
        value={cards ? num(cards.diners_today) : undefined}
        unit={t('insights.card.today')}
        coverage={cov ? {
          ratio: cov.visits > 0 ? cov.with_covers / cov.visits : 0,
          text: cov.visits > 0
            ? <>{t('insights.card.coverageLead')} <b>{t('insights.card.coverageNofM', { n: num(cov.with_covers), m: num(cov.visits) })}</b> {t('insights.card.coverageTail')}</>
            : t('insights.card.noSeated'),
        } : null}
        definition={<p>{t('insights.def.diners')}</p>}
      />
      <StatCard
        label={t('insights.card.acceptToday')}
        state={state}
        onRetry={retry}
        parts={accept ?? undefined}
        value={accept ? undefined : '—'}
        note={cards ? (cards.accept_sample > 0 ? t('insights.card.acceptNote', { n: num(cards.accept_sample) }) : t('insights.card.acceptNone')) : undefined}
        definition={<p>{t('insights.def.accept')}</p>}
      />
      <StatCard
        label={t('insights.card.unresolved')}
        state={state}
        onRetry={retry}
        value={cards ? num(cards.unresolved_orders) : undefined}
        live={liveOk}
        note={t('insights.card.unresolvedNote')}
        definition={<p>{t('insights.def.unresolved')}</p>}
      />
    </StatGrid>
  );
}

// ------------------------------------------------------------------ metric guide

function MetricGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onClose={onClose} variant="dialog" wide title={t('insights.guide.title')}>
      <dl className="insx-guide">
        {METRICS.map((m) => (
          <div key={m} className="insx-guide__row">
            <dt>{t(`insights.metric.${METRIC_KEY[m]}`)}</dt>
            <dd>{t(`insights.def.metric.${METRIC_KEY[m]}`)}</dd>
          </div>
        ))}
      </dl>
      <p className="insx-fine">{t('insights.guide.distinct')}</p>
      <p className="insx-fine">{t('insights.guide.time')}</p>
    </Sheet>
  );
}
