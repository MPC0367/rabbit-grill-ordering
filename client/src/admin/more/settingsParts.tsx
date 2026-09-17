// The settings section frame: each section edits a draft of one or more
// top-level settings keys and saves them on its own (PATCH with only those
// keys). It shows whether the change applies now or to future orders only,
// when it was last saved (or that it is still a proposed default), inline
// validation, a conflict note when another device saved meanwhile, and the
// audit trail link.
//
// Version check (admin-ops finding 12): every save sends
// `expected_updated`, a map of each key the section edits to the
// `updated[key]` time its draft started from (null = never saved). The
// server answers 409 `stale_version` with `details.current` (the full
// SettingsView) when any of those keys was saved since, and changes nothing.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Settings } from '../../../../shared/settings.ts';
import { api, ApiError } from '../../lib/api.ts';
import { dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, Dialog, Tag, TextLink, useAnnounce, useToast } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { FormAlert, issuesOf, same, useErrorWords, type ErrorWords } from './shared.tsx';

export type Key = keyof Settings;

/** What the daily clean-up task last did (D-S8-02). */
export interface RetentionStatus {
  last_run_at: string | null;
  raw_events_purged_through: string | null;
}

export interface SettingsView {
  settings: Settings;
  updated: Partial<Record<Key, string>>;
  future_only: string[];
  retention_status?: RetentionStatus;
}

/** Reserved PATCH field: key -> the `updated` time the draft was based on (null = never saved). */
export const EXPECTED_UPDATED = 'expected_updated';

export type Stamps = Partial<Record<Key, string | null>>;

export function stampsOf(updated: SettingsView['updated'], keys: readonly Key[]): Stamps {
  const out: Stamps = {};
  for (const k of keys) out[k] = updated[k] ?? null;
  return out;
}

const isSettingsView = (v: unknown): v is SettingsView =>
  Boolean(v) && typeof v === 'object' && typeof (v as SettingsView).settings === 'object' && typeof (v as SettingsView).updated === 'object';

/** PATCH the settings with the version check (D-S8-26). */
function patchSettings(patch: Record<string, unknown>, stamps: Stamps): Promise<SettingsView> {
  return api.patch<SettingsView>('/api/staff/settings', { ...patch, [EXPECTED_UPDATED]: stamps });
}

export interface SettingsCtx {
  view: SettingsView;
  apply: (view: SettingsView) => void;
  /** Re-read the settings (after a conflict answer without the current view). */
  refresh: () => unknown;
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
  /** Reserved fields sent with the patch when this dialog is confirmed (e.g. deactivate_demo_staff). */
  extra?: Record<string, unknown>;
  /** A refusal this dialog can answer: the replacement dialog, or null for the usual error. */
  retry?: (err: ApiError) => ConfirmSpec | null;
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
  /** This section's own words for a refusal the generic error line cannot explain. */
  refusal?: (err: ApiError) => string | null;
  /** Extra content under the section footer (read-only notes). */
  after?: ReactNode;
}

export function SettingsSection<K extends Key>({ id, keys, title, description, scopeNote, children, validate, toPatch, confirm, refusal, after }: SettingsSectionProps<K>) {
  const { t, lang } = useI18n();
  const { can } = useStaff();
  const ctx = useSettingsCtx();
  const toast = useToast();
  const announce = useAnnounce();
  const { errorText, issueWords } = useErrorWords();
  const headId = useId();
  const box = useRef<HTMLElement>(null);

  const server = pick(ctx.view.settings, keys);
  const serverStamps = stampsOf(ctx.view.updated, keys);
  const [base, setBase] = useState(server);
  const [baseStamps, setBaseStamps] = useState(serverStamps);
  const [draft, setDraft] = useState(server);
  const [errors, setErrors] = useState<Record<string, ErrorWords>>({});
  const [general, setGeneral] = useState<ErrorWords[]>([]);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<ConfirmSpec | null>(null);
  const [preparing, setPreparing] = useState(false);
  const dirty = !same(draft, base);
  // A save elsewhere moves the stamp even when it stored the same values.
  const moved = !same(server, base) || !same(serverStamps, baseStamps);
  if (moved && !dirty && !saving) {
    setBase(server);
    setBaseStamps(serverStamps);
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
    const payload: Record<string, unknown> = { ...(toPatch ? toPatch(draft) : draft), ...asking?.extra };
    try {
      const view = await patchSettings(payload, baseStamps);
      const fresh = pick(view.settings, keys);
      setBase(fresh);
      setBaseStamps(stampsOf(view.updated, keys));
      setDraft(fresh);
      setErrors({});
      setAsking(null);
      ctx.apply(view);
      toast.show(t('settings.saved', { section: title }));
    } catch (err) {
      const issues = issuesOf(err);
      const again = asking?.retry && err instanceof ApiError ? asking.retry(err) : null;
      if (err instanceof ApiError && err.code === 'stale_version') {
        // Someone saved these keys meanwhile: nothing was changed. Show their
        // version beside this draft (the conflict banner) and let the person decide.
        const current = (err.details as { current?: unknown } | null | undefined)?.current;
        if (isSettingsView(current)) ctx.apply(current); else void ctx.refresh();
        setAsking(null);
        setGeneral([{ text: t('settings.conflict.refused') }]);
        announce(t('settings.conflict.refused'), { assertive: true });
        focusFirstError();
      } else if (again) {
        // The dialog stays open with what the answer asks for (e.g. the demo accounts to switch off).
        setAsking(again);
        announce(again.title, { assertive: true });
      } else if (issues.length) {
        const map: Record<string, ErrorWords> = {};
        for (const i of issues) map[i.path] = issueWords(i);
        setErrors(map);
        setAsking(null);
        announce(t('settings.saveFailed', { section: title }), { assertive: true });
        focusFirstError();
      } else {
        // A refusal this section can say better than the generic error line.
        const words = (err instanceof ApiError ? refusal?.(err) : null) ?? errorText(err);
        setGeneral([{ text: words }]);
        if (asking) setAsking(null);
        announce(words, { assertive: true });
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
    setBaseStamps(serverStamps);
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
