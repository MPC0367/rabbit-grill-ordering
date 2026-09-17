// Compact staff catalog: Food/Drinks, category chips, search, and an inline
// chooser (variants, choices with included vs charged prices, quantity,
// note) under the dish being added. Weighed cuts go to the weighing queue.
import { useMemo, useState } from 'react';
import type { CatalogDTO, MenuItemDTO } from '../../../../../shared/dto.ts';
import { allocateGroupPicks, measuredAmount } from '../../../../../shared/money.ts';
import { money } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import {
  Button, Checkbox, ChoiceGroup, Icon, normalizeSearch, RadioCard, SegmentedControl, Stepper, Tag, TextArea,
  TextField,
} from '../../../ui/index.ts';
import { FilterChips, StaffSearch } from '../../../ui/admin/index.ts';
import { staffName } from '../support.ts';
import { newUid, unitPrice, type DraftLine } from './draft.ts';

type Group = 'food' | 'drinks';

/**
 * A paper order already happened, so a dish that sold out or whose category
 * was paused since then can still be recorded (D-S8-19). Nothing else can: the
 * server re-checks every line with those two states ignored, and an unverified
 * dish or one whose price is not approved is never recorded at that price.
 */
const RECOVERABLE = new Set(['sold_out', 'paused']);

export interface PortionAsk { preferredGrams: number | null; note: string }

export function CatalogPicker({ catalog, mode, counts, onAdd, onPortion, portionState, locked }: {
  catalog: CatalogDTO;
  mode: 'assist' | 'recover';
  /** Quantity already in the draft per item. */
  counts: ReadonlyMap<string, number>;
  onAdd: (line: DraftLine) => void;
  onPortion: (item: MenuItemDTO, ask: PortionAsk) => Promise<boolean>;
  portionState: Readonly<Record<string, 'sending' | 'sent'>>;
  locked: boolean;
}) {
  const { t, pick } = useI18n();
  const [group, setGroup] = useState<Group>('food');
  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const groups = catalog.groups.filter((g) => g.category_ids.length > 0);
  const cats = useMemo(() => {
    const ids = groups.find((g) => g.key === group)?.category_ids ?? [];
    return ids.map((id) => catalog.categories.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  }, [catalog, group, groups]);

  const q = normalizeSearch(query);
  const items = useMemo(() => {
    const byId = new Map(catalog.items.map((i) => [i.id, i]));
    if (q) {
      return catalog.items.filter((i) => normalizeSearch(`${i.name.th ?? ''} ${i.name.en ?? ''}`).includes(q));
    }
    const shown = category === 'all' ? cats : cats.filter((c) => c.id === category);
    return shown.flatMap((c) => c.item_ids.map((id) => byId.get(id)).filter((i): i is MenuItemDTO => Boolean(i)));
  }, [catalog, cats, category, q]);

  const allowed = (item: MenuItemDTO): { ok: boolean; reason: string | null } => {
    const priced = item.pricing_type === 'measured_weight'
      // A recovered cut is priced at the approved rate; without one, nothing may be recorded.
      ? item.rate_minor !== null && item.rate_basis_grams !== null
      : unitPrice(item, { variant_id: item.variants[0]?.id ?? null, modifiers: [] }) !== null;
    if (item.pricing_type === 'measured_weight' && mode === 'recover') {
      return priced ? { ok: true, reason: t('recover.weighedHint') } : { ok: false, reason: t('assist.reason.price_pending') };
    }
    if (item.pricing_type === 'measured_weight') return { ok: true, reason: null };
    if (item.orderable) return { ok: true, reason: null };
    const why = item.unavailable_reason ?? 'not_orderable';
    // Sold out or paused now: the paper ticket still counts, as long as the
    // dish has an approved price (the server checks the rest again).
    if (mode === 'recover' && RECOVERABLE.has(why) && priced) {
      return { ok: true, reason: t(`assist.reason.${why}`) };
    }
    return { ok: false, reason: t(`assist.reason.${why}`) };
  };

  const quickAdd = (item: MenuItemDTO) => {
    onAdd({ uid: newUid(), item_id: item.id, variant_id: null, quantity: 1, modifiers: [], note: '', allergy_note: false });
    setFlash(item.id);
    setTimeout(() => setFlash((f) => (f === item.id ? null : f)), 1200);
  };

  return (
    <div className="ao-pick">
      <div className="ao-pick__tools">
        <StaffSearch label={t('assist.searchLabel')} placeholder={t('assist.searchPlaceholder')} value={query} onChange={setQuery} />
        {q ? null : (
          <>
            <SegmentedControl<Group>
              size="staff"
              label={t('assist.group')}
              value={group}
              onChange={(g) => { setGroup(g); setCategory('all'); }}
              options={groups.map((g) => {
                const p = pick(g.name);
                return { value: g.key, label: <span lang={p.lang}>{p.text}</span> };
              })}
            />
            <div className="ao-cats">
              <FilterChips<string>
                label={t('assist.categories')}
                value={category}
                onChange={setCategory}
                options={[
                  { value: 'all', label: t('common.all') },
                  ...cats.map((c) => {
                    const p = pick(c.name);
                    return { value: c.id, label: p.text, lang: p.lang };
                  }),
                ]}
              />
            </div>
          </>
        )}
      </div>

      <p className="ao-pick__count" role="status">{q ? t('common.results', { n: items.length }) : ''}</p>

      {items.length === 0 ? (
        <p className="ao-pick__empty">{t('assist.noResults')}</p>
      ) : (
        <ul className="ao-list">
          {items.map((item) => {
            const n = staffName(item.name);
            const ok = allowed(item);
            const measured = item.pricing_type === 'measured_weight';
            const needsChooser = !measured && (item.variants.length > 0 || item.modifier_groups.length > 0 || !item.quick_add);
            const inDraft = counts.get(item.id) ?? 0;
            const price = measured
              ? (item.rate_minor !== null ? t('assist.rate', { amount: money(item.rate_minor), n: item.rate_basis_grams ?? 100 }) : t('common.pricePending'))
              : item.variants.length > 0
                ? (() => {
                  const prices = item.variants.map((v) => v.price_minor).filter((p): p is number => p !== null);
                  return prices.length ? `${t('common.priceFrom')} ${money(Math.min(...prices))}` : t('common.pricePending');
                })()
                : item.price_minor !== null ? money(item.price_minor) : t('common.pricePending');
            const isOpen = open === item.id;
            const pState = portionState[item.id];
            return (
              <li key={item.id} className={`ao-row${isOpen ? ' is-open' : ''}${ok.ok ? '' : ' is-off'}`}>
                <div className="ao-row__main">
                  <div className="ao-row__name">
                    <p className="ao-row__th" lang={n.lang}>{n.text}</p>
                    <p className="ao-row__en">
                      {n.secondary ? <span lang="en">{n.secondary}</span> : null}
                      {n.noThai ? <span>{t('common.ticket.noThaiName')}</span> : null}
                      {item.alcohol ? <Tag tone="alert" icon="glass">{t('common.alcoholConfirm')}</Tag> : null}
                    </p>
                    {ok.reason ? <p className={`ao-row__why${ok.ok ? '' : ' is-off'}`}>{ok.reason}</p> : null}
                  </div>
                  <span className="ao-row__price num">{price}</span>
                  <span className="ao-row__act">
                    {inDraft > 0 ? <span className="ao-row__in" aria-label={t('common.inOrderCount', { n: inDraft })}>{t('common.inOrderCount', { n: inDraft })}</span> : null}
                    {!ok.ok ? null : measured ? (
                      <Button
                        variant="secondary"
                        size="staff"
                        icon="scale"
                        aria-expanded={isOpen}
                        aria-disabled={locked || pState === 'sending' || undefined}
                        aria-label={mode === 'recover' ? t('recover.weighNamed', { name: n.text }) : undefined}
                        onClick={() => setOpen(isOpen ? null : item.id)}
                      >
                        {mode === 'recover' ? t('recover.weighEnter') : pState === 'sent' ? t('assist.weighSent') : t('assist.weighOpen')}
                      </Button>
                    ) : needsChooser ? (
                      <Button variant="secondary" size="staff" icon={isOpen ? 'chev-d' : 'plus'} aria-expanded={isOpen}
                        aria-disabled={locked || undefined}
                        aria-label={t('common.addNamedChoices', { name: n.text })}
                        onClick={() => setOpen(isOpen ? null : item.id)}
                      >
                        {t('assist.choose')}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="staff" icon="plus" iconBold
                        confirmed={flash === item.id}
                        aria-disabled={locked || undefined}
                        aria-label={t('common.addNamed', { name: n.text })}
                        onClick={() => quickAdd(item)}
                      >
                        {t('common.add')}
                      </Button>
                    )}
                  </span>
                </div>
                {isOpen && measured && mode === 'recover' ? (
                  <RecoverWeightForm
                    item={item}
                    onCancel={() => setOpen(null)}
                    onAdd={(g) => {
                      onAdd({ uid: newUid(), item_id: item.id, variant_id: null, quantity: 1, modifiers: [], note: '', allergy_note: false, measured_grams: g });
                      setOpen(null);
                      setFlash(item.id);
                      setTimeout(() => setFlash(null), 1200);
                    }}
                  />
                ) : null}
                {isOpen && measured && mode === 'assist' ? (
                  <PortionAskForm
                    sent={pState === 'sent'}
                    sending={pState === 'sending'}
                    onCancel={() => setOpen(null)}
                    onSend={async (ask) => { const done = await onPortion(item, ask); if (done) setOpen(null); }}
                  />
                ) : null}
                {isOpen && !measured ? (
                  <Chooser
                    item={item}
                    onCancel={() => setOpen(null)}
                    onAdd={(line) => { onAdd(line); setOpen(null); setFlash(item.id); setTimeout(() => setFlash(null), 1200); }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ inline chooser

function Chooser({ item, onAdd, onCancel }: { item: MenuItemDTO; onAdd: (line: DraftLine) => void; onCancel: () => void }) {
  const { t, pick } = useI18n();
  const firstVariant = item.variants.find((v) => v.available && v.price_minor !== null) ?? null;
  const [variant, setVariant] = useState<string | null>(firstVariant?.id ?? null);
  const [picks, setPicks] = useState<Record<string, string[]>>(() => Object.fromEntries(
    item.modifier_groups.map((g) => [g.id, g.options.filter((o) => o.is_default && o.available).map((o) => o.id)]),
  ));
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [allergy, setAllergy] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const n = staffName(item.name);
  const modifiers = Object.entries(picks).map(([group_id, option_ids]) => ({ group_id, option_ids }));
  const unit = unitPrice(item, { variant_id: variant, modifiers });

  const add = () => {
    if (item.variants.length > 0 && !variant) { setMissing('variant'); return; }
    for (const g of item.modifier_groups) {
      const c = (picks[g.id] ?? []).length;
      if (c < g.min_select || c > g.max_select) { setMissing(g.id); return; }
    }
    onAdd({ uid: newUid(), item_id: item.id, variant_id: variant, quantity: qty, modifiers, note: note.trim(), allergy_note: allergy && Boolean(note.trim()) });
  };

  return (
    <div className="ao-choose" role="group" aria-label={t('assist.chooserFor', { name: n.text })}>
      {item.variants.length > 0 ? (
        <ChoiceGroup legend={t('assist.variant')} required satisfied={Boolean(variant)} error={missing === 'variant' ? t('assist.rule.pickOne') : undefined} rule={t('assist.rule.one')}>
          {item.variants.map((v) => {
            const p = pick(v.name);
            return (
              <RadioCard
                key={v.id}
                name={`v-${item.id}`}
                label={<span lang={p.lang}>{p.text}</span>}
                aside={v.available && v.price_minor !== null ? money(v.price_minor) : undefined}
                disabled={!v.available || v.price_minor === null}
                checked={variant === v.id}
                onChange={() => { setVariant(v.id); setMissing(null); }}
              />
            );
          })}
        </ChoiceGroup>
      ) : null}

      {item.modifier_groups.map((g) => {
        const name = pick(g.name);
        const chosen = picks[g.id] ?? [];
        const single = g.max_select === 1;
        const alloc = allocateGroupPicks(g.options, chosen, g.included_count);
        return (
          <ChoiceGroup
            key={g.id}
            legend={<span lang={name.lang}>{name.text}</span>}
            required={g.min_select > 0}
            satisfied={chosen.length >= g.min_select}
            rule={[
              g.min_select > 0 ? t('common.required') : t('common.optional'),
              single ? t('assist.rule.one') : t('assist.rule.max', { n: g.max_select }),
              g.included_count > 0 ? t('assist.rule.included', { n: g.included_count }) : null,
            ].filter(Boolean).join(' · ')}
            error={missing === g.id ? t('assist.rule.error', { min: g.min_select, max: g.max_select }) : undefined}
          >
            {g.options.map((o) => {
              const on = chosen.includes(o.id);
              const a = alloc.find((x) => x.id === o.id);
              const p = pick(o.name);
              const aside = !o.available ? undefined
                : a ? (a.charged_minor ? `+${money(a.charged_minor)}` : t('common.included'))
                : o.price_delta_minor ? `+${money(o.price_delta_minor)}` : t('common.included');
              return (
                <RadioCard
                  key={o.id}
                  type={single ? 'radio' : 'checkbox'}
                  name={`m-${item.id}-${g.id}`}
                  label={<span lang={p.lang}>{p.text}</span>}
                  aside={aside}
                  disabled={!o.available}
                  checked={on}
                  onChange={() => {
                    setMissing(null);
                    setPicks((cur) => {
                      const list = cur[g.id] ?? [];
                      const next = single ? [o.id] : on ? list.filter((x) => x !== o.id) : list.length >= g.max_select ? list : [...list, o.id];
                      return { ...cur, [g.id]: next };
                    });
                  }}
                />
              );
            })}
          </ChoiceGroup>
        );
      })}

      {item.notes_allowed ? (
        <div className="ao-choose__note">
          <TextArea density="staff" label={t('assist.note')} optional help={t('assist.noteHelp')} value={note} onChange={setNote} limit={item.note_max || 140} rows={2} />
          {note.trim() ? (
            <Checkbox label={t('assist.allergyTick')} description={t('assist.allergyTickHelp')} checked={allergy} onChange={(e) => setAllergy(e.currentTarget.checked)} />
          ) : null}
        </div>
      ) : null}

      <div className="ao-choose__foot">
        <Stepper value={qty} onChange={setQty} min={1} max={item.max_qty || 20} label={t('common.qtyOf', { name: n.text })} variant="plain" />
        <Button variant="secondary" size="staff" icon="plus" iconBold priceMinor={unit !== null ? unit * qty : undefined} onClick={add}>
          {t('assist.addLine')}
        </Button>
        <Button variant="ghost" size="staff" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ weighed cut from a paper ticket

/**
 * Paper recovery (D-S8-21): the cut was weighed during the outage, so staff
 * enter the grams from the ticket and the line is priced at the approved rate.
 * One cut is one line; a second cut is entered again.
 *
 * The amount under the grams is a PREVIEW of a line that does not exist yet,
 * so there is nothing for the server to quote. It uses `measuredAmount` from
 * `shared/money.ts`, the very function the server prices the cut with, on the
 * rate from the same menu payload, so the two cannot disagree. Once the line is
 * added, every figure on the panel comes from the server quote.
 */
function RecoverWeightForm({ item, onAdd, onCancel }: { item: MenuItemDTO; onAdd: (grams: number) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [grams, setGrams] = useState('');
  const [error, setError] = useState<string | null>(null);
  const g = grams ? Number(grams) : null;
  const amount = g !== null && g > 0 && item.rate_minor !== null && item.rate_basis_grams !== null
    ? measuredAmount(g, item.rate_minor, item.rate_basis_grams)
    : null;
  return (
    <div className="ao-choose ao-choose--weigh">
      <p className="ao-choose__lede"><Icon name="scale" size="sm" /> {t('recover.weighLede')}</p>
      <TextField
        density="staff"
        label={t('recover.weighLabel')}
        help={item.rate_minor !== null ? t('assist.rate', { amount: money(item.rate_minor), n: item.rate_basis_grams ?? 100 }) : undefined}
        inputMode="numeric"
        suffix={t('requests.quote.unit')}
        value={grams}
        error={error ?? undefined}
        onChange={(e) => { setGrams(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 4)); setError(null); }}
      />
      <p className="ao-choose__ok" aria-live="polite">
        {amount !== null ? t('recover.weighAmount', { amount: money(amount) }) : ''}
      </p>
      <div className="ao-choose__foot">
        <Button
          variant="secondary"
          size="staff"
          icon="plus"
          iconBold
          onClick={() => {
            if (g === null || g < 1 || g > 10_000) { setError(t('recover.weighRange')); return; }
            onAdd(g);
          }}
        >
          {t('assist.addLine')}
        </Button>
        <Button variant="ghost" size="staff" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ weighed cut: ask the weighing queue

function PortionAskForm({ sent, sending, onSend, onCancel }: {
  sent: boolean;
  sending: boolean;
  onSend: (ask: PortionAsk) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [grams, setGrams] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="ao-choose ao-choose--weigh">
      <p className="ao-choose__lede"><Icon name="scale" size="sm" /> {t('assist.weighLede')}</p>
      {sent ? <p className="ao-choose__ok"><Icon name="check-c" size="sm" /> {t('assist.weighSentLong')}</p> : null}
      <TextField
        density="staff"
        label={t('assist.preferred')}
        optional
        help={t('assist.preferredHelp')}
        inputMode="numeric"
        suffix={t('requests.quote.unit')}
        value={grams}
        error={error ?? undefined}
        onChange={(e) => { setGrams(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 4)); setError(null); }}
      />
      <TextArea density="staff" label={t('assist.weighNote')} optional value={note} onChange={setNote} limit={200} rows={2} />
      <div className="ao-choose__foot">
        <Button
          variant="secondary"
          size="staff"
          icon="scale"
          loading={sending}
          onClick={() => {
            const g = grams ? Number(grams) : null;
            if (g !== null && (g < 50 || g > 5000)) { setError(t('assist.preferredRange')); return; }
            onSend({ preferredGrams: g, note: note.trim() });
          }}
        >
          {t('assist.weighSend')}
        </Button>
        <Button variant="ghost" size="staff" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}
