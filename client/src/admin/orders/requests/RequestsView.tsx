// Requests tab (brief 22, 44A): the table service queue and the weighed-cut
// queue, oldest first, with versioned actions and a finished-today toggle.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CatalogDTO, PortionRequestDTO, ServiceRequestDTO } from '../../../../../shared/dto.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { useResource, type Resource } from '../../../lib/live.tsx';
import { qs } from '../../../lib/api.ts';
import { clock } from '../../../lib/format.ts';
import { useNow } from '../../../lib/store.ts';
import {
  Banner, Button, CheckButton, EmptyState, SectionHeader, Skeleton, useAnnounce,
} from '../../../ui/index.ts';
import { useStaff } from '../../shell/session.tsx';
import AssistOrderPanel from '../AssistOrderPanel.tsx';
import { errorText, SAFETY_REFRESH_MS, todayDate } from '../support.ts';
import { PortionCard, PortionDoneRow } from './PortionCard.tsx';
import { ServiceCard, ServiceDoneRow } from './ServiceCard.tsx';

interface ServiceList { requests: ServiceRequestDTO[]; server_time?: string }
interface PortionList { requests: PortionRequestDTO[]; server_time?: string }

type Conflicts = Record<string, { by: string; at: string }>;

/** Replace one request in a list resource (optimistic view of the server's answer). */
function useReplace<X extends { id: string }>(res: Resource<{ requests: X[] }>) {
  return useCallback((next: X) => {
    res.mutate((prev) => (prev ? { ...prev, requests: prev.requests.map((r) => (r.id === next.id ? next : r)) } : prev as unknown as { requests: X[] }));
    void res.refresh();
  }, [res.mutate, res.refresh]);
}

function QueueSection({ id, title, count, description, children }: { id: string; title: string; count: number | null; description?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="rqsec" aria-labelledby={id}>
      <SectionHeader
        titleId={id}
        title={<>{title}{count !== null ? <span className="rqsec__n" aria-label={t('requests.openCount', { n: count })}>{count}</span> : null}</>}
        description={description}
      />
      {children}
    </section>
  );
}

type QueueRes = Pick<Resource<unknown>, 'loading' | 'data' | 'error' | 'refresh'>;

function QueueState({ res, denied, deniedText, emptyTitle, emptyBody, icon }: {
  res: QueueRes;
  denied: boolean;
  deniedText: string;
  emptyTitle: string;
  emptyBody: string;
  icon: 'hand' | 'scale';
}) {
  const { t } = useI18n();
  if (denied) return <EmptyState compact icon="lock" title={t('requests.deniedTitle')} headingLevel={3}>{deniedText}</EmptyState>;
  if (res.loading && !res.data) {
    return (
      <div className="rqlist" role="status" aria-label={t('common.loading')}>
        <Skeleton shape="block" height={150} />
        <Skeleton shape="block" height={150} />
      </div>
    );
  }
  if (res.error && !res.data) {
    return (
      <EmptyState compact icon="wifi-off" title={t('orders.board.failedTitle')} headingLevel={3}
        action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}
      >
        {errorText(t, res.error)}
      </EmptyState>
    );
  }
  return <EmptyState compact icon={icon} title={emptyTitle} headingLevel={3}>{emptyBody}</EmptyState>;
}

export default function RequestsView() {
  const { t, pick } = useI18n();
  const { can } = useStaff();
  const now = useNow(15_000);
  const [showDone, setShowDone] = useState(false);
  const [assistVisit, setAssistVisit] = useState<string | null>(null);
  const today = todayDate();

  const canService = can('service.handle');
  const canPortions = can('portions.quote');

  const service = useResource<ServiceList>(canService ? '/api/staff/service?scope=active' : null, { topics: ['service.', 'visit.'], intervalMs: SAFETY_REFRESH_MS });
  const portions = useResource<PortionList>(canPortions ? '/api/staff/portions?scope=open' : null, { topics: ['portion.', 'visit.', 'order.'], intervalMs: SAFETY_REFRESH_MS });
  const serviceAll = useResource<ServiceList>(canService && showDone ? `/api/staff/service${qs({ scope: 'all', date: today })}` : null, { topics: ['service.'] });
  const portionsAll = useResource<PortionList>(canPortions && showDone ? `/api/staff/portions${qs({ scope: 'all', date: today })}` : null, { topics: ['portion.'] });
  const menu = useResource<CatalogDTO>(canPortions ? '/api/public/menu' : null, { topics: ['menu.'] });
  const items = useMemo(() => new Map((menu.data?.items ?? []).map((i) => [i.id, i])), [menu.data]);

  const [serviceConflicts, setServiceConflicts] = useState<Conflicts>({});
  const [portionConflicts, setPortionConflicts] = useState<Conflicts>({});
  const replaceService = useReplace(service);
  const replacePortion = useReplace(portions);

  // A lapsed quote turns into "expired" on the server's next read: refresh at the moment it lapses.
  const nextExpiry = useMemo(() => {
    const times = (portions.data?.requests ?? [])
      .map((r) => (r.quote && r.quote.status === 'active' ? new Date(r.quote.expires_at).getTime() : Infinity))
      .filter((x) => x > Date.now());
    return times.length ? Math.min(...times) : null;
  }, [portions.data]);
  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = setTimeout(() => void portions.refresh(), Math.min(2_147_000_000, nextExpiry - Date.now() + 800));
    return () => clearTimeout(timer);
  }, [nextExpiry, portions.refresh]);

  // The shell chimes for new requests; this page says what arrived (once, never on the first load).
  const announce = useAnnounce();
  const seen = useRef<{ service: Set<string> | null; portions: Set<string> | null }>({ service: null, portions: null });
  useEffect(() => {
    const list = service.data?.requests;
    if (!list) return;
    if (!seen.current.service) { seen.current.service = new Set(list.map((r) => r.id)); return; }
    const fresh = list.filter((r) => !seen.current.service!.has(r.id) && r.status === 'sent');
    for (const r of list) seen.current.service.add(r.id);
    if (fresh.length === 1) announce(t('requests.alert.newService', { type: t(`service.${fresh[0].type}`), table: fresh[0].table_label }));
    else if (fresh.length > 1) announce(t('requests.openCount', { n: fresh.length }));
  }, [service.data, announce, t]);
  useEffect(() => {
    const list = portions.data?.requests;
    if (!list) return;
    if (!seen.current.portions) { seen.current.portions = new Set(list.map((r) => r.id)); return; }
    const fresh = list.filter((r) => !seen.current.portions!.has(r.id) && r.status === 'requested');
    for (const r of list) seen.current.portions.add(r.id);
    if (fresh.length === 1) announce(t('requests.alert.newPortion', { table: fresh[0].table_label, name: pick(fresh[0].item_name).text }));
    else if (fresh.length > 1) announce(t('requests.openCount', { n: fresh.length }));
  }, [portions.data, announce, t, pick]);

  const serviceQueue = useMemo(() => [...(service.data?.requests ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)), [service.data]);
  const portionQueue = useMemo(() => [...(portions.data?.requests ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)), [portions.data]);
  const serviceDone = (serviceAll.data?.requests ?? []).filter((r) => r.status === 'completed' || r.status === 'cancelled');
  const portionDone = (portionsAll.data?.requests ?? []).filter((r) => !['requested', 'quoted'].includes(r.status));

  const staleMark = (set: (fn: (c: Conflicts) => Conflicts) => void, id: string, current: { acknowledged_by?: string | null; completed_by?: string | null; cancelled_by?: string | null; updated_at?: string; acknowledged_at?: string | null; completed_at?: string | null; cancelled_at?: string | null } | null) => {
    const by = current?.cancelled_by ?? current?.completed_by ?? current?.acknowledged_by ?? t('orders.conflict.someone');
    const at = current?.cancelled_at ?? current?.completed_at ?? current?.acknowledged_at ?? current?.updated_at ?? new Date().toISOString();
    set((c) => ({ ...c, [id]: { by, at } }));
  };

  const review = (set: (fn: (c: Conflicts) => Conflicts) => void, id: string, res: Pick<Resource<unknown>, 'refresh'>) => {
    set((c) => {
      const next = { ...c };
      delete next[id];
      return next;
    });
    void res.refresh();
  };

  const serviceSection = (
    <QueueSection
      key="service"
      id="rq-service"
      title={t('requests.service.title')}
      count={canService && service.data ? serviceQueue.length : null}
      description={t('requests.service.desc')}
    >
      {canService && serviceQueue.length > 0 ? (
        <div className="rqlist">
          {serviceQueue.map((r) => (
            <ServiceCard
              key={r.id}
              req={r}
              now={now}
              can={can}
              onChanged={replaceService}
              onStale={(cur) => { staleMark(setServiceConflicts, r.id, cur); if (cur) replaceService(cur); else void service.refresh(); }}
              conflict={serviceConflicts[r.id] ?? null}
              onReview={() => review(setServiceConflicts, r.id, service)}
              onAssist={setAssistVisit}
            />
          ))}
        </div>
      ) : (
        <QueueState
          res={service}
          denied={!canService}
          deniedText={t('requests.service.denied')}
          emptyTitle={t('requests.service.empty')}
          emptyBody={t('requests.service.emptyBody')}
          icon="hand"
        />
      )}
      {canService && showDone ? (
        <div className="rqdone-wrap">
          <h3 className="rqdone__h">{t('requests.doneToday', { n: serviceDone.length })}</h3>
          {serviceDone.length ? <ul className="rqdone-list">{serviceDone.map((r) => <ServiceDoneRow key={r.id} req={r} />)}</ul>
            : <p className="rqdone__empty">{serviceAll.loading ? t('common.loading') : t('requests.doneNone')}</p>}
        </div>
      ) : null}
    </QueueSection>
  );

  const portionSection = (
    <QueueSection
      key="portions"
      id="rq-portions"
      title={t('requests.portion.title')}
      count={canPortions && portions.data ? portionQueue.length : null}
      description={t('requests.portion.desc')}
    >
      {canPortions && portionQueue.length > 0 ? (
        <div className="rqlist">
          {portionQueue.map((r) => (
            <PortionCard
              key={r.id}
              req={r}
              item={items.get(r.item_id)}
              now={now}
              can={can}
              onChanged={replacePortion}
              onStale={(cur) => {
                setPortionConflicts((c) => ({ ...c, [r.id]: { by: t('orders.conflict.someone'), at: cur?.updated_at ?? new Date().toISOString() } }));
                if (cur) replacePortion(cur); else void portions.refresh();
              }}
              conflict={portionConflicts[r.id] ?? null}
              onReview={() => review(setPortionConflicts, r.id, portions)}
            />
          ))}
        </div>
      ) : (
        <QueueState
          res={portions}
          denied={!canPortions}
          deniedText={t('requests.portion.denied')}
          emptyTitle={t('requests.portion.empty')}
          emptyBody={t('requests.portion.emptyBody')}
          icon="scale"
        />
      )}
      {canPortions && showDone ? (
        <div className="rqdone-wrap">
          <h3 className="rqdone__h">{t('requests.doneToday', { n: portionDone.length })}</h3>
          {portionDone.length ? <ul className="rqdone-list">{portionDone.map((r) => <PortionDoneRow key={r.id} req={r} />)}</ul>
            : <p className="rqdone__empty">{portionsAll.loading ? t('common.loading') : t('requests.doneNone')}</p>}
        </div>
      ) : null}
    </QueueSection>
  );

  // The queue this role works first leads (kitchen: cuts to weigh).
  const sections = canService || !canPortions ? [serviceSection, portionSection] : [portionSection, serviceSection];
  const staleAt = service.stale ? service.fetchedAt : portions.stale ? portions.fetchedAt : null;

  return (
    <div className="rqpage">
      <div className="toolbar-cq">
        <div className="toolbar rq-toolbar" role="group" aria-label={t('requests.filters')}>
          <CheckButton
            label={t('requests.showDone')}
            checked={showDone}
            onChange={setShowDone}
          />
          {canService ? <p className="rq-toolbar__note">{t('requests.orderNote')}</p> : null}
        </div>
      </div>
      {staleAt ? (
        <Banner
          variant="warning"
          staff
          className="ob-banner"
          title={t('orders.board.staleTitle', { time: clock(new Date(staleAt).toISOString()) })}
          action={<Button variant="outline" size="staff" icon="refresh" onClick={() => { void service.refresh(); void portions.refresh(); }}>{t('common.retry')}</Button>}
        >
          {t('requests.staleBody')}
        </Banner>
      ) : null}
      <div className="rqgrid">{sections}</div>
      {assistVisit ? (
        <AssistOrderPanel visitId={assistVisit} mode="assist" onClose={() => setAssistVisit(null)} />
      ) : null}
    </div>
  );
}
