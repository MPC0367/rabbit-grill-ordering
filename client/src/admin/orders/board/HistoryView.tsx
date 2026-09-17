// Board history: every round of one business date, newest first, read-only
// tickets (managers can still open the panel to correct a served dish).
import { useMemo, useState } from 'react';
import type { CatalogDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import { addDays } from '../../../../../shared/time.ts';
import { dateLabel } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { useResource } from '../../../lib/live.tsx';
import { qs } from '../../../lib/api.ts';
import { navigate, setQuery, useRoute } from '../../../lib/router.ts';
import { useNow } from '../../../lib/store.ts';
import {
  Button, DateRangeNav, EmptyState, FilterChips, normalizeSearch, Skeleton, StaffSearch,
} from '../../../ui/index.ts';
import { useStaff } from '../../shell/session.tsx';
import { errorText, tn, todayDate } from '../support.ts';
import { useBoardActions, type OrdersResponse } from './actions.ts';
import { matchesQuery, placementOf } from './model.ts';
import { OrderDetails } from './OrderDetails.tsx';
import { linesCarryConfirm, OrderTicket } from './OrderTicket.tsx';

type Outcome = 'all' | 'served' | 'open' | 'void';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function HistoryView() {
  const { t, lang, has } = useI18n();
  const { can } = useStaff();
  const { query } = useRoute();
  const now = useNow(60_000);
  const today = todayDate();
  const raw = query.get('date') ?? '';
  const date = ISO_DATE.test(raw) && raw <= today ? raw : today;
  const res = useResource<OrdersResponse>(`/api/staff/orders${qs({ scope: 'history', date, limit: 500 })}`, { topics: ['order.', 'line.'] });
  const needMenu = Boolean(res.data) && !res.data!.orders.every((o) => linesCarryConfirm(o.lines));
  const menu = useResource<CatalogDTO>(needMenu ? '/api/public/menu' : null, { topics: ['menu.'] });
  const alcoholItems = useMemo(() => new Set((menu.data?.items ?? []).filter((i) => i.alcohol).map((i) => i.id)), [menu.data]);
  const actions = useBoardActions(res);
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('all');
  const [details, setDetails] = useState<string | null>(null);

  const q = normalizeSearch(search);
  const rows = useMemo(() => (res.data?.orders ?? [])
    .map((o) => ({ order: o, placement: placementOf(o.lines) }))
    .filter((r) => matchesQuery(r.order, q, normalizeSearch))
    .filter((r) => outcome === 'all'
      || (outcome === 'served' && r.placement === 'served')
      || (outcome === 'void' && r.placement === 'void')
      || (outcome === 'open' && r.placement !== 'served' && r.placement !== 'void')), [res.data, q, outcome]);

  const all = res.data?.orders ?? [];
  const count = (o: Outcome) => all.filter((x) => {
    const p = placementOf(x.lines);
    return o === 'served' ? p === 'served' : o === 'void' ? p === 'void' : p !== 'served' && p !== 'void';
  }).length;

  const go = (d: string) => setQuery({ date: d === today ? null : d });
  const detailOrder: StaffOrderDTO | null = details ? all.find((o) => o.id === details) ?? null : null;

  return (
    <div className="ob ob--history">
      <div className="ob-histbar">
        <Button variant="ghost" size="staff" icon="chev-l" onClick={() => navigate('/admin/orders')}>
          {t('orders.history.back')}
        </Button>
        <DateRangeNav
          period="custom"
          label={date === today ? t('orders.history.today') : dateLabel(date, lang, { weekday: true })}
          range={dateLabel(date, lang, { weekday: true, year: true })}
          timeZone="Asia/Bangkok"
          onPrev={() => go(addDays(date, -1))}
          onNext={() => go(addDays(date, 1))}
          nextDisabled={date >= today}
          date={date}
          maxDate={today}
          onPickDate={(d) => go(d > today ? today : d)}
        />
      </div>
      <div className="toolbar-cq">
        <div className="toolbar" role="group" aria-label={t('orders.history.filters')}>
          <FilterChips<Outcome>
            className="ob-histchips"
            label={t('orders.history.outcome')}
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: 'all', label: t('common.all'), count: all.length },
              { value: 'open', label: t('orders.history.outcomeOpen'), count: count('open') },
              { value: 'served', label: t('common.staff.status.served'), count: count('served') },
              { value: 'void', label: t('orders.history.void'), count: count('void') },
            ]}
          />
          <StaffSearch label={t('common.board.search')} placeholder={t('common.board.searchShort')} value={search} onChange={setSearch} />
        </div>
      </div>

      {res.loading && !res.data ? (
        <div className="ob-histgrid" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} shape="block" height={200} />)}
        </div>
      ) : res.error && !res.data ? (
        <div className="ob-state">
          <EmptyState
            icon={res.error.code === 'forbidden' ? 'lock' : 'wifi-off'}
            title={t('orders.board.failedTitle')}
            headingLevel={2}
            action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}
          >
            {errorText(t, res.error)}
          </EmptyState>
        </div>
      ) : rows.length === 0 ? (
        <div className="ob-state">
          <EmptyState icon="orders" title={all.length ? t('orders.board.noMatch') : t('orders.history.empty')} headingLevel={2}>
            {all.length ? null : t('orders.history.emptyBody')}
          </EmptyState>
        </div>
      ) : (
        <>
          <p className="ob-histcount" role="status">{tn({ t, has }, 'orders.history.count', rows.length)}</p>
          <div className="ob-histgrid">
            {rows.map((r) => (
              <OrderTicket
                key={r.order.id}
                order={r.order}
                lines={r.order.lines}
                placement={r.placement}
                now={now}
                flags={r.order.finished_at ? [{ kind: 'station', label: t('orders.history.finished') }] : []}
                fresh={false}
                busy={null}
                conflict={actions.conflicts[r.order.id] ?? null}
                alcoholItems={alcoholItems}
                showMoney={can('orders.view_bill_values')}
                can={can}
                onAdvance={() => {}}
                onMore={(o) => setDetails(o.id)}
                onReview={actions.review}
                readOnly
              />
            ))}
          </div>
        </>
      )}

      {detailOrder ? (
        <OrderDetails
          key={detailOrder.id}
          order={detailOrder}
          can={can}
          busy={actions.busy[detailOrder.id] ?? null}
          conflict={actions.conflicts[detailOrder.id] ?? null}
          onReview={() => actions.review(detailOrder.id)}
          onClose={() => setDetails(null)}
          onTransition={actions.transition}
          onFinish={actions.finish}
        />
      ) : null}
    </div>
  );
}
