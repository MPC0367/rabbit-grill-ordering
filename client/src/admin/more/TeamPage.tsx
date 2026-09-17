// /admin/team (team.manage): staff accounts, roles, passwords, sessions,
// last-owner protection and the first-admin note. /admin/team?self=1 is the
// self-service password change any signed-in staff member can reach.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { StaffUserDTO } from '../../../../shared/dto.ts';
import { ROLES, type Role } from '../../../../shared/permissions.ts';
import { api } from '../../lib/api.ts';
import { dateTime } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import { useMedia } from '../../lib/store.ts';
import { useRoute } from '../../lib/router.ts';
import {
  Banner, Button, Checkbox, DataTable, EmptyState, Pill, SectionHeader, Sheet, Tag, TextField, useToast,
  prefersReducedMotion, type SortState,
} from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import StaffEditor from './StaffEditor.tsx';
import { PASSWORD_MIN, passwordProblem, RolePicker } from './teamParts.tsx';
import { FormAlert, issuesOf, MorePageFrame, ResourceGate, StaleBanner, useErrorWords, type ErrorWords } from './shared.tsx';

// ------------------------------------------------------------------ self password
function SelfPassword({ highlight, primary }: { highlight: boolean; primary: boolean }) {
  const { t } = useI18n();
  const { me } = useStaff();
  const toast = useToast();
  const { errorText, issueWords } = useErrorWords();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, ErrorWords>>({});
  const [general, setGeneral] = useState<ErrorWords[]>([]);
  const currentRef = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!highlight) return;
    const el = box.current;
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    currentRef.current?.focus({ preventScroll: true });
  }, [highlight]);

  const submit = async () => {
    const e: Record<string, ErrorWords> = {};
    if (!current) e.current = { text: t('team.err.currentMissing') };
    const p = passwordProblem(next, me.user);
    if (p) e.password = { text: t(p) };
    else if (next === current) e.password = { text: t('team.err.passwordSame') };
    if (!e.password && again !== next) e.again = { text: t('team.err.mismatch') };
    setErrors(e);
    setGeneral([]);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.post(`/api/staff/team/${me.user.id}/password`, { password: next, current_password: current });
      setCurrent(''); setNext(''); setAgain('');
      toast.show(t('team.self.done'));
    } catch (err) {
      const issues = issuesOf(err);
      if (issues.length) {
        const fe: Record<string, ErrorWords> = {};
        for (const i of issues) fe[i.path === 'current_password' ? 'current' : 'password'] = issueWords(i);
        setErrors(fe);
        if (fe.current) currentRef.current?.focus();
      } else {
        setGeneral([{ text: errorText(err) }]);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={box} className={highlight ? 'mp-panel team-self is-target' : 'mp-panel team-self'} id="self" aria-labelledby="team-self-h">
      <SectionHeader level={2} titleId="team-self-h" title={t('team.self.title')} description={t('team.self.lede', { name: me.user.display_name })} />
      <form
        className="mp-form"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        noValidate
      >
        <input type="text" name="username" autoComplete="username" value={me.user.username} readOnly hidden />
        <TextField
          ref={currentRef}
          density="staff"
          type={show ? 'text' : 'password'}
          label={t('team.self.current')}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current ? <span lang={errors.current.lang}>{errors.current.text}</span> : undefined}
        />
        <div className="mp-form__pair">
          <TextField
            density="staff"
            type={show ? 'text' : 'password'}
            label={t('team.self.new')}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            help={t('team.pw.rule', { n: PASSWORD_MIN })}
            error={errors.password ? <span lang={errors.password.lang}>{errors.password.text}</span> : undefined}
          />
          <TextField
            density="staff"
            type={show ? 'text' : 'password'}
            label={t('team.self.again')}
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            error={errors.again?.text}
          />
        </div>
        <Checkbox label={t('team.pw.show')} checked={show} onChange={(e) => setShow(e.target.checked)} />
        <FormAlert lines={general} />
        <div className="mp-form__foot">
          <p className="mp-meta">{t('team.self.note')}</p>
          <Button type="submit" variant={primary ? 'primary' : 'secondary'} size="staff" icon="key" loading={busy}>{t('team.self.submit')}</Button>
        </div>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ create
function CreateStaff({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (u: StaffUserDTO) => void }) {
  const { t } = useI18n();
  const { errorText, issueWords } = useErrorWords();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('floor');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, ErrorWords>>({});
  const [general, setGeneral] = useState<ErrorWords[]>([]);
  const first = useRef<HTMLInputElement>(null);

  const reset = () => { setUsername(''); setName(''); setRole('floor'); setPassword(''); setShow(false); setErrors({}); setGeneral([]); };

  const submit = async () => {
    const e: Record<string, ErrorWords> = {};
    const u = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) e.username = { text: t('team.err.usernameFormat') };
    if (!name.trim()) e.display_name = { text: t('team.err.nameRequired') };
    const p = passwordProblem(password, { username: u, display_name: name.trim() });
    if (p) e.password = { text: t(p) };
    setErrors(e);
    setGeneral([]);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const created = await api.post<StaffUserDTO>('/api/staff/team', { username: u, display_name: name.trim(), role, password });
      reset();
      onCreated(created);
    } catch (err) {
      const issues = issuesOf(err);
      if (issues.length) {
        const fe: Record<string, ErrorWords> = {};
        const rest: ErrorWords[] = [];
        for (const i of issues) {
          if (['username', 'display_name', 'password'].includes(i.path)) fe[i.path] = issueWords(i);
          else rest.push(issueWords(i));
        }
        setErrors(fe);
        setGeneral(rest);
      } else {
        setGeneral([{ text: errorText(err) }]);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => { if (!busy) { reset(); onClose(); } }}
      variant="dialog"
      wide
      title={t('team.add.title')}
      initialFocus={first}
      dismissible={!busy}
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={() => { reset(); onClose(); }} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" size="staff" icon="plus" loading={busy} type="submit" form="team-add-form">{t('team.add.submit')}</Button>
        </>
      )}
    >
      <form id="team-add-form" className="mp-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="sheet__lede">{t('team.add.lede')}</p>
        <div className="mp-form__pair">
          <TextField
            ref={first}
            density="staff"
            label={t('team.f.name')}
            value={name}
            maxLength={60}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            help={t('team.f.nameHelp')}
            error={errors.display_name ? <span lang={errors.display_name.lang}>{errors.display_name.text}</span> : undefined}
          />
          <TextField
            density="staff"
            label={t('team.f.username')}
            value={username}
            maxLength={32}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            lang="en"
            onChange={(e) => setUsername(e.target.value)}
            help={t('team.f.usernameHelp')}
            error={errors.username ? <span lang={errors.username.lang}>{errors.username.text}</span> : undefined}
          />
        </div>
        <RolePicker value={role} onChange={setRole} name="team-add-role" />
        <TextField
          density="staff"
          type={show ? 'text' : 'password'}
          label={t('team.f.password')}
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          help={t('team.pw.ruleNew', { n: PASSWORD_MIN })}
          error={errors.password ? <span lang={errors.password.lang}>{errors.password.text}</span> : undefined}
        />
        <Checkbox label={t('team.pw.show')} checked={show} onChange={(e) => setShow(e.target.checked)} />
        <FormAlert lines={general} />
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ list
function StatusCell({ u }: { u: StaffUserDTO }) {
  const { t } = useI18n();
  return (
    <span className="team-status">
      {u.active ? <Pill tone="ok" icon="check" size="sm">{t('team.active')}</Pill> : <Pill tone="neutral" icon="slash" size="sm">{t('team.inactive')}</Pill>}
      {u.is_fixture ? <Tag tone="example">{t('common.demoData')}</Tag> : null}
    </span>
  );
}

export default function TeamPage() {
  const { t, lang } = useI18n();
  const { me, can } = useStaff();
  const toast = useToast();
  const { query } = useRoute();
  const self = query.get('self') === '1';
  const manage = can('team.manage');
  const phone = useMedia('(max-width: 719px)');
  const res = useResource<{ users: StaffUserDTO[] }>(manage ? '/api/staff/team' : null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  const users = res.data?.users;
  const sorted = useMemo(() => {
    if (!users || !sort) return users ?? [];
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (u: StaffUserDTO) => (sort.key === 'name' ? u.display_name.toLowerCase() : sort.key === 'role' ? String(ROLES.indexOf(u.role)) : u.last_login_at ?? '');
    return [...users].sort((a, b) => dir * val(a).localeCompare(val(b)));
  }, [users, sort]);
  const activeCount = users?.filter((u) => u.active).length ?? 0;
  const demoActive = users?.some((u) => u.active && u.is_fixture) ?? false;
  const editingUser = users?.find((u) => u.id === editing) ?? null;
  const ownerCount = users?.filter((u) => u.active && u.role === 'owner').length ?? 0;

  const openEditor = (u: StaffUserDTO, el: HTMLElement) => { trigger.current = el; setEditing(u.id); };
  const lastSeen = (u: StaffUserDTO) => (u.last_login_at ? dateTime(u.last_login_at, lang) : t('team.never'));

  if (!manage) {
    return (
      <MorePageFrame title={t('team.self.pageTitle')} description={t('team.self.pageLede')}>
        <SelfPassword highlight={false} primary />
      </MorePageFrame>
    );
  }

  return (
    <MorePageFrame
      title={t('team.title')}
      description={t('team.lede')}
      actions={<Button variant="primary" size="staff" icon="plus" opensDialog onClick={() => setAdding(true)}>{t('team.add')}</Button>}
    >
      {demoActive ? (
        <Banner staff className="mp-banner" variant="demo" title={t('team.demoBanner.title')}>{t('team.demoBanner.body')}</Banner>
      ) : null}
      <StaleBanner error={users ? res.error : null} onRetry={() => void res.refresh()} busy={res.loading} />

      <section aria-labelledby="team-list-h" className="team-list">
        <SectionHeader
          titleId="team-list-h"
          title={t('team.list.title')}
          description={users ? t('team.list.count', { active: activeCount, inactive: users.length - activeCount }) : undefined}
        />
        {!users ? (
          <ResourceGate error={res.error} loading={res.loading} onRetry={() => void res.refresh()} what={t('team.list.title')} />
        ) : users.length === 0 ? (
          <EmptyState icon="user" headingLevel={3} title={t('team.list.empty')} action={<Button variant="outline" size="staff" icon="plus" onClick={() => setAdding(true)}>{t('team.add')}</Button>} />
        ) : phone ? (
          <ul className="team-cards">
            {users.map((u) => (
              <li key={u.id} className={u.active ? 'team-card' : 'team-card is-inactive'}>
                <div className="team-card__main">
                  <p className="team-card__n">
                    {u.display_name}
                    {u.id === me.user.id ? <> <Tag tone="ink">{t('team.you')}</Tag></> : null}
                  </p>
                  <p className="team-card__u" lang="en">{u.username}</p>
                  <p className="team-card__r">{t(`team.role.${u.role}`)}</p>
                  <StatusCell u={u} />
                  <p className="mp-meta">{u.last_login_at ? t('team.lastSeen', { at: lastSeen(u) }) : t('team.never')}</p>
                </div>
                <Button variant="outline" size="staff" opensDialog onClick={(e) => openEditor(u, e.currentTarget)}>
                  {t('team.manage')}<span className="sr"> {u.display_name}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <DataTable<StaffUserDTO>
            caption={t('team.list.title')}
            rows={sorted}
            rowKey={(u) => u.id}
            selectedKey={editing}
            sort={sort}
            onSort={(key) => setSort(sort?.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}
            columns={[
              {
                key: 'name', header: t('team.col.name'), sortable: true, wrap: true,
                cell: (u) => (
                  <span className="team-name">
                    <span className="team-name__n">
                      <b>{u.display_name}</b>
                      {u.id === me.user.id ? <Tag tone="ink">{t('team.you')}</Tag> : null}
                    </span>
                    <span className="team-name__u" lang="en">{u.username}</span>
                  </span>
                ),
              },
              { key: 'role', header: t('team.col.role'), sortable: true, cell: (u) => t(`team.role.${u.role}`) },
              { key: 'status', header: t('team.col.status'), cell: (u) => <StatusCell u={u} /> },
              { key: 'last', header: t('team.col.last'), sortable: true, cell: (u) => lastSeen(u) },
            ]}
            actionsLabel={t('team.col.actions')}
            rowActions={(u) => (
              <Button variant="outline" size="staff" opensDialog onClick={(e) => openEditor(u, e.currentTarget)}>
                {t('team.manage')}<span className="sr"> {u.display_name}</span>
              </Button>
            )}
          />
        )}
      </section>

      <div className="team-notes">
        <section className="mp-panel mp-note" aria-labelledby="team-first-h">
          <h2 className="mp-panel__h" id="team-first-h">{t('team.first.title')}</h2>
          <p>{t('team.first.body')}</p>
          <pre className="mp-code" lang="en"><code>npm run admin:create -- --username owner --name "Owner"</code></pre>
          <p className="mp-meta">{t('team.first.note')}</p>
        </section>
        <section className="mp-panel mp-note" aria-labelledby="team-rules-h">
          <h2 className="mp-panel__h" id="team-rules-h">{t('team.rules.title')}</h2>
          <ul className="mp-list">
            <li>{t('team.rules.owner', { n: ownerCount })}</li>
            <li>{t('team.rules.signout')}</li>
            <li>{t('team.rules.perms')}</li>
          </ul>
        </section>
      </div>

      <SelfPassword highlight={self} primary={false} />

      <CreateStaff
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(u) => {
          setAdding(false);
          res.mutate((prev) => ({ users: [...(prev?.users ?? []), u] }));
          void res.refresh();
          toast.show(t('team.add.done', { name: u.display_name }));
        }}
      />
      {editingUser ? (
        <StaffEditor
          key={editingUser.id}
          user={editingUser}
          isSelf={editingUser.id === me.user.id}
          onClose={() => { setEditing(null); trigger.current?.focus(); }}
          onChanged={(u) => res.mutate((prev) => ({ users: (prev?.users ?? []).map((x) => (x.id === u.id ? u : x)) }))}
          onRefresh={() => res.refresh()}
        />
      ) : null}
    </MorePageFrame>
  );
}

