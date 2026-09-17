// Tables and QR cards (brief 20): list, batch print selection, and the manager
// table management dialogs (create, edit, enable/disable, pause ordering, QR rotation).
import { useMemo, useState } from 'react';
import type { TablesDTO, TableTileDTO } from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { dateLabel, dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { businessDate } from '../../../../shared/time.ts';
import {
  Button, CheckButton, Checkbox, DataTable, Dialog, EmptyState, LinkButton, Pill, SectionHeader, Sheet, Skeleton, Switch,
  TableStatePill, Tag, TextField, useToast, type DataColumn,
} from '../../ui/index.ts';
import { errorText, isApiError, useStaff } from './shared.ts';

// ------------------------------------------------------------------ manage view
interface ManageProps {
  tiles: TableTileDTO[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (tile: TableTileDTO) => void;
  onRotate: (tile: TableTileDTO) => void;
  refresh: () => void;
}

export function printHref(ids: string[]): string {
  return `/admin/tables/print${ids.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : ''}`;
}

export function ManageView({ tiles, loading, onAdd, onEdit, onRotate, refresh }: ManageProps) {
  const { t, lang } = useI18n();
  const { can } = useStaff();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pausing, setPausing] = useState<string | null>(null);
  const live = new Set(tiles.map((x) => x.id));
  const chosen = [...selected].filter((id) => live.has(id));
  const allChosen = tiles.length > 0 && chosen.length === tiles.length;
  const reprint = tiles.filter((x) => x.qr?.reprint_required);

  const toggle = (id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const setOrdering = async (tile: TableTileDTO, open: boolean) => {
    setPausing(tile.id);
    try {
      await api.patch(`/api/staff/tables/${encodeURIComponent(tile.id)}`, { ordering_paused: !open, version: tile.version });
      toast.show(open ? t('tables.pause.resumed', { table: tile.label }) : t('tables.pause.paused', { table: tile.label }));
    } catch (err) {
      toast.show({ message: isApiError(err, 'stale_version') ? t('billing.error.changedElsewhere') : errorText(t, err), tone: 'error' });
    } finally {
      setPausing(null);
      refresh();
    }
  };

  const columns: DataColumn<TableTileDTO>[] = useMemo(() => [
    {
      key: 'label',
      header: t('tables.manage.col.table'),
      cell: (row) => (
        <Checkbox
          className="c5-rowcheck"
          checked={selected.has(row.id)}
          onChange={(e) => toggle(row.id, e.target.checked)}
          label={<span className="c5-tlabel"><span className="visually-hidden">{t('tables.manage.select')} </span>{row.label}</span>}
        />
      ),
    },
    { key: 'zone', header: t('tables.manage.col.zone'), cell: (row) => row.zone ?? <span className="c5-muted">—</span> },
    { key: 'state', header: t('tables.manage.col.state'), cell: (row) => <TableStatePill state={row.state} /> },
    {
      key: 'ordering',
      header: t('tables.manage.col.ordering'),
      cell: (row) => {
        if (row.state === 'disabled') return <span className="c5-muted">{t('tables.manage.noOrdering')}</span>;
        if (!can('ordering.pause')) {
          return row.ordering_paused ? <Pill tone="heat" size="sm" icon="pause">{t('tables.pause.on')}</Pill> : <span>{t('tables.pause.off')}</span>;
        }
        return (
          <Switch
            density="staff"
            checked={!row.ordering_paused}
            disabled={pausing === row.id}
            onChange={(open) => void setOrdering(row, open)}
            label={<span className="visually-hidden">{t('tables.manage.orderingAt', { table: row.label })}</span>}
            onLabel={t('tables.pause.off')}
            offLabel={t('tables.pause.on')}
          />
        );
      },
    },
    {
      key: 'qr',
      header: t('tables.manage.col.qr'),
      wrap: true,
      cell: (row) => (
        <span className="c5-qrcell">
          {row.qr?.reprint_required ? <Tag tone="alert" icon="alert">{t('tables.qr.reprint')}</Tag> : null}
          <span className="c5-cell-sub">
            {row.qr?.rotated_at
              ? t('tables.qr.replacedOn', { date: dateTime(row.qr.rotated_at, lang) })
              : row.qr ? t('tables.qr.issuedOn', { date: dateLabel(businessDate(row.qr.issued_at, 0), lang, { year: true }) }) : '—'}
          </span>
        </span>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, lang, selected, pausing, can]);

  return (
    <section className="c5-manage" aria-labelledby="c5-manage-title">
      <SectionHeader
        titleId="c5-manage-title"
        title={can('tables.manage') ? t('tables.manage.title') : t('tables.manage.titleView')}
        description={t('tables.manage.lede')}
        actions={can('tables.manage') ? <Button variant="outline" size="staff" icon="plus" opensDialog onClick={onAdd}>{t('tables.manage.add')}</Button> : undefined}
      />
      {reprint.length > 0 ? (
        <div className="c5-callout c5-callout--alert c5-reprint" role="status">
          <p>{t('tables.qr.reprintBanner', { tables: reprint.map((x) => x.label).join(', ') })}</p>
          <LinkButton variant="outline" size="staff" icon="qr" href={printHref(reprint.map((x) => x.id))}>{t('tables.qr.printReplaced')}</LinkButton>
        </div>
      ) : null}
      <div className="c5-manage__bar">
        <CheckButton
          label={t('tables.manage.selectAll')}
          checked={allChosen}
          count={tiles.length}
          onChange={(on) => setSelected(on ? new Set(tiles.map((x) => x.id)) : new Set())}
        />
        <span className="c5-manage__count" aria-live="polite">{t('tables.manage.selected', { n: chosen.length })}</span>
        {chosen.length > 0 ? (
          <LinkButton variant="primary" size="staff" icon="qr" href={printHref(chosen)}>{t('tables.manage.printSelected', { n: chosen.length })}</LinkButton>
        ) : (
          <Button variant="primary" size="staff" icon="qr" aria-disabled="true" aria-describedby="c5-print-hint">{t('tables.manage.printSelected', { n: 0 })}</Button>
        )}
        <LinkButton variant="outline" size="staff" href={printHref([])}>{t('tables.manage.printAll')}</LinkButton>
        <span id="c5-print-hint" className="visually-hidden">{t('tables.manage.printHint')}</span>
      </div>
      {loading && tiles.length === 0 ? (
        <div role="status" aria-label={t('common.loading')} className="c5-manage__skel"><Skeleton lines={6} /></div>
      ) : (
        <DataTable<TableTileDTO>
          caption={t('tables.manage.caption')}
          columns={columns}
          rows={tiles}
          rowKey={(r) => r.id}
          actionsLabel={t('common.staff.actions')}
          empty={<EmptyState compact icon="tables" title={t('tables.manage.empty')} />}
          rowActions={(row) => (
            <span className="c5-rowacts">
              <LinkButton variant="ghost" size="staff" icon="qr" href={printHref([row.id])} aria-label={t('tables.manage.printOne', { table: row.label })}>{t('tables.manage.print')}</LinkButton>
              {can('tables.manage') ? (
                <Button variant="ghost" size="staff" opensDialog onClick={() => onEdit(row)} aria-label={t('tables.manage.editOne', { table: row.label })}>{t('common.edit')}</Button>
              ) : null}
              {can('tables.qr_rotate') ? (
                <Button variant="ghost" size="staff" icon="refresh" opensDialog onClick={() => onRotate(row)} aria-label={t('tables.qr.rotateOne', { table: row.label })}>{t('tables.qr.rotate')}</Button>
              ) : null}
            </span>
          )}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------------ create / edit
interface FormProps {
  tile: TableTileDTO | null;
  onClose: () => void;
  onSaved: (tile: TableTileDTO, created: boolean) => void;
  onRotate?: (tile: TableTileDTO) => void;
  refresh: () => void;
}

export function TableFormDialog({ tile, onClose, onSaved, onRotate, refresh }: FormProps) {
  const { t } = useI18n();
  const { can } = useStaff();
  const [label, setLabel] = useState(tile?.label ?? '');
  const [zone, setZone] = useState(tile?.zone ?? '');
  const [sort, setSort] = useState(tile ? String(tile.sort) : '');
  const [enabled, setEnabled] = useState(tile?.enabled ?? true);
  // The version this form edits; refreshed (with a warning) when another device saved first.
  const [version, setVersion] = useState(tile?.version ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [sortError, setSortError] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    setError(null);
    const l = label.trim();
    let bad = false;
    if (!l) { setLabelError(t('tables.manage.labelNeeded')); bad = true; } else setLabelError(null);
    const sortNum = sort.trim() === '' ? undefined : Number(sort);
    if (sortNum !== undefined && !Number.isInteger(sortNum)) { setSortError(t('tables.manage.sortWhole')); bad = true; } else setSortError(null);
    if (bad) return;
    setBusy(true);
    try {
      if (!tile) {
        const created = await api.post<TableTileDTO>('/api/staff/tables', { label: l, zone: zone.trim() || null, sort: sortNum });
        onSaved(created, true);
      } else {
        const patch: Record<string, unknown> = { version };
        if (l !== tile.label) patch.label = l;
        if ((zone.trim() || null) !== tile.zone) patch.zone = zone.trim() || null;
        if (sortNum !== undefined && sortNum !== tile.sort) patch.sort = sortNum;
        if (enabled !== tile.enabled) patch.enabled = enabled;
        if (Object.keys(patch).length === 1) { onClose(); return; }
        const next = await api.patch<TableTileDTO>(`/api/staff/tables/${encodeURIComponent(tile.id)}`, patch);
        onSaved(next, false);
      }
    } catch (err) {
      if (isApiError(err, 'conflict')) setLabelError(t('tables.manage.labelTaken'));
      else if (isApiError(err, 'stale_version') && tile) {
        refresh();
        try {
          const latest = (await api.get<TablesDTO>('/api/staff/tables')).tables.find((x) => x.id === tile.id);
          if (latest) setVersion(latest.version);
        } catch { /* the next save reports it again */ }
        setError(t('tables.manage.staleForm'));
      } else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const hasVisit = Boolean(tile?.visit);
  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={tile ? t('tables.manage.editTitle', { table: tile.label }) : t('tables.manage.addTitle')}
      dismissible={!busy}
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={busy} onClick={() => void save()}>{tile ? t('common.save') : t('tables.manage.create')}</Button>
        </>
      )}
    >
      <div className="c5-form">
        <TextField density="staff" label={t('tables.manage.label')} value={label} maxLength={24} autoComplete="off" onChange={(e) => { setLabel(e.target.value); setLabelError(null); }} error={labelError ?? undefined} help={tile ? t('tables.manage.labelHelp') : undefined} />
        <TextField density="staff" label={t('tables.manage.zone')} optional value={zone} maxLength={40} autoComplete="off" onChange={(e) => setZone(e.target.value)} />
        <TextField density="staff" label={t('tables.manage.sort')} optional inputMode="numeric" value={sort} autoComplete="off" onChange={(e) => { setSort(e.target.value.replace(/[^\d-]/g, '')); setSortError(null); }} error={sortError ?? undefined} help={t('tables.manage.sortHelp')} />
        {tile ? (
          <div className="c5-form__switch">
            <Switch density="staff" checked={enabled} onChange={setEnabled} label={t('tables.manage.enabled')} onLabel={t('tables.manage.enabledOn')} offLabel={t('tables.manage.enabledOff')} />
            {!enabled && hasVisit ? <p className="c5-callout c5-callout--heat">{t('tables.manage.disableWithVisit')}</p> : null}
            {!enabled && !hasVisit ? <p className="c5-note">{t('tables.manage.disableHelp')}</p> : null}
          </div>
        ) : null}
        {tile && onRotate && can('tables.qr_rotate') ? (
          <div className="c5-form__qr">
            <p className="c5-note">{t('tables.qr.rotateHint')}</p>
            <Button variant="danger" size="staff" icon="refresh" opensDialog onClick={() => onRotate(tile)}>{t('tables.qr.rotate')}</Button>
          </div>
        ) : null}
      </div>
      {error ? <p className="field__error c5-block" role="alert">{error}</p> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ rotate QR
export function RotateQrDialog({ tile, onClose, onDone, refresh }: { tile: TableTileDTO; onClose: () => void; onDone: (tile: TableTileDTO) => void; refresh: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const run = async (reason?: string) => {
    if (!reason) return;
    if (reason.trim().length < 3) { setError(t('tables.qr.reasonShort')); return; }
    try {
      const next = await api.post<TableTileDTO>(`/api/staff/tables/${encodeURIComponent(tile.id)}/rotate-qr`, { version: tile.version, reason });
      onDone(next);
    } catch (err) {
      if (isApiError(err, 'stale_version')) { refresh(); setError(t('tables.manage.stale')); } else setError(errorText(t, err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      density="staff"
      tone="danger"
      title={t('tables.qr.rotateTitle', { table: tile.label })}
      confirmLabel={t('tables.qr.rotateConfirm')}
      onConfirm={run}
      error={error}
      reason={{ label: t('billing.reason'), required: true, limit: 200, placeholder: t('tables.qr.rotatePlaceholder') }}
    >
      <p className="c5-callout c5-callout--alert">{t('tables.qr.rotateWarning', { table: tile.label })}</p>
      <p>{t('tables.qr.rotateBody')}</p>
    </Dialog>
  );
}

// ------------------------------------------------------------------ enable
export function EnableDialog({ tile, onClose, onDone, refresh }: { tile: TableTileDTO; onClose: () => void; onDone: (tile: TableTileDTO) => void; refresh: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    try {
      const next = await api.patch<TableTileDTO>(`/api/staff/tables/${encodeURIComponent(tile.id)}`, { enabled: true, version: tile.version });
      onDone(next);
    } catch (err) {
      if (isApiError(err, 'stale_version')) { refresh(); setError(t('tables.manage.stale')); } else setError(errorText(t, err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      density="staff"
      title={t('tables.enable.title', { table: tile.label })}
      confirmLabel={t('tables.enable.confirm', { table: tile.label })}
      onConfirm={run}
      error={error}
    >
      <p>{t('tables.enable.body')}</p>
    </Dialog>
  );
}
