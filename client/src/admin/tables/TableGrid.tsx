// The live table grid (brief 36): one kit TableTile per table, with the facts,
// word badges and the single primary action for its state.
import { forwardRef, type ReactNode } from 'react';
import type { StaffBillDTO, TableTileDTO } from '../../../../shared/dto.ts';
import { clock, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { attentionKinds, TableTile, type AttnKind, type TileAction } from '../../ui/index.ts';
import { paidAt } from '../billing/useBill.tsx';
import { seatedFor } from './shared.ts';

export interface TileHandlers {
  onDetails: (tile: TableTileDTO) => void;
  onSeat: (tile: TableTileDTO) => void;
  onCheckout: (tile: TableTileDTO, bill: StaffBillDTO) => void;
  onEnable: (tile: TableTileDTO) => void;
}

export interface TilePerms {
  seat: boolean;
  checkout: boolean;
  enable: boolean;
}

interface Props extends TileHandlers {
  tile: TableTileDTO;
  bill?: StaffBillDTO;
  now: number;
  selected: boolean;
  freed: boolean;
  perms: TilePerms;
}

/**
 * Rounds and unresolved items (brief 36). Ready food and rounds to accept are
 * already counted on the tile's attention badges (READY 2, NEW 2), so the
 * fact line always states what is still not served.
 */
function roundsFact(t: (k: string, v?: Record<string, string | number>) => string, v: NonNullable<TableTileDTO['visit']>): string {
  if (v.rounds === 0) return t('tables.tile.noRounds');
  const rounds = t(v.rounds === 1 ? 'tables.tile.round' : 'tables.tile.rounds', { n: v.rounds });
  const tail = v.unresolved_lines > 0 ? t('tables.tile.unservedAll', { n: v.unresolved_lines }) : t('tables.tile.allServed');
  return `${rounds} · ${tail}`;
}

export const TableGridTile = forwardRef<HTMLButtonElement, Props>(function TableGridTile(
  { tile, bill, now, selected, freed, perms, onDetails, onSeat, onCheckout, onEnable },
  ref,
) {
  const { t, lang } = useI18n();
  const v = tile.visit;
  const facts: ReactNode[] = [];
  let seated: string | undefined;
  let action: TileAction | undefined;
  const spokenExtra: string[] = [];

  if (tile.state === 'dining' && v) {
    seated = seatedFor(t, v.seated_at, now);
    facts.push(roundsFact(t, v));
    action = { onClick: () => onDetails(tile) };
  } else if (tile.state === 'checking_out' && v) {
    // The kit prints the seated line for dining tiles only; a table paying has been seated just as long.
    seated = seatedFor(t, v.seated_at, now);
    facts.push(<>{t('common.tile.seated')} <b>{seated}</b></>);
    if (bill) {
      const at = paidAt(bill);
      facts.push(
        <>
          {t('tables.tile.bill')} <b>{money(bill.total_minor)}</b>
          {' · '}
          {at ? t('tables.tile.paidAt', { time: clock(at) }) : bill.current_revision && !bill.revision_stale ? t('tables.tile.notPaid') : t('tables.tile.notFinalised')}
        </>,
      );
      spokenExtra.push(at ? t('tables.tile.paidAt', { time: clock(at) }) : t('tables.tile.notPaid'));
    } else {
      facts.push(t('tables.tile.billChecking'));
    }
    facts.push(v.unresolved_lines > 0 ? t('tables.tile.unserved', { n: v.unresolved_lines }) : t('tables.tile.allFoodServed'));
    if (bill?.can_checkout && perms.checkout) {
      action = { onClick: () => onCheckout(tile, bill) };
      spokenExtra.push(t('tables.tile.readyToClose'));
    } else {
      action = { label: t('tables.tile.openBill'), onClick: () => onDetails(tile) };
    }
  } else if (tile.state === 'available') {
    if (perms.seat) action = { onClick: () => onSeat(tile) };
  } else if (tile.state === 'disabled') {
    if (perms.enable) action = { onClick: () => onEnable(tile) };
  }

  if (tile.ordering_paused && tile.state !== 'disabled') {
    facts.push(<span className="c5-fact c5-fact--heat">{t('tables.tile.paused')}</span>);
    spokenExtra.push(t('tables.tile.paused'));
  }
  if (tile.qr?.reprint_required) {
    facts.push(<span className="c5-fact c5-fact--alert">{t('tables.tile.reprint')}</span>);
    spokenExtra.push(t('tables.tile.reprint'));
  }
  if (tile.zone) facts.push(<span className="c5-fact">{tile.zone}</span>);
  // The kit shows "No open visit" / "No seating or ordering" only when there are no other facts.
  if (facts.length > 0 && (tile.state === 'available' || tile.state === 'disabled')) {
    facts.unshift(t(tile.state === 'available' ? 'common.tile.noVisit' : 'common.tile.noSeating'));
  }

  // The tile's one button reads e.g. "Details": its description names the table and state (WCAG 2.4.6).
  const tileId = `c5-tile-${tile.id}`;
  if (action) action = { ...action, describedBy: action.describedBy ?? tileId };

  const kinds = attentionKinds(tile.attention);
  const attention = kinds.map((kind: AttnKind) => ({
    kind,
    detail: kind === 'ready' && v ? v.ready_lines : kind === 'new' && v && v.unaccepted_rounds > 1 ? v.unaccepted_rounds : undefined,
  }));

  const stateWord = t(`table.${tile.state}`);
  const spoken = [
    t('common.table', { label: tile.label }),
    `${lang === 'en' ? stateWord.toLowerCase() : stateWord}${seated ? ` ${seated}` : ''}`,
    ...kinds.map((k) => t(`common.attn.aria.${k}`)),
    ...spokenExtra,
  ].join(lang === 'th' ? ' ' : ', ');

  return (
    <TableTile
      ref={ref}
      label={tile.label}
      state={tile.state}
      attention={attention}
      seated={seated}
      facts={facts.length > 0 ? facts : undefined}
      action={action}
      selected={selected}
      ariaLabel={spoken}
      className={freed ? 'c5-freed' : undefined}
      data-table-id={tile.id}
      id={tileId}
    />
  );
});
