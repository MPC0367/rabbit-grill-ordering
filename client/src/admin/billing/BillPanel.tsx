// The table bill for staff (brief 16, 23; DESIGN §10.19 bill block).
// Accepted chargeable lines, what is waiting and what is not charged, the
// calculation, revision history, payment records and the actions this role
// may take. Paid and Checkout complete are shown as different things:
// a payment never frees the table.
import { useState, type ReactNode } from 'react';
import type { BillLineDTO, BillRevisionDTO, PaymentDTO, StaffBillDTO } from '../../../../shared/dto.ts';
import { clock, dateTime, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  Button, DrawerSection, EmptyState, KeyValue, LineStatusPill, Pill, Price, Skeleton, type KeyValueItem,
} from '../../ui/index.ts';
import { dishName, errorText, tn } from '../tables/shared.ts';
import { billState, nextBillStep, paymentStatusKey, useBillController, type BillController } from './useBill.tsx';
import './billing.css';

export interface BillPanelProps {
  visitId: string;
  /** Share a controller with the host (the table drawer). The host then renders `controller.dialogs`. */
  controller?: BillController;
  /** inline (default): the next billing step is a button here. external: the host shows it. */
  nextStep?: 'inline' | 'external';
}

const COLLAPSE_AFTER = 6;

function groupByRound(lines: BillLineDTO[]): Array<{ ref: string; lines: BillLineDTO[] }> {
  const out: Array<{ ref: string; lines: BillLineDTO[] }> = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.ref === l.order_reference) last.lines.push(l);
    else out.push({ ref: l.order_reference, lines: [l] });
  }
  return out;
}

function LineRows({ lines, mode }: { lines: BillLineDTO[]; mode: 'charged' | 'pending' | 'excluded' }) {
  const { t, pick } = useI18n();
  const groups = groupByRound(lines);
  return (
    <>
      {groups.map((g) => (
        <li key={g.ref} className="c5-bgroup">
          <span className="c5-bgroup__ref" lang="en">{g.ref}</span>
          <ul className="c5-blines">
            {g.lines.map((l) => {
              const n = dishName(pick, l.name, [l.variant_name ? pick(l.variant_name).text : null, l.measured_grams ? t('billing.grams', { g: l.measured_grams }) : null]);
              return (
                <li key={l.line_id} className={`c5-bline c5-bline--${mode}`}>
                  <span className="c5-bline__q num">{l.quantity}</span>
                  <span className="c5-bline__n">
                    <span lang={n.lang}>{n.text}</span>
                    {n.marked ? <span className="c5-fallback" title={t(n.lang === 'en' ? 'common.enOnly' : 'tables.thaiOnly')}> †</span> : null}
                  </span>
                  {mode === 'charged' ? (
                    <Price minor={l.line_total_minor} plain className="c5-bline__v num" />
                  ) : (
                    <span className="c5-bline__s">
                      <LineStatusPill status={l.status} />
                      <span className="c5-bline__muted num">{money(l.line_total_minor)}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </>
  );
}

function PaymentRow({ p, onReverse }: { p: PaymentDTO; onReverse?: () => void }) {
  const { t, pick } = useI18n();
  const method = pick(p.method_label);
  const tone = p.kind !== 'settlement' ? 'heat' : p.status === 'confirmed' ? 'ok' : p.status === 'reversed' ? 'alert' : 'neutral';
  const details = [
    clock(p.confirmed_at),
    p.confirmed_by,
    p.tendered_minor !== null ? t('billing.payment.received', { amount: money(p.tendered_minor) }) : null,
    p.change_minor !== null && p.change_minor > 0 ? t('billing.payment.change', { amount: money(p.change_minor) }) : null,
    p.reference ? t('billing.payment.ref', { ref: p.reference }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <li className="c5-payrow">
      <div className="c5-payrow__main">
        <b lang={method.lang}>{method.text}</b>
        <Price minor={p.kind === 'settlement' ? p.amount_minor : -p.amount_minor} plain className="c5-payrow__amt num" />
        <Pill tone={tone} size="sm" icon={tone === 'ok' ? 'check' : tone === 'alert' ? 'slash' : 'refresh'}>{t(paymentStatusKey(p))}</Pill>
      </div>
      <p className="c5-payrow__meta">{details}</p>
      {p.reason ? <p className="c5-payrow__meta">{t('billing.payment.reason', { reason: p.reason })}</p> : null}
      {onReverse ? (
        <Button variant="ghost" size="staff" className="c5-payrow__act" opensDialog onClick={onReverse}>{t('billing.action.reverse')}</Button>
      ) : null}
    </li>
  );
}

/** Adjustments that no longer count: voided by a manager, or because their dish left the bill (D-S8-01). */
function VoidedAdjustments({ list }: { list: NonNullable<StaffBillDTO['adjustments']> }) {
  const { t, lang } = useI18n();
  if (list.length === 0) return null;
  return (
    <details className="c5-revs c5-voids">
      <summary>{t('billing.voided.title', { n: list.length })}</summary>
      <ol>
        {list.map((a) => (
          <li key={a.id} className="is-old">
            <p className="c5-revs__h">
              <b>{t(`billing.adjust.kind.${a.kind}`)}</b>
              <span className="num">{money(a.amount_minor, { sign: true })}</span>
              <Pill tone="line" size="sm" icon="slash">{t('billing.voided.pill')}</Pill>
            </p>
            <p className="c5-payrow__meta">{t('billing.payment.reason', { reason: a.reason })}</p>
            <p className="c5-payrow__meta">
              {a.voided_at
                ? t('billing.voided.by', { time: dateTime(a.voided_at, lang), name: a.voided_by ?? t('common.unknown') })
                : null}
              {a.void_reason ? ` · ${a.void_reason}` : ''}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

function RevisionHistory({ revisions }: { revisions: BillRevisionDTO[] }) {
  const { t, lang } = useI18n();
  if (revisions.length === 0) return null;
  return (
    <details className="c5-revs">
      <summary>{t('billing.revisions', { n: revisions.length })}</summary>
      <ol>
        {revisions.map((r) => (
          <li key={r.id} className={r.status === 'superseded' ? 'is-old' : undefined}>
            <p className="c5-revs__h">
              <b>{t('billing.revision', { n: r.revision_no })}</b>
              <span className="num">{money(r.total_minor)}</span>
              <Pill tone={r.status === 'settled' ? 'ok' : r.status === 'payable' ? 'neutral' : 'line'} size="sm">{t(`billing.revStatus.${r.status}`)}</Pill>
            </p>
            <p className="c5-payrow__meta">
              {t('billing.finalisedBy', { time: dateTime(r.finalized_at, lang), name: r.finalized_by ?? t('common.unknown') })}
            </p>
            {r.superseded_at ? (
              <p className="c5-payrow__meta">
                {t('billing.supersededAt', { time: dateTime(r.superseded_at, lang) })}
                {r.supersede_reason ? ` · ${r.supersede_reason === 'refinalized' ? t('billing.refinalised') : r.supersede_reason}` : ''}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function BillBody({ ctl, nextStep = 'inline' }: { ctl: BillController; nextStep?: 'inline' | 'external' }) {
  const { t, lang, pick } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const { bill, res, can } = ctl;

  if (!can('billing.view')) {
    return <p className="c5-note">{t('billing.noPermission')}</p>;
  }
  if (!bill) {
    if (res.error) {
      return (
        <EmptyState compact icon="alert" title={t('billing.loadFailed')} action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}>
          {errorText(t, res.error)}
        </EmptyState>
      );
    }
    return (
      <div role="status" aria-label={t('common.loading')} className="c5-bill-skel">
        <Skeleton lines={3} />
        <Skeleton shape="block" height={40} />
      </div>
    );
  }

  const b = bill;
  const rev = b.current_revision;
  const itemCount = b.lines.reduce((n, l) => n + l.quantity, 0);
  const charged = showAll || b.lines.length <= COLLAPSE_AFTER + 1 ? b.lines : b.lines.slice(0, COLLAPSE_AFTER);
  const hidden = b.lines.length - charged.length;
  const closed = b.checkout_complete || b.visit_status === 'closed';
  const canAdjust = can('billing.adjust') && !closed && !b.paid && rev?.status !== 'payable';
  const canReopen = can('billing.reopen') && !closed && !b.paid && (b.visit_status === 'billing' || rev?.status === 'payable');
  const next = nextStep === 'inline' ? nextBillStep(b, can, t) : null;
  const settlementRev = rev?.id;

  const summary: KeyValueItem[] = [
    { key: 'sub', term: tn(t, 'billing.subtotal', itemCount), value: money(b.subtotal_minor), strong: true },
  ];
  if (rev && rev.adjustments.length > 0) {
    for (const a of rev.adjustments) {
      summary.push({ key: a.id, term: `${t(`billing.adjust.kind.${a.kind}`)} · ${a.reason}`, value: money(a.amount_minor, { sign: true }) });
    }
  } else if (b.adjustments && b.adjustments.length > 1) {
    // Several on a running bill: one line in the calculation, each one listed
    // below with who added it, why, and the way to void it.
    summary.push({ key: 'adj', term: tn(t, 'billing.adjustmentsN', b.adjustments.length), value: money(b.adjustments_minor, { sign: true }) });
  } else if (b.adjustments && b.adjustments.length === 1) {
    const a = b.adjustments[0];
    summary.push({ key: a.id, term: `${t(`billing.adjust.kind.${a.kind}`)} · ${a.reason}`, value: money(a.amount_minor, { sign: true }) });
  } else if (b.adjustments_minor !== 0) {
    summary.push({ key: 'adj', term: t('billing.adjustments'), value: money(b.adjustments_minor, { sign: true }) });
  }
  if (b.charges.length === 0) {
    summary.push({ key: 'charges', term: t('billing.charges'), value: t('billing.notConfigured'), muted: true });
  } else {
    for (const c of b.charges) {
      const label = pick({ th: c.label_th, en: c.label_en });
      summary.push({
        key: c.id,
        term: c.inclusive ? t('billing.chargeIncluded', { label: label.text }) : label.text,
        termLang: label.lang,
        value: money(c.amount_minor),
        muted: c.inclusive,
      });
    }
  }
  if (b.unresolved.open_portion_requests > 0) {
    summary.push({ key: 'quotes', term: t('billing.quotesWaiting', { n: b.unresolved.open_portion_requests }), value: t('billing.notIncluded'), muted: true });
  }

  const actions: ReactNode[] = [];
  if (next) {
    actions.push(
      <Button
        key="next"
        variant="primary"
        size="staff"
        icon="receipt"
        opensDialog
        aria-disabled={next.blockedBy ? true : undefined}
        aria-describedby={next.blockedBy ? `c5-next-${b.visit_id}` : undefined}
        onClick={() => { if (!next.blockedBy) ctl.open(next.step); }}
      >
        {next.label}
      </Button>,
    );
  }
  if (canReopen) {
    actions.push(<Button key="reopen" variant="outline" size="staff" opensDialog onClick={() => ctl.open('reopen')}>{t('billing.action.reopen')}</Button>);
  }

  return (
    <div className="c5-bill">
      {res.stale ? (
        <p className="c5-stale" role="status">
          {t('billing.staleData')}
          <Button variant="ghost" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>
        </p>
      ) : null}

      {rev ? (
        <p className="c5-bill__meta">
          {t('billing.revisionLine', { n: rev.revision_no, time: clock(rev.finalized_at), name: rev.finalized_by ?? t('common.unknown') })}
        </p>
      ) : !closed ? (
        <p className="c5-bill__meta">{b.visit_status === 'billing' ? t('billing.runningBilling') : t('billing.running')}</p>
      ) : null}

      {b.revision_stale ? (
        <p className="c5-callout c5-callout--heat" role="status">
          {t('billing.staleRevision', { total: money(b.running_total_minor ?? b.total_minor) })}
        </p>
      ) : null}

      {b.lines.length === 0 && b.pending_lines.length === 0 ? (
        <p className="c5-bill__empty">{t('billing.noItems')}</p>
      ) : (
        <ul className="c5-bgroups" aria-label={t('billing.itemsLabel')}>
          <LineRows lines={charged} mode="charged" />
        </ul>
      )}
      {hidden > 0 ? (
        <Button variant="ghost" size="staff" iconEnd="chev-d" onClick={() => setShowAll(true)}>{t('billing.showAll', { n: b.lines.length })}</Button>
      ) : null}

      {b.pending_lines.length > 0 ? (
        <div className="c5-bsub">
          <h4 className="c5-cap">{t('billing.pendingTitle')}</h4>
          <ul className="c5-bgroups"><LineRows lines={b.pending_lines} mode="pending" /></ul>
        </div>
      ) : null}
      {b.excluded_lines.length > 0 ? (
        <div className="c5-bsub">
          <h4 className="c5-cap">{t('billing.excludedTitle')}</h4>
          <ul className="c5-bgroups"><LineRows lines={b.excluded_lines} mode="excluded" /></ul>
        </div>
      ) : null}

      <KeyValue items={summary} className="c5-bill__kv" />
      <p className="c5-total">
        <span>{rev ? t('billing.totalDue') : t('billing.totalSoFar')}</span>
        <Price minor={b.total_minor} size="total" />
      </p>

      {/* Money given back after checkout: the revision stays settled as history (D-S8-04). */}
      {b.payment_state === 'refunded' ? (
        <div className="c5-callout c5-callout--alert c5-refund" role="status">
          <p>{b.refund ? t('billing.refunded.row', { amount: money(b.refund.amount_minor) }) : t('billing.state.refunded')}</p>
          {b.refund ? (
            <p className="c5-refund__meta">
              {[
                b.refund.reason ? t('billing.payment.reason', { reason: b.refund.reason }) : null,
                t('billing.refunded.by', { name: b.refund.by ?? t('common.unknown'), time: dateTime(b.refund.at, lang) }),
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}
      {b.paid && !closed ? (
        <p className="c5-callout c5-callout--ok" role="status">{t('billing.paidNotClosed')}</p>
      ) : null}
      {closed ? <p className="c5-callout c5-callout--ok">{t('billing.closedNote')}</p> : null}

      {/* Each adjustment with who added it and why; a manager can void one while the bill is open (D-S8-01). */}
      {b.adjustments && b.adjustments.length > 0 ? (
        <div className="c5-bsub">
          <h4 className="c5-cap">{t('billing.adjustments')}</h4>
          <ul className="c5-payrows">
            {b.adjustments.map((a) => (
              <li key={a.id} className="c5-payrow">
                <div className="c5-payrow__main">
                  <b>{t(`billing.adjust.kind.${a.kind}`)}</b>
                  <Price minor={a.amount_minor} plain className="c5-payrow__amt num" />
                </div>
                <p className="c5-payrow__meta">
                  {[clock(a.created_at), a.created_by, t('billing.payment.reason', { reason: a.reason })].filter(Boolean).join(' · ')}
                </p>
                {canAdjust ? (
                  <Button
                    variant="ghost"
                    size="staff"
                    className="c5-payrow__act"
                    opensDialog
                    aria-label={t('billing.void.action.named', {
                      kind: t(`billing.adjust.kind.${a.kind}`),
                      amount: money(a.amount_minor, { sign: true }),
                      reason: a.reason,
                    })}
                    onClick={() => ctl.open('void', { adjustment: a })}
                  >
                    {t('billing.void.action')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAdjust ? (
        <Button variant="ghost" size="staff" icon="plus" opensDialog className="c5-bill__adjust" onClick={() => ctl.open('adjust')}>
          {t('billing.action.adjust')}
        </Button>
      ) : null}

      {b.payments.length > 0 ? (
        <div className="c5-bsub">
          <h4 className="c5-cap">{t('billing.paymentsTitle')}</h4>
          <ul className="c5-payrows">
            {b.payments.map((p) => (
              <PaymentRow
                key={p.id}
                p={p}
                onReverse={p.kind === 'settlement' && p.status === 'confirmed' && can('payments.correct') && (!settlementRev || p.bill_revision_id === settlementRev || closed)
                  ? () => ctl.open('reverse', { payment: p })
                  : undefined}
              />
            ))}
          </ul>
        </div>
      ) : rev && !b.paid && !closed ? (
        <p className="c5-bill__empty">{t('billing.noPayment')}</p>
      ) : null}

      <VoidedAdjustments list={b.voided_adjustments ?? []} />
      <RevisionHistory revisions={b.revisions} />

      {next?.blockedBy ? <p className="c5-note" id={`c5-next-${b.visit_id}`}>{next.blockedBy}</p> : null}
      {actions.length > 0 ? <div className="c5-actions">{actions}</div> : null}
    </div>
  );
}

/** Bill section of the table drawer, or a standalone bill for a visit. */
export default function BillPanel({ visitId, controller, nextStep = 'inline' }: BillPanelProps) {
  const { t } = useI18n();
  const own = useBillController(visitId, { enabled: !controller });
  const ctl = controller ?? own;
  const b = ctl.bill;
  const state = b ? billState(b, t, clock) : null;
  return (
    <DrawerSection
      title={t('billing.title')}
      aside={state ? <Pill tone={state.tone} size="sm" icon={state.icon}>{state.text}</Pill> : undefined}
      className="c5-billsec"
    >
      <BillBody ctl={ctl} nextStep={nextStep} />
      {controller ? null : own.dialogs}
    </DrawerSection>
  );
}
