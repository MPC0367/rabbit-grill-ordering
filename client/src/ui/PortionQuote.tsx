// PortionQuote (DESIGN §10.15, brief 44A). A weighed cut is not an order
// until the guest confirms the quote; it never counts in the subtotal before.
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';
import { clock, grams as gramsLabel } from '../lib/format.ts';
import { useI18n, type Picked } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { Button } from './Button.tsx';
import { Leader, Price } from './Price.tsx';

export type PortionQuoteState = 'requested' | 'quoted' | 'confirmed' | 'expired' | 'revised';

export interface PortionQuoteProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  state: PortionQuoteState;
  /** Dish name in the reading language (pick()). */
  name: Picked;
  /** Other-language name (English italic when reading Thai). */
  secondary?: Picked | null;
  grams?: number | null;
  rateMinor?: number | null;
  basisGrams?: number;
  amountMinor?: number | null;
  /** Quote expiry (ISO). */
  expiresAt?: string | null;
  /** Revised quotes: the earlier weight and amount, struck in the history line only. */
  previous?: { grams: number; amountMinor: number } | null;
  onConfirm?: () => void;
  onChange?: () => void;
  onRequestAgain?: () => void;
  busy?: boolean;
  /** Extra line (e.g. chosen options). */
  children?: ReactNode;
}

export const PortionQuote = forwardRef<HTMLElement, PortionQuoteProps>(function PortionQuote(
  { state, name, secondary, grams, rateMinor, basisGrams = 100, amountMinor, expiresAt, previous, onConfirm, onChange, onRequestAgain, busy, children, className, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  const titleId = useId();
  const priced = state === 'quoted' || state === 'revised' || state === 'confirmed';
  const kicker = t(`common.portion.${state}`);
  const muted = state === 'expired' || state === 'requested';

  let honest: ReactNode;
  if (state === 'requested') honest = t('common.weighNote');
  else if (state === 'confirmed') honest = t('common.portion.confirmedNote');
  else if (state === 'expired') honest = null;
  else honest = expiresAt ? t('common.portion.hold', { time: clock(expiresAt) }) : null;

  return (
    <section ref={ref} aria-labelledby={titleId} className={cx('card quote', muted && 'is-muted', className)} {...rest}>
      <p className="quote__k">
        <Icon name={state === 'confirmed' ? 'check' : state === 'expired' ? 'clock' : 'scale'} size="sm" />
        {kicker}
      </p>
      <h2 className="quote__t" id={titleId}>
        <span lang={name.lang}>{name.text}</span>
        {secondary ? <> <span className={secondary.lang === 'en' ? 'en' : 'meta'} lang={secondary.lang}>{secondary.text}</span></> : null}
      </h2>
      {priced || (rateMinor !== null && rateMinor !== undefined) ? (
        <dl>
          {priced && grams ? (
            <Leader definition label={t('common.portion.weighed')} value={gramsLabel(grams, lang)} />
          ) : null}
          {rateMinor !== null && rateMinor !== undefined ? (
            <Leader definition label={t('common.portion.rate', { n: basisGrams })} value={<Price minor={rateMinor} plain />} />
          ) : null}
          {priced && amountMinor !== null && amountMinor !== undefined ? (
            <Leader
              definition
              label={t('common.portion.total')}
              labelClassName="is-total"
              value={<Price minor={amountMinor} plain />}
              valueClassName="total"
            />
          ) : null}
        </dl>
      ) : null}
      {state === 'revised' && previous ? (
        <p className="quote__prev">
          {t('common.portion.previous')} <s>{gramsLabel(previous.grams, lang)} · <Price minor={previous.amountMinor} plain /></s>
        </p>
      ) : null}
      {children}
      {honest ? <p className="support">{honest}</p> : null}
      {(state === 'quoted' || state === 'revised') && (onConfirm || onChange) ? (
        <div className={cx('quote__actions', !(onConfirm && onChange) && 'quote__actions--one')}>
          {onConfirm ? <Button variant="primary" size="lg" loading={busy} onClick={onConfirm}>{t('common.portion.confirm')}</Button> : null}
          {onChange ? <Button variant="outline" size="lg" opensDialog onClick={onChange} disabled={busy}>{t('common.portion.change')}</Button> : null}
        </div>
      ) : null}
      {state === 'expired' && onRequestAgain ? (
        <div className="quote__actions quote__actions--one">
          <Button variant="secondary" size="lg" icon="scale" opensDialog loading={busy} onClick={onRequestAgain}>{t('common.portion.again')}</Button>
        </div>
      ) : null}
    </section>
  );
});
