// The ⋯ details panel of a round: per-dish selection for partial steps,
// reject / cancel / correct with a reason, Finish order with explicit
// resolutions, and the round's history. Confirmations replace the panel's
// body and footer (DESIGN §10.7: sheets never stack).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OrderLineDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import { isActive, type LineStatus } from '../../../../../shared/status.ts';
import { clock } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import {
  AllergyBand, Button, Checkbox, Chip, Drawer, DrawerSection, HistoryList, Icon, LineStatusPill, SegmentedControl,
  StatusPill, TableBox, TextArea, type HistoryItem,
} from '../../../ui/index.ts';
import { staffName, sumQty, tn } from '../support.ts';
import type { ActionOutcome, BusyKind, Resolution } from './actions.ts';
import { cancelPermission, lastStep, planSelection, tableOf, unresolvedLines } from './model.ts';

type Step =
  | { kind: 'lines' }
  | { kind: 'confirm'; action: 'reject' | 'cancel' | 'correct'; to: LineStatus; lineIds: string[] }
  | { kind: 'finish' };

export interface OrderDetailsProps {
  order: StaffOrderDTO;
  can: (p: Permission) => boolean;
  busy: BusyKind | null;
  conflict: { by: string; at: string } | null;
  onReview: () => void;
  onClose: () => void;
  onTransition: (order: StaffOrderDTO, lines: OrderLineDTO[], to: LineStatus, opts: { reason?: string; kind?: BusyKind; silent?: boolean }) => Promise<ActionOutcome>;
  onFinish: (order: StaffOrderDTO, resolutions: Resolution[]) => Promise<ActionOutcome>;
  /** Open straight at the Finish order step. */
  startAt?: 'finish';
}

const MIN_REASON = 3;

/** Staff words for the derived order state (the kit pill defaults to the guest's). */
const ORDER_WORD: Record<StaffOrderDTO['status'], string> = {
  received: 'common.staff.status.submitted',
  confirmed: 'common.staff.status.accepted',
  preparing: 'common.staff.status.preparing',
  almost_done: 'common.staff.status.almost_done',
  ready: 'common.staff.status.ready',
  partially_served: 'orders.state.partial',
  served: 'common.staff.status.served',
  rejected: 'common.staff.status.rejected',
  cancelled: 'common.staff.status.cancelled',
};
const REASON_MAX = 200;

const FORWARD_LABEL: Partial<Record<LineStatus, string>> = {
  accepted: 'orders.act.accept',
  preparing: 'orders.act.start',
  almost_done: 'orders.act.almost',
  ready: 'orders.act.ready',
  served: 'orders.act.serve',
};

function sourceLine(o: StaffOrderDTO, t: (k: string, v?: Record<string, string | number>) => string): string {
  const sent = t('common.ticket.sent', { time: clock(o.submitted_at) });
  if (o.source === 'manual_recovery') return `${sent} · ${t('orders.source.paper', { ref: o.manual_reference ?? '' })}${o.staff_name ? ` · ${o.staff_name}` : ''}`;
  if (o.source === 'staff') return `${sent} · ${t('orders.source.staff', { name: o.staff_name ?? '' })}`;
  if (o.source === 'portion_quote') return `${sent} · ${o.staff_name ? t('orders.source.portionInPerson', { name: o.staff_name }) : t('orders.source.portion')}`;
  return o.guest_label ? `${sent} · ${o.guest_label}` : sent;
}

export function OrderDetails({ order, can, busy, conflict, onReview, onClose, onTransition, onFinish, startAt }: OrderDetailsProps) {
  const { t, pick, lang, has } = useI18n();
  const [step, setStep] = useState<Step>(startAt === 'finish' ? { kind: 'finish' } : { kind: 'lines' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Drop selections of dishes that finished elsewhere while the panel was open.
  const selectable = useMemo(() => order.lines.filter((l) => l.status !== 'rejected' && l.status !== 'cancelled'), [order.lines]);
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((id) => selectable.some((l) => l.id === id)));
      return keep.size === s.size ? s : keep;
    });
  }, [selectable]);

  // Move focus to the new step's heading so keyboard and screen reader users follow along.
  useEffect(() => {
    const h = bodyRef.current?.querySelector<HTMLElement>('[data-step-focus]');
    h?.focus();
    setError(null);
  }, [step.kind]);

  const chosen = order.lines.filter((l) => selected.has(l.id));
  const plan = planSelection(chosen);
  const allergy = [...new Set(order.lines.filter((l) => l.allergy_flag && l.note).map((l) => l.note!.trim()))].join(' · ');
  const isBusy = busy !== null;

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const allIds = selectable.filter((l) => l.status !== 'served' || can('orders.correct')).map((l) => l.id);
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const history: HistoryItem[] = useMemo(() => {
    const items: Array<HistoryItem & { at: string }> = [];
    for (const l of order.lines) {
      const n = staffName(l.name);
      for (const [i, s] of l.steps.entries()) {
        const words = s.kind === 'correction'
          ? t('orders.history.corrected', { status: t(`common.staff.status.${s.status}`) })
          : s.kind === 'recovery'
            ? t('orders.history.recovered', { status: t(`common.staff.status.${s.status}`) })
            : t(`common.staff.status.${s.status}`);
        items.push({
          id: `${l.id}-${i}`,
          at: s.at,
          time: clock(s.at),
          event: `${words} · ${l.quantity}× ${n.text}`,
          detail: [s.actor, s.reason].filter(Boolean).join(' · ') || undefined,
        });
      }
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }, [order.lines, t]);

  /** A dish row. `head` is a node, or a function that receives the details (a checkbox puts them in its description). */
  const lineRow = (l: OrderLineDTO, head: ReactNode | ((meta: ReactNode) => ReactNode), after?: ReactNode) => {
    const n = staffName(l.name);
    const last = lastStep(l);
    const variant = l.variant_name ? pick(l.variant_name) : null;
    const mods = l.modifiers.flatMap((g) => g.options.map((o) => pick(o.name)));
    const meta = (
        <span className="odl__meta">
          {n.secondary ? <span className="odl__en" lang="en">{n.secondary}</span> : null}
          {n.noThai ? <span className="odl__en">{t('common.ticket.noThaiName')}</span> : null}
          {variant || mods.length ? (
            <span className="odl__chips">
              {variant ? <Chip lang={variant.lang}>{variant.text}</Chip> : null}
              {mods.map((m, i) => <Chip key={i} lang={m.lang}>{m.text}</Chip>)}
            </span>
          ) : null}
          {l.note ? (
            <span className={`odl__note${l.allergy_flag ? ' is-allergy' : ''}`}>
              <Icon name={l.allergy_flag ? 'alert' : 'note'} size="sm" />
              <span>
                <small lang={lang}>{l.allergy_flag ? t('common.ticket.allergy') : t('common.ticket.guestNote')}</small>
                <span>{l.note}</span>
              </span>
            </span>
          ) : null}
          <span className="odl__status">
            <LineStatusPill status={l.status} time={last ? clock(last.at) : undefined} />
            {last?.actor ? <span className="odl__actor">{last.actor}</span> : null}
            {l.status_reason ? <span className="odl__reason">{t('common.reasonIs', { reason: l.status_reason })}</span> : null}
          </span>
        </span>
    );
    return (
      <li key={l.id} className={`odl__row${l.status === 'served' ? ' is-served' : ''}${!isActive(l.status) ? ' is-void' : ''}`}>
        {typeof head === 'function' ? head(meta) : <>{head}{meta}</>}
        {after}
      </li>
    );
  };

  const dishLabel = (l: OrderLineDTO) => {
    const n = staffName(l.name);
    return (
      <span className="odl__name">
        <b className="odl__q">{l.quantity}×</b>
        <span lang={n.lang}>{n.text}</span>
      </span>
    );
  };

  // ---------------------------------------------------------------- step: lines
  let body: ReactNode;
  let footer: ReactNode;

  if (step.kind === 'lines') {
    const forward = plan.forward[0] ?? null;
    const extra = plan.forward.slice(1);
    const forwardBtn = (f: { to: LineStatus; permission: Permission }, primary: boolean) => {
      const allowed = can(f.permission);
      return (
        <Button
          key={f.to}
          variant={primary ? 'primary' : 'outline'}
          size="staff"
          count={sumQty(chosen)}
          loading={busy === 'panel'}
          aria-disabled={!allowed || isBusy || undefined}
          aria-describedby={!allowed ? 'odl-deny' : undefined}
          onClick={async () => {
            setError(null);
            const out = await onTransition(order, chosen, f.to, { kind: 'panel', silent: true });
            if (out.ok) setSelected(new Set());
            else if (out.message) setError(out.message);
          }}
        >
          {t(FORWARD_LABEL[f.to] ?? 'orders.act.accept')}
        </Button>
      );
    };
    const denied = forward && !can(forward.permission) ? t('orders.denied.generic') : null;

    const exception = (action: 'reject' | 'cancel' | 'correct', spec: { to: LineStatus; permission: Permission } | null, label: string, help: string) => {
      const reasonOff = chosen.length === 0
        ? t('orders.details.pickFirst')
        : !spec
          ? t(`orders.details.not.${action}`)
          : !can(spec.permission)
            ? t(action === 'correct' ? 'orders.denied.correct' : action === 'cancel' && spec.permission === 'orders.cancel_started' ? 'orders.denied.cancelStarted' : 'orders.denied.generic')
            : null;
      const id = `odl-x-${action}`;
      return (
        <div className="odl__x">
          <Button
            variant={action === 'correct' ? 'outline' : 'danger'}
            size="staff"
            opensDialog
            count={chosen.length ? sumQty(chosen) : undefined}
            aria-disabled={Boolean(reasonOff) || isBusy || undefined}
            aria-describedby={id}
            onClick={() => { if (!reasonOff && spec) setStep({ kind: 'confirm', action, to: spec.to, lineIds: chosen.map((l) => l.id) }); }}
          >
            {label}
          </Button>
          <p className="odl__help" id={id}>{reasonOff ?? help}</p>
        </div>
      );
    };

    body = (
      <>
        {conflict ? (
          <div className="ticket__conflict odl__conflict" role="status">
            <Icon name="refresh" size="sm" />
            <span>{t('common.ticket.conflict', { name: conflict.by, time: clock(conflict.at) })}</span>
            <button type="button" className="textlink" onClick={onReview}>{t('common.ticket.review')}</button>
          </div>
        ) : null}
        {allergy ? <AllergyBand text={allergy} className="odl__allergy" /> : null}
        <DrawerSection
          title={t('orders.details.dishes')}
          aside={allIds.length > 1 ? (
            <button type="button" className="textlink odl__all" onClick={() => setSelected(allOn ? new Set() : new Set(allIds))}>
              {allOn ? t('orders.details.selectNone') : t('orders.details.selectAll')}
            </button>
          ) : undefined}
        >
          <p className="odl__lede" data-step-focus tabIndex={-1}>{t('orders.details.pickHelp')}</p>
          <ul className="odl">
            {order.lines.map((l) => lineRow(l, (meta) => (
              <Checkbox
                className="odl__check"
                label={dishLabel(l)}
                description={meta}
                checked={selected.has(l.id)}
                disabled={!isActive(l.status)}
                onChange={(e) => toggle(l.id, e.currentTarget.checked)}
              />
            )))}
          </ul>
        </DrawerSection>
        <DrawerSection title={t('orders.details.exceptions')}>
          <div className="odl__xs">
            {exception('reject', plan.reject, t('orders.x.reject'), t('orders.x.rejectHelp'))}
            {exception('cancel', plan.cancel, t('orders.x.cancel'), t('orders.x.cancelHelp'))}
            {exception('correct', plan.correct, t('orders.x.correct'), plan.correct ? t('orders.x.correctTo', { status: t(`common.staff.status.${plan.correct.to}`) }) : t('orders.x.correctHelp'))}
          </div>
        </DrawerSection>
        <DrawerSection title={t('orders.finish.title')}>
          <div className="odl__x">
            <Button
              variant="outline"
              size="staff"
              icon="check"
              aria-disabled={!can('orders.serve') || Boolean(order.finished_at) || isBusy || undefined}
              aria-describedby="odl-finish-help"
              onClick={() => { if (can('orders.serve') && !order.finished_at) setStep({ kind: 'finish' }); }}
            >
              {t('orders.finish.open')}
            </Button>
            <p className="odl__help" id="odl-finish-help">
              {order.finished_at
                ? t('orders.finish.already', { time: clock(order.finished_at) })
                : !can('orders.serve') ? t('orders.denied.serve') : t('orders.finish.help')}
            </p>
          </div>
        </DrawerSection>
        <DrawerSection title={t('orders.details.history')}>
          <HistoryList items={history} />
        </DrawerSection>
      </>
    );
    footer = (
      <div className="odl__foot">
        <p className="odl__count" aria-live="polite">
          {chosen.length === 0 ? t('orders.details.noneSelected') : tn({ t, has }, 'orders.details.selected', sumQty(chosen))}
          {denied ? <span id="odl-deny"> · {denied}</span> : null}
          {chosen.length > 0 && !forward ? <span> · {t('orders.details.noCommonStep')}</span> : null}
        </p>
        {error ? <p className="field__error" role="alert"><Icon name="alert" /><span>{error}</span></p> : null}
        {forward ? (
          <div className="odl__acts">
            {forwardBtn(forward, true)}
            {extra.map((f) => forwardBtn(f, false))}
          </div>
        ) : null}
      </div>
    );
  } else if (step.kind === 'confirm') {
    body = (
      <ConfirmStep
        key={`${step.action}-${step.lineIds.join()}`}
        order={order}
        step={step}
        busy={isBusy}
        error={error}
        onBack={() => setStep({ kind: 'lines' })}
        onConfirm={async (reason) => {
          const lines = order.lines.filter((l) => step.lineIds.includes(l.id));
          setError(null);
          const out = await onTransition(order, lines, step.to, { reason, kind: 'panel', silent: true });
          if (out.ok) { setSelected(new Set()); setStep({ kind: 'lines' }); }
          else if (out.stale) setStep({ kind: 'lines' });
          else setError(out.message);
        }}
        renderLine={(l) => lineRow(l, <span className="odl__plain">{dishLabel(l)}</span>)}
      />
    );
    footer = null;
  } else {
    body = (
      <FinishStep
        order={order}
        can={can}
        busy={isBusy}
        onBack={() => setStep({ kind: 'lines' })}
        onFinish={async (resolutions) => {
          const out = await onFinish(order, resolutions);
          if (out.ok) onClose();
          else if (out.stale) setStep({ kind: 'lines' });
          return out;
        }}
        renderLine={(l, after) => lineRow(l, <span className="odl__plain">{dishLabel(l)}</span>, after)}
      />
    );
    footer = null;
  }

  return (
    <Drawer
      open
      inline={false}
      onClose={onClose}
      className="odl-drawer"
      lead={<TableBox label={tableOf(order)} />}
      title={<span className="odl-nowrap">{order.reference} · {t('common.ticket.round', { n: order.round_no })}</span>}
      status={<StatusPill kind="order" status={order.status} size="sm" label={t(ORDER_WORD[order.status])} />}
      subtitle={sourceLine(order, t)}
      closeLabel={t('orders.details.close', { table: tableOf(order) })}
      footer={footer ?? undefined}
    >
      <div ref={bodyRef} className="odl-body">{body}</div>
    </Drawer>
  );
}

// ------------------------------------------------------------------ confirm (reject / cancel / correct)

function ConfirmStep({ order, step, busy, error, onBack, onConfirm, renderLine }: {
  order: StaffOrderDTO;
  step: Extract<Step, { kind: 'confirm' }>;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: (reason: string) => Promise<void>;
  renderLine: (l: OrderLineDTO) => ReactNode;
}) {
  const { t, has } = useI18n();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const lines = order.lines.filter((l) => step.lineIds.includes(l.id));
  const n = sumQty(lines);
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    if ([...reason.trim()].length < MIN_REASON) { setMissing(true); ref.current?.focus(); return; }
    await onConfirm(reason.trim());
  };
  const danger = step.action !== 'correct';
  return (
    <div className="odl-confirm" role="group" aria-labelledby="odl-confirm-h">
      <h3 id="odl-confirm-h" className="odl-confirm__h" data-step-focus tabIndex={-1}>
        {tn({ t, has }, `orders.confirm.${step.action}.title`, n, { table: tableOf(order) })}
      </h3>
      <p className="odl-confirm__lede">
        {t(`orders.confirm.${step.action}.body`, { status: t(`common.staff.status.${step.to}`) })}
      </p>
      <ul className="odl">{lines.map(renderLine)}</ul>
      <TextArea
        ref={ref}
        density="staff"
        label={t(step.action === 'correct' ? 'orders.confirm.reasonStaff' : 'orders.confirm.reasonGuest')}
        help={t(step.action === 'correct' ? 'orders.confirm.reasonStaffHelp' : 'orders.confirm.reasonGuestHelp')}
        value={reason}
        onChange={(v) => { setReason(v); if ([...v.trim()].length >= MIN_REASON) setMissing(false); }}
        limit={REASON_MAX}
        required
        error={missing ? t('orders.confirm.reasonShort', { n: MIN_REASON }) : undefined}
      />
      {error ? <p className="field__error" role="alert"><Icon name="alert" /><span>{error}</span></p> : null}
      <div className="odl-confirm__acts">
        <Button variant="outline" size="staff" onClick={onBack} disabled={busy}>{t('orders.confirm.back')}</Button>
        <Button variant={danger ? 'danger-solid' : 'primary'} size="staff" count={n} loading={busy} onClick={() => void submit()}>
          {t(`orders.confirm.${step.action}.go`)}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ finish order

type Choice = 'served' | 'cancel' | '';

function FinishStep({ order, can, busy, onBack, onFinish, renderLine }: {
  order: StaffOrderDTO;
  can: (p: Permission) => boolean;
  busy: boolean;
  onBack: () => void;
  onFinish: (resolutions: Resolution[]) => Promise<ActionOutcome>;
  renderLine: (l: OrderLineDTO, after?: ReactNode) => ReactNode;
}) {
  const { t, has } = useI18n();
  const [serverIds, setServerIds] = useState<string[] | null>(null);
  const open = unresolvedLines(order);
  // The server's list wins when it answered; otherwise what this device sees.
  const pending = serverIds ? order.lines.filter((l) => serverIds.includes(l.id) && isActive(l.status) && l.status !== 'served') : open;
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const cancels = pending.filter((l) => choice[l.id] === 'cancel');
  const undecided = pending.filter((l) => !choice[l.id]);
  const readyLines = pending.filter((l) => l.status === 'ready');
  const served = order.lines.filter((l) => l.status === 'served');

  const submit = async () => {
    setError(null);
    if (undecided.length > 0) { setError(tn({ t, has }, 'orders.finish.decideAll', sumQty(undecided))); return; }
    if (cancels.length > 0 && [...reason.trim()].length < MIN_REASON) { setMissing(true); reasonRef.current?.focus(); return; }
    const resolutions: Resolution[] = pending.map((l) => ({
      line_id: l.id,
      version: l.version,
      action: choice[l.id] === 'served' ? 'served' : 'cancel',
      reason: choice[l.id] === 'cancel' ? reason.trim() : null,
    }));
    const out = await onFinish(resolutions);
    if (!out.ok && out.unresolved) {
      setServerIds(out.unresolved.map((u) => u.id));
      setError(tn({ t, has }, 'orders.finish.serverListed', out.unresolved.reduce((s, u) => s + u.quantity, 0)));
    } else if (!out.ok && out.message) {
      setError(out.message);
    }
  };

  const options = (l: OrderLineDTO) => {
    const canServe = l.status === 'ready';
    const cancelPerm = cancelPermission(l.status);
    const canCancel = can(cancelPerm);
    return [
      { value: 'served' as Choice, label: t('orders.finish.markServed'), disabled: !canServe },
      { value: 'cancel' as Choice, label: t(l.status === 'submitted' ? 'orders.finish.reject' : 'orders.finish.cancel'), disabled: !canCancel },
    ];
  };

  return (
    <div className="odl-confirm" role="group" aria-labelledby="odl-finish-h">
      <h3 id="odl-finish-h" className="odl-confirm__h" data-step-focus tabIndex={-1}>
        {t('orders.finish.confirmTitle', { n: order.round_no, table: tableOf(order) })}
      </h3>
      <p className="odl-confirm__lede">{t('orders.finish.body')}</p>
      {served.length > 0 ? <p className="odl-confirm__note">{tn({ t, has }, 'orders.finish.servedCount', sumQty(served))}</p> : null}

      {pending.length === 0 ? (
        <p className="odl-confirm__note is-ok"><Icon name="check-c" size="sm" /> {t('orders.finish.nothingLeft')}</p>
      ) : (
        <>
          <p className="odl-confirm__warn" role="note">
            <Icon name="alert" size="sm" />
            {tn({ t, has }, 'orders.finish.unresolved', sumQty(pending))}
          </p>
          {readyLines.length > 1 && can('orders.serve') ? (
            <Button variant="outline" size="staff" className="odl-confirm__bulk" onClick={() => setChoice((c) => ({ ...c, ...Object.fromEntries(readyLines.map((l) => [l.id, 'served' as Choice])) }))}>
              {t('orders.finish.allReadyServed', { n: sumQty(readyLines) })}
            </Button>
          ) : null}
          <ul className="odl">
            {pending.map((l) => renderLine(l, (
              <div className="odl__resolve">
                <SegmentedControl<Choice>
                  size="staff"
                  tone="paper"
                  label={t('orders.finish.resolveFor', { name: staffName(l.name).text })}
                  value={choice[l.id] ?? ''}
                  onChange={(v) => { setChoice((c) => ({ ...c, [l.id]: v })); setError(null); }}
                  options={options(l)}
                />
                {l.status !== 'ready' ? <span className="odl__help">{t('orders.finish.notReady')}</span> : null}
              </div>
            )))}
          </ul>
          {cancels.length > 0 ? (
            <TextArea
              ref={reasonRef}
              density="staff"
              label={t('orders.confirm.reasonGuest')}
              help={tn({ t, has }, 'orders.finish.reasonHelp', sumQty(cancels))}
              value={reason}
              onChange={(v) => { setReason(v); if ([...v.trim()].length >= MIN_REASON) setMissing(false); }}
              limit={REASON_MAX}
              required
              error={missing ? t('orders.confirm.reasonShort', { n: MIN_REASON }) : undefined}
            />
          ) : null}
        </>
      )}
      {error ? <p className="field__error" role="alert"><Icon name="alert" /><span>{error}</span></p> : null}
      <div className="odl-confirm__acts">
        <Button variant="outline" size="staff" onClick={onBack} disabled={busy}>{t('orders.confirm.back')}</Button>
        <Button
          variant={cancels.length > 0 ? 'danger-solid' : 'primary'}
          size="staff"
          icon="check"
          loading={busy}
          count={pending.length ? sumQty(pending) : undefined}
          onClick={() => void submit()}
        >
          {pending.length ? t('orders.finish.goResolve') : t('orders.finish.go')}
        </Button>
      </div>
    </div>
  );
}
