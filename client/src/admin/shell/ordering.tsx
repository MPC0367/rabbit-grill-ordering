// Restaurant-wide guest ordering (brief 25, DESIGN §10.30 "Pause control").
// Pausing is never one tap: Pause… and Resume… open a dialog. The paused
// state is shown to every role; only ordering.pause can change it.
import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OverviewDTO, StaffOrderingDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLiveResource } from './live-resource.ts';
import {
  Banner, Button, Checkbox, OrderingControl, SegmentedControl, Sheet, TextArea, TextField, useToast,
} from '../../ui/index.ts';
import { useAttention } from './attention.tsx';
import { useStaff } from './session.tsx';

type Ordering = OverviewDTO['ordering'];

interface OrderingActions {
  /** Current restaurant-wide state (undefined while loading). */
  ordering: Ordering | undefined;
  paused: boolean;
  canChange: boolean;
  /** "by Nok 19:40" when the audit log is readable, else null. */
  pausedDetail: string | null;
  pausedBy: { name: string | null; at: string } | null;
  busy: boolean;
  openPause(): void;
  openResume(): void;
}

const OrderingContext = createContext<OrderingActions | null>(null);

interface AuditList { entries: Array<{ at: string; actor_label: string | null; reason: string | null }> }

const WAIT_PRESETS = [15, 30, 45, 60] as const;
const MESSAGE_LIMIT = 300;
const REASON_LIMIT = 200;

function issuePaths(err: ApiError): string[] {
  const d = err.details as { issues?: Array<{ path?: string }> } | null | undefined;
  return (d?.issues ?? []).map((i) => i.path ?? '').filter(Boolean);
}

export function OrderingProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { can } = useStaff();
  const toast = useToast();
  const attention = useAttention();
  const ordering = attention.data?.ordering;
  const paused = ordering ? !ordering.enabled : false;
  const canChange = can('ordering.pause');
  const [dialog, setDialog] = useState<'pause' | 'resume' | null>(null);
  const [busy, setBusy] = useState(false);

  // Who paused, from the audit log (owner and manager by default). Others just see "Paused".
  const audit = useLiveResource<AuditList>(
    paused && can('audit.view') ? '/api/staff/audit?action=ordering.paused&limit=1' : null,
    { topics: ['ordering.'] },
  );
  const last = audit.data?.entries[0];
  const pausedBy = paused && last ? { name: last.actor_label, at: last.at } : null;
  const pausedDetail = pausedBy?.name ? t('common.staff.pausedBy', { name: pausedBy.name, time: clock(pausedBy.at) }) : null;

  const apply = useCallback(async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const next = await api.patch<StaffOrderingDTO>('/api/staff/ordering', body);
      if (attention.data) {
        attention.mutate((prev) => ({
          ...(prev ?? attention.data!),
          ordering: {
            enabled: next.enabled,
            paused_message: next.paused_message,
            estimated_wait_minutes: next.estimated_wait_minutes,
            within_hours: next.within_hours,
          },
        }));
      }
      void attention.refresh();
      setDialog(null);
      toast.show({ message: done, tone: 'ok' });
    } finally {
      setBusy(false);
    }
  }, [attention, toast]);

  const value = useMemo<OrderingActions>(() => ({
    ordering,
    paused,
    canChange,
    pausedDetail,
    pausedBy,
    busy,
    openPause: () => { if (canChange) setDialog('pause'); },
    openResume: () => { if (canChange) setDialog('resume'); },
  }), [ordering, paused, canChange, pausedDetail, pausedBy?.name, pausedBy?.at, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <OrderingContext.Provider value={value}>
      {children}
      {dialog === 'pause' && ordering ? (
        <PauseSheet
          ordering={ordering}
          onClose={() => setDialog(null)}
          onSubmit={(body) => apply(body, t('admin.pause.done'))}
        />
      ) : null}
      {dialog === 'resume' && ordering ? (
        <ResumeSheet
          ordering={ordering}
          onClose={() => setDialog(null)}
          onSubmit={(body) => apply(body, t('admin.resume.done'))}
        />
      ) : null}
    </OrderingContext.Provider>
  );
}

export function useOrderingActions(): OrderingActions {
  const ctx = useContext(OrderingContext);
  if (!ctx) throw new Error('useOrderingActions outside OrderingProvider');
  return ctx;
}

// ---------------------------------------------------------------- header control and banner
/** The joined "Guest ordering ✓ Open | Pause…" control for the workspace header. */
export function HeaderOrderingControl() {
  const o = useOrderingActions();
  if (!o.ordering) return null;
  return (
    <OrderingControl
      paused={o.paused}
      pausedDetail={o.pausedDetail ?? undefined}
      onPause={o.canChange ? o.openPause : undefined}
      onResume={o.canChange ? o.openResume : undefined}
      busy={o.busy}
    />
  );
}

/** Ink band under the header on every staff page while guest ordering is paused. */
export function PausedBanner({ withAction = true }: { withAction?: boolean }) {
  const { t, pick, lang } = useI18n();
  const o = useOrderingActions();
  if (!o.ordering || !o.paused) return null;
  const message = pick(o.ordering.paused_message);
  const wait = o.ordering.estimated_wait_minutes;
  return (
    <Banner
      variant="paused"
      staff
      className="ashell__paused"
      title={t('admin.paused.title')}
      action={o.canChange && withAction ? (
        <Button variant="outline" size="staff" opensDialog onClick={o.openResume} loading={o.busy}>
          {t('common.staff.resume')}
        </Button>
      ) : undefined}
    >
      {o.pausedDetail ? <span className="ashell__paused-by">{o.pausedDetail}</span> : null}
      {o.pausedDetail ? ' · ' : null}
      {message.text ? (
        <span>
          {t('admin.paused.guestsSee')}{' '}
          <q lang={message.lang}>{message.text}</q>
        </span>
      ) : null}
      {wait ? <span lang={lang}>{' · '}{t('admin.paused.wait', { n: wait })}</span> : null}
    </Banner>
  );
}

// ---------------------------------------------------------------- dialogs
interface SheetProps {
  ordering: Ordering;
  onClose(): void;
  onSubmit(body: Record<string, unknown>): Promise<void>;
}

function useSubmitError() {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const fail = useCallback((err: unknown) => {
    const e = err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
    setFields(e.code === 'validation_failed' ? issuePaths(e) : []);
    setError(t(`error.${e.code}`));
  }, [t]);
  const clear = useCallback(() => { setError(null); setFields([]); }, []);
  return { error, fields, fail, clear };
}

function PauseSheet({ ordering, onClose, onSubmit }: SheetProps) {
  const { t } = useI18n();
  const [th, setTh] = useState(ordering.paused_message.th ?? '');
  const [en, setEn] = useState(ordering.paused_message.en ?? '');
  const current = ordering.estimated_wait_minutes;
  const [wait, setWait] = useState<string>(current ? String(current) : 'none');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [missing, setMissing] = useState<{ th: boolean; en: boolean }>({ th: false, en: false });
  const { error, fields, fail, clear } = useSubmitError();
  const thRef = useRef<HTMLTextAreaElement>(null);
  const enRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const waitLabel = useId();
  const ledeId = useId();

  const waitOptions = useMemo(() => {
    const values: string[] = ['none', ...WAIT_PRESETS.map(String)];
    if (current && !values.includes(String(current))) values.push(String(current));
    return values.map((v) => ({
      value: v,
      label: v === 'none' ? t('admin.pause.waitNone') : t('admin.pause.waitMinutes', { n: v }),
    }));
  }, [current, t]);

  const submit = async () => {
    if (pending) return;
    clear();
    const next = { th: !th.trim(), en: !en.trim() };
    setMissing(next);
    if (next.th) { thRef.current?.focus(); return; }
    if (next.en) { enRef.current?.focus(); return; }
    setPending(true);
    try {
      await onSubmit({
        enabled: false,
        paused_message_th: th.trim(),
        paused_message_en: en.trim(),
        estimated_wait_minutes: wait === 'none' ? null : Number(wait),
        reason: reason.trim() || null,
      });
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };

  const thError = missing.th || fields.includes('paused_message_th') ? t('admin.pause.messageRequired') : undefined;
  const enError = missing.en || fields.includes('paused_message_en') ? t('admin.pause.messageRequired') : undefined;

  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      wide
      title={t('admin.pause.title')}
      describedBy={ledeId}
      dismissible={!pending}
      initialFocus={confirmRef}
      className="opause"
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={pending}>{t('admin.pause.keepOpen')}</Button>
          <Button ref={confirmRef} variant="primary" size="staff" icon="pause" loading={pending} onClick={() => void submit()}>
            {t('admin.pause.confirm')}
          </Button>
        </>
      )}
    >
      <p className="sheet__lede" id={ledeId}>{t('admin.pause.lede')}</p>
      <div className="opause__fields">
        <TextArea
          ref={thRef}
          label={t('admin.pause.messageTh')}
          value={th}
          onChange={(v) => { setTh(v); if (v.trim()) setMissing((m) => ({ ...m, th: false })); }}
          limit={MESSAGE_LIMIT}
          density="staff"
          lang="th"
          rows={3}
          required
          error={thError}
        />
        <TextArea
          ref={enRef}
          label={t('admin.pause.messageEn')}
          value={en}
          onChange={(v) => { setEn(v); if (v.trim()) setMissing((m) => ({ ...m, en: false })); }}
          limit={MESSAGE_LIMIT}
          density="staff"
          lang="en"
          rows={3}
          required
          error={enError}
          help={t('admin.pause.messageHelp')}
        />
        <div className="opause__wait">
          <p className="field__label" id={waitLabel} aria-hidden="true">{t('admin.pause.wait')}</p>
          <SegmentedControl
            label={t('admin.pause.wait')}
            tone="paper"
            size="staff"
            value={wait}
            onChange={setWait}
            options={waitOptions}
          />
          <p className="field__help">{t('admin.pause.waitHelp')}</p>
        </div>
        <TextField
          label={t('admin.pause.reason')}
          optional
          density="staff"
          value={reason}
          maxLength={REASON_LIMIT}
          onChange={(e) => setReason(e.target.value)}
          help={t('admin.pause.reasonHelp')}
        />
      </div>
      {error ? <p className="field__error sheet__block" role="alert">{error}</p> : null}
    </Sheet>
  );
}

function ResumeSheet({ ordering, onClose, onSubmit }: SheetProps) {
  const { t } = useI18n();
  const wait = ordering.estimated_wait_minutes;
  const [clearWait, setClearWait] = useState(true);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const { error, fail, clear } = useSubmitError();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const ledeId = useId();

  const submit = async () => {
    if (pending) return;
    clear();
    setPending(true);
    try {
      await onSubmit({
        enabled: true,
        ...(wait && clearWait ? { estimated_wait_minutes: null } : {}),
        reason: reason.trim() || null,
      });
    } catch (err) {
      fail(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={t('admin.resume.title')}
      describedBy={ledeId}
      dismissible={!pending}
      initialFocus={confirmRef}
      className="opause"
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={pending}>{t('admin.resume.keepPaused')}</Button>
          <Button ref={confirmRef} variant="primary" size="staff" icon="check" loading={pending} onClick={() => void submit()}>
            {t('admin.resume.confirm')}
          </Button>
        </>
      )}
    >
      <p className="sheet__lede" id={ledeId}>{t('admin.resume.lede')}</p>
      <div className="opause__fields">
        {wait ? (
          <Checkbox
            label={t('admin.resume.clearWait', { n: wait })}
            description={t('admin.resume.clearWaitHelp')}
            checked={clearWait}
            onChange={(e) => setClearWait(e.target.checked)}
          />
        ) : null}
        <TextField
          label={t('admin.pause.reason')}
          optional
          density="staff"
          value={reason}
          maxLength={REASON_LIMIT}
          onChange={(e) => setReason(e.target.value)}
          help={t('admin.pause.reasonHelp')}
        />
      </div>
      {error ? <p className="field__error sheet__block" role="alert">{error}</p> : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------- staff ordering detail
/** GET /api/staff/ordering: backlog, intake limit and oldest unaccepted round (Overview page). */
export function useStaffOrdering() {
  return useLiveResource<StaffOrderingDTO>('/api/staff/ordering', { topics: ['ordering.', 'order.', 'line.'], debounceMs: 250 });
}

