// Manager bill adjustment (discount, comp, correction) with a required reason.
// Only while the bill is not finalised; the server re-checks everything.
import { useMemo, useRef, useState } from 'react';
import type { StaffBillDTO } from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, SegmentedControl, Select, Sheet, TextArea, TextField } from '../../ui/index.ts';
import { dishName, errorText, isAmbiguous, isApiError, parseBaht, pendingKey } from '../tables/shared.ts';

type Kind = 'discount' | 'comp' | 'correction';
type Direction = 'off' | 'on';

interface Props {
  bill: StaffBillDTO;
  onClose: () => void;
  onSaved: (next: StaffBillDTO) => void | Promise<void>;
  onStale: () => void | Promise<void>;
}

export default function AdjustmentDialog({ bill, onClose, onSaved, onStale }: Props) {
  const { t, pick } = useI18n();
  const [kind, setKind] = useState<Kind>('discount');
  const [direction, setDirection] = useState<Direction>('off');
  const [lineId, setLineId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // The bill these numbers come from (D-S8-01). A change from another device
  // is shown once and has to be seen before the adjustment is applied to it.
  const [seen, setSeen] = useState(bill.bill_version);
  const stale = bill.bill_version !== seen;

  const lineOptions = useMemo(() => bill.lines.map((l) => ({
    value: l.line_id,
    label: `${l.quantity} × ${dishName(pick, l.name, [l.variant_name ? pick(l.variant_name).text : null, l.measured_grams ? `${l.measured_grams} g` : null]).text} · ${money(l.line_total_minor)}`,
  })), [bill.lines, pick]);

  const base = bill.subtotal_minor + bill.adjustments_minor;
  const typed = parseBaht(amount);
  const signed = typed === null ? null : (kind === 'correction' && direction === 'on' ? typed : -typed);
  const after = signed === null ? null : base + signed;

  const pickLine = (id: string) => {
    setLineId(id);
    const line = bill.lines.find((l) => l.line_id === id);
    if (line && kind === 'comp') setAmount(String(line.line_total_minor / 100));
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    let bad = false;
    if (typed === null || typed === 0) { setAmountError(t('billing.adjust.amountNeeded')); bad = true; } else setAmountError(null);
    if (reason.trim().length < 3) { setReasonError(t('billing.adjust.reasonNeeded')); bad = true; } else setReasonError(null);
    if (bad) {
      if (typed === null || typed === 0) amountRef.current?.focus(); else reasonRef.current?.focus();
      return;
    }
    if (after !== null && after < 0) { setAmountError(t('billing.adjust.tooMuch', { amount: money(base) })); amountRef.current?.focus(); return; }
    // The bill moved on while this dialog was open: show the new total first.
    if (stale) { setSeen(bill.bill_version); setError(t('billing.adjust.recheck', { total: money(base) })); return; }
    // Kept until the server gives a definitive answer, so a retry after a lost
    // answer replays the same attempt instead of discounting twice.
    const k = pendingKey(`adjust.${bill.visit_id}`);
    setBusy(true);
    try {
      const next = await api.post<StaffBillDTO>(`/api/staff/visits/${encodeURIComponent(bill.visit_id)}/adjustments`, {
        kind,
        amount_minor: signed,
        reason: reason.trim(),
        order_line_id: lineId || null,
        idempotency_key: k.key(),
        bill_version: seen,
      });
      k.clear();
      setBusy(false);
      await onSaved(next);
    } catch (err) {
      setBusy(false);
      if (isAmbiguous(err)) { setError(t('billing.error.ambiguous')); return; }
      k.clear();
      if (isApiError(err, 'validation_failed')) {
        const d = (err.details ?? {}) as { max_reduction_minor?: number };
        if (d.max_reduction_minor !== undefined) { setAmountError(t('billing.adjust.tooMuch', { amount: money(d.max_reduction_minor) })); return; }
      }
      if (isApiError(err, 'stale_version')) {
        const current = (err.details as { current?: StaffBillDTO } | null)?.current;
        if (current) setSeen(current.bill_version);
        await onStale();
        setError(t('billing.adjust.recheck', { total: money(current ? current.subtotal_minor + current.adjustments_minor : base) }));
        return;
      }
      if (isApiError(err, 'idempotency_mismatch')) {
        await onStale();
        setError(t('billing.adjust.alreadyRecorded'));
        return;
      }
      if (isApiError(err, 'bill_changed', 'already_settled')) {
        await onStale();
        setError(t('billing.adjust.finalised'));
        return;
      }
      if (isApiError(err, 'invalid_transition')) {
        await onStale();
        setError(t('billing.adjust.lineGone'));
        return;
      }
      setError(errorText(t, err));
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={t('billing.adjust.title', { table: bill.table_label })}
      dismissible={!busy}
      footerAlign="end"
      bodyClassName="c5-adjust"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={busy} onClick={() => void submit()}>
            {signed !== null && signed !== 0 ? t('billing.adjust.confirmAmount', { amount: money(signed, { sign: true }) }) : t('billing.adjust.confirm')}
          </Button>
        </>
      )}
    >
      <p className="sheet__lede">{t('billing.adjust.lede')}</p>
      <SegmentedControl<Kind>
        size="staff"
        block
        className="c5-block"
        label={t('billing.adjust.kind')}
        value={kind}
        onChange={(v) => { setKind(v); if (v !== 'correction') setDirection('off'); }}
        options={[
          { value: 'discount', label: t('billing.adjust.kind.discount') },
          { value: 'comp', label: t('billing.adjust.kind.comp') },
          { value: 'correction', label: t('billing.adjust.kind.correction') },
        ]}
      />
      <p className="c5-note c5-block--tight">{t(`billing.adjust.kindHelp.${kind}`)}</p>

      {kind === 'correction' ? (
        <SegmentedControl<Direction>
          size="staff"
          block
          className="c5-block"
          label={t('billing.adjust.direction')}
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'off', label: t('billing.adjust.takeOff') },
            { value: 'on', label: t('billing.adjust.addOn') },
          ]}
        />
      ) : null}

      {lineOptions.length > 0 ? (
        <Select
          className="c5-block"
          density="staff"
          label={t('billing.adjust.line')}
          optional
          value={lineId}
          onChange={(e) => pickLine(e.target.value)}
          options={[{ value: '', label: t('billing.adjust.wholeBill') }, ...lineOptions]}
        />
      ) : null}

      <TextField
        ref={amountRef}
        className="c5-block"
        density="staff"
        label={kind === 'correction' && direction === 'on' ? t('billing.adjust.amountOn') : t('billing.adjust.amountOff')}
        inputMode="decimal"
        autoComplete="off"
        prefix="฿"
        value={amount}
        onChange={(e) => { setAmount(e.target.value); setAmountError(null); }}
        error={amountError ?? undefined}
      />

      <TextArea
        ref={reasonRef}
        className="c5-block"
        density="staff"
        label={t('billing.reason')}
        value={reason}
        onChange={(v) => { setReason(v); if (v.trim().length >= 3) setReasonError(null); }}
        limit={200}
        required
        placeholder={t('billing.adjust.reasonPlaceholder')}
        error={reasonError ?? undefined}
      />

      {stale ? (
        <p className="c5-callout c5-callout--heat c5-block" role="status">{t('billing.adjust.changedHere', { total: money(base) })}</p>
      ) : null}

      <p className="c5-kvline c5-block" aria-live="polite">
        <span>{bill.charges.length > 0 ? t('billing.adjust.beforeCharges') : t('billing.adjust.newTotal')}</span>
        <b className="num">
          {money(base)}
          {after !== null && after !== base ? <> → {money(Math.max(0, after))}</> : null}
        </b>
      </p>
      {error ? <p className="field__error c5-block" role="alert">{error}</p> : null}
    </Sheet>
  );
}
