// One measured-weight request in the portion queue (brief 44A): waiting to be
// weighed, quoted (expiry countdown, re-weigh, confirmed in person, cancel)
// or expired (weigh again). A quote is never an order until confirmed.
import { useState } from 'react';
import type { MenuItemDTO, PortionRequestDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import { newIdempotencyKey } from '../../../../../shared/ids.ts';
import { api } from '../../../lib/api.ts';
import { clock, grams as gramsLabel, money } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { useNow } from '../../../lib/store.ts';
import { Button, Dialog, Icon, Pill, Tag, useAnnounce, useToast } from '../../../ui/index.ts';
import { GuestNote, TableBox } from '../../../ui/admin/index.ts';
import {
  clearPendingKey, errorText, minutesSince, pendingKey, staleCurrent, staffName, toApiError,
} from '../support.ts';
import { QuoteSheet } from './QuoteSheet.tsx';

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PortionCard({ req, item, now, can, onChanged, onStale, conflict, onReview }: {
  req: PortionRequestDTO;
  item: MenuItemDTO | undefined;
  now: number;
  can: (p: Permission) => boolean;
  onChanged: (next: PortionRequestDTO) => void;
  onStale: (current: PortionRequestDTO | null) => void;
  conflict: { by: string; at: string } | null;
  onReview: () => void;
}) {
  const { t, lang, pick } = useI18n();
  const toast = useToast();
  const announce = useAnnounce();
  const tick = useNow(1000);
  const [sheet, setSheet] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const n = staffName(req.item_name);
  /** Dish name in the reading language, for sentences. */
  const said = pick(req.item_name).text;
  const quote = req.quote;
  const activeQuote = quote && quote.status === 'active' ? quote : null;
  const left = activeQuote ? new Date(activeQuote.expires_at).getTime() - tick : 0;
  const lapsed = Boolean(activeQuote) && left <= 0;
  const expiredQuote = (quote && quote.status === 'expired') || lapsed || req.status === 'expired';
  const state: 'requested' | 'quoted' | 'expired' = expiredQuote ? 'expired' : req.status === 'quoted' && activeQuote ? 'quoted' : 'requested';
  const wait = minutesSince(state === 'quoted' && activeQuote ? activeQuote.created_at : req.created_at, now);
  const canQuote = can('portions.quote');
  const blocked = Boolean(conflict);
  const scope = activeQuote ? `portion.${req.id}.${activeQuote.id}.${activeQuote.revision}` : '';

  const handleError = (err: unknown): string | null => {
    const e = toApiError(err);
    if (['stale_version', 'invalid_transition', 'already_done', 'quote_expired', 'quote_superseded'].includes(e.code)) {
      if (scope) clearPendingKey(scope);
      onStale(staleCurrent<PortionRequestDTO>(err));
      toast.show({ message: e.code === 'stale_version' ? t('orders.toast.stale') : t(`error.${e.code}`), tone: 'info' });
      return null;
    }
    if (e.ambiguous) return t('requests.inPerson.ambiguous');
    if (scope) clearPendingKey(scope);
    return errorText(t, err);
  };

  const confirmInPerson = async (note?: string) => {
    if (!activeQuote) return;
    setDialogError(null);
    const key = pendingKey(scope, newIdempotencyKey);
    try {
      const r = await api.post<{ request: PortionRequestDTO; order: StaffOrderDTO; replayed: boolean }>(
        `/api/staff/portions/${req.id}/confirm-in-person`,
        { quote_id: activeQuote.id, revision: activeQuote.revision, idempotency_key: key, note: note?.trim() || null },
      );
      clearPendingKey(scope);
      onChanged(r.request);
      const words = t('requests.inPerson.done', { table: req.table_label, ref: r.order.reference });
      announce(words);
      toast.show({ message: words });
      setConfirmOpen(false);
    } catch (err) {
      const msg = handleError(err);
      if (msg) setDialogError(msg);
      else setConfirmOpen(false);
    }
  };

  const cancel = async (reason?: string) => {
    setDialogError(null);
    if (!reason || [...reason.trim()].length < 2) { setDialogError(t('orders.confirm.reasonShort', { n: 2 })); return; }
    try {
      const next = await api.post<PortionRequestDTO>(`/api/staff/portions/${req.id}/cancel`, { reason: reason.trim(), version: req.version });
      onChanged(next);
      const words = t('requests.portion.cancelled', { table: req.table_label, name: said });
      announce(words);
      toast.show({ message: words });
      setCancelOpen(false);
    } catch (err) {
      const msg = handleError(err);
      if (msg) setDialogError(msg);
      else setCancelOpen(false);
    }
  };

  const heading = state === 'quoted' ? t('requests.portion.quoted') : state === 'expired' ? t('requests.portion.expired') : t('requests.portion.requested');

  return (
    <article className={`ticket rq rq--portion${blocked ? ' has-conflict' : ''}`} aria-label={t('requests.portion.aria', { name: said, table: req.table_label, state: heading })}>
      <header className="ticket__head">
        <TableBox label={req.table_label} />
        <div className="ticket__r1">
          <span className="rq__type" lang={lang}>
            <Icon name={state === 'expired' ? 'clock' : 'scale'} size="sm" />
            {heading}
          </span>
          <span className="wait">
            <Icon name="clock" />
            <b>{wait}</b>
            <small>{t('common.ticket.min')}</small>
          </span>
        </div>
        <p className="ticket__r2">
          {t('requests.portion.askedAt', { time: clock(req.created_at) })}
          {' · '}
          {req.source === 'staff' ? t('requests.portion.byStaff') : t('requests.portion.byGuest')}
        </p>
      </header>

      {conflict ? (
        <div className="ticket__conflict" role="status">
          <Icon name="refresh" size="sm" />
          <span>{t('common.ticket.conflict', { name: conflict.by, time: clock(conflict.at) })}</span>
          <button type="button" className="textlink" onClick={onReview}>{t('common.ticket.review')}</button>
        </div>
      ) : null}

      <div className="rq__body">
        <p className="rq__dish">
          <span className="line__th" lang={n.lang}>{n.text}</span>
          {n.secondary ? <span className="line__en" lang="en">{n.secondary}</span> : null}
        </p>
        <p className="rq__facts">
          {req.current_rate ? <span>{t('requests.quote.rate', { amount: money(req.current_rate.rate_minor), n: req.current_rate.rate_basis_grams })}</span> : <span className="is-alert">{t('requests.quote.noRate')}</span>}
          {req.preferred_grams ? <span>{t('requests.quote.preferred', { grams: gramsLabel(req.preferred_grams, lang) })}</span> : null}
        </p>
        {req.note ? <GuestNote text={req.note} /> : null}

        {quote && state !== 'requested' ? (
          <div className={`rq__quote${state === 'expired' ? ' is-expired' : ''}`}>
            <p className="rq__quote-main">
              <Icon name="scale" size="sm" />
              <b className="num">{gramsLabel(quote.grams, lang)}</b>
              <span aria-hidden="true">·</span>
              <b className="num">{money(quote.amount_minor)}</b>
              <Tag tone="line">{t('requests.portion.revision', { n: quote.revision })}</Tag>
            </p>
            {quote.choices.length ? (
              <p className="rq__quote-sub">{quote.choices.map((c) => c.options.map((o) => pick(o.name).text).join(', ')).join(' · ')}</p>
            ) : null}
            {state === 'quoted' && activeQuote ? (
              <p className="rq__quote-sub" aria-live="off">
                <Pill tone="heat" icon="clock" size="sm">{t('requests.portion.waitingGuest')}</Pill>
                <span>{t('requests.portion.expiresIn', { left: countdown(left), time: clock(activeQuote.expires_at) })}</span>
              </p>
            ) : (
              <p className="rq__quote-sub">
                <Pill tone="alert" icon="clock" size="sm">{t('requests.portion.expiredAt', { time: clock(quote.expires_at) })}</Pill>
                <span>{t('requests.portion.weighAgainHelp')}</span>
              </p>
            )}
          </div>
        ) : null}
      </div>

      {canQuote ? (
        <div className="ticket__actions">
          {state === 'quoted' ? (
            <>
              {can('portions.confirm_in_person') ? (
                <Button variant="outline" size="staff" icon="check" opensDialog aria-disabled={blocked || undefined}
                  onClick={() => { setDialogError(null); setConfirmOpen(true); }}
                >
                  {t('requests.inPerson.open')}
                </Button>
              ) : null}
              <Button variant="outline" size="staff" icon="scale" opensDialog aria-disabled={blocked || undefined} onClick={() => setSheet(true)}>
                {t('requests.portion.reweigh')}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="staff" icon="scale" opensDialog aria-disabled={blocked || !req.current_rate || undefined}
              aria-label={t('requests.portion.weighAria', { name: said, table: req.table_label })}
              onClick={() => setSheet(true)}
            >
              {state === 'expired' ? t('requests.portion.weighAgain') : t('requests.portion.weigh')}
            </Button>
          )}
          <Button variant="quiet" size="staff" opensDialog className="rq__wide rq__cancel" aria-disabled={blocked || undefined}
            onClick={() => { setDialogError(null); setCancelOpen(true); }}
          >
            {t('requests.portion.cancel')}
          </Button>
        </div>
      ) : null}

      {sheet ? (
        <QuoteSheet
          req={req}
          item={item}
          onClose={() => setSheet(false)}
          onDone={onChanged}
          onStale={onStale}
        />
      ) : null}

      <Dialog
        open={confirmOpen && Boolean(activeQuote)}
        onClose={() => setConfirmOpen(false)}
        density="staff"
        wide
        title={t('requests.inPerson.title', { table: req.table_label })}
        confirmLabel={t('requests.inPerson.go')}
        cancelLabel={t('orders.confirm.back')}
        reason={{ label: t('requests.inPerson.note'), required: false, limit: 200, help: t('requests.inPerson.noteHelp') }}
        error={dialogError}
        onConfirm={(note) => confirmInPerson(note)}
      >
        {activeQuote ? t('requests.inPerson.body', {
          table: req.table_label,
          grams: gramsLabel(activeQuote.grams, lang),
          name: said,
          amount: money(activeQuote.amount_minor),
          rev: activeQuote.revision,
        }) : null}
      </Dialog>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        density="staff"
        tone="danger"
        title={t('requests.portion.cancelTitle', { name: said, table: req.table_label })}
        confirmLabel={t('requests.portion.cancelGo')}
        cancelLabel={t('orders.confirm.back')}
        reason={{ label: t('requests.cancelReason'), required: true, limit: 200, help: t('requests.portion.cancelHelp') }}
        error={dialogError}
        onConfirm={(reason) => cancel(reason)}
      >
        {t('requests.portion.cancelBody')}
      </Dialog>
    </article>
  );
}

/** Closed portion requests (history toggle). */
export function PortionDoneRow({ req }: { req: PortionRequestDTO }) {
  const { t, lang } = useI18n();
  const n = staffName(req.item_name);
  const q = req.quote;
  const tone = req.status === 'confirmed' ? 'ok' : 'alert';
  const words = t(`requests.portion.status.${req.status}`);
  return (
    <li className="rqdone">
      <span className="rqdone__t">{req.table_label}</span>
      <span className="rqdone__body">
        <b lang={n.lang}>{n.text}</b>
        <span>
          {q ? `${gramsLabel(q.grams, lang)} · ${money(q.amount_minor)}` : t('requests.portion.notWeighed')}
          {req.order_reference ? ` · ${req.order_reference}` : ''}
          {q?.confirmed_via === 'in_person' ? ` · ${t('requests.portion.viaInPerson')}` : ''}
          {req.resolution_reason ? ` · ${t('common.reasonIs', { reason: req.resolution_reason })}` : ''}
        </span>
      </span>
      <Pill tone={tone} icon={req.status === 'confirmed' ? 'check' : 'slash'} size="sm">
        {words} · {clock(req.updated_at)}
      </Pill>
    </li>
  );
}
