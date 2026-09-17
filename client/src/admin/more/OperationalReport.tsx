// Operational report (brief 26): KPIs for a chosen business-date range from
// GET /api/staff/stats/kpis, each with its definition and sample, precisely
// labelled totals (never "revenue"), hourly rounds, reasons, open bills,
// service requests, guest feedback, and a CSV of exactly what is on screen.
// Dates follow the server's business-day cutoff. Table, category and staff
// filters appear once the server says it can split by them.
import { useMemo, useState, type ReactNode } from 'react';
import { addDays, daysBetween, monthStart } from '../../../../shared/time.ts';
import { qs } from '../../lib/api.ts';
import { dateLabel, dateTime, money, num, pct } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { setQuery, useRoute } from '../../lib/router.ts';
import {
  Button, DataTable, EmptyState, FilterChips, KeyValue, MiniBars, SectionHeader, SelectButton, StatCard, StatGrid, TextField, useToast,
} from '../../ui/index.ts';
import { useLiveResource } from '../insights/parts.tsx';
import { MAX_CUSTOM_DAYS, useBusinessToday } from '../insights/query.ts';
import { downloadFile, kpiCsv, saveBlob } from './csv.ts';
import { FeedbackPanel, feedbackUnavailable } from './FeedbackPanel.tsx';
import type { FeedbackListDTO, KpiFigure, KpiView } from './reportTypes.ts';
import { langOf, StaleBanner, useErrorWords } from './shared.tsx';

type Preset = '7d' | '30d' | 'month' | 'lastmonth' | 'year' | 'custom';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ALL = '';

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

/** Days in an inclusive range, as the API counts them (at most MAX_CUSTOM_DAYS). */
function tooLong(from: string, to: string): boolean {
  return daysBetween(from, to) + 1 > MAX_CUSTOM_DAYS;
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

const TOPICS = ['order.', 'line.', 'bill.', 'payment.', 'service.', 'visit.'];

export default function OperationalReport({ includeDemo }: { includeDemo: boolean }) {
  const { t, lang, pick } = useI18n();
  const toast = useToast();
  const { errorText } = useErrorWords();
  const { query } = useRoute();
  const dur = useDuration();
  const today = useBusinessToday();

  const qFrom = query.get('from') ?? '';
  const qTo = query.get('to') ?? '';
  const preset: Preset = (['7d', '30d', 'month', 'lastmonth', 'year', 'custom'] as const).includes(query.get('range') as Preset)
    ? (query.get('range') as Preset)
    : '7d';
  const urlRangeOk = ISO.test(qFrom) && ISO.test(qTo) && qFrom <= qTo && !tooLong(qFrom, qTo);
  const range = preset === 'custom' && urlRangeOk ? { from: qFrom, to: qTo } : presetRange(preset === 'custom' ? '7d' : preset, today);

  // Filters live in the URL; the server echoes the ones it applied.
  const idParam = (k: string) => { const v = query.get(k); return v && ID.test(v) ? v : null; };
  const want = { table_id: idParam('table'), category_id: idParam('cat'), staff_id: idParam('staff') };

  // Custom dates are edited locally and applied once both are valid.
  const [draft, setDraft] = useState<{ from: string; to: string }>(() => (preset === 'custom' && !urlRangeOk && (qFrom || qTo) ? { from: qFrom, to: qTo } : range));
  const draftKey = `${range.from}|${range.to}`;
  const [seenKey, setSeenKey] = useState(draftKey);
  if (seenKey !== draftKey) { setSeenKey(draftKey); setDraft(range); }
  const draftProblem = !ISO.test(draft.from) || !ISO.test(draft.to)
    ? t('reports.kpi.err.dates')
    : draft.from > draft.to ? t('reports.kpi.err.order')
    : tooLong(draft.from, draft.to) ? t('reports.kpi.err.max', { n: MAX_CUSTOM_DAYS })
    : null;

  const fx = includeDemo ? '1' : '0';
  const path = `/api/staff/stats/kpis${qs({ from: range.from, to: range.to, include_fixture: fx, ...want })}`;
  const res = useLiveResource<KpiView>(path, { topics: TOPICS, debounceMs: 2500 });
  // Guest feedback: stop asking once the server says this account may not read it.
  const [fbOff, setFbOff] = useState(false);
  const feedback = useLiveResource<FeedbackListDTO>(
    fbOff ? null : `/api/staff/feedback${qs({ from: range.from, to: range.to, include_fixture: fx })}`,
    { topics: ['visit.'], debounceMs: 5000 },
  );
  if (!fbOff && !feedback.data && feedbackUnavailable(feedback.error)) setFbOff(true);
  const fbData = fbOff ? null : feedback.data ?? null;
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

  // ---- filters (only when the server lists the choices, i.e. it can apply them)
  const options = k?.filter_options;
  const applied = k?.filters;
  const anyFilter = Boolean(applied && (applied.table_id || applied.category_id || applied.staff_id));
  const unfiltered = new Set<KpiFigure>(anyFilter ? k?.unfiltered ?? [] : []);
  /** A figure the active filters do not narrow says so under its note. */
  const withScope = (figure: KpiFigure, note: ReactNode): ReactNode => (unfiltered.has(figure)
    ? <>{note}{note ? <br /> : null}<span className="oprep__unf">{t('reports.kpi.filter.unfiltered')}</span></>
    : note);
  const filterScope: string[] = [];
  if (applied && options) {
    const table = applied.table_id ? options.tables.find((x) => x.id === applied.table_id) : null;
    const cat = applied.category_id ? options.categories.find((x) => x.id === applied.category_id) : null;
    const staff = applied.staff_id ? options.staff.find((x) => x.id === applied.staff_id) : null;
    if (table) filterScope.push(t('reports.kpi.filter.scopeTable', { label: table.label }));
    if (cat) filterScope.push(t('reports.kpi.filter.scopeCategory', { name: pick(cat.name).text }));
    if (staff) filterScope.push(t('reports.kpi.filter.scopeStaff', { name: staff.name }));
  }

  const exportCsv = () => {
    if (!k) return;
    const name = `rabbit-grill-operational-${k.from}-to-${k.to}${anyFilter ? '-filtered' : ''}${k.include_fixture ? '-demo' : ''}.csv`;
    saveBlob(new Blob([kpiCsv(k, { generatedAt: new Date().toISOString(), feedback: fbData })], { type: 'text/csv;charset=utf-8' }), name);
    toast.show(t('reports.kpi.csvSaved', { name }));
  };

  const [roundsBusy, setRoundsBusy] = useState(false);
  const roundsCsv = `/api/staff/stats/export.csv${qs({
    view: 'orders', rows: 'order', period: 'custom', from: range.from, to: range.to, include_fixture: fx,
    // The same filters as the figures, so the exported rounds match what is on screen.
    ...(options ? { table_id: want.table_id, category_id: want.category_id, staff_id: want.staff_id } : {}),
  })}`;

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
            <TextField
              density="staff"
              type="date"
              label={t('reports.kpi.to')}
              value={draft.to}
              max={today}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              error={draftProblem ?? undefined}
            />
            <Button type="submit" variant="outline" size="staff" disabled={Boolean(draftProblem) || (draft.from === range.from && draft.to === range.to)}>
              {t('reports.kpi.apply')}
            </Button>
            {draftProblem ? null : <p className="mp-meta oprep__hint">{t('reports.kpi.rangeHint', { n: MAX_CUSTOM_DAYS })}</p>}
          </form>
        ) : null}
        {options ? (
          <div className="oprep__filters" role="group" aria-label={t('reports.kpi.filter.label')}>
            <SelectButton
              label={t('reports.kpi.filter.table')}
              value={want.table_id ?? ALL}
              options={[{ value: ALL, label: t('reports.kpi.filter.allTables') }, ...options.tables.map((x) => ({ value: x.id, label: x.label }))]}
              onChange={(v) => setQuery({ table: v || null })}
            />
            <SelectButton
              label={t('reports.kpi.filter.category')}
              value={want.category_id ?? ALL}
              options={[{ value: ALL, label: t('reports.kpi.filter.allCategories') }, ...options.categories.map((x) => ({ value: x.id, label: pick(x.name).text }))]}
              onChange={(v) => setQuery({ cat: v || null })}
            />
            <SelectButton
              label={t('reports.kpi.filter.staff')}
              value={want.staff_id ?? ALL}
              options={[{ value: ALL, label: t('reports.kpi.filter.allStaff') }, ...options.staff.map((x) => ({ value: x.id, label: x.name }))]}
              onChange={(v) => setQuery({ staff: v || null })}
            />
            {want.table_id || want.category_id || want.staff_id ? (
              <Button variant="ghost" size="staff" icon="x" onClick={() => setQuery({ table: null, cat: null, staff: null })}>
                {t('reports.kpi.filter.clear')}
              </Button>
            ) : null}
            <p className="mp-meta oprep__fhelp">{t('reports.kpi.filter.help')}</p>
          </div>
        ) : null}
        <p className="oprep__scope" aria-live="polite">
          <b>{rangeText}</b>
          <span> · {t('reports.kpi.tz')}</span>
          <span> · {includeDemo ? t('reports.scope.withDemo') : t('reports.scope.noDemo')}</span>
          {filterScope.map((s) => <span key={s}> · <b>{s}</b></span>)}
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
              note={k ? withScope('qr_adoption', k.qr_adoption.denominator ? t('reports.kpi.qr.note', { n: num(k.qr_adoption.numerator), d: num(k.qr_adoption.denominator) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.qr')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.orderTime')}
              parts={k ? dur.parts(k.guest_order_time.median_s) : undefined}
              value={k && k.guest_order_time.median_s === null ? '—' : undefined}
              note={k ? withScope('guest_order_time', k.guest_order_time.sample ? t('reports.kpi.p90sample', { p90: dur.text(k.guest_order_time.p90_s), n: num(k.guest_order_time.sample), what: unit('reports.kpi.journeys', k.guest_order_time.sample) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.orderTime')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.aov')}
              value={k ? (k.average_order_value.value_minor === null ? '—' : money(k.average_order_value.value_minor)) : undefined}
              note={k ? withScope('average_order_value', k.average_order_value.rounds ? t('reports.kpi.aov.note', { n: num(k.average_order_value.rounds) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.aov')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.atv')}
              value={k ? (k.average_table_value.value_minor === null ? '—' : money(k.average_table_value.value_minor)) : undefined}
              note={k ? withScope('average_table_value', k.average_table_value.visits ? t('reports.kpi.atv.note', { n: num(k.average_table_value.visits) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.atv')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.errors')}
              value={k ? pct(k.operational_errors.rate, 1) : undefined}
              note={k ? withScope('operational_errors', k.operational_errors.submitted_rounds ? t('reports.kpi.errors.note', { n: num(k.error_rounds ?? 0), d: num(k.operational_errors.submitted_rounds) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.errors')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.accept')}
              parts={k ? dur.parts(k.staff_response.accept_median_s) : undefined}
              value={k && k.staff_response.accept_median_s === null ? '—' : undefined}
              note={k ? withScope('accept', k.staff_response.accept_sample ? t('reports.kpi.p90sample', { p90: dur.text(k.staff_response.accept_p90_s), n: num(k.staff_response.accept_sample), what: unit('reports.kpi.rounds', k.staff_response.accept_sample) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.accept')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.ack')}
              parts={k ? dur.parts(k.staff_response.ack_median_s) : undefined}
              value={k && k.staff_response.ack_median_s === null ? '—' : undefined}
              note={k ? withScope('ack', k.staff_response.ack_sample ? t('reports.kpi.p90sample', { p90: dur.text(k.staff_response.ack_p90_s), n: num(k.staff_response.ack_sample), what: unit('reports.kpi.requests', k.staff_response.ack_sample) }) : t('reports.kpi.noSample')) : null}
              definition={<p>{t('reports.def.ack')}</p>}
            />
            <StatCard
              state={state}
              label={t('reports.kpi.openBills')}
              value={k ? num(k.open_bills) : undefined}
              live={Boolean(k)}
              note={withScope('open_bills', t('reports.kpi.openBills.note'))}
              definition={<p>{t('reports.def.openBills')}</p>}
            />
            {financial ? (
              <StatCard
                state={state}
                label={t('reports.kpi.exceptions')}
                value={k ? num(k.payment_exceptions.count) : undefined}
                note={k ? withScope('payment_exceptions', t('reports.kpi.exceptions.note', { value: money(k.payment_exceptions.value_minor) })) : null}
                definition={(
                  <>
                    <p>{t('reports.def.exceptions')}</p>
                    {k?.refunds_after_checkout ? <p>{t('reports.def.exceptionsRefunds')}</p> : null}
                  </>
                )}
              />
            ) : null}
            {financial && k?.refunds_after_checkout ? (
              <StatCard
                state={state}
                label={t('reports.kpi.refunds')}
                value={num(k.refunds_after_checkout.count)}
                note={withScope('refunds', t('reports.kpi.refunds.note', { value: money(k.refunds_after_checkout.value_minor) }))}
                definition={<p>{t('reports.def.refunds')}</p>}
              />
            ) : null}
          </StatGrid>

          {k ? (
            <>
              <div className="oprep__grid">
                <article className="mp-panel" aria-labelledby="oprep-totals">
                  <h3 id="oprep-totals" className="mp-panel__h">{t('reports.kpi.totals')}</h3>
                  <p className="mp-meta">{withScope('totals', t('reports.kpi.totals.d'))}</p>
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
                  {unfiltered.has('hourly') ? <p className="mp-meta oprep__unf">{t('reports.kpi.filter.unfiltered')}</p> : null}
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
                  caption={withScope('cancellations', t('reports.kpi.cancellations'))}
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
                  caption={withScope('service_requests', t('reports.kpi.requestsBy'))}
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
              {fbOff ? null : <FeedbackPanel res={feedback} />}
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
