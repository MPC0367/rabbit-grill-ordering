// DataTable (DESIGN.md §10.23): a real <table> with caption, sticky header,
// sortable headers (aria-sort), row actions, empty state and footer.
import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { cx, Ico } from './parts.tsx';

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Right-aligned tabular numbers. */
  numeric?: boolean;
  /** Oswald, tracked (references). */
  code?: boolean;
  sortable?: boolean;
  width?: string;
  className?: string;
  /** Plain-text header for the sort button's name when `header` is not a string. */
  headerText?: string;
  /** Let long text wrap (cells stay on one line by default; the frame scrolls sideways instead). */
  wrap?: boolean;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  caption: ReactNode;
  /** Show the caption visibly (it is always read by screen readers). */
  showCaption?: boolean;
  sort?: SortState | null;
  onSort?: (key: string) => void;
  /** Selected row: hover wash + 3px ember left bar. */
  selectedKey?: string | null;
  /** Trailing actions cell per row. */
  rowActions?: (row: T) => ReactNode;
  actionsLabel?: string;
  /** Shown inside the frame when there are no rows. */
  empty?: ReactNode;
  /** Footer row content ("Show all 39 rounds", pagination, counts). */
  footer?: ReactNode;
  /** Scroll inside the frame with a sticky header. */
  maxHeight?: number | string;
  className?: string;
  id?: string;
}

export function DataTable<T>({
  columns, rows, rowKey, caption, showCaption, sort, onSort, selectedKey, rowActions, actionsLabel,
  empty, footer, maxHeight, className, id,
}: DataTableProps<T>) {
  const { t } = useI18n();
  const span = columns.length + (rowActions ? 1 : 0);
  const frameStyle: CSSProperties | undefined = maxHeight != null ? { maxHeight } : undefined;
  return (
    <div className={cx('dtable-frame', maxHeight != null && 'is-scroll', className)} style={frameStyle} tabIndex={maxHeight != null ? 0 : undefined} role={maxHeight != null ? 'region' : undefined} aria-label={maxHeight != null && typeof caption === 'string' ? caption : undefined}>
      <table className="dtable" id={id}>
        <caption className={showCaption ? 'dtable__cap' : 'sr'}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = c.sortable && active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th key={c.key} scope="col" className={cx(c.numeric && 'n', c.className)} style={c.width ? { width: c.width } : undefined} aria-sort={ariaSort}>
                  {c.sortable && onSort ? (
                    <button
                      type="button"
                      className={cx('dtable__sort', active && 'is-active')}
                      aria-label={(() => {
                        const text = c.headerText ?? (typeof c.header === 'string' ? c.header : null);
                        return text ? t('common.staff.sortBy', { col: text }) : undefined;
                      })()}
                      onClick={() => onSort(c.key)}
                    >
                      {c.header}
                      <Ico name={active ? 'chev-d' : 'sort'} size="xs" className={cx(active && sort?.dir === 'asc' && 'is-asc')} />
                    </button>
                  ) : c.header}
                </th>
              );
            })}
            {rowActions ? <th scope="col" className="dtable__act"><span className="sr">{actionsLabel ?? t('common.staff.actions')}</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="dtable__empty">
              <td colSpan={span}>
                {empty ?? <p className="dtable__none">{t('common.staff.noRows')}</p>}
              </td>
            </tr>
          ) : rows.map((row, i) => {
            const k = rowKey(row);
            const sel = selectedKey != null && selectedKey === k;
            return (
              <tr key={k} className={cx(sel && 'is-selected')} aria-current={sel ? 'true' : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={cx(c.numeric && 'n', c.code && 'code', c.wrap && 'is-wrap', c.className)}>
                    {c.cell(row, i)}
                  </td>
                ))}
                {rowActions ? <td className="dtable__act">{rowActions(row)}</td> : null}
              </tr>
            );
          })}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              <td colSpan={span}>{footer}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
