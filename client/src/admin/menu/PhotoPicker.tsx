// Photo picker (C6, brief 04 + 34): choose one of the processed dish photos
// listed in /media/manifest.json, with previews and TH/EN alt text. A missing
// photo never blocks publishing; guests then see a text-led row.
import { useEffect, useId, useMemo, useState } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, DishImage, EmptyState, Icon, StaffSearch, TextArea, dishImageUrl, normalizeSearch, type DishImageSource } from '../../ui/index.ts';
import { IMAGE_ALT_MAX } from '../../../../shared/schemas.ts';
import { useMenuData } from './model.tsx';
import { useNameText } from './parts.tsx';

export interface ManifestPhoto { name: string; sizes: number[]; w: number; h: number }

let manifestCache: Promise<ManifestPhoto[]> | null = null;

function loadManifest(): Promise<ManifestPhoto[]> {
  if (!manifestCache) {
    manifestCache = fetch('/media/manifest.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ dish?: Record<string, { sizes: number[]; w: number; h: number }> }>;
      })
      .then((m) => Object.entries(m.dish ?? {}).map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name)))
      .catch((err) => { manifestCache = null; throw err; });
  }
  return manifestCache;
}

/** The processed photo list; `null` while loading, `'error'` when the manifest is unreachable. */
export function useManifest(): ManifestPhoto[] | null | 'error' {
  const [state, setState] = useState<ManifestPhoto[] | null | 'error'>(null);
  useEffect(() => {
    let alive = true;
    loadManifest().then((list) => { if (alive) setState(list); }, () => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);
  return state;
}

export function photoSource(list: ManifestPhoto[] | null | 'error', name: string, fallback: DishImageSource | null): DishImageSource | null {
  if (!name) return null;
  if (Array.isArray(list)) {
    const p = list.find((x) => x.name === name);
    if (p) return { name: p.name, sizes: p.sizes, w: p.w, h: p.h, alt: { th: null, en: null } };
    return null;
  }
  return fallback && fallback.name === name ? fallback : null;
}

export default function PhotoPicker({ itemId, value, altTh, altEn, onChange, onAltTh, onAltEn, disabled, errors }: {
  itemId: string;
  value: string;
  altTh: string;
  altEn: string;
  onChange: (name: string) => void;
  onAltTh: (v: string) => void;
  onAltEn: (v: string) => void;
  disabled: boolean;
  errors: Partial<Record<string, string>>;
}) {
  const { t } = useI18n();
  const data = useMenuData();
  const nameText = useNameText();
  const manifest = useManifest();
  const uid = useId().replace(/:/g, '');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = photoSource(manifest, value, data.item(itemId)?.image ?? null);

  const usedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const it of data.items) {
      if (!it.image || it.id === itemId || it.status === 'archived') continue;
      const list = map.get(it.image.name);
      if (list) list.push(nameText(it.name)); else map.set(it.image.name, [nameText(it.name)]);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.items, itemId]);

  const photos = Array.isArray(manifest) ? manifest.filter((p) => !q || normalizeSearch(p.name.replace(/-/g, ' ')).includes(normalizeSearch(q))) : [];

  return (
    <div className="ph">
      <div className="ph__current">
        {current ? (
          <DishImage image={{ ...current, alt: { th: altTh || null, en: altEn || null } }} variant="plate" plateClassName="ph__plate" decorative />
        ) : (
          <div className="ph__none" aria-hidden="true"><Icon name="info" /></div>
        )}
        <div className="ph__meta">
          <p className="ph__name">
            {current ? <span lang="en">{current.name}</span> : value ? t('catalog.photo.missingFile', { name: value }) : t('catalog.photo.none')}
          </p>
          <p className="field__help">{current ? t('catalog.photo.using') : t('catalog.photo.noneHelp')}</p>
          {!disabled ? (
            <div className="ph__acts">
              <Button variant="outline" size="staff" aria-expanded={open} aria-controls={`${uid}-grid`} onClick={() => setOpen((v) => !v)} iconEnd={open ? 'chev-d' : 'chev-r'}>
                {open ? t('catalog.photo.closeChooser') : t('catalog.photo.choose')}
              </Button>
              {value ? <Button variant="ghost" size="staff" icon="x" onClick={() => onChange('')}>{t('catalog.photo.remove')}</Button> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div id={`${uid}-grid`} hidden={!open} className="ph__chooser">
        {open ? (
          manifest === null ? (
            <p className="field__help">{t('common.loading')}</p>
          ) : manifest === 'error' ? (
            <EmptyState compact icon="wifi-off" title={t('catalog.photo.manifestFailed')} />
          ) : (
            <>
              <StaffSearch label={t('catalog.photo.search')} placeholder={t('catalog.photo.search')} value={q} onChange={setQ} />
              <fieldset className="ph__grid">
                <legend className="visually-hidden">{t('catalog.photo.choose')}</legend>
                {photos.map((p) => {
                  const others = usedBy.get(p.name);
                  return (
                    <label key={p.name} className="ph__tile">
                      <input type="radio" name={`${uid}-photo`} value={p.name} checked={value === p.name} onChange={() => onChange(p.name)} />
                      <img src={dishImageUrl(p.name, p.sizes.find((s) => s >= 240) ?? p.sizes[0])} alt="" width={120} height={90} loading="lazy" decoding="async" />
                      <span className="ph__tile-n" lang="en">{p.name}</span>
                      {others ? <span className="ph__tile-u">{t('catalog.photo.usedBy', { names: others.join(', ') })}</span> : null}
                    </label>
                  );
                })}
              </fieldset>
              {photos.length === 0 ? <p className="field__help">{t('catalog.filter.noMatch', { q })}</p> : null}
            </>
          )
        ) : null}
      </div>

      <div className="mn-grid2">
        <TextArea density="staff" label={t('catalog.photo.altTh')} optional lang="th" value={altTh} limit={IMAGE_ALT_MAX} onChange={onAltTh} disabled={disabled || !value} error={errors.image_alt_th} />
        <TextArea density="staff" label={t('catalog.photo.altEn')} optional lang="en" value={altEn} limit={IMAGE_ALT_MAX} onChange={onAltEn} disabled={disabled || !value} error={errors.image_alt_en} />
      </div>
      <p className="field__help">{t('catalog.photo.altHelp')}</p>
    </div>
  );
}
