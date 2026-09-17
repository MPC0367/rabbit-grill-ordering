// The dish sheet (DESIGN §10.7, brief 10, 11, 44B-C). Stream C1b.
// Bottom sheet on phones, centred dialog from 720px (kit Sheet). The overlay
// host (guest/shell/overlays.tsx) mounts one per opening, owns Back and the
// dish-detail engagement tracking; this sheet only builds the selection.
//
// Order of content: wide plate, Thai title, English italic, printed portion,
// verified description, price leader, alcohol flag, variants, choice groups,
// note (+ allergy tick + honest help), allergen notice, sticky footer
// (quantity + "Add · ฿total"). The total mirrors shared/money; the server
// re-prices everything on quote and submit.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MenuItemDTO, ModifierGroupDTO } from '../../../../shared/dto.ts';
import { useConfig } from '../../lib/config.tsx';
import { money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  AllergyNotice, Button, Checkbox, ChoiceGroup, DishImage, EmptyState, Flag, Icon, Leader, LiveRegion, Price,
  RadioCard, Sheet, Skeleton, Stepper, Tag, TextArea, prefersReducedMotion, textLength, useToast,
} from '../../ui/index.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { useOverlays } from '../shell/overlays.tsx';
import { useGuestSession } from '../shell/session.tsx';
import NoAccessPanel from '../visit/NoAccessPanel.tsx';
import { basePrice, defaultPicks, defaultVariant, optionEffect, unitPrice, type CartLine } from './model.ts';
import { useOrderingState } from './ordering.ts';
import { addLine, cartStore, removeLine, restoreLine, updateLine, useCart } from './store.ts';
import './cart.css';

export interface ItemSheetProps {
  itemId: string;
  /** Edit this draft line instead of adding a new one. */
  lineUid?: string;
  onClose(): void;
}

const THAI = /[฀-๿]/;
const MEMORY_MS = 10 * 60 * 1000;

interface Draft {
  variantId: string | null;
  picks: Record<string, string[]>;
  qty: number;
  note: string;
  allergy: boolean;
}

/** Unsaved selections survive a detour (e.g. Call staff) for a few minutes. */
const memory = new Map<string, { draft: Draft; at: number }>();

function picksRecord(list: ReadonlyArray<{ group_id: string; option_ids: string[] }>): Record<string, string[]> {
  return Object.fromEntries(list.map((p) => [p.group_id, [...p.option_ids]]));
}

function picksList(rec: Record<string, string[]>) {
  return Object.entries(rec).filter(([, ids]) => ids.length > 0).map(([group_id, option_ids]) => ({ group_id, option_ids }));
}

function initialDraft(item: MenuItemDTO, line: CartLine | undefined): Draft {
  if (line) {
    return {
      variantId: line.variant_id,
      picks: picksRecord(line.modifiers),
      qty: line.quantity,
      note: line.note ?? '',
      allergy: line.allergy_note,
    };
  }
  return { variantId: defaultVariant(item), picks: picksRecord(defaultPicks(item)), qty: 1, note: '', allergy: false };
}

type GroupProblem = 'min' | 'max' | 'gone' | null;

function groupProblem(g: ModifierGroupDTO, ids: string[]): GroupProblem {
  if (ids.some((id) => !g.options.find((o) => o.id === id)?.available)) return 'gone';
  if (ids.length < g.min_select) return 'min';
  if (ids.length > g.max_select) return 'max';
  return null;
}

// ------------------------------------------------------------------ host
export default function ItemSheet({ itemId, lineUid, onClose }: ItemSheetProps) {
  const { t } = useI18n();
  const { item, loading, catalog } = useCatalog();
  const dish = item(itemId);
  const cart = useCart();
  const line = lineUid ? cart.lines.find((l) => l.uid === lineUid) : undefined;

  if (!dish) {
    const waiting = loading && !catalog;
    return (
      <Sheet open onClose={onClose} label={waiting ? t('item.loading') : t('item.missing.title')}>
        {waiting ? (
          <div className="c1b-sheet__skel" role="status" aria-label={t('item.loading')}>
            <Skeleton shape="block" height={180} />
            <Skeleton width="70%" height={28} />
            <Skeleton width="45%" height={20} />
            <Skeleton lines={3} />
          </div>
        ) : (
          <EmptyState
            icon="info"
            headingLevel={2}
            title={t('item.missing.title')}
            action={<Button variant="outline" onClick={onClose}>{t('item.missing.back')}</Button>}
          >
            {t('item.missing.body')}
          </EmptyState>
        )}
      </Sheet>
    );
  }
  return <ItemSheetBody item={dish} line={line} lineUid={lineUid} onClose={onClose} />;
}

// ------------------------------------------------------------------ sheet
function ItemSheetBody({ item, line, lineUid, onClose }: { item: MenuItemDTO; line: CartLine | undefined; lineUid?: string; onClose(): void }) {
  const { t, pick, both, lang, has } = useI18n();
  const { config } = useConfig();
  const { catalog, category } = useCatalog();
  const { openService, openPortion } = useOverlays();
  const { mode, endedReason } = useGuestSession();
  const ordering = useOrderingState();
  const toast = useToast();
  const cart = useCart();
  const titleId = useId();
  const memoKey = `${item.id}|${lineUid ?? ''}`;
  const editing = Boolean(lineUid && line);
  const frozen = Boolean(line && cart.views.find((v) => v.line.uid === line.uid)?.frozen);

  const [draft, setDraft] = useState<Draft>(() => {
    const kept = memory.get(memoKey);
    memory.delete(memoKey);
    return kept && Date.now() - kept.at < MEMORY_MS ? kept.draft : initialDraft(item, line);
  });
  const [showErrors, setShowErrors] = useState(false);
  const committed = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const touched = useRef(false);
  const legendRefs = useRef(new Map<string, HTMLElement | null>());

  // Keep an unsaved selection if the sheet is replaced (Call staff) or dismissed by accident.
  useEffect(() => () => {
    if (!committed.current && touched.current) memory.set(memoKey, { draft: draftRef.current, at: Date.now() });
  }, [memoKey]);

  const update = (patch: Partial<Draft>) => {
    touched.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  };

  // ---- names and numbers
  const names = both(item.name);
  const title = names.primary;
  const secondary = names.secondary;
  const cat = category(item.category_id);
  const catName = cat ? pick(cat.name) : null;
  const numeral = useMemo(() => {
    const group = catalog?.groups.find((g) => g.category_ids.includes(item.category_id));
    if (!group || !catalog) return null;
    const visible = group.category_ids.filter((id) => (catalog.categories.find((c) => c.id === id)?.item_ids.length ?? 0) > 0);
    const i = visible.indexOf(item.category_id);
    return i < 0 ? null : String(i + 1).padStart(2, '0');
  }, [catalog, item.category_id]);
  const portion = item.portion_note ? pick(item.portion_note) : null;
  const description = item.description ? pick(item.description) : null;

  const picks = picksList(draft.picks);
  const unit = unitPrice(item, draft.variantId, picks);
  const total = unit === null ? null : unit * draft.qty;
  const noteLimit = Math.max(0, Math.min(item.note_max, config?.notes_max_length ?? item.note_max));
  const notesOn = item.notes_allowed && noteLimit > 0;
  const noteTooLong = notesOn && textLength(draft.note, 'codepoint') > noteLimit;
  const joined = mode === 'joined';
  const billing = ordering.block?.code === 'visit_billing';
  const example = item.badges.includes('demo_modifier_attachment');

  // ---- problems, in display order
  const variantProblem: 'required' | 'gone' | null = item.pricing_type !== 'variant' ? null
    : !draft.variantId ? 'required'
      : item.variants.find((v) => v.id === draft.variantId && v.available && v.price_minor !== null) ? null : 'gone';
  const problems: Array<{ key: string; label: string; kind: string }> = [];
  if (variantProblem) problems.push({ key: 'variant', label: t('item.variant.legend'), kind: variantProblem });
  for (const g of item.modifier_groups) {
    const p = groupProblem(g, draft.picks[g.id] ?? []);
    if (p) problems.push({ key: g.id, label: pick(g.name).text, kind: p });
  }
  if (noteTooLong) problems.push({ key: 'note', label: t('item.note.label'), kind: 'note' });
  const first = problems[0];

  const chooseLabel = (label: string) => (THAI.test(label) ? t('item.error.choose', { group: label }) : t('item.error.chooseLatin', { group: label }));
  const errorFor = (key: string): string | undefined => {
    if (!showErrors) {
      // An earlier choice that disappeared is shown at once (editing a line).
      const p = problems.find((x) => x.key === key);
      return p?.kind === 'gone' ? t('item.error.gone') : undefined;
    }
    const p = problems.find((x) => x.key === key);
    if (!p) return undefined;
    if (p.kind === 'gone') return t('item.error.gone');
    if (key === 'variant') return t('item.error.chooseVariant');
    const g = item.modifier_groups.find((x) => x.id === key);
    if (p.kind === 'min' && g && g.min_select > 1) return t('item.error.atLeast', { min: g.min_select });
    return chooseLabel(p.label);
  };

  const focusProblem = (key: string) => {
    const el = key === 'note' ? document.getElementById(`${titleId}-note`) : legendRefs.current.get(key);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  };

  // ---- actions
  const name = title.text;
  const commit = () => {
    if (first) {
      setShowErrors(true);
      requestAnimationFrame(() => focusProblem(first.key));
      return;
    }
    if (!joined || billing || frozen) return;
    const payload = {
      item_id: item.id,
      item,
      variant_id: item.pricing_type === 'variant' ? draft.variantId : null,
      modifiers: picks,
      quantity: draft.qty,
      note: notesOn ? draft.note : null,
      allergy_note: notesOn && draft.allergy,
    };
    if (editing && line) {
      const holder = updateLine(line.uid, payload);
      if (holder === null) return;
      committed.current = true;
      onClose();
      toast.show(t('item.updated', { name }));
      return;
    }
    const result = addLine(payload);
    if (!result) return;
    committed.current = true;
    onClose();
    if (result.quantity <= 0) {
      toast.show({ message: t('item.maxReached', { name }), tone: 'info' });
      return;
    }
    toast.show({
      message: result.quantity > 1 ? t('item.addedQty', { name, n: result.quantity }) : t('item.added', { name }),
      action: {
        label: t('common.undo'),
        onClick: () => {
          const current = cartStore.get().lines.find((l) => l.uid === result.uid);
          if (!current) return;
          if (!result.merged || current.quantity <= result.quantity) removeLine(result.uid);
          else updateLine(result.uid, { quantity: current.quantity - result.quantity });
        },
      },
    });
  };

  const removeThis = () => {
    if (!line) return;
    const index = cartStore.get().lines.findIndex((l) => l.uid === line.uid);
    const removed = removeLine(line.uid);
    if (!removed) return;
    committed.current = true;
    onClose();
    toast.show({ message: t('item.removed', { name }), action: { label: t('common.undo'), onClick: () => restoreLine(removed, index) } });
  };

  // ---- price leader value
  let priceValue: ReactNode;
  if (item.pricing_type === 'measured_weight') {
    priceValue = <Price minor={item.rate_minor} size="lg" unit={t('common.perGrams', { n: item.rate_basis_grams ?? 100 })} stackUnit />;
  } else if (item.pricing_type === 'variant' && basePrice(item, draft.variantId) === null) {
    const open = item.variants.filter((v) => v.available && v.price_minor !== null).map((v) => v.price_minor as number);
    const min = open.length ? Math.min(...open) : null;
    priceValue = min === null ? <Price minor={null} /> : open.every((p) => p === min)
      ? <Price minor={min} size="lg" />
      : <span className="c1b-from"><span className="c1b-from__k">{t('common.priceFrom')}</span> <Price minor={min} size="lg" /></span>;
  } else {
    priceValue = <Price minor={basePrice(item, draft.variantId)} size="lg" />;
  }

  // ---- footer
  const orderable = item.orderable && item.pricing_type !== 'measured_weight';
  const reasonKey = `item.unavailable.${item.unavailable_reason ?? 'other'}`;
  const reasonText = has(reasonKey) ? t(reasonKey) : t('item.unavailable.other');
  let footer: ReactNode;
  if (item.pricing_type === 'measured_weight' && item.orderable) {
    footer = (
      <Button variant="secondary" size="lg" block icon="scale" opensDialog onClick={() => openPortion(item.id)} aria-label={t('common.askToWeighNamed', { name })}>
        {t('common.askToWeigh')}
      </Button>
    );
  } else if (!orderable) {
    footer = (
      <p className={item.sold_out ? 'c1b-sheet__why' : 'c1b-sheet__why c1b-sheet__why--quiet'} role="status">
        <Icon name={item.sold_out ? 'slash' : 'info'} />
        <span>{reasonText}</span>
      </p>
    );
  } else if (mode !== 'joined') {
    footer = mode === 'loading'
      ? <Button variant="primary" size="lg" block loading>{t('item.add')}</Button>
      : undefined;
  } else if (billing) {
    footer = (
      <p className="c1b-sheet__why c1b-sheet__why--quiet" role="status"><Icon name="receipt" /><span>{ordering.block!.body}</span></p>
    );
  } else if (frozen) {
    footer = <p className="c1b-sheet__why c1b-sheet__why--quiet" role="status"><Icon name="clock" /><span>{t('item.frozen')}</span></p>;
  } else {
    const label = first && first.kind !== 'note' ? (first.key === 'variant' ? t('item.error.chooseVariant') : chooseLabel(first.label)) : editing ? t('item.update') : t('item.add');
    const ready = !first;
    footer = (
      <>
        <Stepper
          variant="plain"
          size="lg"
          value={draft.qty}
          min={1}
          max={item.max_qty}
          onChange={(qty) => update({ qty })}
          label={t('common.qtyOf', { name })}
        />
        <Button
          variant="primary"
          size="lg"
          priceMinor={ready && total !== null ? total : undefined}
          onClick={commit}
          aria-label={ready && total !== null ? `${label} · ${money(total)} · ${name}` : `${label} · ${name}`}
          data-testid="item-commit"
        >
          {label}
        </Button>
      </>
    );
  }

  const kicker = (
    <>
      {numeral ? <span lang="en">No. {numeral}</span> : null}
      {catName ? <span lang={catName.lang}>{catName.text}</span> : null}
    </>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      langSwitch
      kicker={numeral || catName ? kicker : undefined}
      labelledBy={titleId}
      footer={footer}
      bodyClassName="c1b-sheet"
    >
      <DishImage image={item.image} variant="wide" plateClassName="sheet__photo" loading="eager" sizes="(min-width: 720px) 552px, 100vw" />
      <h2 className="sheet__title" id={titleId} lang={title.lang}>{title.text}</h2>
      {secondary ? <p className="en en--lg" lang={secondary.lang}>{secondary.text}</p> : null}
      {title.fallback && lang === 'th' ? <p className="meta c1b-sheet__fallback">{t('common.enOnly')}</p> : null}
      {portion ? <p className="meta c1b-sheet__portion" lang={portion.lang}>{portion.text}</p> : null}
      {description ? <p className="support c1b-sheet__desc" lang={description.lang}>{description.text}</p> : null}

      <Leader
        className="sheet__price"
        label={<span className="sheet__price-k">{t('item.price')}</span>}
        value={priceValue}
      />
      {item.pricing_type === 'measured_weight' ? <p className="support c1b-sheet__note">{t('item.weigh.lede')} {t('common.weighNote')}</p> : null}
      {item.alcohol ? <p className="c1b-sheet__flag"><Flag kind="alcohol">{t('item.alcohol')}</Flag></p> : null}
      {editing && frozen ? <p className="c1b-sheet__flag meta">{t('item.frozen')}</p> : null}

      {joined && ordering.block && !billing && orderable ? (
        <p className="c1b-sheet__block-note" role="status">
          <Icon name="pause" size="sm" />
          <span><b>{ordering.block.title}</b> · {t('cart.block.kept')}</span>
        </p>
      ) : null}

      {orderable && item.pricing_type === 'variant' ? (
        <ChoiceGroup
          className="sheet__block"
          legend={t('item.variant.legend')}
          required
          satisfied={!variantProblem}
          rule={t('item.rule.requiredOne')}
          error={errorFor('variant')}
          legendRef={(el) => { legendRefs.current.set('variant', el); }}
        >
          {item.variants.map((v) => {
            const vn = pick(v.name);
            const open = v.available && v.price_minor !== null;
            return (
              <RadioCard
                key={v.id}
                name={`${titleId}-variant`}
                value={v.id}
                checked={draft.variantId === v.id}
                disabled={!open || frozen}
                onChange={() => update({ variantId: v.id })}
                label={<span lang={vn.lang}>{vn.text}</span>}
                aside={open ? money(v.price_minor as number) : t('item.variant.unavailable')}
              />
            );
          })}
        </ChoiceGroup>
      ) : null}

      {orderable ? item.modifier_groups.map((g) => (
        <GroupField
          key={g.id}
          group={g}
          ids={draft.picks[g.id] ?? []}
          example={example}
          disabled={frozen}
          error={errorFor(g.id)}
          legendRef={(el) => { legendRefs.current.set(g.id, el); }}
          onChange={(ids) => update({ picks: { ...draft.picks, [g.id]: ids } })}
          idBase={`${titleId}-${g.id}`}
        />
      )) : null}

      {orderable && joined && !billing ? (
        notesOn ? (
          <div className="sheet__block c1b-sheet__notes">
            <TextArea
              id={`${titleId}-note`}
              label={t('item.note.label')}
              optional
              value={draft.note}
              onChange={(note) => update({ note, allergy: note.trim() ? draft.allergy : false })}
              limit={noteLimit}
              placeholder={t('item.note.placeholder')}
              help={t('item.note.help')}
              error={noteTooLong ? t('cart.issue.note_too_long') : undefined}
              disabled={frozen}
              rows={3}
            />
            <Checkbox
              label={t('item.note.allergy')}
              description={t('item.note.allergyHelp')}
              checked={draft.allergy && Boolean(draft.note.trim())}
              disabled={!draft.note.trim() || frozen}
              onChange={(e) => update({ allergy: e.currentTarget.checked })}
            />
          </div>
        ) : (
          <p className="support sheet__block">{t('item.note.notAllowed')}</p>
        )
      ) : null}

      {!joined && mode !== 'loading' ? (
        <div className="sheet__block"><NoAccessPanel reason={mode === 'ended' ? (endedReason === 'visit_access_revoked' ? 'revoked' : 'required') : 'public'} compact /></div>
      ) : null}

      <AllergyNotice
        className="sheet__block"
        allergens={item.allergens}
        onCallStaff={joined ? openService : undefined}
        callStaffLabel={t('item.allergy.ask')}
      />

      {editing && line && joined && !frozen ? (
        <div className="sheet__block c1b-sheet__remove">
          <Button variant="danger" icon="x" onClick={removeThis}>{t('item.remove')}</Button>
        </div>
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ one choice group
function GroupField({ group, ids, example, disabled, error, legendRef, onChange, idBase }: {
  group: ModifierGroupDTO;
  ids: string[];
  example: boolean;
  disabled: boolean;
  error?: string;
  legendRef: (el: HTMLElement | null) => void;
  onChange: (ids: string[]) => void;
  idBase: string;
}) {
  const { t, pick } = useI18n();
  const legend = pick(group.name);
  const single = group.max_select === 1;
  const required = group.min_select > 0;
  const hasDefault = group.options.some((o) => o.is_default && o.available);
  const withNone = single && !required && !hasDefault;
  const full = !single && ids.length >= group.max_select;

  const rule = useMemo(() => {
    const parts: string[] = [];
    if (required) {
      parts.push(group.min_select === group.max_select
        ? group.min_select === 1 ? t('item.rule.requiredOne') : t('item.rule.requiredExactly', { n: group.min_select })
        : t('item.rule.requiredRange', { min: group.min_select, max: group.max_select }));
    } else {
      parts.push(single ? t('item.rule.optionalOne') : t('item.rule.optionalMax', { max: group.max_select }));
    }
    if (group.included_count > 0) {
      const extras = [...new Set(group.options.filter((o) => o.available).map((o) => o.price_delta_minor))];
      parts.push(extras.length === 1 && extras[0] > 0
        ? t('item.rule.included', { n: group.included_count, price: money(extras[0], { sign: true }) })
        : t('item.rule.includedVaries', { n: group.included_count }));
      if (group.options.some((o) => o.upgrade_minor > 0)) parts.push(t('item.rule.upgrade'));
    }
    return parts.join(' · ');
  }, [group, required, single, t]);

  return (
    <ChoiceGroup
      className="sheet__block"
      legend={<><span lang={legend.lang}>{legend.text}</span>{example ? <Tag tone="example" /> : null}</>}
      required={required}
      satisfied={required && ids.length >= group.min_select && ids.length <= group.max_select}
      rule={rule}
      error={error}
      legendRef={legendRef}
    >
      {withNone ? (
        <RadioCard
          name={idBase}
          value=""
          checked={ids.length === 0}
          disabled={disabled}
          onChange={() => onChange([])}
          label={t('item.option.none')}
          aside=""
        />
      ) : null}
      {group.options.map((o) => {
        const on = ids.includes(o.id);
        const optName = pick(o.name);
        const effect = optionEffect(group, o.id, ids);
        const blocked = !o.available || (full && !on);
        return (
          <RadioCard
            key={o.id}
            type={single ? 'radio' : 'checkbox'}
            name={idBase}
            value={o.id}
            checked={on}
            disabled={disabled || (blocked && !on)}
            onChange={() => {
              if (single) onChange([o.id]);
              else onChange(on ? ids.filter((x) => x !== o.id) : group.options.map((x) => x.id).filter((x) => x === o.id || ids.includes(x)));
            }}
            label={<span lang={optName.lang}>{optName.text}</span>}
            aside={!o.available ? t('common.optionOut') : effect > 0 ? money(effect, { sign: true }) : t('common.included')}
          />
        );
      })}
      {!single ? <LiveRegion>{full ? t('item.rule.full', { max: group.max_select }) : ''}</LiveRegion> : null}
    </ChoiceGroup>
  );
}
