// DishRow (DESIGN §10.6) and the printed-menu section it sits in.
//   [plate 4:3]  [kicker?]
//                name ········· ฿price [unit]
//                English italic (full width)
//                unit / note?
//                [state?]              [action]
// Presentational: data by props, actions by callbacks.
import { forwardRef, useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { MenuItemDTO } from '../../../shared/dto.ts';
import { useI18n, type Picked } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { Button } from './Button.tsx';
import { Price } from './Price.tsx';
import { Stepper } from './Stepper.tsx';
import { DishImage } from './DishImage.tsx';

export type DishRowItem = Pick<
  MenuItemDTO,
  'id' | 'name' | 'pricing_type' | 'price_minor' | 'rate_minor' | 'rate_basis_grams' | 'variants' | 'image'
  | 'sold_out' | 'orderable' | 'unavailable_reason' | 'quick_add' | 'portion_note' | 'max_qty'
>;

export interface DishRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  item: DishRowItem;
  /** Total quantity of this dish in the device draft (0 = not in the draft). */
  qtyInDraft?: number;
  /** The dish opens the sheet for choices (default: !item.quick_add). */
  hasChoices?: boolean;
  /** Extra kicker above the name (the by-weight kicker is automatic). */
  kicker?: ReactNode;
  /** Meta line under the names (search results: "เนื้อ · Beef Selection"). */
  meta?: ReactNode;
  /** Opens the item sheet (row, photo and name). Not used when sold out. */
  onOpen?: () => void;
  /** Quick add (simple dish) or open the sheet (dish with choices). */
  onAdd?: () => void;
  /** Inline stepper for a simple dish already in the draft. */
  onChangeQty?: (next: number) => void;
  /** Stepper "−" at 1: remove the line (show an undo toast). */
  onRemove?: () => void;
  /** By-weight dishes: "ขอให้พนักงานชั่ง" opens the portion request. */
  onRequestWeigh?: () => void;
  /** Show "เพิ่มแล้ว ✓" on the Add button (hold 1.2s after a successful add). */
  confirmed?: boolean;
  /** Add in progress (spinner, double taps ignored). */
  busy?: boolean;
  headingLevel?: 2 | 3 | 4;
  /** Eager-load photos in the first viewport. */
  priority?: boolean;
}

function variantPrice(item: DishRowItem): { minor: number | null; from: boolean } {
  const prices = item.variants.filter((v) => v.available && v.price_minor !== null).map((v) => v.price_minor as number);
  if (!prices.length) return { minor: null, from: false };
  const min = Math.min(...prices);
  return { minor: min, from: prices.some((p) => p !== min) };
}

export const DishRow = forwardRef<HTMLElement, DishRowProps>(function DishRow(
  {
    item, qtyInDraft = 0, hasChoices, kicker, meta, onOpen, onAdd, onChangeQty, onRemove, onRequestWeigh,
    confirmed, busy, headingLevel = 3, priority, className, ...rest
  },
  ref,
) {
  const { t, both } = useI18n();
  const nameId = useId();
  const [photoFailed, setPhotoFailed] = useState(false);

  const names = both(item.name);
  const primary: Picked = names.primary;
  const secondary: Picked | null = names.secondary;
  const byWeight = item.pricing_type === 'measured_weight';
  const soldOut = item.sold_out;
  const choices = hasChoices ?? !item.quick_add;
  const withPhoto = Boolean(item.image) && !photoFailed;
  const H = `h${headingLevel}` as 'h3';

  // price column
  let priceMinor: number | null = null;
  let from = false;
  if (byWeight) priceMinor = item.rate_minor;
  else if (item.pricing_type === 'variant') ({ minor: priceMinor, from } = variantPrice(item));
  else priceMinor = item.price_minor;
  const pending = priceMinor === null || item.unavailable_reason === 'price_pending';
  const unit = byWeight && item.rate_basis_grams ? t('common.perGrams', { n: item.rate_basis_grams }) : undefined;
  const portion = item.portion_note ? both(item.portion_note).primary : null;
  const canOpen = Boolean(onOpen) && !soldOut;
  const inDraft = qtyInDraft > 0;

  const secondaryLine = secondary ? (
    secondary.lang === 'en'
      ? <p className="en" lang="en">{secondary.text}</p>
      : <p className="dish__alt" lang={secondary.lang}>{secondary.text}</p>
  ) : null;

  // foot: state (left) + action (right)
  let state: ReactNode = null;
  let action: ReactNode = null;
  if (soldOut) {
    action = (
      <p className="soldout">
        <Icon name="slash" />
        {t('common.soldOut')}
      </p>
    );
  } else if (byWeight) {
    if (item.orderable && onRequestWeigh) {
      action = (
        <Button
          variant="secondary"
          icon="scale"
          opensDialog
          aria-label={t('common.askToWeighNamed', { name: primary.text })}
          onClick={onRequestWeigh}
        >
          {t('common.askToWeigh')}
        </Button>
      );
    }
  } else if (item.orderable && !pending) {
    if (inDraft && !choices && onChangeQty) {
      state = (
        <p className="dish__state"><Icon name="check" />{t('common.inOrder')}</p>
      );
      action = (
        <Stepper
          value={qtyInDraft}
          min={1}
          max={item.max_qty}
          label={t('common.qtyInOrder', { name: primary.text })}
          onChange={onChangeQty}
          onRemove={onRemove}
        />
      );
    } else if (onAdd) {
      if (inDraft) {
        state = (
          <p className="dish__state"><Icon name="check" />{t('common.inOrderCount', { n: qtyInDraft })}</p>
        );
      }
      action = (
        <Button
          variant="secondary"
          className="btn--add"
          icon="plus"
          iconBold
          loading={busy}
          confirmed={confirmed}
          opensDialog={choices}
          aria-label={confirmed ? undefined : t(choices ? 'common.addNamedChoices' : 'common.addNamed', { name: primary.text })}
          onClick={onAdd}
        >
          {t('common.add')}
        </Button>
      );
    }
  }

  // Text-led rows carry the English line in the foot, left of the action, when there is no state.
  const secondaryInFoot = !withPhoto && !state && Boolean(secondaryLine) && Boolean(action);

  const nameNode = canOpen ? (
    <button type="button" className="dish__open" aria-haspopup="dialog" onClick={onOpen} lang={primary.lang}>
      {primary.text}
    </button>
  ) : (
    <span lang={primary.lang}>{primary.text}</span>
  );

  return (
    <article
      ref={ref}
      aria-labelledby={nameId}
      className={cx('dish', !withPhoto && 'dish--text', byWeight && 'dish--weight', soldOut && 'is-soldout', className)}
      data-item={item.id}
      {...rest}
    >
      {withPhoto ? (
        <div className="dish__plate" aria-hidden="true">
          <DishImage
            image={item.image}
            decorative
            loading={priority ? 'eager' : 'lazy'}
            onFallback={() => setPhotoFailed(true)}
          />
        </div>
      ) : null}
      <div className="dish__body">
        {byWeight ? (
          <p className="dish__kick"><Icon name="scale" />{t('common.priceByWeight')}</p>
        ) : kicker ? (
          <p className="dish__kick">{kicker}</p>
        ) : null}
        <div className="lead">
          <H className="dish__name" id={nameId}>{nameNode}</H>
          <span className="lead__dots" aria-hidden="true" />
          <p className={cx('lead__val', !unit && !from && 'price')}>
            {pending ? (
              <span className="is-pending">{t('common.pricePending')}</span>
            ) : unit ? (
              <Price minor={priceMinor} unit={unit} stackUnit as="span" />
            ) : from ? (
              <><span className="dish__from">{t('common.priceFrom')}</span><Price minor={priceMinor} /></>
            ) : (
              <Price minor={priceMinor} plain />
            )}
          </p>
        </div>
        {secondaryInFoot ? null : secondaryLine}
        {portion ? <p className="dish__unit" lang={portion.lang}>{portion.text}</p> : null}
        {meta ? <p className="dish__meta">{meta}</p> : null}
        {byWeight ? <p className="dish__note">{t('common.weighNote')}</p> : null}
        {state || action || secondaryInFoot ? (
          <div className="dish__foot">
            {secondaryInFoot ? secondaryLine : state ?? <span />}
            {action}
          </div>
        ) : null}
      </div>
    </article>
  );
});

// ---------------------------------------------------------------- section
export interface MenuSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Section anchor id (the category row scrolls here). */
  id: string;
  /** "01": the display position among published categories. */
  numeral: string;
  title: string;
  titleLang?: string;
  /** English italic on the right (Thai in support type when viewing English). */
  secondary?: string | null;
  secondaryLang?: string;
  /** Owner note under the title ("ไพร์มริบคิดราคาตามน้ำหนัก"). */
  hint?: ReactNode;
  children: ReactNode;
}

/** No. 01 kicker on a hairline, Thai h2 with the italic English right-aligned, then a list whose first row sits under an ink rule. */
export const MenuSection = forwardRef<HTMLElement, MenuSectionProps>(function MenuSection(
  { id, numeral, title, titleLang, secondary, secondaryLang = 'en', hint, children, className, ...rest },
  ref,
) {
  const headingId = `${id}-h`;
  return (
    <section ref={ref} id={id} aria-labelledby={headingId} className={cx('msec', className)} {...rest}>
      <p className="msec__kick" lang="en" aria-hidden="true">No. {numeral}</p>
      <div className="msec__title">
        <h2 id={headingId} lang={titleLang}>{title}</h2>
        {secondary ? <p className="en" lang={secondaryLang}>{secondary}</p> : null}
      </div>
      {hint ? <p className="msec__hint">{hint}</p> : null}
      <div className="msec__list">{children}</div>
    </section>
  );
});
