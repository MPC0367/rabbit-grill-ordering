// Staff-assisted ordering (brief 22, 44A) and paper-order recovery (brief 22,
// 30) in one drawer: the same catalog, choices and server pricing as guests,
// review, then an honest submission with a persisted attempt key.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogDTO, MenuItemDTO, OrderDTO, PortionRequestDTO, QuoteDTO, SubmitResultDTO, VisitDetailDTO } from '../../../../shared/dto.ts';
import { newIdempotencyKey } from '../../../../shared/ids.ts';
import { api } from '../../lib/api.ts';
import { clock, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import {
  Banner, Button, ChoiceGroup, Drawer, EmptyState, Icon, IconButton, KeyValue, RadioCard, Skeleton, Stepper,
  TableBox, TableStatePill, TextArea, TextField, useAnnounce, useToast,
} from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { CatalogPicker, type PortionAsk } from './assist/CatalogPicker.tsx';
import { sameLine, toInput, unitPrice, useDraft, type DraftLine, type RecoverFields } from './assist/draft.ts';
import {
  bangkokInputToIso, bangkokLocalInput, clearPendingKey, errorText, pendingKey, staffName, sumQty, tn, toApiError,
} from './support.ts';
import './orders.css';

export interface AssistOrderPanelProps {
  visitId: string;
  mode?: 'assist' | 'recover';
  onClose(): void;
  onDone?(reference: string): void;
}

type Step = 'pick' | 'review' | 'done';
type SendState = { state: 'idle' } | { state: 'sending' } | { state: 'ambiguous' } | { state: 'error'; message: string };

const RECOVER_PAST_MS = 24 * 3_600_000;
const RECOVER_FUTURE_MS = 5 * 60_000;

export default function AssistOrderPanel({ visitId, mode = 'assist', onClose, onDone }: AssistOrderPanelProps) {
  const { t, lang, pick, has } = useI18n();
  const { can, me } = useStaff();
  const toast = useToast();
  const announce = useAnnounce();
  const recover = mode === 'recover';
  const allowed = can(recover ? 'orders.recover_manual' : 'orders.assist');

  const visit = useResource<VisitDetailDTO>(allowed && can('tables.view') ? `/api/staff/visits/${visitId}` : null, { topics: ['visit.', 'order.', 'bill.'] });
  const menu = useResource<CatalogDTO>(allowed ? '/api/public/menu' : null, { topics: ['menu.'] });
  const items = useMemo(() => new Map((menu.data?.items ?? []).map((i) => [i.id, i])), [menu.data]);
  const { draft, update, clear } = useDraft(mode, visitId);

  const [step, setStep] = useState<Step>(draft.key ? 'review' : 'pick');
  const [send, setSend] = useState<SendState>(draft.key ? { state: 'ambiguous' } : { state: 'idle' });
  const [quote, setQuote] = useState<QuoteDTO | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [result, setResult] = useState<{ order: OrderDTO; replayed: boolean } | null>(null);
  const [portionState, setPortionState] = useState<Record<string, 'sending' | 'sent'>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof RecoverFields, string>>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const locked = Boolean(draft.key);
  const lines = locked && draft.sentLines ? draft.sentLines : draft.lines;
  const count = sumQty(lines);

  // Default the paper time to "now" (Bangkok) the first time the form shows.
  useEffect(() => {
    if (recover && !draft.recover.time) update((d) => ({ ...d, recover: { ...d.recover, time: bangkokLocalInput(Date.now()) } }));
  }, [recover, draft.recover.time, update]);

  // Server quote for the current lines (same pricing path as guests), debounced.
  const quoteSeq = useRef(0);
  const linesKey = JSON.stringify(lines.map((l) => [l.item_id, l.variant_id, l.quantity, l.modifiers, l.note, l.allergy_note]));
  useEffect(() => {
    if (!allowed || !menu.data) return;
    if (lines.length === 0) { setQuote(null); setQuoteError(null); return; }
    const my = ++quoteSeq.current;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const q = await api.post<QuoteDTO>('/api/staff/orders/quote', { visit_id: visitId, lines: lines.map((l) => toInput(l, items.get(l.item_id))) });
        if (my === quoteSeq.current) { setQuote(q); setQuoteError(null); }
      } catch (err) {
        if (my === quoteSeq.current) setQuoteError(errorText(t, err));
      } finally {
        if (my === quoteSeq.current) setQuoting(false);
      }
    }, 300);
    return () => clearTimeout(timer);
    // linesKey stands for `lines`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, allowed, menu.data, visitId]);

  // Focus the top of the body when the step changes.
  useEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>('[data-step-focus]')?.focus();
  }, [step]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l.item_id, (m.get(l.item_id) ?? 0) + l.quantity);
    return m;
  }, [lines]);

  const addLine = useCallback((line: DraftLine) => {
    update((d) => {
      const hit = d.lines.find((l) => sameLine(l, line));
      const lines2 = hit
        ? d.lines.map((l) => (l === hit ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) } : l))
        : [...d.lines, line];
      return { ...d, lines: lines2 };
    });
    const item = items.get(line.item_id);
    announce(t('assist.added', { n: line.quantity, name: staffName(item?.name).text }));
  }, [update, items, announce, t]);

  const setQty = (uid: string, q: number) => update((d) => ({ ...d, lines: d.lines.map((l) => (l.uid === uid ? { ...l, quantity: q } : l)) }));
  const removeLine = (uid: string) => {
    const line = draft.lines.find((l) => l.uid === uid);
    update((d) => ({ ...d, lines: d.lines.filter((l) => l.uid !== uid) }));
    if (line) announce(t('assist.removed', { name: staffName(items.get(line.item_id)?.name).text }));
  };

  const askPortion = useCallback(async (item: MenuItemDTO, ask: PortionAsk): Promise<boolean> => {
    const scope = `staffportion.${visitId}.${item.id}`;
    const key = pendingKey(scope, newIdempotencyKey);
    setPortionState((s) => ({ ...s, [item.id]: 'sending' }));
    try {
      await api.post<PortionRequestDTO>('/api/staff/portions', {
        visit_id: visitId, item_id: item.id, preferred_grams: ask.preferredGrams, note: ask.note || null, idempotency_key: key,
      });
      clearPendingKey(scope);
      setPortionState((s) => ({ ...s, [item.id]: 'sent' }));
      const words = t('assist.weighToast', { name: staffName(item.name).text, table: visit.data?.table.label ?? '' });
      toast.show({ message: words });
      return true;
    } catch (err) {
      const e = toApiError(err);
      if (!e.ambiguous) clearPendingKey(scope);
      setPortionState((s) => { const n = { ...s }; delete n[item.id]; return n; });
      toast.show({ message: e.ambiguous ? t('assist.weighAmbiguous') : errorText(t, err), tone: 'error' });
      return false;
    }
  }, [visitId, t, toast, visit.data]);

  // ---------------------------------------------------------------- submit
  const recoverChecks = (): { ok: boolean; iso: string | null } => {
    const f = draft.recover;
    const errs: Partial<Record<keyof RecoverFields, string>> = {};
    if (!f.reference.trim()) errs.reference = t('recover.err.reference');
    const iso = bangkokInputToIso(f.time);
    if (!iso) errs.time = t('recover.err.time');
    else {
      const ms = new Date(iso).getTime();
      if (ms > Date.now() + RECOVER_FUTURE_MS) errs.time = t('recover.err.future');
      else if (ms < Date.now() - RECOVER_PAST_MS) errs.time = t('recover.err.past');
    }
    if (!f.already) errs.already = t('recover.err.already');
    if ([...f.reason.trim()].length < 3) errs.reason = t('recover.err.reason');
    setFieldErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) bodyRef.current?.querySelector<HTMLElement>(`[data-field="${first}"] input, [data-field="${first}"] textarea, [data-field="${first}"] legend`)?.focus();
    return { ok: !first, iso };
  };

  const finishOk = (r: SubmitResultDTO) => {
    clear();
    setResult(r);
    setStep('done');
    setSend({ state: 'idle' });
    const words = r.replayed
      ? t(recover ? 'recover.replayed' : 'assist.replayed', { ref: r.order.reference })
      : t(recover ? 'recover.done' : 'assist.done', { ref: r.order.reference, n: r.order.round_no, table: r.order.table_label });
    toast.show({ message: words });
    announce(words);
    onDone?.(r.order.reference);
  };

  const failed = (err: unknown) => {
    const e = toApiError(err);
    if (e.ambiguous) { setSend({ state: 'ambiguous' }); return; }
    // Definitive answer: nothing was created, so the attempt key is free again.
    update((d) => ({ ...d, key: null, sentLines: null, sentSubtotal: null }));
    if (e.code === 'cart_changed') {
      const q = (e.details as { quote?: QuoteDTO } | null)?.quote;
      if (q) setQuote(q);
    }
    const message = e.code === 'idempotency_mismatch' ? t('assist.err.mismatch') : errorText(t, err);
    setSend({ state: 'error', message });
  };

  const submit = async () => {
    if (send.state === 'sending') return;
    if (lines.length === 0) return;
    const inputs = lines.map((l) => toInput(l, items.get(l.item_id)));
    if (recover) {
      const check = recoverChecks();
      if (!check.ok || !check.iso) return;
      const blocking = (quote?.issues ?? []).filter((i) => i.code !== 'sold_out' && i.code !== 'not_orderable');
      if (blocking.length) { setSend({ state: 'error', message: t('assist.err.fixLines') }); return; }
      update((d) => ({ ...d, key: d.key ?? `rec-${d.recover.reference.trim()}`, sentLines: d.sentLines ?? d.lines }));
      setSend({ state: 'sending' });
      try {
        const r = await api.post<SubmitResultDTO>('/api/staff/orders/recover', {
          visit_id: visitId,
          manual_reference: draft.recover.reference.trim(),
          original_time: check.iso,
          lines: inputs,
          already: draft.recover.already,
          reason: draft.recover.reason.trim(),
        }, { timeoutMs: 20_000 });
        finishOk(r);
      } catch (err) {
        failed(err);
      }
      return;
    }
    if (!locked && (!quote || quoting)) { setSend({ state: 'error', message: t('assist.err.quoting') }); return; }
    if (!locked && quote && quote.issues.length > 0) { setSend({ state: 'error', message: t('assist.err.fixLines') }); return; }
    const key = draft.key ?? newIdempotencyKey();
    const expected = draft.sentSubtotal ?? quote?.subtotal_minor ?? 0;
    update((d) => ({ ...d, key, sentLines: d.sentLines ?? d.lines, sentSubtotal: expected }));
    setSend({ state: 'sending' });
    try {
      const r = await api.post<SubmitResultDTO>('/api/staff/orders/assist', {
        visit_id: visitId, idempotency_key: key, lines: inputs, expected_subtotal_minor: expected,
      }, { timeoutMs: 20_000 });
      finishOk(r);
    } catch (err) {
      failed(err);
    }
  };

  const discardAttempt = () => {
    update((d) => ({ ...d, key: null, sentLines: null, sentSubtotal: null }));
    setSend({ state: 'idle' });
  };

  // ---------------------------------------------------------------- header
  const v = visit.data;
  const tableLabel = v?.table.label ?? '';
  const nextRound = v ? Math.max(0, ...v.orders.map((o) => o.round_no)) + 1 : null;
  const title = recover
    ? (tableLabel ? t('recover.titleTable', { table: tableLabel }) : t('recover.title'))
    : (tableLabel ? t('assist.titleTable', { table: tableLabel }) : t('assist.title'));
  const subtitle = recover
    ? t('recover.subtitle', { name: me.user.display_name })
    : nextRound && step !== 'done' ? t('assist.subtitle', { n: nextRound, name: me.user.display_name }) : t('assist.subtitleNoRound', { name: me.user.display_name });

  // ---------------------------------------------------------------- body
  const issuesFor = (i: number) => (quote?.issues ?? []).filter((x) => x.line_index === i);
  const subtotal = quote?.subtotal_minor ?? lines.reduce((s, l) => s + (unitPrice(items.get(l.item_id), l) ?? 0) * l.quantity, 0);
  const showMoney = can('orders.view_bill_values');

  let body;
  let footer;
  if (!allowed) {
    body = (
      <EmptyState icon="lock" title={t('assist.deniedTitle')} headingLevel={3}>
        {recover ? t('recover.denied') : t('assist.denied')}
      </EmptyState>
    );
    footer = <Button variant="outline" size="staff" onClick={onClose}>{t('common.close')}</Button>;
  } else if (step === 'done' && result) {
    body = (
      <div className="ao-done" data-step-focus tabIndex={-1}>
        <span className="ao-done__mark" aria-hidden="true"><Icon name="check" size="lg" bold /></span>
        <h3 className="ao-done__h">
          {result.replayed
            ? t(recover ? 'recover.replayedTitle' : 'assist.replayedTitle')
            : t(recover ? 'recover.doneTitle' : 'assist.doneTitle')}
        </h3>
        <p className="ao-done__ref">
          <span lang="en" className="num">{result.order.reference}</span>
          {' · '}
          {t('common.ticket.round', { n: result.order.round_no })}
          {' · '}
          {t('common.table', { label: result.order.table_label })}
        </p>
        <p className="ao-done__p">
          {recover
            ? t(`recover.doneBody.${(result.order.lines[0]?.status === 'served' ? 'served' : result.order.lines[0]?.status === 'ready' ? 'prepared' : 'none')}`)
            : t('assist.doneBody')}
        </p>
        <ul className="ao-done__lines">
          {result.order.lines.map((l) => {
            const n = staffName(l.name);
            return (
              <li key={l.id}>
                <b className="num">{l.quantity}×</b> <span lang={n.lang}>{n.text}</span>
                {l.variant_name ? <span className="ao-done__v"> · {pick(l.variant_name).text}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
    footer = (
      <div className="ao-foot">
        {!recover ? (
          <Button variant="outline" size="staff" icon="plus" onClick={() => { setResult(null); setStep('pick'); }}>
            {t('assist.another')}
          </Button>
        ) : null}
        <Button variant="primary" size="staff" onClick={onClose}>{t('assist.close')}</Button>
      </div>
    );
  } else if (!menu.data) {
    body = menu.error ? (
      <EmptyState icon="wifi-off" title={t('assist.menuFailed')} headingLevel={3}
        action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void menu.refresh()}>{t('common.retry')}</Button>}
      >
        {errorText(t, menu.error)} {t('orders.board.paperFallback')}
      </EmptyState>
    ) : (
      <div className="ao-skel" role="status" aria-label={t('common.loading')}>
        <Skeleton shape="block" height={48} />
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} shape="block" height={64} />)}
      </div>
    );
    footer = null;
  } else if (step === 'pick') {
    body = (
      <>
        <p className="ao-lede" data-step-focus tabIndex={-1}>{recover ? t('recover.pickLede') : t('assist.pickLede')}</p>
        {locked ? (
          <Banner variant="warning" staff title={t('assist.pendingTitle')}>{t('assist.pendingBody')}</Banner>
        ) : null}
        <CatalogPicker
          catalog={menu.data}
          mode={mode}
          counts={counts}
          onAdd={addLine}
          onPortion={askPortion}
          portionState={portionState}
          locked={locked}
        />
      </>
    );
    footer = (
      <div className="ao-foot">
        <p className="ao-foot__sum" aria-live="polite">
          {count === 0 ? t('assist.empty') : (
            <>
              <b>{tn({ t, has }, 'assist.dishes', count)}</b>
              {showMoney ? <span className="num"> · {money(subtotal)}</span> : null}
            </>
          )}
        </p>
        <Button variant="primary" size="staff" iconEnd="chev-r" aria-disabled={count === 0 || undefined} onClick={() => { if (count > 0) setStep('review'); }}>
          {t('assist.review')}
        </Button>
      </div>
    );
  } else {
    const f = draft.recover;
    const setF = (patch: Partial<RecoverFields>) => {
      update((d) => ({ ...d, recover: { ...d.recover, ...patch } }));
      setFieldErrors((e) => { const n = { ...e }; for (const k of Object.keys(patch)) delete n[k as keyof RecoverFields]; return n; });
    };
    const nowLocal = bangkokLocalInput(Date.now() + RECOVER_FUTURE_MS);
    const minLocal = bangkokLocalInput(Date.now() - RECOVER_PAST_MS);
    body = (
      <>
        <h3 className="ao-h" data-step-focus tabIndex={-1}>{tn({ t, has }, recover ? 'recover.reviewTitle' : 'assist.reviewTitle', count)}</h3>
        {send.state === 'ambiguous' ? (
          <Banner variant="warning" staff title={t('assist.ambiguousTitle')}>
            {t('assist.ambiguousBody')}
          </Banner>
        ) : null}
        {v && v.status !== 'open' && !recover ? (
          <Banner variant="billing" staff title={t('assist.notOpenTitle')}>{t('assist.notOpenBody')}</Banner>
        ) : null}
        <ul className="ao-lines">
          {lines.map((l, i) => {
            const item = items.get(l.item_id);
            const n = staffName(item?.name);
            const qline = quote?.lines.find((x) => x.line_index === i);
            const issues = issuesFor(i);
            const variant = item?.variants.find((x) => x.id === l.variant_id);
            const mods = l.modifiers.flatMap((m) => {
              const g = item?.modifier_groups.find((x) => x.id === m.group_id);
              return m.option_ids.map((id) => g?.options.find((o) => o.id === id)).filter(Boolean).map((o) => pick(o!.name));
            });
            const lineTotal = qline?.line_total_minor ?? ((unitPrice(item, l) ?? 0) * l.quantity);
            return (
              <li key={l.uid} className={`ao-line${issues.length ? ' has-issue' : ''}`}>
                <div className="ao-line__main">
                  <p className="ao-line__name">
                    <span lang={n.lang}>{n.text || t('assist.unknownItem')}</span>
                    {n.secondary ? <span className="ao-line__en" lang="en">{n.secondary}</span> : null}
                    {n.noThai && n.text ? <span className="ao-line__en">{t('common.ticket.noThaiName')}</span> : null}
                  </p>
                  {variant || mods.length ? (
                    <p className="ao-line__chips">
                      {variant ? <span className="chip-mod" lang={pick(variant.name).lang}>{pick(variant.name).text}</span> : null}
                      {mods.map((m, k) => <span key={k} className="chip-mod" lang={m.lang}>{m.text}</span>)}
                    </p>
                  ) : null}
                  {l.note ? (
                    <p className={`ao-line__note${l.allergy_note ? ' is-allergy' : ''}`}>
                      <Icon name={l.allergy_note ? 'alert' : 'note'} size="sm" />
                      <span>{l.allergy_note ? `${t('common.ticket.allergy')}: ` : ''}{l.note}</span>
                    </p>
                  ) : null}
                  {issues.map((x, k) => (
                    <p key={k} className={`ao-line__issue${recover && (x.code === 'sold_out' || x.code === 'not_orderable') ? ' is-info' : ''}`} role="note">
                      <Icon name="alert" size="sm" />
                      <span>
                        {t(`assist.issue.${x.code}`)}
                        {x.current?.line_total_minor !== undefined ? ` · ${t('assist.issue.nowCosts', { amount: money(x.current.line_total_minor) })}` : ''}
                      </span>
                    </p>
                  ))}
                </div>
                <span className="ao-line__total num">{showMoney ? money(lineTotal) : null}</span>
                <div className="ao-line__qty">
                  <Stepper
                    value={l.quantity}
                    min={1}
                    max={item?.max_qty || 99}
                    onChange={(q) => setQty(l.uid, q)}
                    onRemove={() => removeLine(l.uid)}
                    disabled={locked}
                    label={t('common.qtyInOrder', { name: n.text })}
                  />
                  <IconButton icon="x" size="staff" label={t('assist.removeNamed', { name: n.text })} disabled={locked} onClick={() => removeLine(l.uid)} />
                </div>
              </li>
            );
          })}
        </ul>

        {lines.length > 0 ? (
          <KeyValue
            className="ao-sum"
            items={[
              { term: t('assist.subtotal', { n: count }), value: quoting && !quote ? '…' : money(subtotal), strong: true },
              ...(quote?.charges_preview ?? []).filter((c) => c.amount_minor).map((c) => ({
                term: `${lang === 'th' ? c.label_th : c.label_en}${c.inclusive ? ` (${t('assist.included')})` : ''}`,
                value: money(c.amount_minor),
                muted: true,
              })),
            ]}
          />
        ) : null}
        <p className="ao-note">{recover ? t('recover.billNote') : t('assist.billNote')}</p>
        {quoteError ? <p className="field__error" role="alert"><Icon name="alert" /><span>{quoteError}</span></p> : null}

        {recover ? (
          <div className="ao-recover">
            <h3 className="ao-h ao-h--sub">{t('recover.fieldsTitle')}</h3>
            <div data-field="reference">
              <TextField
                density="staff"
                label={t('recover.reference')}
                help={t('recover.referenceHelp')}
                value={f.reference}
                maxLength={40}
                autoComplete="off"
                disabled={locked}
                error={fieldErrors.reference}
                onChange={(e) => setF({ reference: e.currentTarget.value })}
              />
            </div>
            <div data-field="time">
              <TextField
                density="staff"
                type="datetime-local"
                label={t('recover.time')}
                help={t('recover.timeHelp')}
                value={f.time}
                min={minLocal}
                max={nowLocal}
                disabled={locked}
                error={fieldErrors.time}
                onChange={(e) => setF({ time: e.currentTarget.value })}
              />
            </div>
            <div data-field="already">
              <ChoiceGroup legend={t('recover.already')} required satisfied={Boolean(f.already)} error={fieldErrors.already}>
                {(['none', 'prepared', 'served'] as const).map((a) => (
                  <RadioCard
                    key={a}
                    card
                    name={`already-${visitId}`}
                    label={t(`recover.already.${a}`)}
                    description={t(`recover.already.${a}Help`)}
                    checked={f.already === a}
                    disabled={locked}
                    onChange={() => setF({ already: a })}
                  />
                ))}
              </ChoiceGroup>
            </div>
            <div data-field="reason">
              <TextArea
                density="staff"
                label={t('recover.reason')}
                help={t('recover.reasonHelp')}
                value={f.reason}
                onChange={(val) => setF({ reason: val })}
                limit={200}
                disabled={locked}
                error={fieldErrors.reason}
              />
            </div>
          </div>
        ) : null}

        {send.state === 'error' ? (
          <p className="field__error ao-err" role="alert"><Icon name="alert" /><span>{send.message}</span></p>
        ) : null}
      </>
    );
    footer = (
      <div className="ao-foot">
        {send.state === 'ambiguous' ? (
          <Button variant="ghost" size="staff" onClick={discardAttempt}>{t('assist.editInstead')}</Button>
        ) : (
          <Button variant="outline" size="staff" icon="chev-l" disabled={send.state === 'sending'} onClick={() => setStep('pick')}>
            {t('assist.addMore')}
          </Button>
        )}
        <Button
          variant="primary"
          size="staff"
          icon={send.state === 'ambiguous' ? 'refresh' : recover ? 'pad' : 'check'}
          loading={send.state === 'sending'}
          count={count}
          aria-disabled={count === 0 || undefined}
          onClick={() => void submit()}
        >
          {send.state === 'ambiguous' ? t('assist.retry') : recover ? t('recover.send') : t('assist.send')}
        </Button>
      </div>
    );
  }

  return (
    <Drawer
      open
      inline={false}
      onClose={onClose}
      className="ao-drawer"
      lead={tableLabel ? <TableBox label={tableLabel} /> : undefined}
      title={title}
      status={v ? <TableStatePill state={v.table.state} /> : undefined}
      subtitle={v ? `${subtitle} · ${t('assist.seated', { time: clock(v.seated_at) })}` : subtitle}
      closeLabel={t('assist.closeLabel')}
      footer={footer ?? undefined}
    >
      <div ref={bodyRef} className="ao-body">{body}</div>
    </Drawer>
  );
}
