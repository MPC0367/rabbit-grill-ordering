// New dish (C6): the few facts a draft needs, then the full editor.
// New items always start as unverified drafts (server rule).
import { useRef, useState } from 'react';
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import type { PricingType } from '../../../../shared/status.ts';
import { api } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, ChoiceGroup, RadioCard, Select, Sheet, TextField } from '../../ui/index.ts';
import { itemHref, navigateFromOverlay, useErrorText, useMenuData } from './model.tsx';

export default function NewItemDialog({ defaultCategoryId, onClose }: { defaultCategoryId?: string; onClose: () => void }) {
  const { t, pick } = useI18n();
  const data = useMenuData();
  const errorText = useErrorText();
  const [categoryId, setCategoryId] = useState(defaultCategoryId ?? '');
  const [nameTh, setNameTh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [pricing, setPricing] = useState<PricingType>('fixed');
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  const options = (['food', 'drinks'] as const).flatMap((g) => data.categoriesOf(g).map((c) => ({
    value: c.id,
    label: `${t(`catalog.group.${g}`)} · ${pick(c.name).text}`,
  })));

  const create = async () => {
    if (saving) return;
    setFailure(null);
    if (!nameTh.trim() && !nameEn.trim()) {
      setNameError(t('catalog.item.nameNeeded'));
      firstRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<AdminItemDTO>('/api/staff/menu/items', {
        category_id: categoryId,
        name_th: nameTh.trim() || null,
        name_en: nameEn.trim() || null,
        pricing_type: pricing,
      });
      data.putItem(res);
      navigateFromOverlay(itemHref(res.id));
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      wide
      title={t('catalog.item.newTitle')}
      dismissible={!saving}
      initialFocus={firstRef}
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={saving} onClick={() => void create()} disabled={!categoryId}>{t('catalog.item.createDraft')}</Button>
        </>
      )}
    >
      <form className="mn-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <p className="sheet__lede">{t('catalog.item.newLede')}</p>
        {failure ? <p className="field__error" role="alert">{failure}</p> : null}
        <TextField ref={firstRef} density="staff" label={t('catalog.field.nameTh')} lang="th" value={nameTh} maxLength={120}
          onChange={(e) => { setNameTh(e.target.value); setNameError(null); }} error={nameError ?? undefined} />
        <TextField density="staff" label={t('catalog.field.nameEn')} lang="en" value={nameEn} maxLength={120}
          onChange={(e) => { setNameEn(e.target.value); setNameError(null); }} help={t('catalog.item.nameHelp')} />
        <Select density="staff" label={t('catalog.filter.category')} value={categoryId} placeholder={t('catalog.item.pickCategory')} options={options}
          onChange={(e) => setCategoryId(e.target.value)} />
        <ChoiceGroup legend={t('catalog.editor.pricingType')} rule={t('catalog.item.pricingRule')}>
          {(['fixed', 'variant', 'measured_weight'] as const).map((p) => (
            <RadioCard key={p} name="new-pricing" value={p} checked={pricing === p} onChange={() => setPricing(p)}
              label={t(`catalog.pricing.${p}`)} description={t(`catalog.pricing.${p}Help`)} />
          ))}
        </ChoiceGroup>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  );
}
