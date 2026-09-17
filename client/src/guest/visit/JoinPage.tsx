// /q/:token - arrival from a table QR (brief 07, 30; DECISIONS D-04, D-18, D-19).
// The token only identifies the table; joining the current visit needs the
// staff PIN. There is never a table picker or a typed table number, and
// every state keeps an "ask staff" way out.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { GuestSessionDTO, QrResolveDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate } from '../../lib/router.ts';
import { Button, Card, Icon, Skeleton, TextLink, cx, useToast, type IconName } from '../../ui/index.ts';
import { useGuestSession } from '../shell/session.tsx';
import { detailOf, errorWords, rememberTable, retryAfterSeconds } from './lib.ts';
import { PIN_MIN, PinInput } from './PinInput.tsx';
import './visit.css';

/**
 * The code length for this visit, when the server says it (QrResolveDTO.pin_digits:
 * the length of the visit's actual code, 4 to 8). Unknown: the field takes 4 to 8
 * digits and waits for the Join button.
 */
function pinLengthOf(info: QrResolveDTO | null): number | null {
  const n = (info as (QrResolveDTO & { pin_digits?: number | null }) | null)?.pin_digits;
  return typeof n === 'number' && Number.isInteger(n) && n >= 4 && n <= 8 ? n : null;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'failed'; error: ApiError }
  | { kind: 'ready'; info: QrResolveDTO };

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
}

export default function JoinPage({ token }: { token: string }) {
  const { t, has } = useI18n();
  const { session, mode, setSession } = useGuestSession();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [pin, setPin] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<ApiError | null>(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const autoJoined = useRef(false);
  const msgId = useId();
  const leadId = useId();

  const resolve = useCallback(async () => {
    setPhase({ kind: 'checking' });
    setJoinError(null);
    try {
      const info = await api.post<QrResolveDTO>('/api/public/qr/resolve', { token });
      setPhase({ kind: 'ready', info });
    } catch (err) {
      setPhase({ kind: 'failed', error: asApiError(err) });
    }
  }, [token]);

  useEffect(() => { void resolve(); }, [resolve]);

  // Locked or rate limited: the form waits, then quietly comes back.
  useEffect(() => {
    if (!blockedUntil) return;
    const wait = blockedUntil - Date.now();
    if (wait <= 0) { setBlockedUntil(null); return; }
    const timer = setTimeout(() => {
      setBlockedUntil(null);
      setJoinError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }, Math.min(wait, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [blockedUntil]);

  const info = phase.kind === 'ready' ? phase.info : null;
  const label = info?.table_label ?? null;
  const pinLength = pinLengthOf(info);

  const join = useCallback(async (digits: string | null) => {
    if (joining || !info) return;
    if (info.pin_required && (!digits || digits.length < (pinLengthOf(info) ?? PIN_MIN))) {
      setJoinError(new ApiError('validation_failed', 422, 'pin'));
      inputRef.current?.focus();
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      const s = await api.post<GuestSessionDTO>('/api/public/qr/join', digits ? { token, pin: digits } : { token });
      rememberTable(s.visit.table_label);
      setSession(s);
      if (info.already_joined) toast.show({ message: t('join.backToast', { label: s.visit.table_label }) });
      navigate('/menu', { replace: true });
    } catch (err) {
      const e = asApiError(err);
      switch (e.code) {
        case 'qr_invalid':
        case 'qr_disabled':
          setPhase({ kind: 'failed', error: e });
          return;
        case 'table_disabled':
          setPhase({ kind: 'ready', info: { ...info, state: 'disabled', already_joined: false } });
          return;
        case 'no_open_visit':
          setPhase({ kind: 'ready', info: { ...info, state: 'no_open_visit', already_joined: false } });
          return;
        case 'pin_required':
          if (!info.pin_required) setPhase({ kind: 'ready', info: { ...info, pin_required: true, already_joined: false } });
          break;
        case 'pin_invalid':
          setPin('');
          break;
        case 'pin_locked': {
          const until = detailOf<string>(e, 'until');
          const secs = retryAfterSeconds(e);
          const at = until ? new Date(until).getTime() : secs ? Date.now() + secs * 1000 : null;
          setPin('');
          if (at && Number.isFinite(at)) setBlockedUntil(at);
          break;
        }
        case 'rate_limited': {
          const secs = retryAfterSeconds(e);
          if (secs) setBlockedUntil(Date.now() + secs * 1000);
          break;
        }
        default:
          break;
      }
      setJoinError(e);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setJoining(false);
    }
  }, [joining, info, token, setSession, toast, t]);

  // Already a member of this table's visit: carry straight on.
  useEffect(() => {
    if (!info?.already_joined || autoJoined.current) return;
    autoJoined.current = true;
    void join(null);
  }, [info, join]);

  // Orient screen-reader and keyboard users once the QR is understood.
  const phaseKey = phase.kind === 'ready' ? `${phase.info.state}-${phase.info.pin_required}-${phase.info.already_joined}` : phase.kind;
  useEffect(() => {
    if (phase.kind === 'checking') return;
    const pinForm = phase.kind === 'ready' && phase.info.state === 'ready' && phase.info.pin_required && !phase.info.already_joined;
    if (pinForm) inputRef.current?.focus();
    else headingRef.current?.focus();
    // run when the visible state changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseKey]);

  const stub = (
    <header className="vjoin__stub">
      <p className="vjoin__kick">{t('join.welcomeKicker')}</p>
      {label ? (
        <p className="vjoin__table">
          <span className="visually-hidden">{t('common.table', { label })}</span>
          <span className="vjoin__table-k" aria-hidden="true">{t('join.tableWord')}</span>
          <span className="vjoin__table-n" aria-hidden="true">{label}</span>
        </p>
      ) : null}
    </header>
  );

  const askStaff = (key = 'join.askStaff') => (
    <p className="vjoin__help"><Icon name="hand" /><span>{t(key)}</span></p>
  );

  let body: ReactNode;

  if (phase.kind === 'checking') {
    body = (
      <Card as="section" className="vjoin__card" aria-busy="true">
        <p role="status" className="vjoin__lead">{t('join.checking')}</p>
        <div className="vpin" aria-hidden="true">
          {Array.from({ length: PIN_MIN }, (_, i) => <Skeleton key={i} shape="block" height={68} />)}
        </div>
        <Skeleton shape="block" height={52} />
      </Card>
    );
  } else if (phase.kind === 'failed') {
    const e = phase.error;
    const invalid = e.code === 'qr_invalid';
    const replaced = e.code === 'qr_disabled';
    const title = invalid ? t('join.invalidTitle') : replaced ? t('join.replacedTitle') : t('join.errorTitle');
    const text = invalid ? t('join.invalidBody') : replaced ? t('join.replacedBody') : e.code === 'network_error' || e.code === 'timeout' ? t('join.network') : errorWords(t, has, e);
    body = (
      <StateCard
        icon={invalid || replaced ? 'qr' : 'wifi-off'}
        tone={invalid || replaced ? 'alert' : undefined}
        title={title}
        headingRef={headingRef}
        action={invalid || replaced ? null : <Button variant="primary" size="lg" block icon="refresh" onClick={() => void resolve()}>{t('join.retry')}</Button>}
      >
        <p>{text}</p>
        {askStaff()}
      </StateCard>
    );
  } else if (info && info.already_joined) {
    body = (
      <StateCard
        icon="check-c"
        tone="ok"
        title={t('join.continueTitle', { label: info.table_label })}
        headingRef={headingRef}
        action={(
          <Button variant="primary" size="lg" block loading={joining} onClick={() => void join(null)}>
            {t('join.continue', { label: info.table_label })}
          </Button>
        )}
      >
        <p>{t('join.continueBody')}</p>
        {joinError ? <JoinMessage id={msgId} error={joinError} blockedUntil={blockedUntil} pinLength={pinLength} /> : null}
      </StateCard>
    );
  } else if (info && info.state === 'disabled') {
    body = (
      <StateCard icon="lock" title={t('join.disabledTitle', { label: info.table_label })} headingRef={headingRef}>
        <p>{t('join.disabledBody')}</p>
        {askStaff()}
      </StateCard>
    );
  } else if (info && info.state === 'no_open_visit') {
    body = (
      <StateCard
        icon="seat"
        title={t('join.notOpenTitle', { label: info.table_label })}
        headingRef={headingRef}
        action={<Button variant="primary" size="lg" block icon="refresh" onClick={() => void resolve()}>{t('join.retry')}</Button>}
      >
        <p>{t('join.notOpenBody')}</p>
        {askStaff('join.notOpenAsk')}
      </StateCard>
    );
  } else if (info && !info.pin_required) {
    body = (
      <StateCard
        icon="cutlery"
        title={t('join.openTitle', { label: info.table_label })}
        headingRef={headingRef}
        action={(
          <Button variant="primary" size="lg" block loading={joining} onClick={() => void join(null)}>
            {t('join.submit', { label: info.table_label })}
          </Button>
        )}
      >
        <p>{t('join.openBody')}</p>
        {joinError ? <JoinMessage id={msgId} error={joinError} blockedUntil={blockedUntil} pinLength={pinLength} /> : null}
        {askStaff()}
      </StateCard>
    );
  } else {
    const blocked = blockedUntil !== null && blockedUntil > Date.now();
    const switching = mode === 'joined' && session && info && session.visit.table_label !== info.table_label;
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (!blocked) void join(pin);
    };
    body = (
      <Card as="section" className="vjoin__card" aria-labelledby={`${leadId}-t`}>
        <div>
          <h1 id={`${leadId}-t`} ref={headingRef} tabIndex={-1}>{t('join.pinTitle')}</h1>
          <p className="vjoin__lead" id={leadId}>{pinLength ? t('join.pinLead', { n: pinLength }) : t('join.pinLeadAny')}</p>
        </div>
        {switching ? (
          <p className="vnote">
            <Icon name="info" />
            <span className="vnote__body">{t('join.switchNote', { from: session!.visit.table_label, to: info!.table_label })}</span>
          </p>
        ) : null}
        <form onSubmit={submit} noValidate className="vjoin__actions">
          <PinInput
            ref={inputRef}
            value={pin}
            onChange={(v) => { setPin(v); if (joinError && joinError.code !== 'pin_locked' && joinError.code !== 'rate_limited') setJoinError(null); }}
            onComplete={(v) => { if (!blocked) void join(v); }}
            length={pinLength}
            label={pinLength ? t('join.pinLabel', { n: pinLength }) : t('join.pinLabelAny')}
            describedBy={`${leadId} ${msgId}`}
            error={Boolean(joinError) && !blocked}
            disabled={blocked || joining}
          />
          <div id={msgId} aria-live="polite" className="vjoin__msg">
            {joinError ? <JoinMessage error={joinError} blockedUntil={blockedUntil} pinLength={pinLength} /> : null}
          </div>
          <Button type="submit" variant="primary" size="lg" block loading={joining} disabled={blocked}>
            {t('join.submit', { label: info!.table_label })}
          </Button>
        </form>
        {askStaff('join.noPin')}
      </Card>
    );
  }

  const showBrowse = phase.kind !== 'checking' && !(info?.already_joined);
  return (
    <main className="g-main">
      <div className="vjoin">
        {stub}
        {body}
        {showBrowse ? (
          <div className="vjoin__links">
            <TextLink href="/menu">{info && info.state === 'no_open_visit' ? t('join.browse') : t('join.browseFirst')}</TextLink>
          </div>
        ) : null}
        {info && info.state === 'no_open_visit' ? <p className="support vjoin__center">{t('join.meanwhile')}</p> : null}
        {info && info.state === 'ready' && !info.already_joined ? <p className="meta vjoin__center">{t('join.privacy')}</p> : null}
      </div>
    </main>
  );
}

function StateCard({
  icon, tone, title, headingRef, action, children,
}: {
  icon: IconName;
  tone?: 'alert' | 'ok';
  title: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <Card as="section" className="vjoin__card" aria-labelledby={id}>
      <div className="vjoin__state">
        <span className={cx('vjoin__mark', tone && `vjoin__mark--${tone}`)} aria-hidden="true"><Icon name={icon} /></span>
        <h1 id={id} ref={headingRef} tabIndex={-1}>{title}</h1>
        {children}
      </div>
      {action ? <div className="vjoin__actions">{action}</div> : null}
    </Card>
  );
}

function JoinMessage({ error, blockedUntil, id, pinLength }: { error: ApiError; blockedUntil: number | null; id?: string; pinLength: number | null }) {
  const { t, has } = useI18n();
  const format = pinLength ? t('join.pinFormat', { n: pinLength }) : t('join.pinFormatAny');
  let main: string;
  let sub: string | null = null;
  switch (error.code) {
    case 'pin_invalid': {
      main = t('join.pinWrong');
      const left = detailOf<number>(error, 'attempts_left');
      if (typeof left === 'number' && left > 0) sub = left === 1 ? t('join.attemptsLeftOne') : t('join.attemptsLeft', { n: left });
      break;
    }
    case 'pin_locked':
      main = t('join.lockedTitle');
      sub = blockedUntil ? t('join.lockedBody', { time: clock(new Date(blockedUntil).toISOString()) }) : t('join.lockedBodyNoTime');
      break;
    case 'rate_limited': {
      const secs = retryAfterSeconds(error);
      main = secs ? t('join.rateLimited', { n: secs }) : t('error.rate_limited');
      break;
    }
    case 'pin_required':
      main = detailOf<string>(error, 'reason') === 'no_pin_set' ? t('join.noPinSet') : format;
      break;
    case 'validation_failed':
      main = format;
      break;
    case 'network_error':
    case 'timeout':
      main = t('join.network');
      break;
    default:
      main = errorWords(t, has, error);
  }
  return (
    <p className={cx('vjoin__error')} id={id}>
      <Icon name={error.code === 'pin_locked' ? 'lock' : 'alert'} />
      <span>
        {main}
        {sub ? <small>{sub}</small> : null}
      </span>
    </p>
  );
}
