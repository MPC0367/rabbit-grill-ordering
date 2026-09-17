// /menu/orders - the table's rounds as parcel tracking (brief 14, 34, 35, 44A;
// DESIGN §10.14). Everything shown comes from recorded staff steps; nothing
// is estimated. A step animates once, only when a committed live event moved
// it; reconnects and catch-up refetches set state silently.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GuestBillDTO, OrderDTO, PortionRequestDTO } from '../../../../shared/dto.ts';
import { isChargeable } from '../../../../shared/status.ts';
import { clock } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import type { Resource } from '../../lib/live.tsx';
import { setQuery, useRoute } from '../../lib/router.ts';
import { useNow } from '../../lib/store.ts';
import {
  Button, Card, ConnectionIndicator, EmptyState, Icon, LinkButton, PageHead, RunningTotal, Skeleton, TextLink,
  UnsentCard, announce, useToast,
} from '../../ui/index.ts';
import { useCartCount } from '../cart/store.ts';
import { useGuestConnection, useGuestLiveState } from '../shell/hooks.ts';
import { useOverlays } from '../shell/overlays.tsx';
import { useGuestSession } from '../shell/session.tsx';
import { useCommitted, useServiceRequests, useVisitResource } from './hooks.ts';
import { errorWords, isAccessEnded, prefersReduced } from './lib.ts';
import NoAccessPanel from './NoAccessPanel.tsx';
import { PortionCards, visiblePortions } from './PortionCards.tsx';
import { PastRoundView, RoundView, collapses } from './TrackRounds.tsx';
import './visit.css';

interface OrdersPayload { orders: OrderDTO[]; portions: PortionRequestDTO[] }

const STEP_TOPICS = ['order.', 'line.'];

export default function TrackPage() {
  const { t, has, lang } = useI18n();
  const { mode, session, endedReason } = useGuestSession();
  const joined = mode === 'joined' && session !== null;
  const visitId = joined ? session.visit.id : null;
  const label = joined ? session.visit.table_label : '';

  // Committed events vs catch-up: a step may animate only when a live event
  // (not a reconnect, a replay burst or a refetch) brought the change.
  const steps = useCommitted(STEP_TOPICS);
  const orders = useVisitResource<OrdersPayload>(visitId ? '/api/guest/orders' : null, ['order.', 'line.', 'portion.', 'visit.'], { onEvent: steps.onEvent, onResync: steps.onResync });
  const bill = useVisitResource<GuestBillDTO>(visitId ? '/api/guest/bill' : null, ['bill.', 'visit.', 'order.', 'line.']);

  const data = orders.data;
  const animate = steps.committed(data);

  // ?placed=<reference>: highlight, scroll to and announce the new round once.
  const { query } = useRoute();
  const placedParam = query.get('placed');
  const [placed, setPlaced] = useState<string | null>(placedParam);
  useEffect(() => {
    if (!placedParam) return;
    setPlaced(placedParam);
    setQuery({ placed: null });
  }, [placedParam]);
  const handledPlaced = useRef<string | null>(null);
  const reseat = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reseat.current) clearTimeout(reseat.current); }, []);
  useEffect(() => {
    if (!placed || !data || handledPlaced.current === placed) return;
    const order = data.orders.find((o) => o.reference === placed);
    if (!order) return;
    handledPlaced.current = placed;
    announce(t('track.placed', { n: order.round_no, ref: order.reference }));
    const find = () => document.getElementById(`round-${placed}`);
    requestAnimationFrame(() => {
      const el = find();
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: prefersReduced() ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
    });
    // Chrome above the card can still settle (connection chip, request lines): re-seat it once.
    if (reseat.current) clearTimeout(reseat.current);
    reseat.current = setTimeout(() => {
      const el = find();
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top < 56 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start', behavior: 'auto' });
    }, 900);
  }, [placed, data, t]);

  // Polite words for changes that leave no live region behind.
  const prevStatus = useRef<Map<string, string> | null>(null);
  const prevPortion = useRef<Map<string, string> | null>(null);
  const prevLine = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = prevStatus.current;
    const beforeP = prevPortion.current;
    const beforeL = prevLine.current;
    prevStatus.current = new Map(data.orders.map((o) => [o.id, o.status]));
    prevPortion.current = new Map(data.portions.map((p) => [p.id, p.status]));
    prevLine.current = new Map(data.orders.flatMap((o) => o.lines.map((l) => [l.id, l.status] as const)));
    if (!animate || !before || !beforeP || !beforeL) return;
    const newest = Math.max(0, ...data.orders.map((o) => o.round_no));
    const words: string[] = [];
    for (const o of data.orders) {
      if (o.round_no !== newest && o.status === 'served' && before.get(o.id) && before.get(o.id) !== 'served') {
        words.push(t('track.servedAnnounce', { n: o.round_no }));
      }
    }
    // A dish reaching "almost done" or "ready" while the rest of its round is
    // still cooking: the round's own status line does not change, so say it
    // here, once per update, naming at most three dishes.
    const nameOf = (b: { th: string | null; en: string | null }) => b[lang] ?? b.en ?? b.th ?? '';
    for (const status of ['ready', 'almost_done'] as const) {
      const names: string[] = [];
      for (const o of data.orders) {
        const roundSays = o.status === status && before.get(o.id) !== status;
        if (roundSays) continue;
        for (const l of o.lines) {
          const was = beforeL.get(l.id);
          if (l.status === status && was !== undefined && was !== status) names.push(nameOf(l.name));
        }
      }
      if (!names.length) continue;
      const shown = names.slice(0, 3).join(', ');
      const list = names.length > 3 ? t('track.andMore', { names: shown, n: names.length - 3 }) : shown;
      words.push(t(status === 'ready' ? 'track.dishesReady' : 'track.dishesAlmost', { names: list }));
    }
    for (const p of data.portions) {
      if (p.status === 'quoted' && beforeP.get(p.id) !== 'quoted') {
        words.push(t('portion.quoteArrived', { name: p.item_name[lang] ?? p.item_name.en ?? p.item_name.th ?? '' }));
      }
    }
    if (words.length) announce(words.join(' · '));
    // `animate` is derived from `data`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (mode === 'loading') return <TrackSkeleton />;
  if (!joined) {
    return (
      <main className="g-main g-main--track">
        <h1 className="visually-hidden">{t('track.title')}</h1>
        <NoAccessPanel reason={mode === 'ended' ? (endedReason === 'visit_access_revoked' ? 'revoked' : 'required') : 'public'} />
      </main>
    );
  }

  return (
    <main className="g-main g-main--track">
      <div className="vpage-cq">
        <TrackBody
          label={label}
          visitId={visitId!}
          services={session.services}
          billingNow={session.visit.status === 'billing'}
          orders={orders}
          bill={bill.data ?? null}
          animate={animate}
          placed={placed}
          onPlaced={setPlaced}
          errorText={orders.error ? errorWords(t, has, orders.error) : ''}
        />
      </div>
    </main>
  );
}

function TrackSkeleton() {
  const { t } = useI18n();
  return (
    <main className="g-main g-main--track">
      <div className="vpage" role="status" aria-live="polite">
        <span className="visually-hidden">{t('track.loading')}</span>
        <div className="pagehead" aria-hidden="true">
          <Skeleton width="44%" height={14} />
          <Skeleton width="58%" height={32} />
          <Skeleton width="40%" height={28} />
        </div>
        <Card className="vskel" aria-hidden="true">
          <div className="vskel__row"><Skeleton width="30%" height={22} /><Skeleton width="28%" height={26} /></div>
          <Skeleton width="45%" height={30} />
          <Skeleton lines={5} />
        </Card>
      </div>
    </main>
  );
}

interface TrackBodyProps {
  label: string;
  visitId: string;
  services: ReadonlyArray<string>;
  billingNow: boolean;
  orders: Resource<OrdersPayload>;
  bill: GuestBillDTO | null;
  animate: boolean;
  placed: string | null;
  onPlaced: (ref: string) => void;
  errorText: string;
}

function TrackBody({ label, visitId, services, billingNow, orders, bill, animate, placed, onPlaced, errorText }: TrackBodyProps) {
  const { t, lang } = useI18n();
  const liveState = useGuestLiveState();
  const { offline: shellOffline } = useGuestConnection(true);
  const cartCount = useCartCount();
  const { openService } = useOverlays();
  const now = useNow(15_000);
  const data = orders.data;
  const list = data?.orders ?? [];
  const portions = data?.portions ?? [];
  const svc = useServiceRequests(visitId);

  const sorted = useMemo(() => [...list].sort((a, b) => b.round_no - a.round_no), [list]);
  const newest = sorted[0]?.id ?? null;
  const current = sorted.filter((o) => !collapses(o) || o.id === newest || o.reference === placed);
  const past = sorted.filter((o) => !current.includes(o));
  const rounds = list.length;
  const nextRound = Math.max(0, ...list.map((o) => o.round_no)) + 1;
  const hasPortions = visiblePortions(portions, list, now).length > 0;

  // The running amount is what the restaurant has confirmed; its round count
  // counts only the rounds that contribute to it (not rounds awaiting staff).
  const runningMinor = bill
    ? bill.subtotal_minor
    : list.reduce((s, o) => s + o.lines.filter((l) => isChargeable(l.status)).reduce((x, l) => x + l.line_total_minor, 0), 0);
  const confirmedRounds = bill
    ? new Set(bill.lines.map((l) => l.order_reference)).size
    : list.filter((o) => o.lines.some((l) => isChargeable(l.status))).length;
  const runningLabel = confirmedRounds === 0 ? t('track.runningLabelNone')
    : confirmedRounds === 1 ? t('track.runningLabelOne') : t('track.runningLabel', { n: confirmedRounds });

  const stale = orders.stale || liveState === 'reconnecting' || liveState === 'offline';

  const kicker = rounds === 0
    ? t('track.kickerNone', { label })
    : rounds === 1 ? t('track.kickerOne', { label }) : t('track.kicker', { label, n: rounds });

  const head = (
    <div className="vpage__head">
      <PageHead
        kicker={kicker}
        title={t('track.title')}
        secondary={lang === 'th' ? t('track.titleEn') : undefined}
        row={<ConnectionIndicator variant="track" state={liveState} stale={orders.stale} />}
        support={t('track.shared', { label })}
      />
      {/* Offline, the shell banner already says the status may be old and offers staff. */}
      {stale && data && !shellOffline ? (
        <div className="vnote vnote--heat vnote--action" role="status">
          <Icon name="clock" />
          <span className="vnote__body">
            <span className="vnote__t">{t('track.staleTitle')}</span>
            {t('track.staleBody')}
          </span>
          <Button variant="outline" icon="bell" opensDialog onClick={openService}>{t('track.askStaff')}</Button>
        </div>
      ) : null}
    </div>
  );

  const actions = (
    <div className="vpage__top">
      <ServicePair
        services={services}
        svc={svc}
        billAllowed={rounds > 0}
        billingNow={billingNow || bill?.visit_status === 'billing'}
        billRequestedAt={bill?.bill_requested_at ?? null}
      />
    </div>
  );

  let main;
  if (!data && orders.loading) {
    main = (
      <div className="vpage__main" role="status" aria-live="polite">
        <span className="visually-hidden">{t('track.loading')}</span>
        <Card className="vskel" aria-hidden="true">
          <div className="vskel__row"><Skeleton width="30%" height={22} /><Skeleton width="28%" height={26} /></div>
          <Skeleton width="45%" height={30} />
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  } else if (!data) {
    main = (
      <div className="vpage__main">
        <EmptyState
          icon="alert"
          headingLevel={2}
          title={t('track.errorTitle')}
          action={<Button variant="primary" icon="refresh" onClick={() => void orders.refresh()}>{t('common.retry')}</Button>}
        >
          {errorText}
        </EmptyState>
      </div>
    );
  } else if (list.length === 0 && !hasPortions) {
    main = (
      <div className="vpage__main">
        <EmptyState
          icon="track"
          headingLevel={2}
          title={t('track.emptyTitle')}
          action={cartCount > 0 ? undefined : <LinkButton href="/menu" variant="primary" icon="book">{t('track.toMenu')}</LinkButton>}
        >
          {t('track.emptyBody')}
        </EmptyState>
      </div>
    );
  } else {
    main = (
      <div className="vpage__main">
        <PortionCards
          visitId={visitId}
          portions={portions}
          orders={list}
          refresh={orders.refresh}
          onConfirmed={(o) => onPlaced(o.reference)}
          callStaff={(type, note) => svc.send(type, note)}
          canCallStaff={services.includes('call_staff')}
        />
        {current.length ? (
          <section aria-label={t('track.currentHeading')}>
            {current.map((o) => (
              <RoundView key={o.id} order={o} animate={animate && !isAccessEnded(orders.error)} highlight={o.reference === placed} />
            ))}
          </section>
        ) : null}
        {past.length ? (
          <section className="vsection" aria-labelledby="track-past-h">
            <h2 className="vsection__h" id="track-past-h">{t('track.pastHeading')}</h2>
            {past.map((o) => <PastRoundView key={o.id} order={o} />)}
          </section>
        ) : null}
      </div>
    );
  }

  const bottom = (
    <div className="vpage__bottom">
      <UnsentCard count={cartCount} nextRound={nextRound} href="/menu/cart" />
      {rounds > 0 ? (
        <RunningTotal
          aria-label={runningLabel}
          label={runningLabel}
          totalMinor={runningMinor}
          size="xl"
          note={t('track.runningNote')}
          action={<TextLink href="/menu/bill">{t('track.viewBill')}</TextLink>}
        />
      ) : null}
    </div>
  );

  return (
    <div className="vpage vpage--split">
      {head}
      {actions}
      {main}
      {bottom}
    </div>
  );
}

// ------------------------------------------------------------------ Call staff / Request bill
function ServicePair({
  services, svc, billAllowed, billingNow, billRequestedAt,
}: {
  services: ReadonlyArray<string>;
  svc: ReturnType<typeof useServiceRequests>;
  billAllowed: boolean;
  billingNow: boolean;
  billRequestedAt: string | null;
}) {
  const { t, has } = useI18n();
  const toast = useToast();
  const { openService } = useOverlays();
  // Offline, Call staff opens the service sheet (it explains the in-person
  // fallback) and Request the bill waits: it cannot be sent from here.
  const { offline } = useGuestConnection(true);
  const callOn = services.includes('call_staff');
  const billOn = services.includes('bill') && billAllowed;
  const call = svc.slots.get('call_staff')?.active ?? null;
  const billReq = svc.slots.get('bill')?.active ?? null;
  const billDone = billingNow || Boolean(billReq) || Boolean(billRequestedAt);

  if (!callOn && !billOn) return null;

  const send = async (type: 'call_staff' | 'bill') => {
    if (offline) { openService(); return; }
    const active = type === 'call_staff' ? call : billReq;
    if (active) {
      toast.show({ message: t(active.status === 'acknowledged' ? 'track.alreadySeen' : 'track.alreadySent', { time: clock(active.created_at) }), tone: 'info' });
      return;
    }
    try {
      const r = await svc.send(type);
      if (type === 'bill') toast.show({ message: r.existing ? t(r.seen ? 'help.existingSeen' : 'help.existing') : t('bill.requestedToast') });
      else toast.show({ message: r.existing ? t(r.seen ? 'help.existingSeen' : 'help.existing') : t('help.sentToast', { name: t('service.call_staff') }) });
    } catch (err) {
      toast.show({ message: `${t('help.failed')} · ${errorWords(t, has, err)}`, tone: 'error' });
    }
  };

  const lines: Array<{ key: string; ok: boolean; text: string }> = [];
  if (call) {
    lines.push({
      key: 'call',
      ok: call.status === 'acknowledged',
      text: call.status === 'acknowledged' ? t('track.callState.acknowledged') : t('track.callState.sent', { time: clock(call.created_at) }),
    });
  }
  if (billReq) {
    lines.push({
      key: 'bill',
      ok: billReq.status === 'acknowledged',
      text: billReq.status === 'acknowledged' ? t('track.billState.acknowledged') : t('track.billState.sent', { time: clock(billReq.created_at) }),
    });
  }

  return (
    <div>
      <div className={callOn && billOn ? 'pair' : 'pair vpair--one'}>
        {callOn ? (
          <Button
            variant="outline"
            size="lg"
            icon={call ? 'check' : 'bell'}
            loading={svc.busy === 'call_staff'}
            onClick={() => void send('call_staff')}
            data-service="call_staff"
            data-state={call?.status ?? 'idle'}
          >
            {t('service.call_staff')}
          </Button>
        ) : null}
        {billOn ? (
          billDone ? (
            <LinkButton href="/menu/bill" variant="outline" size="lg" icon="receipt" data-service="bill" data-state="requested">
              {billingNow ? t('track.billingShort') : t('track.viewBillShort')}
            </LinkButton>
          ) : (
            <Button
              variant="outline"
              size="lg"
              icon="receipt"
              loading={svc.busy === 'bill'}
              disabled={offline}
              onClick={() => void send('bill')}
              data-service="bill"
              data-state={offline ? 'offline' : 'idle'}
            >
              {t('service.bill')}
            </Button>
          )
        ) : null}
      </div>
      <div aria-live="polite">
        {lines.map((l) => (
          <p key={l.key} className={l.ok ? 'vstatus vstatus--ok' : 'vstatus'}>
            <Icon name={l.ok ? 'check-c' : 'clock'} />
            <span>{l.text}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
