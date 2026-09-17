// One table request in the service queue (brief 22): table, type, the
// guest's note, age, status and who acknowledged it, with versioned actions.
import { useState } from 'react';
import type { ServiceRequestDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import type { ServiceStatus } from '../../../../../shared/status.ts';
import { api } from '../../../lib/api.ts';
import { clock } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { Button, Dialog, GuestNote, Icon, Pill, StatusPill, TableBox, useAnnounce, useToast } from '../../../ui/index.ts';
import { errorText, minutesSince, staleCurrent, tn, toApiError } from '../support.ts';

const TYPE_ICON = {
  call_staff: 'hand',
  water: 'glass',
  utensils: 'cutlery',
  bill: 'receipt',
  order_change: 'pad',
  allergy_help: 'alert',
} as const;

export function ServiceCard({ req, now, can, onChanged, onStale, conflict, onReview, onAssist }: {
  req: ServiceRequestDTO;
  now: number;
  can: (p: Permission) => boolean;
  onChanged: (next: ServiceRequestDTO) => void;
  onStale: (current: ServiceRequestDTO | null) => void;
  conflict: { by: string; at: string } | null;
  onReview: () => void;
  onAssist?: (visitId: string) => void;
}) {
  const { t, lang, has } = useI18n();
  const toast = useToast();
  const announce = useAnnounce();
  const [busy, setBusy] = useState<ServiceStatus | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const typeWords = t(`service.${req.type}`);
  const wait = minutesSince(req.created_at, now);
  const handle = can('service.handle');
  const blocked = Boolean(conflict);

  const move = async (to: ServiceStatus, reason?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(to);
    try {
      const next = await api.post<ServiceRequestDTO>(`/api/staff/service/${req.id}/transition`, { to, version: req.version, reason: reason ?? null });
      onChanged(next);
      const words = t(`requests.done.${to}`, { type: typeWords, table: req.table_label });
      announce(words);
      if (to === 'cancelled') toast.show({ message: words });
      return true;
    } catch (err) {
      const e = toApiError(err);
      if (e.code === 'stale_version' || e.code === 'invalid_transition') {
        onStale(staleCurrent<ServiceRequestDTO>(err));
        toast.show({ message: t('orders.toast.stale'), tone: 'info' });
      } else {
        const msg = errorText(t, err);
        if (to === 'cancelled') setCancelError(msg);
        else toast.show({ message: msg, tone: 'error' });
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  const who = req.status === 'acknowledged' && req.acknowledged_at
    ? t('requests.ackBy', { name: req.acknowledged_by ?? t('orders.conflict.someone'), time: clock(req.acknowledged_at) })
    : req.status === 'sent' ? t('requests.nobodyYet') : null;
  const late = req.status === 'sent' && wait >= 5;

  return (
    <article className={`ticket rq${blocked ? ' has-conflict' : ''}`} aria-label={tn({ t, has }, 'requests.aria', wait, { type: typeWords, table: req.table_label })}>
      <header className="ticket__head">
        <TableBox label={req.table_label} />
        <div className="ticket__r1">
          <span className="rq__type" lang={lang}>
            <Icon name={TYPE_ICON[req.type]} size="sm" />
            {typeWords}
          </span>
          <span className={`wait${late ? ' wait--late' : ''}`}>
            <Icon name="clock" />
            <b>{wait}</b>
            <small>{t('common.ticket.min')}</small>
          </span>
        </div>
        <p className="ticket__r2">{t('requests.sentAt', { time: clock(req.created_at) })}</p>
      </header>

      {conflict ? (
        <div className="ticket__conflict" role="status">
          <Icon name="refresh" size="sm" />
          <span>{t('common.ticket.conflict', { name: conflict.by, time: clock(conflict.at) })}</span>
          <button type="button" className="textlink" onClick={onReview}>{t('common.ticket.review')}</button>
        </div>
      ) : null}

      <div className="rq__body">
        {req.note ? <GuestNote text={req.note} /> : null}
        <p className="rq__state">
          {req.status === 'sent'
            ? <Pill tone="heat" icon="clock" size="sm">{t('requests.state.sent')}</Pill>
            : <Pill tone="ok" icon="check" size="sm">{t('requests.state.acknowledged')}</Pill>}
          {who ? <span className="rq__who">{who}</span> : null}
        </p>
      </div>

      {handle ? (
        <div className="ticket__actions">
          {req.status === 'sent' ? (
            <>
              <Button variant="primary" size="staff" icon="check" iconBold loading={busy === 'acknowledged'}
                aria-disabled={blocked || Boolean(busy) || undefined}
                aria-label={t('requests.ackAria', { type: typeWords, table: req.table_label })}
                onClick={() => void move('acknowledged')}
              >
                {t('requests.ack')}
              </Button>
              <Button variant="outline" size="staff" loading={busy === 'completed'}
                aria-disabled={blocked || Boolean(busy) || undefined}
                aria-label={t('requests.completeAria', { type: typeWords, table: req.table_label })}
                onClick={() => void move('completed')}
              >
                {t('requests.complete')}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="staff" icon="check" iconBold loading={busy === 'completed'}
              aria-disabled={blocked || Boolean(busy) || undefined}
              aria-label={t('requests.completeAria', { type: typeWords, table: req.table_label })}
              onClick={() => void move('completed')}
            >
              {t('requests.complete')}
            </Button>
          )}
          {onAssist && (req.type === 'order_change' || req.type === 'call_staff') && can('orders.assist') ? (
            <Button variant="ghost" size="staff" icon="plus" opensDialog className="rq__wide" onClick={() => onAssist(req.visit_id)}>
              {t('orders.focus.assist')}
            </Button>
          ) : null}
          {can('service.cancel') ? (
            <Button variant="quiet" size="staff" opensDialog className="rq__wide rq__cancel"
              aria-disabled={blocked || Boolean(busy) || undefined}
              onClick={() => { setCancelError(null); setCancelOpen(true); }}
            >
              {t('requests.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        density="staff"
        tone="danger"
        title={t('requests.cancelTitle', { type: typeWords, table: req.table_label })}
        confirmLabel={t('requests.cancelGo')}
        cancelLabel={t('orders.confirm.back')}
        reason={{ label: t('requests.cancelReason'), required: true, limit: 200, help: t('requests.cancelHelp') }}
        error={cancelError}
        onConfirm={async (reason) => {
          if (!reason || [...reason].length < 3) { setCancelError(t('orders.confirm.reasonShort', { n: 3 })); return; }
          const ok = await move('cancelled', reason);
          if (ok) setCancelOpen(false);
        }}
      >
        {t('requests.cancelBody')}
      </Dialog>
    </article>
  );
}

/** Finished requests (history toggle): one quiet row each. */
export function ServiceDoneRow({ req }: { req: ServiceRequestDTO }) {
  const { t } = useI18n();
  const at = req.status === 'cancelled' ? req.cancelled_at ?? req.completed_at : req.completed_at;
  const by = req.status === 'cancelled' ? req.cancelled_by : req.completed_by;
  return (
    <li className="rqdone">
      <span className="rqdone__t">{req.table_label}</span>
      <span className="rqdone__body">
        <b>{t(`service.${req.type}`)}</b>
        <span>
          {t('requests.sentAt', { time: clock(req.created_at) })}
          {req.acknowledged_by ? ` · ${t('requests.ackShort', { name: req.acknowledged_by })}` : ''}
          {req.close_reason ? ` · ${t('common.reasonIs', { reason: req.close_reason })}` : ''}
        </span>
      </span>
      <StatusPill kind="service" status={req.status} size="sm" label={t(`requests.state.${req.status}`)} detail={[at ? clock(at) : null, by].filter(Boolean).join(' · ') || undefined} />
    </li>
  );
}
