// Sheet, Dialog, Drawer (DESIGN §10.7, §10.19) on native <dialog>.
//  - showModal(): top layer, inert page behind, ::backdrop scrim
//  - Escape, the backdrop and browser Back close it (one history entry per open)
//  - page scroll is locked; focus returns to the trigger on close
//  - one overlay at a time: confirmations replace a sheet's footer, never stack
// Sheet is a bottom sheet on phones and a centred dialog from 720px.
import {
  forwardRef, useId, useRef, useState,
  type HTMLAttributes, type MouseEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../lib/i18n.tsx';
import { useMedia } from '../lib/store.ts';
import { cx, useIsoLayoutEffect, useLatest } from './cx.ts';
import { useEscape } from './hooks.ts';
import { firstFocusable, useFocusReturn, useHistoryDismiss, useScrollLock } from './overlay.ts';
import { Button, IconButton } from './Button.tsx';
import { ensureModalRegions } from './Toast.tsx';
import { LangSwitch } from './Brand.tsx';
import { TextArea } from './Field.tsx';

export type SheetVariant = 'sheet' | 'dialog' | 'drawer';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Visible title in the head (also the dialog's name). */
  title?: ReactNode;
  /** Kicker shown in the head instead of a title (item sheet: "No. 01 เนื้อ"). Pair with labelledBy. */
  kicker?: ReactNode;
  /** aria-label when there is no visible title. */
  label?: string;
  /** id of a heading inside the body that names the dialog. */
  labelledBy?: string;
  describedBy?: string;
  children?: ReactNode;
  /** Sticky footer (stepper + primary action). */
  footer?: ReactNode;
  footerAlign?: 'fill' | 'end';
  /** sheet (bottom on phones) · dialog (always centred, 480) · drawer (full sheet on phones, right panel from 720) */
  variant?: SheetVariant;
  /** 560 instead of 480 for centred dialogs. */
  wide?: boolean;
  closeLabel?: string;
  hideClose?: boolean;
  /**
   * Guest sheets: a language switch beside the close button. The page behind a
   * modal sheet is inert, and switching language must keep the open sheet.
   */
  langSwitch?: boolean;
  /** false: Escape and the backdrop do nothing (e.g. while an action is pending). Back still closes unless history is false. */
  dismissible?: boolean;
  /** Push a history entry so Back closes it (default true). */
  history?: boolean;
  /** Element to focus on open (default: the browser's first focusable). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Render in the page flow with no modal behaviour (documentation, embedded panels). */
  inline?: boolean;
  /** Replace the whole head. */
  head?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  bodyClassName?: string;
  id?: string;
}

function SheetParts({
  titleId, title, kicker, head, hideClose, closeLabel, onClose, grab, children, footer, footerAlign, bodyClassName, langSwitch,
}: SheetProps & { titleId: string; grab: boolean }) {
  const { t } = useI18n();
  return (
    <>
      {grab ? <div className="sheet__grab" aria-hidden="true" /> : null}
      {head ?? (
        <div className="sheet__head">
          {kicker ? <p className="sheet__kick">{kicker}</p> : title ? <h2 id={titleId}>{title}</h2> : <span />}
          {langSwitch ? (
            <div className="sheet__tools">
              <LangSwitch />
              {hideClose ? null : <IconButton label={closeLabel ?? t('common.close')} icon="x" iconSize="lg" onClick={onClose} data-overlay-close="" />}
            </div>
          ) : hideClose ? null : (
            <IconButton label={closeLabel ?? t('common.close')} icon="x" iconSize="lg" onClick={onClose} data-overlay-close="" />
          )}
        </div>
      )}
      <div className={cx('sheet__body', bodyClassName)}>{children}</div>
      {footer ? <div className={cx('sheet__foot', footerAlign === 'end' && 'sheet__foot--end')}>{footer}</div> : null}
    </>
  );
}

function ModalSheet(props: SheetProps) {
  const { onClose, variant = 'sheet', wide, dismissible = true, history = true, initialFocus, label, labelledBy, describedBy, title, kicker, role, className, id } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useLatest(onClose);
  const downOnBackdrop = useRef(false);

  useFocusReturn(true);
  useScrollLock(true);
  useHistoryDismiss(true, () => close.current(), history);

  useIsoLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      try { d.showModal(); } catch { d.setAttribute('open', ''); }
    }
    // The page behind is inert now: status words spoken while this is open go here.
    ensureModalRegions(d);
    // With a language switch in the head, open on the close button as before
    // rather than on the switch that now comes first.
    const target = initialFocus?.current ?? (props.langSwitch ? d.querySelector<HTMLElement>('[data-overlay-close]') : null);
    if (target) target.focus();
    else if (!d.contains(document.activeElement)) firstFocusable(d)?.focus();
    return () => { if (d.open) d.close(); };
    // open once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBackdropDown = (e: MouseEvent<HTMLDialogElement>) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  };
  const onBackdropClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (!dismissible || !downOnBackdrop.current || e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close.current();
  };

  return (
    <dialog
      ref={ref}
      id={id}
      role={role}
      className={cx('sheet', variant !== 'sheet' && `sheet--${variant}`, wide && 'sheet--wide', className)}
      aria-labelledby={labelledBy ?? (title && !kicker ? titleId : undefined)}
      aria-label={labelledBy || (title && !kicker) ? undefined : label}
      aria-describedby={describedBy}
      aria-modal="true"
      onCancel={(e) => { e.preventDefault(); if (dismissible) close.current(); }}
      onMouseDown={onBackdropDown}
      onClick={onBackdropClick}
    >
      <SheetParts {...props} titleId={titleId} grab={variant === 'sheet'} />
    </dialog>
  );
}

/** Bottom sheet (phones) / centred dialog (720+). Renders nothing while closed. */
export function Sheet(props: SheetProps) {
  const titleId = useId();
  if (props.inline) {
    return (
      <section
        id={props.id}
        className={cx('sheet sheet--inline', props.variant === 'dialog' && 'sheet--dialog', props.className)}
        aria-labelledby={props.labelledBy ?? (props.title && !props.kicker ? titleId : undefined)}
        aria-label={props.labelledBy || (props.title && !props.kicker) ? undefined : props.label}
      >
        <SheetParts {...props} titleId={titleId} grab={false} />
      </section>
    );
  }
  if (!props.open || typeof document === 'undefined') return null;
  return createPortal(<ModalSheet {...props} />, document.body);
}

// ---------------------------------------------------------------- Dialog
export interface DialogReasonField {
  label: ReactNode;
  required?: boolean;
  placeholder?: string;
  limit?: number;
  help?: ReactNode;
  initial?: string;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Body: one honest sentence about what will happen. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  /**
   * Runs the action. The dialog shows a spinner while a returned promise is
   * pending and stays open; close it yourself on success.
   */
  onConfirm: (reason?: string) => void | Promise<unknown>;
  /** danger = danger-solid confirm (revoke, reject, cancel). */
  tone?: 'default' | 'danger';
  /** Ask for a reason (required for destructive or exception actions). */
  reason?: DialogReasonField;
  /** Error from the last attempt (shown above the footer). */
  error?: ReactNode;
  busy?: boolean;
  wide?: boolean;
  /** Staff surfaces use 48px controls. */
  density?: 'guest' | 'staff';
}

/** Confirmation dialog (centred on every size), optionally with a reason field. */
export function Dialog({ open, ...rest }: DialogProps) {
  if (!open) return null;
  return <DialogBody open {...rest} />;
}

function DialogBody({ open, onClose, title, children, confirmLabel, cancelLabel, onConfirm, tone = 'default', reason, error, busy, wide, density }: DialogProps) {
  const { t } = useI18n();
  const [text, setText] = useState(reason?.initial ?? '');
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const descId = useId();
  const size = density === 'staff' ? 'staff' : 'lg';

  const run = async () => {
    if (pending || busy) return;
    const value = text.trim();
    if (reason?.required && !value) {
      setMissing(true);
      reasonRef.current?.focus();
      return;
    }
    const out = onConfirm(reason ? value : undefined);
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      setPending(true);
      try { await out; } catch { /* the caller shows the error */ } finally { setPending(false); }
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      variant="dialog"
      wide={wide}
      title={title}
      role="alertdialog"
      describedBy={children ? descId : undefined}
      initialFocus={reason ? reasonRef : tone === 'danger' ? cancelRef : confirmRef}
      dismissible={!pending}
      footerAlign="end"
      footer={(
        <>
          <Button ref={cancelRef} variant="outline" size={size} onClick={onClose} disabled={pending}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === 'danger' ? 'danger-solid' : 'primary'}
            size={size}
            loading={pending || busy}
            onClick={() => void run()}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {children ? <div className="sheet__lede" id={descId}>{children}</div> : null}
      {reason ? (
        <TextArea
          ref={reasonRef}
          className="sheet__block"
          label={reason.label}
          optional={reason.required ? undefined : true}
          value={text}
          onChange={(v) => { setText(v); if (v.trim()) setMissing(false); }}
          limit={reason.limit}
          placeholder={reason.placeholder}
          help={reason.help}
          density={density}
          required={reason.required}
          error={missing ? t('common.reasonRequired') : undefined}
        />
      ) : null}
      {error ? (
        <p className="field__error sheet__block" role="alert">{error}</p>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Drawer
export interface DrawerProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  open: boolean;
  onClose: () => void;
  /** Title text (20/600). */
  title?: ReactNode;
  /** Meta line under the title. */
  subtitle?: ReactNode;
  /** Leading block in the head (framed table box). */
  lead?: ReactNode;
  /** Pill after the title. */
  status?: ReactNode;
  label?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /**
   * Inline side panel (non-modal, sticky beside the grid) instead of a modal.
   * 'auto' (default): inline from 1200px, modal below.
   */
  inline?: boolean | 'auto';
  closeLabel?: string;
}

/** Table-details drawer: right side panel on desktop, full sheet on phones. Escape closes it. */
export const Drawer = forwardRef<HTMLElement, DrawerProps>(function Drawer(
  { open, onClose, title, subtitle, lead, status, label, children, footer, inline = 'auto', closeLabel, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const wideScreen = useMedia('(min-width: 1200px)');
  const isInline = inline === 'auto' ? wideScreen : inline;
  const titleId = useId();
  const panel = useRef<HTMLElement | null>(null);

  useEscape(open && isInline, onClose);
  useFocusReturn(open && isInline);
  useIsoLayoutEffect(() => {
    if (open && isInline) panel.current?.focus({ preventScroll: true });
  }, [open, isInline]);

  if (!open) return null;

  const head = (
    <div className="drawer__head">
      {lead}
      <div style={{ minWidth: 0 }}>
        {title ? (
          <h2 className="drawer__t" id={titleId}>
            {title}
            {status ? <> {status}</> : null}
          </h2>
        ) : null}
        {subtitle ? <p className="drawer__s">{subtitle}</p> : null}
      </div>
      <IconButton label={closeLabel ?? t('common.close')} icon="x" iconSize="lg" size="staff" onClick={onClose} data-overlay-close="" />
    </div>
  );

  if (isInline) {
    return (
      <aside
        ref={(el) => {
          panel.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        className={cx('drawer', className)}
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        {...rest}
      >
        {head}
        <div className="drawer__body">{children}</div>
        {footer ? <div className="drawer__foot">{footer}</div> : null}
      </aside>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      variant="drawer"
      head={head}
      labelledBy={title ? titleId : undefined}
      label={label}
      className={className}
      bodyClassName="drawer__body"
      footer={footer ? <div className="drawer__foot" style={{ padding: 0, border: 0, width: '100%' }}>{footer}</div> : undefined}
    >
      {children}
    </Sheet>
  );
});
