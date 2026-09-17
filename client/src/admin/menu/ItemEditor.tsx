// Item editor (C6, brief 04 + 11 + 21 + 44): a full page at
// /admin/menu/items/:id. Names, descriptions, pricing (fixed, variants,
// measured weight), service rules, choice groups, photo, owner review,
// source evidence, price history, publish controls and a guest preview.
// Only changed fields are sent; a stale version shows the latest saved
// values beside the user's edits instead of throwing the edits away.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import type { PricingType, Station } from '../../../../shared/status.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useConfig } from '../../lib/config.tsx';
import { clock, dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import {
  Banner, Button, Checkbox, ChoiceGroup, EmptyState, Icon, IconButton, LinkButton, RadioCard, Select, Skeleton, Tag,
  TextArea, TextField, TextLink, useToast,
} from '../../ui/index.ts';
import {
  blankVariant, buildPatch, diffForms, fieldValue, formOf, type FormErrors, type ItemForm, type VariantForm,
} from './editor-form.ts';
import { FlagsPanel, PriceHistory, SourcePanel } from './EvidencePanel.tsx';
import GuestPreview from './GuestPreview.tsx';
import ModifierGroupEditor from './ModifierGroupEditor.tsx';
import {
  TAB_HREF, useCan, useErrorText, useMenuData, validationIssues, type AdminModifierGroup,
} from './model.tsx';
import { DataNotices, ItemName, LoadFailed, Marker, ruleText, useNameText } from './parts.tsx';
import PhotoPicker, { photoSource, useManifest } from './PhotoPicker.tsx';
import PublishPanel from './PublishPanel.tsx';
import ReviewPanel from './ReviewPanel.tsx';
import { missingDescription, thaiNeedsReview } from './attention.ts';

export default function ItemEditor({ itemId }: { itemId: string }) {
  const { t } = useI18n();
  const data = useMenuData();
  const item = data.item(itemId);

  if (!data.catalog) {
    return (
      <section className="ed mn-pad" aria-labelledby="ed-h" aria-busy={!data.resource.error || undefined}>
        <h2 id="ed-h" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.editor.title')}</h2>
        {data.resource.error ? <LoadFailed resource={data.resource} /> : (
          <div className="ed-loading" role="status" aria-label={t('common.loading')}>
            <Skeleton width="40%" height={32} />
            <Skeleton shape="block" width="100%" height={220} />
            <Skeleton shape="block" width="100%" height={160} />
          </div>
        )}
      </section>
    );
  }
  if (!item) {
    return (
      <section className="ed mn-pad" aria-labelledby="ed-h">
        <h2 id="ed-h" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.editor.title')}</h2>
        <EmptyState icon="search" title={t('catalog.editor.notFound')} headingLevel={3}
          action={<LinkButton href={TAB_HREF.catalog} variant="outline" size="staff" icon="chev-l">{t('catalog.editor.backToCatalog')}</LinkButton>}>
          {t('catalog.editor.notFoundBody')}
        </EmptyState>
      </section>
    );
  }
  return <EditorForm key={item.id} latest={item} />;
}

// ------------------------------------------------------------------ the form page
function EditorForm({ latest }: { latest: AdminItemDTO }) {
  const { t, lang, pick } = useI18n();
  const data = useMenuData();
  const can = useCan();
  const { config } = useConfig();
  const { hash } = useRoute();
  const toast = useToast();
  const errorText = useErrorText();
  const nameText = useNameText();
  const manifest = useManifest();
  const canEdit = can('menu.edit');
  const canReview = can('menu.review');
  const canPublish = can('menu.publish');
  const readOnly = !canEdit;

  const [base, setBase] = useState<AdminItemDTO>(latest);
  const [form, setForm] = useState<ItemForm>(() => formOf(latest));
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<AdminItemDTO | null>(null);
  const [saving, setSaving] = useState(false);
  const [groupEditor, setGroupEditor] = useState<AdminModifierGroup | 'new' | null>(null);
  const pageRef = useRef<HTMLElement>(null);

  const patch = useMemo(() => buildPatch(form, base, { canReview, t }), [form, base, canReview, t]);
  const dirty = patch.changed.length > 0;
  const outdated = latest.version > base.version;

  // Nothing typed yet and a newer version arrived: follow it silently.
  if (outdated && !dirty && !conflict) {
    setBase(latest);
    setForm(formOf(latest));
  }

  // Closing the tab with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Deep links such as #pricing from the availability list.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(`ed-${hash.slice(1)}`);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  }, [hash]);

  const set = <K extends keyof ItemForm>(k: K, v: ItemForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      pageRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };

  const save = async () => {
    if (readOnly || saving || !dirty) return;
    setFailure(null);
    const errs = Object.fromEntries(Object.entries(patch.errors).filter(([, v]) => v));
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFailure(t('catalog.editor.fixFields'));
      focusFirstError();
      return;
    }
    setSaving(true);
    try {
      const res = await api.patch<AdminItemDTO>(`/api/staff/menu/items/${encodeURIComponent(base.id)}`, { ...patch.body, version: base.version });
      data.putItem(res);
      setBase(res);
      setForm(formOf(res));
      setConflict(null);
      toast.show({
        message: patch.priceChanged ? t('catalog.editor.savedPrice', { name: nameText(res.name) }) : t('catalog.editor.saved', { name: nameText(res.name) }),
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version') {
        const current = (err.details as { current?: AdminItemDTO } | null)?.current;
        if (current) { data.putItem(current); setConflict(current); }
        setFailure(errorText(err));
      } else {
        const issues = validationIssues(err);
        if (issues.length) {
          const e: FormErrors = {};
          for (const i of issues) {
            const key = i.path === 'price_minor' ? 'price' : i.path === 'rate_minor' ? 'rate' : i.path === 'rate_basis_grams' ? 'basis' : i.path.replace(/\.(price_minor)$/, '.price');
            e[key] = i.path === 'price_change_reason' ? t('catalog.editor.reasonRequired') : t('catalog.err.field');
          }
          setErrors(e);
          focusFirstError();
        }
        setFailure(errorText(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(formOf(latest));
    setBase(latest);
    setErrors({});
    setFailure(null);
    setConflict(null);
  };

  const categoryName = (id: string) => pick(data.category(id)?.name).text || '—';
  const groupName = (id: string) => pick(data.modifierGroup(id)?.name).text || id;
  const image = photoSource(manifest, form.image, latest.image);
  const blockedReason = dirty ? t('catalog.editor.saveFirstReview') : null;
  const headId = 'ed-h';

  return (
    <article className="ed" ref={pageRef} aria-labelledby={headId}>
      <DataNotices resource={data.resource} />
      <header className="ed-head">
        <TextLink href={TAB_HREF.catalog} icon={null} className="ed-head__back">
          <Icon name="chev-l" size="sm" />{t('catalog.editor.backToCatalog')}
        </TextLink>
        <div className="ed-head__main">
          <h2 id={headId} className="ed-head__t" data-menu-focus tabIndex={-1}>
            <ItemName name={latest.name} size="lg" />
          </h2>
          <p className="ed-head__meta">
            <span>{categoryName(latest.category_id)}</span>
            <span aria-hidden="true">·</span>
            <span>{t(`catalog.pricing.${latest.pricing_type}`)}</span>
            <span aria-hidden="true">·</span>
            <span lang="en" className="ed-head__key">{latest.key}</span>
            <span aria-hidden="true">·</span>
            <span>{t('catalog.editor.updated', { time: dateTime(latest.updated_at, lang) })}</span>
          </p>
        </div>
        {readOnly ? <Tag tone="neutral" icon="lock">{t('catalog.editor.readOnly')}</Tag> : null}
      </header>

      {conflict ? (
        <ConflictPanel
          mine={form}
          base={base}
          latest={conflict}
          categoryName={categoryName}
          groupName={groupName}
          onKeepMine={() => { setForm(mergeForms(form, base, conflict)); setBase(conflict); setConflict(null); setFailure(null); }}
          onUseLatest={() => { setBase(conflict); setForm(formOf(conflict)); setConflict(null); setFailure(null); setErrors({}); }}
        />
      ) : outdated && dirty ? (
        <div className="mn-pad">
          <Banner
            variant="info"
            staff
            title={t('catalog.conflict.elsewhereTitle')}
            action={<Button size="staff" variant="outline" onClick={() => setConflict(latest)}>{t('catalog.conflict.compare')}</Button>}
          >
            {t('catalog.conflict.elsewhereBody')}
          </Banner>
        </div>
      ) : null}

      <div className="ed-grid">
        <div className="ed-pub">
          <PublishPanel item={latest} canPublish={canPublish} dirty={dirty} />
        </div>
        <form className="ed-main" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate aria-label={t('catalog.editor.formLabel')}>
          <EdSection id="names" title={t('catalog.editor.names')}
            aside={<NameMarkers item={latest} />}>
            <fieldset className="mn-fieldset mn-fieldset--bare" disabled={readOnly}>
              <legend className="visually-hidden">{t('catalog.editor.names')}</legend>
              <div className="mn-grid2">
                <TextField density="staff" label={t('catalog.field.nameTh')} lang="th" value={form.name_th} maxLength={120}
                  error={errors.name_th} onChange={(e) => set('name_th', e.target.value)} help={t('catalog.editor.nameThHelp')} />
                <TextField density="staff" label={t('catalog.field.nameEn')} lang="en" value={form.name_en} maxLength={120}
                  error={errors.name_en} onChange={(e) => set('name_en', e.target.value)} />
              </div>
              <div className="mn-grid2">
                <TextArea density="staff" label={t('catalog.field.descTh')} optional lang="th" value={form.desc_th} limit={400} onChange={(v) => set('desc_th', v)} />
                <TextArea density="staff" label={t('catalog.field.descEn')} optional lang="en" value={form.desc_en} limit={400} onChange={(v) => set('desc_en', v)} />
              </div>
            </fieldset>
            {canReview ? (
              <Checkbox
                label={t('catalog.editor.descVerified')}
                description={t('catalog.editor.descVerifiedHelp')}
                checked={form.desc_verified}
                disabled={!form.desc_th.trim() && !form.desc_en.trim()}
                onChange={(e) => set('desc_verified', e.target.checked)}
              />
            ) : (
              <p className="mn-note">
                <Icon name={latest.desc_verified ? 'check-c' : 'info'} size="sm" />
                {latest.desc_verified ? t('catalog.editor.descIsVerified') : t('catalog.editor.descNotVerified')}
                {' '}{t('catalog.editor.descResetNote')}
              </p>
            )}
            {/* Search aliases: other spellings guests type, never printed (D-S8-28). */}
            <fieldset className="mn-fieldset mn-fieldset--bare" disabled={readOnly}>
              <legend className="visually-hidden">{t('catalog.editor.aliases')}</legend>
              <div className="mn-grid2">
                <TextArea density="staff" label={t('catalog.editor.aliasesTh')} optional lang="th" value={form.aliases_th} limit={240}
                  help={t('catalog.editor.aliasesHelp')} error={errors.aliases_th} onChange={(v) => set('aliases_th', v)} />
                <TextArea density="staff" label={t('catalog.editor.aliasesEn')} optional lang="en" value={form.aliases_en} limit={240}
                  error={errors.aliases_en} onChange={(v) => set('aliases_en', v)} />
              </div>
              {canReview ? (
                <Checkbox
                  label={t('catalog.editor.aliasesVerified')}
                  description={t('catalog.editor.aliasesVerifiedHelp')}
                  checked={form.aliases_verified}
                  disabled={!form.aliases_th.trim() && !form.aliases_en.trim()}
                  onChange={(e) => set('aliases_verified', e.target.checked)}
                />
              ) : (
                <p className="mn-note">
                  <Icon name={latest.aliases_verified ? 'check-c' : 'info'} size="sm" />
                  {latest.aliases_verified ? t('catalog.editor.aliasesAreVerified') : t('catalog.editor.aliasesNotVerified')}
                </p>
              )}
            </fieldset>
          </EdSection>

          <EdSection id="pricing" title={t('catalog.editor.pricing')}>
            <PricingFields form={form} set={set} errors={errors} readOnly={readOnly} base={base} priceChanged={patch.priceChanged} />
          </EdSection>

          <EdSection id="service" title={t('catalog.editor.service')}>
            <fieldset className="mn-fieldset mn-fieldset--bare" disabled={readOnly}>
              <legend className="visually-hidden">{t('catalog.editor.service')}</legend>
              <div className="mn-grid3">
                <Select density="staff" label={t('catalog.field.station')} value={form.station} onChange={(e) => set('station', e.target.value as Station)}
                  options={[{ value: 'kitchen', label: t('catalog.station.kitchen') }, { value: 'bar', label: t('catalog.station.bar') }]} />
                <TextField density="staff" label={t('catalog.editor.maxQty')} inputMode="numeric" value={form.max_qty} error={errors.max_qty}
                  onChange={(e) => set('max_qty', e.target.value)} help={t('catalog.editor.maxQtyHelp')} />
                <TextField density="staff" label={t('catalog.editor.noteMax')} inputMode="numeric" value={form.note_max} error={errors.note_max}
                  disabled={!form.notes_allowed || readOnly} onChange={(e) => set('note_max', e.target.value)}
                  help={t('catalog.editor.noteMaxHelp', { n: config?.notes_max_length ?? 140 })} />
              </div>
              {/* What guests read while the kitchen works on this dish (D-S8-18). */}
              <Select
                density="staff"
                label={t('catalog.field.prepKind')}
                value={form.prep_kind}
                onChange={(e) => set('prep_kind', e.target.value as ItemForm['prep_kind'])}
                help={form.prep_kind === '' && latest.prep_kind
                  ? `${t('catalog.editor.prepKindHelp')} ${t('catalog.prep.now', { word: t(`catalog.prep.${latest.prep_kind}`) })}`
                  : t('catalog.editor.prepKindHelp')}
                options={[
                  { value: '', label: t('catalog.prep.auto') },
                  { value: 'cook', label: t('catalog.prep.cook') },
                  { value: 'prepare', label: t('catalog.prep.prepare') },
                ]}
              />
              <Checkbox label={t('catalog.editor.notesAllowed')} description={t('catalog.editor.notesAllowedHelp')} checked={form.notes_allowed} onChange={(e) => set('notes_allowed', e.target.checked)} />
              <Checkbox label={t('catalog.editor.alcohol')} description={t('catalog.editor.alcoholHelp')} checked={form.alcohol} onChange={(e) => set('alcohol', e.target.checked)} />
              <Checkbox label={t('catalog.editor.staffConfirm')} description={t('catalog.editor.staffConfirmHelp')} checked={form.requires_staff_confirm} onChange={(e) => set('requires_staff_confirm', e.target.checked)} />
            </fieldset>
          </EdSection>

          <EdSection id="choices" title={t('catalog.editor.choices')} aside={canEdit ? (
            <Button variant="ghost" size="staff" icon="plus" iconBold opensDialog onClick={() => setGroupEditor('new')}>{t('catalog.groups.new')}</Button>
          ) : null}>
            <ChoiceGroupsField value={form.modifier_group_ids} onChange={(ids) => set('modifier_group_ids', ids)} readOnly={readOnly} onEditGroup={setGroupEditor} />
          </EdSection>

          <EdSection id="photo" title={t('catalog.editor.photo')}>
            <PhotoPicker
              itemId={latest.id}
              value={form.image}
              altTh={form.image_alt_th}
              altEn={form.image_alt_en}
              onChange={(v) => set('image', v)}
              onAltTh={(v) => set('image_alt_th', v)}
              onAltEn={(v) => set('image_alt_en', v)}
              disabled={readOnly}
              errors={errors}
            />
          </EdSection>

          <EdSection id="review" title={t('catalog.editor.review')} lede={t('catalog.allergen.neverFree')}>
            <ReviewPanel item={latest} canReview={canReview} blockedReason={blockedReason} />
          </EdSection>

          <EdSection id="source" title={t('catalog.editor.source')}>
            <SourcePanel item={latest} />
            {!canReview ? (
              <TextArea density="staff" label={t('catalog.editor.internalNotes')} optional value={form.review_notes} limit={1000}
                disabled={readOnly} onChange={(v) => set('review_notes', v)} help={t('catalog.editor.internalNotesHelp')} />
            ) : null}
            <h4 className="ed-sub">{t('catalog.flags.title')}</h4>
            <FlagsPanel item={latest} canReview={canReview} />
          </EdSection>

          <EdSection id="history" title={t('catalog.editor.history')}>
            <PriceHistory item={latest} />
          </EdSection>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>

        <div className="ed-prev">
          <GuestPreview form={form} base={base} priceChanged={patch.priceChanged} canReview={canReview} image={image} />
        </div>
      </div>

      {canEdit ? (
        <div className={dirty ? 'ed-bar is-dirty' : 'ed-bar'} role="region" aria-label={t('catalog.editor.saveBar')}>
          <p className="ed-bar__state" role="status">
            {dirty
              ? <><Icon name="note" size="sm" />{t('catalog.editor.unsaved', { n: patch.changed.length })}</>
              : <><Icon name="check" size="sm" />{t('catalog.editor.allSaved')}</>}
          </p>
          {failure ? <p className="ed-bar__err" role="alert"><Icon name="alert" size="sm" />{failure}</p> : null}
          <div className="ed-bar__acts">
            <Button variant="ghost" size="staff" onClick={discard} disabled={!dirty || saving}>{t('catalog.editor.discard')}</Button>
            <Button variant="primary" size="staff" icon="check" loading={saving} aria-disabled={!dirty || undefined} onClick={() => void save()}>
              {t('catalog.editor.save')}
            </Button>
          </div>
        </div>
      ) : null}

      {groupEditor ? (
        <ModifierGroupEditor group={groupEditor === 'new' ? null : groupEditor} readOnly={!canEdit} onClose={() => setGroupEditor(null)} />
      ) : null}
    </article>
  );
}

// ------------------------------------------------------------------ layout pieces
function EdSection({ id, title, lede, aside, children }: { id: string; title: string; lede?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="ed-card" id={`ed-${id}`} aria-labelledby={`ed-${id}-h`}>
      <header className="ed-card__head">
        <h3 id={`ed-${id}-h`} tabIndex={-1}>{title}</h3>
        {aside}
      </header>
      {lede ? <p className="ed-card__lede">{lede}</p> : null}
      {children}
    </section>
  );
}

function NameMarkers({ item }: { item: AdminItemDTO }) {
  const { t } = useI18n();
  return (
    <span className="ed-marks">
      {!item.name.th ? <Marker icon="info" tone="heat">{t('catalog.mark.noThai')}</Marker>
        : thaiNeedsReview(item) ? <Marker icon="info" tone="heat">{t('catalog.mark.thaiUnapproved')}</Marker> : null}
      {missingDescription(item) ? <Marker icon="info">{t('catalog.mark.noDescription')}</Marker> : null}
    </span>
  );
}

// ------------------------------------------------------------------ pricing
function PricingFields({ form, set, errors, readOnly, base, priceChanged }: {
  form: ItemForm;
  set: <K extends keyof ItemForm>(k: K, v: ItemForm[K]) => void;
  errors: FormErrors;
  readOnly: boolean;
  base: AdminItemDTO;
  priceChanged: boolean;
}) {
  const { t, pick } = useI18n();
  const data = useMenuData();
  const uid = useId().replace(/:/g, '');
  const categories = (['food', 'drinks'] as const).flatMap((g) => data.categoriesOf(g).map((c) => ({
    value: c.id,
    label: `${t(`catalog.group.${g}`)} · ${pick(c.name).text}`,
  })));

  const setVariant = (i: number, p: Partial<VariantForm>) => set('variants', form.variants.map((v, j) => (j === i ? { ...v, ...p } : v)));
  const moveVariant = (i: number, dir: -1 | 1) => {
    const to = i + dir;
    if (to < 0 || to >= form.variants.length) return;
    const next = [...form.variants];
    [next[i], next[to]] = [next[to], next[i]];
    set('variants', next);
  };

  return (
    <fieldset className="mn-fieldset mn-fieldset--bare" disabled={readOnly}>
      <legend className="visually-hidden">{t('catalog.editor.pricing')}</legend>
      <Select density="staff" label={t('catalog.filter.category')} value={form.category_id} options={categories}
        onChange={(e) => set('category_id', e.target.value)} help={t('catalog.editor.categoryHelp')} />

      <ChoiceGroup legend={t('catalog.editor.pricingType')} rule={t('catalog.editor.pricingRule')}>
        {(['fixed', 'variant', 'measured_weight'] as PricingType[]).map((p) => (
          <RadioCard key={p} name={`${uid}-pricing`} value={p} checked={form.pricing_type === p}
            onChange={() => {
              set('pricing_type', p);
              if (p === 'variant' && form.variants.length === 0) set('variants', [blankVariant(1)]);
            }}
            label={t(`catalog.pricing.${p}`)} description={t(`catalog.pricing.${p}Help`)} />
        ))}
      </ChoiceGroup>
      {form.pricing_type !== base.pricing_type ? (
        <p className="mn-note"><Icon name="alert" size="sm" />{t('catalog.editor.typeChangeNote')}</p>
      ) : null}

      {form.pricing_type === 'fixed' ? (
        <TextField density="staff" label={t('catalog.editor.price')} prefix="฿" inputMode="decimal" value={form.price}
          error={errors.price} onChange={(e) => set('price', e.target.value)} help={t('catalog.editor.priceHelp')} className="ed-price" />
      ) : null}

      {form.pricing_type === 'measured_weight' ? (
        <>
          <div className="mn-grid2">
            <TextField density="staff" label={t('catalog.editor.rate')} prefix="฿" inputMode="decimal" value={form.rate}
              error={errors.rate} onChange={(e) => set('rate', e.target.value)} />
            <TextField density="staff" label={t('catalog.editor.basis')} suffix={t('catalog.editor.grams')} inputMode="numeric" value={form.basis}
              error={errors.basis} onChange={(e) => set('basis', e.target.value)} />
          </div>
          <p className="mn-note"><Icon name="scale" size="sm" />{t('catalog.editor.weightNote')}</p>
        </>
      ) : null}

      {form.pricing_type === 'variant' ? (
        <div className="ed-vars">
          {errors.variants ? <p className="field__error" role="alert">{errors.variants}</p> : null}
          <ol className="ed-vars__list">
            {form.variants.map((v, i) => {
              const label = v.name_en || v.name_th || v.key || t('catalog.editor.variantN', { n: i + 1 });
              return (
                <li key={v.uid} className="ed-var">
                  <div className="ed-var__head">
                    <span className="ed-var__n" lang="en">{String(i + 1).padStart(2, '0')}</span>
                    <Checkbox label={t('catalog.editor.variantAvailable')} checked={v.available} onChange={(e) => setVariant(i, { available: e.target.checked })} />
                    {!readOnly ? (
                      <span className="ed-var__tools">
                        <IconButton icon="chev-d" className="mn-move__up" variant="framed" size="staff" iconSize="sm" label={t('catalog.list.moveUp', { name: label })}
                          aria-disabled={i === 0 || undefined} onClick={() => moveVariant(i, -1)} />
                        <IconButton icon="chev-d" variant="framed" size="staff" iconSize="sm" label={t('catalog.list.moveDown', { name: label })}
                          aria-disabled={i === form.variants.length - 1 || undefined} onClick={() => moveVariant(i, 1)} />
                        <IconButton icon="x" variant="framed" size="staff" iconSize="sm" label={t('catalog.editor.removeVariant', { name: label })}
                          onClick={() => set('variants', form.variants.filter((_, j) => j !== i))} />
                      </span>
                    ) : null}
                  </div>
                  <div className="ed-var__grid">
                    <TextField density="staff" label={t('catalog.field.nameTh')} optional lang="th" value={v.name_th} maxLength={60} onChange={(e) => setVariant(i, { name_th: e.target.value })} />
                    <TextField density="staff" label={t('catalog.field.nameEn')} optional lang="en" value={v.name_en} maxLength={60} onChange={(e) => setVariant(i, { name_en: e.target.value })} />
                    <TextField density="staff" label={t('catalog.editor.price')} prefix="฿" inputMode="decimal" value={v.price}
                      error={errors[`variants.${i}.price`]} onChange={(e) => setVariant(i, { price: e.target.value })} />
                    <TextField density="staff" label={t('catalog.editor.variantKey')} lang="en" value={v.key} maxLength={40}
                      error={errors[`variants.${i}.key`]} onChange={(e) => setVariant(i, { key: e.target.value })} />
                  </div>
                  {!v.price.trim() ? <p className="field__help">{t('catalog.editor.variantNoPrice')}</p> : null}
                </li>
              );
            })}
          </ol>
          {!readOnly ? (
            <Button variant="outline" size="staff" icon="plus" iconBold disabled={form.variants.length >= 12}
              onClick={() => set('variants', [...form.variants, blankVariant(form.variants.length + 1)])}>
              {t('catalog.editor.addVariant')}
            </Button>
          ) : null}
          <p className="field__help">{t('catalog.editor.variantHelp')}</p>
        </div>
      ) : null}

      {priceChanged ? (
        <TextArea density="staff" className="ed-reason" label={t('catalog.editor.reason')} value={form.price_change_reason} limit={200}
          optional={base.status !== 'published'} error={errors.price_change_reason}
          onChange={(v) => set('price_change_reason', v)}
          help={base.status === 'published' ? t('catalog.editor.reasonHelpPublished') : t('catalog.editor.reasonHelpDraft')} />
      ) : null}

      <div className="mn-grid2">
        <TextField density="staff" label={t('catalog.editor.portionTh')} optional lang="th" value={form.portion_note_th} maxLength={60}
          onChange={(e) => set('portion_note_th', e.target.value)} help={t('catalog.editor.portionHelp')} />
        <TextField density="staff" label={t('catalog.editor.portionEn')} optional lang="en" value={form.portion_note_en} maxLength={60}
          onChange={(e) => set('portion_note_en', e.target.value)} />
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ choice groups
function ChoiceGroupsField({ value, onChange, readOnly, onEditGroup }: {
  value: string[];
  onChange: (ids: string[]) => void;
  readOnly: boolean;
  onEditGroup: (g: AdminModifierGroup) => void;
}) {
  const { t, pick } = useI18n();
  const data = useMenuData();
  const [pickId, setPickId] = useState('');
  const all = data.catalog?.modifier_groups ?? [];
  const attached = value.map((id) => data.modifierGroup(id)).filter((g): g is AdminModifierGroup => Boolean(g));
  const free = all.filter((g) => !value.includes(g.id));

  const move = (i: number, dir: -1 | 1) => {
    const to = i + dir;
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    [next[i], next[to]] = [next[to], next[i]];
    onChange(next);
  };

  return (
    <div className="ed-groups">
      {attached.length === 0 ? <p className="field__help">{t('catalog.editor.noGroups')}</p> : (
        <ol className="ed-groups__list">
          {attached.map((g, i) => {
            const n = pick(g.name);
            const available = g.options.filter((o) => o.available).length;
            const impossible = g.min_select > 0 && available < g.min_select;
            return (
              <li key={g.id} className="ed-group">
                <div className="ed-group__main">
                  <p className="ed-group__t" lang={n.lang}>{n.text}</p>
                  <p className="ed-group__rule">{ruleText(g, t)} · {t('catalog.groups.optionCount', { n: g.options.length })}</p>
                  {impossible ? <Marker icon="alert" tone="alert">{t('catalog.blocker.required_choice_unavailable')}</Marker> : null}
                </div>
                <span className="ed-group__tools">
                  <Button variant="ghost" size="staff" opensDialog onClick={() => onEditGroup(g)}>{readOnly ? t('catalog.category.view') : t('catalog.groups.edit')}</Button>
                  {!readOnly ? (
                    <>
                      <IconButton icon="chev-d" className="mn-move__up" variant="framed" size="staff" iconSize="sm" label={t('catalog.list.moveUp', { name: n.text })}
                        aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)} />
                      <IconButton icon="chev-d" variant="framed" size="staff" iconSize="sm" label={t('catalog.list.moveDown', { name: n.text })}
                        aria-disabled={i === attached.length - 1 || undefined} onClick={() => move(i, 1)} />
                      <IconButton icon="x" variant="framed" size="staff" iconSize="sm" label={t('catalog.editor.detachGroup', { name: n.text })}
                        onClick={() => onChange(value.filter((id) => id !== g.id))} />
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && free.length ? (
        <div className="ed-groups__add">
          <Select density="staff" label={t('catalog.editor.attachLabel')} value={pickId} placeholder={t('catalog.editor.attachPlaceholder')}
            options={free.map((g) => ({ value: g.id, label: `${pick(g.name).text} · ${ruleText(g, t)}` }))}
            onChange={(e) => setPickId(e.target.value)} />
          <Button variant="outline" size="staff" icon="plus" iconBold disabled={!pickId}
            onClick={() => { if (pickId) { onChange([...value, pickId]); setPickId(''); } }}>
            {t('catalog.editor.attach')}
          </Button>
        </div>
      ) : null}
      <p className="field__help">{t('catalog.editor.groupsHelp')}</p>
    </div>
  );
}

// ------------------------------------------------------------------ conflicts
/**
 * Three-way merge for "keep my edits": fields this person changed keep their
 * value; everything else takes the latest saved value, so a change made on
 * another device to a field nobody touched here is never undone.
 */
function mergeForms(mine: ItemForm, base: AdminItemDTO, latest: AdminItemDTO): ItemForm {
  const merged = formOf(latest) as unknown as Record<string, unknown>;
  const mineRec = mine as unknown as Record<string, unknown>;
  for (const k of diffForms(mine, formOf(base))) merged[k] = mineRec[k];
  merged.price_change_reason = mine.price_change_reason;
  return merged as unknown as ItemForm;
}

function ConflictPanel({ mine, base, latest, categoryName, groupName, onKeepMine, onUseLatest }: {
  mine: ItemForm;
  base: AdminItemDTO;
  latest: AdminItemDTO;
  categoryName: (id: string) => string;
  groupName: (id: string) => string;
  onKeepMine: () => void;
  onUseLatest: () => void;
}) {
  const { t } = useI18n();
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headRef.current?.focus(); }, [latest.version]);
  const theirs = formOf(latest);
  const was = formOf(base);
  const minePart = new Set(diffForms(mine, was));
  const theirPart = diffForms(theirs, was);
  const keys = [...new Set([...minePart, ...theirPart])].filter((k) => minePart.has(k) || theirPart.includes(k));
  return (
    <section className="mn-pad ed-conflict" aria-labelledby="ed-conflict-h">
      <div className="ed-conflict__box">
        <h3 id="ed-conflict-h" ref={headRef} tabIndex={-1}><Icon name="alert" size="sm" />{t('catalog.conflict.title')}</h3>
        <p>{t('catalog.conflict.itemBody', { time: clock(latest.updated_at) })}</p>
        {keys.length ? (
          <table className="ed-conflict__table">
            <caption className="visually-hidden">{t('catalog.conflict.tableCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('catalog.conflict.field')}</th>
                <th scope="col">{t('catalog.conflict.saved')}</th>
                <th scope="col">{t('catalog.conflict.yours')}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}>
                  <th scope="row">{t(`catalog.efield.${k}`)}</th>
                  <td>{fieldValue(theirs, k, t, groupName, categoryName)}</td>
                  <td>{minePart.has(k) ? <b>{fieldValue(mine, k, t, groupName, categoryName)}</b> : <span className="ed-conflict__same">{t('catalog.conflict.notEdited')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="field__help">{t('catalog.conflict.same')}</p>}
        <div className="ed-conflict__acts">
          <Button variant="primary" size="staff" onClick={onKeepMine}>{t('catalog.conflict.keepMine')}</Button>
          <Button variant="outline" size="staff" onClick={onUseLatest}>{t('catalog.conflict.useLatest')}</Button>
        </div>
        <p className="field__help">{t('catalog.conflict.keepHelp')}</p>
      </div>
    </section>
  );
}
