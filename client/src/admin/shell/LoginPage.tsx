// Staff sign-in (brief 18). A charcoal column that echoes the rail beside a
// paper form. Errors never say which part was wrong. The demo usernames are
// listed only while the restaurant runs in demo mode (public config).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { StaffMeDTO } from '../../../../shared/dto.ts';
import { TIMEZONE } from '../../../../shared/time.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useConfig } from '../../lib/config.tsx';
import { dateLabel } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate, useRoute } from '../../lib/router.ts';
import { Button, Icon, LangToggle, TextField, Wordmark } from '../../ui/index.ts';
import { useBusinessToday } from '../insights/query.ts';
import { canOpen, isAdminPath, landingFor } from './routes.tsx';
import { useSessionState } from './session.tsx';
import './shell.css';

const DEMO_ROLES = ['owner', 'manager', 'cashier', 'floor', 'kitchen'] as const;

interface FormError { code: string; retryAfterSeconds?: number | null }

export default function LoginPage() {
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const session = useSessionState();
  const { query } = useRoute();
  // The restaurant's own date (the server's business-day cutoff), not this device's.
  const businessToday = useBusinessToday();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [missing, setMissing] = useState<{ user: boolean; pass: boolean }>({ user: false, pass: false });
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const demoId = useId();

  const next = query.get('next');
  const demo = config?.operating_mode === 'demo';

  useEffect(() => {
    document.title = `${t('login.title')} · ${t('admin.docTitle')}`;
  }, [t]);

  // Start in the username field on tablets and desktops (a shared tablet is signed in to
  // many times a day). Phones wait for a tap so the keyboard does not cover the page.
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) userRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const u = username.trim();
    const gaps = { user: !u, pass: !password };
    setMissing(gaps);
    if (gaps.user) { userRef.current?.focus(); return; }
    if (gaps.pass) { passRef.current?.focus(); return; }
    setPending(true);
    setError(null);
    try {
      const me = await api.post<StaffMeDTO>('/api/staff/auth/login', { username: u, password });
      const canAny = (ps: readonly string[]) => ps.some((p) => me.permissions.includes(p as StaffMeDTO['permissions'][number]));
      const target = next && isAdminPath(next) && canOpen(next, canAny) ? next : landingFor(me.user.id, me.landing, canAny);
      setPassword('');
      session.signIn(me);
      navigate(target, { replace: true });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
      // Too many attempts (from this address or for this account) answers
      // 429 rate_limited with how long to wait; a locked account answers the
      // same way, so nothing here reveals whether a username exists (D-S8-10).
      const retry = (apiErr.details as { retry_after_seconds?: number } | null | undefined)?.retry_after_seconds ?? null;
      setError({ code: apiErr.code, retryAfterSeconds: typeof retry === 'number' && retry > 0 ? retry : null });
      setPending(false);
      // Keep what was typed, select the password so a retry replaces it.
      requestAnimationFrame(() => {
        if (apiErr.code === 'invalid_credentials') {
          passRef.current?.focus();
          passRef.current?.select();
        } else {
          errorRef.current?.focus();
        }
      });
    }
  };

  const errorText = error ? messageFor(error, t) : null;
  const notice = !error && session.reason === 'expired' ? t('login.expired')
    : !error && session.reason === 'locked' ? t('login.locked')
    : !error && session.reason === 'signed-out' ? t('login.signedOut')
    : null;

  return (
    <div className="alogin">
      <a className="skip" href="#login-form">{t('admin.skip')}</a>
      <aside className="alogin__side" data-surface="dark" aria-label={t('login.sideLabel')}>
        <Wordmark variant="staff" className="alogin__mark" label={t('common.staff.home')} />
        <div className="alogin__rule" aria-hidden="true" />
        <p className="alogin__motto" lang={lang}>{t('login.motto')}</p>
        <div className="alogin__foot">
          <p className="alogin__date">
            {dateLabel(businessToday, lang, { weekday: true, year: true })}
            <br />
            <span lang="en">{TIMEZONE}</span>
          </p>
        </div>
      </aside>

      <main id="main" className="alogin__main">
        <div className="alogin__top">
          <Wordmark variant="staff" className="alogin__mark alogin__mark--phone" label={t('common.staff.home')} />
          <LangToggle className="alogin__lang" />
        </div>

        <form id="login-form" className="alogin__card" onSubmit={submit} noValidate aria-labelledby={titleId}>
          <p className="alogin__kicker" lang={lang}>{t('login.kicker')}</p>
          <h1 id={titleId} className="alogin__title">{t('login.title')}</h1>
          <p className="alogin__lede">{t('login.lede')}</p>

          {notice ? <p className="alogin__notice" role="status"><Icon name="info" size="sm" />{notice}</p> : null}

          <div ref={errorRef} tabIndex={-1} className="alogin__error" role="alert" aria-live="assertive">
            {errorText ? (
              <>
                <Icon name="alert" size="sm" />
                <span>{errorText}</span>
              </>
            ) : null}
          </div>

          <TextField
            ref={userRef}
            label={t('login.username')}
            density="staff"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            lang="en"
            value={username}
            onChange={(e) => { setUsername(e.target.value); if (e.target.value.trim()) setMissing((m) => ({ ...m, user: false })); }}
            error={missing.user ? t('login.usernameMissing') : undefined}
            required
          />
          <TextField
            ref={passRef}
            label={t('login.password')}
            density="staff"
            name="password"
            type={reveal ? 'text' : 'password'}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            onChange={(e) => { setPassword(e.target.value); if (e.target.value) setMissing((m) => ({ ...m, pass: false })); }}
            error={missing.pass ? t('login.passwordMissing') : undefined}
            required
            className="alogin__pass"
            suffix={(
              <button
                type="button"
                className="alogin__reveal"
                aria-pressed={reveal}
                aria-label={t('login.showPassword')}
                onClick={() => { setReveal((v) => !v); passRef.current?.focus(); }}
              >
                <span aria-hidden="true">{reveal ? t('login.hide') : t('login.show')}</span>
              </button>
            )}
          />

          <Button type="submit" variant="primary" size="staff" block loading={pending} iconEnd="arrow-r">
            {t('login.submit')}
          </Button>

          <p className="alogin__help">{t('login.help')}</p>

          {demo ? (
            <section className="alogin__demo" id={demoId} aria-labelledby={`${demoId}-t`}>
              <p className="alogin__demo-t" id={`${demoId}-t`}>
                <span className="demo" lang={lang}>{t('common.demoData')}</span>
                {t('login.demoTitle')}
              </p>
              <p className="alogin__demo-b">{t('login.demoBody')}</p>
              <ul className="alogin__demo-list">
                {DEMO_ROLES.map((role) => (
                  <li key={role}>
                    <button
                      type="button"
                      className="alogin__demo-u"
                      onClick={() => {
                        setUsername(`demo-${role}`);
                        setMissing((m) => ({ ...m, user: false }));
                        passRef.current?.focus();
                      }}
                      aria-label={t('login.demoUse', { name: `demo-${role}`, role: t(`admin.role.${role}`) })}
                    >
                      <span lang="en" className="alogin__demo-name">demo-{role}</span>
                      <span className="alogin__demo-role">{t(`admin.role.${role}`)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </form>
      </main>
    </div>
  );
}

function messageFor(error: FormError, t: (k: string, v?: Record<string, string | number>) => string): string {
  switch (error.code) {
    case 'invalid_credentials': return t('login.error.invalid');
    case 'rate_limited': return error.retryAfterSeconds
      ? t('login.error.rateLimitedFor', { minutes: Math.max(1, Math.ceil(error.retryAfterSeconds / 60)) })
      : t('login.error.rateLimited');
    case 'validation_failed': return t('login.error.invalid');
    case 'network_error':
    case 'timeout': return t('login.error.network');
    default: return t(`error.${error.code}`);
  }
}
