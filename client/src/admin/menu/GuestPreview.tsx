// Guest preview (C6, brief 21): the kit DishRow plus the details a guest
// would see, built from the editor's current values, in Thai and English.
import { useEffect, useState, type ReactNode } from 'react';
import type { AdminItemDTO, MenuItemDTO } from '../../../../shared/dto.ts';
import type { Locale } from '../../../../shared/settings.ts';
import { useConfig } from '../../lib/config.tsx';
import { I18nProvider, useI18n } from '../../lib/i18n.tsx';
import { money } from '../../lib/format.ts';
import { AllergyNotice, DishRow, Flag, Icon, SegmentedControl, Tag, type DishImageSource } from '../../ui/index.ts';
import { useReasonText } from './parts.tsx';
import type { ItemForm } from './editor-form.ts';
import { bahtTextToMinor, intText, useMenuData } from './model.tsx';

const LANG_KEY = 'rg.lang';
function writeLang(value: string): void {
  try { window.localStorage.setItem(LANG_KEY, value); } catch { /* private mode */ }
}

/**
 * Render children with a second language context. The app's I18nProvider
 * takes its language from storage, so storage points at the preview language
 * only while the nested provider first renders and is set straight back to
 * the reader's language by the sibling below. The document language is
 * restored after the nested provider's effect.
 */
function LangScope({ lang, children }: { lang: Locale; children: ReactNode }) {
  const outer = useI18n().lang;
  useState(() => { writeLang(lang); return null; });
  useEffect(() => { document.documentElement.lang = outer; });
  return (
    <>
      <I18nProvider scope="admin" defaultLang={lang}>{children}</I18nProvider>
      <RestoreLang to={outer} />
    </>
  );
}

function RestoreLang({ to }: { to: Locale }) {
  useState(() => { writeLang(to); return null; });
  return null;
}

export interface PreviewInput {
  form: ItemForm;
  base: AdminItemDTO;
  priceChanged: boolean;
  canReview: boolean;
  image: DishImageSource | null;
}

type PreviewItem = MenuItemDTO & { descriptionShown: boolean; descriptionHeld: boolean };

function usePreviewItem({ form, base, priceChanged, canReview, image }: PreviewInput): PreviewItem {
  const { config } = useConfig();
  const data = useMenuData();
  const live = config?.operating_mode === 'live';
  const reviewAfter = priceChanged ? 'needs_review' : base.review_status;
  const hidePrices = live && reviewAfter !== 'verified';
  const price = form.pricing_type === 'fixed' ? bahtTextToMinor(form.price) ?? null : null;
  const rate = form.pricing_type === 'measured_weight' ? bahtTextToMinor(form.rate) ?? null : null;
  const basis = form.pricing_type === 'measured_weight' ? intText(form.basis, 1, 1000) ?? null : null;
  const variants = form.pricing_type === 'variant'
    ? form.variants.map((v) => ({
      id: v.id ?? v.uid,
      key: v.key,
      name: { th: v.name_th.trim() || null, en: v.name_en.trim() || null },
      price_minor: hidePrices ? null : bahtTextToMinor(v.price) ?? null,
      available: v.available,
    }))
    : [];
  const hasPrice = form.pricing_type === 'fixed' ? price !== null
    : form.pricing_type === 'measured_weight' ? rate !== null && basis !== null
    : form.variants.some((v) => v.available && typeof bahtTextToMinor(v.price) === 'number');
  const groups = form.modifier_group_ids.map((id) => data.modifierGroup(id)).filter((g): g is NonNullable<typeof g> => Boolean(g));

  let reason = base.unavailable_reason;
  if (reason === null || reason === 'price_pending' || reason === 'not_verified') {
    if (!hasPrice) reason = 'price_pending';
    else if (live && reviewAfter !== 'verified') reason = 'not_verified';
    else if (!live && reviewAfter !== 'verified' && !base.demo_orderable) reason = 'not_verified';
    else reason = null;
  }
  const textChanged = form.desc_th.trim() !== (base.description_admin.th ?? '') || form.desc_en.trim() !== (base.description_admin.en ?? '');
  const verifiedAfter = canReview ? form.desc_verified : (textChanged ? false : base.desc_verified);
  const hasDesc = Boolean(form.desc_th.trim() || form.desc_en.trim());
  const orderable = reason === null;

  return {
    ...base,
    name: { th: form.name_th.trim() || null, en: form.name_en.trim() || null },
    description: verifiedAfter && hasDesc ? { th: form.desc_th.trim() || null, en: form.desc_en.trim() || null } : null,
    descriptionShown: verifiedAfter && hasDesc,
    descriptionHeld: hasDesc && !verifiedAfter,
    portion_note: form.portion_note_th.trim() || form.portion_note_en.trim()
      ? { th: form.portion_note_th.trim() || null, en: form.portion_note_en.trim() || null }
      : null,
    pricing_type: form.pricing_type,
    price_minor: hidePrices ? null : price,
    rate_minor: hidePrices ? null : rate,
    rate_basis_grams: basis,
    variants,
    modifier_groups: groups,
    image: image ? { ...image, alt: { th: form.image_alt_th.trim() || null, en: form.image_alt_en.trim() || null } } : null,
    alcohol: form.alcohol || Boolean(data.category(form.category_id)?.alcohol),
    notes_allowed: form.notes_allowed,
    note_max: intText(form.note_max, 0, 500) ?? base.note_max,
    max_qty: intText(form.max_qty, 1, 99) ?? base.max_qty,
    orderable,
    unavailable_reason: reason,
    quick_add: orderable && form.pricing_type === 'fixed' && !groups.some((g) => g.min_select > 0),
  };
}

export default function GuestPreview(props: PreviewInput) {
  const { t, lang } = useI18n();
  const [view, setView] = useState<'both' | Locale>('both');
  const item = usePreviewItem(props);
  const langs: Locale[] = view === 'both' ? ['th', 'en'] : [view];
  const visible = props.base.status === 'published';
  return (
    <section className="ed-card ed-preview" aria-labelledby="ed-prev-h">
      <header className="ed-card__head">
        <h3 id="ed-prev-h">{t('catalog.preview.title')}</h3>
        <SegmentedControl
          size="md"
          label={t('catalog.preview.langs')}
          value={view}
          onChange={setView}
          options={[
            { value: 'both', label: t('catalog.preview.both') },
            { value: 'th', label: 'ไทย', lang: 'th' },
            { value: 'en', label: 'EN', lang: 'en' },
          ]}
        />
      </header>
      <p className="ed-card__lede">{visible ? t('catalog.preview.lede') : t('catalog.preview.notVisible')}</p>
      <div className="ed-preview__panes">
        {langs.map((l) => (
          <LangScope key={`${l}-${lang}`} lang={l}>
            <PreviewPane item={item} lang={l} />
          </LangScope>
        ))}
      </div>
    </section>
  );
}

function PreviewPane({ item, lang }: { item: PreviewItem; lang: Locale }) {
  const { t, pick } = useI18n();
  const reasonText = useReasonText();
  const desc = item.description ? pick(item.description) : null;
  return (
    <div className="ed-pane" lang={lang} data-scope="guest">
      <p className="ed-pane__k">{lang === 'th' ? 'ไทย' : 'English'}</p>
      <div className="ed-pane__row">
        <DishRow item={item} headingLevel={4} onAdd={() => {}} onRequestWeigh={() => {}} hasChoices={!item.quick_add} />
      </div>
      <div className="ed-pane__details">
        {!item.orderable && !item.sold_out && item.pricing_type !== 'measured_weight' ? (
          <p className="ed-pane__reason"><Icon name="info" size="sm" />{t('catalog.preview.cannotOrder', { reason: reasonText(item.unavailable_reason) })}</p>
        ) : null}
        {desc ? <p className="ed-pane__desc" lang={desc.lang}>{desc.text}</p> : null}
        {item.modifier_groups.length ? (
          <ul className="ed-pane__groups">
            {item.modifier_groups.map((g) => {
              const gn = pick(g.name);
              return (
                <li key={g.id}>
                  <b lang={gn.lang}>{gn.text}</b>
                  <span>
                    {g.options.map((o) => {
                      const on = pick(o.name);
                      return `${on.text}${o.price_delta_minor ? ` +${money(o.price_delta_minor)}` : ''}`;
                    }).join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="ed-pane__meta">
          {item.notes_allowed ? t('catalog.preview.notes', { n: item.note_max }) : t('catalog.preview.noNotes')}
        </p>
        {item.alcohol ? <Flag kind="alcohol" /> : null}
        {item.badges.includes('demo_fixture') ? <Tag tone="example">{t('common.demoData')}</Tag> : null}
        <AllergyNotice allergens={{ ...item.allergens, entries: item.allergens.status === 'verified' ? item.allergens.entries : [] }} />
      </div>
    </div>
  );
}
