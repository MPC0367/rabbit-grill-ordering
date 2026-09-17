// Menu Stats (brief 38, 44F; DESIGN §10.22): item ranking by period,
// category, direction and measure, with availability context, Top 5/10 and
// the full searchable ranking, and a per-item detail drawer. Ranking order
// and ties come from the server (D-S6-06); for the "All food" / "All drinks"
// scopes the same competition ranking and shares are recomputed over the
// rows of that group.
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { AdminCatalogDTO, MenuStatsDTO, RankingRowDTO, StatsPeriod } from '../../../../shared/dto.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import { clock, num } from '../../lib/format.ts';
import {
  DefinitionButton, EmptyState, FilterChips, Icon, RankingRow, RankingTable, SectionHeader, SegmentedControl, SelectButton,
  StaffSearch, announce, dishImageUrl, normalizeSearch, type RankContext,
} from '../../ui/index.ts';
import { ErrorPanel, LoadingBlock, PageBar, PeriodBar, useLiveResource, useSticky } from './parts.tsx';
import {
  MEASURES, periodParams, pushQuery, queryString, readCategory, readDirection, readMeasure, readPeriod, readTop,
  replaceQuery, contains, elapsedEquivalent, resolveRange, today, type Measure, type TopN,
} from './query.ts';
import { rangeLabel, share, spanLabel, weightText } from './labels.ts';
import { ItemDrawer } from './ItemDrawer.tsx';

const TOPICS = ['order.', 'line.', 'menu.', 'portion.', 'report.'];
const PAST_TOPICS = ['menu.', 'report.'];

type T = (key: string, vars?: Record<string, string | number>) => string;

export function measureValue(r: RankingRowDTO, m: Measure): number | null {
  switch (m) {
    case 'net': return r.net_qty;
    case 'submitted': return r.submitted_qty;
    case 'grams': return r.grams ?? 0;
    case 'per_available_day': return r.per_available_day;
  }
}

/** Competition ranking (1, 2, 2, 4) over rows already in the server's order; shares of the listed net total. */
function rerank(rows: RankingRowDTO[], m: Measure): RankingRowDTO[] {
  const total = rows.reduce((s, r) => s + r.net_qty, 0);
  let rank = 0;
  let last: number | null | undefined;
  return rows.map((r, i) => {
    const v = measureValue(r, m);
    if (i === 0 || v !== last) rank = i + 1;
    last = v;
    return { ...r, rank, share: total > 0 ? Math.round((r.net_qty / total) * 10_000) / 10_000 : null };
  });
}

export default function MenuStats({ includeFixture, headingId }: { includeFixture: boolean; headingId: string }) {
  const { t, lang, pick } = useI18n();
  const { query } = useRoute();
  const ps = readPeriod(query);
  const direction = readDirection(query);
  const measure = readMeasure(query);
  const category = readCategory(query);
  const top = readTop(query);
  const urlQ = query.get('q') ?? '';
  const [search, setSearch] = useState(urlQ);
  const [openId, setOpenId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSearch(urlQ); }, [urlQ]);
  useEffect(() => {
    if (search === urlQ) return;
    const id = setTimeout(() => replaceQuery({ q: search.trim() || null }), 250);
    return () => clearTimeout(id);
  }, [search, urlQ]);

  const group = category === 'food' || category === 'drinks' ? category : null;
  const whole = category === 'all';
  const fx = includeFixture ? '1' : '0';
  const params = { ...periodParams(ps), category: group || whole ? null : category, direction, measure, include_fixture: fx };
  const path = `/api/staff/stats/menu${queryString(params)}`;
  // A past period only changes through late corrections, which the server announces as report.* events.
  const current = contains(resolveRange(ps, today()), today());
  const ranking = useSticky<MenuStatsDTO>(path, { topics: current ? TOPICS : PAST_TOPICS, debounceMs: 2500 });
  const catalog = useLiveResource<AdminCatalogDTO>('/api/staff/menu', { topics: ['menu.'], debounceMs: 1000 });

  const maps = useMemo(() => {
    const cat = new Map<string, { group: 'food' | 'drinks' }>();
    const item = new Map<string, string>();
    for (const c of catalog.data?.categories ?? []) cat.set(c.id, { group: c.group });
    for (const i of catalog.data?.items ?? []) item.set(i.id, i.category_id);
    return { cat, item };
  }, [catalog.data]);

  const data = ranking.shown;
  const needCatalog = group !== null;
  const ready = Boolean(data) && (!needCatalog || Boolean(catalog.data));

  const rows = useMemo(() => {
    if (!data) return [];
    const base = group
      ? data.rows.filter((r) => maps.cat.get(maps.item.get(r.item_id) ?? '')?.group === group)
      : data.rows;
    return rerank(base, measure);
  }, [data, group, maps, measure]);

  const needle = normalizeSearch(search);
  const matches = needle
    ? rows.filter((r) => normalizeSearch(`${r.name.th ?? ''} ${r.name.en ?? ''} ${r.category.th ?? ''} ${r.category.en ?? ''}`).includes(needle))
    : rows;
  const limit = top === 'all' || needle ? matches.length : Number(top);
  const visible = matches.slice(0, limit);
  const maxValue = Math.max(0, ...rows.map((r) => measureValue(r, measure) ?? 0));
  const never = rows.filter((r) => r.quality === 'never_ordered_despite_availability').length;
  const insufficient = rows.filter((r) => r.quality === 'insufficient_availability').length;

  // Category choices: whole groups first, then each category in menu order.
  const catOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: 'food', label: t('insights.menu.cat.food') },
      { value: 'drinks', label: t('insights.menu.cat.drinks') },
      { value: 'all', label: t('insights.menu.cat.all') },
    ];
    const cats = catalog.data?.categories ?? [];
    for (const g of catalog.data?.groups ?? []) {
      for (const id of g.category_ids) {
        const c = cats.find((x) => x.id === id);
        if (!c) continue;
        const name = pick(c.name).text;
        opts.push({ value: c.id, label: c.status === 'published' ? name : `${name} · ${t('insights.menu.cat.notListed')}` });
      }
    }
    for (const c of cats) {
      if (!opts.some((o) => o.value === c.id)) opts.push({ value: c.id, label: pick(c.name).text });
    }
    if (!opts.some((o) => o.value === category)) opts.push({ value: category, label: t('insights.menu.cat.unknown') });
    return opts;
  }, [catalog.data, category, pick, t]);
  const catName = catOptions.find((o) => o.value === category)?.label ?? '';
  const scope = group ? t(`insights.menu.scope.${group}`) : whole ? t('insights.menu.scope.all') : t('insights.menu.scope.category', { name: catName });

  // Announce explicit filter changes once the new ranking is in.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!ranking.data || !ready) return;
    const key = `${path}|${category}`;
    if (announced.current !== null && announced.current !== key) {
      announce(t('insights.menu.announce', { n: num(rows.length), scope }));
    }
    announced.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking.data, ready, category]);

  const periodWord = t(`insights.menu.vs.${ps.period}`);
  const measureDesc = t(`insights.measure.${measure}.desc`);
  const description = `${t(direction === 'most' ? 'insights.menu.most' : 'insights.menu.least')} · ${measureDesc}`;
  const exportHref = `/api/staff/stats/export.csv${queryString({ view: 'menu', ...params })}`;
  const openRow = openId ? rows.find((r) => r.item_id === openId) ?? data?.rows.find((r) => r.item_id === openId) ?? null : null;

  const onTableClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select')) return;
    const row = target.closest<HTMLElement>('.rank');
    const cls = row ? Array.from(row.classList).find((c) => c.startsWith('insx-r-')) : undefined;
    if (cls) setOpenId(cls.slice('insx-r-'.length));
  };

  let body: ReactNode;
  if (ranking.failed) {
    body = <ErrorPanel error={ranking.error} onRetry={() => void ranking.refresh()} />;
  } else if (needCatalog && catalog.error && !catalog.data) {
    body = <ErrorPanel error={catalog.error} onRetry={() => void catalog.refresh()} />;
  } else if (!ready) {
    body = <LoadingBlock label={t('insights.state.loading')} height={420} />;
  } else {
    const empty = matches.length === 0
      ? (
        <EmptyState compact icon={needle ? 'search' : 'list'} title={needle ? t('insights.menu.noMatch', { q: search.trim() }) : t(direction === 'most' ? 'insights.menu.emptyMost' : 'insights.menu.emptyLeast')}>
          {needle ? t('insights.menu.noMatchText') : t('insights.menu.emptyText')}
        </EmptyState>
      )
      : undefined;
    const footerText = needle
      ? <>{t(matches.length === 1 ? 'insights.menu.matchesOne' : 'insights.menu.matches', { n: num(matches.length), q: search.trim() })}</>
      : (
        <>
          {t('insights.menu.footer', { n: num(visible.length), total: num(rows.length), scope })}
          {never > 0 ? <> · <b>{num(never)}</b> {t('insights.menu.footerNever')}</> : null}
          {insufficient > 0 ? <> · <b>{num(insufficient)}</b> {t('insights.menu.footerInsufficient')}</> : null}
        </>
      );
    const footerAction = !needle && top !== 'all' && rows.length > Number(top)
      ? (
        <button type="button" className="btn btn--outline btn--staff" onClick={() => replaceQuery({ top: 'all' })}>
          {t('insights.menu.fullRanking')}
        </button>
      )
      : !needle && top === 'all' && rows.length > 10
        ? (
          <button type="button" className="btn btn--ghost btn--staff" onClick={() => { replaceQuery({ top: null }); tableRef.current?.scrollIntoView({ block: 'nearest' }); }}>
            {t('insights.menu.showTop10')}
          </button>
        )
        : undefined;
    body = (
      <>
        <div ref={tableRef} className="insx-rankwrap">
        <RankingTable
          label={t('insights.menu.tableLabel', { direction: t(direction === 'most' ? 'insights.menu.most' : 'insights.menu.least'), scope, period: rangeLabel({ from: data!.from, to: data!.to }, lang) })}
          changeHeader={periodWord}
          refreshing={ranking.refreshing}
          empty={empty}
          footerText={footerText}
          footerAction={footerAction}
          onClick={onTableClick}
          className="insx-ranks"
        >
          {visible.map((r) => (
            <RankingRow key={r.item_id} className={`insx-r-${r.item_id}`} {...rowProps(r, measure, maxValue, t, pick, () => setOpenId(r.item_id))} />
          ))}
        </RankingTable>
        </div>
        <div className="insx-notes">
          <p className="insx-fine">{t('insights.menu.tie')}</p>
          <p className="insx-fine">{comparisonNote(data!, t, lang, ps.period)}</p>
          {group && needCatalog ? <p className="insx-fine">{t('insights.menu.groupCsv')}</p> : null}
        </div>
      </>
    );
  }

  return (
    <div className="insx-view" data-view="menu">
      <PageBar
        generatedAt={data?.generated_at}
        fetchedAt={ranking.fetchedAt}
        stale={ranking.stale}
        failed={ranking.failed}
        onRetry={() => void ranking.refresh()}
        includeFixture={includeFixture}
        exports={[{ href: exportHref, label: group ? t('insights.export.menuAll') : t('insights.export.view') }]}
      />
      <section className="insx-section insx-menu" aria-labelledby={headingId}>
        <SectionHeader
          display
          titleId={headingId}
          title={t('insights.tab.menu')}
          description={description}
          actions={<StaffSearch className="insx-find" label={t('insights.menu.search')} placeholder={t('insights.menu.search')} value={search} onChange={setSearch} />}
        />
        <PeriodBar
          ps={ps}
          layout="ranking"
          prevDisabled={data ? data.previous?.note === 'no_prior_data' || data.previous?.note === 'no_data_yet' : false}
        >
          <SelectButton
            label={t('insights.menu.category')}
            value={category}
            options={catOptions}
            onChange={(v) => pushQuery({ category: v === 'food' ? null : v })}
          />
          <FilterChips
            label={t('insights.menu.order')}
            value={direction}
            onChange={(v) => pushQuery({ direction: v === 'most' ? null : v })}
            options={[
              { value: 'most', label: t('insights.menu.most') },
              { value: 'least', label: t('insights.menu.least') },
            ]}
          />
        </PeriodBar>
        <div className="insx-rankbar">
          <div className="insx-rankbar__measure">
            <SelectButton
              label={t('insights.measure.label')}
              value={measure}
              options={MEASURES.map((m) => ({ value: m, label: t(`insights.measure.${m}`) }))}
              onChange={(v) => pushQuery({ measure: v === 'net' ? null : v })}
            />
            <DefinitionButton label={t('insights.measure.defLabel')}>
              {MEASURES.map((m) => (
                <p key={m}><b>{t(`insights.measure.${m}`)}</b> · {t(`insights.measure.${m}.def`)}</p>
              ))}
            </DefinitionButton>
          </div>
          <SegmentedControl<TopN>
            size="staff"
            label={t('insights.menu.show')}
            value={needle ? 'all' : top}
            onChange={(v) => replaceQuery({ top: v === '10' ? null : v })}
            options={[
              { value: '5', label: t('insights.menu.top', { n: 5 }), disabled: Boolean(needle) },
              { value: '10', label: t('insights.menu.top', { n: 10 }), disabled: Boolean(needle) },
              { value: 'all', label: t('insights.menu.all') },
            ]}
          />
        </div>
        {body}
      </section>
      {openRow ? (
        <ItemDrawer
          row={openRow}
          ps={ps}
          includeFixture={includeFixture}
          image={openRow.image}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

function comparisonNote(data: MenuStatsDTO, t: T, lang: 'th' | 'en', period: StatsPeriod): string {
  const p = data.previous;
  if (!p) return '';
  if (p.note === 'no_prior_data' || p.note === 'no_data_yet' || p.note === 'future_period') return t('insights.menu.cmpNone');
  const now = today();
  // While the period contains today the server compares up to the same elapsed point (D-S6-04).
  if (contains({ from: data.from, to: data.to }, now)) {
    const to = elapsedEquivalent(period, { from: data.from, to: data.to }, { from: p.from, to: p.to }, now);
    const range = period === 'week' || period === 'custom' ? rangeLabel({ from: p.from, to }, lang) : `${spanLabel(p.from, to, lang)} ${to.slice(0, 4)}`;
    const text = t('insights.menu.cmpSameSpan', { range, time: clock(data.generated_at) });
    return p.note === 'prior_partial_coverage' ? `${text} ${t('insights.menu.cmpPartialShort')}` : text;
  }
  const range = rangeLabel({ from: p.from, to: p.to }, lang);
  return p.note === 'prior_partial_coverage' ? t('insights.menu.cmpPartial', { range }) : t('insights.menu.cmpFull', { range });
}

type Pick = ReturnType<typeof useI18n>['pick'];

function rowProps(r: RankingRowDTO, measure: Measure, maxValue: number, t: T, pick: Pick, open: () => void) {
  const th = r.name.th;
  const name = th ?? r.name.en ?? '';
  const cat = pick(r.category).text;
  const category = pick(r.name).fallback ? `${cat} · ${t('common.enOnly')}` : cat;
  const value = measureValue(r, measure);
  let shareText: string;
  switch (measure) {
    case 'net':
      shareText = r.share === null ? '' : r.measured_weight ? `${share(r.share)} · ${t('insights.menu.unit.servings')}` : share(r.share);
      break;
    case 'submitted':
      shareText = t('insights.menu.unit.netOf', { n: num(r.net_qty) });
      break;
    case 'grams':
      shareText = `${t('insights.unit.g')} · ${t(r.net_qty === 1 ? 'insights.menu.unit.servingsOne' : 'insights.menu.unit.servingsN', { n: num(r.net_qty) })}`;
      break;
    default:
      shareText = value === null ? t('insights.menu.unit.noAvail') : t('insights.menu.unit.perDay', { n: num(r.net_qty) });
  }
  return {
    rank: r.rank,
    image: r.image ? dishImageUrl(r.image, 240) : null,
    name,
    nameLang: th ? 'th' : 'en',
    english: th ? r.name.en : null,
    category,
    servings: Math.round((value ?? 0) * 100) / 100,
    shareText,
    bar: maxValue > 0 ? (value ?? 0) / maxValue : 0,
    orders: r.orders,
    visits: r.visits,
    change: { label: r.change.label, delta: r.change.delta },
    context: contextOf(r, measure, t, name, open),
    variants: r.variants.length > 0 ? r.variants.map((v) => {
      const p = pick(v.name);
      return { name: p.text, lang: p.lang, servings: v.net_qty };
    }) : undefined,
  };
}

function contextOf(r: RankingRowDTO, measure: Measure, t: T, name: string, open: () => void): RankContext {
  const days = r.available_days;
  const availText = days !== null && r.period_days > 0 && days < r.period_days
    ? t('insights.menu.ctx.availDays', { n: num(days), m: num(r.period_days) })
    : null;
  let title: ReactNode;
  let text: ReactNode = null;
  let tone: 'ok' | 'alert' | 'neutral' | undefined;
  if (r.archived) {
    title = <><Icon name="lock" size="sm" />{t('insights.menu.ctx.archived')}</>;
    text = t('insights.menu.ctx.archivedText');
  } else if (r.quality === 'insufficient_availability') {
    title = <><Icon name="info" size="sm" />{t('common.rank.insufficient')}</>;
    text = days === null ? t('insights.menu.ctx.noLog') : t('insights.menu.ctx.availDays', { n: num(days), m: num(r.period_days) });
  } else if (r.quality === 'never_ordered_despite_availability') {
    title = <><Icon name="info" size="sm" />{t('common.rank.never')}</>;
    text = availText;
  } else if (r.measured_weight) {
    title = <><Icon name="scale" size="sm" />{t('common.rank.byWeight')}</>;
    const grams = t('insights.menu.ctx.gramsTotal', { w: weightText(r.grams ?? 0, t) });
    text = measure === 'grams' ? grams : `${t('common.rank.byServings')} · ${grams}`;
    if (availText) text = `${text} · ${availText}`;
  } else if (r.availability === 'partial' && days !== null) {
    tone = 'alert';
    title = <><Icon name="slash" size="sm" />{t('insights.menu.ctx.unavailable', { n: num(r.period_days - days), m: num(r.period_days) })}</>;
    text = t('common.rank.lowCount');
  } else if (r.availability === 'full') {
    title = <><Icon name="check-c" size="sm" />{t('common.rank.available')}</>;
  } else {
    title = <><Icon name="info" size="sm" />{t('insights.menu.ctx.noLog')}</>;
  }
  return {
    kind: 'custom',
    tone,
    title,
    text: (
      <>
        {text ? <span className="insx-ctx">{text}</span> : null}
        <button type="button" className="textlink insx-details" onClick={open} aria-haspopup="dialog" aria-label={t('insights.menu.detailsFor', { name })}>
          {t('insights.menu.details')}
          <Icon name="chev-r" size="xs" />
        </button>
      </>
    ),
  };
}
