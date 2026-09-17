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
  normalizeSearch, Skeleton, TableStrip, TextLink, useAnnounce, useToast, type BoardStage, type FloorTable, type TicketFlagSpec,
} from '../../../ui/index.ts';
import { useStaff } from '../../shell/session.tsx';
import AssistOrderPanel from '../AssistOrderPanel.tsx';
import {
  compareLabels, errorText, JUST_IN_MS, LATE_AFTER_MINUTES, minutesSince, readStation, SAFETY_REFRESH_MS,
  seatedLong, seatedShort, sumQty, writeStation, type StationPref,
} from '../support.ts';
import { useBoardActions, type BusyKind, type OrdersResponse } from './actions.ts';
import {
  matchesQuery, placementOf, readyPartOf, readyRoundCount, readySince, sortOrders, tableOf, visibleLines,
  type Placement, type SortKey,
} from './model.ts';
import { OrderDetails } from './OrderDetails.tsx';
import { linesCarryConfirm, OrderTicket } from './OrderTicket.tsx';
import { ReadyPartList, type ReadyPart } from './ReadyParts.tsx';
import { ServedList } from './ServedList.tsx';
import { useNewRoundAlerts } from './alerts.ts';

interface Row { order: StaffOrderDTO; lines: OrderLineDTO[]; placement: Placement }

const SORTS: SortKey[] = ['oldest', 'newest', 'table', 'late'];

/** A panel action shows as busy on the ticket's primary button; serving a ready part, on its serve button. */
function busyOf(kind: BusyKind | undefined): 'primary' | 'secondary' | null {
  if (!kind) return null;
  return kind === 'secondary' || kind === 'part' ? 'secondary' : 'primary';
}

function isStage(v: string | null): v is BoardStage {
  return v !== null && (BOARD_STAGES as readonly string[]).includes(v);
}

const shown = (el: Element | null | undefined): el is HTMLElement => Boolean(el) && (el as HTMLElement).offsetParent !== null;

/** Focus without jumping the page for touch users; keyboard users get it scrolled into view. */
function focusCalm(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex') && !el.matches('button, a[href], input, select, textarea')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  let keyboard = false;
  try { keyboard = el.matches(':focus-visible'); } catch { /* old engines */ }
  if (keyboard) el.scrollIntoView({ block: 'nearest' });
}

/** Where focus was before a ticket action: the column and position, for when the ticket leaves it. */
interface FocusOrigin { column: HTMLElement | null; index: number }

function focusOrigin(orderId: string): FocusOrigin {
  const ticket = document.getElementById(`ticket-${orderId}`);
  const column = ticket?.closest<HTMLElement>('.col') ?? null;
  const list = column ? Array.from(column.querySelectorAll('.ticket')) : [];
  return { column, index: ticket ? list.indexOf(ticket) : -1 };
}

/**
 * After an action, a ticket often re-mounts in another column and the button
 * that had focus is gone (WCAG 2.4.3). Put focus on the ticket's next action,
 * else the ticket, else the ticket now at the same place in the old column,
 * else that column's heading, else the status switch.
 */
function restoreFocus(orderId: string, from: FocusOrigin): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const ticket = document.getElementById(`ticket-${orderId}`);
    const next = ticket?.querySelector<HTMLElement>('.ticket__actions .btn:not([aria-disabled="true"])');
    if (shown(next)) { focusCalm(next); return; }
    if (shown(ticket)) { focusCalm(ticket); return; }
    const col = from.column?.isConnected ? from.column : null;
    if (col) {
      const list = Array.from(col.querySelectorAll<HTMLElement>('.ticket'));
      const same = list[Math.min(Math.max(from.index, 0), list.length - 1)];
      const btn = same?.querySelector<HTMLElement>('.ticket__actions .btn:not([aria-disabled="true"])');
      if (shown(btn)) { focusCalm(btn); return; }
      if (shown(same)) { focusCalm(same); return; }
      const head = col.querySelector<HTMLElement>('.col__head h2');
      if (shown(head)) { focusCalm(head); return; }
    }
    const pressed = document.querySelector<HTMLElement>('.boardtabs button[aria-pressed="true"]');
    if (shown(pressed)) focusCalm(pressed);
  }));
}

export default function BoardView() {
  const { t } = useI18n();
  const { can, me } = useStaff();
  const { query } = useRoute();
  const live = useLive();
  const announce = useAnnounce();
  const toast = useToast();
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
  // Lines carry their own staff-confirmation snapshot once the server sends it;
  // until then the live menu's alcohol flag stands in (D-FX-OPS-02).
  const needMenu = Boolean(res.data) && !res.data!.orders.every((o) => linesCarryConfirm(o.lines));
  const menu = useResource<CatalogDTO>(needMenu ? '/api/public/menu' : null, { topics: ['menu.'] });
  const alcoholItems = useMemo(() => new Set((menu.data?.items ?? []).filter((i) => i.alcohol).map((i) => i.id)), [menu.data]);

  const actions = useBoardActions(res);

  // ---------------------------------------------------------------- filters (station persisted per device)
  const [station, setStationState] = useState<StationPref>(() => readStation(me.user.role));
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
  // The one status shown on tablets and phones. `?stage=` opens a status
  // directly (Overview's ready card); a tap writes it back to the address.
  const stageParam = query.get('stage');
  const queryStage = isStage(stageParam) ? stageParam : null;
  const [stage, setStageState] = useState<BoardStage>(queryStage ?? 'submitted');
  useEffect(() => { if (queryStage) setStageState(queryStage); }, [queryStage]);
  const setStage = useCallback((s: BoardStage) => {
    setStageState(s);
    setQuery({ stage: s === 'submitted' ? null : s });
  }, []);
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
    // Ready dishes of rounds that sit in an earlier column also wait at the pass.
    const parts: ReadyPart[] = [];
    for (const s of BOARD_STAGES) {
      if (s === 'ready') continue;
      for (const r of g[s]) {
        const ready = readyPartOf(r.lines, r.placement);
        if (ready.length === 0) continue;
        const rest = r.lines.filter((l) => !ready.includes(l) && l.status !== 'served' && l.status !== 'rejected' && l.status !== 'cancelled');
        parts.push({ order: r.order, ready, rest, placement: s });
      }
    }
    // The pass reads in the order food came up.
    const byReady = <X,>(key: (x: X) => string | null) => (a: X, b: X) => (key(a) ?? '').localeCompare(key(b) ?? '');
    parts.sort(byReady((p) => readySince(p.ready)));
    if (sort === 'oldest' || sort === 'late') {
      g.ready.sort(byReady((r) => readySince(r.lines)));
    }
    return { columns: g, parts, served: sorted(served), voided: sorted(voided) };
  }, [rows, sort, now]);

  const counts = Object.fromEntries(BOARD_STAGES.map((s) => [s, groups.columns[s].length])) as Record<BoardStage, number>;
  // Every round with a dish at the pass counts once, so Ready agrees with Overview.
  counts.ready = readyRoundCount(BOARD_STAGES.flatMap((s) => groups.columns[s]));

  // Tablets and phones: a table picked from elsewhere (?table=) opens on the
  // first status that has its rounds, unless the address names one.
  const pickedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!res.data || pickedFor.current === table) return;
    const first = pickedFor.current === null;
    pickedFor.current = table;
    if (first && (queryStage || table === 'all')) return;
    if (counts[stage] > 0) return;
    const target = BOARD_STAGES.find((s) => counts[s] > 0);
    if (target) setStageState(target);
  }, [res.data, table, queryStage, counts, stage]);

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
  // A ticket asked to be found (from a ready part or a "moved" toast): focus it once it is on screen.
  const locate = useRef<string | null>(null);
  const [locateTick, setLocateTick] = useState(0);
  const showTicket = useCallback((orderId: string, where: BoardStage) => {
    if (narrow) setStage(where);
    locate.current = orderId;
    setLocateTick((n) => n + 1);
  }, [narrow, setStage]);
  useEffect(() => {
    const id = locate.current;
    if (!id) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`ticket-${id}`);
      if (!shown(el)) return;
      locate.current = null;
      el.setAttribute('tabindex', '-1');
      el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
      el.classList.remove('ob-located');
      void el.offsetWidth; // restart the outline pulse
      el.classList.add('ob-located');
      setTimeout(() => el.classList.remove('ob-located'), 1600);
    });
    return () => cancelAnimationFrame(raf);
  }, [locateTick, stage]);

  const shownStageRef = useRef<BoardStage | null>(null);
  shownStageRef.current = narrow ? stage : null;
  const stationRef = useRef(station);
  stationRef.current = station;

  const afterMove = useCallback((order: StaffOrderDTO, from: FocusOrigin, updated: StaffOrderDTO[]) => {
    const next = updated.find((o) => o.id === order.id);
    const showing = shownStageRef.current;
    if (next && showing) {
      // One status at a time: say where the ticket went, with a way to follow it.
      const lines = visibleLines(next, stationRef.current);
      const p = lines.length ? placementOf(lines) : 'void';
      if (p !== showing && isStage(p)) {
        toast.show({
          message: t('orders.toast.moved', { table: tableOf(next), status: t(`common.staff.status.${p}`) }),
          tone: 'info',
          action: { label: t('orders.toast.show'), onClick: () => showTicket(next.id, p) },
        });
      }
    }
    restoreFocus(order.id, from);
  }, [showTicket, t, toast]);

  const onAdvance = useCallback((order: StaffOrderDTO, lines: OrderLineDTO[], to: LineStatus, which: 'primary' | 'secondary') => {
    const from = focusOrigin(order.id);
    void actions.transition(order, lines, to, { kind: which }).then((out) => {
      if (out.ok) afterMove(order, from, out.orders);
    });
  }, [actions.transition, afterMove]);
  const onServePart = useCallback((part: ReadyPart) => {
    const row = document.activeElement?.closest<HTMLElement>('.passpart__row');
    const list = row?.parentElement ?? null;
    const index = row && list ? Array.from(list.children).indexOf(row) : -1;
    void actions.transition(part.order, part.ready, 'served', { kind: 'part' }).then((out) => {
      if (!out.ok) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        // The slip is gone: the next slip at its place, else the column's first ticket, else the column.
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.passpart__row'));
        const same = rows[Math.min(Math.max(index, 0), rows.length - 1)];
        const target = same?.querySelector<HTMLElement>('.btn')
          ?? document.querySelector<HTMLElement>('.col--ready .ticket .ticket__actions .btn')
          ?? document.querySelector<HTMLElement>('.col--ready .col__head h2');
        if (shown(target)) focusCalm(target);
        else restoreFocus(part.order.id, { column: null, index: -1 });
      }));
    });
  }, [actions.transition]);
  const onShowPart = useCallback((part: ReadyPart) => showTicket(part.order.id, part.placement), [showTicket]);
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
            count={counts[s]}
            current={s === stage}
            help={s === 'ready' ? readyHelp : undefined}
            empty={s === 'ready' && groups.served.length > 0 ? <span hidden /> : emptyFor(s)}
          >
            {s === 'ready' ? (
              <ReadyPartList
                parts={groups.parts}
                now={now}
                can={can}
                busy={actions.busy}
                onServe={onServePart}
                onShow={onShowPart}
              />
            ) : null}
            {groups.columns[s].map(ticket)}
            {s === 'ready' && groups.served.length > 0 && counts.ready === 0 ? emptyFor(s) : null}
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
