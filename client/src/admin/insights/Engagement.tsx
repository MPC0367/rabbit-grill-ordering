// Engagement (brief 39, D-S6-09): coverage first, then observed active
// time, the dining-session funnel with its denominators, attributed and
// unattributed rounds, category exposure, scroll depth, daily sessions and
// the item table. The words describe what was measured, never intent.
import { useMemo, useState, type ReactNode } from 'react';
import type { EngagementDTO } from '../../../../shared/dto.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import { num } from '../../lib/format.ts';
import {
  Banner, DataTable, EmptyState, KeyValue, LinkButton, MiniBars, StatCard, StaffSearch, normalizeSearch, cx,
  type DataColumn, type SortState,
} from '../../ui/index.ts';
import {
  Card, ErrorPanel, HBars, LoadingBlock, PageBar, PeriodBar, SplitMeter, useSticky,
} from './parts.tsx';
import { contains, periodParams, queryString, readPeriod, resolveRange, today } from './query.ts';
import { dayMonth, durationParts, durationText, fullDate, monthShort, monthYear, rangeLabel, ratioText, share, spokenDate } from './labels.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;
type ItemRow = EngagementDTO['items'][number];

const FIRST_ITEMS = 10;

export default function Engagement({ includeFixture, headingId, canExportRaw, canSettings }: {
  includeFixture: boolean;
  headingId: string;
  canExportRaw: boolean;
  canSettings: boolean;
}) {
  const { t, lang } = useI18n();
  const { query } = useRoute();
  const ps = readPeriod(query);
  const range = resolveRange(ps);
  const current = contains(range, today());
  const fx = includeFixture ? '1' : '0';
  const path = `/api/staff/stats/engagement${queryString({ ...periodParams(ps), include_fixture: fx })}`;
  // Telemetry emits no live events (D-S6-08), so the current period refreshes on a timer.
  const eng = useSticky<EngagementDTO>(path, { topics: ['report.', 'settings.'], intervalMs: current ? 60_000 : undefined });
  const d = eng.shown;

  const csv = `/api/staff/stats/export.csv${queryString({ view: 'engagement', ...periodParams(ps), include_fixture: fx })}`;
  const exports = [{ href: csv, label: t('insights.export.view') }];
  if (canExportRaw) exports.push({ href: `${csv}&raw=1`, label: t('insights.export.raw') });

  let body: ReactNode;
  if (eng.failed) {
    body = <ErrorPanel error={eng.error} onRetry={() => void eng.refresh()} />;
  } else if (!d) {
    body = <LoadingBlock label={t('insights.state.loading')} height={520} />;
  } else if (d.coverage.measured_sessions === 0) {
    body = (
      <>
        {d.coverage.note === 'no_telemetry' ? null : <CoverageNote d={d} t={t} lang={lang} />}
        <div className="insx-state insx-state--card">
          <EmptyState icon="bars" title={t('insights.eng.emptyTitle')}>
            {d.coverage.note === 'analytics_disabled'
              ? t('insights.eng.emptyDisabled')
              : d.coverage.telemetry_since && d.coverage.telemetry_since > d.to
                ? t('insights.eng.emptyBefore', { date: fullDate(d.coverage.telemetry_since, lang) })
                : t('insights.eng.emptyText')}
          </EmptyState>
        </div>
      </>
    );
  } else {
    body = <EngagementBody d={d} t={t} lang={lang} refreshing={eng.refreshing} />;
  }

  return (
    <div className="insx-view" data-view="engagement">
      <PageBar
        generatedAt={d?.generated_at}
        fetchedAt={eng.fetchedAt}
        stale={eng.stale}
        failed={eng.failed}
        onRetry={() => void eng.refresh()}
        includeFixture={includeFixture}
        exports={exports}
      />
      <PeriodBar ps={ps} minDate={null} />
      <Banner
        variant="info"
        staff
        role="note"
        className="insx-notice"
        icon="info"
        title={t('insights.eng.noticeTitle')}
        action={canSettings ? (
          <LinkButton variant="outline" size="staff" icon="key" href="/admin/settings">{t('insights.eng.settings')}</LinkButton>
        ) : undefined}
      >
        {t('insights.eng.notice')}
        {canSettings ? null : ` ${t('insights.eng.noticeOwner')}`}
      </Banner>
      <section aria-labelledby={headingId} className="insx-section">
        <h2 id={headingId} className="visually-hidden">{t('insights.tab.engagement')}</h2>
        {body}
      </section>
    </div>
  );
}

function CoverageNote({ d, t, lang }: { d: EngagementDTO; t: T; lang: 'th' | 'en' }) {
  const note = d.coverage.note;
  if (!note) return null;
  const since = d.coverage.telemetry_since ? fullDate(d.coverage.telemetry_since, lang) : '—';
  const text = note === 'analytics_disabled' ? t('insights.eng.note.disabled')
    : note === 'no_telemetry' ? t('insights.eng.note.none')
    : note === 'telemetry_started_in_period' ? t('insights.eng.note.started', { date: since })
    : note === 'raw_events_retention' ? t('insights.eng.note.retention')
    : note;
  return (
    <Banner variant="warning" staff className="insx-notice" role="note">
      {text}
    </Banner>
  );
}

function EngagementBody({ d, t, lang, refreshing }: { d: EngagementDTO; t: T; lang: 'th' | 'en'; refreshing: boolean }) {
  const c = d.coverage;
  const f = d.funnel;
  const isYear = d.period === 'year';
  const since = c.telemetry_since;
  const orders = f.attributed_orders + f.unattributed_orders;

  const funnel = [
    { key: 'ses', label: t('insights.eng.funnel.sessions'), value: f.sessions, note: t('insights.eng.funnel.base') },
    { key: 'imp', label: t('insights.eng.funnel.saw'), value: f.impression_sessions, note: ratioText(f.impression_sessions, f.sessions) },
    { key: 'det', label: t('insights.eng.funnel.details'), value: f.detail_sessions, note: ratioText(f.detail_sessions, f.sessions) },
    { key: 'add', label: t('insights.eng.funnel.added'), value: f.add_sessions, note: ratioText(f.add_sessions, f.sessions) },
    { key: 'sub', label: t('insights.eng.funnel.sent'), value: f.submit_sessions, note: ratioText(f.submit_sessions, f.sessions) },
  ];

  const menuParts = durationParts(d.active_menu_ms.median, t);
  const detailParts = durationParts(d.active_detail_ms.median, t);

  // Daily rows before telemetry began are unmeasured, not zero.
  const daily = d.daily.filter((x) => !since || (isYear ? x.date >= since.slice(0, 7) : x.date >= since));
  const dayLabel = (key: string) => (isYear ? monthShort(key, lang) : String(Number(key.slice(8))));
  const every = daily.length > 16 ? 5 : daily.length > 8 ? 2 : 1;
  const todayKey = isYear ? today().slice(0, 7) : today();

  return (
    <div className={cx('insx-eng', refreshing && 'is-refreshing')} aria-busy={refreshing || undefined}>
      <CoverageNote d={d} t={t} lang={lang} />

      <Card title={t('insights.eng.coverage')} className="insx-coverage" icon="user">
        <div className="insx-coverage__grid">
          <div className="insx-coverage__lead">
            <p className="insx-bignum">{num(c.measured_sessions)}</p>
            <p className="insx-muted">{t('insights.eng.measured')}</p>
            <SplitMeter
              label={t('insights.eng.split')}
              parts={[
                { key: 'dining', value: c.dining_sessions, tone: 'ink', text: t('insights.eng.dining', { n: num(c.dining_sessions), p: ratioText(c.dining_sessions, c.measured_sessions) }) },
                { key: 'public', value: c.public_sessions, tone: 'soft', text: t('insights.eng.public', { n: num(c.public_sessions), p: ratioText(c.public_sessions, c.measured_sessions) }) },
              ]}
            />
          </div>
          <KeyValue
            items={[
              { key: 'opt', term: t('insights.eng.optedOut'), value: num(c.opted_out_sessions) },
              { key: 'since', term: t('insights.eng.since'), value: since ? fullDate(since, lang) : t('insights.eng.notStarted'), muted: !since },
              { key: 'range', term: t('insights.eng.period'), value: rangeLabel({ from: d.from, to: d.to }, lang, { weekday: false }) },
            ]}
          />
          <div className="insx-limits">
            <p className="insx-limits__t">{t('insights.eng.limits')}</p>
            <ul>
              <li>{t('insights.eng.limit.active')}</li>
              <li>{t('insights.eng.limit.close')}</li>
              <li>{t('insights.eng.limit.scroll')}</li>
              <li>{t('insights.eng.limit.read')}</li>
              <li>{t('insights.eng.limit.devices')}</li>
            </ul>
          </div>
        </div>
      </Card>

      <div className="insx-grid insx-grid--2">
        <div className="insx-stack">
          <StatCard
            label={t('insights.eng.menuTime')}
            parts={menuParts ?? undefined}
            value={menuParts ? undefined : '—'}
            note={d.active_menu_ms.sample > 0
              ? t('insights.eng.timeNote', { p90: durationText(d.active_menu_ms.p90, t), n: num(d.active_menu_ms.sample) })
              : t('insights.eng.noSample')}
            definition={<p>{t('insights.def.menuTime')}</p>}
          />
          <StatCard
            label={t('insights.eng.detailTime')}
            parts={detailParts ?? undefined}
            value={detailParts ? undefined : '—'}
            note={d.active_detail_ms.sample > 0
              ? t('insights.eng.detailNote', { p90: durationText(d.active_detail_ms.p90, t), n: num(d.active_detail_ms.sample) })
              : t('insights.eng.noSample')}
            definition={<p>{t('insights.def.detailTime')}</p>}
          />
          <Card title={t('insights.eng.orders')}>
            <p className="insx-orders">
              <b>{num(orders)}</b> {t('insights.eng.ordersLead')}
            </p>
            <SplitMeter
              label={t('insights.eng.orders')}
              parts={[
                { key: 'attr', value: f.attributed_orders, tone: 'ink', text: t('insights.eng.attributed', { n: num(f.attributed_orders), p: ratioText(f.attributed_orders, orders) }) },
                { key: 'un', value: f.unattributed_orders, tone: 'soft', text: t('insights.eng.unattributed', { n: num(f.unattributed_orders), p: ratioText(f.unattributed_orders, orders) }) },
              ]}
            />
            <p className="insx-fine">{t('insights.eng.ordersNote')}</p>
          </Card>
        </div>

        <Card title={t('insights.eng.funnel')} aside={<span className="insx-muted">{t('insights.eng.funnelBase', { n: num(f.sessions) })}</span>}>
          <HBars label={t('insights.eng.funnel')} items={funnel} />
          <p className="insx-quick">
            <b>{num(f.quick_add_sessions)}</b> {t('insights.eng.quick', { p: ratioText(f.quick_add_sessions, f.sessions) })}
          </p>
          <p className="insx-fine">{t('insights.eng.funnelNote')}</p>
        </Card>
      </div>

      <div className="insx-grid insx-grid--2 insx-grid--rev">
        <Card title={t('insights.eng.categories')} aside={<span className="insx-muted">{t('insights.eng.ofMeasured')}</span>}>
          <CategoryBars d={d} t={t} />
          <p className="insx-fine">{t('insights.eng.categoriesNote')}</p>
        </Card>
        <div className="insx-stack">
        <Card title={t('insights.eng.scroll')} aside={<span className="insx-muted">{t('insights.eng.approx')}</span>}>
          <HBars
            label={t('insights.eng.scroll')}
            items={d.scroll.map((s) => ({
              key: String(s.threshold),
              label: t('insights.eng.reached', { n: s.threshold }),
              value: s.sessions,
              note: ratioText(s.sessions, c.measured_sessions),
              ratio: c.measured_sessions > 0 ? s.sessions / c.measured_sessions : 0,
            }))}
          />
          <p className="insx-fine">{t('insights.eng.scrollNote')}</p>
        </Card>
        <Card title={t(isYear ? 'insights.eng.monthly' : 'insights.eng.daily')}>
          {daily.length > 0 ? (
            <div className="insx-dailies">
              <MiniBars
                title={t('insights.eng.sessionsCap')}
                unit={t('insights.eng.sessionsUnit')}
                height={72}
                labelEvery={every}
                highlightKey={todayKey}
                data={daily.map((x) => ({
                  key: x.date,
                  label: dayLabel(x.date),
                  value: x.sessions,
                  spoken: `${isYear ? monthYear(x.date, lang) : spokenDate(x.date, lang)}, ${num(x.sessions)} ${t('insights.eng.sessionsUnit')}`,
                }))}
              />
              <MiniBars
                title={t('insights.eng.activeCap')}
                unit={t('insights.unit.minutes')}
                height={72}
                labelEvery={every}
                highlightKey={todayKey}
                data={daily.map((x) => ({
                  key: x.date,
                  label: dayLabel(x.date),
                  value: Math.round(x.active_ms / 60_000),
                  spoken: `${isYear ? monthYear(x.date, lang) : dayMonth(x.date, lang)}, ${durationText(x.active_ms, t)}`,
                }))}
              />
            </div>
          ) : (
            <p className="insx-muted">{t('insights.eng.noDaily')}</p>
          )}
          {since && since > d.from ? <p className="insx-fine">{t('insights.eng.dailySince', { date: fullDate(since, lang) })}</p> : null}
        </Card>
        </div>
      </div>

      <ItemTable d={d} t={t} />
    </div>
  );
}

function CategoryBars({ d, t }: { d: EngagementDTO; t: T }) {
  const { pick } = useI18n();
  const items = [...d.categories].sort((a, b) => b.sessions_exposed - a.sessions_exposed).map((cat) => {
    const p = pick(cat.name);
    return {
      key: cat.category_id,
      label: p.text,
      lang: p.lang,
      value: cat.sessions_exposed,
      note: share(cat.share),
      ratio: cat.share ?? 0,
      muted: cat.sessions_exposed === 0,
    };
  });
  return <HBars label={t('insights.eng.categories')} items={items} />;
}

function ItemTable({ d, t }: { d: EngagementDTO; t: T }) {
  const { lang } = useI18n();
  const [sort, setSort] = useState<SortState>({ key: 'impressions', dir: 'desc' });
  const [all, setAll] = useState(false);
  const [find, setFind] = useState('');
  const needle = normalizeSearch(find);
  const rows = useMemo(() => {
    const val = (r: ItemRow): number | string => {
      switch (sort.key) {
        case 'name': return (r.name.th ?? r.name.en ?? '').toLowerCase();
        case 'details': return r.detail_opens;
        case 'adds': return r.adds;
        case 'rate': return r.add_rate ?? -1;
        case 'submitted': return r.submitted;
        default: return r.impressions;
      }
    };
    const list = needle
      ? d.items.filter((r) => normalizeSearch(`${r.name.th ?? ''} ${r.name.en ?? ''}`).includes(needle))
      : d.items;
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), lang);
      return (sort.dir === 'asc' ? cmp : -cmp) || (b.impressions - a.impressions);
    });
  }, [d.items, sort, needle, lang]);
  const visible = all || needle ? rows : rows.slice(0, FIRST_ITEMS);

  const columns: Array<DataColumn<ItemRow>> = [
    {
      key: 'name',
      header: t('insights.eng.col.dish'),
      sortable: true,
      wrap: true,
      cell: (r) => {
        const th = r.name.th;
        return (
          <span className="insx-dish">
            <b lang={th ? 'th' : 'en'}>{th ?? r.name.en}</b>
            {th && r.name.en ? <span className="en" lang="en">{r.name.en}</span> : null}
            {!th ? <small>{t('common.enOnly')}</small> : null}
          </span>
        );
      },
    },
    { key: 'impressions', header: t('insights.eng.col.impressions'), numeric: true, sortable: true, cell: (r) => num(r.impressions) },
    { key: 'details', header: t('insights.eng.col.details'), numeric: true, sortable: true, cell: (r) => num(r.detail_opens) },
    { key: 'adds', header: t('insights.eng.col.adds'), numeric: true, sortable: true, cell: (r) => num(r.adds) },
    { key: 'rate', header: t('insights.eng.col.rate'), numeric: true, sortable: true, cell: (r) => (r.add_rate === null ? '—' : share(r.add_rate)) },
    { key: 'submitted', header: t('insights.eng.col.submitted'), numeric: true, sortable: true, cell: (r) => num(r.submitted) },
  ];

  return (
    <section className="insx-section" aria-labelledby="insx-eng-items">
      <div className="section-h">
        <h3 id="insx-eng-items" className="insx-h3">{t('insights.eng.items')}</h3>
        <p>{t('insights.eng.itemsNote')}</p>
        <div className="right">
          <StaffSearch className="insx-find" label={t('insights.menu.search')} placeholder={t('insights.menu.search')} value={find} onChange={setFind} />
        </div>
      </div>
      <DataTable<ItemRow>
        caption={t('insights.eng.items')}
        columns={columns}
        rows={visible}
        rowKey={(r) => r.item_id}
        sort={sort}
        onSort={(key) => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' })}
        empty={<p className="dtable__none">{needle ? t('insights.menu.noMatch', { q: find.trim() }) : t('insights.eng.noItems')}</p>}
        footer={!needle && rows.length > FIRST_ITEMS ? (
          <button type="button" className="textlink" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? t('insights.eng.fewerItems') : t('insights.eng.allItems', { n: num(rows.length) })}
          </button>
        ) : undefined}
      />
    </section>
  );
}
