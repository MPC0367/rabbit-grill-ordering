// "บริการที่โต๊ะ 07" (brief 15, 16; DESIGN §10.13; DECISIONS D-16, D-21).
// Only the services the restaurant enabled. One active request per type:
// a repeated tap gets the request that is already waiting. When this phone
// cannot reach the server the sheet says so and falls back to waving to a
// member of staff. The bill request confirms what it is asking for first.
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import type { GuestBillDTO } from '../../../../shared/dto.ts';
import type { ServiceType } from '../../../../shared/status.ts';
import { ApiError } from '../../lib/api.ts';
import { useConfig } from '../../lib/config.tsx';
import { clock, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  Button, Icon, Leader, ListRow, Price, Sheet, Skeleton, StatusPill, TextArea, useToast,
  type IconName, type ListRowProps,
} from '../../ui/index.ts';
import { AnalyticsNotice } from '../shell/AnalyticsNotice.tsx';
import { useGuestLiveState, useOnline } from '../shell/hooks.ts';
import { useGuestSession } from '../shell/session.tsx';
import { useServiceRequests, useVisitResource } from './hooks.ts';
import { closeThenNavigate, detailOf, errorWords } from './lib.ts';
import NoAccessPanel from './NoAccessPanel.tsx';
import './visit.css';

const ORDER: ServiceType[] = ['call_staff', 'water', 'utensils', 'order_change', 'allergy_help', 'bill'];
const ICONS: Record<ServiceType, IconName> = {
  call_staff: 'bell', water: 'glass', utensils: 'cutlery', order_change: 'note', allergy_help: 'alert', bill: 'receipt',
};
const COMPOSE = new Set<ServiceType>(['order_change', 'allergy_help']);
const RECENT_MS = 30 * 60_000;
const NOTE_MAX = 200;

type View = 'list' | 'order_change' | 'allergy_help' | 'bill';

export default function ServiceSheet({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { mode, session, endedReason } = useGuestSession();
  const label = session?.visit.table_label ?? null;
  const title = label ? t('common.serviceAt', { label }) : t('common.service');

  if (mode !== 'joined' || !session) {
    return (
      <Sheet open onClose={onClose} title={title}>
        <NoAccessPanel reason={mode === 'ended' ? (endedReason === 'visit_access_revoked' ? 'revoked' : 'required') : 'public'} compact />
      </Sheet>
    );
  }
  return <ServiceSheetBody onClose={onClose} title={title} visitId={session.visit.id} label={session.visit.table_label} services={session.services} />;
}

function ServiceSheetBody({ onClose, title, visitId, label, services }: {
  onClose(): void; title: string; visitId: string; label: string; services: ReadonlyArray<ServiceType>;
}) {
  const { t, has } = useI18n();
  const { config } = useConfig();
  const liveState = useGuestLiveState();
  const online = useOnline();
  const toast = useToast();
  const svc = useServiceRequests(visitId);
  const bill = useVisitResource<GuestBillDTO>('/api/guest/bill', ['bill.', 'visit.', 'order.', 'line.']);
  const [view, setView] = useState<View>('list');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listTopRef = useRef<HTMLDivElement>(null);
  const composeId = useId();

  const enabled = ORDER.filter((s) => (services.length ? services : config?.services ?? []).includes(s));
  const offline = !online || liveState === 'offline' || unreachable;

  // Moving between the list and a request: keep focus inside the sheet, on the new view.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    if (view === 'list') listTopRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    else headRef.current?.focus();
  }, [view]);

  const describe = (err: unknown): string => {
    if (err instanceof ApiError && err.code === 'bad_request' && detailOf<string>(err, 'reason') === 'service_disabled') return t('help.unavailable');
    return errorWords(t, has, err);
  };

  const failed = (err: unknown) => {
    if (err instanceof ApiError && (err.code === 'visit_closed' || err.code === 'visit_access_revoked' || err.code === 'visit_access_required')) return;
    if (err instanceof ApiError && err.ambiguous) setUnreachable(true);
    setError(`${t('help.failed')} · ${describe(err)}`);
  };

  const sendNow = async (type: ServiceType, text?: string) => {
    setError(null);
    try {
      const r = await svc.send(type, text);
      if (type === 'bill') {
        toast.show({ message: r.existing ? t(r.seen ? 'help.existingSeen' : 'help.existing') : t('bill.requestedToast') });
        void bill.refresh();
      } else {
        toast.show({ message: r.existing ? t(r.seen ? 'help.existingSeen' : 'help.existing') : t('help.sentToast', { name: t(`service.${type}`) }) });
      }
      setUnreachable(false);
      setNote('');
      if (view !== 'list') setView('list');
    } catch (err) {
      failed(err);
    }
  };

  const goBill = (e?: MouseEvent) => {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
    e?.preventDefault();
    closeThenNavigate(onClose, '/menu/bill');
  };

  const b = bill.data;
  const billSub = !b ? t('help.viewBillPlain')
    : b.bill_status === 'finalized' || b.bill_status === 'settled'
      ? (b.paid ? t('bill.status.paid') : t('help.viewBillFinal', { amount: money(b.total_minor) }))
      : t('help.viewBillSub', { amount: money(b.subtotal_minor) });

  const row = (type: ServiceType): ListRowProps & { key: string } => {
    const slot = svc.slots.get(type);
    const active = slot?.active ?? null;
    const done = slot?.lastDone ?? null;
    const doneAt = done ? done.completed_at ?? done.created_at : null;
    let sub: string = type === 'call_staff' ? t('help.sub.call_staff', { label }) : t(`help.sub.${type}`);
    let trailing: ListRowProps['trailing'];
    if (active) {
      sub = active.status === 'acknowledged'
        ? t(type === 'call_staff' ? 'help.acknowledgedCall' : 'help.acknowledged')
        : t('help.sent', { time: clock(active.created_at) });
      trailing = <StatusPill kind="service" status={active.status} size="sm" />;
    } else if (doneAt && Date.now() - new Date(doneAt).getTime() < RECENT_MS) {
      sub = t('help.done', { time: clock(doneAt) });
    }
    if (svc.busy === type) trailing = <span className="vsvc__busy" role="status" aria-label={t('common.sending')} />;
    const opens = COMPOSE.has(type) || type === 'bill';
    return {
      key: type,
      icon: ICONS[type],
      title: t(`service.${type}`),
      sub,
      trailing,
      // Bill stays open while requested: it leads to the bill.
      disabled: (Boolean(active) && type !== 'bill') || svc.busy !== null,
      onClick: () => {
        if (type === 'bill') { setError(null); setView('bill'); return; }
        if (COMPOSE.has(type)) { setError(null); setNote(''); setView(type as View); return; }
        void sendNow(type);
      },
      opensDialog: false,
      className: opens ? undefined : 'srow--now',
    };
  };

  let body;
  let footer;
  if (offline) {
    body = (
      <div className="vsheet">
        <p className="vnote vnote--alert" role="status">
          <Icon name="wifi-off" />
          <span className="vnote__body"><span className="vnote__t">{t('help.offlineTitle')}</span></span>
        </p>
        <p className="handnote"><Icon name="hand" />{t('common.serviceFallback')}</p>
        {unreachable && online && liveState !== 'offline' ? (
          <Button variant="outline" icon="refresh" onClick={() => { setUnreachable(false); setError(null); void svc.refresh(); }}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    );
  } else if (view === 'list') {
    body = (
      <div className="vsvc" ref={listTopRef}>
        <ul>
          {enabled.map((type) => {
            const { key, ...props } = row(type);
            return <li key={key} data-service={type} data-state={svc.slots.get(type)?.active?.status ?? 'idle'}><ListRow {...props} /></li>;
          })}
          <li>
            <a className="srow" href="/menu/bill" onClick={goBill} data-service="view-bill">
              <span className="srow__ic" aria-hidden="true"><Icon name="pad" /></span>
              <span className="srow__txt">
                <span className="srow__t">{t('help.viewBill')}</span>
                <span className="srow__s">{billSub}</span>
              </span>
              <Icon name="chev-r" />
            </a>
          </li>
        </ul>
        {error ? (
          <p className="vnote vnote--alert vsvc__error" role="alert"><Icon name="alert" /><span className="vnote__body">{error}</span></p>
        ) : null}
        <p className="handnote"><Icon name="hand" />{t('common.serviceFallback')}</p>
        <AnalyticsNotice variant="sheet" />
      </div>
    );
  } else if (view === 'bill') {
    const active = svc.slots.get('bill')?.active ?? null;
    const requestedAt = active?.created_at ?? b?.bill_requested_at ?? null;
    body = (
      <div className="vsheet">
        <Button ref={backRef} variant="quiet" icon="chev-l" className="vsheet__back" onClick={() => setView('list')}>{t('help.back')}</Button>
        <div className="vsheet__head">
          <h3 ref={headRef} tabIndex={-1}>{t('service.bill')}</h3>
          <p className="support">{t('help.billLead')}</p>
        </div>
        {b ? (
          <div className="vsheet__rate">
            <Leader
              label={t(b.bill_status === 'open' ? 'bill.totalNow' : 'bill.totalDue')}
              value={<Price minor={b.total_minor} />}
            />
            {b.bill_status === 'open' ? <p className="vtotals__note">{t('bill.totalNowNote')}</p> : null}
          </div>
        ) : bill.loading ? <Skeleton shape="block" height={56} /> : null}
        {requestedAt ? (
          <p className="vnote vnote--ok" role="status"><Icon name="check-c" /><span className="vnote__body">{t('help.billAlready', { time: clock(requestedAt) })}</span></p>
        ) : null}
        {error ? <p className="vnote vnote--alert" role="alert"><Icon name="alert" /><span className="vnote__body">{error}</span></p> : null}
      </div>
    );
    footer = requestedAt || b?.visit_status === 'billing' ? (
      <div className="vsheet__foot vsheet__foot--one">
        <Button variant="primary" size="lg" icon="receipt" onClick={() => goBill()}>{t('help.viewBill')}</Button>
      </div>
    ) : (
      <div className="vsheet__foot">
        <Button variant="primary" size="lg" icon="receipt" loading={svc.busy === 'bill'} onClick={() => void sendNow('bill')}>{t('service.bill')}</Button>
        <Button variant="outline" size="lg" onClick={() => goBill()}>{t('help.billReview')}</Button>
      </div>
    );
  } else {
    const type = view;
    body = (
      <div className="vsheet">
        <Button ref={backRef} variant="quiet" icon="chev-l" className="vsheet__back" onClick={() => setView('list')}>{t('help.back')}</Button>
        <div className="vsheet__head">
          <h3 ref={headRef} tabIndex={-1} id={`${composeId}-t`}>{t(`service.${type}`)}</h3>
          <p className="support">{t(`help.lead.${type}`)}</p>
        </div>
        <TextArea
          label={t(`help.noteLabel.${type}`)}
          optional
          value={note}
          onChange={setNote}
          limit={NOTE_MAX}
          rows={3}
          help={t('help.noteHelp')}
        />
        {error ? <p className="vnote vnote--alert" role="alert"><Icon name="alert" /><span className="vnote__body">{error}</span></p> : null}
      </div>
    );
    footer = (
      <div className="vsheet__foot vsheet__foot--one">
        <Button variant="primary" size="lg" loading={svc.busy === type} onClick={() => void sendNow(type, note)}>
          {t(`help.send.${type}`)}
        </Button>
      </div>
    );
  }

  return (
    <Sheet open onClose={onClose} langSwitch title={title} footer={footer} bodyClassName="vsvc-body">
      {body}
    </Sheet>
  );
}
