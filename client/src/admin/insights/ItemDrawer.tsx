// Item detail drawer for Menu Stats (brief 38): weekly demand trend,
// variants, engagement counts and, for weighed cuts, the portion funnel.
// Findings are descriptive only, always with their counts; nothing here
// judges taste, quality or price.
import type { ItemStatsDTO, RankingRowDTO } from '../../../../shared/dto.ts';
import { addDays, weekStart } from '../../../../shared/time.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { num } from '../../lib/format.ts';
import {
  Drawer, DrawerSection, EmptyState, Icon, KeyValue, LinkButton, MiniBars, Skeleton, dishImageUrl, type KeyValueItem,
} from '../../ui/index.ts';
import { ErrorPanel, HBars, useLiveResource } from './parts.tsx';
import { periodParams, queryString, today, type PeriodState } from './query.ts';
import { dayMonth, durationText, rangeLabel, ratioText, share, weightText } from './labels.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

export function ItemDrawer({ row, ps, includeFixture, image, onClose }: {
  row: RankingRowDTO;
  ps: PeriodState;
  includeFixture: boolean;
  image: string | null;
  onClose: () => void;
}) {
  const { t, lang, pick } = useI18n();
  const path = `/api/staff/stats/menu/items/${encodeURIComponent(row.item_id)}${queryString({ ...periodParams(ps), include_fixture: includeFixture ? '1' : '0' })}`;
  const item = useLiveResource<ItemStatsDTO>(path, { topics: ['order.', 'line.', 'portion.', 'report.'], debounceMs: 2500 });
  const d = item.data;
  const th = row.name.th;
  const cat = pick(row.category);
  const namePick = pick(row.name);

  const lead = image ? (
    <span className="plate insx-drawer__plate" aria-hidden="true">
      <img src={dishImageUrl(image, 240)} alt="" width={240} height={180} decoding="async" />
    </span>
  ) : null;

  const subtitle = (
    <>
      {th && row.name.en ? <span className="en" lang="en">{row.name.en}</span> : null}
      {th && row.name.en ? ' · ' : null}
      <span lang={cat.lang}>{cat.text}</span>
      {namePick.fallback ? <> · {t(namePick.lang === 'en' ? 'common.enOnly' : 'insights.thOnly')}</> : null}
    </>
  );

  let body;
  if (item.loading && !d) {
    body = (
      <div className="insx-drawer__loading" role="status" aria-label={t('insights.state.loading')}>
        <Skeleton lines={3} />
        <Skeleton shape="block" width="100%" height={120} />
        <Skeleton lines={4} />
      </div>
    );
  } else if (item.error && !d) {
    body = item.error.code === 'not_found'
      ? <EmptyState compact icon="info" title={t('insights.item.notFound')}>{t('insights.item.notFoundText')}</EmptyState>
      : <ErrorPanel error={item.error} onRetry={() => void item.refresh()} compact />;
  } else if (d) {
    body = <ItemBody d={d} row={row} t={t} lang={lang} pick={pick} />;
  }

  return (
    <Drawer
      open
      inline={false}
      onClose={onClose}
      lead={lead}
      title={<span lang={th ? 'th' : 'en'}>{th ?? row.name.en}</span>}
      subtitle={subtitle}
      className="insx-drawer"
      footer={
        <div className="insx-drawer__foot">
          <LinkButton variant="outline" size="staff" icon="cutlery" href={`/admin/menu/items/${encodeURIComponent(row.item_id)}`}>
            {t('insights.item.openMenu')}
          </LinkButton>
        </div>
      }
    >
      {body}
    </Drawer>
  );
}

type Pick = ReturnType<typeof useI18n>['pick'];

function ItemBody({ d, row, t, lang, pick }: { d: ItemStatsDTO; row: RankingRowDTO; t: T; lang: 'th' | 'en'; pick: Pick }) {
  const periodText = d.from && d.to ? rangeLabel({ from: d.from, to: d.to }, lang, { weekday: d.period === 'week' || d.period === 'custom' }) : '';
  const summary: KeyValueItem[] = [
    { key: 'net', term: t('insights.item.net'), value: num(row.net_qty), strong: true },
    { key: 'sub', term: t('insights.item.submitted'), value: num(row.submitted_qty) },
    { key: 'ord', term: t('insights.item.orders'), value: num(row.orders) },
    { key: 'vis', term: t('insights.item.visits'), value: num(row.visits) },
  ];
  if (row.measured_weight || row.grams) summary.push({ key: 'g', term: t('insights.item.grams'), value: weightText(row.grams ?? 0, t) });
  summary.push({
    key: 'av',
    term: t('insights.item.available'),
    value: d.availability_days === null ? t('insights.item.noLog') : t('insights.item.daysOf', { n: num(d.availability_days), m: num(d.period_days ?? row.period_days) }),
    muted: d.availability_days === null,
  });

  const thisWeek = weekStart(today());
  const weekly = d.weekly.map((w) => ({
    key: w.week_start,
    label: dayMonth(w.week_start, lang, false),
    value: w.net_qty,
    spoken: t('insights.item.weekSpoken', { from: dayMonth(w.week_start, lang, false), to: dayMonth(addDays(w.week_start, 6), lang, false), n: num(w.net_qty) }),
  }));

  const e = d.engagement;
  const engagement: KeyValueItem[] = [
    { key: 'imp', term: t('insights.item.impressions'), value: num(e.impressions) },
    { key: 'det', term: t('insights.item.detailOpens'), value: num(e.detail_opens) },
    { key: 'dwell', term: t('insights.item.detailTime'), value: durationText(e.detail_active_ms_median, t), muted: e.detail_active_ms_median === null },
    { key: 'add', term: t('insights.item.adds'), value: num(e.adds) },
    { key: 'rate', term: t('insights.item.addRate'), value: e.add_rate === null ? '—' : share(e.add_rate), muted: e.add_rate === null },
    { key: 'subm', term: t('insights.item.attributed'), value: num(e.submitted_orders) },
    { key: 'sample', term: t('insights.item.sample'), value: num(e.sample_sessions) },
  ];

  const findings = describe(d, row, t);

  return (
    <div className="insx-drawer__body">
      <p className="insx-muted">{t('insights.item.period', { range: periodText })}</p>
      <DrawerSection title={t('insights.item.summary')}>
        <KeyValue items={summary} />
      </DrawerSection>

      <DrawerSection title={t('insights.item.trend')}>
        {weekly.length > 0 ? (
          <MiniBars
            title={t(d.period === 'week' ? 'insights.item.trendCap' : 'insights.item.trendCapPeriod', { n: weekly.length })}
            unit={t('insights.item.servingsUnit')}
            data={weekly}
            height={96}
            labelEvery={weekly.length > 26 ? 8 : weekly.length > 8 ? 3 : 1}
            highlightKey={thisWeek}
          />
        ) : (
          <p className="insx-muted">{t('insights.item.noTrend')}</p>
        )}
      </DrawerSection>

      {d.variants.length > 0 ? (
        <DrawerSection title={t('insights.item.variants')}>
          <HBars
            label={t('insights.item.variants')}
            items={d.variants.map((v, i) => {
              const p = pick(v.name);
              return { key: `${i}`, label: p.text, lang: p.lang, value: v.net_qty };
            })}
          />
        </DrawerSection>
      ) : null}

      {d.portion_funnel ? (
        <DrawerSection title={t('insights.item.portion')}>
          <HBars
            label={t('insights.item.portion')}
            tone="ok"
            items={[
              { key: 'req', label: t('insights.item.portionReq'), value: d.portion_funnel.requests },
              { key: 'quo', label: t('insights.item.portionQuoted'), value: d.portion_funnel.quoted, note: ratioText(d.portion_funnel.quoted, d.portion_funnel.requests) },
              { key: 'con', label: t('insights.item.portionConfirmed'), value: d.portion_funnel.confirmed, note: ratioText(d.portion_funnel.confirmed, d.portion_funnel.requests) },
            ]}
          />
          <p className="insx-fine">{t('insights.item.portionGrams', { w: weightText(d.portion_funnel.grams_total, t) })}</p>
        </DrawerSection>
      ) : null}

      <DrawerSection title={t('insights.item.engagement')}>
        <KeyValue items={engagement} />
        <p className="insx-fine">{t('insights.item.engNote')}</p>
      </DrawerSection>

      <DrawerSection title={t('insights.item.findings')}>
        <ul className="insx-findings">
          {findings.map((f) => (
            <li key={f}><Icon name="info" size="sm" />{f}</li>
          ))}
        </ul>
        <p className="insx-fine">{t('insights.item.findingsNote')}</p>
      </DrawerSection>
    </div>
  );
}

/** Descriptive observations with their counts. Never an interpretation. */
function describe(d: ItemStatsDTO, row: RankingRowDTO, t: T): string[] {
  const out: string[] = [];
  const e = d.engagement;
  if (e.sample_sessions === 0) {
    out.push(t('insights.item.find.noTelemetry'));
  } else if (!row.measured_weight) {
    if (e.impressions >= 20 && e.add_rate !== null && e.add_rate < 0.05) {
      out.push(t('insights.item.find.viewedAddedRarely', { i: num(e.impressions), a: num(e.adds) }));
    } else if (e.impressions > 0 && e.add_rate !== null && e.add_rate >= 0.2) {
      out.push(t('insights.item.find.addedOften', { i: num(e.impressions), a: num(e.adds), rate: share(e.add_rate) }));
    }
    if (e.detail_opens >= 5 && e.adds < e.detail_opens / 2) {
      out.push(t('insights.item.find.detailsOverAdds', { d: num(e.detail_opens), a: num(e.adds) }));
    }
  } else if (d.portion_funnel) {
    out.push(t('insights.item.find.weighed', { i: num(e.impressions), r: num(d.portion_funnel.requests), c: num(d.portion_funnel.confirmed) }));
  }
  if (e.sample_sessions > 0 && e.sample_sessions < 30) out.push(t('insights.item.find.smallSample', { n: num(e.sample_sessions) }));
  const days = d.availability_days;
  const span = d.period_days ?? row.period_days;
  if (days !== null && span > 0 && days < span) out.push(t('insights.item.find.availability', { n: num(days), m: num(span) }));
  if (row.net_qty === 0 && row.submitted_qty > 0) out.push(t('insights.item.find.allVoided', { n: num(row.submitted_qty) }));
  if (out.length === 0) out.push(t('insights.item.find.none'));
  return out;
}
