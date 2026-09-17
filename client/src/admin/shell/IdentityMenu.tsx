// Staff identity chip and its account menu (WAI-ARIA menu button pattern).
// On phones, where there is no rail, the menu also carries the alert sound,
// the language and Lock screen.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Locale } from '../../../../shared/settings.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate } from '../../lib/router.ts';
import { Icon, type IconName } from '../../ui/index.ts';
import { StaffChip } from '../../ui/admin/index.ts';
import { useStaff } from './session.tsx';
import type { AlertSound } from './sound.ts';

export interface IdentityMenuProps {
  /** Phone: include sound, language and lock. */
  full: boolean;
  sound: AlertSound;
  onTestSound(): void;
  onLock(): void;
  /** The page this person starts on after signing in, and whether it is the current page. */
  start: { isCurrent: boolean; canSet: boolean; onToggle(): void };
}

type ItemRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';

function MenuItem({ role = 'menuitem', checked, icon, onSelect, children, tone, lang, state }: {
  role?: ItemRole;
  checked?: boolean;
  icon?: IconName;
  onSelect(): void;
  children: ReactNode;
  tone?: 'danger';
  lang?: string;
  /** Visible state word on the right (the checked state is also exposed as aria-checked). */
  state?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      aria-checked={role === 'menuitem' ? undefined : Boolean(checked)}
      className={`acct__item${tone ? ` acct__item--${tone}` : ''}`}
      lang={lang}
      onClick={onSelect}
    >
      <span className="acct__icon" aria-hidden="true">
        {role === 'menuitem' ? (icon ? <Icon name={icon} size="sm" /> : null) : checked ? <Icon name="check" size="sm" bold /> : null}
      </span>
      <span className="acct__label">{children}</span>
      {state ? <span className="acct__state" aria-hidden="true">{state}</span> : null}
    </button>
  );
}

export function IdentityMenu({ full, sound, onTestSound, onLock, start }: IdentityMenuProps) {
  const { t, lang, setLang } = useI18n();
  const { me, logout } = useStaff();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const roleLabel = t(`admin.role.${me.user.role}`);

  const trigger = () => wrap.current?.querySelector<HTMLButtonElement>('button.who') ?? null;
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => trigger()?.focus());
  }, []);

  // Wire the chip (a kit button without a ref) as the menu button.
  useEffect(() => {
    const btn = trigger();
    if (!btn) return;
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-controls', menuId);
  }, [open, menuId]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => items()[0]?.focus());
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  const onTriggerKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (open || (e.target as HTMLElement).getAttribute('role')?.startsWith('menuitem')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (e.key === 'ArrowUp') requestAnimationFrame(() => items().at(-1)?.focus());
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let to = -1;
    if (e.key === 'ArrowDown') to = (at + 1) % list.length;
    else if (e.key === 'ArrowUp') to = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = list.length - 1;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    else if (e.key === 'Tab') { close(false); return; }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const from = at + 1;
      const order = [...list.slice(from), ...list.slice(0, from)];
      const hit = order.find((b) => (b.textContent ?? '').trim().toLowerCase().startsWith(k));
      if (hit) { e.preventDefault(); hit.focus(); }
      return;
    }
    if (to >= 0) { e.preventDefault(); list[to]?.focus(); }
  };

  const run = (fn: () => void, refocus = true) => () => { close(refocus); fn(); };

  const langItem = (l: Locale, label: string) => (
    <MenuItem role="menuitemradio" checked={lang === l} lang={l} onSelect={() => setLang(l)}>{label}</MenuItem>
  );

  return (
    <span className="acct" ref={wrap} onKeyDown={onTriggerKey}>
      <StaffChip
        name={me.user.display_name}
        role={roleLabel}
        onOpen={() => setOpen((v) => !v)}
        menuLabel={t('admin.account.open')}
      />
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={t('admin.account.menu')}
          className="acct__menu"
          onKeyDown={onMenuKey}
        >
          <div className="acct__who" role="presentation">
            <span className="acct__name">{me.user.display_name}</span>
            <span className="acct__meta">
              {roleLabel}
              {' · '}
              <span lang="en">{me.user.username}</span>
            </span>
          </div>
          {full ? (
            <div role="group" aria-label={t('admin.account.device')} className="acct__group">
              <MenuItem
                role="menuitemcheckbox"
                checked={sound.enabled}
                onSelect={() => sound.setEnabled(!sound.enabled)}
                state={sound.enabled ? t('admin.account.on') : t('admin.account.off')}
              >
                {t('admin.account.alerts')}
              </MenuItem>
              <MenuItem icon="sound" onSelect={run(onTestSound)}>{t('common.staff.alertsTestLabel')}</MenuItem>
            </div>
          ) : null}
          {full ? (
            <div role="group" aria-label={t('common.language')} className="acct__group">
              {langItem('th', 'ภาษาไทย')}
              {langItem('en', 'English')}
            </div>
          ) : null}
          {start.canSet ? (
            <div role="group" aria-label={t('admin.account.startGroup')} className="acct__group">
              <MenuItem role="menuitemcheckbox" checked={start.isCurrent} onSelect={start.onToggle}>
                {t('admin.account.startHere')}
              </MenuItem>
            </div>
          ) : null}
          <div role="group" aria-label={t('admin.account.session')} className="acct__group">
            <MenuItem icon="key" onSelect={run(() => navigate('/admin/team?self=1'), false)}>{t('admin.account.password')}</MenuItem>
            {full ? <MenuItem icon="lock" onSelect={run(onLock, false)}>{t('common.staff.lock')}</MenuItem> : null}
            <MenuItem icon="arrow-r" onSelect={run(() => void logout(), false)}>{t('admin.account.signOut')}</MenuItem>
          </div>
        </div>
      ) : null}
    </span>
  );
}
