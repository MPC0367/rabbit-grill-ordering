// Record a full-bill payment (brief 16, 23). V1: one settlement per payable
// revision, amount locked to the total, cash tendered -> change, optional
// reference, idempotent. Staff record money they have checked; nothing here
// moves money or completes checkout.
//
// The fields and the submit live in `usePaymentSurface` so the same payment can
// be a centred dialog (desktop and tablet) or a step inside the table drawer
// (phones, round-1 finding 31): on a phone a payment is never a second dialog
// stacked over the drawer.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StaffBillDTO } from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { clock, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Price, SegmentedControl, Sheet, TextField, useToast } from '../../ui/index.ts';
import { errorText, isAmbiguous, isApiError, parseBaht, pendingKey } from '../tables/shared.ts';

interface Props {
  bill: StaffBillDTO;
  onClose: () => void;
  onRecorded: (next: StaffBillDTO) => void | Promise<void>;
  /** The bill moved on elsewhere (paid, changed): refresh it. */
  onStale: () => void | Promise<void>;
}

export interface PaymentSurfaceProps extends Omit<Props, 'bill'> {
  /** Undefined while the bill is still loading. */
  bill: StaffBillDTO | undefined;
  /** False: the surface is not showing, so nothing is submitted and no state is kept. */
  active: boolean;
  /** 'cancel' (dialog) or 'none' (a drawer step whose host shows its own back action). */
  dismissAs?: 'cancel' | 'none';
}

export interface PaymentSurface {
  title: string;
  /** The fields; render inside the dialog body or the drawer body. */
  body: ReactNode;
  /** Dismiss + confirm; render in the dialog or drawer foot. */
  footer: ReactNode;
  /** A request is in flight: do not let the surface be dismissed. */
  busy: boolean;
}

/** Friendly cash amounts at or above the total: exact, next 100, next 500, next 1000. */
function quickAmounts(total: number): number[] {
  const up = (step: number) => Math.ceil(total / step) * step;
  const set = new Set<number>([total, up(10_000), up(50_000), up(100_000)]);
  return [...set].filter((v) => v >= total).sort((a, b) => a - b).slice(0, 4);
}

/**
 * One payment surface: the fields, the change arithmetic and the idempotent
 * submit. Returns null when there is nothing to pay (no payable revision, or
 * the surface is not showing).
 */
export function usePaymentSurface({ bill, active, onClose, onRecorded, onStale, dismissAs = 'cancel' }: PaymentSurfaceProps): PaymentSurface | null {
  const { t, pick } = useI18n();
  const toast = useToast();
  const rev = bill?.current_revision;
  const methods = useMemo(() => bill?.payment_methods ?? [], [bill]);
  const firstMethod = methods[0]?.id ?? '';
  const [method, setMethod] = useState(firstMethod);
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenderError, setTenderError] = useState<string | null>(null);
  const tenderRef = useRef<HTMLInputElement>(null);
  const changeId = useId();
  const chosen = methods.find((m) => m.id === method);
  const total = rev?.total_minor ?? 0;
  const tenderedMinor = parseBaht(tendered);
  const change = chosen?.tendered && tenderedMinor !== null ? tenderedMinor - total : null;
  const quick = useMemo(() => quickAmounts(total), [total]);

  // Each OPENING starts clean: unlike a dialog, this surface stays mounted, so
  // it clears itself instead of being unmounted. Only the edge into `active`
  // resets it, never a bill refresh while the cashier is typing.
  const firstRef = useRef(firstMethod);
  firstRef.current = firstMethod;
  useEffect(() => {
    if (!active) return;
    setMethod(firstRef.current);
    setTendered('');
    setReference('');
    setError(null);
    setTenderError(null);
  }, [active]);

  // The revision was settled or replaced elsewhere: this surface no longer applies.
  const payable = rev?.status === 'payable' && !bill?.revision_stale;
  useEffect(() => {
    if (active && !payable && !busy) onClose();
  }, [active, payable, busy, onClose]);

  if (!active || !bill || !rev) return null;
  const methodName = chosen ? pick({ th: chosen.label_th, en: chosen.label_en }).text : '';

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!chosen) { setError(t('billing.pay.noMethod')); return; }
    let tenderedValue: number | null = null;
    if (chosen.tendered && tendered.trim() !== '') {
      if (tenderedMinor === null) { setTenderError(t('billing.pay.badAmount')); tenderRef.current?.focus(); return; }
      if (tenderedMinor < total) { setTenderError(t('billing.pay.short', { amount: money(total - tenderedMinor) })); tenderRef.current?.focus(); return; }
      tenderedValue = tenderedMinor;
    }
    setTenderError(null);
    const k = pendingKey(`pay.${rev.id}`);
    setBusy(true);
    try {
      const next = await api.post<StaffBillDTO>(`/api/staff/visits/${encodeURIComponent(bill.visit_id)}/payments`, {
        revision_id: rev.id,
        method: chosen.id,
        amount_minor: total,
        tendered_minor: tenderedValue,
        reference: reference.trim() || null,
        idempotency_key: k.key(),
      });
      k.clear();
      const changeMinor = tenderedValue !== null ? tenderedValue - total : 0;
      toast.show(changeMinor > 0
        ? t('billing.toast.paidChange', { table: bill.table_label, amount: money(total), method: methodName, change: money(changeMinor) })
        : t('billing.toast.paid', { table: bill.table_label, amount: money(total), method: methodName }));
      setBusy(false);
      await onRecorded(next);
    } catch (err) {
      setBusy(false);
      if (isAmbiguous(err)) {
        setError(t('billing.error.ambiguousPayment'));
        return;
      }
      k.clear();
      if (isApiError(err, 'already_settled', 'idempotency_mismatch')) {
        toast.show({ message: t('billing.pay.otherCashier'), tone: 'info' });
        await onStale();
        onClose();
        return;
      }
      if (isApiError(err, 'bill_changed', 'stale_version')) {
        setError(t('billing.pay.billChanged'));
        await onStale();
        return;
      }
      if (isApiError(err, 'amount_mismatch')) {
        const d = (err.details ?? {}) as { expected_minor?: number };
        setError(t('billing.pay.mismatch', { amount: money(d.expected_minor ?? total) }));
        await onStale();
        return;
      }
      setError(errorText(t, err));
    }
  };

  const body = (
    <>
      <div className="c5-due">
        <p className="c5-due__k">{t('billing.pay.due')}</p>
        <Price minor={total} size="xl" className="c5-due__v" />
        <p className="c5-due__s">
          {t('billing.pay.fullBill', { n: rev.revision_no, time: clock(rev.finalized_at) })}
        </p>
      </div>

      {methods.length > 1 ? (
        <SegmentedControl
          size="staff"
          block
          className="c5-block"
          label={t('billing.pay.method')}
          value={method}
          onChange={(v) => { setMethod(v); setTenderError(null); }}
          options={methods.map((m) => ({ value: m.id, label: pick({ th: m.label_th, en: m.label_en }).text }))}
        />
      ) : chosen ? (
        <p className="c5-kvline c5-block"><span>{t('billing.pay.method')}</span><b>{methodName}</b></p>
      ) : (
        <p className="field__error c5-block" role="alert">{t('billing.pay.noMethod')}</p>
      )}

      {chosen?.tendered ? (
        <div className="c5-block c5-tender">
          <TextField
            ref={tenderRef}
            density="staff"
            label={t('billing.pay.received')}
            optional
            inputMode="decimal"
            autoComplete="off"
            prefix="฿"
            value={tendered}
            placeholder={String(total / 100)}
            onChange={(e) => { setTendered(e.target.value); setTenderError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            error={tenderError ?? undefined}
            help={t('billing.pay.receivedHelp')}
          />
          <div className="c5-quick" role="group" aria-label={t('billing.pay.quick')}>
            {quick.map((v) => (
              <Button key={v} variant="outline" size="staff" onClick={() => { setTendered(String(v / 100)); setTenderError(null); }} aria-pressed={tenderedMinor === v}>
                {v === total ? t('billing.pay.exact') : money(v)}
              </Button>
            ))}
          </div>
          <p className={`c5-change${change !== null && change < 0 ? ' is-short' : ''}`} id={changeId} aria-live="polite">
            <span>{change !== null && change < 0 ? t('billing.pay.shortBy') : t('billing.pay.change')}</span>
            <b className="num">{change === null ? '—' : money(Math.abs(change))}</b>
          </p>
        </div>
      ) : null}

      <TextField
        className="c5-block"
        density="staff"
        label={t('billing.pay.reference')}
        optional
        maxLength={80}
        autoComplete="off"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        help={t('billing.pay.referenceHelp')}
      />

      <p className="c5-note c5-block">{t('billing.pay.honest')}</p>
      {error ? <p className="field__error c5-block" role="alert">{error}</p> : null}
    </>
  );

  const footer = (
    <>
      {dismissAs === 'cancel' ? (
        <Button variant="outline" size="staff" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
      ) : null}
      <Button variant="primary" size="staff" loading={busy} onClick={() => void submit()} aria-describedby={change !== null ? changeId : undefined}>
        {t('billing.pay.confirm', { amount: money(total), method: methodName })}
      </Button>
    </>
  );

  return { title: t('billing.pay.title', { table: bill.table_label }), body, footer, busy };
}

export default function PaymentDialog({ bill, onClose, onRecorded, onStale }: Props) {
  const surface = usePaymentSurface({ bill, active: true, onClose, onRecorded, onStale });
  if (!surface) return null;
  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={surface.title}
      dismissible={!surface.busy}
      footerAlign="end"
      bodyClassName="c5-pay"
      footer={surface.footer}
    >
      {surface.body}
    </Sheet>
  );
}
