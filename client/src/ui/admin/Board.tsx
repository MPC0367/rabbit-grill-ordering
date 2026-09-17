// Column board (DESIGN.md §10.17) and its toolbar (§10.30).
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';
import type { Station } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { SegmentedControl } from '../SegmentedControl.tsx';
import { EmptyState } from '../Feedback.tsx';
import { CheckButton, FilterChips, SelectButton, StaffSearch } from './Controls.tsx';
import { cx, Ico, safeId, type AdminIconName } from './parts.tsx';

export type BoardStage = 'submitted' | 'accepted' | 'preparing' | 'almost_done' | 'ready';

export const BOARD_STAGES: readonly BoardStage[] = ['submitted', 'accepted', 'preparing', 'almost_done', 'ready'];

const STAGE_GLYPH: Record<BoardStage, AdminIconName> = {
  submitted: 'plus',
  accepted: 'check',
  preparing: 'pan',
  almost_done: 'half',
  ready: 'cloche',
};

export interface BoardColumnProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  stage: BoardStage;
  count: number;
  /** Defaults to the staff status word. */
  title?: string;
  /** Defaults: New "Accept to confirm", Almost done "optional", Ready "at the pass". Pass null to hide. */
  hint?: string | null;
  /** Text under the tickets. Almost done defaults to its "optional" explanation. */
  help?: ReactNode | null;
  /** Shown when count is 0. */
  empty?: ReactNode;
  /** The one column shown on tablet and phone (single-column board). */
  current?: boolean;
  children?: ReactNode;
}

export const BoardColumn = forwardRef<HTMLElement, BoardColumnProps>(function BoardColumn(
  { stage, count, title, hint, help, empty, current, children, className, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  const headId = `col-${safeId(useId())}`;
  const defaultHint = stage === 'submitted' ? t('common.board.acceptHint')
    : stage === 'almost_done' ? t('common.board.optional')
    : stage === 'ready' ? t('common.board.atPass')
    : null;
  const shownHint = hint === undefined ? defaultHint : hint;
  const shownHelp = help === undefined ? (stage === 'almost_done' ? t('common.board.almostHelp') : null) : help;
  return (
    <section
      ref={ref}
      {...rest}
      className={cx('col', stage === 'submitted' && 'col--new', stage === 'ready' && 'col--ready', current && 'is-current', className)}
      aria-labelledby={headId}
    >
      <header className="col__head">
        <span className="glyph" aria-hidden="true"><Ico name={STAGE_GLYPH[stage]} /></span>
        <h2 id={headId} lang={lang}>
          {title ?? t(`common.staff.status.${stage}`)}
          <span className="sr">, {t('common.board.tickets', { n: count })}</span>
        </h2>
        <span className="col__count" aria-hidden="true">{count}</span>
        {shownHint ? <span className="col__hint">{shownHint}</span> : null}
      </header>
      <div className="col__stack">
        {children}
        {count === 0 ? (
          empty ?? <EmptyState compact className="col__empty" icon={STAGE_GLYPH[stage]} title={t('common.board.empty')} />
        ) : null}
        {shownHelp ? <p className="col__help">{shownHelp}</p> : null}
      </div>
    </section>
  );
});

export interface BoardGridProps extends HTMLAttributes<HTMLDivElement> {
  /** "columns": five columns side by side (≥ 1200). "single": one status at a time, tickets in a grid. */
  layout?: 'columns' | 'single';
}

export function BoardGrid({ layout = 'columns', className, children, ...rest }: BoardGridProps) {
  return (
    <div {...rest} className={cx('board', layout === 'single' && 'board--single', className)}>
      {children}
    </div>
  );
}

export interface BoardStatusSwitchProps {
  counts: Partial<Record<BoardStage, number>>;
  value: BoardStage;
  onChange: (stage: BoardStage) => void;
  className?: string;
}

/** Tablet and phone: choose the one status column to show (New · Accepted · Preparing · Almost done · Ready). */
export function BoardStatusSwitch({ counts, value, onChange, className }: BoardStatusSwitchProps) {
  const { t } = useI18n();
  return (
    <div className={cx('boardtabs is-on', className)}>
      <SegmentedControl<BoardStage>
        size="staff"
        label={t('common.board.status')}
        value={value}
        onChange={onChange}
        options={BOARD_STAGES.map((s) => ({ value: s, label: t(`common.staff.status.${s}`), count: counts[s] ?? 0 }))}
      />
    </div>
  );
}

export interface BoardToolbarProps {
  /** Ticket counts per station; the "All stations" chip is added first. */
  stationCounts: Partial<Record<Station, number>>;
  station: Station | 'all';
  onStation: (station: Station | 'all') => void;
  tables: ReadonlyArray<{ value: string; label: string }>;
  table: string;
  onTable: (value: string) => void;
  sorts: ReadonlyArray<{ value: string; label: string }>;
  sort: string;
  onSort: (value: string) => void;
  showExceptions: boolean;
  onShowExceptions: (next: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  className?: string;
}

/** One row of 48px controls: station chips, table, sort, rejected/cancelled toggle, search pushed right. */
export function BoardToolbar({
  stationCounts, station, onStation, tables, table, onTable, sorts, sort, onSort,
  showExceptions, onShowExceptions, query, onQuery, className,
}: BoardToolbarProps) {
  const { t } = useI18n();
  const stations = (Object.keys(stationCounts) as Station[]).map((s) => ({
    value: s as Station | 'all',
    label: t(`common.board.${s}`),
    count: stationCounts[s],
  }));
  return (
    <div className="toolbar-cq">
      <div className={cx('toolbar', className)} role="group" aria-label={t('common.board.filters')}>
        <FilterChips
          label={t('common.board.station')}
          value={station}
          onChange={onStation}
          options={[{ value: 'all', label: t('common.board.allStations') }, ...stations]}
        />
        <SelectButton label={t('common.board.table')} value={table} options={tables} onChange={onTable} />
        <SelectButton label={t('common.board.sort')} icon="sort" value={sort} options={sorts} onChange={onSort} />
        <CheckButton label={t('common.board.showExceptions')} checked={showExceptions} onChange={onShowExceptions} />
        <StaffSearch label={t('common.board.search')} placeholder={t('common.board.searchShort')} value={query} onChange={onQuery} />
      </div>
    </div>
  );
}
