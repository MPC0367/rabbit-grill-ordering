// Tables (brief 20, 36, 43; DESIGN §10.18-10.19; mock admin-tables.html).
// "Which tables are free?" answered at a glance: a summary bar whose counts
// reconcile with the tiles, the live grid, and the table drawer at
// /admin/tables/:id (browser Back closes it). ?view=manage lists tables for
// QR printing and, for managers, table administration.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckoutResultDTO, StaffBillDTO, TablesDTO, TableTileDTO } from '../../../../shared/dto.ts';
import type { TableState } from '../../../../shared/status.ts';
import { api } from '../../lib/api.ts';
import { clock, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate, useRoute } from '../../lib/router.ts';
import { useNow } from '../../lib/store.ts';
import {
  Banner, Button, Dialog, EmptyState, LinkButton, Skeleton, SubTabs, TablesSummaryBar, cx, normalizeSearch,
  useAnnounce, useToast, type TableFilter,
} from '../../ui/index.ts';
import { paidAt } from '../billing/useBill.tsx';
import SeatDialog from './SeatDialog.tsx';
import TableDrawer from './TableDrawer.tsx';
import { TableGridTile } from './TableGrid.tsx';
import { EnableDialog, ManageView, printHref, RotateQrDialog, TableFormDialog } from './TableAdmin.tsx';
import {
  afterOverlaysClose, errorText, isAmbiguous, isApiError, pendingKey, TABLE_TOPICS, useBills, useLiveResource, useStaff,
} from './shared.ts';
import './tables.css';
import '../billing/billing.css';

const FREED_MS = 1400;

export default function TablesPage({ tableId }: { tableId?: string }) {
  const { t } = useI18n();
  const { can } = useStaff();
  const { query } = useRoute();
  const toast = useToast();
  const announce = useAnnounce();
  const now = useNow(30_000);
  const view: 'live' | 'manage' = query.get('view') === 'manage' ? 'manage' : 'live';
  const allowed = can('tables.view');

  // The 30 s safety refresh also notices an unreachable server: the grid then says it is out of date.
  const res = useLiveResource<TablesDTO>(allowed ? '/api/staff/tables' : null, TABLE_TOPICS, null, 30_000);
  const tiles = useMemo(() => res.data?.tables ?? [], [res.data]);
  const refreshTables = useCallback(() => { void res.refresh(); }, [res.refresh]);
  const checkoutIds = useMemo(() => tiles.filter((x) => x.state === 'checking_out' && x.visit).map((x) => x.visit!.id), [tiles]);
  const bills = useBills(checkoutIds, can('billing.view'));

  const [filter, setFilter] = useState<TableFilter>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [q, setQ] = useState('');
  const [seat, setSeat] = useState<TableTileDTO | null>(null);
  const [tileCheckout, setTileCheckout] = useState<{ tile: TableTileDTO; bill: StaffBillDTO } | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [enable, setEnable] = useState<TableTileDTO | null>(null);
  const [form, setForm] = useState<{ tile: TableTileDTO | null } | null>(null);
  const [rotate, setRotate] = useState<TableTileDTO | null>(null);
  const [freed, setFreed] = useState<string | null>(null);

  // ---------------------------------------------------------------- polite state announcements
  const prevStates = useRef<Map<string, TableState> | null>(null);
  const quiet = useRef(new Set<string>());
  useEffect(() => {
    if (!res.data) return;
    const cur = new Map(res.data.tables.map((x) => [x.id, x.state] as const));
    const prev = prevStates.current;
    prevStates.current = cur;
    if (!prev) return;
    const changed = res.data.tables.filter((x) => prev.has(x.id) && prev.get(x.id) !== x.state && !quiet.current.has(x.id));
    quiet.current.clear();
    if (changed.length === 0) return;
    if (changed.length > 3) announce(t('tables.live.manyChanged', { n: changed.length }));
    else announce(changed.map((x) => t('tables.live.changed', { table: x.label, state: t(`table.${x.state}`) })).join(' · '));
  }, [res.data, announce, t]);

  useEffect(() => {
    if (!freed) return;
    const timer = setTimeout(() => setFreed(null), FREED_MS);
    return () => clearTimeout(timer);
  }, [freed]);

  // The inline drawer sticks under the workspace header; until the page scrolls it
  // starts lower (under the summary bar), so size it to what is visible and keep
  // Complete checkout on screen.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tableId) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const head = document.querySelector('.wshead-cq, .wshead');
      const floor = head ? head.getBoundingClientRect().bottom : 0;
      const top = Math.max(wrap.getBoundingClientRect().top, floor);
      wrap.style.setProperty('--c5-drawer-top', `${Math.round(floor)}px`);
      wrap.style.setProperty('--c5-drawer-h', `${Math.max(320, Math.round(window.innerHeight - top))}px`);
    };
    const kick = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    return () => {
      window.removeEventListener('scroll', kick);
      window.removeEventListener('resize', kick);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [tableId, view]);

  // ---------------------------------------------------------------- drawer routing
  const openDrawer = useCallback((tile: TableTileDTO) => {
    if (tile.id === tableId) return;
    const st = window.history.state as Record<string, unknown> | null;
    navigate(`/admin/tables/${encodeURIComponent(tile.id)}`, {
      state: { c5Grid: true },
      replace: Boolean(tableId && st?.c5Grid),
      keepScroll: true,
    });
  }, [tableId]);

  const closeDrawer = useCallback(() => {
    const st = window.history.state as Record<string, unknown> | null;
    if (st?.c5Grid) window.history.back();
    else navigate(view === 'manage' ? '/admin/tables?view=manage' : '/admin/tables', { replace: true, keepScroll: true });
  }, [view]);

  const toggleDetails = useCallback((tile: TableTileDTO) => {
    if (tile.id === tableId) closeDrawer(); else openDrawer(tile);
  }, [tableId, closeDrawer, openDrawer]);

  const markFreed = useCallback((tile: { id: string; label: string; state: TableState }) => {
    quiet.current.add(tile.id);
    setFreed(tile.id);
    const msg = tile.state === 'disabled' ? t('tables.checkout.doneDisabled', { table: tile.label }) : t('tables.checkout.done', { table: tile.label });
    toast.show(msg);
  }, [t, toast]);

  // ---------------------------------------------------------------- checkout from a tile
  const runTileCheckout = async () => {
    const c = tileCheckout;
    if (!c?.tile.visit) return;
    const visitId = c.tile.visit.id;
    const k = pendingKey(`checkout.${visitId}`);
    try {
      const result = await api.post<CheckoutResultDTO>(`/api/staff/visits/${encodeURIComponent(visitId)}/checkout`, { idempotency_key: k.key() });
      k.clear();
      setTileCheckout(null);
      markFreed(result.table);
      refreshTables();
    } catch (err) {
      if (isAmbiguous(err)) { setCheckoutError(t('tables.checkout.ambiguous')); return; }
      k.clear();
      refreshTables();
      setCheckoutError(isApiError(err, 'unresolved_orders', 'bill_not_finalized', 'unpaid_bill', 'invalid_transition')
        ? t('tables.checkout.stillBlockedTile')
        : errorText(t, err));
    }
  };

  // ---------------------------------------------------------------- derived
  const counts = useMemo(() => {
    const c: Record<TableState, number> = { available: 0, dining: 0, checking_out: 0, disabled: 0 };
    for (const x of tiles) c[x.state] += 1;
    return c;
  }, [tiles]);
  const attentionCount = tiles.filter((x) => x.attention.length > 0).length;
  const needle = normalizeSearch(q);
  const visible = tiles.filter((x) => (filter === 'all' || x.state === filter)
    && (!attentionOnly || x.attention.length > 0)
    && (!needle || normalizeSearch(x.label).includes(needle) || normalizeSearch(x.zone ?? '').includes(needle)));
  const selectedTile = tableId ? tiles.find((x) => x.id === tableId) : undefined;
  const filtered = filter !== 'all' || attentionOnly || needle !== '';
  const perms = { seat: can('visits.open'), checkout: can('checkout.complete'), enable: can('tables.manage') };

  if (!allowed) {
    return (
      <div className="c5-tables c5-tables--denied">
        <EmptyState icon="lock" headingLevel={2} title={t('tables.denied.title')} action={<LinkButton variant="outline" size="staff" href="/admin/orders">{t('tables.denied.action')}</LinkButton>}>
          {t('tables.denied.body')}
        </EmptyState>
      </div>
    );
  }

  const views = (
    <SubTabs
      className="subtabs--bar c5-views"
      label={t('tables.views')}
      items={[
        { id: 'live', label: t('tables.view.live'), href: '/admin/tables', current: view === 'live' },
        { id: 'manage', label: can('tables.manage') ? t('tables.view.manage') : t('tables.view.qr'), href: '/admin/tables?view=manage', current: view === 'manage' },
      ]}
    />
  );

  // ---------------------------------------------------------------- grid body
  let grid;
  if (!res.data && res.error) {
    const denied = isApiError(res.error, 'forbidden');
    grid = (
      <EmptyState
        icon="alert"
        title={denied ? t('tables.denied.title') : t('tables.grid.loadFailed')}
        action={denied ? undefined : <Button variant="outline" size="staff" icon="refresh" onClick={refreshTables}>{t('common.retry')}</Button>}
      >
        {errorText(t, res.error)}
      </EmptyState>
    );
  } else if (!res.data) {
    grid = (
      <div className="tgrid" role="status" aria-label={t('common.loading')}>
        {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} shape="block" height={176} className="c5-tile-skel" />)}
      </div>
    );
  } else if (tiles.length === 0) {
    grid = (
      <EmptyState
        icon="tables"
        title={t('tables.grid.none')}
        action={can('tables.manage') ? <Button variant="primary" size="staff" icon="plus" opensDialog onClick={() => setForm({ tile: null })}>{t('tables.manage.add')}</Button> : undefined}
      >
        {can('tables.manage') ? t('tables.grid.noneManager') : t('tables.grid.noneStaff')}
      </EmptyState>
    );
  } else if (visible.length === 0) {
    grid = (
      <EmptyState
        icon="filter"
        title={t('tables.grid.noMatch')}
        action={<Button variant="outline" size="staff" onClick={() => { setFilter('all'); setAttentionOnly(false); setQ(''); }}>{t('tables.grid.showAll')}</Button>}
      >
        {t('tables.grid.noMatchBody')}
      </EmptyState>
    );
  } else {
    grid = (
      <div className="tgrid" aria-label={t('tables.grid.title')}>
        {visible.map((tile) => (
          <TableGridTile
            key={tile.id}
            tile={tile}
            bill={tile.visit ? bills.get(tile.visit.id) : undefined}
            now={now}
            selected={tile.id === tableId}
            freed={tile.id === freed}
            perms={perms}
            onDetails={toggleDetails}
            onSeat={(x) => setSeat(x)}
            onCheckout={(x, b) => { setCheckoutError(null); setTileCheckout({ tile: x, bill: b }); }}
            onEnable={(x) => setEnable(x)}
          />
        ))}
      </div>
    );
  }

  const tcBill = tileCheckout?.bill;
  const tcPaid = paidAt(tcBill);

  return (
    <div className="c5-tables">
      {views}
      {view === 'live' ? (
        <>
          <TablesSummaryBar
            counts={counts}
            filter={filter}
            onFilter={setFilter}
            attentionCount={attentionCount}
            attentionOnly={attentionOnly}
            onAttentionOnly={setAttentionOnly}
            query={q}
            onQuery={setQ}
          />
          {filtered && res.data ? (
            <p className="visually-hidden" role="status">{t('tables.grid.showing', { n: visible.length, total: tiles.length })}</p>
          ) : null}
          <div ref={wrapRef} className={cx('tgrid-wrap', !tableId && 'tgrid-wrap--closed')}>
            <section className="c5-gridsec" aria-labelledby="c5-grid-title">
              <h2 id="c5-grid-title" className="visually-hidden">{t('tables.grid.title')}</h2>
              {res.stale ? (
                <Banner
                  variant="warning"
                  staff
                  title={t('tables.grid.staleTitle')}
                  action={<Button variant="outline" size="staff" icon="refresh" onClick={refreshTables}>{t('common.retry')}</Button>}
                >
                  {t('tables.grid.staleBody', { time: res.fetchedAt ? clock(new Date(res.fetchedAt).toISOString()) : '—' })}
                </Banner>
              ) : null}
              {grid}
            </section>
            {tableId ? (
              <TableDrawer
                key={tableId}
                tableId={tableId}
                tile={selectedTile}
                tables={tiles}
                tablesLoading={!res.data && !res.error}
                onClose={closeDrawer}
                onSeat={(x) => setSeat(x)}
                onEditTable={(x) => setForm({ tile: x })}
                onCheckedOut={(result) => {
                  markFreed(result.table);
                  refreshTables();
                  afterOverlaysClose(closeDrawer);
                }}
                onTransferred={(to) => {
                  const st = window.history.state as Record<string, unknown> | null;
                  afterOverlaysClose(() => navigate(`/admin/tables/${encodeURIComponent(to)}`, { replace: true, state: st?.c5Grid ? { c5Grid: true } : undefined, keepScroll: true }));
                }}
                refreshTables={refreshTables}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="c5-manage-wrap">
          {res.error && !res.data ? (
            <EmptyState icon="alert" title={t('tables.grid.loadFailed')} action={<Button variant="outline" size="staff" icon="refresh" onClick={refreshTables}>{t('common.retry')}</Button>}>
              {errorText(t, res.error)}
            </EmptyState>
          ) : (
            <ManageView
              tiles={tiles}
              loading={!res.data}
              onAdd={() => setForm({ tile: null })}
              onEdit={(x) => setForm({ tile: x })}
              onRotate={(x) => setRotate(x)}
              refresh={refreshTables}
            />
          )}
        </div>
      )}

      {seat ? (
        <SeatDialog
          tile={seat}
          onClose={() => setSeat(null)}
          onChanged={refreshTables}
          onOpenDetails={(x) => afterOverlaysClose(() => openDrawer(x))}
        />
      ) : null}

      <Dialog
        open={Boolean(tileCheckout)}
        onClose={() => setTileCheckout(null)}
        density="staff"
        title={tileCheckout ? t('tables.checkout.title', { table: tileCheckout.tile.label }) : ''}
        confirmLabel={t('common.tile.checkout')}
        onConfirm={runTileCheckout}
        error={checkoutError}
      >
        {tcBill ? (
          <p className="c5-dialog-total">
            <span>{tcPaid ? t('tables.checkout.paidLine', { time: clock(tcPaid) }) : t('tables.checkout.billLine')}</span>
            <b className="num">{money(tcBill.total_minor)}</b>
          </p>
        ) : null}
        <p>{t('tables.checkout.body')}</p>
        {tcBill && tcBill.unresolved.open_requests > 0 ? <p className="c5-note">{t(tcBill.unresolved.open_requests === 1 ? 'tables.notice.requestsOne' : 'tables.notice.requests', { n: tcBill.unresolved.open_requests })}</p> : null}
        {tileCheckout ? (
          <Button
            variant="ghost"
            size="staff"
            iconEnd="chev-r"
            className="c5-dialog-link"
            onClick={() => { const x = tileCheckout.tile; setTileCheckout(null); afterOverlaysClose(() => openDrawer(x)); }}
          >
            {t('tables.checkout.openDetails')}
          </Button>
        ) : null}
      </Dialog>

      {enable ? (
        <EnableDialog
          tile={enable}
          onClose={() => setEnable(null)}
          refresh={refreshTables}
          onDone={(next) => { setEnable(null); refreshTables(); toast.show(t('tables.enable.done', { table: next.label })); }}
        />
      ) : null}

      {form ? (
        <TableFormDialog
          tile={form.tile}
          onClose={() => setForm(null)}
          refresh={refreshTables}
          onRotate={(x) => { setForm(null); setRotate(x); }}
          onSaved={(next, created) => {
            setForm(null);
            refreshTables();
            toast.show(created ? t('tables.manage.created', { table: next.label }) : t('tables.manage.saved', { table: next.label }));
          }}
        />
      ) : null}

      {rotate ? (
        <RotateQrDialog
          tile={tiles.find((x) => x.id === rotate.id) ?? rotate}
          onClose={() => setRotate(null)}
          refresh={refreshTables}
          onDone={(next) => {
            setRotate(null);
            refreshTables();
            toast.show({
              message: t('tables.qr.rotated', { table: next.label }),
              tone: 'info',
              duration: 8000,
              action: { label: t('tables.qr.printNew'), onClick: () => afterOverlaysClose(() => navigate(printHref([next.id]))) },
            });
          }}
        />
      ) : null}
    </div>
  );
}

