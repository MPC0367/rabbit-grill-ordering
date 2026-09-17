// Shared pieces for the More area (C7b): error wording, page states, the
// page frame with focus management, and small form helpers built from kit
// primitives. Nothing here re-implements a kit component.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveEvent } from '../../lib/live.tsx';
import type { Locale } from '../../../../shared/settings.ts';
import { businessDate } from '../../../../shared/time.ts';
import { ApiError } from '../../lib/api.ts';
import { clock, dateLabel } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, EmptyState, LinkButton, Skeleton, TextField } from '../../ui/index.ts';
import { PageHeader } from '../../ui/admin/index.ts';
import './more.css';

// ------------------------------------------------------------------ errors
export interface Issue { path: string; message: string; code?: string }

export function issuesOf(err: unknown): Issue[] {
  if (!(err instanceof ApiError) || err.code !== 'validation_failed') return [];
  const d = err.details as { issues?: Issue[] } | null | undefined;
  return Array.isArray(d?.issues) ? d.issues : [];
}

/** Server English messages we know how to say in both languages (matched by path + wording). */
const KNOWN_ISSUES: Array<{ path: RegExp; text?: RegExp; code?: string; key: string }> = [
  { path: /^password$/, text: /does not contain/i, key: 'team.err.passwordName' },
  { path: /^password$/, text: /different from the current/i, key: 'team.err.passwordSame' },
  { path: /^password$/, code: 'too_small', key: 'team.err.passwordShort' },
  { path: /^current_password$/, key: 'team.err.currentWrong' },
  { path: /^username$/, text: /already in use/i, key: 'team.err.usernameTaken' },
  { path: /^username$/, key: 'team.err.usernameFormat' },
  { path: /^display_name$/, key: 'team.err.nameRequired' },
  { path: /^reason$/, key: 'reports.err.reasonRequired' },
  { path: /^ordering\.enforce_hours$/, key: 'settings.err.enforceHours' },
  { path: /^ordering\.weekly_hours/, text: /after opening/i, key: 'settings.err.hoursOrder' },
  { path: /^ordering\.weekly_hours/, text: /overlap/i, key: 'settings.err.hoursOverlap' },
  { path: /^ordering\.weekly_hours/, key: 'settings.err.hoursFormat' },
  { path: /^payment_methods/, text: /at least one/i, key: 'settings.err.oneMethod' },
  { path: /^analytics\.heartbeat_seconds$/, key: 'settings.err.heartbeat' },
  { path: /^checkout\.after_checkout$/, key: 'settings.err.needsClearing' },
  { path: /^charges/, text: /unique id/i, key: 'settings.err.chargeId' },
  { path: /^charges\.\d+\.label/, key: 'settings.err.labelRequired' },
  { path: /^payment_methods\.\d+\.label/, key: 'settings.err.labelRequired' },
  { path: /^role_permissions/, key: 'settings.err.ownerOnly' },
  { path: /\./, code: 'too_small', key: 'settings.err.outOfRange' },
  { path: /\./, code: 'too_big', key: 'settings.err.outOfRange' },
];

export interface ErrorWords { text: string; lang?: string }

export function useErrorWords() {
  const { t, has, lang } = useI18n();
  /** One translated line for any API error. */
  const errorText = (err: unknown): string => {
    const code = err instanceof ApiError ? err.code : 'internal';
    return has(`error.${code}`) ? t(`error.${code}`) : t('error.internal');
  };
  /** A validation issue in the UI language when we know it; otherwise the server's English words. */
  const issueWords = (issue: Issue): ErrorWords => {
    const hit = KNOWN_ISSUES.find((k) => k.path.test(issue.path) && (!k.text || k.text.test(issue.message)) && (!k.code || k.code === issue.code));
    if (hit) return { text: t(hit.key) };
    return { text: issue.message, lang: lang === 'en' ? undefined : 'en' };
  };
  return { errorText, issueWords };
}

// ------------------------------------------------------------------ page frame
/**
 * Page frame under the shell's workspace header (which already carries the
 * "More" title, the subtabs, the demo stamp, the document title and route
 * focus: the shell focuses this page's h1 after a navigation).
 * `index` renders the lede without a second "More" heading.
 */
export function MorePageFrame({
  title, description, actions, children, wide, index,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  index?: boolean;
}) {
  return (
    <div className={wide ? 'mp mp--wide' : 'mp'}>
      {index ? (
        <p className="mp-lede">{description}</p>
      ) : (
        <PageHeader title={title} description={description} actions={actions} />
      )}
      <div className="mp__body">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ states
export function Denied({ what, headingLevel = 2 }: { what: string; headingLevel?: 2 | 3 }) {
  const { t } = useI18n();
  return (
    <EmptyState
      icon="lock"
      headingLevel={headingLevel}
      title={t('more.denied.title', { what })}
      action={<LinkButton href="/admin/more" variant="outline" size="staff" icon="chev-l">{t('more.denied.back')}</LinkButton>}
    >
      {t('more.denied.body')}
    </EmptyState>
  );
}

/** Loading / failed / forbidden for a resource that has no data yet. */
export function ResourceGate({ error, loading, onRetry, what, rows = 3 }: { error: ApiError | null; loading: boolean; onRetry: () => void; what: string; rows?: number }) {
  const { t } = useI18n();
  const { errorText } = useErrorWords();
  if (error?.code === 'forbidden') return <Denied what={what} />;
  if (error && !loading) {
    return (
      <EmptyState
        icon={error.code === 'network_error' || error.code === 'timeout' ? 'wifi-off' : 'alert'}
        headingLevel={2}
        title={t('more.loadFailed', { what })}
        action={<Button variant="outline" size="staff" icon="refresh" onClick={onRetry}>{t('common.retry')}</Button>}
        role="alert"
      >
        {errorText(error)}
      </EmptyState>
    );
  }
  return (
    <div className="mp-skel" role="status" aria-live="polite">
      <span className="sr">{t('common.loading')}</span>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} shape="block" height={i === 0 ? 72 : 120} />)}
    </div>
  );
}

/** Shown above data that could not be refreshed. */
export function StaleBanner({ error, onRetry, busy }: { error: ApiError | null; onRetry: () => void; busy?: boolean }) {
  const { t } = useI18n();
  const { errorText } = useErrorWords();
  if (!error) return null;
  return (
    <Banner
      staff
      className="mp-banner"
      variant={error.code === 'network_error' || error.code === 'timeout' ? 'offline' : 'warning'}
      title={t('more.stale.title')}
      action={<Button variant="outline" size="staff" icon="refresh" loading={busy} onClick={onRetry}>{t('common.retry')}</Button>}
    >
      {errorText(error)}
    </Banner>
  );
}

/** Inline alert under a form: one line per problem. */
export function FormAlert({ lines, id }: { lines: ErrorWords[]; id?: string }) {
  if (lines.length === 0) return null;
  return (
    <div className="mp-alert" role="alert" id={id}>
      {lines.map((l, i) => <p key={i} lang={l.lang}>{l.text}</p>)}
    </div>
  );
}

// ------------------------------------------------------------------ number input
function fmtNumber(v: number | null, decimals: number): string {
  if (v === null || Number.isNaN(v)) return '';
  return decimals > 0 ? String(Number(v.toFixed(decimals))) : String(v);
}

function parseNumber(text: string, decimals: number): number | null {
  const s = text.trim();
  if (s === '') return null;
  const re = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  return re.test(s) ? Number(s) : Number.NaN;
}

export interface NumberFieldProps {
  label: ReactNode;
  value: number | null;
  /** NaN while the text is not a valid number; null when empty. */
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  decimals?: number;
  suffix?: ReactNode;
  prefix?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  id?: string;
  disabled?: boolean;
  hideLabel?: boolean;
  className?: string;
}

/** A staff number box that keeps what is being typed and reports NaN until it parses. */
export function NumberField({ label, value, onChange, min, max, decimals = 0, suffix, prefix, help, error, optional, id, disabled, hideLabel, className }: NumberFieldProps) {
  const [text, setText] = useState(() => fmtNumber(value, decimals));
  useEffect(() => {
    const parsed = parseNumber(text, decimals);
    if (!Object.is(parsed, value) && !(Number.isNaN(value as number) && Number.isNaN(parsed as number))) setText(fmtNumber(value, decimals));
    // sync from outside only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TextField
      id={id}
      className={className}
      density="staff"
      label={label}
      optional={optional}
      hideLabel={hideLabel}
      inputMode={decimals > 0 ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={text}
      disabled={disabled}
      data-min={min}
      data-max={max}
      prefix={prefix}
      suffix={suffix}
      help={help}
      error={error}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNumber(e.target.value, decimals));
      }}
    />
  );
}

/** Range check shared by the settings and team forms. */
export function numberProblem(v: number | null, min: number, max: number, nullable = false): 'empty' | 'range' | null {
  if (v === null) return nullable ? null : 'empty';
  if (Number.isNaN(v) || v < min || v > max) return 'range';
  return null;
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Refetch on live topics. useResource({ topics }) in lib/live.tsx clears its
 * debounce timer whenever the live context re-renders, which every event does,
 * so its topic refetch never fires; this keeps the timer across re-subscribes.
 * Keep `topics` on useResource as well: that part still refetches after a reconnect.
 */
export function useTopicRefresh(prefixes: string[], refresh: () => unknown, debounceMs = 300, maxWaitMs = 30_000) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPending = useRef<number | null>(null);
  const latest = useRef(refresh);
  latest.current = refresh;
  useLiveEvent(prefixes, () => {
    const now = Date.now();
    if (firstPending.current === null) firstPending.current = now;
    if (timer.current) clearTimeout(timer.current);
    // Trailing debounce that still fires within maxWaitMs while events keep coming.
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - (now - firstPending.current)));
    timer.current = setTimeout(() => { timer.current = null; firstPending.current = null; void latest.current(); }, delay);
  });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
}

/** t() with an English singular: uses `<key>.one` when n is 1 and that key exists. */
export function usePlural() {
  const { t, has } = useI18n();
  return (key: string, n: number, vars: Record<string, string | number> = {}) =>
    t(n === 1 && has(`${key}.one`) ? `${key}.one` : key, { n, ...vars });
}

/** lang for free text typed by staff (reasons): Thai when it holds Thai letters. */
export function langOf(text: string | null | undefined): 'th' | 'en' | undefined {
  if (!text) return undefined;
  return /[฀-๿]/.test(text) ? 'th' : 'en';
}

/** "17 Sep 2026, 19:42" in Bangkok time (the year matters in archives and account history). */
export function fullDateTime(iso: string, lang: Locale): string {
  return `${dateLabel(businessDate(iso, 0), lang, { year: true })}, ${clock(iso)}`;
}
