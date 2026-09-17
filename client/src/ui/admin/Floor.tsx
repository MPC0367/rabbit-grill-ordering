// The live table strip over the Orders board (DESIGN.md §10.18 compact tiles)
// and the word badges shared with the large table tiles.
import { forwardRef, type HTMLAttributes, type MouseEvent } from 'react';
import type { TableTileDTO } from '../../../../shared/dto.ts';
import type { TableState } from '../../../../shared/status.ts';
import { linkHandler } from '../../lib/router.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { cx, Ico } from './parts.tsx';
import type { TableSwatch } from './Controls.tsx';

export type AttnKind = 'new' | 'ready' | 'call' | 'quote' | 'bill';

/** Most urgent first: a guest calling beats food at the pass beats a new round. */
export const ATTN_PRIORITY: readonly AttnKind[] = ['call', 'ready', 'new', 'quote', 'bill'];

const DTO_ATTN: Record<TableTileDTO['attention'][number], AttnKind> = {
  new_order: 'new',
  ready_food: 'ready',
  service_request: 'call',
  portion_request: 'quote',
  bill_requested: 'bill',
};

/** Maps TableTileDTO.attention to word-badge kinds, most urgent first. */
export function attentionKinds(attention: TableTileDTO['attention']): AttnKind[] {
  const kinds = new Set(attention.map((a) => DTO_ATTN[a]));
  return ATTN_PRIORITY.filter((k) => kinds.has(k));
}

export const STATE_SWATCH: Record<TableState, TableSwatch> = {
  available: 'avail',
  dining: 'dining',
  checking_out: 'bill',
  disabled: 'off',
};

export interface AttnBadgeProps {
  kind: AttnKind;
  /** Count or time after the word ("Ready 1", "Call 19:50"). */
  detail?: string | number;
  className?: string;
}

/** NEW / READY / CALL / QUOTE / BILL in 13px Oswald caps. Overlaid; never replaces the state. */
export function AttnBadge({ kind, detail, className }: AttnBadgeProps) {
  const { t, lang } = useI18n();
  return (
    <span className={cx('attn', `attn--${kind}`, className)} lang={lang}>
      {detail != null && detail !== '' ? `${t(`common.attn.${kind}`)} ${detail}` : t(`common.attn.${kind}`)}
    </span>
  );
}

export interface TableLegendProps {
  counts: Record<TableState, number>;
  className?: string;
}

/** One row: each swatch with its word and count. */
export function TableLegend({ counts, className }: TableLegendProps) {
  const { t } = useI18n();
  const states: TableState[] = ['available', 'dining', 'checking_out', 'disabled'];
  return (
    <ul className={cx('legend', className)} aria-label={t('common.floor.legend')}>
      {states.map((s) => (
        <li key={s} className="legend__i">
          <i className={cx('sw', `sw--${STATE_SWATCH[s]}`)} aria-hidden="true" />
          {t(`table.${s}`)} <b>{counts[s]}</b>
        </li>
      ))}
    </ul>
  );
}

export interface FloorTable {
  id: string;
  label: string;
  state: TableState;
  /** Short seated time for the tile: "48m", "1h 04". */
  duration?: string;
  /** Spoken seated time: "48 minutes". */
  durationLong?: string;
  attention?: AttnKind[];
  /** Full spoken label override. */
  ariaLabel?: string;
}

export interface FloorTileProps extends FloorTable {
  selected?: boolean;
  onSelect?: (id: string) => void;
  className?: string;
}

/** Compact 48px tile: Oswald 22 number + a state word; one attention badge hangs over the top edge. */
export const FloorTile = forwardRef<HTMLButtonElement, FloorTileProps>(function FloorTile(
  { id, label, state, duration, durationLong, attention = [], ariaLabel, selected, onSelect, className },
  ref,
) {
  const { t, lang } = useI18n();
  const word = state === 'available' ? t('common.floor.free')
    : state === 'checking_out' ? t('common.floor.bill')
    : state === 'disabled' ? t('common.floor.off')
    : duration ?? '';
  const badge = ATTN_PRIORITY.find((k) => attention.includes(k));
  const stateWord = t(`table.${state}`);
  const spoken = ariaLabel ?? [
    `${t('common.table', { label })}`,
    `${lang === 'en' ? stateWord.toLowerCase() : stateWord}${state === 'dining' && (durationLong ?? duration) ? ` ${durationLong ?? duration}` : ''}`,
    ...ATTN_PRIORITY.filter((k) => attention.includes(k)).map((k) => t(`common.attn.aria.${k}`)),
  ].join(lang === 'th' ? ' ' : ', ');
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ttile', `ttile--${STATE_SWATCH[state]}`, selected && 'is-selected', className)}
      aria-label={spoken}
      aria-pressed={onSelect && selected !== undefined ? selected : undefined}
      onClick={onSelect ? () => onSelect(id) : undefined}
    >
      {badge ? <AttnBadge kind={badge} /> : null}
      <span className="ttile__n">{label}</span>
      <span className="ttile__s">{word}</span>
    </button>
  );
});

export interface TableStripProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  tables: FloorTable[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** "Open Tables ›" link. */
  openHref?: string;
  onOpen?: (e: MouseEvent<HTMLAnchorElement>) => void;
  title?: string;
}

/** Live floor strip with a legend whose counts are computed from the same tiles, so they always reconcile. */
export const TableStrip = forwardRef<HTMLElement, TableStripProps>(function TableStrip(
  { tables, selectedId, onSelect, openHref, onOpen, title, className, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  const counts: Record<TableState, number> = { available: 0, dining: 0, checking_out: 0, disabled: 0 };
  for (const tb of tables) counts[tb.state] += 1;
  return (
    <section ref={ref} {...rest} className={cx('floor', className)} aria-label={t('common.floor.label')}>
      <div className="floor__legend">
        <p className="cap" lang={lang}>{title ?? t('common.floor.title')}</p>
        <TableLegend counts={counts} />
      </div>
      {openHref ? (
        <a className="btn btn--ghost floor__link" href={openHref} onClick={(e) => (onOpen ? onOpen(e) : linkHandler(e))}>
          {t('common.floor.open')}
          <Ico name="chev-r" />
        </a>
      ) : <span />}
      <ul className="strip">
        {tables.map((tb) => (
          <li key={tb.id}>
            <FloorTile {...tb} selected={selectedId === undefined ? undefined : selectedId === tb.id} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
});
