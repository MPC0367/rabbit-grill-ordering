// Manage one staff account (team.manage): name, role and active state with
// version conflicts and last-owner protection, a password reset, and
// "sign out everywhere". Confirmations replace the section's own footer
// (one overlay at a time, DESIGN.md §10.7).
import { useState } from 'react';
import type { StaffUserDTO } from '../../../../shared/dto.ts';
import type { Role } from '../../../../shared/permissions.ts';
import { ApiError, api } from '../../lib/api.ts';
import { dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Checkbox, IconButton, KeyValue, Sheet, Switch, Tag, TextField, useToast } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { FormAlert, issuesOf, useErrorWords, usePlural, type ErrorWords } from './shared.tsx';
import { initialsOf, passwordProblem, PASSWORD_MIN, RolePicker } from './teamParts.tsx';

export interface StaffEditorProps {
  user: StaffUserDTO;
  isSelf: boolean;
  onClose: () => void;
  onChanged: (u: StaffUserDTO) => void;
  onRefresh: () => Promise<void>;
}

export default function StaffEditor({ user, isSelf, onClose, onChanged, onRefresh }: StaffEditorProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const staff = useStaff();
  const { errorText, issueWords } = useErrorWords();
  const plural = usePlural();

  // ---- details
  const [base, setBase] = useState(user);
  const [name, setName] = useState(user.display_name);
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [saving, setSaving] = useState(false);
  const [detailErrors, setDetailErrors] = useState<Record<string, ErrorWords>>({});
  const [detailAlert, setDetailAlert] = useState<ErrorWords[]>([]);
  const [conflict, setConflict] = useState(false);
  const dirty = name.trim() !== base.display_name || role !== base.role || active !== base.active;
  const accessChange = role !== base.role || (base.active && !active);

  // If the list refreshes with a newer version while nothing is typed, follow it.
  if (user.version !== base.version && !dirty && !saving) {
    setBase(user);
    setName(user.display_name);
    setRole(user.role);
    setActive(user.active);
  }

  const saveDetails = async () => {
    setDetailAlert([]);
    setDetailErrors({});
    if (!name.trim()) { setDetailErrors({ display_name: { text: t('team.err.nameRequired') } }); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { version: base.version };
      if (name.trim() !== base.display_name) body.display_name = name.trim();
      if (role !== base.role) body.role = role;
      if (active !== base.active) body.active = active;
      const next = await api.patch<StaffUserDTO>(`/api/staff/team/${user.id}`, body);
      setBase(next);
      setName(next.display_name);
      setRole(next.role);
      setActive(next.active);
      setConflict(false);
      onChanged(next);
      toast.show(t('team.edit.saved', { name: next.display_name }));
      if (isSelf && accessChange) void staff.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version') {
        const current = (err.details as { current?: StaffUserDTO } | null)?.current;
        if (current) {
          setBase(current);
          setName(current.display_name);
          setRole(current.role);
          setActive(current.active);
          onChanged(current);
        } else {
          void onRefresh();
        }
        setConflict(true);
      } else if (err instanceof ApiError && err.code === 'last_owner') {
        setDetailAlert([{ text: t('error.last_owner') }, { text: t('team.edit.lastOwnerHelp') }]);
      } else {
        const issues = issuesOf(err);
        if (issues.length) {
          const fe: Record<string, ErrorWords> = {};
          const rest: ErrorWords[] = [];
          for (const i of issues) {
            if (i.path === 'display_name') fe.display_name = issueWords(i);
            else rest.push(issueWords(i));
          }
          setDetailErrors(fe);
          setDetailAlert(rest);
        } else {
          setDetailAlert([{ text: errorText(err) }]);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // ---- password reset
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErrors, setPwErrors] = useState<Record<string, ErrorWords>>({});
  const [pwAlert, setPwAlert] = useState<ErrorWords[]>([]);
  const setPassword = async () => {
    const e: Record<string, ErrorWords> = {};
    const p = passwordProblem(pw, base);
    if (p) e.password = { text: t(p) };
    else if (pw !== pw2) e.again = { text: t('team.err.mismatch') };
    setPwErrors(e);
    setPwAlert([]);
    if (Object.keys(e).length) return;
    setPwBusy(true);
    try {
      // Resetting your own password here still needs the current one: use the form at the bottom of the page.
      await api.post(`/api/staff/team/${user.id}/password`, { password: pw });
      setPw(''); setPw2('');
      toast.show(t('team.pw.doneOther', { name: base.display_name }));
      void onRefresh();
    } catch (err) {
      const issues = issuesOf(err);
      if (issues.length) setPwErrors({ password: issueWords(issues[0]) });
      else setPwAlert([{ text: errorText(err) }]);
    } finally {
      setPwBusy(false);
    }
  };

  // ---- sessions
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeAlert, setRevokeAlert] = useState<ErrorWords[]>([]);
  const revoke = async () => {
    setRevokeBusy(true);
    setRevokeAlert([]);
    try {
      const r = await api.post<{ ok: true; revoked?: number }>(`/api/staff/team/${user.id}/revoke-sessions`);
      setConfirmRevoke(false);
      toast.show(plural('team.sessions.done', r.revoked ?? 0, { name: base.display_name }));
      if (isSelf) void staff.refresh();
    } catch (err) {
      setRevokeAlert([{ text: errorText(err) }]);
    } finally {
      setRevokeBusy(false);
    }
  };

  const busy = saving || pwBusy || revokeBusy;

  return (
    <Sheet
      open
      onClose={() => { if (!busy) onClose(); }}
      variant="drawer"
      dismissible={!busy}
      head={(
        <div className="drawer__head">
          <span className="avatar" aria-hidden="true">{initialsOf(base.display_name)}</span>
          <div style={{ minWidth: 0 }}>
            <h2 className="drawer__t" id="staff-edit-h">
              {base.display_name}
              {isSelf ? <span className="team-you"> · {t('team.you')}</span> : null}
            </h2>
            <p className="drawer__s">
              {t(`team.role.${base.role}`)} · {base.active ? t('team.active') : t('team.inactive')}
              {base.is_fixture ? <> · <Tag tone="example">{t('common.demoData')}</Tag></> : null}
            </p>
          </div>
          <IconButton label={t('common.close')} icon="x" iconSize="lg" size="staff" onClick={onClose} disabled={busy} data-overlay-close="" />
        </div>
      )}
      labelledBy="staff-edit-h"
      bodyClassName="drawer__body staff-edit"
    >
      <KeyValue
        items={[
          { key: 'u', term: t('team.f.username'), value: <span lang="en">{base.username}</span> },
          { key: 'c', term: t('team.edit.created'), value: dateTime(base.created_at, lang) },
          { key: 'l', term: t('team.col.last'), value: base.last_login_at ? dateTime(base.last_login_at, lang) : t('team.never'), muted: !base.last_login_at },
        ]}
      />

      <section className="dsec staff-edit__sec" aria-labelledby="staff-edit-details">
        <h3 className="staff-edit__h" id="staff-edit-details">{t('team.edit.details')}</h3>
        {conflict ? (
          <p className="mp-warn" role="status">{t('team.edit.conflict')}</p>
        ) : null}
        <TextField
          density="staff"
          label={t('team.f.name')}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          error={detailErrors.display_name ? <span lang={detailErrors.display_name.lang}>{detailErrors.display_name.text}</span> : undefined}
        />
        <RolePicker value={role} onChange={setRole} name={`role-${user.id}`} />
        <div className="staff-edit__switch">
          <Switch
            density="staff"
            checked={active}
            onChange={setActive}
            label={t('team.edit.activeLabel')}
            onLabel={t('team.active')}
            offLabel={t('team.inactive')}
          />
          <p className="mp-meta">{active ? t('team.edit.activeHelp') : t('team.edit.inactiveHelp')}</p>
        </div>
        {dirty && accessChange ? (
          <p className="mp-warn">{isSelf ? t('team.edit.selfSignout') : t('team.edit.signout', { name: base.display_name })}</p>
        ) : null}
        <FormAlert lines={detailAlert} />
        <div className="staff-edit__foot">
          <Button variant="ghost" size="staff" disabled={!dirty || saving} onClick={() => { setName(base.display_name); setRole(base.role); setActive(base.active); setDetailAlert([]); setDetailErrors({}); }}>
            {t('settings.discard')}
          </Button>
          <Button variant={dirty ? 'primary' : 'outline'} size="staff" loading={saving} disabled={!dirty} onClick={() => void saveDetails()}>
            {t('team.edit.save')}
          </Button>
        </div>
      </section>

      <section className="dsec staff-edit__sec" aria-labelledby="staff-edit-pw">
        <h3 className="staff-edit__h" id="staff-edit-pw">{t('team.pw.title')}</h3>
        {isSelf ? (
          <p className="mp-meta">{t('team.pw.selfHere')}</p>
        ) : (
          <form className="mp-form" noValidate onSubmit={(e) => { e.preventDefault(); void setPassword(); }}>
            <p className="mp-meta">{t('team.pw.otherLede', { name: base.display_name })}</p>
            <input type="text" name="username" autoComplete="off" value={base.username} readOnly hidden />
            <TextField
              density="staff"
              type={showPw ? 'text' : 'password'}
              label={t('team.pw.new')}
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              help={t('team.pw.rule', { n: PASSWORD_MIN })}
              error={pwErrors.password ? <span lang={pwErrors.password.lang}>{pwErrors.password.text}</span> : undefined}
            />
            <TextField
              density="staff"
              type={showPw ? 'text' : 'password'}
              label={t('team.pw.again')}
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              error={pwErrors.again?.text}
            />
            <Checkbox label={t('team.pw.show')} checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />
            <FormAlert lines={pwAlert} />
            <div className="staff-edit__foot">
              <Button type="submit" variant="outline" size="staff" icon="key" loading={pwBusy} disabled={!pw}>{t('team.pw.submit')}</Button>
            </div>
          </form>
        )}
      </section>

      <section className="dsec staff-edit__sec" aria-labelledby="staff-edit-sessions">
        <h3 className="staff-edit__h" id="staff-edit-sessions">{t('team.sessions.title')}</h3>
        <p className="mp-meta">{isSelf ? t('team.sessions.selfLede') : t('team.sessions.lede', { name: base.display_name })}</p>
        {confirmRevoke ? (
          <div className="mp-confirm" role="group" aria-labelledby="staff-edit-revoke-q">
            <p id="staff-edit-revoke-q"><b>{t('team.sessions.confirmQ', { name: base.display_name })}</b></p>
            <FormAlert lines={revokeAlert} />
            <div className="staff-edit__foot">
              <Button variant="outline" size="staff" onClick={() => setConfirmRevoke(false)} disabled={revokeBusy}>{t('common.cancel')}</Button>
              <Button variant="danger-solid" size="staff" loading={revokeBusy} onClick={() => void revoke()} autoFocus>{t('team.sessions.confirm')}</Button>
            </div>
          </div>
        ) : (
          <div className="staff-edit__foot">
            <Button variant="danger" size="staff" icon="lock" onClick={() => setConfirmRevoke(true)}>{t('team.sessions.action')}</Button>
          </div>
        )}
      </section>
    </Sheet>
  );
}
