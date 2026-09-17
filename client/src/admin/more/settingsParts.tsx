// The settings section frame: each section edits a draft of one or more
// top-level settings keys and saves them on its own (PATCH with only those
// keys). It shows whether the change applies now or to future orders only,
// when it was last saved (or that it is still a proposed default), inline
// validation, a conflict note when another device saved meanwhile, and the
// audit trail link.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Settings } from '../../../../shared/settings.ts';
import { api } from '../../lib/api.ts';
import { dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, Dialog, Tag, TextLink, useAnnounce, useToast } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { FormAlert, issuesOf, same, useErrorWords, type ErrorWords } from './shared.tsx';

export type Key = keyof Settings;

export interface SettingsView {
  settings: Settings;
  updated: Partial<Record<Key, string>>;
  future_only: string[];
}

export interface SettingsCtx {
  view: SettingsView;
  apply: (view: SettingsView) => void;
  setDirty: (id: string, dirty: boolean) => void;
}

export const SettingsContext = createContext<SettingsCtx | null>(null);

export function useSettingsCtx(): SettingsCtx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('settings section outside SettingsContext');
  return ctx;
}

type Picked<K extends Key> = Pick<Settings, K>;

function pick<K extends Key>(s: Settings, keys: readonly K[]): Picked<K> {
  const out = {} as Picked<K>;
  for (const k of keys) out[k] = structuredClone(s[k]);
  return out;
}

export interface DraftApi<K extends Key> {
  draft: Picked<K>;
  base: Picked<K>;
  set: <P extends K>(key: P, value: Settings[P]) => void;
  /** Merge into an object-valued key. */
  merge: <P extends K>(key: P, partial: Partial<Settings[P]>) => void;
  /** Error for a path (exact, or any child path). Marks the error as shown inline. */
  err: (path: string) => ReactNode | undefined;
  saving: boolean;
}

export interface ConfirmSpec {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
}

export interface SettingsSectionProps<K extends Key> {
  id: string;
  keys: readonly K[];
  title: string;
  description?: ReactNode;
  /** Replaces the default "applies now / future orders only" wording. */
  scopeNote?: ReactNode;
  children: (d: DraftApi<K>) => ReactNode;
  /** Client checks before sending: path -> i18n text. */
  validate?: (draft: Picked<K>) => Record<string, string>;
  /** Body sent to PATCH (default: the draft as is). */
  toPatch?: (draft: Picked<K>) => Record<string, unknown>;
  /** Ask before saving (e.g. going live, pausing ordering, permission changes). */
  confirm?: (draft: Picked<K>, base: Picked<K>) => ConfirmSpec | null | Promise<ConfirmSpec | null>;
  /** Extra content under the section footer (read-only notes). */
  after?: ReactNode;
}

export function SettingsSection<K extends Key>({ id, keys, title, description, scopeNote, children, validate, toPatch, confirm, after }: SettingsSectionProps<K>) {
  const { t, lang } = useI18n();
  const { can } = useStaff();
  const ctx = useSettingsCtx();
  const toast = useToast();
  const announce = useAnnounce();
  const { errorText, issueWords } = useErrorWords();
  const headId = useId();
  const box = useRef<HTMLElement>(null);

  const server = pick(ctx.view.settings, keys);
  const [base, setBase] = useState(server);
  const [draft, setDraft] = useState(server);
  const [errors, setErrors] = useState<Record<string, ErrorWords>>({});
  const [general, setGeneral] = useState<ErrorWords[]>([]);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<ConfirmSpec | null>(null);
  const [preparing, setPreparing] = useState(false);
  const dirty = !same(draft, base);
  const moved = !same(server, base);
  if (moved && !dirty && !saving) {
    setBase(server);
    setDraft(server);
  }
  const conflict = moved && dirty;

  const { setDirty } = ctx;
  useEffect(() => { setDirty(id, dirty); }, [setDirty, id, dirty]);
  useEffect(() => () => setDirty(id, false), [setDirty, id]);

  const future = keys.some((k) => ctx.view.future_only.includes(k));
  const savedAt = keys.map((k) => ctx.view.updated[k]).filter((v): v is string => Boolean(v)).sort().pop() ?? null;

  const shown = new Set<string>();
  const api_: DraftApi<K> = {
    draft,
    base,
    saving,
    set: (key, value) => setDraft((d) => ({ ...d, [key]: value })),
    merge: (key, partial) => setDraft((d) => ({ ...d, [key]: { ...(d[key] as object), ...(partial as object) } })),
    err: (path) => {
      const hits = Object.entries(errors).filter(([p]) => p === path || p.startsWith(`${path}.`));
      if (hits.length === 0) return undefined;
      for (const [p] of hits) shown.add(p);
      const w = hits[0][1];
      return <span lang={w.lang}>{w.text}</span>;
    },
  };
  const body = children(api_);
  const unmatched = Object.entries(errors).filter(([p]) => !shown.has(p)).map(([, w]) => w);
  const alertLines = [...(Object.keys(errors).length > unmatched.length ? [{ text: t('settings.fixFields') }] : []), ...unmatched, ...general];

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      const el = box.current?.querySelector<HTMLElement>('[aria-invalid="true"], .mp-alert');
      if (el) {
        el.scrollIntoView({ block: 'center' });
        if (el.matches('input, select, textarea, button')) el.focus({ preventScroll: true });
      }
    });
  };

  const send = async () => {
    setSaving(true);
    setGeneral([]);
    try {
      const view = await api.patch<SettingsView>('/api/staff/settings', toPatch ? toPatch(draft) : draft);
      const fresh = pick(view.settings, keys);
      setBase(fresh);
      setDraft(fresh);
      setErrors({});
      setAsking(null);
      ctx.apply(view);
      toast.show(t('settings.saved', { section: title }));
    } catch (err) {
      const issues = issuesOf(err);
      if (issues.length) {
        const map: Record<string, ErrorWords> = {};
        for (const i of issues) map[i.path] = issueWords(i);
        setErrors(map);
        setAsking(null);
        announce(t('settings.saveFailed', { section: title }), { assertive: true });
        focusFirstError();
      } else if (asking) {
        setGeneral([{ text: errorText(err) }]);
        setAsking(null);
        announce(errorText(err), { assertive: true });
      } else {
        setGeneral([{ text: errorText(err) }]);
        announce(errorText(err), { assertive: true });
      }
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const local = validate ? validate(draft) : {};
    if (Object.keys(local).length) {
      const map: Record<string, ErrorWords> = {};
      for (const [p, text] of Object.entries(local)) map[p] = { text };
      setErrors(map);
      setGeneral([]);
      announce(t('settings.saveFailed', { section: title }), { assertive: true });
      focusFirstError();
      return;
    }
    setErrors({});
    if (confirm) {
      setPreparing(true);
      try {
        const spec = await confirm(draft, base);
        if (spec) { setAsking(spec); return; }
      } catch (err) {
        setGeneral([{ text: errorText(err) }]);
        return;
      } finally {
        setPreparing(false);
      }
    }
    await send();
  };

  const discard = () => {
    setDraft(base);
    setErrors({});
    setGeneral([]);
    announce(t('settings.discarded', { section: title }));
  };

  const reload = () => {
    setBase(server);
    setDraft(server);
    setErrors({});
    setGeneral([]);
  };

  return (
    <section ref={box} id={`set-${id}`} className={dirty ? 'setsec is-dirty' : 'setsec'} aria-labelledby={headId}>
      <header className="setsec__head">
        <div className="setsec__t">
          <h2 id={headId}>{title}</h2>
          <span className="setsec__tags">
            {future
              ? <Tag tone="heat" icon="clock">{t('settings.scope.future')}</Tag>
              : <Tag tone="line" icon="check">{t('settings.scope.now')}</Tag>}
            {!savedAt ? <Tag tone="example">{t('settings.proposed')}</Tag> : null}
          </span>
        </div>
        {description ? <div className="setsec__d">{description}</div> : null}
        <p className="setsec__scope">{scopeNote ?? (future ? t('settings.scope.futureD') : t('settings.scope.nowD'))}</p>
      </header>

      {conflict ? (
        <Banner
          staff
          variant="warning"
          title={t('settings.conflict.title')}
          action={<Button variant="outline" size="staff" onClick={reload}>{t('settings.conflict.load')}</Button>}
        >
          {t('settings.conflict.body')}
        </Banner>
      ) : null}

      <div className="setsec__body">{body}</div>

      <FormAlert lines={alertLines} />

      <footer className="setsec__foot">
        <p className="setsec__meta" aria-live="polite">
          {dirty ? <b className="setsec__unsaved">{t('settings.unsaved')}</b> : savedAt ? t('settings.lastSaved', { at: dateTime(savedAt, lang) }) : t('settings.neverSaved')}
          {can('audit.view') ? (
            <>
              {' · '}
              <TextLink href={`/admin/audit?entity_type=settings&entity_id=${keys[0]}`} icon={null}>{t('settings.auditLink')}</TextLink>
            </>
          ) : null}
        </p>
        <div className="setsec__btns">
          {dirty ? <Button variant="ghost" size="staff" onClick={discard} disabled={saving}>{t('settings.discard')}</Button> : null}
          <Button
            variant={dirty ? 'primary' : 'outline'}
            size="staff"
            disabled={!dirty}
            loading={saving || preparing}
            opensDialog={Boolean(confirm)}
            onClick={() => void save()}
          >
            {t('settings.save')}<span className="sr"> · {title}</span>
          </Button>
        </div>
      </footer>
      {after}

      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking?.title ?? ''}
        confirmLabel={asking?.confirmLabel ?? ''}
        tone={asking?.tone}
        density="staff"
        wide
        busy={saving}
        error={general.length ? general.map((g) => g.text).join(' ') : undefined}
        onConfirm={() => send()}
      >
        {asking?.body}
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------------ small building blocks
export function FieldRow({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={`setrow setrow--${cols}`}>{children}</div>;
}

export function SwitchRow({ children, help }: { children: ReactNode; help?: ReactNode }) {
  return (
    <div className="setswitch">
      {children}
      {help ? <p className="setswitch__help">{help}</p> : null}
    </div>
  );
}

/** Range text for help lines: "10 to 600 seconds". */
export function useRangeHelp() {
  const { t } = useI18n();
  return (min: number, max: number, unit: string) => t('settings.range', { min, max, unit });
}
