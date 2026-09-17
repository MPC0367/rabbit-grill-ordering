// Day drill-down under the Order Stats chart (brief 37): the rounds sent on
// one business date with the table label as it was at the time, round
// number, sent time, source, quantities and status, plus the hourly
// breakdown. Selecting a bar never leaves the page; this section follows it.
import { useEffect, useMemo, useState } from 'react';
import type { DayDrilldownDTO, OrderMetric, StaffOrderDTO } from '../../../../shared/dto.ts';
import type { OrderStatus } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { bangkokParts } from '../../../../shared/time.ts';
import { clock, num } from '../../lib/format.ts';
import {
  DataTable, EmptyState, LinkButton, MiniBars, Pill, SectionHeader, StatusPill, type DataColumn, type SortState,
} from '../../ui/index.ts';
import { ErrorPanel, LoadingBlock, useLiveResource } from './parts.tsx';
import { dayMonth, spokenDate } from './labels.ts';
import { nowMs, queryString } from './query.ts';

const LIVE_TOPICS = ['order.', 'line.', 'portion.', 'report.'];
const PAST_TOPICS = ['report.'];
const FIRST_ROWS = 8;

interface Row {
  id: string;
  reference: string;
  table: string;
  round: number | null;
  sentAt: string;
  source: string;
  staffName: string | null;
  items: number;
  status: OrderStatus;
  rejected: number;
  cancelled: number;
}

export function DayDrilldown({ date, includeFixture, metric, isToday }: {
  date: string;
  includeFixture: boolean;
  metric: OrderMetric;
  isToday: boolean;
}) {
  const { t, lang } = useI18n();
  const fx = includeFixture ? '1' : '0';
  const topics = isToday ? LIVE_TOPICS : PAST_TOPICS;
  const day = useLiveResource<DayDrilldownDTO>(`/api/staff/stats/orders/day${queryString({ date, include_fixture: fx })}`, { topics, debounceMs: 1500 });
  // Round numbers, staff names and per-line counts come from the staff order list for the same date.
  const extra = useLiveResource<{ orders: StaffOrderDTO[] }>(`/api/staff/orders${queryString({ scope: 'history', date, limit: 500 })}`, { topics, debounceMs: 1500 });
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'sent', dir: 'asc' });
  useEffect(() => { setShowAll(false); }, [date]);

  const rows = useMemo<Row[]>(() => {
    const byId = new Map((extra.data?.orders ?? []).map((o) => [o.id, o]));
    return (day.data?.orders ?? []).map((o) => {
      const s = byId.get(o.id);
      return {
        id: o.id,
        reference: o.reference,
        table: o.table_label,
        round: s?.round_no ?? null,
        sentAt: o.submitted_at,
        source: o.source,
        staffName: s?.staff_name ?? null,
        items: o.items,
        status: o.status,
        rejected: s?.counts.rejected ?? 0,
        cancelled: s?.counts.cancelled ?? 0,
      };
    });
  }, [day.data, extra.data]);

  const sorted = useMemo(() => {
    const val = (r: Row): string | number => {
      switch (sort.key) {
        case 'ref': return r.reference;
        case 'table': return r.table;
        case 'round': return r.round ?? 0;
        case 'items': return r.items;
        default: return r.sentAt;
      }
    };
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'en', { numeric: true });
      return (sort.dir === 'asc' ? c : -c) || a.sentAt.localeCompare(b.sentAt);
    });
  }, [rows, sort]);

  const title = t('insights.day.title', { date: dayMonth(date, lang), n: num(rows.length) });
  const visible = showAll ? sorted : sorted.slice(0, FIRST_ROWS);
  const csv = `/api/staff/stats/export.csv${queryString({ view: 'orders', rows: 'order', period: 'custom', from: date, to: date, include_fixture: fx })}`;

  const sourceText = (r: Row) => {
    switch (r.source) {
      case 'guest': return t('insights.source.guest');
      case 'staff': return r.staffName ? `${t('insights.source.staff')} · ${r.staffName}` : t('insights.source.staff');
      case 'manual_recovery': return t('insights.source.recovery');
      case 'portion_quote': return t('insights.source.portion');
      default: return r.source;
    }
  };

  const statusCell = (r: Row) => {
    const word = t(`insights.day.status.${r.status}`);
    if ((r.rejected > 0 || r.cancelled > 0) && r.status !== 'rejected' && r.status !== 'cancelled') {
      const parts = [
        r.rejected > 0 ? t('insights.day.someRejected', { n: r.rejected }) : null,
        r.cancelled > 0 ? t('insights.day.someCancelled', { n: r.cancelled }) : null,
      ].filter(Boolean).join(' · ');
      return <Pill tone="heat" icon="slash" size="sm">{word} · {parts}</Pill>;
    }
    return <StatusPill kind="order" status={r.status} size="sm" label={word} />;
  };

  const columns: Array<DataColumn<Row>> = [
    { key: 'ref', header: t('insights.day.col.ref'), code: true, sortable: true, cell: (r) => <span lang="en">{r.reference}</span> },
    { key: 'table', header: t('insights.day.col.table'), sortable: true, cell: (r) => r.table },
    { key: 'round', header: t('insights.day.col.round'), numeric: true, sortable: true, cell: (r) => (r.round === null ? '—' : r.round) },
    { key: 'sent', header: t('insights.day.col.sent'), sortable: true, cell: (r) => clock(r.sentAt) },
    { key: 'source', header: t('insights.day.col.source'), cell: sourceText },
    { key: 'items', header: t('insights.day.col.items'), numeric: true, sortable: true, cell: (r) => num(r.items) },
    { key: 'status', header: t('insights.day.col.status'), cell: statusCell },
  ];

  // Hourly: trim the empty hours before the first and after the last round.
  const useItems = metric === 'items';
  const hourly = day.data?.hourly ?? [];
  const valueOf = (h: { rounds: number; items: number }) => (useItems ? h.items : h.rounds);
  const firstIdx = hourly.findIndex((h) => h.rounds > 0);
  let lastIdx = -1;
  hourly.forEach((h, i) => { if (h.rounds > 0) lastIdx = i; });
  const hours = firstIdx < 0 ? [] : hourly.slice(firstIdx, lastIdx + 1);
  const nowHour = isToday ? bangkokParts(nowMs()).hour : null;
  const unitWord = useItems ? t('insights.day.unitItems') : t('insights.day.unitRounds');

  let body;
  if (day.loading && !day.data) {
    body = <LoadingBlock label={t('insights.state.loading')} height={260} />;
  } else if (day.error && !day.data) {
    body = <ErrorPanel error={day.error} onRetry={() => void day.refresh()} compact />;
  } else if (rows.length === 0) {
    body = (
      <div className="insx-state insx-state--card">
        <EmptyState compact icon="list" title={t('insights.day.emptyTitle', { date: dayMonth(date, lang) })}>
          {isToday ? t('insights.day.emptyToday') : t('insights.day.emptyText')}
        </EmptyState>
      </div>
    );
  } else {
    body = (
      <div className="insx-dayq">
      <div className="insx-day">
        <DataTable<Row>
          className="insx-day__table"
          caption={t('insights.day.caption', { date: spokenDate(date, lang) })}
          columns={columns}
          rows={visible}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={(key) => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}
          footer={rows.length > FIRST_ROWS ? (
            <button type="button" className="textlink" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? t('insights.day.showFewer') : t('insights.day.showAll', { n: num(rows.length) })}
            </button>
          ) : undefined}
        />
        <div className="insx-card insx-day__hours">
          <MiniBars
            title={t('insights.day.hourly', { what: unitWord, date: dayMonth(date, lang) })}
            unit={unitWord}
            height={96}
            labelEvery={hours.length > 12 ? 2 : 1}
            highlightKey={nowHour === null ? null : `h${nowHour}`}
            data={hours.map((h) => ({
              key: `h${h.hour}`,
              label: String(h.hour).padStart(2, '0'),
              value: valueOf(h),
              spoken: t('insights.day.hourSpoken', { hour: `${String(h.hour).padStart(2, '0')}:00`, n: num(valueOf(h)), unit: unitWord }),
            }))}
          />
          <p className="insx-fine">{t('insights.day.hourlyNote')}</p>
        </div>
      </div>
      </div>
    );
  }

  return (
    <section className="insx-section" aria-labelledby="insx-day-h">
      <SectionHeader
        titleId="insx-day-h"
        title={day.data || !day.loading ? title : t('insights.day.titleLoading', { date: dayMonth(date, lang) })}
        description={rows.length > 0
          ? `${t('insights.day.desc')} · ${t('insights.day.showing', { n: num(visible.length), total: num(rows.length) })}`
          : t('insights.day.desc')}
        actions={<LinkButton external download variant="outline" size="staff" icon="download" href={csv}>{t('insights.day.csv')}</LinkButton>}
      />
      {body}
    </section>
  );
}
