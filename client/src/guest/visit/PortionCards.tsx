// Measured-weight cuts on Track (brief 44A, DECISIONS D-08, D-22). A request
// is not an order: it waits for staff to weigh, then for the guest to confirm
// the exact amount. Only confirmation creates a round.
//
// A priced card shows everything staff attached to the quote (brief 44A 4-5):
// the choices they set (doneness and the like), what those choices add to the
// amount, and their note, which the quote form promises the guest will see.
// The guest's own request note stays visible in every state.
import { useState } from 'react';
import type { OrderDTO, PortionQuoteDTO, PortionRequestDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { clock, grams as gramsLabel, money } from '../../lib/format.ts';
import { useI18n, type Picked } from '../../lib/i18n.tsx';
import { useNow } from '../../lib/store.ts';
import { Button, Dialog, Icon, Leader, PortionQuote, TextLink, useToast, type PortionQuoteState } from '../../ui/index.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { useOverlays } from '../shell/overlays.tsx';
import { useAccessFailure } from './hooks.ts';
import { attemptKey, errorWords, settleKey, settleUnlessAmbiguous } from './lib.ts';

type ServiceSend = (type: 'call_staff', note?: string | null) => Promise<unknown>;

export interface PortionCardsProps {
  visitId: string;
  portions: ReadonlyArray<PortionRequestDTO>;
  orders: ReadonlyArray<OrderDTO>;
  refresh: () => Promise<void>;
  /** A confirmation created this round: highlight and scroll to it. */
  onConfirmed: (order: OrderDTO) => void;
  callStaff: ServiceSend;
  canCallStaff: boolean;
}

function viewState(p: PortionRequestDTO, now: number): PortionQuoteState | null {
  const q = p.quote;
  switch (p.status) {
    case 'quoted':
      if (q && new Date(q.expires_at).getTime() <= now) return 'expired';
      return q && q.revision > 1 ? 'revised' : 'quoted';
    case 'requested':
      return q && (q.status === 'expired' || new Date(q.expires_at).getTime() <= now) && q.status !== 'withdrawn' && q.status !== 'superseded' ? 'expired' : 'requested';
    case 'expired':
      return 'expired';
    case 'confirmed':
      return 'confirmed';
    default:
      return null;
  }
}

const ORDER: Record<PortionQuoteState, number> = { quoted: 0, revised: 0, expired: 1, requested: 2, confirmed: 3 };

/** Which requests Track shows: open ones, and confirmations whose round is still on its way. */
export function visiblePortions(portions: ReadonlyArray<PortionRequestDTO>, orders: ReadonlyArray<OrderDTO>, now: number) {
  const activeRefs = new Set(orders.filter((o) => o.lines.some((l) => l.status !== 'served' && l.status !== 'rejected' && l.status !== 'cancelled')).map((o) => o.reference));
  return portions
    .map((p) => ({ p, state: viewState(p, now) }))
    .filter((x): x is { p: PortionRequestDTO; state: PortionQuoteState } => {
      if (!x.state) return false;
      if (x.state === 'confirmed') return Boolean(x.p.order_reference && activeRefs.has(x.p.order_reference));
      if (x.p.status === 'expired') return now - new Date(x.p.updated_at).getTime() < 30 * 60_000;
      return true;
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.p.updated_at < b.p.updated_at ? 1 : -1));
}

export function PortionCards({ visitId, portions, orders, refresh, onConfirmed, callStaff, canCallStaff }: PortionCardsProps) {
  const { t, has, pick, lang } = useI18n();
  const { item } = useCatalog();
  const { openPortion } = useOverlays();
  const toast = useToast();
  const failure = useAccessFailure();
  const now = useNow(15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'change' | 'cancel'; p: PortionRequestDTO } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const list = visiblePortions(portions, orders, now);
  if (list.length === 0) return null;

  const names = (p: PortionRequestDTO): { name: Picked; secondary: Picked | null } => {
    const name = pick(p.item_name);
    const alt = lang === 'th' ? p.item_name.en : null;
    return { name, secondary: alt && alt !== name.text ? { text: alt, lang: 'en', fallback: false } : null };
  };

  const fail = (err: unknown) => {
    if (failure(err)) return;
    toast.show({ message: errorWords(t, has, err), tone: 'error' });
  };

  const confirm = async (p: PortionRequestDTO) => {
    const q = p.quote;
    if (!q) return;
    const scope = `confirm.${visitId}.${q.id}.${q.revision}`;
    setBusy(p.id);
    try {
      const r = await api.post<{ request: PortionRequestDTO; order: OrderDTO }>(`/api/guest/portions/${p.id}/confirm`, {
        quote_id: q.id, revision: q.revision, idempotency_key: attemptKey(scope),
      });
      settleKey(scope);
      toast.show({ message: t('portion.confirmedToast', { name: pick(p.item_name).text, round: r.order.round_no }) });
      onConfirmed(r.order);
      await refresh();
    } catch (err) {
      settleUnlessAmbiguous(scope, err);
      if (err instanceof ApiError && err.code === 'already_done') { await refresh(); return; }
      fail(err);
      if (err instanceof ApiError && !err.ambiguous) void refresh();
    } finally {
      setBusy(null);
    }
  };

  const change = async (p: PortionRequestDTO, reason?: string) => {
    const q = p.quote;
    if (!q) return;
    setDialogError(null);
    try {
      await api.post<PortionRequestDTO>(`/api/guest/portions/${p.id}/decline`, { quote_id: q.id, revision: q.revision });
    } catch (err) {
      if (failure(err)) { setDialog(null); return; }
      setDialogError(errorWords(t, has, err));
      if (err instanceof ApiError && (err.code === 'quote_superseded' || err.code === 'invalid_transition')) void refresh();
      return;
    }
    // Ask staff to weigh again, carrying what the guest would like.
    const scope = `portion.${visitId}.${p.item_id}.change.${q.id}`;
    try {
      const body: Record<string, unknown> = { item_id: p.item_id, idempotency_key: attemptKey(scope) };
      if (reason && reason.trim()) body.note = reason.trim();
      await api.post<PortionRequestDTO>('/api/guest/portions', body);
      settleKey(scope);
      toast.show({ message: t('portion.changeSent', { name: pick(p.item_name).text }) });
    } catch (err) {
      settleUnlessAmbiguous(scope, err);
      fail(err);
    }
    setDialog(null);
    void refresh();
  };

  const cancel = async (p: PortionRequestDTO) => {
    setDialogError(null);
    try {
      await api.post<PortionRequestDTO>(`/api/guest/portions/${p.id}/cancel`, {});
      toast.show({ message: t('portion.cancelled', { name: pick(p.item_name).text }) });
      setDialog(null);
      void refresh();
    } catch (err) {
      if (failure(err)) { setDialog(null); return; }
      setDialogError(errorWords(t, has, err));
      void refresh();
    }
  };

  const weighAgain = async (p: PortionRequestDTO) => {
    setBusy(p.id);
    try {
      await callStaff('call_staff', t('portion.weighAgainNote', { name: pick(p.item_name).text }));
      toast.show({ message: t('portion.weighAgainSent') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="vquotes" aria-label={t('portion.sectionLabel')}>
      {list.map(({ p, state }) => {
        const { name, secondary } = names(p);
        const q = p.quote;
        const catalogItem = item(p.item_id);
        const rate = q?.rate_minor ?? p.current_rate?.rate_minor ?? catalogItem?.rate_minor ?? null;
        const basis = q?.rate_basis_grams ?? p.current_rate?.rate_basis_grams ?? catalogItem?.rate_basis_grams ?? 100;
        const priced = state === 'quoted' || state === 'revised' || state === 'confirmed';
        const terminalExpired = p.status === 'expired';
        const round = p.order_reference ? orders.find((o) => o.reference === p.order_reference) : undefined;
        return (
          <PortionQuote
            key={p.id}
            className="vquote"
            data-portion={p.id}
            data-state={state}
            state={state}
            name={name}
            secondary={secondary}
            grams={priced ? q?.grams ?? null : null}
            rateMinor={rate}
            basisGrams={basis}
            amountMinor={priced ? q?.amount_minor ?? null : null}
            expiresAt={state === 'quoted' || state === 'revised' ? q?.expires_at ?? null : null}
            busy={busy === p.id}
            onConfirm={state === 'quoted' || state === 'revised' ? () => void confirm(p) : undefined}
            onChange={state === 'quoted' || state === 'revised' ? () => { setDialogError(null); setDialog({ kind: 'change', p }); } : undefined}
            onRequestAgain={state === 'expired' && (terminalExpired || canCallStaff)
              ? () => (terminalExpired ? openPortion(p.item_id) : void weighAgain(p))
              : undefined}
          >
            {state === 'revised' ? <p className="support">{t('portion.revisedNote')}</p> : null}
            {priced && q ? <QuoteDetails quote={q} /> : null}
            {priced && p.note ? <GuestNote note={p.note} /> : null}
            {state === 'requested' || state === 'expired' ? (
              <div className="vquote__extra">
                {p.preferred_grams ? <Leader label={t('portion.preferredShown')} value={gramsLabel(p.preferred_grams, lang)} /> : null}
                {p.note ? <GuestNote note={p.note} /> : null}
                <p className="meta">{t('portion.requestedAt', { time: clock(p.created_at) })}</p>
                {state === 'expired' && !terminalExpired ? <p className="support">{t('portion.expiredHelp')}</p> : null}
              </div>
            ) : null}
            {state === 'confirmed' && p.order_reference ? (
              <div className="vquote__link">
                <TextLink
                  href={`#round-${p.order_reference}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const el = document.getElementById(`round-${p.order_reference}`);
                    el?.scrollIntoView({ block: 'start' });
                    el?.focus({ preventScroll: true });
                  }}
                >
                  {t('portion.inRound', { round: round?.round_no ?? '' })} · <span className="vref" lang="en">{p.order_reference}</span>
                </TextLink>
              </div>
            ) : null}
            {state === 'requested' ? (
              <div className="vquote__quiet">
                <Button variant="quiet" opensDialog onClick={() => { setDialogError(null); setDialog({ kind: 'cancel', p }); }}>
                  {t('portion.cancel')}
                </Button>
              </div>
            ) : null}
          </PortionQuote>
        );
      })}
      <Dialog
        open={dialog?.kind === 'change'}
        onClose={() => setDialog(null)}
        title={dialog ? t('portion.changeTitle', { name: pick(dialog.p.item_name).text }) : ''}
        confirmLabel={t('portion.changeConfirm')}
        cancelLabel={t('common.cancel')}
        reason={{ label: t('portion.changeReason'), limit: 200 }}
        error={dialogError}
        onConfirm={(reason) => (dialog ? change(dialog.p, reason) : undefined)}
      >
        {t('portion.changeBody')}
      </Dialog>
      <Dialog
        open={dialog?.kind === 'cancel'}
        onClose={() => setDialog(null)}
        title={dialog ? t('portion.cancelTitle', { name: pick(dialog.p.item_name).text }) : ''}
        confirmLabel={t('portion.cancelConfirm')}
        cancelLabel={t('portion.keep')}
        error={dialogError}
        onConfirm={() => (dialog ? cancel(dialog.p) : undefined)}
      >
        {t('portion.cancelBody')}
      </Dialog>
    </section>
  );
}

/** What staff attached to a quote: chosen options, their charge, and the note for the guest. */
export function QuoteDetails({ quote }: { quote: PortionQuoteDTO }) {
  const { t, pick } = useI18n();
  const choices = quote.choices.filter((c) => c.options.length > 0);
  const extra = quote.modifiers_minor ?? 0;
  if (!choices.length && !quote.note && extra <= 0) return null;
  return (
    <div className="vquote__detail" data-quote-detail="">
      {choices.length ? (
        <ul className="vquote__choices">
          {choices.map((c, i) => {
            const group = pick(c.group);
            return (
              <li key={i}>
                <span className="vquote__group" lang={group.lang}>{group.text}</span>
                <span className="vquote__opts">
                  {c.options.map((o, j) => {
                    const name = pick(o.name);
                    return <span key={j} lang={name.lang}>{name.text}</span>;
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {extra > 0 ? <p className="meta">{t('portion.modifiersIncluded', { amount: money(extra) })}</p> : null}
      {quote.note ? (
        <div className="vquote__staff" data-staff-note="">
          <p className="vquote__staff-k"><Icon name="note" size="sm" />{t('portion.staffNote')}</p>
          {/* The staff member's own words, in whatever language they wrote. */}
          <p className="vquote__staff-t">{quote.note}</p>
        </div>
      ) : null}
    </div>
  );
}

function GuestNote({ note }: { note: string }) {
  const { t } = useI18n();
  return (
    <p className="meta cartline__note vquote__mine">
      <Icon name="note" size="sm" />
      <span><span className="visually-hidden">{t('portion.yourNote')}: </span>{note}</span>
    </p>
  );
}
