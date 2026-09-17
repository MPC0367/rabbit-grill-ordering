// Operational report (brief 26): KPIs for a chosen business-date range from
// GET /api/staff/stats/kpis, each with its definition and sample, precisely
// labelled totals (never "revenue"), hourly rounds, reasons, open bills,
// service requests, and a CSV of exactly what is on screen.
import { useMemo, useState } from 'react';
import type { KpiDTO } from '../../../../shared/dto.ts';
import { addDays, daysBetween, monthStart, todayBusinessDate } from '../../../../shared/time.ts';
import { qs } from '../../lib/api.ts';
import { dateLabel, dateTime, money, num, pct } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import { setQuery, useRoute } from '../../lib/router.ts';
import {
  Button, DataTable, EmptyState, FilterChips, KeyValue, MiniBars, SectionHeader, StatCard, StatGrid, TextField, useToast,
} from '../../ui/index.ts';
import { downloadFile, kpiCsv, saveBlob } from './csv.ts';
import { langOf, StaleBanner, useErrorWords, useTopicRefresh } from './shared.tsx';

type Preset = '7d' | '30d' | 'month' | 'lastmonth' | 'year' | 'custom';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function presetRange(p: Exclude<Preset, 'custom'>, today: string): { from: string; to: string } {
  switch (p) {
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: monthStart(today), to: today };
    case 'lastmonth': {
      const end = addDays(monthStart(today), -1);
      return { from: monthStart(end), to: end };
    }
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

function useDuration() {
  const { t } = useI18n();
  const parts = (s: number | null): Array<{ n: string; unit?: string }> | undefined => {
    if (s === null) return undefined;
    const r = Math.round(s);
    if (r < 60) return [{ n: String(r), unit: t('reports.unit.s') }];
    const h = Math.floor(r / 3600);
    const m = Math.floor((r % 3600) / 60);
    const sec = r % 60;
    if (h > 0) return [{ n: String(h), unit: t('reports.unit.h') }, { n: String(m), unit: t('reports.unit.m') }];
    return [{ n: String(m), unit: t('reports.unit.m') }, { n: String(sec), unit: t('reports.unit.s') }];
  };
  const text = (s: number | null): string => (parts(s) ?? [{ n: '—' }]).map((p) => `${p.n}${p.unit ? ` ${p.unit}` : ''}`).join(' ');
  return { parts, text };
}

export default function OperationalReport({ includeDemo }: { includeDemo: boolean }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { errorText } = useErrorWords();
  const { query } = useRoute();
  const dur = useDuration();
  const today = todayBusinessDate(0);

  const qFrom = query.get('from') ?? '';
  const qTo = query.get('to') ?? '';
  const preset: Preset = (['7d', '30d', 'month', 'lastmonth', 'year', 'custom'] as const).includes(query.get('range') as Preset)
    ? (query.get('range') as Preset)
    : '7d';
  const urlRangeOk = ISO.test(qFrom) && ISO.test(qTo) && qFrom <= qTo;
  const range = preset === 'custom' && urlRangeOk ? { from: qFrom, to: qTo } : presetRange(preset === 'custom' ? '7d' : preset, today);

  // Custom dates are edited locally and applied once both are valid.
  const [draft, setDraft] = useState<{ from: string; to: string }>(() => (preset === 'custom' && !urlRangeOk && (qFrom || qTo) ? { from: qFrom, to: qTo } : range));
  const draftKey = `${range.from}|${range.to}`;
  const [seenKey, setSeenKey] = useState(draftKey);
  if (seenKey !== draftKey) { setSeenKey(draftKey); setDraft(range); }
  const draftProblem = !ISO.test(draft.from) || !ISO.test(draft.to)
    ? t('reports.kpi.err.dates')
    : draft.from > draft.to ? t('reports.kpi.err.order')
    : daysBetween(draft.from, draft.to) > 800 ? t('reports.kpi.err.long')
    : null;

  const path = `/api/staff/stats/kpis${qs({ from: range.from, to: range.to, include_fixture: includeDemo ? '1' : '0' })}`;
  const topics = ['order.', 'line.', 'bill.', 'payment.', 'service.', 'visit.'];
  const res = useResource<KpiDTO>(path, { topics, debounceMs: 2500 });
  useTopicRefresh(topics, res.refresh, 2500);
  const k = res.data;
  const state: 'loading' | 'error' | 'ready' = !k ? (res.error && !res.loading ? 'error' : 'loading') : 'ready';

  const rangeText = range.from === range.to
    ? dateLabel(range.from, lang, { year: true, weekday: true })
    : `${dateLabel(range.from, lang, { year: range.from.slice(0, 4) !== range.to.slice(0, 4) })} – ${dateLabel(range.to, lang, { year: true })}`;

  const hourly = useMemo(() => {
    if (!k) return [];
    const byHour = new Map(k.hourly.map((h) => [h.hour, h.rounds]));
    const used = k.hourly.filter((h) => h.rounds > 0).map((h) => h.hour);
    const first = used.length ? Math.max(0, Math.min(...used) - 1) : 10;
    const last = used.length ? Math.min(23, Math.max(...used) + 1) : 22;
    const out = [];
    for (let h = first; h <= last; h++) {
      const v = byHour.get(h) ?? 0;
      const hh = String(h).padStart(2, '0');
      out.push({ key: hh, label: hh, value: v, spoken: t(v === 1 ? 'reports.kpi.hourSpoken.one' : 'reports.kpi.hourSpoken', { from: `${hh}:00`, to: `${String((h + 1) % 24).padStart(2, '0')}:00`, n: num(v) }) });
    }
    return out;
  }, [k, t]);

  const unit = (key: string, n: number) => t(n === 1 ? `${key}.one` : key);
  const reasonText = (r: string) => (r === 'unspecified' ? t('reports.kpi.unspecified') : <span lang={langOf(r)}>{r}</span>);
  const financial = k?.financial_visible !== false;

  const exportCsv = () => {
    if (!k) return;
    const name = `rabbit-grill-operational-${k.from}-to-${k.to}${k.include_fixture ? '-demo' : ''}.csv`;
    saveBlob(new Blob([kpiCsv(k, { generatedAt: new Date().toISOString() })], { type: 'text/csv;charset=utf-8' }), name);
    toast.show(t('reports.kpi.csvSaved', { name }));
  };

  const [roundsBusy, setRoundsBusy] = useState(false);
  const roundsCsv = `/api/staff/stats/export.csv${qs({ view: 'orders', rows: 'order', period: 'custom', from: range.from, to: range.to, include_fixture: includeDemo ? '1' : '0' })}`;

  return (
    <section className="oprep" aria-labelledby="oprep-h">
      <SectionHeader
        titleId="oprep-h"
        title={t('reports.kpi.title')}
        description={t('reports.kpi.lede')}
        actions={(
          <>
            <Button
              variant="outline"
              size="staff"
              icon="download"
              loading={roundsBusy}
              onClick={async () => {
                setRoundsBusy(true);
                try {
                  const f = await downloadFile(roundsCsv, `rabbit-grill-order-rounds-${range.from}-${range.to}.csv`);
                  toast.show(t('reports.kpi.csvSaved', { name: f.name }));
                } catch (err) {
                  toast.show({ tone: 'error', message: errorText(err) });
                } finally {
                  setRoundsBusy(false);
                }
              }}
            >
              {t('reports.kpi.roundsCsv')}
            </Button>
            <Button variant="outline" size="staff" icon="download" onClick={exportCsv} disabled={!k}>
              {t('reports.kpi.csv')}
            </Button>
          </>
        )}
      />

      <div className="oprep__range">
        <FilterChips<Preset>
          label={t('reports.kpi.rangeLabel')}
          value={preset}
          onChange={(p) => {
            if (p === 'custom') setQuery({ range: 'custom', from: range.from, to: range.to });
            else setQuery({ range: p === '7d' ? null : p, from: null, to: null });
          }}
          options={[
            { value: '7d', label: t('reports.kpi.p7') },
            { value: '30d', label: t('reports.kpi.p30') },
            { value: 'month', label: t('reports.kpi.pMonth') },
            { value: 'lastmonth', label: t('reports.kpi.pLastMonth') },
            { value: 'year', label: t('reports.kpi.pYear') },
            { value: 'custom', label: t('reports.kpi.pCustom') },
          ]}
        />
        {preset === 'custom' ? (
          <form
            className="oprep__dates"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draftProblem) setQuery({ range: 'custom', from: draft.from, to: draft.to });
            }}
          >
            <TextField density="staff" type="date" label={t('reports.kpi.from')} value={draft.from} max={today} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <TextField density="staff" type="date" label={t('reports.kpi.to')} value={draft.to} max={today} onChange={(e) => setDraft({ ...draft, to: e.target.value })} error={draftProblem ?? undefined} />
            <Button type="submit" variant="outline" size="staff" disabled={Boolean(draftProblem) || (draft.from === range.from && draft.to === range.to)}>
              {t('reports.kpi.apply')}
            </Button>
          </form>
        ) : null}
        <p className="oprep__scope" aria-live="polite">
          <b>{rangeText}</b>
          <span> · {t('reports.kpi.tz')}</span>
          <span> · {includeDemo ? t('reports.scope.withDemo') : t('reports.scope.noDemo')}</span>
        </p>
      </div>

      <StaleBanner error={k ? res.error : null} onRetry={() => void res.refresh()} busy={res.loading} />

      {state === 'error' ? (
        <EmptyState
          icon="alert"
          headingLevel={3}
          title={t('more.loadFailed', { what: t('reports.kpi.title') })}
          role="alert"
          action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}
        >
          {res.error?.code === 'forbidden' ? t('more.denied.body') : errorText(res.error)}
        </EmptyState>
      ) : (
        <>
          <StatGrid className="oprep__cards" aria-busy={res.loading || undefined}>
            <StatCard
              state={state}
              label={t('reports.kpi.qr')}
              value={k ? pct(k.qr_adoption.value) : undefined}
              note={k ? (k.qr_adoption.denominator ? t('reports.kpi.qr.note', { n: num(k.qr_adoption.numerator), d: num(k.qr_adoption.denominator) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.qr')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.orderTime')}
              parts={k ? dur.parts(k.guest_order_time.median_s) : undefined}
              value={k && k.guest_order_time.median_s === null ? '—' : undefined}
              note={k ? (k.guest_order_time.sample ? t('reports.kpi.p90sample', { p90: dur.text(k.guest_order_time.p90_s), n: num(k.guest_order_time.sample), what: unit('reports.kpi.journeys', k.guest_order_time.sample) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.orderTime')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.aov')}
              value={k ? (k.average_order_value.value_minor === null ? '—' : money(k.average_order_value.value_minor)) : undefined}
              note={k ? (k.average_order_value.rounds ? t('reports.kpi.aov.note', { n: num(k.average_order_value.rounds) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.aov')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.atv')}
              value={k ? (k.average_table_value.value_minor === null ? '—' : money(k.average_table_value.value_minor)) : undefined}
              note={k ? (k.average_table_value.visits ? t('reports.kpi.atv.note', { n: num(k.average_table_value.visits) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.atv')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.errors')}
              value={k ? pct(k.operational_errors.rate, 1) : undefined}
              note={k ? (k.operational_errors.submitted_rounds ? t('reports.kpi.errors.note', { n: num(k.error_rounds ?? 0), d: num(k.operational_errors.submitted_rounds) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.errors')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.accept')}
              parts={k ? dur.parts(k.staff_response.accept_median_s) : undefined}
              value={k && k.staff_response.accept_median_s === null ? '—' : undefined}
              note={k ? (k.staff_response.accept_sample ? t('reports.kpi.p90sample', { p90: dur.text(k.staff_response.accept_p90_s), n: num(k.staff_response.accept_sample), what: unit('reports.kpi.rounds', k.staff_response.accept_sample) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.accept')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.ack')}
              parts={k ? dur.parts(k.staff_response.ack_median_s) : undefined}
              value={k && k.staff_response.ack_median_s === null ? '—' : undefined}
              note={k ? (k.staff_response.ack_sample ? t('reports.kpi.p90sample', { p90: dur.text(k.staff_response.ack_p90_s), n: num(k.staff_response.ack_sample), what: unit('reports.kpi.requests', k.staff_response.ack_sample) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.ack')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.openBills')}
              value={k ? num(k.open_bills) : undefined}
              live={Boolean(k)}
              note={t('reports.kpi.openBills.note')}
              definition={<p>{t('reports.def.openBills')}</p>}
            />
            {financial ? (
              <StatCard
                state={state}
                label={t('reports.kpi.exceptions')}
                value={k ? num(k.payment_exceptions.count) : undefined}
                note={k ? t('reports.kpi.exceptions.note', { value: money(k.payment_exceptions.value_minor) }) : null}
                definition={<p>{t('reports.def.exceptions')}</p>}
              />
            ) : null}
          </StatGrid>

          {k ? (
            <>
              <div className="oprep__grid">
                <article className="mp-panel" aria-labelledby="oprep-totals">
                  <h3 id="oprep-totals" className="mp-panel__h">{t('reports.kpi.totals')}</h3>
                  <p className="mp-meta">{t('reports.kpi.totals.d')}</p>
                  <KeyValue
                    items={[
                      { key: 's', term: t('reports.kpi.tSubmitted'), value: money(k.totals.submitted_minor) },
                      { key: 'a', term: t('reports.kpi.tAccepted'), value: money(k.totals.accepted_minor), strong: true },
                      { key: 'f', term: t('reports.kpi.tFinalised'), value: money(k.totals.finalized_minor) },
                      financial
                        ? { key: 'p', term: t('reports.kpi.tPaid'), value: money(k.totals.paid_minor) }
                        : { key: 'p', term: t('reports.kpi.tPaid'), value: t('reports.kpi.financialOnly'), muted: true },
                    ]}
                  />
                </article>
                <article className="mp-panel" aria-labelledby="oprep-hours">
                  <h3 id="oprep-hours" className="mp-panel__h">{t('reports.kpi.hourly')}</h3>
                  {hourly.some((h) => h.value > 0) ? (
                    <MiniBars data={hourly} title={t('reports.kpi.hourly.cap')} unit={t('reports.kpi.rounds')} height={120} />
                  ) : (
                    <EmptyState compact icon="bars" headingLevel={4} title={t('reports.kpi.noRounds')} />
                  )}
                </article>
              </div>

              <div className="oprep__grid oprep__grid--3">
                <DataTable
                  caption={t('reports.kpi.errorsBy')}
                  showCaption
                  rows={(k.operational_error_kinds ?? k.operational_errors.by_reason.map((r) => ({ kind: 'rejected' as const, ...r }))).map((r, i) => ({ ...r, id: `${r.kind}-${i}` }))}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: 'kind', header: t('reports.kpi.col.kind'), cell: (r) => t(`reports.kpi.kind.${r.kind}`) },
                    { key: 'reason', header: t('reports.kpi.col.reason'), wrap: true, cell: (r) => reasonText(r.reason) },
                    { key: 'count', header: t('reports.kpi.col.rounds'), numeric: true, cell: (r) => num(r.count) },
                  ]}
                  empty={<p className="dtable__none">{t('reports.kpi.noErrors')}</p>}
                />
                <DataTable
                  caption={t('reports.kpi.cancellations')}
                  showCaption
                  rows={k.cancellations.map((c, i) => ({ ...c, id: String(i) }))}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: 'reason', header: t('reports.kpi.col.reason'), wrap: true, cell: (r) => reasonText(r.reason) },
                    { key: 'count', header: t('reports.kpi.col.lines'), numeric: true, cell: (r) => num(r.count) },
                    { key: 'value', header: t('reports.kpi.col.value'), numeric: true, cell: (r) => money(r.value_minor) },
                  ]}
                  empty={<p className="dtable__none">{t('reports.kpi.noCancellations')}</p>}
                />
                <DataTable
                  caption={t('reports.kpi.requestsBy')}
                  showCaption
                  rows={k.service_requests}
                  rowKey={(r) => r.type}
                  columns={[
                    { key: 'type', header: t('reports.kpi.col.type'), wrap: true, cell: (r) => t(`settings.service.${r.type}`) },
                    { key: 'count', header: t('reports.kpi.col.requests'), numeric: true, cell: (r) => num(r.count) },
                  ]}
                  empty={<p className="dtable__none">{t('reports.kpi.noRequests')}</p>}
                />
              </div>
              <p className="mp-meta oprep__foot">
                {t('reports.kpi.foot', { at: dateTime(k.generated_at ?? new Date().toISOString(), lang) })}
              </p>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
