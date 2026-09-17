// Owner review and allergens (C6, brief 04 + 11 + 21). Only menu.review can
// change these; everyone else sees them read-only. Unknown allergen data is
// always stated as unknown and never reads as allergen-free.
import { useState } from 'react';
import type { AdminItemDTO, AllergenState } from '../../../../shared/dto.ts';
import type { ReviewStatus } from '../../../../shared/status.ts';
import { api, ApiError } from '../../lib/api.ts';
import { dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  Banner, Button, ChoiceGroup, Icon, IconButton, RadioCard, Select, Tag, TextArea, TextField, useToast,
} from '../../ui/index.ts';
import { KeyValue } from '../../ui/admin/index.ts';
import { useErrorText, useMenuData } from './model.tsx';
import { ReviewPill, useNameText } from './parts.tsx';

interface Entry { uid: string; allergen: string; state: AllergenState; note: string }
let seq = 0;
const entryOf = (e: AdminItemDTO['allergens']['entries'][number]): Entry => ({ uid: `a${++seq}`, allergen: e.allergen, state: e.state, note: e.note ?? '' });
const sameEntries = (a: Entry[], b: Entry[]) => a.length === b.length && a.every((x, i) => x.allergen.trim() === b[i].allergen.trim() && x.state === b[i].state && x.note.trim() === b[i].note.trim());

export default function ReviewPanel({ item, canReview, blockedReason }: {
  item: AdminItemDTO;
  canReview: boolean;
  /** Set while the main form has unsaved edits: a review would make them stale. */
  blockedReason: string | null;
}) {
  const { t, lang } = useI18n();
  const data = useMenuData();
  const errorText = useErrorText();
  const nameText = useNameText();
  const toast = useToast();
  const [status, setStatus] = useState<ReviewStatus>(item.review_status);
  const [notes, setNotes] = useState(item.review_notes ?? '');
  const [allergenStatus, setAllergenStatus] = useState(item.allergens.status);
  const [entries, setEntries] = useState<Entry[]>(() => item.allergens.entries.map(entryOf));
  /** The saved item these fields were loaded from (its version is sent with the review). */
  const [synced, setSynced] = useState<AdminItemDTO>(item);
  const [failure, setFailure] = useState<string | null>(null);
  const [entryErrors, setEntryErrors] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  const allergensChanged = allergenStatus !== synced.allergens.status || !sameEntries(entries, synced.allergens.entries.map(entryOf));
  const dirty = status !== synced.review_status || notes.trim() !== (synced.review_notes ?? '') || allergensChanged;
  const loadFrom = (it: AdminItemDTO) => {
    setStatus(it.review_status);
    setNotes(it.review_notes ?? '');
    setAllergenStatus(it.allergens.status);
    setEntries(it.allergens.entries.map(entryOf));
    setEntryErrors({});
    setSynced(it);
  };
  // Follow the saved item while nothing is being edited here; keep edits otherwise.
  if (item !== synced && item.version !== synced.version && !dirty) loadFrom(item);

  if (!canReview) {
    return (
      <div className="rv">
        <KeyValue
          items={[
            { term: t('catalog.review.state'), value: <ReviewPill status={item.review_status} /> },
            { term: t('catalog.review.by'), value: item.reviewer ?? t('catalog.review.nobody'), muted: !item.reviewer },
            { term: t('catalog.review.at'), value: item.approved_at ? dateTime(item.approved_at, lang) : '—', muted: !item.approved_at },
            { term: t('catalog.allergen.state'), value: t(`catalog.allergen.${item.allergens.status}`) },
          ]}
        />
        <AllergenList item={item} />
        <p className="mn-note"><Icon name="lock" size="sm" />{t('catalog.review.ownerOnly')}</p>
      </div>
    );
  }

  const save = async () => {
    if (saving || blockedReason) return;
    setFailure(null);
    const errs: Record<number, string> = {};
    const seen = new Set<string>();
    entries.forEach((e, i) => {
      const k = e.allergen.trim().toLowerCase();
      if (!k) errs[i] = t('catalog.allergen.nameNeeded');
      else if (seen.has(k)) errs[i] = t('catalog.allergen.twice');
      seen.add(k);
    });
    setEntryErrors(errs);
    if (Object.keys(errs).length) { setFailure(t('catalog.editor.fixFields')); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { review_status: status, notes: notes.trim() || null, version: synced.version };
      if (allergensChanged) {
        body.allergens = {
          status: allergenStatus,
          entries: entries.map((e) => ({ allergen: e.allergen.trim(), state: e.state, note: e.note.trim() || null })),
        };
      }
      const res = await api.post<AdminItemDTO>(`/api/staff/menu/items/${encodeURIComponent(item.id)}/review`, body);
      data.putItem(res);
      loadFrom(res);
      toast.show({ message: t('catalog.review.saved', { name: nameText(res.name) }) });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version') {
        const current = (err.details as { current?: AdminItemDTO } | null)?.current;
        if (current) { data.putItem(current); setSynced(current); }
        setFailure(t('catalog.review.stale'));
      } else {
        setFailure(errorText(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    loadFrom(item);
    setFailure(null);
  };

  const setEntry = (i: number, patch: Partial<Entry>) => {
    setEntries((list) => list.map((e, j) => (j === i ? { ...e, ...patch } : e)));
    setEntryErrors((x) => { const { [i]: _, ...rest } = x; return rest; });
  };

  return (
    <div className="rv">
      {item.reviewer ? (
        <p className="field__help">{item.approved_at ? t('catalog.review.last', { name: item.reviewer, time: dateTime(item.approved_at, lang) }) : t('catalog.review.lastBy', { name: item.reviewer })}</p>
      ) : null}
      <ChoiceGroup legend={t('catalog.review.state')} rule={t('catalog.review.stateRule')}>
        {(['verified', 'needs_review', 'unverified'] as const).map((s) => (
          <RadioCard key={s} name={`rv-${item.id}`} value={s} checked={status === s} onChange={() => setStatus(s)}
            label={t(`catalog.review.${s}`)} description={t(`catalog.review.${s}Help`)} />
        ))}
      </ChoiceGroup>
      <TextArea density="staff" label={t('catalog.review.notes')} optional value={notes} limit={1000} onChange={setNotes} help={t('catalog.review.notesHelp')} />

      <ChoiceGroup legend={t('catalog.allergen.title')} rule={t('catalog.allergen.rule')}>
        {(['unknown', 'verified'] as const).map((s) => (
          <RadioCard key={s} name={`al-${item.id}`} value={s} checked={allergenStatus === s} onChange={() => setAllergenStatus(s)}
            label={t(`catalog.allergen.${s}`)} description={t(`catalog.allergen.${s}Help`)} />
        ))}
      </ChoiceGroup>
      {allergenStatus === 'verified' && entries.length === 0 ? (
        <Banner variant="warning" staff>{t('catalog.allergen.verifiedEmpty')}</Banner>
      ) : null}

      <ol className="rv-entries">
        {entries.map((e, i) => (
          <li key={e.uid} className="rv-entry">
            <TextField density="staff" label={t('catalog.allergen.name')} value={e.allergen} maxLength={40} error={entryErrors[i]}
              onChange={(ev) => setEntry(i, { allergen: ev.target.value })} />
            <Select density="staff" label={t('catalog.allergen.how')} value={e.state} onChange={(ev) => setEntry(i, { state: ev.target.value as AllergenState })}
              options={[{ value: 'contains', label: t('common.allergy.contains') }, { value: 'may_contain', label: t('common.allergy.mayContain') }]} />
            <TextField density="staff" label={t('catalog.allergen.note')} optional value={e.note} maxLength={120} onChange={(ev) => setEntry(i, { note: ev.target.value })} />
            <IconButton icon="x" variant="framed" size="staff" label={t('catalog.allergen.remove', { name: e.allergen || String(i + 1) })}
              onClick={() => setEntries((list) => list.filter((_, j) => j !== i))} />
          </li>
        ))}
      </ol>
      <Button variant="outline" size="staff" icon="plus" iconBold disabled={entries.length >= 20}
        onClick={() => setEntries((list) => [...list, { uid: `a${++seq}`, allergen: '', state: 'contains', note: '' }])}>
        {t('catalog.allergen.add')}
      </Button>
      <p className="field__help">{t('catalog.allergen.help')}</p>

      {failure ? <p className="field__error" role="alert">{failure}</p> : null}
      {blockedReason && dirty ? <p className="mn-note"><Icon name="info" size="sm" />{blockedReason}</p> : null}
      <div className="rv-acts">
        {dirty ? <Button variant="ghost" size="staff" onClick={reset} disabled={saving}>{t('catalog.editor.discard')}</Button> : null}
        <Button variant="secondary" size="staff" icon="check" loading={saving} disabled={!dirty || Boolean(blockedReason)} onClick={() => void save()}>
          {t('catalog.review.save')}
        </Button>
      </div>
    </div>
  );
}

function AllergenList({ item }: { item: AdminItemDTO }) {
  const { t } = useI18n();
  if (!item.allergens.entries.length) {
    return <p className="field__help">{item.allergens.status === 'verified' ? t('catalog.allergen.noneListed') : t('catalog.allergen.unknownNote')}</p>;
  }
  return (
    <p className="rv-tags">
      {item.allergens.entries.map((e) => (
        <Tag key={e.allergen} tone={e.state === 'contains' ? 'alert' : 'heat'}>
          {e.allergen} · {e.state === 'contains' ? t('common.allergy.contains') : t('common.allergy.mayContain')}
        </Tag>
      ))}
    </p>
  );
}
