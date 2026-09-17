// Import / export (C6, brief 21): documented template and current export,
// upload or paste a CSV, a validation preview with row-level errors, then
// "Apply to drafts". An import never publishes and never changes published
// or archived dishes. File contents are data only.
import { useId, useRef, useState } from 'react';
import type { AdminCatalogDTO, ImportErrorDTO, ImportPreviewDTO, ImportRowAction, ImportRowDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  Banner, Button, Icon, LinkButton, Pill, TextArea, useAnnounce, type PillTone,
} from '../../ui/index.ts';
import { DataTable, FilterChips, type ChipOption, type DataColumn } from '../../ui/admin/index.ts';
import { TAB_HREF, useErrorText, useMenuData } from './model.tsx';

const MAX_CHARS = 2_000_000;
const COLUMNS = [
  'key', 'category_key', 'name_th', 'name_en', 'desc_th', 'desc_en', 'pricing_type', 'price_baht', 'rate_baht',
  'rate_basis_grams', 'variant_key', 'variant_name_th', 'variant_name_en', 'variant_price_baht', 'station',
  'alcohol', 'notes_allowed', 'max_qty', 'image', 'image_alt_th', 'image_alt_en', 'aliases_th', 'aliases_en',
];

type RowFilter = 'all' | 'errors' | 'create' | 'update_draft' | 'skipped';

const ACTION_LOOK: Record<ImportRowAction, { tone: PillTone; icon: 'plus' | 'note' | 'slash' | 'lock' | 'alert' }> = {
  create: { tone: 'ok', icon: 'plus' },
  update_draft: { tone: 'neutral', icon: 'note' },
  skip_published: { tone: 'line', icon: 'slash' },
  skip_archived: { tone: 'line', icon: 'lock' },
  error: { tone: 'alert', icon: 'alert' },
};

export default function ImportTab() {
  const { t, has } = useI18n();
  const data = useMenuData();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const uid = useId().replace(/:/g, '');
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('pasted.csv');
  const [fromFile, setFromFile] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [previewedText, setPreviewedText] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ create: number; update: number } | null>(null);
  const [filter, setFilter] = useState<RowFilter>('all');

  const errorLabel = (code: string) => (has(`catalog.import.err.${code}`) ? t(`catalog.import.err.${code}`) : code.replace(/_/g, ' '));

  const readFile = async (file: File | undefined) => {
    setFileNote(null);
    if (!file) return;
    if (file.size > MAX_CHARS * 2) {
      setFileNote(t('catalog.import.tooBig'));
      return;
    }
    try {
      const text = await file.text();
      if (text.length > MAX_CHARS) { setFileNote(t('catalog.import.tooBig')); return; }
      setCsv(text);
      setFilename(file.name.slice(0, 120) || 'menu.csv');
      setFromFile(true);
      setFileNote(t('catalog.import.loaded', { name: file.name, n: text.split(/\r?\n/).filter((l) => l.trim()).length }));
      setPreview(null);
      setApplied(null);
    } catch {
      setFileNote(t('catalog.import.readFailed'));
    }
  };

  const check = async () => {
    if (checking || !csv.trim()) return;
    setFailure(null);
    setApplied(null);
    setChecking(true);
    try {
      const res = await api.post<ImportPreviewDTO>('/api/staff/menu/import/preview', { filename, csv }, { timeoutMs: 60_000 });
      setPreview(res);
      setPreviewedText(csv);
      setFilter(res.errors.length ? 'errors' : 'all');
      announce(res.summary.can_apply
        ? t('catalog.import.readyAnnounce', { n: res.summary.rows })
        : t('catalog.import.errorsAnnounce', { n: res.summary.errors }));
      requestAnimationFrame(() => previewRef.current?.focus());
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    if (!preview || applying || !preview.summary.can_apply || previewedText !== csv) return;
    setFailure(null);
    setApplying(true);
    try {
      const res = await api.post<AdminCatalogDTO>(`/api/staff/menu/import/${encodeURIComponent(preview.batch_id)}/apply`, {}, { timeoutMs: 60_000 });
      data.putCatalog(res);
      setApplied({ create: preview.summary.create, update: preview.summary.update_draft });
      announce(t('catalog.import.appliedAnnounce', { create: preview.summary.create, update: preview.summary.update_draft }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') {
        const d = err.details as { errors?: ImportErrorDTO[] } | null;
        if (d?.errors?.length) setPreview({ ...preview, errors: d.errors, summary: { ...preview.summary, errors: d.errors.length, can_apply: false } });
      }
      setFailure(errorText(err));
    } finally {
      setApplying(false);
    }
  };

  const clear = () => {
    setCsv('');
    setPreview(null);
    setPreviewedText(null);
    setApplied(null);
    setFailure(null);
    setFileNote(null);
    setFromFile(false);
    setFilename('pasted.csv');
    if (fileRef.current) fileRef.current.value = '';
  };

  const stale = preview !== null && previewedText !== csv;
  const s = preview?.summary;
  const errorRows = new Set(preview?.errors.map((e) => e.row) ?? []);
  const isProblem = (r: ImportRowDTO) => r.action === 'error' || errorRows.has(r.row);
  const problemRows = (preview?.rows ?? []).filter(isProblem).length;
  const rows = (preview?.rows ?? []).filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'errors') return isProblem(r);
    if (filter === 'skipped') return r.action === 'skip_published' || r.action === 'skip_archived';
    return r.action === filter;
  });

  const filterOptions: ChipOption<RowFilter>[] = s ? [
    { value: 'all', label: t('common.all'), count: s.rows },
    { value: 'errors', label: t('catalog.import.fErrors'), count: problemRows },
    { value: 'create', label: t('catalog.import.fCreate'), count: s.create },
    { value: 'update_draft', label: t('catalog.import.fUpdate'), count: s.update_draft },
    { value: 'skipped', label: t('catalog.import.fSkipped'), count: s.skip_published + s.skip_archived },
  ] : [];

  const rowColumns: DataColumn<ImportRowDTO>[] = [
    { key: 'row', header: t('catalog.import.col.row'), numeric: true, width: '64px', cell: (r) => r.row },
    {
      key: 'action', header: t('catalog.import.col.action'), cell: (r) => {
        const look = ACTION_LOOK[r.action] ?? ACTION_LOOK.error;
        return <Pill tone={look.tone} icon={look.icon} size="sm">{t(`catalog.import.action.${r.action}`)}</Pill>;
      },
    },
    { key: 'key', header: t('catalog.import.col.key'), code: true, cell: (r) => <span lang="en">{r.key || '—'}{r.variant_key ? <span className="im-var"> · {r.variant_key}</span> : null}</span> },
    { key: 'category', header: t('catalog.import.col.category'), cell: (r) => <span lang="en">{r.category_key || '—'}</span> },
    {
      key: 'name', header: t('catalog.import.col.name'), wrap: true, cell: (r) => (
        <span className="im-name">
          {r.name.th ? <span lang="th">{r.name.th}</span> : null}
          {r.name.en ? <span lang="en" className="im-name__en">{r.name.en}</span> : null}
          {!r.name.th && !r.name.en ? <span>{t('catalog.unnamed')}</span> : null}
        </span>
      ),
    },
    {
      key: 'message', header: t('catalog.import.col.note'), wrap: true, cell: (r) => (
        r.action === 'skip_published' ? t('catalog.import.skipPublishedNote')
          : r.action === 'skip_archived' ? t('catalog.import.skipArchivedNote')
          : r.message ? <span lang="en">{r.message}</span> : '—'
      ),
    },
  ];

  const errorColumns: DataColumn<ImportErrorDTO>[] = [
    { key: 'row', header: t('catalog.import.col.row'), numeric: true, width: '64px', cell: (e) => e.row || '—' },
    { key: 'column', header: t('catalog.import.col.column'), code: true, cell: (e) => <span lang="en">{e.column ?? '—'}</span> },
    { key: 'code', header: t('catalog.import.col.problem'), wrap: true, cell: (e) => <b>{errorLabel(e.code)}</b> },
    { key: 'message', header: t('catalog.import.col.detail'), wrap: true, cell: (e) => <span lang="en">{e.message}</span> },
  ];

  return (
    <section className="im" aria-labelledby="im-h">
      <h2 id="im-h" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.tab.import')}</h2>
      <div className="mn-pad im__body">
        <Banner variant="info" staff title={t('catalog.import.neverTitle')}>{t('catalog.import.neverBody')}</Banner>

        <div className="im-steps">
          <section className="im-step" aria-labelledby={`${uid}-s1`}>
            <p className="im-step__n" lang="en" aria-hidden="true">01</p>
            <h3 id={`${uid}-s1`}>{t('catalog.import.s1')}</h3>
            <p className="im-step__lede">{t('catalog.import.s1Lede')}</p>
            <div className="im-step__acts">
              <LinkButton href="/api/staff/menu/import-template.csv" external download variant="outline" size="staff" icon="download">
                {t('catalog.import.template')}
              </LinkButton>
              <LinkButton href="/api/staff/menu/export.csv" external download variant="outline" size="staff" icon="download">
                {t('catalog.import.export')}
              </LinkButton>
            </div>
            <details className="im-cols">
              <summary>{t('catalog.import.columns', { n: COLUMNS.length })}</summary>
              <ul>
                {COLUMNS.map((c) => (
                  <li key={c}><code lang="en">{c}</code><span>{t(`catalog.import.colhelp.${c}`)}</span></li>
                ))}
              </ul>
              <p className="field__help">{t('catalog.import.rules')}</p>
            </details>
          </section>

          <section className="im-step" aria-labelledby={`${uid}-s2`}>
            <p className="im-step__n" lang="en" aria-hidden="true">02</p>
            <h3 id={`${uid}-s2`}>{t('catalog.import.s2')}</h3>
            <p className="im-step__lede">{t('catalog.import.s2Lede')}</p>
            <div className="im-step__acts">
              <label className="btn btn--outline btn--staff im-file">
                <Icon name="download" className="im-file__icon" />
                <span>{t('catalog.import.choose')}</span>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="im-file__input" onChange={(e) => void readFile(e.target.files?.[0])} />
              </label>
              {csv ? <Button variant="ghost" size="staff" icon="x" onClick={clear}>{t('catalog.import.clear')}</Button> : null}
            </div>
            {fileNote ? <p className="field__help" role="status">{fileNote}</p> : null}
            <TextArea
              density="staff"
              className="im-paste"
              label={t('catalog.import.paste')}
              optional
              value={csv}
              spellCheck={false}
              onChange={(v) => { setCsv(v); setApplied(null); if (fromFile) { setFromFile(false); setFilename('pasted.csv'); } }}
              help={t('catalog.import.pasteHelp')}
            />
            <Button variant={preview && !stale ? 'outline' : 'primary'} size="staff" icon="check" loading={checking}
              aria-disabled={!csv.trim() || undefined} onClick={() => void check()}>
              {preview && !stale ? t('catalog.import.recheck') : t('catalog.import.check')}
            </Button>
          </section>
        </div>

        {failure ? <p className="field__error" role="alert"><Icon name="alert" size="sm" />{failure}</p> : null}

        {preview && s ? (
          <section className="im-preview" aria-labelledby={`${uid}-s3`}>
            <header className="im-preview__head">
              <p className="im-step__n" lang="en" aria-hidden="true">03</p>
              <h3 id={`${uid}-s3`} ref={previewRef} tabIndex={-1}>{t('catalog.import.s3')}</h3>
              <p className="im-step__lede">{fromFile ? t('catalog.import.s3Lede', { name: filename }) : t('catalog.import.s3Pasted')}</p>
            </header>
            {stale ? <Banner variant="warning" staff>{t('catalog.import.stale')}</Banner> : null}

            <dl className="im-sum">
              {([
                ['rows', s.rows], ['items', s.items], ['variants', s.variants], ['create', s.create],
                ['update_draft', s.update_draft], ['skip_published', s.skip_published], ['skip_archived', s.skip_archived], ['errors', s.errors],
              ] as const).map(([k, v]) => (
                <div key={k} className={k === 'errors' && v > 0 ? 'im-sum__i is-bad' : 'im-sum__i'}>
                  <dt>{t(`catalog.import.sum.${k}`)}</dt>
                  <dd>{num(v)}</dd>
                </div>
              ))}
            </dl>

            {preview.errors.length ? (
              <div className="im-errors">
                <h4><Icon name="alert" size="sm" />{t('catalog.import.errorsTitle', { n: preview.errors.length })}</h4>
                <p className="field__help">{t('catalog.import.errorsHelp')}</p>
                <DataTable
                  columns={errorColumns}
                  rows={preview.errors}
                  rowKey={(e) => `${e.row}-${e.column ?? ''}-${e.code}-${e.message}`}
                  caption={t('catalog.import.errorsTitle', { n: preview.errors.length })}
                  maxHeight={320}
                />
              </div>
            ) : (
              <p className="mn-note mn-note--ok"><Icon name="check-c" size="sm" />{t('catalog.import.noErrors')}</p>
            )}

            <div className="im-rows">
              <FilterChips options={filterOptions} value={filter} onChange={setFilter} label={t('catalog.import.filter')} />
              <DataTable
                columns={rowColumns}
                rows={rows}
                rowKey={(r) => `${r.row}-${r.key}-${r.variant_key ?? ''}`}
                caption={t('catalog.import.rowsCaption')}
                maxHeight={480}
                empty={<p className="dtable__none">{t('catalog.import.noRows')}</p>}
              />
            </div>

            <section className="im-apply" aria-labelledby={`${uid}-s4`}>
              <p className="im-step__n" lang="en" aria-hidden="true">04</p>
              <h3 id={`${uid}-s4`}>{t('catalog.import.s4')}</h3>
              {applied ? (
                <Banner variant="info" staff icon="check-c" title={t('catalog.import.appliedTitle')}
                  action={<LinkButton href={`${TAB_HREF.catalog}?status=draft`} variant="outline" size="staff" iconEnd="chev-r">{t('catalog.import.seeDrafts')}</LinkButton>}>
                  {t('catalog.import.appliedBody', { create: applied.create, update: applied.update })}
                </Banner>
              ) : (
                <>
                  <p className="im-step__lede">
                    {s.can_apply && !stale
                      ? t('catalog.import.applyLede', { create: s.create, update: s.update_draft, skip: s.skip_published + s.skip_archived })
                      : stale ? t('catalog.import.applyStale') : t('catalog.import.applyBlocked', { n: s.errors })}
                  </p>
                  <Button variant="primary" size="staff" icon="check" loading={applying}
                    aria-disabled={!s.can_apply || stale || undefined}
                    disabled={!s.can_apply || stale}
                    onClick={() => void apply()}>
                    {t('catalog.import.apply')}
                  </Button>
                  <p className="field__help">{t('catalog.import.applyNote')}</p>
                </>
              )}
            </section>
          </section>
        ) : null}
      </div>
    </section>
  );
}
