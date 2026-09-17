// Operating mode (demo / live, with a strong confirmation that counts what
// stops being orderable) and the role permission matrix (owner-only rows
// locked; every change is listed and confirmed before it is saved).
import type { AdminCatalogDTO } from '../../../../shared/dto.ts';
import { OWNER_ONLY, PERMISSIONS, ROLES, rolesFor, type Permission, type PermissionOverrides, type Role } from '../../../../shared/permissions.ts';
import { api } from '../../lib/api.ts';
import { num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, ChoiceGroup, Icon, RadioCard } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { SettingsSection } from './settingsParts.tsx';
import { usePlural } from './shared.tsx';

// ------------------------------------------------------------------ operating mode
export function ModeSection() {
  const { t } = useI18n();
  const { can } = useStaff();
  return (
    <SettingsSection
      id="mode"
      keys={['operating_mode'] as const}
      title={t('settings.mode.title')}
      description={t('settings.mode.d')}
      confirm={async (d, b) => {
        if (d.operating_mode === b.operating_mode) return null;
        let counts: { stop: number; stay: number; start: number } | null = null;
        if (can('menu.view')) {
          const cat = await api.get<AdminCatalogDTO>('/api/staff/menu');
          const unverifiedOrderable = cat.items.filter((i) => i.status === 'published' && i.orderable && i.review_status !== 'verified').length;
          const demoOnly = cat.items.filter((i) => i.status === 'published' && !i.orderable && i.demo_orderable && i.review_status !== 'verified' && !i.sold_out).length;
          counts = { stop: unverifiedOrderable, stay: cat.review.live_ready, start: demoOnly };
        }
        if (d.operating_mode === 'live') {
          return {
            title: t('settings.mode.liveTitle'),
            tone: 'danger',
            confirmLabel: t('settings.mode.liveConfirm'),
            body: (
              <div className="mode-confirm">
                {counts ? (
                  <dl className="mode-counts">
                    <div className={counts.stop ? 'is-alert' : undefined}><dt>{t('settings.mode.stop')}</dt><dd>{num(counts.stop)}</dd></div>
                    <div><dt>{t('settings.mode.stay')}</dt><dd>{num(counts.stay)}</dd></div>
                  </dl>
                ) : <p>{t('settings.mode.noCounts')}</p>}
                <ul className="mp-list">
                  <li>{t('settings.mode.live1')}</li>
                  <li>{t('settings.mode.live2')}</li>
                  <li>{t('settings.mode.live3')}</li>
                  <li>{t('settings.mode.live4')}</li>
                </ul>
                <p className="mp-meta">{t('settings.mode.reviewHint')}</p>
              </div>
            ),
          };
        }
        return {
          title: t('settings.mode.demoTitle'),
          confirmLabel: t('settings.mode.demoConfirm'),
          body: (
            <div className="mode-confirm">
              {counts ? (
                <dl className="mode-counts">
                  <div><dt>{t('settings.mode.start')}</dt><dd>{num(counts.start)}</dd></div>
                </dl>
              ) : null}
              <ul className="mp-list">
                <li>{t('settings.mode.demo1')}</li>
                <li>{t('settings.mode.demo2')}</li>
              </ul>
            </div>
          ),
        };
      }}
    >
      {({ draft, base, set }) => (
        <ChoiceGroup legend={t('settings.mode.legend')} className="setchoice">
          <RadioCard
            name="operating-mode"
            checked={draft.operating_mode === 'demo'}
            onChange={() => set('operating_mode', 'demo')}
            label={<>{t('settings.mode.demo')}{base.operating_mode === 'demo' ? <span className="setcurrent"> · {t('settings.mode.current')}</span> : null}</>}
            description={t('settings.mode.demoD')}
          />
          <RadioCard
            name="operating-mode"
            checked={draft.operating_mode === 'live'}
            onChange={() => set('operating_mode', 'live')}
            label={<>{t('settings.mode.live')}{base.operating_mode === 'live' ? <span className="setcurrent"> · {t('settings.mode.current')}</span> : null}</>}
            description={t('settings.mode.liveD')}
          />
        </ChoiceGroup>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ role permissions
const GROUPS: Array<{ id: string; prefixes: string[] }> = [
  { id: 'service', prefixes: ['orders.', 'service.', 'portions.'] },
  { id: 'tables', prefixes: ['tables.', 'visits.', 'ordering.'] },
  { id: 'billing', prefixes: ['billing.', 'payments.', 'checkout.'] },
  { id: 'menu', prefixes: ['menu.'] },
  { id: 'insight', prefixes: ['stats.', 'reports.', 'audit.'] },
  { id: 'admin', prefixes: ['team.', 'settings.'] },
];

function grouped(): Array<{ id: string; perms: Permission[] }> {
  const used = new Set<Permission>();
  const out = GROUPS.map((g) => {
    const perms = PERMISSIONS.filter((p) => g.prefixes.some((x) => p.startsWith(x)));
    perms.forEach((p) => used.add(p));
    return { id: g.id, perms };
  });
  const rest = PERMISSIONS.filter((p) => !used.has(p));
  if (rest.length) out.push({ id: 'other', perms: rest });
  return out;
}

const sameRoles = (a: readonly Role[], b: readonly Role[]) => a.length === b.length && a.every((r) => b.includes(r));

function toggle(overrides: PermissionOverrides, perm: Permission, role: Role): PermissionOverrides {
  const current = rolesFor(perm, overrides);
  const nextRoles = current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
  const ordered = ROLES.filter((r) => nextRoles.includes(r));
  const next = { ...overrides };
  if (sameRoles(ordered, rolesFor(perm, {}))) delete next[perm];
  else next[perm] = ordered;
  return next;
}

interface Change { perm: Permission; role: Role; granted: boolean }

function diff(before: PermissionOverrides, after: PermissionOverrides): Change[] {
  const out: Change[] = [];
  for (const perm of PERMISSIONS) {
    const a = rolesFor(perm, before);
    const b = rolesFor(perm, after);
    for (const role of ROLES) {
      if (a.includes(role) !== b.includes(role)) out.push({ perm, role, granted: b.includes(role) });
    }
  }
  return out;
}

export function PermissionsSection() {
  const { t } = useI18n();
  const plural = usePlural();
  const groups = grouped();
  return (
    <SettingsSection
      id="permissions"
      keys={['role_permissions'] as const}
      title={t('settings.perm.title')}
      description={t('settings.perm.d')}
      confirm={(d, b) => {
        const changes = diff(b.role_permissions, d.role_permissions);
        return {
          title: plural('settings.perm.confirmTitle', changes.length),
          confirmLabel: t('settings.perm.confirmSave'),
          tone: 'danger',
          body: (
            <>
              <p>{t('settings.perm.confirmBody')}</p>
              <ul className="perm-changes">
                {changes.map((c) => (
                  <li key={`${c.perm}-${c.role}`} className={c.granted ? 'is-grant' : 'is-revoke'}>
                    <b>{c.granted ? t('settings.perm.grant') : t('settings.perm.revoke')}</b>
                    {' · '}{t(`team.role.${c.role}`)}{' · '}{t(`settings.perm.p.${c.perm}`)}
                  </li>
                ))}
              </ul>
            </>
          ),
        };
      }}
    >
      {({ draft, base, set }) => {
        const o = draft.role_permissions;
        const customCount = Object.keys(o).length;
        return (
          <>
            <div className="perm-tools">
              <p className="mp-meta">
                {customCount ? plural('settings.perm.custom', customCount) : t('settings.perm.allDefault')}
              </p>
              <Button variant="ghost" size="staff" icon="refresh" disabled={customCount === 0} onClick={() => set('role_permissions', {})}>
                {t('settings.perm.reset')}
              </Button>
            </div>
            <div className="perm-frame" role="region" aria-label={t('settings.perm.title')} tabIndex={0}>
              <table className="perm">
                <caption className="sr">{t('settings.perm.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="perm__p">{t('settings.perm.col')}</th>
                    {ROLES.map((r) => (
                      <th scope="col" key={r} className="perm__r">
                        {r === 'owner' ? <Icon name="lock" size="xs" /> : null}
                        {t(`team.role.${r}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.id}>
                    <tr className="perm__g">
                      <th scope="colgroup" colSpan={ROLES.length + 1}>{t(`settings.perm.g.${g.id}`)}</th>
                    </tr>
                    {g.perms.map((p) => {
                      const locked = OWNER_ONLY.includes(p);
                      const eff = rolesFor(p, o);
                      const def = rolesFor(p, {});
                      const was = rolesFor(p, base.role_permissions);
                      const label = t(`settings.perm.p.${p}`);
                      return (
                        <tr key={p}>
                          <th scope="row" className="perm__p">
                            <span>{label}</span>
                            {locked ? <span className="perm__lock"><Icon name="lock" size="xs" />{t('settings.perm.ownerOnly')}</span> : null}
                          </th>
                          {ROLES.map((r) => {
                            const on = eff.includes(r);
                            const fixed = r === 'owner' || locked;
                            const custom = !fixed && on !== def.includes(r);
                            const pendingChange = on !== was.includes(r);
                            return (
                              <td key={r} className={['perm__c', custom ? 'is-custom' : '', pendingChange ? 'is-changed' : ''].filter(Boolean).join(' ')}>
                                <label className="perm__box">
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={fixed}
                                    onChange={() => set('role_permissions', toggle(o, p, r))}
                                    aria-label={`${label}: ${t(`team.role.${r}`)}${custom ? ` (${t('settings.perm.notDefault')})` : ''}`}
                                  />
                                  <span className="perm__mark" aria-hidden="true">{on ? <Icon name="check" size="sm" bold /> : null}</span>
                                </label>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
            <p className="mp-meta perm-legend">
              <span className="perm-legend__i perm-legend__i--custom" aria-hidden="true" /> {t('settings.perm.legendCustom')}
              {' · '}<Icon name="lock" size="xs" /> {t('settings.perm.legendLocked')}
            </p>
          </>
        );
      }}
    </SettingsSection>
  );
}

