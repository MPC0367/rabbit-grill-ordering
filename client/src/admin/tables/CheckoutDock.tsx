// The drawer foot (brief 36, DESIGN §10.19): exactly what still blocks
// checkout, the next billing step, and the single Complete checkout action
// (idempotent; a lost answer is recovered with the same key), plus the
// manager exception path with a reason.
import { useEffect, useId, useMemo, useState } from 'react';
import type { CheckoutResultDTO, StaffBillDTO, VisitDetailDTO } from '../../../../shared/dto.ts';
import { ACTIVE_UNSERVED } from '../../../../shared/status.ts';
import { api } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useMedia } from '../../lib/store.ts';
import { Button, CheckoutBlockers, Dialog } from '../../ui/index.ts';
import type { BillController } from '../billing/useBill.tsx';
import { errorText, isAmbiguous, isApiError, pendingKey } from './shared.ts';

type T = (k: string, v?: Record<string, string | number>) => string;

/** Plain-words blockers (stop checkout) and notices (closed automatically at checkout). */
export function checkoutWords(t: T, bill: StaffBillDTO, detail: VisitDetailDTO | undefined): { blockers: string[]; notices: string[] } {
  const blockers: string[] = [];
  const notices: string[] = [];
  const codes = new Set(bill.checkout_blockers);
  if (codes.has('unresolved_orders')) {
    const rounds = [...(detail?.orders ?? [])].sort((a, b) => a.round_no - b.round_no);
    let described = false;
    for (const o of rounds) {
      // Counted in items (order lines), the same unit as the tile's "not served" figure.
      const waiting = o.lines.filter((l) => l.status === 'submitted').length;
      const cooking = o.lines.filter((l) => l.status !== 'submitted' && ACTIVE_UNSERVED.includes(l.status)).length;
      if (waiting > 0) { blockers.push(t(waiting === 1 ? 'tables.block.toAcceptOne' : 'tables.block.toAccept', { n: waiting, r: o.round_no })); described = true; }
      if (cooking > 0) { blockers.push(t(cooking === 1 ? 'tables.block.unservedOne' : 'tables.block.unserved', { n: cooking, r: o.round_no })); described = true; }
    }
    if (!described) blockers.push(t('tables.block.unservedAny', { n: bill.unresolved.unserved_lines }));
  }
  if (codes.has('bill_not_finalized')) {
    if (bill.revision_stale) blockers.push(t('tables.block.stale'));
    else if (bill.visit_status === 'open') blockers.push(t('tables.block.notStarted'));
    else blockers.push(t('tables.block.notFinalised'));
  }
  if (codes.has('unpaid_bill')) {
    const due = bill.current_revision && !bill.revision_stale ? bill.current_revision.total_minor : bill.running_total_minor ?? bill.total_minor;
    blockers.push(t('tables.block.unpaid', { amount: money(due) }));
  }
  if (codes.has('open_requests')) {
    const n = bill.unresolved.open_requests;
    notices.push(t(n === 1 ? 'tables.notice.requestsOne' : 'tables.notice.requests', { n }));
  }
  if (codes.has('open_portions')) {
    const n = bill.unresolved.open_portion_requests;
    notices.push(t(n === 1 ? 'tables.notice.portionsOne' : 'tables.notice.portions', { n }));
  }
  return { blockers, notices };
}

interface Props {
  detail: VisitDetailDTO;
  ctl: BillController;
  onCompleted: (result: CheckoutResultDTO) => void;
  refresh: () => void;
}

export default function CheckoutDock({ detail, ctl, onCompleted, refresh }: Props) {
  const { t } = useI18n();
  const blockId = useId();
  const [dialog, setDialog] = useState<'complete' | 'exception' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(() => pendingKey(`checkout.${detail.id}`).pending());
  // Phones: the list folds away so the sheet keeps room for the table itself.
  const compact = useMedia('(max-width: 767px)');
  const { bill, can, next } = ctl;
  const label = detail.table.label;
  const closed = detail.status === 'closed';

  // An earlier attempt whose answer was lost: the visit closed after all.
  useEffect(() => {
    if (closed && lost) { pendingKey(`checkout.${detail.id}`).clear(); setLost(false); }
  }, [closed, lost, detail.id]);

  const words = useMemo(() => (bill ? checkoutWords(t, bill, detail) : { blockers: [], notices: [] }), [bill, detail, t]);

  if (closed || !bill) return null;

  const ready = bill.can_checkout;
  const mayComplete = can('checkout.complete');
  const mayOverride = mayComplete && can('visits.close_exception') && !ready && bill.visit_status === 'billing';

  const run = async (exceptionReason?: string) => {
    const k = pendingKey(`checkout.${detail.id}`);
    try {
      const result = await api.post<CheckoutResultDTO>(`/api/staff/visits/${encodeURIComponent(detail.id)}/checkout`, {
        idempotency_key: k.key(),
        exception_reason: exceptionReason ?? null,
      });
      k.clear();
      setLost(false);
      setDialog(null);
      onCompleted(result);
    } catch (err) {
      if (isAmbiguous(err)) {
        setLost(true);
        setError(t('tables.checkout.ambiguous'));
        return;
      }
      k.clear();
      setLost(false);
      if (isApiError(err, 'unresolved_orders', 'bill_not_finalized', 'unpaid_bill', 'invalid_transition', 'stale_version', 'conflict')) {
        await ctl.refresh();
        refresh();
        setError(isApiError(err, 'invalid_transition') ? t('tables.checkout.startFirst') : isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : t('tables.checkout.stillBlocked'));
        return;
      }
      if (isApiError(err, 'forbidden')) { setError(t('tables.checkout.forbidden')); return; }
      if (isApiError(err, 'idempotency_mismatch')) { setError(t('tables.checkout.retry')); return; }
      setError(errorText(t, err));
    }
  };

  const nextButton = next ? (
    <Button
      variant={ready ? 'outline' : 'primary'}
      size="staff"
      icon="receipt"
      opensDialog
      aria-disabled={next.blockedBy ? true : undefined}
      aria-describedby={next.blockedBy ? `${blockId}-next` : undefined}
      onClick={() => { if (!next.blockedBy) ctl.open(next.step); }}
    >
      {next.label}
    </Button>
  ) : null;

  return (
    <div className="c5-dock">
      {lost ? <p className="c5-callout c5-callout--heat" role="status">{t('tables.checkout.lost')}</p> : null}
      {compact && (words.blockers.length > 0 || words.notices.length > 0) ? (
        <details className="c5-dock__fold">
          <summary>
            {words.blockers.length > 0
              ? t('tables.checkout.foldBlocked', { n: words.blockers.length })
              : t('tables.checkout.foldNotices', { n: words.notices.length })}
          </summary>
          {words.blockers.length > 0 ? <CheckoutBlockers id={blockId} items={words.blockers} /> : null}
          {words.notices.length > 0 ? (
            <ul className="c5-notices" aria-label={t('tables.checkout.noticesLabel')}>
              {words.notices.map((n) => <li key={n}>{n}</li>)}
            </ul>
          ) : null}
        </details>
      ) : (
        <>
          {words.blockers.length > 0 ? <CheckoutBlockers id={blockId} items={words.blockers} /> : null}
          {words.notices.length > 0 ? (
            <ul className="c5-notices" aria-label={t('tables.checkout.noticesLabel')}>
              {words.notices.map((n) => <li key={n}>{n}</li>)}
            </ul>
          ) : null}
        </>
      )}
      {next?.blockedBy ? <p className="c5-note" id={`${blockId}-next`}>{next.blockedBy}</p> : null}
      <div className="drawer__actions c5-dock__actions">
        {nextButton}
        {mayComplete ? (
          <Button
            variant="primary"
            size="staff"
            opensDialog
            aria-disabled={!ready || undefined}
            aria-describedby={!ready && words.blockers.length > 0 ? blockId : undefined}
            onClick={() => { if (ready) { setError(null); setDialog('complete'); } }}
          >
            {t('common.tile.checkout')}
          </Button>
        ) : (
          <p className="c5-note c5-dock__who">{t('tables.checkout.cashierOnly')}</p>
        )}
      </div>
      {mayOverride ? (
        <Button variant="quiet" size="staff" className="c5-dock__exception" opensDialog onClick={() => { setError(null); setDialog('exception'); }}>
          {t('tables.checkout.exception')}
        </Button>
      ) : null}

      <Dialog
        open={dialog === 'complete'}
        onClose={() => setDialog(null)}
        density="staff"
        title={t('tables.checkout.title', { table: label })}
        confirmLabel={t('common.tile.checkout')}
        onConfirm={() => run()}
        error={error}
      >
        <p>{t('tables.checkout.body')}</p>
        {words.notices.map((n) => <p key={n} className="c5-note">{n}</p>)}
      </Dialog>

      <Dialog
        open={dialog === 'exception'}
        onClose={() => setDialog(null)}
        density="staff"
        tone="danger"
        title={t('tables.checkout.exceptionTitle', { table: label })}
        confirmLabel={t('tables.checkout.exceptionConfirm')}
        onConfirm={(reason) => (reason ? run(reason) : undefined)}
        error={error}
        reason={{ label: t('billing.reason'), required: true, limit: 200, placeholder: t('tables.checkout.exceptionPlaceholder') }}
      >
        <p>{t('tables.checkout.exceptionBody')}</p>
        {words.blockers.length > 0 ? (
          <ul className="c5-list">
            {words.blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        ) : null}
        <p className="c5-note">{t('tables.checkout.exceptionAudit')}</p>
      </Dialog>
    </div>
  );
}
