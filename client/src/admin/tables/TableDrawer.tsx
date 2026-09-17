// Table details drawer (brief 20, 36; DESIGN §10.19): head with seated time and
// diners, guest access, rounds and portion quotes, open requests, the bill,
// history, manager table actions, and the checkout dock.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CheckoutResultDTO, PortionRequestDTO, ServiceRequestDTO, StaffOrderDTO, TableTileDTO, VisitDetailDTO,
} from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { clock, dateTime, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Link } from '../../lib/router.ts';
import { useNow } from '../../lib/store.ts';
import {
  Button, Dialog, Drawer, DrawerSection, EmptyState, GuestAccessPanel, HistoryList, LinkButton, QuoteWell, RoundList,
  Select, Sheet, Skeleton, StatusPill, Switch, TableBox, TableStatePill, TextArea, useAnnounce, useToast,
  type RoundData,
} from '../../ui/index.ts';
import AssistOrderPanel from '../orders/AssistOrderPanel.tsx';
import BillPanel from '../billing/BillPanel.tsx';
import { useBillController } from '../billing/useBill.tsx';
import CheckoutDock from './CheckoutDock.tsx';
import { CoversPicker } from './SeatDialog.tsx';
import { historyItems } from './history.ts';
import {
  dishName, errorText, isAmbiguous, isApiError, pendingKey, seatedFor, tn, useLiveResource, useStaff, VISIT_TOPICS,
} from './shared.ts';

type T = (k: string, v?: Record<string, string | number>) => string;

interface Props {
  tableId: string;
  tile: TableTileDTO | undefined;
  tables: TableTileDTO[];
  tablesLoading: boolean;
  onClose: () => void;
  onSeat: (tile: TableTileDTO) => void;
  onEditTable: (tile: TableTileDTO) => void;
  onCheckedOut: (result: CheckoutResultDTO) => void;
  onTransferred: (toTableId: string) => void;
  refreshTables: () => void;
}

const HISTORY_PREVIEW = 8;

// ------------------------------------------------------------------ rounds
function toRounds(orders: StaffOrderDTO[], pick: ReturnType<typeof useI18n>['pick'], t: T): { rounds: RoundData[]; marked: boolean } {
  let marked = false;
  const rounds = [...orders].sort((a, b) => b.round_no - a.round_no).map((o): RoundData => {
    const active = o.lines.filter((l) => l.status !== 'cancelled' && l.status !== 'rejected');
    const servedTimes = active.map((l) => [...l.steps].reverse().find((s) => s.status === 'served')?.at ?? null);
    const allServed = active.length > 0 && active.every((l) => l.status === 'served');
    const lastServed = allServed ? servedTimes.filter((x): x is string => Boolean(x)).sort().pop() ?? null : null;
    return {
      id: o.id,
      round: o.round_no,
      reference: o.reference,
      sentAt: clock(o.submitted_at),
      allServedAt: allServed && lastServed && o.lines.every((l) => l.status === 'served') ? clock(lastServed) : null,
      lines: o.lines.map((l) => {
        const n = dishName(pick, l.name, [
          l.variant_name ? pick(l.variant_name).text : null,
          l.measured_grams ? t('billing.grams', { g: l.measured_grams }) : null,
        ]);
        if (n.marked) marked = true;
        const served = [...l.steps].reverse().find((s) => s.status === 'served');
        return {
          id: l.id,
          quantity: l.quantity,
          name: n.marked ? `${n.text} †` : n.text,
          nameLang: n.lang,
          status: l.status,
          time: served ? clock(served.at) : undefined,
        };
      }),
    };
  });
  return { rounds, marked };
}

function PortionWell({ p, canConfirm, onConfirm }: { p: PortionRequestDTO; canConfirm: boolean; onConfirm: (p: PortionRequestDTO) => void }) {
  const { t, pick } = useI18n();
  const name = dishName(pick, p.item_name);
  const q = p.quote;
  const quoted = p.status === 'quoted' && q && q.status === 'active';
  const detail = quoted
    ? `${t('billing.grams', { g: q.grams })} · ${money(q.amount_minor)}`
    : p.preferred_grams ? t('tables.portion.preferred', { g: p.preferred_grams }) : t('tables.portion.noPreference');
  const status = quoted ? t('tables.portion.awaiting', { time: clock(q.expires_at) }) : t('tables.portion.toWeigh');
  return (
    <div className="c5-portion">
      <QuoteWell name={name.marked ? `${name.text} †` : name.text} nameLang={name.lang} detail={detail} status={status} />
      <div className="c5-portion__acts">
        {quoted && canConfirm ? (
          <Button variant="ghost" size="staff" icon="hand" opensDialog onClick={() => onConfirm(p)}>{t('tables.portion.inPerson')}</Button>
        ) : null}
        {!quoted ? (
          <LinkButton variant="ghost" size="staff" href="/admin/orders/requests" iconEnd="chev-r">{t('tables.portion.weigh')}</LinkButton>
        ) : null}
      </div>
    </div>
  );
}

function RequestRow({ r, canHandle, busy, onMove }: { r: ServiceRequestDTO; canHandle: boolean; busy: boolean; onMove: (r: ServiceRequestDTO, to: 'acknowledged' | 'completed') => void }) {
  const { t } = useI18n();
  return (
    <li className="c5-req">
      <div className="c5-req__main">
        <b>{t(`service.${r.type}`)}</b>
        <StatusPill kind="service" status={r.status} size="sm" />
      </div>
      <p className="c5-req__meta">
        {t('tables.request.at', { time: clock(r.created_at) })}
        {r.acknowledged_by ? ` · ${t('tables.request.ackBy', { name: r.acknowledged_by })}` : ''}
      </p>
      {r.note ? <p className="c5-req__note">“{r.note}”</p> : null}
      {canHandle ? (
        <div className="c5-req__acts">
          {r.status === 'sent' ? (
            <Button variant="outline" size="staff" loading={busy} onClick={() => onMove(r, 'acknowledged')}>{t('tables.request.ack')}</Button>
          ) : null}
          <Button variant="outline" size="staff" icon="check" loading={busy} onClick={() => onMove(r, 'completed')}>{t('tables.request.done')}</Button>
        </div>
      ) : null}
    </li>
  );
}

// ------------------------------------------------------------------ drawer
export default function TableDrawer({
  tableId, tile, tables, tablesLoading, onClose, onSeat, onEditTable, onCheckedOut, onTransferred, refreshTables,
}: Props) {
  const { t, lang, pick } = useI18n();
  const { can } = useStaff();
  const toast = useToast();
  const announce = useAnnounce();
  const now = useNow(30_000);

  // Keep the last visit this drawer showed: if it closes elsewhere, say so.
  const [visitId, setVisitId] = useState<string | null>(tile?.visit?.id ?? null);
  const tileVisit = tile?.visit?.id ?? null;
  useEffect(() => {
    if (tileVisit && tileVisit !== visitId) setVisitId(tileVisit);
  }, [tileVisit, visitId]);

  const detailRes = useLiveResource<VisitDetailDTO>(visitId ? `/api/staff/visits/${encodeURIComponent(visitId)}` : null, VISIT_TOPICS, visitId);
  const detail = detailRes.data && detailRes.data.id === visitId ? detailRes.data : undefined;
  const refreshDetail = detailRes.refresh;
  const billCtl = useBillController(visitId ?? 'none', { enabled: Boolean(visitId), onChange: () => { void refreshDetail(); refreshTables(); } });

  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [busyReq, setBusyReq] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'revoke' | 'covers' | 'transfer' | 'assist' | 'recover'>(null);
  const [inPerson, setInPerson] = useState<PortionRequestDTO | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [historyAll, setHistoryAll] = useState(false);
  const [pausing, setPausing] = useState(false);

  // A revealed PIN hides itself again after a minute.
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(false), 60_000);
    return () => clearTimeout(timer);
  }, [revealed]);
  useEffect(() => { setRevealed(false); setHistoryAll(false); }, [visitId]);

  // A checkout whose answer was lost is settled once the visit is known to be closed.
  const closedId = detailRes.data?.status === 'closed' ? detailRes.data.id : null;
  useEffect(() => { if (closedId) pendingKey(`checkout.${closedId}`).clear(); }, [closedId]);

  const label = tile?.label ?? detail?.table.label ?? '';
  const state = tile?.state ?? detail?.table.state ?? 'available';
  const active = detail ? detail.status !== 'closed' : false;
  const closedHere = Boolean(visitId && detail && detail.status === 'closed');

  const openDialog = (d: typeof dialog) => { setDialogError(null); setDialog(d); };
  const closeDialog = () => { setDialog(null); setDialogError(null); };

  const mutateVisit = async (path: string, body: unknown): Promise<VisitDetailDTO | null> => {
    if (!detail) return null;
    try {
      const next = await api.post<VisitDetailDTO>(`/api/staff/visits/${encodeURIComponent(detail.id)}${path}`, body);
      detailRes.mutate(next);
      refreshTables();
      return next;
    } catch (err) {
      if (isApiError(err, 'stale_version', 'invalid_transition', 'conflict')) void refreshDetail();
      setDialogError(isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : errorText(t, err));
      throw err;
    }
  };

  const rotatePin = async () => {
    if (!detail || rotating) return;
    setRotating(true);
    try {
      await mutateVisit('/rotate-pin', { version: detail.version });
      setRevealed(true);
      announce(t('tables.access.rotated'));
    } catch (err) {
      toast.show({ message: isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : t('tables.access.rotateFailed'), tone: 'error' });
    } finally {
      setRotating(false);
    }
  };

  const revoke = async (reason?: string) => {
    if (!detail || !reason) return;
    await mutateVisit('/revoke-guests', { version: detail.version, reason }).then(() => {
      closeDialog();
      setRevealed(true);
      toast.show(t('tables.access.revoked', { table: label }));
    }).catch(() => undefined);
  };

  const moveRequest = async (r: ServiceRequestDTO, to: 'acknowledged' | 'completed') => {
    setBusyReq(r.id);
    try {
      await api.post(`/api/staff/service/${encodeURIComponent(r.id)}/transition`, { to, version: r.version });
      await refreshDetail();
      refreshTables();
      announce(to === 'completed' ? t('tables.request.doneSpoken', { type: t(`service.${r.type}`) }) : t('tables.request.ackSpoken', { type: t(`service.${r.type}`) }));
    } catch (err) {
      void refreshDetail();
      toast.show({ message: isApiError(err, 'stale_version', 'invalid_transition') ? t('tables.request.changed') : errorText(t, err), tone: 'error' });
    } finally {
      setBusyReq(null);
    }
  };

  const confirmInPerson = async (note?: string) => {
    const p = inPerson;
    if (!p?.quote) return;
    const k = pendingKey(`portion.${p.quote.id}`);
    try {
      await api.post(`/api/staff/portions/${encodeURIComponent(p.id)}/confirm-in-person`, {
        quote_id: p.quote.id,
        revision: p.quote.revision,
        idempotency_key: k.key(),
        note: note || null,
      });
      k.clear();
      setInPerson(null);
      await refreshDetail();
      refreshTables();
      toast.show(t('tables.portion.confirmed', { name: pick(p.item_name).text }));
    } catch (err) {
      if (!isAmbiguous(err)) k.clear();
      if (isApiError(err, 'quote_expired', 'quote_superseded', 'stale_version', 'conflict')) void refreshDetail();
      setDialogError(isAmbiguous(err) ? t('billing.error.ambiguous') : errorText(t, err));
    }
  };

  const togglePause = async (next: boolean) => {
    if (!tile || pausing) return;
    setPausing(true);
    try {
      await api.patch(`/api/staff/tables/${encodeURIComponent(tile.id)}`, { ordering_paused: next, version: tile.version });
      refreshTables();
      toast.show(next ? t('tables.pause.paused', { table: label }) : t('tables.pause.resumed', { table: label }));
    } catch (err) {
      refreshTables();
      toast.show({ message: isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : errorText(t, err), tone: 'error' });
    } finally {
      setPausing(false);
    }
  };

  const { rounds, marked } = useMemo(() => (detail ? toRounds(detail.orders, pick, t) : { rounds: [], marked: false }), [detail, pick, t]);
  const openPortions = detail?.portions.filter((p) => p.status === 'requested' || p.status === 'quoted') ?? [];
  const openRequests = detail?.requests.filter((r) => r.status === 'sent' || r.status === 'acknowledged') ?? [];
  const history = useMemo(() => (detail ? historyItems(detail.history, t) : []), [detail, t]);
  const shownHistory = historyAll ? history : history.slice(0, HISTORY_PREVIEW);
  const devices = detail ? detail.guests.filter((g) => !g.revoked).length : 0;
  const freeTables = tables.filter((x) => x.state === 'available' && x.id !== tableId);

  // ---------------------------------------------------------------- head meta
  let subtitle: ReactNode = null;
  if (detail && active) {
    const coversText = detail.covers === null ? t('tables.covers.notRecorded') : tn(t, 'tables.covers.n', detail.covers);
    subtitle = (
      <>
        <span className="c5-seg">{t('tables.drawer.seated', { time: clock(detail.seated_at), for: seatedFor(t, detail.seated_at, now) })}</span>
        {' · '}
        <span className="c5-seg">
          <span className={detail.covers === null ? 'c5-muted' : undefined}>{coversText}</span>
          {can('visits.covers') ? (
            <>
              {' '}
              <button type="button" className="c5-metalink" aria-haspopup="dialog" onClick={() => openDialog('covers')}>
                {detail.covers === null ? t('tables.covers.add') : t('common.edit')}
                <span className="visually-hidden"> {t('tables.covers.label')}</span>
              </button>
            </>
          ) : null}
        </span>
        {detail.opened_by ? <>{' · '}<span className="c5-seg">{t('tables.drawer.openedBy', { name: detail.opened_by })}</span></> : null}
      </>
    );
  } else if (tile && !visitId) {
    subtitle = tile.zone ? `${tile.zone}` : null;
  }

  // ---------------------------------------------------------------- body
  let body: ReactNode;
  let footer: ReactNode = null;

  if (!tile && tablesLoading) {
    body = <div className="c5-drawer-skel" role="status" aria-label={t('common.loading')}><Skeleton lines={4} /><Skeleton shape="block" height={120} /></div>;
  } else if (!tile && !detail) {
    body = (
      <EmptyState icon="info" title={t('tables.drawer.notFound')} action={<Button variant="outline" size="staff" onClick={onClose}>{t('tables.drawer.backToTables')}</Button>}>
        {t('tables.drawer.notFoundBody')}
      </EmptyState>
    );
  } else if (!visitId && tile) {
    body = (
      <>
        <EmptyState
          icon={tile.state === 'disabled' ? 'lock' : 'seat'}
          title={tile.state === 'disabled' ? t('tables.drawer.disabledTitle') : t('tables.drawer.freeTitle')}
          action={tile.state === 'available' && can('visits.open') ? (
            <Button variant="primary" size="staff" icon="seat" opensDialog onClick={() => onSeat(tile)}>{t('common.tile.seat')}</Button>
          ) : undefined}
        >
          {tile.state === 'disabled' ? t('tables.drawer.disabledBody') : t('tables.drawer.freeBody')}
        </EmptyState>
        <TableSection tile={tile} canManage={can('tables.manage')} canPause={can('ordering.pause')} pausing={pausing} onPause={togglePause} onEdit={() => onEditTable(tile)} />
      </>
    );
  } else if (!detail) {
    if (detailRes.error) {
      const denied = isApiError(detailRes.error, 'forbidden');
      body = (
        <EmptyState icon="alert" title={denied ? t('tables.drawer.denied') : t('tables.drawer.loadFailed')} action={denied ? undefined : (
          <Button variant="outline" size="staff" icon="refresh" onClick={() => void refreshDetail()}>{t('common.retry')}</Button>
        )}>
          {errorText(t, detailRes.error)}
        </EmptyState>
      );
    } else {
      body = <div className="c5-drawer-skel" role="status" aria-label={t('common.loading')}><Skeleton lines={3} /><Skeleton shape="block" height={96} /><Skeleton lines={5} /></div>;
    }
  } else {
    body = (
      <>
        {detailRes.stale ? (
          <p className="c5-stale" role="status">
            {t('tables.drawer.stale', { time: detailRes.fetchedAt ? clock(new Date(detailRes.fetchedAt).toISOString()) : '—' })}
            <Button variant="ghost" size="staff" icon="refresh" onClick={() => void refreshDetail()}>{t('common.retry')}</Button>
          </p>
        ) : null}
        {closedHere ? (
          <div className="c5-callout c5-callout--ok c5-closed" role="status">
            <p>{detail.closed_at ? t('tables.drawer.closedAt', { table: label, time: clock(detail.closed_at) }) : t('tables.drawer.closed', { table: label })}</p>
            {tile?.state === 'available' && can('visits.open') ? (
              <Button variant="primary" size="staff" icon="seat" opensDialog onClick={() => onSeat(tile)}>{t('tables.drawer.seatNew')}</Button>
            ) : null}
          </div>
        ) : null}

        {active ? (
          <GuestAccessPanel
            pin={detail.join_pin}
            revealed={revealed}
            onReveal={setRevealed}
            onRotate={can('visits.pin_rotate') ? () => void rotatePin() : undefined}
            onRevoke={can('visits.revoke_guests') ? () => openDialog('revoke') : undefined}
            devices={devices}
            lockedUntil={detail.pin_locked_until ? clock(detail.pin_locked_until) : null}
            rotating={rotating}
          />
        ) : null}

        <DrawerSection
          title={t('tables.drawer.rounds')}
          aside={active && detail.status === 'open' && can('orders.assist') ? (
            <Button variant="ghost" size="staff" icon="plus" opensDialog onClick={() => openDialog('assist')}>{t('tables.drawer.assist')}</Button>
          ) : undefined}
        >
          {rounds.length === 0 && openPortions.length === 0 ? (
            <p className="c5-note">{t('tables.drawer.noRounds')}</p>
          ) : (
            <RoundList rounds={rounds} />
          )}
          {openPortions.map((p) => (
            <PortionWell key={p.id} p={p} canConfirm={can('portions.confirm_in_person') && active} onConfirm={(x) => { setDialogError(null); setInPerson(x); }} />
          ))}
          {marked ? <p className="c5-footnote">† {t(lang === 'th' ? 'common.enOnly' : 'tables.thaiOnly')}</p> : null}
          <div className="c5-rowlinks">
            {rounds.length > 0 ? (
              <LinkButton variant="ghost" size="staff" href={`/admin/orders?table=${encodeURIComponent(label)}`} iconEnd="chev-r">{t('tables.drawer.onBoard')}</LinkButton>
            ) : null}
            {active && detail.status === 'open' && can('orders.recover_manual') ? (
              <Button variant="ghost" size="staff" icon="note" opensDialog onClick={() => openDialog('recover')}>{t('tables.drawer.recover')}</Button>
            ) : null}
          </div>
        </DrawerSection>

        {openRequests.length > 0 ? (
          <DrawerSection title={t('tables.drawer.requests')} aside={<span className="meta">{tn(t, 'tables.drawer.requestsCount', openRequests.length)}</span>}>
            <ul className="c5-reqs">
              {openRequests.map((r) => (
                <RequestRow key={r.id} r={r} canHandle={can('service.handle') && active} busy={busyReq === r.id} onMove={(x, to) => void moveRequest(x, to)} />
              ))}
            </ul>
          </DrawerSection>
        ) : null}

        {can('billing.view') ? <BillPanel visitId={detail.id} controller={billCtl} nextStep="external" /> : null}

        <DrawerSection
          title={t('tables.drawer.history')}
          aside={can('audit.view') ? <Link className="textlink c5-audit-link" to={`/admin/audit?visit_id=${encodeURIComponent(detail.id)}`}>{t('common.history.full')}</Link> : undefined}
        >
          {history.length === 0 ? <p className="c5-note">{t('tables.drawer.noHistory')}</p> : <HistoryList items={shownHistory} />}
          {history.length > HISTORY_PREVIEW && !historyAll ? (
            <Button variant="ghost" size="staff" iconEnd="chev-d" onClick={() => setHistoryAll(true)}>{t('tables.drawer.historyAll', { n: history.length })}</Button>
          ) : null}
        </DrawerSection>

        {tile ? (
          <TableSection
            tile={tile}
            canManage={can('tables.manage')}
            canPause={can('ordering.pause')}
            pausing={pausing}
            onPause={togglePause}
            onEdit={() => onEditTable(tile)}
            onTransfer={active && can('visits.transfer') ? () => openDialog('transfer') : undefined}
          />
        ) : null}

        {detail.closed_at && closedHere ? (
          <p className="c5-footnote">{t('tables.drawer.closedFoot', { time: dateTime(detail.closed_at, lang) })}</p>
        ) : null}
      </>
    );
    footer = active && can('billing.view') ? (
      <CheckoutDock
        detail={detail}
        ctl={billCtl}
        refresh={() => { void refreshDetail(); refreshTables(); }}
        onCompleted={(result) => {
          void refreshDetail();
          onCheckedOut(result);
        }}
      />
    ) : null;
  }

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        className="c5-drawer"
        title={label ? t('common.table', { label }) : t('tables.drawer.title')}
        status={label ? <TableStatePill state={state} /> : undefined}
        lead={label ? <TableBox label={label} /> : undefined}
        subtitle={subtitle}
        closeLabel={t('tables.drawer.close', { table: label })}
        footer={footer ?? undefined}
      >
        {body}
      </Drawer>

      {billCtl.dialogs}

      <Dialog
        open={dialog === 'revoke'}
        onClose={closeDialog}
        density="staff"
        tone="danger"
        title={t('tables.access.revokeTitle', { table: label })}
        confirmLabel={t('tables.access.revokeConfirm')}
        onConfirm={revoke}
        error={dialogError}
        reason={{ label: t('billing.reason'), required: true, limit: 200, placeholder: t('tables.access.revokePlaceholder') }}
      >
        <p>{tn(t, 'tables.access.revokeBody', devices)}</p>
        <p className="c5-note">{t('tables.access.revokeAfter')}</p>
      </Dialog>

      <Dialog
        open={Boolean(inPerson)}
        onClose={() => setInPerson(null)}
        density="staff"
        title={inPerson?.quote ? t('tables.portion.inPersonTitle', {
          name: pick(inPerson.item_name).text,
          grams: t('billing.grams', { g: inPerson.quote.grams }),
          amount: money(inPerson.quote.amount_minor),
        }) : ''}
        confirmLabel={t('tables.portion.inPersonConfirm')}
        onConfirm={confirmInPerson}
        error={dialogError}
        reason={{ label: t('tables.portion.note'), required: false, limit: 200, placeholder: t('tables.portion.notePlaceholder') }}
      >
        <p>{t('tables.portion.inPersonBody')}</p>
      </Dialog>

      {dialog === 'covers' && detail ? (
        <CoversDialog
          detail={detail}
          onClose={closeDialog}
          onSaved={(next) => { detailRes.mutate(next); refreshTables(); closeDialog(); announce(t('tables.covers.saved')); }}
          onStale={() => void refreshDetail()}
        />
      ) : null}

      {dialog === 'transfer' && detail ? (
        <TransferDialog
          detail={detail}
          label={label}
          free={freeTables}
          onClose={closeDialog}
          onDone={(to) => {
            const dest = tables.find((x) => x.id === to);
            closeDialog();
            refreshTables();
            toast.show(t('tables.transfer.done', { from: label, to: dest?.label ?? '' }));
            onTransferred(to);
          }}
          onStale={() => { void refreshDetail(); refreshTables(); }}
        />
      ) : null}

      {(dialog === 'assist' || dialog === 'recover') && detail ? (
        <AssistOrderPanel
          visitId={detail.id}
          mode={dialog === 'recover' ? 'recover' : 'assist'}
          onClose={closeDialog}
          onDone={(reference) => {
            closeDialog();
            void refreshDetail();
            refreshTables();
            toast.show(t(dialog === 'recover' ? 'tables.drawer.recovered' : 'tables.drawer.assisted', { ref: reference, table: label }));
          }}
        />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ table section
function TableSection({ tile, canManage, canPause, pausing, onPause, onEdit, onTransfer }: {
  tile: TableTileDTO; canManage: boolean; canPause: boolean; pausing: boolean;
  onPause: (next: boolean) => void; onEdit: () => void; onTransfer?: () => void;
}) {
  const { t } = useI18n();
  if (!canManage && !canPause && !onTransfer) return null;
  return (
    <DrawerSection title={t('tables.drawer.table')} className="c5-tablesec">
      {canPause && tile.state !== 'disabled' ? (
        <Switch
          density="staff"
          checked={!tile.ordering_paused}
          disabled={pausing}
          onChange={(open) => onPause(!open)}
          label={t('tables.pause.label')}
          onLabel={t('tables.pause.off')}
          offLabel={t('tables.pause.on')}
        />
      ) : null}
      {tile.ordering_paused ? <p className="c5-note">{t('tables.pause.help')}</p> : null}
      <div className="c5-rowlinks">
        {onTransfer ? <Button variant="outline" size="staff" icon="arrow-r" opensDialog onClick={onTransfer}>{t('tables.transfer.action')}</Button> : null}
        {canManage ? <Button variant="outline" size="staff" opensDialog onClick={onEdit}>{t('tables.manage.editAction')}</Button> : null}
      </div>
    </DrawerSection>
  );
}

// ------------------------------------------------------------------ covers dialog
function CoversDialog({ detail, onClose, onSaved, onStale }: {
  detail: VisitDetailDTO; onClose: () => void; onSaved: (next: VisitDetailDTO) => void; onStale: () => void;
}) {
  const { t } = useI18n();
  const [covers, setCovers] = useState<number | null>(detail.covers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(detail.version);
  version.current = detail.version;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.patch<VisitDetailDTO>(`/api/staff/visits/${encodeURIComponent(detail.id)}`, { covers, version: version.current });
      onSaved(next);
    } catch (err) {
      if (isApiError(err, 'stale_version')) { onStale(); setError(t('tables.covers.stale')); } else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={t('tables.covers.title', { table: detail.table.label })}
      dismissible={!busy}
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={busy} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      )}
    >
      <CoversPicker value={covers} onChange={setCovers} label={t('tables.covers.question')} help={t('tables.covers.editHelp')} />
      {error ? <p className="field__error c5-block" role="alert">{error}</p> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ transfer dialog
function TransferDialog({ detail, label, free, onClose, onDone, onStale }: {
  detail: VisitDetailDTO; label: string; free: TableTileDTO[]; onClose: () => void; onDone: (toTableId: string) => void; onStale: () => void;
}) {
  const { t } = useI18n();
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const save = async () => {
    let bad = false;
    if (!to) { setToError(t('tables.transfer.pick')); bad = true; } else setToError(null);
    if (reason.trim().length < 3) { setReasonError(t('common.reasonRequired')); bad = true; } else setReasonError(null);
    if (bad) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/staff/visits/${encodeURIComponent(detail.id)}/transfer`, { to_table_id: to, version: detail.version, reason: reason.trim() });
      onDone(to);
    } catch (err) {
      if (isApiError(err, 'stale_version', 'conflict', 'table_disabled')) onStale();
      setError(isApiError(err, 'conflict') ? t('tables.transfer.taken') : errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={t('tables.transfer.title', { table: label })}
      dismissible={!busy}
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={busy} disabled={free.length === 0} onClick={() => void save()}>{t('tables.transfer.confirm')}</Button>
        </>
      )}
    >
      <p className="sheet__lede">{t('tables.transfer.lede')}</p>
      {free.length === 0 ? (
        <p className="c5-callout c5-callout--neutral c5-block">{t('tables.transfer.none')}</p>
      ) : (
        <Select
          className="c5-block"
          density="staff"
          label={t('tables.transfer.to')}
          value={to}
          placeholder={t('tables.transfer.choose')}
          error={toError ?? undefined}
          onChange={(e) => { setTo(e.target.value); setToError(null); }}
          options={free.map((x) => ({ value: x.id, label: x.zone ? `${t('common.table', { label: x.label })} · ${x.zone}` : t('common.table', { label: x.label }) }))}
        />
      )}
      <TextArea
        className="c5-block"
        density="staff"
        label={t('billing.reason')}
        value={reason}
        onChange={(v) => { setReason(v); if (v.trim().length >= 3) setReasonError(null); }}
        limit={200}
        required
        placeholder={t('tables.transfer.placeholder')}
        error={reasonError ?? undefined}
      />
      {error ? <p className="field__error c5-block" role="alert">{error}</p> : null}
    </Sheet>
  );
}
