// Reusable choice group editor (C6, brief 21 + 44B): min / max / included,
// options with price, upgrade premium, default and availability. Before
// saving it lists every dish the change will touch.
import { useId, useState } from 'react';
import type { AdminCatalogDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, Checkbox, Icon, IconButton, Sheet, TextField, useToast } from '../../ui/index.ts';
import {
  bahtTextToMinor, intText, itemHref, minorToBahtText, navigateFromOverlay, useErrorText, useMenuData, validationIssues, type AdminModifierGroup,
} from './model.tsx';
import { useNameText } from './parts.tsx';

interface OptionForm {
  uid: string;
  id: string | null;
  key: string;
  name_th: string;
  name_en: string;
  price: string;
  upgrade: string;
  is_default: boolean;
  available: boolean;
}

interface Form {
  key: string;
  name_th: string;
  name_en: string;
  min: string;
  max: string;
  included: string;
  options: OptionForm[];
}

let optSeq = 0;
const newUid = () => `o${++optSeq}`;

function formOf(g: AdminModifierGroup | null): Form {
  return {
    key: g?.key ?? '',
    name_th: g?.name.th ?? '',
    name_en: g?.name.en ?? '',
    min: String(g?.min_select ?? 0),
    max: String(g?.max_select ?? 1),
    included: String(g?.included_count ?? 0),
    options: (g?.options ?? []).map((o) => ({
      uid: newUid(), id: o.id, key: o.id, name_th: o.name.th ?? '', name_en: o.name.en ?? '',
      price: minorToBahtText(o.price_delta_minor), upgrade: minorToBahtText(o.upgrade_minor),
      is_default: o.is_default, available: o.available,
    })),
  };
}

function blankOption(): OptionForm {
  return { uid: newUid(), id: null, key: '', name_th: '', name_en: '', price: '0', upgrade: '0', is_default: false, available: true };
}

export function slug(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

type Errors = Record<string, string>;

export default function ModifierGroupEditor({ group, readOnly, onClose }: {
  group: AdminModifierGroup | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const data = useMenuData();
  const errorText = useErrorText();
  const nameText = useNameText();
  const toast = useToast();
  const uid = useId().replace(/:/g, '');
  const [base, setBase] = useState<AdminModifierGroup | null>(group);
  const [form, setForm] = useState<Form>(() => {
    const f = formOf(group);
    return f.options.length ? f : { ...f, options: [blankOption()] };
  });
  const [keyTouched, setKeyTouched] = useState(Boolean(group));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<AdminModifierGroup | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = group === null;
  const snapshot = (f: Form) => JSON.stringify({ ...f, options: f.options.map(({ uid: _u, ...o }) => o) });
  const dirty = isNew || snapshot(form) !== snapshot(formOf(base));

  // Option keys: the DTO does not carry them, so existing options are matched by id and keep their stored key.
  const affected = (base?.item_ids ?? []).map((id) => data.item(id)).filter((i): i is NonNullable<typeof i> => Boolean(i));

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
  };
  const setOpt = (i: number, patch: Partial<OptionForm>) => {
    setForm((f) => ({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[`options.${i}.${k}`];
      return next;
    });
  };
  const moveOpt = (i: number, dir: -1 | 1) => {
    setForm((f) => {
      const to = i + dir;
      if (to < 0 || to >= f.options.length) return f;
      const options = [...f.options];
      [options[i], options[to]] = [options[to], options[i]];
      return { ...f, options };
    });
  };

  const validate = (): Record<string, unknown> | null => {
    const e: Errors = {};
    const key = form.key.trim();
    if (!/^[a-z0-9-]{2,40}$/.test(key)) e.key = t('catalog.groups.keyRule');
    if (!form.name_en.trim()) e.name_en = t('catalog.category.nameEnRequired');
    const min = intText(form.min, 0, 20);
    const max = intText(form.max, 1, 20);
    const inc = intText(form.included, 0, 20);
    if (min === undefined || min === null) e.min = t('catalog.groups.numberRule', { min: 0, max: 20 });
    if (max === undefined || max === null) e.max = t('catalog.groups.numberRule', { min: 1, max: 20 });
    if (inc === undefined || inc === null) e.included = t('catalog.groups.numberRule', { min: 0, max: 20 });
    if (typeof min === 'number' && typeof max === 'number' && max < min) e.max = t('catalog.groups.maxBelowMin');
    if (typeof min === 'number' && min > form.options.length) e.min = t('catalog.groups.minTooMany');
    if (typeof inc === 'number' && typeof max === 'number' && inc > max) e.included = t('catalog.groups.includedTooMany');
    if (form.options.length === 0) e.options = t('catalog.groups.needOption');
    const keys = new Set<string>();
    const options = form.options.map((o, i) => {
      const k = o.id ? o.key : (o.key.trim() || slug(o.name_en) || `option-${i + 1}`);
      if (keys.has(k)) e[`options.${i}.key`] = t('catalog.groups.keyTwice');
      keys.add(k);
      if (!o.name_en.trim()) e[`options.${i}.name_en`] = t('catalog.category.nameEnRequired');
      const price = bahtTextToMinor(o.price);
      const upgrade = bahtTextToMinor(o.upgrade);
      if (price === undefined) e[`options.${i}.price`] = t('catalog.editor.priceRule');
      if (upgrade === undefined) e[`options.${i}.upgrade`] = t('catalog.editor.priceRule');
      if (o.is_default && !o.available) e[`options.${i}.is_default`] = t('catalog.groups.defaultOut');
      return {
        id: o.id, key: k, name_th: o.name_th.trim() || null, name_en: o.name_en.trim(),
        price_delta_minor: price ?? 0, upgrade_minor: upgrade ?? 0, is_default: o.is_default, available: o.available,
      };
    });
    if (typeof max === 'number' && form.options.filter((o) => o.is_default).length > max) e.options = t('catalog.groups.tooManyDefaults');
    setErrors(e);
    if (Object.values(e).some(Boolean)) return null;
    return {
      key, name_th: form.name_th.trim() || null, name_en: form.name_en.trim(),
      min_select: min, max_select: max, included_count: inc, options,
    };
  };

  const save = async () => {
    if (readOnly || saving) return;
    setFailure(null);
    if (!dirty) { onClose(); return; }
    const body = validate();
    if (!body) {
      setFailure(t('catalog.editor.fixFields'));
      return;
    }
    setSaving(true);
    try {
      const res = isNew
        ? await api.post<AdminCatalogDTO>('/api/staff/menu/modifier-groups', body)
        : await api.patch<AdminCatalogDTO>(`/api/staff/menu/modifier-groups/${encodeURIComponent(base!.id)}`, { ...body, version: base!.version });
      data.putCatalog(res);
      toast.show({ message: t(isNew ? 'catalog.groups.created' : 'catalog.groups.saved', { name: form.name_en.trim(), n: affected.length }) });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version' && base) {
        const latest = (err.details as { current?: AdminCatalogDTO } | null)?.current?.modifier_groups.find((g) => g.id === base.id) ?? null;
        if (latest) setConflict(latest);
      } else {
        const issues = validationIssues(err);
        if (issues.length) {
          const e: Errors = {};
          const alias: Record<string, string> = { min_select: 'min', max_select: 'max', included_count: 'included' };
          for (const i of issues) e[alias[i.path] ?? i.path] = t('catalog.err.field');
          if (issues.some((i) => i.path === 'key')) e.key = t('catalog.groups.keyTaken');
          setErrors(e);
        }
      }
      setFailure(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const err = (k: string) => errors[k] || undefined;

  return (
    <Sheet
      open
      onClose={onClose}
      variant="drawer"
      title={isNew ? t('catalog.groups.newTitle') : t(readOnly ? 'catalog.groups.viewTitle' : 'catalog.groups.editTitle', { name: nameText(group.name) })}
      dismissible={!saving}
      className="mn-drawer mn-drawer--wide"
      footerAlign="end"
      footer={readOnly ? (
        <Button variant="outline" size="staff" onClick={onClose}>{t('common.close')}</Button>
      ) : (
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" loading={saving} onClick={() => void save()}>
            {isNew ? t('catalog.groups.create') : affected.length ? t('catalog.groups.saveFor', { n: affected.length }) : t('catalog.groups.save')}
          </Button>
        </>
      )}
    >
      <form className="mn-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {conflict ? (
          <Banner
            variant="warning"
            staff
            title={t('catalog.conflict.title')}
            action={(
              <span className="mn-conflict__acts">
                <Button size="staff" variant="outline" onClick={() => { setBase(conflict); setConflict(null); setFailure(null); }}>{t('catalog.conflict.keepMine')}</Button>
                <Button size="staff" variant="ghost" onClick={() => { setBase(conflict); setForm(formOf(conflict)); setConflict(null); setFailure(null); }}>{t('catalog.conflict.useLatest')}</Button>
              </span>
            )}
          >
            {t('catalog.conflict.bodyGroup')}
          </Banner>
        ) : failure ? (
          <p className="field__error" role="alert">{failure}</p>
        ) : null}

        <section className="mn-affected" aria-labelledby={`${uid}-aff`}>
          <h3 id={`${uid}-aff`}>
            <Icon name="info" size="sm" />
            {isNew ? t('catalog.groups.affectedNone') : t('catalog.groups.affected', { n: affected.length })}
          </h3>
          {affected.length ? (
            <ul className="mn-affected__list">
              {affected.map((i) => (
                <li key={i.id}><a href={itemHref(i.id)} onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigateFromOverlay(itemHref(i.id)); }}>{nameText(i.name)}</a></li>
              ))}
            </ul>
          ) : <p>{t('catalog.groups.attachHint')}</p>}
        </section>

        <fieldset className="mn-fieldset" disabled={readOnly}>
          <legend>{t('catalog.groups.basics')}</legend>
          <div className="mn-grid2">
            <TextField density="staff" label={t('catalog.field.nameTh')} optional lang="th" value={form.name_th} maxLength={80} onChange={(e) => set('name_th', e.target.value)} />
            <TextField
              density="staff" label={t('catalog.field.nameEn')} lang="en" value={form.name_en} maxLength={80} required error={err('name_en')}
              onChange={(e) => { set('name_en', e.target.value); if (!keyTouched) set('key', slug(e.target.value)); }}
            />
          </div>
          <TextField
            density="staff" label={t('catalog.groups.key')} lang="en" value={form.key} maxLength={40} error={err('key')} help={t('catalog.groups.keyHelp')}
            onChange={(e) => { setKeyTouched(true); set('key', e.target.value.toLowerCase()); }}
          />
          <div className="mn-grid3">
            <TextField density="staff" label={t('catalog.groups.min')} inputMode="numeric" value={form.min} onChange={(e) => set('min', e.target.value)} error={err('min')} help={t('catalog.groups.minHelp')} />
            <TextField density="staff" label={t('catalog.groups.max')} inputMode="numeric" value={form.max} onChange={(e) => set('max', e.target.value)} error={err('max')} />
            <TextField density="staff" label={t('catalog.groups.included')} inputMode="numeric" value={form.included} onChange={(e) => set('included', e.target.value)} error={err('included')} help={t('catalog.groups.includedHelp')} />
          </div>
        </fieldset>

        <fieldset className="mn-fieldset" disabled={readOnly}>
          <legend>{t('catalog.groups.options')}</legend>
          {errors.options ? <p className="field__error" role="alert">{errors.options}</p> : null}
          <ol className="mn-opts">
            {form.options.map((o, i) => {
              const label = o.name_en || o.name_th || t('catalog.groups.optionN', { n: i + 1 });
              return (
                <li key={o.uid} className="mn-opt">
                  <div className="mn-opt__head">
                    <span className="mn-opt__n" lang="en">{String(i + 1).padStart(2, '0')}</span>
                    {!readOnly ? (
                      <span className="mn-opt__tools">
                        <IconButton icon="chev-d" className="mn-move__up" variant="framed" size="staff" iconSize="sm" label={t('catalog.list.moveUp', { name: label })} aria-disabled={i === 0 || undefined} onClick={() => moveOpt(i, -1)} />
                        <IconButton icon="chev-d" variant="framed" size="staff" iconSize="sm" label={t('catalog.list.moveDown', { name: label })} aria-disabled={i === form.options.length - 1 || undefined} onClick={() => moveOpt(i, 1)} />
                        <IconButton icon="x" variant="framed" size="staff" iconSize="sm" label={t('catalog.groups.removeOption', { name: label })} aria-disabled={form.options.length === 1 || undefined}
                          onClick={() => { if (form.options.length > 1) set('options', form.options.filter((_, j) => j !== i)); }} />
                      </span>
                    ) : null}
                  </div>
                  <div className="mn-grid2">
                    <TextField density="staff" label={t('catalog.field.nameTh')} optional lang="th" value={o.name_th} maxLength={80} onChange={(e) => setOpt(i, { name_th: e.target.value })} />
                    <TextField density="staff" label={t('catalog.field.nameEn')} lang="en" value={o.name_en} maxLength={80} error={err(`options.${i}.name_en`)} onChange={(e) => setOpt(i, { name_en: e.target.value })} />
                    <TextField density="staff" label={t('catalog.groups.priceDelta')} prefix="฿" inputMode="decimal" value={o.price} error={err(`options.${i}.price`)} help={t('catalog.groups.priceDeltaHelp')} onChange={(e) => setOpt(i, { price: e.target.value })} />
                    <TextField density="staff" label={t('catalog.groups.upgrade')} prefix="฿" inputMode="decimal" value={o.upgrade} error={err(`options.${i}.upgrade`)} help={t('catalog.groups.upgradeHelp')} onChange={(e) => setOpt(i, { upgrade: e.target.value })} />
                  </div>
                  {!o.id ? (
                    <TextField density="staff" label={t('catalog.groups.optionKey')} optional lang="en" value={o.key} maxLength={40} error={err(`options.${i}.key`)} help={t('catalog.groups.optionKeyHelp')} onChange={(e) => setOpt(i, { key: e.target.value })} />
                  ) : null}
                  <div className="mn-opt__checks">
                    <Checkbox label={t('catalog.groups.default')} checked={o.is_default} onChange={(e) => setOpt(i, { is_default: e.target.checked })} />
                    <Checkbox label={t('catalog.groups.available')} checked={o.available} onChange={(e) => setOpt(i, { available: e.target.checked })} />
                  </div>
                  {err(`options.${i}.is_default`) ? <p className="field__error">{err(`options.${i}.is_default`)}</p> : null}
                </li>
              );
            })}
          </ol>
          {!readOnly ? (
            <Button variant="outline" size="staff" icon="plus" iconBold onClick={() => set('options', [...form.options, blankOption()])} disabled={form.options.length >= 30}>
              {t('catalog.groups.addOption')}
            </Button>
          ) : null}
        </fieldset>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Sheet>
  );
}
