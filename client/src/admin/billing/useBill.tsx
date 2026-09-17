// Bill controller (C5): one place that loads a visit's staff bill, works out
// the next billing step for this role, and owns every billing dialog.
// BillPanel uses it on its own; the table drawer shares one instance with its
// checkout dock so the next step can sit beside Complete checkout.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PaymentDTO, StaffBillDTO } from '../../../../shared/dto.ts';
import type { Permission } from '../../../../shared/permissions.ts';
import { api } from '../../lib/api.ts';
import type { Resource } from '../../lib/live.tsx';
import { money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Dialog, useToast } from '../../ui/index.ts';
import {
  BILL_TOPICS, dishName, errorText, isAmbiguous, isApiError, pendingKey, tn, useLiveResource, useStaff,
} from '../tables/shared.ts';
import PaymentDialog from './PaymentDialog.tsx';
import AdjustmentDialog from './AdjustmentDialog.tsx';

export type BillStep = 'start' | 'finalize' | 'pay';
type DialogKind = BillStep | 'reopen' | 'adjust' | 'reverse';

export interface NextBillStep {
  step: BillStep;
  label: string;
  /** Why the step cannot run yet (the button stays focusable and says so). */
  blockedBy?: string;
}

export interface BillController {
  visitId: string;
  res: Resource<StaffBillDTO>;
  bill: StaffBillDTO | undefined;
  next: NextBillStep | null;
  open: (kind: DialogKind, payment?: PaymentDTO) => void;
  can: (p: Permission) => boolean;
  /** Every billing dialog; render once. */
  dialogs: ReactNode;
  refresh: () => Promise<void>;
}

export function billHasContent(b: StaffBillDTO): boolean {
  return b.lines.length > 0 || b.pending_lines.length > 0 || (b.current_revision?.adjustments.length ?? 0) > 0 || b.adjustments_minor !== 0;
}

export function nextBillStep(b: StaffBillDTO | undefined, can: (p: Permission) => boolean, t: (k: string, v?: Record<string, string | number>) => string): NextBillStep | null {
  if (!b || b.checkout_complete || b.visit_status === 'closed') return null;
  if (b.visit_status === 'open') {
    if (!billHasContent(b) || !can('billing.start')) return null;
    return { step: 'start', label: t('billing.action.start') };
  }
  const rev = b.current_revision;
  if (!rev || b.revision_stale) {
    if (!billHasContent(b) || !can('billing.finalize')) return null;
    const pending = b.pending_lines.reduce((n, l) => n + l.quantity, 0);
    return {
      step: 'finalize',
      label: t('billing.action.finalize'),
      blockedBy: pending > 0 ? tn(t, 'billing.finalize.pendingFirst', pending) : undefined,
    };
  }
  if (rev.status === 'payable' && rev.total_minor > 0 && can('payments.confirm')) {
    return { step: 'pay', label: t('billing.action.pay') };
  }
  return null;
}

interface Options {
  /** Called after any successful billing change (the drawer refreshes its visit). */
  onChange?: () => void;
  /** false: load nothing (another controller is in use). */
  enabled?: boolean;
}

export function useBillController(visitId: string, opts: Options = {}): BillController {
  const { t, pick } = useI18n();
  const toast = useToast();
  const { can } = useStaff();
  const enabled = opts.enabled !== false && can('billing.view');
  const res = useLiveResource<StaffBillDTO>(enabled ? `/api/staff/visits/${encodeURIComponent(visitId)}/bill` : null, BILL_TOPICS, visitId);
  const bill = res.data;
  const billRef = useRef(bill);
  billRef.current = bill;
  const [dialog, setDialog] = useState<{ kind: DialogKind; payment?: PaymentDTO } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onChange = opts.onChange;

  const label = bill?.table_label ?? '';
  const open = useCallback((kind: DialogKind, payment?: PaymentDTO) => {
    setError(null);
    setDialog({ kind, payment });
  }, []);
  const close = useCallback(() => { setDialog(null); setError(null); }, []);

  const changed = useCallback(async (next?: StaffBillDTO) => {
    if (next) res.mutate(next);
    else await res.refresh();
    onChange?.();
  }, [res, onChange]);

  const fail = useCallback(async (err: unknown, extra?: string) => {
    if (isApiError(err, 'stale_version', 'bill_changed', 'already_settled', 'conflict', 'invalid_transition')) {
      await res.refresh();
      onChange?.();
    }
    setError(extra ?? errorText(t, err));
  }, [res, onChange, t]);

  const base = `/api/staff/visits/${encodeURIComponent(visitId)}`;

  // ---------------------------------------------------------------- start checkout
  const start = async () => {
    const b = billRef.current;
    if (!b) return;
    try {
      const next = await api.post<StaffBillDTO>(`${base}/billing/start`, { version: b.visit_version });
      await changed(next);
      close();
      toast.show(t('billing.toast.started', { table: label }));
    } catch (err) {
      await fail(err, isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : undefined);
    }
  };

  // ---------------------------------------------------------------- finalise
  const finalize = async () => {
    const b = billRef.current;
    if (!b) return;
    const expected = b.running_total_minor ?? b.total_minor;
    try {
      const next = await api.post<StaffBillDTO>(`${base}/bill/finalize`, { bill_version: b.bill_version, expected_total_minor: expected });
      await changed(next);
      close();
      toast.show(t('billing.toast.finalized', { table: label, total: money(next.total_minor) }));
    } catch (err) {
      if (isApiError(err, 'bill_changed')) {
        const d = (err.details ?? {}) as { expected_total_minor?: number; total_minor?: number };
        await fail(err, d.total_minor !== undefined
          ? t('billing.finalize.totalChanged', { from: money(d.expected_total_minor ?? expected), to: money(d.total_minor) })
          : t('billing.error.changedElsewhere'));
        return;
      }
      if (isApiError(err, 'unresolved_orders')) {
        const d = (err.details ?? {}) as { lines?: StaffBillDTO['pending_lines'] };
        const names = (d.lines ?? []).map((l) => `${l.quantity} × ${dishName(pick, l.name).text}`).join(', ');
        await res.refresh();
        setError(names ? t('billing.finalize.waitingItems', { items: names }) : errorText(t, err));
        return;
      }
      await fail(err, isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : undefined);
    }
  };

  // ---------------------------------------------------------------- reopen
  const reopen = async (reason?: string) => {
    const b = billRef.current;
    if (!b || !reason) return;
    try {
      const next = await api.post<StaffBillDTO>(`${base}/billing/reopen`, { version: b.visit_version, reason });
      await changed(next);
      close();
      toast.show(t('billing.toast.reopened', { table: label }));
    } catch (err) {
      await fail(err, isApiError(err, 'already_settled') ? t('billing.reopen.paidFirst') : isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : undefined);
    }
  };

  // ---------------------------------------------------------------- reverse a payment
  const reverse = async (reason?: string) => {
    const p = dialog?.payment;
    if (!p || !reason) return;
    const k = pendingKey(`reverse.${p.id}`);
    try {
      const next = await api.post<StaffBillDTO>(`/api/staff/payments/${encodeURIComponent(p.id)}/reverse`, { reason, idempotency_key: k.key() });
      k.clear();
      await changed(next);
      close();
      toast.show(t('billing.toast.reversed', { amount: money(p.amount_minor) }));
    } catch (err) {
      if (isApiError(err, 'idempotency_mismatch')) k.clear();
      if (isAmbiguous(err)) { setError(t('billing.error.ambiguous')); return; }
      if (!isAmbiguous(err)) k.clear();
      await fail(err);
    }
  };

  const next = useMemo(() => nextBillStep(bill, can, t), [bill, can, t]);

  const kind = dialog?.kind;
  const rev = bill?.current_revision ?? null;
  const itemCount = bill ? bill.lines.reduce((n, l) => n + l.quantity, 0) : 0;
  const finalizeTotal = bill ? bill.running_total_minor ?? bill.total_minor : 0;
  const pendingCount = bill ? bill.pending_lines.reduce((n, l) => n + l.quantity, 0) : 0;
  const payment = dialog?.payment;

  const dialogs = (
    <>
      <Dialog
        open={kind === 'start'}
        onClose={close}
        density="staff"
        title={t('billing.start.title', { table: label })}
        confirmLabel={t('billing.start.confirm')}
        onConfirm={start}
        error={error}
      >
        <p>{t('billing.start.body')}</p>
        <p className="c5-note">{t('billing.start.reopenNote')}</p>
      </Dialog>

      <Dialog
        open={kind === 'finalize'}
        onClose={close}
        density="staff"
        title={t('billing.finalize.title', { table: label })}
        confirmLabel={t('billing.finalize.confirm', { total: money(finalizeTotal) })}
        onConfirm={finalize}
        error={error ?? (pendingCount > 0 ? tn(t, 'billing.finalize.pendingFirst', pendingCount) : null)}
      >
        <p className="c5-dialog-total">
          <span>{t('billing.finalize.summary', { n: itemCount })}</span>
          <b className="num">{money(finalizeTotal)}</b>
        </p>
        <p>{t('billing.finalize.body')}</p>
      </Dialog>

      <Dialog
        open={kind === 'reopen'}
        onClose={close}
        density="staff"
        tone="danger"
        title={t('billing.reopen.title', { table: label })}
        confirmLabel={t('billing.reopen.confirm')}
        onConfirm={reopen}
        error={error}
        reason={{ label: t('billing.reason'), required: true, limit: 200, placeholder: t('billing.reopen.placeholder') }}
      >
        <p>
          {rev && rev.status === 'payable'
            ? t('billing.reopen.bodyRevision', { n: rev.revision_no, total: money(rev.total_minor) })
            : t('billing.reopen.bodyOpen')}
        </p>
        <p className="c5-note">{t('billing.reopen.after')}</p>
      </Dialog>

      <Dialog
        open={kind === 'reverse' && Boolean(payment)}
        onClose={close}
        density="staff"
        tone="danger"
        title={payment ? t('billing.reverse.title', { amount: money(payment.amount_minor), method: pick(payment.method_label).text }) : ''}
        confirmLabel={t('billing.reverse.confirm')}
        onConfirm={reverse}
        error={error}
        reason={{ label: t('billing.reason'), required: true, limit: 200, placeholder: t('billing.reverse.placeholder') }}
      >
        <p>{t('billing.reverse.body')}</p>
        <p className="c5-note">
          {bill?.visit_status === 'closed' ? t('billing.reverse.closedNote') : t('billing.reverse.openNote')}
        </p>
      </Dialog>

      {kind === 'pay' && bill ? (
        <PaymentDialog bill={bill} onClose={close} onRecorded={async (next) => { await changed(next); close(); }} onStale={async () => { await res.refresh(); onChange?.(); }} />
      ) : null}
      {kind === 'adjust' && bill ? (
        <AdjustmentDialog bill={bill} onClose={close} onSaved={async (next) => { await changed(next); close(); }} onStale={async () => { await res.refresh(); onChange?.(); }} />
      ) : null}
    </>
  );

  return { visitId, res, bill, next, open, can, dialogs, refresh: res.refresh };
}

export function paymentStatusKey(p: PaymentDTO): string {
  if (p.kind === 'reversal') return 'billing.payment.kind.reversal';
  if (p.kind === 'refund_record') return 'billing.payment.kind.refund_record';
  return `billing.payment.status.${p.status}`;
}

/** When the current revision was paid (the confirmed settlement), if it was. */
export function paidAt(b: StaffBillDTO | undefined): string | null {
  if (!b || !b.paid) return null;
  const rev = b.current_revision?.id;
  const p = b.payments.find((x) => x.kind === 'settlement' && x.status === 'confirmed' && (!rev || x.bill_revision_id === rev));
  return p?.confirmed_at ?? null;
}

export type BillTone = 'ok' | 'neutral' | 'alert' | 'heat' | 'line' | 'ink';

/** One pill for where the bill stands: never colour alone (icon + words). */
export function billState(b: StaffBillDTO, t: (k: string, v?: Record<string, string | number>) => string, clockOf: (iso: string) => string): { tone: BillTone; icon: 'check-c' | 'check' | 'receipt' | 'alert' | 'bell' | 'info'; text: string } {
  if (b.checkout_complete || b.visit_status === 'closed') return { tone: 'ok', icon: 'check-c', text: t('billing.state.complete') };
  if (b.paid) {
    const at = paidAt(b);
    return { tone: 'ok', icon: 'check', text: at ? t('billing.state.paidAt', { time: clockOf(at) }) : t('billing.state.paid') };
  }
  if (b.current_revision?.status === 'payable') {
    if (b.revision_stale) return { tone: 'heat', icon: 'alert', text: t('billing.state.stale') };
    return { tone: 'neutral', icon: 'receipt', text: t('billing.state.finalised', { n: b.current_revision.revision_no }) };
  }
  if (b.visit_status === 'billing') return { tone: 'heat', icon: 'receipt', text: t('billing.state.preparing') };
  if (b.bill_requested_at) return { tone: 'heat', icon: 'bell', text: t('billing.state.requested', { time: clockOf(b.bill_requested_at) }) };
  return { tone: 'line', icon: 'info', text: t('billing.state.open') };
}
