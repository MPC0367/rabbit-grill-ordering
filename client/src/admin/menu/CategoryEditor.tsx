// Category editor (C6, brief 21 + 25 + 44D): names, guest note, group,
// status, seasonal dates, station, alcohol and the ordering pause. Opens as a
// drawer (full sheet on phones). Version conflicts keep the user's edits.
import { useId, useState } from 'react';
import type { AdminCatalogDTO } from '../../../../shared/dto.ts';
import type { ItemStatus, Station } from '../../../../shared/status.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, Checkbox, Select, Sheet, TextArea, TextField, useToast } from '../../ui/index.ts';
import { useCan, useErrorText, useMenuData, validationIssues, type AdminCategory, type GroupKey } from './model.tsx';
import { useNameText } from './parts.tsx';

interface Form {
  name_th: string; name_en: string; note_th: string; note_en: string;
  group: GroupKey; status: ItemStatus; seasonal: boolean; active_from: string; active_until: string;
  station: Station; prep_kind: '' | 'cook' | 'prepare'; alcohol: boolean; ordering_paused: boolean;
}

function formOf(c: AdminCategory | null, group: GroupKey): Form {
  return {
    name_th: c?.name.th ?? '', name_en: c?.name.en ?? '',
    note_th: c?.note?.th ?? '', note_en: c?.note?.en ?? '',
    group: c?.group ?? group, status: c?.status ?? 'draft',
    seasonal: c?.seasonal ?? false, active_from: c?.active_from ?? '', active_until: c?.active_until ?? '',
    station: c?.station ?? (group === 'drinks' ? 'bar' : 'kitchen'), prep_kind: c?.prep_kind ?? '', alcohol: c?.alcohol ?? false,
    ordering_paused: c?.ordering_paused ?? false,
  };
}

const FIELDS: Array<keyof Form> = ['name_th', 'name_en', 'note_th', 'note_en', 'group', 'status', 'seasonal', 'active_from', 'active_until', 'station', 'prep_kind', 'alcohol', 'ordering_paused'];
const nul = (s: string) => (s.trim() ? s.trim() : null);

export default function CategoryEditor({ category, defaultGroup, readOnly, onClose }: {
  category: AdminCategory | null;
  defaultGroup: GroupKey;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const data = useMenuData();
  const can = useCan();
  const canPause = can('ordering.pause');
  const errorText = useErrorText();
  const nameText = useNameText();
  const toast = useToast();
  const uid = useId();
  const [base, setBase] = useState<AdminCategory | null>(category);
  const [form, setForm] = useState<Form>(() => formOf(category, defaultGroup));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<AdminCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = category === null;
  const initial = formOf(base, defaultGroup);
  const changed = FIELDS.filter((k) => form[k] !== initial[k]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const validate = (): boolean => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!form.name_en.trim()) e.name_en = t('catalog.category.nameEnRequired');
    if (form.active_from && form.active_until && form.active_from > form.active_until) e.active_until = t('catalog.category.datesOrder');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (readOnly || saving) return;
    setFailure(null);
    if (!validate()) return;
    const values: Record<string, unknown> = {
      name_th: nul(form.name_th), name_en: form.name_en.trim(), note_th: nul(form.note_th), note_en: nul(form.note_en),
      group: form.group, status: form.status, seasonal: form.seasonal,
      active_from: form.active_from || null, active_until: form.active_until || null,
      station: form.station, prep_kind: form.prep_kind || null, alcohol: form.alcohol,
    };
    if (canPause) values.ordering_paused = form.ordering_paused;
    setSaving(true);
    try {
      let res: AdminCatalogDTO;
      if (isNew) {
        res = await api.post<AdminCatalogDTO>('/api/staff/menu/categories', values);
      } else {
        const body: Record<string, unknown> = { version: base!.version };
        for (const k of changed) body[k] = values[k];
        if (changed.length === 0) { onClose(); return; }
        res = await api.patch<AdminCatalogDTO>(`/api/staff/menu/categories/${encodeURIComponent(base!.id)}`, body);
      }
      data.putCatalog(res);
      toast.show({ message: t(isNew ? 'catalog.category.created' : 'catalog.category.saved', { name: form.name_th.trim() && lang === 'th' ? form.name_th.trim() : form.name_en.trim() }) });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version' && base) {
        const latest = (err.details as { current?: AdminCatalogDTO } | null)?.current?.categories.find((c) => c.id === base.id) ?? null;
        if (latest) setConflict(latest);
        setFailure(errorText(err));
        return;
      }
      const issues = validationIssues(err);
      if (issues.length) {
        const e: Partial<Record<keyof Form, string>> = {};
        for (const i of issues) {
          const k = i.path.split('.')[0] as keyof Form;
          if (FIELDS.includes(k)) e[k] = i.path === 'active_until' ? t('catalog.category.datesOrder') : t('catalog.err.field');
        }
        setErrors(e);
      }
      setFailure(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const title = isNew
    ? t('catalog.category.newTitle')
    : readOnly ? nameText(category.name) : t('catalog.category.editTitle', { name: nameText(category.name) });

  return (
    <Sheet
      open
      onClose={onClose}
      variant="drawer"
      title={title}
      dismissible={!saving}
      className="mn-drawer"
      footerAlign="end"
      footer={readOnly ? (
        <Button variant="outline" size="staff" onClick={onClose}>{t('common.close')}</Button>
      ) : (
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={saving} onClick={() => void save()}>
            {isNew ? t('catalog.category.create') : t('catalog.category.save')}
          </Button>
        </>
      )}
    >
      <form
        className="mn-form"
        onSubmit={(e) => { e.preventDefault(); void save(); }}
        aria-describedby={failure ? `${uid}-fail` : undefined}
      >
        {conflict ? (
          <div className="mn-conflict-wrap">
          <Banner
            variant="warning"
            staff
            title={t('catalog.conflict.title')}
            action={(
              <span className="mn-conflict__acts">
                <Button size="staff" variant="outline" onClick={() => { setBase(conflict); setConflict(null); setFailure(null); }}>{t('catalog.conflict.keepMine')}</Button>
                <Button size="staff" variant="ghost" onClick={() => { setBase(conflict); setForm(formOf(conflict, defaultGroup)); setConflict(null); setFailure(null); }}>{t('catalog.conflict.useLatest')}</Button>
              </span>
            )}
          >
            {t('catalog.conflict.body')}
          </Banner>
          <ConflictList fields={FIELDS.filter((k) => formOf(conflict, defaultGroup)[k] !== form[k])} latest={formOf(conflict, defaultGroup)} />
          </div>
        ) : failure ? (
          <p className="field__error" role="alert" id={`${uid}-fail`}>{failure}</p>
        ) : null}

        <fieldset className="mn-fieldset" disabled={readOnly}>
          <legend>{t('catalog.category.names')}</legend>
          <TextField density="staff" label={t('catalog.field.nameTh')} optional lang="th" value={form.name_th} maxLength={80} onChange={(e) => set('name_th', e.target.value)} error={errors.name_th} />
          <TextField density="staff" label={t('catalog.field.nameEn')} lang="en" value={form.name_en} maxLength={80} required onChange={(e) => set('name_en', e.target.value)} error={errors.name_en} />
          <TextArea density="staff" label={t('catalog.category.noteTh')} optional lang="th" value={form.note_th} limit={200} onChange={(v) => set('note_th', v)} help={t('catalog.category.noteHelp')} />
          <TextArea density="staff" label={t('catalog.category.noteEn')} optional lang="en" value={form.note_en} limit={200} onChange={(v) => set('note_en', v)} />
        </fieldset>

        <fieldset className="mn-fieldset" disabled={readOnly}>
          <legend>{t('catalog.category.placement')}</legend>
          <div className="mn-grid2">
            <Select density="staff" label={t('catalog.filter.group')} value={form.group} onChange={(e) => set('group', e.target.value as GroupKey)}
              options={[{ value: 'food', label: t('catalog.group.food') }, { value: 'drinks', label: t('catalog.group.drinks') }]} />
            <Select density="staff" label={t('catalog.field.station')} value={form.station} onChange={(e) => set('station', e.target.value as Station)}
              options={[{ value: 'kitchen', label: t('catalog.station.kitchen') }, { value: 'bar', label: t('catalog.station.bar') }]} />
          </div>
          {/* What guests read while the kitchen works on a dish of this category (D-S8-18). */}
          <Select
            density="staff"
            label={t('catalog.field.prepKind')}
            value={form.prep_kind}
            onChange={(e) => set('prep_kind', e.target.value as Form['prep_kind'])}
            help={t('catalog.category.prepKindHelp')}
            options={[
              { value: '', label: t('catalog.prep.auto') },
              { value: 'cook', label: t('catalog.prep.cook') },
              { value: 'prepare', label: t('catalog.prep.prepare') },
            ]}
          />
          <Select density="staff" label={t('catalog.category.status')} value={form.status} onChange={(e) => set('status', e.target.value as ItemStatus)}
            help={t('catalog.category.statusHelp')}
            options={(['draft', 'published', 'archived'] as const).map((s) => ({ value: s, label: t(`catalog.status.${s}`) }))} />
        </fieldset>

        <fieldset className="mn-fieldset" disabled={readOnly}>
          <legend>{t('catalog.category.availability')}</legend>
          <Checkbox label={t('catalog.category.seasonal')} description={t('catalog.category.seasonalHelp')} checked={form.seasonal} onChange={(e) => set('seasonal', e.target.checked)} />
          <div className="mn-grid2">
            <TextField density="staff" type="date" label={t('catalog.category.from')} optional value={form.active_from} onChange={(e) => set('active_from', e.target.value)} error={errors.active_from} />
            <TextField density="staff" type="date" label={t('catalog.category.until')} optional value={form.active_until} onChange={(e) => set('active_until', e.target.value)} error={errors.active_until} />
          </div>
          <p className="field__help">{t('catalog.category.datesHelp')}</p>
          <Checkbox label={t('catalog.category.alcohol')} description={t('catalog.category.alcoholHelp')} checked={form.alcohol} onChange={(e) => set('alcohol', e.target.checked)} />
          {!isNew ? (
            <Checkbox
              label={t('catalog.category.pausedField')}
              description={canPause ? t('catalog.category.pausedHelp') : t('catalog.category.pausedNoPerm')}
              checked={form.ordering_paused}
              disabled={!canPause || readOnly}
              onChange={(e) => set('ordering_paused', e.target.checked)}
            />
          ) : null}
        </fieldset>

        {category?.source_note ? (
          <section className="mn-evidence" aria-labelledby={`${uid}-src`}>
            <h3 id={`${uid}-src`}>{t('catalog.category.sourceNote')}</h3>
            <p lang="en">{category.source_note}</p>
          </section>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  );
}

function ConflictList({ fields, latest }: { fields: Array<keyof Form>; latest: Form }) {
  const { t } = useI18n();
  if (!fields.length) return null;
  const shown = (k: keyof Form, v: Form[keyof Form]): string => {
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (k === 'prep_kind') return v ? t(`catalog.prep.${v}`) : t('catalog.prep.auto');
    if (!v) return t('catalog.conflict.blank');
    if (k === 'status') return t(`catalog.status.${v}`);
    if (k === 'group') return t(`catalog.group.${v}`);
    if (k === 'station') return t(`catalog.station.${v}`);
    return String(v);
  };
  return (
    <ul className="mn-conflict">
      {fields.map((k) => (
        <li key={k}>
          <b>{t(`catalog.cfield.${k}`)}</b>
          <span>{t('catalog.conflict.latestIs', { value: shown(k, latest[k]) })}</span>
        </li>
      ))}
    </ul>
  );
}
