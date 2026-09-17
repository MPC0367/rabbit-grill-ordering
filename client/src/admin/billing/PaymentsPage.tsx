// Payments (brief 23): one Bangkok business day of staff-confirmed payment
// records, and the exceptions a manager should look at (finalised but
// unpaid, closed with an exception, reversals and refund records).
// Records are never edited: a correction adds a reversal with a reason.
import { useEffect, useMemo, useState } from 'react';
import type { PaymentDTO, PaymentExceptionDTO, PaymentsListDTO, StaffBillDTO, TablesDTO } from '../../../../shared/dto.ts';
import { addDays } from '../../../../shared/time.ts';
import { api, qs } from '../../lib/api.ts';
import { clock, dateLabel, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { setQuery, useRoute } from '../../lib/router.ts';
import {
  Banner, Button, Dialog, EmptyState, LinkButton, Pill, Price, Tag, useToast,
} from '../../ui/index.ts';
import { DataTable, DateRangeNav, PageHeader, SectionHeader, StatCard, StatGrid, type DataColumn } from '../../ui/admin/index.ts';
import { useBusinessToday } from '../insights/query.ts';
import { errorText, isAmbiguous, isApiError, pendingKey, useLiveResource, useStaff } from '../tables/shared.ts';
import { paymentStatusKey } from './useBill.tsx';
import './billing.css';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function paymentTone(p: PaymentDTO): 'ok' | 'alert' | 'heat' | 'neutral' {
  if (p.kind !== 'settlement') return 'heat';
  if (p.status === 'confirmed') return 'ok';
  if (p.status === 'reversed') return 'alert';
  return 'neutral';
}

export default function PaymentsPage() {
  const { t, lang, pick } = useI18n();
  const { can } = useStaff();
  const toast = useToast();
  const { query } = useRoute();
  const businessToday = useBusinessToday();
  const asked = query.get('date');
  const date = asked && DATE_RE.test(asked) ? asked : null;
  const allowed = can('payments.view');
  const res = useLiveResource<PaymentsListDTO>(allowed ? `/api/staff/payments${qs({ date })}` : null, ['payment.', 'bill.', 'visit.']);
  const data = res.data;
  const shownDate = data?.date ?? date;
  const tablesRes = useLiveResource<TablesDTO>(allowed && can('tables.view') ? '/api/staff/tables' : null, ['table.', 'visit.']);
  // The server's current business day (its cutoff hour is a setting); learned from a request without a date.
  const [learned, setLearned] = useState<string | null>(null);
  useEffect(() => { if (!date && data?.date) setLearned(data.date); }, [date, data?.date]);
  const [reverse, setReverse] = useState<PaymentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The restaurant's business day, from the server's cutoff (D-AD-01); a list
  // read without a date still wins, because it is the server's own answer.
  const current = learned ?? businessToday;
  const isToday = !date || date === current;

  const activeTableByVisit = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of tablesRes.data?.tables ?? []) if (x.visit) m.set(x.visit.id, x.id);
    return m;
  }, [tablesRes.data]);

  const goTo = (d: string | null) => setQuery({ date: d }, { replace: false });

  const runReverse = async (reason?: string) => {
    const p = reverse;
    if (!p || !reason) return;
    const k = pendingKey(`reverse.${p.id}`);
    try {
      await api.post<StaffBillDTO>(`/api/staff/payments/${encodeURIComponent(p.id)}/reverse`, { reason, idempotency_key: k.key() });
      k.clear();
      setReverse(null);
      await res.refresh();
      toast.show(t('billing.toast.reversed', { amount: money(p.amount_minor) }));
    } catch (err) {
      if (!isAmbiguous(err)) k.clear();
      setError(isAmbiguous(err) ? t('billing.error.ambiguous') : errorText(t, err));
      if (isApiError(err, 'invalid_transition', 'not_found')) void res.refresh();
    }
  };

  const header = (
    <PageHeader
      title={t('payments.title')}
      back={{ label: t('payments.back'), href: '/admin/more' }}
      description={t('payments.lede')}
    />
  );

  if (!allowed) {
    return (
      <div className="c5-page">
        {header}
        <EmptyState icon="lock" headingLevel={2} title={t('payments.denied.title')}>{t('payments.denied.body')}</EmptyState>
      </div>
    );
  }

  const payments = data?.payments ?? [];
  const exceptions = data?.exceptions ?? [];
  const settlements = payments.filter((p) => p.kind === 'settlement' && p.status === 'confirmed');
  const byMethod = new Map<string, { label: string; lang: string; n: number; v: number }>();
  for (const p of settlements) {
    const cur = byMethod.get(p.method);
    const l = pick(p.method_label);
    if (cur) { cur.n += 1; cur.v += p.amount_minor; } else byMethod.set(p.method, { label: l.text, lang: l.lang, n: 1, v: p.amount_minor });
  }
  const kinds: PaymentExceptionDTO['kind'][] = ['unpaid_finalized', 'closed_with_exception', 'reversal', 'refund_record'];
  const kindTotals = kinds.map((k) => {
    const rows = exceptions.filter((e) => e.kind === k);
    return { kind: k, n: rows.length, v: rows.reduce((s, e) => s + e.amount_minor, 0) };
  });

  const payColumns: DataColumn<PaymentDTO>[] = [
    { key: 'time', header: t('payments.col.time'), numeric: false, cell: (p) => <span className="num">{clock(p.confirmed_at)}</span> },
    { key: 'table', header: t('payments.col.table'), cell: (p) => (p.table_label ? t('common.table', { label: p.table_label }) : '—') },
    {
      key: 'method',
      header: t('payments.col.method'),
      cell: (p) => { const l = pick(p.method_label); return <span lang={l.lang}>{l.text}</span>; },
    },
    {
      key: 'amount',
      header: t('payments.col.amount'),
      numeric: true,
      cell: (p) => <Price minor={p.kind === 'settlement' ? p.amount_minor : -p.amount_minor} plain className="num" />,
    },
    {
      key: 'cash',
      header: t('payments.col.cash'),
      numeric: true,
      cell: (p) => (p.tendered_minor !== null ? (
        <span>
          {money(p.tendered_minor)}
          <span className="c5-cell-sub">{t('billing.payment.change', { amount: money(p.change_minor ?? 0) })}</span>
        </span>
      ) : <span className="c5-muted">—</span>),
    },
    { key: 'ref', header: t('payments.col.reference'), wrap: true, cell: (p) => p.reference ?? <span className="c5-muted">—</span> },
    { key: 'by', header: t('payments.col.by'), cell: (p) => p.confirmed_by ?? t('common.unknown') },
    {
      key: 'status',
      header: t('payments.col.status'),
      wrap: true,
      cell: (p) => (
        <span>
          <Pill tone={paymentTone(p)} size="sm">{t(paymentStatusKey(p))}</Pill>
          {p.reason ? <span className="c5-cell-sub c5-cell-reason">{p.reason}</span> : null}
        </span>
      ),
    },
  ];

  const excColumns: DataColumn<PaymentExceptionDTO>[] = [
    { key: 'kind', header: t('payments.col.kind'), cell: (e) => <Tag tone={e.kind === 'unpaid_finalized' || e.kind === 'closed_with_exception' ? 'alert' : 'heat'}>{t(`payments.kind.${e.kind}`)}</Tag> },
    { key: 'time', header: t('payments.col.time'), cell: (e) => <span className="num">{clock(e.at)}</span> },
    { key: 'table', header: t('payments.col.table'), cell: (e) => t('common.table', { label: e.table_label }) },
    { key: 'amount', header: t('payments.col.amount'), numeric: true, cell: (e) => <Price minor={e.amount_minor} plain className="num" /> },
    { key: 'rev', header: t('payments.col.revision'), numeric: true, cell: (e) => (e.revision_no !== null ? e.revision_no : <span className="c5-muted">—</span>) },
    {
      key: 'visit',
      header: t('payments.col.visit'),
      cell: (e) => <span>{e.visit_status ? t(`payments.visit.${e.visit_status}`) : '—'}</span>,
    },
    { key: 'reason', header: t('payments.col.reason'), wrap: true, cell: (e) => e.reason ?? <span className="c5-muted">—</span> },
  ];

  return (
    <div className="c5-page">
      {header}

      <DateRangeNav
        period="custom"
        label={shownDate ? (isToday ? t('payments.today') : dateLabel(shownDate, lang, { weekday: true })) : t('common.loading')}
        range={shownDate ? dateLabel(shownDate, lang, { weekday: true, year: true }) : '—'}
        timeZone="Asia/Bangkok"
        onPrev={shownDate ? () => goTo(addDays(shownDate, -1)) : undefined}
        onNext={shownDate ? () => goTo(addDays(shownDate, 1)) : undefined}
        nextDisabled={isToday}
        date={shownDate ?? undefined}
        maxDate={current}
        onPickDate={(d) => goTo(d)}
      >
        {!isToday ? <Button variant="outline" size="staff" onClick={() => goTo(null)}>{t('payments.backToday')}</Button> : null}
      </DateRangeNav>

      {res.stale ? (
        <Banner variant="warning" staff title={t('payments.staleTitle')} action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}>
          {errorText(t, res.error)}
        </Banner>
      ) : null}
      {data?.include_fixture ? <Banner variant="demo" staff title={t('common.demoData')}>{t('payments.demo')}</Banner> : null}

      {!data && res.error ? (
        <EmptyState icon="alert" headingLevel={2} title={t('payments.loadFailed')} action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}>
          {errorText(t, res.error)}
        </EmptyState>
      ) : (
        <>
          {/* The stat cards are h3s: a heading above them keeps the outline whole (no h2 gap). */}
          <h2 className="visually-hidden">{t('payments.summaryTitle')}</h2>
          <StatGrid className="c5-summary">
            <StatCard
              label={t('payments.stat.confirmed')}
              state={data ? 'ready' : 'loading'}
              value={data ? money(data.summary.confirmed.value_minor) : undefined}
              note={data ? t('payments.stat.confirmedNote', { n: data.summary.confirmed.count }) : undefined}
            />
            {[...byMethod.values()].map((m) => (
              <StatCard key={m.label} label={m.label} state="ready" value={money(m.v)} note={t('payments.stat.records', { n: m.n })} />
            ))}
            <StatCard
              label={t('payments.stat.exceptions')}
              state={data ? 'ready' : 'loading'}
              value={data ? String(data.summary.exceptions.count) : undefined}
              note={data ? t('payments.stat.exceptionsNote', { amount: money(data.summary.exceptions.value_minor) }) : undefined}
            />
          </StatGrid>

          <section className="c5-section" aria-labelledby="c5-pay-list">
            <SectionHeader titleId="c5-pay-list" title={t('payments.listTitle')} description={t('payments.listLede')} />
            <DataTable<PaymentDTO>
              caption={t('payments.caption', { date: shownDate ? dateLabel(shownDate, lang, { year: true }) : '' })}
              columns={payColumns}
              rows={payments}
              rowKey={(p) => p.id}
              empty={<EmptyState compact icon="receipt" title={data ? t('payments.none') : t('common.loading')}>{data ? t('payments.noneBody') : null}</EmptyState>}
              rowActions={can('payments.correct') ? (p) => (
                p.kind === 'settlement' && p.status === 'confirmed' ? (
                  <Button variant="ghost" size="staff" opensDialog onClick={() => { setError(null); setReverse(p); }} aria-label={t('payments.reverseOne', { amount: money(p.amount_minor), table: p.table_label ?? '' })}>
                    {t('billing.action.reverse')}
                  </Button>
                ) : null
              ) : undefined}
              actionsLabel={t('common.staff.actions')}
              footer={payments.length > 0 ? t('payments.footer', { n: payments.length }) : undefined}
            />
          </section>

          <section className="c5-section" aria-labelledby="c5-pay-exc">
            <SectionHeader titleId="c5-pay-exc" title={t('payments.exceptionsTitle')} description={t('payments.exceptionsLede')} />
            <ul className="c5-kinds" aria-label={t('payments.kindsLabel')}>
              {kindTotals.map((k) => (
                <li key={k.kind} className="c5-kind">
                  <span>{t(`payments.kind.${k.kind}`)}</span>
                  <b>{k.n}</b>
                  <span className="num">{money(k.v)}</span>
                </li>
              ))}
            </ul>
            <DataTable<PaymentExceptionDTO>
              caption={t('payments.exceptionsTitle')}
              columns={excColumns}
              rows={exceptions}
              rowKey={(e) => `${e.kind}-${e.visit_id}-${e.payment_id ?? e.at}`}
              empty={<EmptyState compact icon="check-c" title={data ? t('payments.noExceptions') : t('common.loading')} />}
              rowActions={(e) => {
                const tableId = activeTableByVisit.get(e.visit_id);
                return tableId ? (
                  <LinkButton variant="ghost" size="staff" href={`/admin/tables/${encodeURIComponent(tableId)}`} iconEnd="chev-r">
                    {t('payments.openTable')}
                  </LinkButton>
                ) : null;
              }}
              actionsLabel={t('common.staff.actions')}
            />
          </section>
        </>
      )}

      <Dialog
        open={Boolean(reverse)}
        onClose={() => setReverse(null)}
        density="staff"
        tone="danger"
        title={reverse ? t('billing.reverse.title', { amount: money(reverse.amount_minor), method: pick(reverse.method_label).text }) : ''}
        confirmLabel={t('billing.reverse.confirm')}
        onConfirm={runReverse}
        error={error}
        reason={{ label: t('billing.reason'), required: true, limit: 200, placeholder: t('billing.reverse.placeholder') }}
      >
        <p>{reverse?.table_label ? t('payments.reverseTable', { table: reverse.table_label, time: clock(reverse.confirmed_at) }) : null}</p>
        <p>{t('billing.reverse.body')}</p>
        <p className="c5-note">{t('payments.reverseNote')}</p>
      </Dialog>
    </div>
  );
}
