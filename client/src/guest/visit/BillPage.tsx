// /menu/bill - one combined bill for the table (brief 16, 36; DECISIONS D-12).
// Confirmed lines make the amount; pending lines are shown apart and never
// counted; cancelled and declined lines say "not charged". Payment happens
// with a member of staff: no "I have paid" button, no payment QR in V1, no
// split bill, and this page is not a tax invoice.
import { useMemo, type ReactNode } from 'react';
import type { BillLineDTO, GuestBillDTO } from '../../../../shared/dto.ts';
import type { ChargeLine } from '../../../../shared/money.ts';
import { clock } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive } from '../../lib/live.tsx';
import {
  Button, Card, ConnectionIndicator, EmptyState, Icon, Leader, LinkButton, PageHead, Pill, Price, Skeleton, Timeline,
  useToast, type IconName, type PillTone, type TimelineStep,
} from '../../ui/index.ts';
import { useOverlays } from '../shell/overlays.tsx';
import { useGuestSession } from '../shell/session.tsx';
import { FeedbackForm } from './FeedbackForm.tsx';
import { useCommitted, useServiceRequests, useVisitResource } from './hooks.ts';
import { errorWords } from './lib.ts';
import NoAccessPanel from './NoAccessPanel.tsx';
import { EnOnlyMark, LineName } from './TrackRounds.tsx';
import './visit.css';

type Stage = 'open' | 'requested' | 'billing' | 'final' | 'paid';

const BILL_TOPICS = ['bill.', 'visit.', 'order.', 'line.', 'payment.'];

export default function BillPage() {
  const { t } = useI18n();
  const { mode, session, endedReason } = useGuestSession();
  const joined = mode === 'joined' && session !== null;

  if (mode === 'loading') return <BillSkeleton />;
  if (!joined) {
    return (
      <main className="g-main">
        <h1 className="visually-hidden">{t('bill.title')}</h1>
        <NoAccessPanel reason={mode === 'ended' ? (endedReason === 'visit_access_revoked' ? 'revoked' : 'required') : 'public'} />
      </main>
    );
  }
  return <BillScreen visitId={session.visit.id} label={session.visit.table_label} services={session.services} />;
}

function BillSkeleton() {
  const { t } = useI18n();
  return (
    <main className="g-main">
      <div className="vpage" role="status" aria-live="polite">
        <span className="visually-hidden">{t('bill.loading')}</span>
        <div className="pagehead" aria-hidden="true">
          <Skeleton width="44%" height={14} />
          <Skeleton width="50%" height={32} />
        </div>
        <Card className="vskel" aria-hidden="true">
          <Skeleton lines={6} />
          <div className="vskel__row"><Skeleton width="40%" height={20} /><Skeleton width="24%" height={26} /></div>
        </Card>
      </div>
    </main>
  );
}

function chargeLabel(c: ChargeLine, lang: 'th' | 'en'): { text: string; lang: 'th' | 'en' } {
  if (lang === 'th') return c.label_th ? { text: c.label_th, lang: 'th' } : { text: c.label_en, lang: 'en' };
  return c.label_en ? { text: c.label_en, lang: 'en' } : { text: c.label_th, lang: 'th' };
}

function groupByRound(lines: ReadonlyArray<BillLineDTO>): Array<{ ref: string; lines: BillLineDTO[] }> {
  const groups: Array<{ ref: string; lines: BillLineDTO[] }> = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last.ref === l.order_reference) last.lines.push(l);
    else groups.push({ ref: l.order_reference, lines: [l] });
  }
  return groups;
}

function BillScreen({ visitId, label, services }: { visitId: string; label: string; services: ReadonlyArray<string> }) {
  const { t, has, lang } = useI18n();
  const toast = useToast();
  const live = useLive();
  const { openService } = useOverlays();
  const flow = useCommitted(['bill.', 'visit.', 'payment.']);
  const bill = useVisitResource<GuestBillDTO>('/api/guest/bill', BILL_TOPICS, { onEvent: flow.onEvent, onResync: flow.onResync });
  const svc = useServiceRequests(visitId);
  const b = bill.data;
  const animate = flow.committed(b);

  const billReq = svc.slots.get('bill')?.active ?? null;
  const requestedAt = b?.bill_requested_at ?? billReq?.created_at ?? null;
  const stage: Stage = !b ? 'open'
    : b.paid || b.bill_status === 'settled' ? 'paid'
      : b.bill_status === 'finalized' ? 'final'
        : b.visit_status === 'billing' ? 'billing'
          : requestedAt ? 'requested' : 'open';

  const steps = useMemo<TimelineStep[]>(() => {
    const order: Stage[] = ['open', 'requested', 'final', 'paid'];
    const at = stage === 'billing' ? 1 : order.indexOf(stage);
    const state = (i: number) => (i < at ? 'done' : i === at ? 'current' : 'upcoming') as TimelineStep['state'];
    return [
      { key: 'request', label: t('bill.flow.request'), state: state(0), at: requestedAt, sub: at === 0 ? t('bill.flow.requestSub') : undefined },
      { key: 'prepare', label: t('bill.flow.prepare'), state: state(1), sub: at === 1 ? (stage === 'billing' ? t('bill.flow.prepareSub') : t('bill.flow.waitSub')) : undefined },
      { key: 'pay', label: t('bill.flow.pay'), state: state(2), sub: at === 2 ? t('bill.flow.paySub') : undefined },
      { key: 'confirm', label: t('bill.flow.confirm'), state: stage === 'paid' ? 'done' : 'upcoming' },
    ];
  }, [stage, requestedAt, t]);

  const pill: { tone: PillTone; icon: IconName; text: string } = {
    open: { tone: 'line' as PillTone, icon: 'receipt' as IconName, text: t('bill.status.open') },
    requested: { tone: 'neutral' as PillTone, icon: 'check' as IconName, text: t('bill.status.requested', { time: requestedAt ? clock(requestedAt) : '' }).trim() },
    billing: { tone: 'heat' as PillTone, icon: 'clock' as IconName, text: t('bill.status.billing') },
    final: { tone: 'ink' as PillTone, icon: 'receipt' as IconName, text: t('bill.status.final', { n: b?.revision_no ?? 1 }) },
    paid: { tone: 'ok' as PillTone, icon: 'check-c' as IconName, text: t('bill.status.paid') },
  }[stage];

  const request = async () => {
    try {
      const r = await svc.send('bill');
      toast.show({ message: r.existing ? t('help.existing') : t('bill.requestedToast') });
      void bill.refresh();
    } catch (err) {
      toast.show({ message: `${t('help.failed')} · ${errorWords(t, has, err)}`, tone: 'error' });
    }
  };

  const head = (
    <div className="vpage__head">
      <PageHead
        kicker={t('bill.kicker', { label })}
        title={t('bill.title')}
        secondary={lang === 'th' ? t('bill.titleEn') : undefined}
        row={(
          <>
            <Pill tone={pill.tone} icon={pill.icon} role="status" data-stage={stage}>{pill.text}</Pill>
            {live.state !== 'live' || bill.stale ? <ConnectionIndicator variant="track" stale={bill.stale} /> : null}
          </>
        )}
        support={t('bill.shared', { label })}
      />
      {bill.stale ? (
        <p className="vnote vnote--heat" role="status"><Icon name="clock" /><span className="vnote__body">{t('bill.staleNote')}</span></p>
      ) : null}
    </div>
  );

  if (!b) {
    return (
      <main className="g-main">
        <div className="vpage-cq">
          <div className="vpage">
            {head}
            {bill.loading ? (
              <Card className="vskel" role="status" aria-live="polite">
                <span className="visually-hidden">{t('bill.loading')}</span>
                <Skeleton lines={6} />
              </Card>
            ) : (
              <EmptyState
                icon="alert"
                headingLevel={2}
                title={t('bill.errorTitle')}
                action={<Button variant="primary" icon="refresh" onClick={() => void bill.refresh()}>{t('common.retry')}</Button>}
              >
                {bill.error ? errorWords(t, has, bill.error) : null}
              </EmptyState>
            )}
          </div>
        </div>
      </main>
    );
  }

  const nothing = b.lines.length === 0 && b.pending_lines.length === 0 && b.excluded_lines.length === 0;
  const finalAmount = stage === 'final' || stage === 'paid';
  const canRequest = stage === 'open' && services.includes('bill') && !nothing;

  const top = (
    <div className="vpage__top">
      <Card as="section" className="vbill-flow" aria-labelledby="bill-flow-h">
        <h2 className="vbill-flow__h" id="bill-flow-h">{t('bill.flow')}</h2>
        <Timeline steps={steps} label={t('bill.flow')} animate={animate} />
      </Card>
    </div>
  );

  const main = (
    <div className="vpage__main">
      {stage === 'paid' ? (
        <Card as="section" className="vpaid" aria-labelledby="bill-paid-h">
          <span className="vend__mark" aria-hidden="true"><Icon name="check-c" /></span>
          <h2 id="bill-paid-h">{t('bill.paidTitle')}</h2>
          <p>{t('bill.paidBody')}</p>
        </Card>
      ) : null}
      {nothing ? (
        <EmptyState
          icon="receipt"
          headingLevel={2}
          title={t('bill.emptyTitle')}
          action={<LinkButton href="/menu" variant="outline" icon="book">{t('track.toMenu')}</LinkButton>}
        >
          {t('bill.emptyBody')}
        </EmptyState>
      ) : (
        <>
          <Card as="section" className="vreceipt" aria-labelledby="bill-lines-h" data-bill-status={b.bill_status}>
            <div className="vreceipt__h">
              <h2 id="bill-lines-h">{t('bill.accepted')}</h2>
              {b.revision_no && finalAmount ? <p>{t('bill.revision', { n: b.revision_no })}</p> : null}
            </div>
            {b.lines.length ? groupByRound(b.lines).map((g) => (
              <ReceiptGroup key={g.ref} ref_={g.ref} lines={g.lines} />
            )) : (
              <p className="vreceipt__group vreceipt__sub">{t('bill.emptyBody')}</p>
            )}
            <div className="vtotals">
              {b.adjustments_minor !== 0 || b.charges.some((c) => !c.inclusive) ? (
                <Leader label={t('bill.subtotal')} value={<Price minor={b.subtotal_minor} />} />
              ) : null}
              {b.adjustments_minor !== 0 ? (
                <Leader label={t('bill.adjustments')} value={<Price minor={b.adjustments_minor} sign />} />
              ) : null}
              {b.charges.filter((c) => !c.inclusive).map((c) => {
                const l = chargeLabel(c, lang);
                return <Leader key={c.id} label={<span lang={l.lang}>{l.text}</span>} value={<Price minor={c.amount_minor} />} />;
              })}
              <div className="vtotals__due">
                <Leader
                  label={t(stage === 'paid' ? 'bill.totalPaid' : finalAmount ? 'bill.totalDue' : 'bill.totalNow')}
                  value={<Price minor={b.total_minor} size="lg" />}
                  data-total={b.total_minor}
                />
              </div>
              {b.charges.filter((c) => c.inclusive).map((c) => {
                const l = chargeLabel(c, lang);
                return (
                  <p key={c.id} className="vtotals__inc">
                    {t('bill.chargeIncluded', { label: l.text })} <Price minor={c.amount_minor} plain />
                  </p>
                );
              })}
              {!finalAmount ? <p className="vtotals__note">{t('bill.totalNowNote')}</p> : null}
            </div>
          </Card>

          {b.pending_lines.length ? (
            <Card as="section" className="vreceipt vreceipt--muted" aria-labelledby="bill-pending-h">
              <div className="vreceipt__h">
                <h2 id="bill-pending-h">{t('bill.pending')}</h2>
              </div>
              {groupByRound(b.pending_lines).map((g) => <ReceiptGroup key={g.ref} ref_={g.ref} lines={g.lines} />)}
              <p className="vreceipt__group vreceipt__sub">{t('bill.pendingNote')}</p>
            </Card>
          ) : null}

          {b.excluded_lines.length ? (
            <Card as="section" className="vreceipt vreceipt--muted" aria-labelledby="bill-excluded-h">
              <div className="vreceipt__h">
                <h2 id="bill-excluded-h">{t('bill.excluded')}</h2>
                <p>{t('bill.excludedNote')}</p>
              </div>
              {groupByRound(b.excluded_lines).map((g) => <ReceiptGroup key={g.ref} ref_={g.ref} lines={g.lines} excluded />)}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );

  const bottom = (
    <div className="vpage__bottom">
      {canRequest ? (
        <div className="vbill-act">
          <Button variant="primary" size="lg" block icon="receipt" loading={svc.busy === 'bill'} onClick={() => void request()}>
            {t('service.bill')}
          </Button>
          <p className="support">{t('bill.requestHelp')}</p>
        </div>
      ) : null}
      {stage === 'requested' && requestedAt ? (
        <p className="vnote vnote--ok" role="status">
          <Icon name="check-c" />
          <span className="vnote__body">{t('bill.requested', { time: clock(requestedAt) })}</span>
        </p>
      ) : null}
      {stage === 'paid' ? <div className="vsection"><FeedbackForm visitId={visitId} /></div> : null}
      <Card as="section" className="vhow" aria-labelledby="bill-how-h">
        <h2 id="bill-how-h">{t('bill.howTitle')}</h2>
        <ul>
          <li><Icon name="hand" />{t('bill.how1')}</li>
          <li><Icon name="receipt" />{t('bill.how2')}</li>
          {stage !== 'paid' ? <li><Icon name="bell" />{t('bill.how3')}</li> : null}
        </ul>
        {stage !== 'paid' && services.includes('call_staff') ? (
          <div className="vbill-act">
            <Button variant="outline" icon="bell" opensDialog onClick={openService}>{t('service.call_staff')}</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );

  return (
    <main className="g-main">
      <div className="vpage-cq">
        <div className="vpage vpage--split" data-stage={stage}>
          {head}
          {top}
          {main}
          {bottom}
        </div>
      </div>
    </main>
  );
}

function ReceiptGroup({ ref_, lines, excluded }: { ref_: string; lines: BillLineDTO[]; excluded?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="vreceipt__group">
      <p className="vreceipt__ref" lang="en">{ref_}</p>
      <ul>
        {lines.map((l) => {
          let value: ReactNode = <Price minor={l.line_total_minor} />;
          if (excluded) {
            value = (
              <span className="vreceipt__why">
                <Icon name="slash" />{t('common.notCharged')}
              </span>
            );
          }
          return (
            <li key={l.line_id} className="vreceipt__line" data-line={l.line_id}>
              <Leader
                label={(
                  <span className="vreceipt__name">
                    <LineName line={l} marker={false} />
                    <span className="vreceipt__x">× {l.quantity}</span>
                  </span>
                )}
                value={value}
              />
              <EnOnlyMark name={l.name} />
              {excluded ? (
                <p className="vreceipt__sub">{t(l.status === 'rejected' ? 'status.rejected' : 'status.cancelled')}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
