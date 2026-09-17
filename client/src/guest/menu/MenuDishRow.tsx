// One dish on the guest menu: the kit DishRow wired to the draft, the sheets
// and the engagement tracker (brief 09, 33, 34, 39).
//
//  - photo, name and blank space open the dish sheet (not when sold out)
//  - simple fixed-price dish: "เพิ่ม" adds one, the button holds
//    "เพิ่มแล้ว ✓" for 1.2 s, a toast offers undo; after that the foot shows
//    "✓ ในรายการ" and the tinted stepper (focus moves along with it)
//  - dish with variants or choices: "เพิ่ม" opens the sheet
//  - by weight: "ขอให้พนักงานชั่ง" opens the portion request
//  - no table access: every action explains how to join instead of building
//    a draft that could never be sent
import { memo, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { MenuItemDTO } from '../../../../shared/dto.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useItemImpression } from '../../lib/tracker.ts';
import { DishRow, Icon, Tag, useConfirmFlash } from '../../ui/index.ts';
import { RowActionsContext, type RowAccess } from './actions.ts';

export interface MenuDishRowProps {
  item: MenuItemDTO;
  categoryId: string;
  /** Laid-out position (engagement and sheet source). */
  position: number;
  access: RowAccess;
  /** Total quantity of this dish in the draft. */
  qty: number;
  /** The one draft line of this dish, when the inline stepper may change it. */
  lineUid: string | null;
  /** Show the demo-price tag on this row (only when its section is mixed). */
  demoTag: boolean;
  /** "English name as printed" on this row (null when the section already says it). */
  langMarker: string | null;
  /** Search results: the dish's category ("เนื้อ · Beef Selection"). */
  context?: ReactNode;
  priority?: boolean;
}

const REASONS = new Set(['not_verified', 'price_pending', 'seasonal', 'paused', 'alcohol_disabled']);

export const MenuDishRow = memo(function MenuDishRow({
  item, categoryId, position, access, qty, lineUid, demoTag, langMarker, context, priority,
}: MenuDishRowProps) {
  const { t } = useI18n();
  const actions = useContext(RowActionsContext);
  const impression = useItemImpression<HTMLElement>(item.id, categoryId, position);
  const [flashOn, flash] = useConfirmFlash();
  const row = useRef<HTMLElement | null>(null);
  const focusInside = useRef(false);

  const setRow = useCallback((el: HTMLElement | null) => {
    row.current = el;
    const cleanup = impression(el);
    return () => {
      row.current = null;
      if (typeof cleanup === 'function') cleanup();
    };
  }, [impression]);

  const can = access === 'order';
  // An undo during the hold ends the confirmation at once.
  const confirmed = flashOn && can && qty > 0;
  const pricePending = item.unavailable_reason === 'price_pending'
    || (item.pricing_type === 'fixed' && item.price_minor === null);
  const stepper = can && qty > 0 && Boolean(lineUid) && !confirmed && item.quick_add
    && item.orderable && !item.sold_out && !pricePending;

  // The focused Add button becomes a stepper (or back): keep keyboard focus in the row.
  const wasStepper = useRef(stepper);
  useEffect(() => {
    if (wasStepper.current === stepper) return;
    wasStepper.current = stepper;
    const el = row.current;
    if (!el || !focusInside.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && el.contains(active)) return;
    const next = stepper
      ? el.querySelector<HTMLElement>('.stepper button:last-of-type')
      : el.querySelector<HTMLElement>('.dish__foot .btn');
    next?.focus({ preventScroll: true });
  }, [stepper]);

  const blockedReason = !item.orderable && !item.sold_out
    ? t(REASONS.has(item.unavailable_reason ?? '') ? `menu.reason.${item.unavailable_reason}` : 'menu.reason.default')
    : null;

  const kickerParts: ReactNode[] = [];
  if (item.alcohol) kickerParts.push(<span key="alc" className="mdish__alc"><Icon name="glass" />{t('common.alcoholConfirm')}</span>);
  if (demoTag) kickerParts.push(<Tag key="demo" tone="example">{t('menu.demoPrice')}</Tag>);
  const kicker = kickerParts.length ? <span className="mdish__kick">{kickerParts}</span> : undefined;

  const metaParts: ReactNode[] = [];
  if (context) metaParts.push(<span key="ctx" className="mdish__ctx">{context}</span>);
  if (langMarker) metaParts.push(<span key="lang" className="mdish__lang">{langMarker}</span>);
  if (blockedReason) metaParts.push(<span key="why" className="mdish__why"><Icon name="info" size="sm" />{blockedReason}</span>);
  const meta = metaParts.length ? <span className="mdish__meta">{metaParts}</span> : undefined;

  const onAdd = () => {
    if (!actions) return;
    if (access === 'loading') { actions.notReady(); return; }
    if (!can) { actions.explain(); return; }
    if (item.quick_add) {
      if (actions.quickAdd(item)) flash();
    } else {
      actions.open(item, position);
    }
  };

  const onWeigh = () => {
    if (!actions) return;
    if (access === 'loading') { actions.notReady(); return; }
    if (can) actions.weigh(item);
    else actions.explain();
  };

  return (
    <DishRow
      ref={setRow}
      item={item}
      qtyInDraft={can ? qty : 0}
      hasChoices={!item.quick_add}
      kicker={kicker}
      meta={meta}
      priority={priority}
      confirmed={confirmed}
      onOpen={actions ? () => actions.open(item, position) : undefined}
      onAdd={onAdd}
      onChangeQty={stepper && actions && lineUid ? (next) => actions.setQty(item, lineUid, next) : undefined}
      onRemove={stepper && actions && lineUid ? () => actions.removeLine(item, lineUid) : undefined}
      onRequestWeigh={onWeigh}
      onFocus={() => { focusInside.current = true; }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) focusInside.current = false;
      }}
      data-position={position}
    />
  );
});
