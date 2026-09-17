// The live fulfilment board (brief 19, 35; DESIGN §8.2, §10.16-10.18):
// floor strip, toolbar, five columns (one filtered list on tablets and
// phones), counted actions, the ⋯ details panel and Finish order.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogDTO, OrderLineDTO, StaffOrderDTO, TablesDTO } from '../../../../../shared/dto.ts';
import type { LineStatus } from '../../../../../shared/status.ts';
import { clock } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { useLive, useResource } from '../../../lib/live.tsx';
import { navigate, setQuery, useRoute } from '../../../lib/router.ts';
import { useMedia, useNow } from '../../../lib/store.ts';
import {
  attentionKinds, Banner, BOARD_STAGES, BoardColumn, BoardGrid, BoardStatusSwitch, BoardToolbar, Button, EmptyState,
  normalizeSearch, Skeleton, TableStrip, TextLink, useAnnounce, type BoardStage, type FloorTable, type TicketFlagSpec,
} from '../../../ui/index.ts';
import { useStaff } from '../../shell/session.tsx';
import AssistOrderPanel from '../AssistOrderPanel.tsx';
import {
  compareLabels, errorText, JUST_IN_MS, LATE_AFTER_MINUTES, minutesSince, readStation, SAFETY_REFRESH_MS,
  seatedLong, seatedShort, sumQty, writeStation, type StationPref,
} from '../support.ts';
import { useBoardActions, type BusyKind, type OrdersResponse } from './actions.ts';
import {
  matchesQuery, placementOf, readySince, sortOrders, tableOf, visibleLines, type Placement, type SortKey,
} from './model.ts';
import { OrderDetails } from './OrderDetails.tsx';
import { OrderTicket } from './OrderTicket.tsx';
import { ServedList } from './ServedList.tsx';
import { useNewRoundAlerts } from './alerts.ts';

interface Row { order: StaffOrderDTO; lines: OrderLineDTO[]; placement: Placement }

const SORTS: SortKey[] = ['oldest', 'newest', 'table', 'late'];

/** A panel action shows as busy on the ticket's primary button. */
function busyOf(kind: BusyKind | undefined): 'primary' | 'secondary' | null {
  if (!kind) return null;
  return kind === 'secondary' ? 'secondary' : 'primary';
}

export default function BoardView() {
  const { t } = useI18n();
  const { can } = useStaff();
  const { query } = useRoute();
  const live = useLive();
  const announce = useAnnounce();
  const now = useNow(15_000);
  const narrow = useMedia('(max-width: 1199px)');
  const phone = useMedia('(max-width: 767px)');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const res = useResource<OrdersResponse>('/api/staff/orders?scope=active', { topics: ['order.', 'line.'], intervalMs: SAFETY_REFRESH_MS });
  const canTables = can('tables.view');
  const tablesRes = useResource<TablesDTO>(canTables ? '/api/staff/tables' : null, {
    topics: ['table.', 'visit.', 'order.', 'line.', 'service.', 'portion.', 'bill.'],
    intervalMs: SAFETY_REFRESH_MS,
  });
  const menu = useResource<CatalogDTO>('/api/public/menu', { topics: ['menu.'] });
  const alcoholItems = useMemo(() => new Set((menu.data?.items ?? []).filter((i) => i.alcohol).map((i) => i.id)), [menu.data]);

  const actions = useBoardActions(res);

  // ---------------------------------------------------------------- filters (station persisted per device)
  const [station, setStationState] = useState<StationPref>(() => readStation());
  const setStation = (s: StationPref) => { setStationState(s); writeStation(s); };
  const table = query.get('table') ?? 'all';
  const setTable = (v: string) => setQuery({ table: v === 'all' ? null : v });
  const sort = (SORTS.includes(query.get('sort') as SortKey) ? query.get('sort') : 'oldest') as SortKey;
  const [showVoid, setShowVoid] = useState(false);
  const [search, setSearch] = useState('');
  const activeFilters = [station !== 'all', table !== 'all', sort !== 'oldest', showVoid, search.trim() !== ''].filter(Boolean).length;
  const filterSummary = [
    station === 'all' ? t('common.board.allStations') : t(`common.board.${station}`),
    table === 'all' ? null : t('common.table', { label: table }),
    sort === 'late' ? t('orders.sort.late', { n: LATE_AFTER_MINUTES }) : t(`orders.sort.${sort}`),
    search.trim() ? `“${search.trim()}”` : null,
  ].filter(Boolean).join(' · ');
  const [stage, setStage] = useState<BoardStage>('submitted');
  const [details, setDetails] = useState<{ id: string; startAt?: 'finish' } | null>(null);
  const [assist, setAssist] = useState<{ visitId: string; mode: 'assist' | 'recover' } | null>(null);
  const lastKnown = useRef(new Map<string, StaffOrderDTO>());

  const orders = useMemo(() => res.data?.orders ?? [], [res.data]);
  useEffect(() => { for (const o of orders) lastKnown.current.set(o.id, o); }, [orders]);

  const fresh = useNewRoundAlerts(orders, res.fetchedAt, live.state);

  const q = normalizeSearch(search);
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const o of orders) {
      if (table !== 'all' && tableOf(o) !== table && o.table_label !== table) continue;
      if (!matchesQuery(o, q, normalizeSearch)) continue;
      const lines = visibleLines(o, station);
      if (lines.length === 0) continue;
      out.push({ order: o, lines, placement: placementOf(lines) });
    }
    return out;
  }, [orders, table, q, station]);

  const stationCounts = useMemo(() => {
    const c = { kitchen: 0, bar: 0 };
    for (const o of orders) {
      for (const s of ['kitchen', 'bar'] as const) {
        const p = placementOf(visibleLines(o, s));
        if ((BOARD_STAGES as readonly string[]).includes(p)) c[s] += 1;
      }
    }
    return c;
  }, [orders]);

  const groups = useMemo(() => {
    const g: Record<BoardStage, Row[]> = { submitted: [], accepted: [], preparing: [], almost_done: [], ready: [] };
    const served: Row[] = [];
    const voided: Row[] = [];
    for (const r of rows) {
      if (r.placement === 'served') served.push(r);
      else if (r.placement === 'void') voided.push(r);
      else {
        if (sort === 'late' && minutesSince(r.order.submitted_at, now) <= LATE_AFTER_MINUTES) continue;
        g[r.placement].push(r);
      }
    }
    const sorted = (list: Row[]) => {
      const byId = new Map(list.map((r) => [r.order.id, r]));
      return sortOrders(list.map((r) => r.order), sort).map((o) => byId.get(o.id)!);
    };
    for (const s of BOARD_STAGES) g[s] = sorted(g[s]);
    // The pass reads in the order food came up.
    if (sort === 'oldest' || sort === 'late') {
      g.ready.sort((a, b) => (readySince(a.lines) ?? '').localeCompare(readySince(b.lines) ?? ''));
    }
    return { columns: g, served: sorted(served), voided: sorted(voided) };
  }, [rows, sort, now]);

  const counts = Object.fromEntries(BOARD_STAGES.map((s) => [s, groups.columns[s].length])) as Record<BoardStage, number>;

  // ---------------------------------------------------------------- floor strip
  const floor: FloorTable[] = useMemo(() => (tablesRes.data?.tables ?? [])
    .slice()
    .sort((a, b) => a.sort - b.sort || compareLabels(a.label, b.label))
    .map((tb) => ({
      id: tb.id,
      label: tb.label,
      state: tb.state,
      duration: tb.visit && tb.state === 'dining' ? seatedShort(tb.visit.seated_at, now) : undefined,
      durationLong: tb.visit && tb.state === 'dining' ? seatedLong(t, tb.visit.seated_at, now) : undefined,
      attention: attentionKinds(tb.attention),
    })), [tablesRes.data, now, t]);
  const selectedTable = tablesRes.data?.tables.find((tb) => tb.label === table) ?? null;

  const tableOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const tb of tablesRes.data?.tables ?? []) labels.add(tb.label);
    for (const o of orders) labels.add(tableOf(o));
    if (table !== 'all') labels.add(table);
    return [
      { value: 'all', label: t('common.all') },
      ...[...labels].sort(compareLabels).map((l) => ({ value: l, label: l })),
    ];
  }, [tablesRes.data, orders, table, t]);

  // ---------------------------------------------------------------- flags
  const oldestNew = groups.columns.submitted.length > 1
    ? groups.columns.submitted.reduce((a, b) => (a.order.submitted_at <= b.order.submitted_at ? a : b)).order.id
    : null;
  const flagsFor = useCallback((r: Row): TicketFlagSpec[] => {
    const f: TicketFlagSpec[] = [];
    const o = r.order;
    if (r.placement === 'submitted') {
      if (o.id === oldestNew) f.push({ kind: 'oldest' });
      if (now - new Date(o.submitted_at).getTime() < JUST_IN_MS) f.push({ kind: 'just' });
    }
    if (r.placement === 'ready') {
      const at = readySince(r.lines);
      const m = at ? minutesSince(at, now) : 0;
      f.push({ kind: 'ready', minutes: m >= 1 ? m : undefined });
    }
    if (o.source === 'manual_recovery') f.push({ kind: 'station', label: t('orders.flag.paper') });
    else if (o.source === 'staff') f.push({ kind: 'station', label: t('orders.flag.staff') });
    const hidden = o.lines.filter((l) => !r.lines.includes(l) && l.status !== 'rejected' && l.status !== 'cancelled');
    if (station !== 'all' && hidden.length > 0) {
      f.push({ kind: 'station', label: t(`orders.flag.more.${station === 'kitchen' ? 'bar' : 'kitchen'}`, { n: sumQty(hidden) }) });
    } else if (station === 'all' && r.lines.every((l) => l.station === 'bar')) {
      f.push({ kind: 'station', label: t('common.board.bar') });
    }
    return f;
  }, [oldestNew, now, station, t]);

  // ---------------------------------------------------------------- actions
  const onAdvance = useCallback((order: StaffOrderDTO, lines: OrderLineDTO[], to: LineStatus, which: 'primary' | 'secondary') => {
    void actions.transition(order, lines, to, { kind: which });
  }, [actions.transition]);
  const onMore = useCallback((order: StaffOrderDTO) => setDetails({ id: order.id }), []);
  const closeDetails = useCallback(() => {
    setDetails(null);
    // A finished round leaves the board with its ⋯ button: give keyboard users a place to carry on.
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const spots = Array.from(document.querySelectorAll<HTMLElement>('.boardtabs button[aria-pressed="true"], .board .col--ready h2, .board .col h2'));
      const spot = spots.find((el) => el.offsetParent !== null);
      if (!spot) return;
      if (spot.tagName === 'H2') spot.setAttribute('tabindex', '-1');
      spot.focus({ preventScroll: true });
    }, 120);
  }, []);
  const onFinish = useCallback((order: StaffOrderDTO) => setDetails({ id: order.id, startAt: 'finish' }), []);
  const detailOrder = details ? (orders.find((o) => o.id === details.id) ?? lastKnown.current.get(details.id) ?? null) : null;

  const ticket = (r: Row) => (
    <OrderTicket
      key={r.order.id}
      order={r.order}
      lines={r.lines}
      placement={r.placement}
      now={now}
      flags={flagsFor(r)}
      fresh={fresh.has(r.order.id)}
      busy={busyOf(actions.busy[r.order.id])}
      conflict={actions.conflicts[r.order.id] ?? null}
      alcoholItems={alcoholItems}
      showMoney={can('orders.view_bill_values')}
      can={can}
      onAdvance={onAdvance}
      onMore={onMore}
      onReview={actions.review}
    />
  );

  // ---------------------------------------------------------------- render
  const readyHelp = (
    <>
      {t('orders.board.readyHelp')}{' '}
      <TextLink href="/admin/orders?view=history">{t('orders.history.open')}</TextLink>
    </>
  );
  const loading = res.loading && !res.data;
  const shownStages = narrow ? [stage] : BOARD_STAGES;

  const filtered = Boolean(q) || table !== 'all' || sort === 'late';
  const emptyFor = (s: BoardStage) => (filtered
    ? <EmptyState compact className="col__empty" icon="filter" title={t('orders.board.noMatch')} />
    : s === 'ready'
      ? <EmptyState compact className="col__empty" icon="cloche" title={t('common.board.empty')} />
      : undefined);

  const statusSwitch = (
    <BoardStatusSwitch
      counts={counts}
      value={stage}
      onChange={(s) => { setStage(s); announce(t('orders.board.showing', { status: t(`common.staff.status.${s}`), n: counts[s] })); }}
    />
  );

  let board;
  if (loading) {
    board = (
      <BoardGrid layout={narrow ? 'single' : 'columns'} aria-busy="true">
        {shownStages.map((s) => (
          <BoardColumn key={s} stage={s} count={0} current={s === stage} empty={
            <div className="ob-skel" role="status" aria-label={t('common.loading')}>
              <Skeleton shape="block" height={188} />
              <Skeleton shape="block" height={132} />
            </div>
          } help={null} />
        ))}
      </BoardGrid>
    );
  } else if (res.error && !res.data) {
    const denied = res.error.code === 'forbidden' || res.error.code === 'auth_required';
    board = (
      <div className="ob-state">
        <EmptyState
          icon={denied ? 'lock' : 'wifi-off'}
          title={denied ? t('orders.board.deniedTitle') : t('orders.board.failedTitle')}
          action={denied ? null : <Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}
          headingLevel={2}
        >
          {denied ? t('orders.board.deniedBody') : `${errorText(t, res.error)} ${t('orders.board.paperFallback')}`}
        </EmptyState>
      </div>
    );
  } else {
    board = (
      <BoardGrid layout={narrow ? 'single' : 'columns'}>
        {shownStages.map((s) => (
          <BoardColumn
            key={s}
            stage={s}
            count={groups.columns[s].length}
            current={s === stage}
            help={s === 'ready' ? readyHelp : undefined}
            empty={s === 'ready' && groups.served.length > 0 ? <span hidden /> : emptyFor(s)}
          >
            {groups.columns[s].map(ticket)}
            {s === 'ready' && groups.served.length > 0 && groups.columns.ready.length === 0 ? emptyFor(s) : null}
            {s === 'ready' ? (
              <ServedList
                orders={groups.served.map((r) => r.order)}
                can={can}
                busy={actions.busy}
                onFinish={onFinish}
                onMore={onMore}
              />
            ) : null}
          </BoardColumn>
        ))}
      </BoardGrid>
    );
  }

  return (
    <div className="ob">
      {canTables && !phone ? (
        <TableStrip
          tables={floor}
          title={t('common.floor.title')}
          selectedId={selectedTable?.id ?? null}
          onSelect={(id) => {
            const tb = tablesRes.data?.tables.find((x) => x.id === id);
            if (tb) setTable(table === tb.label ? 'all' : tb.label);
          }}
          openHref="/admin/tables"
        />
      ) : null}

      {selectedTable ? (
        <div className="ob-focus" role="region" aria-label={t('orders.focus.label', { table: selectedTable.label })}>
          <p className="ob-focus__t">
            <b>{t('common.table', { label: selectedTable.label })}</b>
            <span>
              {t(`table.${selectedTable.state}`)}
              {selectedTable.visit ? ` · ${t('orders.focus.seated', { time: clock(selectedTable.visit.seated_at), duration: seatedLong(t, selectedTable.visit.seated_at, now) })}` : ''}
            </span>
          </p>
          <div className="ob-focus__acts">
            {selectedTable.visit && selectedTable.visit.status === 'open' && can('orders.assist') ? (
              <Button variant="ghost" size="staff" icon="plus" opensDialog onClick={() => setAssist({ visitId: selectedTable.visit!.id, mode: 'assist' })}>
                {t('orders.focus.assist')}
              </Button>
            ) : null}
            {selectedTable.visit && can('orders.recover_manual') ? (
              <Button variant="ghost" size="staff" icon="pad" opensDialog onClick={() => setAssist({ visitId: selectedTable.visit!.id, mode: 'recover' })}>
                {t('orders.focus.recover')}
              </Button>
            ) : null}
            <Button variant="ghost" size="staff" icon="x" onClick={() => setTable('all')}>{t('orders.focus.clear')}</Button>
          </div>
        </div>
      ) : null}

      {phone && !loading && res.data ? statusSwitch : null}

      {phone ? (
        <div className="ob-mfilters">
          <Button
            variant="outline"
            size="staff"
            icon="filter"
            iconEnd="chev-d"
            aria-expanded={filtersOpen}
            aria-controls="ob-filters"
            className={filtersOpen ? 'is-open' : undefined}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            {t('orders.filters.toggle')}
            {activeFilters > 0 ? ` · ${activeFilters}` : ''}
          </Button>
          <p className="ob-mfilters__sum">{filterSummary}</p>
        </div>
      ) : null}

      {!phone || filtersOpen ? (
      <div id="ob-filters">
      <BoardToolbar
        stationCounts={stationCounts}
        station={station}
        onStation={setStation}
        tables={tableOptions}
        table={table}
        onTable={setTable}
        sorts={SORTS.map((s) => ({ value: s, label: s === 'late' ? t('orders.sort.late', { n: LATE_AFTER_MINUTES }) : t(`orders.sort.${s}`) }))}
        sort={sort}
        onSort={(v) => setQuery({ sort: v === 'oldest' ? null : v })}
        showExceptions={showVoid}
        onShowExceptions={setShowVoid}
        query={search}
        onQuery={setSearch}
      />
      </div>
      ) : null}

      {res.stale ? (
        <Banner
          variant="warning"
          staff
          className="ob-banner"
          title={t('orders.board.staleTitle', { time: res.fetchedAt ? clock(new Date(res.fetchedAt).toISOString()) : '—' })}
          action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}
        >
          {t('orders.board.paperFallback')}
        </Banner>
      ) : null}

      {narrow && !phone && !loading && res.data ? statusSwitch : null}

      {board}

      {showVoid && res.data ? (
        <section className="ob-void" aria-labelledby="ob-void-h">
          <h2 id="ob-void-h" className="ob-void__h">
            {t('orders.void.title')} <span className="served__n">{groups.voided.length}</span>
          </h2>
          {groups.voided.length === 0 ? (
            <p className="ob-void__empty">{t('orders.void.empty')}</p>
          ) : (
            <div className="ob-void__grid">
              {groups.voided.map((r) => ticket(r))}
            </div>
          )}
        </section>
      ) : null}

      {narrow ? (
      <p className="ob-foot">
        <button type="button" className="textlink" onClick={() => navigate(`/admin/orders?view=history`)}>
          {t('orders.history.open')}
        </button>
      </p>
      ) : null}

      {detailOrder ? (
        <OrderDetails
          key={detailOrder.id}
          order={detailOrder}
          can={can}
          busy={actions.busy[detailOrder.id] ?? null}
          conflict={actions.conflicts[detailOrder.id] ?? null}
          onReview={() => actions.review(detailOrder.id)}
          onClose={closeDetails}
          onTransition={actions.transition}
          onFinish={actions.finish}
          startAt={details?.startAt}
        />
      ) : null}

      {assist ? (
        <AssistOrderPanel
          visitId={assist.visitId}
          mode={assist.mode}
          onClose={() => setAssist(null)}
          onDone={() => { void res.refresh(); void tablesRes.refresh(); }}
        />
      ) : null}
    </div>
  );
}
