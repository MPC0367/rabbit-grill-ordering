// One draft line on "Your order", the review step and the desktop panel.
// Built on the kit OrderLine; adds the chosen options, the allergy mark, the
// English-only name marker and the exact per-line quote issues with their fix.
import type { ReactNode } from 'react';
import type { Bilingual, MenuItemDTO, QuoteIssue } from '../../../../shared/dto.ts';
import { money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Icon, OrderLine, Stepper, Tag, cx } from '../../ui/index.ts';
import { lineDisplay, MAX_QTY_FALLBACK } from './model.ts';
import type { LineView } from './store.ts';

export type DraftLineMode = 'edit' | 'review' | 'panel';

export interface DraftLineProps {
  view: LineView;
  item: MenuItemDTO | undefined;
  mode: DraftLineMode;
  /** Mark placeholder configuration (the demo coffee-beans attachment). */
  example?: boolean;
  onQuantity?: (uid: string, quantity: number) => void;
  onRemove?: (uid: string) => void;
  onEdit?: (uid: string, itemId: string) => void;
  onAcceptPrice?: (uid: string, unitMinor: number) => void;
  onWeigh?: (itemId: string) => void;
  /** Controls are unavailable (a submission is being resolved, or ordering is blocked for edits). */
  locked?: boolean;
}

const CHOICE_CODES: ReadonlyArray<QuoteIssue['code']> = ['variant_unavailable', 'variant_required', 'modifier_unavailable', 'modifier_invalid', 'modifier_required'];
const GONE_CODES: ReadonlyArray<QuoteIssue['code']> = ['sold_out', 'not_orderable', 'item_missing'];

export function hasThaiGap(name: Bilingual, lang: string): boolean {
  return lang === 'th' && !name.th && Boolean(name.en);
}

export function DraftLine({ view, item, mode, example, onQuantity, onRemove, onEdit, onAcceptPrice, onWeigh, locked }: DraftLineProps) {
  const { t, pick, lang } = useI18n();
  const { line, quoted, issues } = view;
  const display = lineDisplay(line, item, quoted);
  const name = pick(display.name);
  const gone = issues.some((i) => GONE_CODES.includes(i.code));
  const editable = mode === 'edit' && !view.frozen && !locked;
  const maxQty = item?.max_qty ?? line.max_qty ?? MAX_QTY_FALLBACK;

  // ---- options: variant, choices (charged ones show their price), allergy mark
  const parts: ReactNode[] = [];
  if (display.variant) {
    const v = pick(display.variant);
    parts.push(<span key="v" lang={v.lang}>{v.text}</span>);
  }
  for (const [i, o] of display.options.entries()) {
    const p = pick(o.name);
    parts.push(
      <span key={`o${i}`}>
        <span lang={p.lang}>{p.text}</span>
        {o.price_minor ? <span className="c1b-line__plus"> {money(o.price_minor, { sign: true })}</span> : null}
      </span>,
    );
  }
  if (example && display.options.length) parts.push(<Tag key="ex" tone="example" />);
  if (line.allergy_note && line.note) parts.push(<Tag key="al" tone="alert" icon="alert">{t('cart.allergyMark')}</Tag>);
  const joined = parts.flatMap((p, i) => (i ? [<span key={`s${i}`} aria-hidden="true">·</span>, p] : [p]));
  // No Thai name on file: say so visibly (it sits on its own row above the quantity).
  if (hasThaiGap(display.name, lang)) joined.push(<span key="en" className="c1b-enonly" lang={lang}>{t('common.enOnly')}</span>);
  const options = joined.length ? joined : undefined;

  // ---- issues and their fixes
  const messages: string[] = [];
  const fixes: ReactNode[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const kind = GONE_CODES.includes(issue.code) ? 'gone' : CHOICE_CODES.includes(issue.code) ? 'choice' : issue.code;
    if (seen.has(kind)) continue;
    seen.add(kind);
    switch (issue.code) {
      case 'sold_out':
      case 'not_orderable':
      case 'item_missing':
        messages.push(t(`cart.issue.${issue.code}`));
        if (mode !== 'review' && onRemove && !view.frozen) {
          fixes.push(
            <Button key="rm" variant="danger" onClick={() => onRemove(line.uid)} aria-label={t('cart.removeNamed', { name: name.text })}>
              {t('cart.fix.remove')}
            </Button>,
          );
        }
        break;
      case 'price_changed': {
        const next = issue.current?.unit_price_minor;
        messages.push(line.expected_unit_minor !== null && next !== undefined
          ? t('cart.issue.price_changed', { old: money(line.expected_unit_minor), new: money(next) })
          : t('cart.issue.price_changed_new', { new: next !== undefined ? money(next) : '—' }));
        if (mode !== 'review' && onAcceptPrice && next !== undefined && !view.frozen) {
          fixes.push(
            <Button key="acc" variant="secondary" icon="check" iconBold onClick={() => onAcceptPrice(line.uid, next)}>
              {t('cart.fix.accept')}
            </Button>,
          );
        }
        break;
      }
      case 'variant_unavailable':
      case 'modifier_unavailable':
      case 'modifier_invalid':
      case 'variant_required':
      case 'modifier_required':
        messages.push(t(issue.code.endsWith('_required') ? 'cart.issue.required' : 'cart.issue.choice'));
        if (mode !== 'review' && onEdit && item && !gone && !view.frozen) {
          fixes.push(
            <Button key="ch" variant="secondary" opensDialog onClick={() => onEdit(line.uid, line.item_id)}>
              {t('cart.fix.choose')}
            </Button>,
          );
        }
        break;
      case 'quantity_invalid':
        messages.push(item ? t('cart.issue.quantity', { n: item.max_qty }) : t('cart.issue.quantityPlain'));
        if (mode !== 'review' && onQuantity && item && !view.frozen) {
          fixes.push(
            <Button key="qt" variant="secondary" onClick={() => onQuantity(line.uid, Math.min(line.quantity, item.max_qty))}>
              {t('cart.fix.quantity')}
            </Button>,
          );
        }
        break;
      case 'note_too_long':
      case 'notes_not_allowed':
        messages.push(t(`cart.issue.${issue.code}`));
        if (mode !== 'review' && onEdit && item && !gone && !view.frozen) {
          fixes.push(
            <Button key="nt" variant="secondary" opensDialog onClick={() => onEdit(line.uid, line.item_id)}>
              {t('cart.fix.note')}
            </Button>,
          );
        }
        break;
      case 'measured_weight_needs_quote':
        messages.push(t('cart.issue.weigh'));
        if (mode !== 'review' && onWeigh && !view.frozen) {
          fixes.push(
            <Button key="wg" variant="secondary" icon="scale" opensDialog onClick={() => onWeigh(line.item_id)}>
              {t('common.askToWeigh')}
            </Button>,
          );
        }
        break;
    }
  }

  const actions: ReactNode[] = [];
  if (mode === 'edit') {
    if (!gone) {
      actions.push(
        <Stepper
          key="qty"
          value={line.quantity}
          min={1}
          max={maxQty}
          onChange={(n) => onQuantity?.(line.uid, n)}
          onRemove={editable ? () => onRemove?.(line.uid) : undefined}
          disabled={!editable}
          label={t('common.qtyInOrder', { name: name.text })}
          removeLabel={t('cart.removeNamed', { name: name.text })}
        />,
      );
    }
    if (fixes.length) actions.unshift(<div key="fixes" className="c1b-fixes">{fixes}</div>);
    if (editable && item && !gone && fixes.length === 0) {
      actions.push(
        <Button key="edit" variant="ghost" icon="note" opensDialog onClick={() => onEdit?.(line.uid, line.item_id)} aria-label={t('cart.editNamed', { name: name.text })}>
          {t('common.edit')}
        </Button>,
      );
    }
    if (editable && !gone) {
      actions.push(
        <Button key="rm" variant="ghost" onClick={() => onRemove?.(line.uid)} aria-label={t('cart.removeNamed', { name: name.text })}>
          {t('cart.remove')}
        </Button>,
      );
    }
  }


  return (
    <OrderLine
      size={mode === 'panel' ? 'md' : 'lg'}
      className={cx('c1b-line', gone && 'is-soldout', view.frozen && 'is-frozen', issues.length > 0 && 'has-issue')}
      data-uid={line.uid}
      name={name.text || '—'}
      nameLang={name.lang}
      image={item?.image ?? line.image}
      quantity={line.quantity}
      totalMinor={view.totalMinor}
      options={options}
      note={line.note}
      issue={messages.length ? messages.join(' ') : undefined}
      actions={actions.length ? actions : undefined}
    />
  );
}

/** Small "this line is locked" note for lines inside an unresolved submission. */
export function FrozenNote() {
  const { t } = useI18n();
  return (
    <p className="meta c1b-frozen"><Icon name="clock" size="sm" /><span>{t('submit.frozen')}</span></p>
  );
}
