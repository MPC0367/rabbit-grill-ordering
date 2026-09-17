// /admin/more: the permission-filtered index of the quieter destinations
// (Payments, Annual reports, Team, Settings, Audit) plus the signed-in
// person's own account. Each card is one link with a one-line description.
import { useState } from 'react';
import type { Permission } from '../../../../shared/permissions.ts';
import { linkHandler } from '../../lib/router.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, EmptyState, Icon, StaffChip, type IconName } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { MorePageFrame, useErrorWords } from './shared.tsx';

interface Entry {
  id: string;
  href: string;
  icon: IconName;
  perm: Permission | null;
}

const BUSINESS: Entry[] = [
  { id: 'payments', href: '/admin/payments', icon: 'receipt', perm: 'payments.view' },
  { id: 'reports', href: '/admin/reports', icon: 'book', perm: 'reports.view' },
];
const ADMIN: Entry[] = [
  { id: 'team', href: '/admin/team', icon: 'user', perm: 'team.manage' },
  { id: 'settings', href: '/admin/settings', icon: 'filter', perm: 'settings.manage' },
  { id: 'audit', href: '/admin/audit', icon: 'track', perm: 'audit.view' },
];

function MoreCard({ entry }: { entry: Entry }) {
  const { t } = useI18n();
  const titleId = `more-${entry.id}`;
  return (
    <li>
      <a className="morecard" href={entry.href} onClick={linkHandler} aria-labelledby={titleId} aria-describedby={`${titleId}-d`}>
        <span className="morecard__mark" aria-hidden="true"><Icon name={entry.icon} /></span>
        <span className="morecard__text">
          <span className="morecard__t" id={titleId}>{t(`more.item.${entry.id}`)}</span>
          <span className="morecard__d" id={`${titleId}-d`}>{t(`more.item.${entry.id}.d`)}</span>
        </span>
        <Icon name="chev-r" className="morecard__chev" />
      </a>
    </li>
  );
}

function Group({ id, entries }: { id: string; entries: Entry[] }) {
  const { t } = useI18n();
  const { can } = useStaff();
  const visible = entries.filter((e) => !e.perm || can(e.perm));
  if (visible.length === 0) return null;
  return (
    <section className="moregroup" aria-labelledby={`moreg-${id}`}>
      <h2 className="moregroup__h" id={`moreg-${id}`}>{t(`more.group.${id}`)}</h2>
      <ul className="moregrid">
        {visible.map((e) => <MoreCard key={e.id} entry={e} />)}
      </ul>
    </section>
  );
}

export default function MorePage() {
  const { t } = useI18n();
  const { me, can, logout } = useStaff();
  const { errorText } = useErrorWords();
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const anything = [...BUSINESS, ...ADMIN].some((e) => !e.perm || can(e.perm));

  return (
    <MorePageFrame title={t('more.title')} description={anything ? t('more.lede') : t('more.ledeAccount')} index>
      <Group id="business" entries={BUSINESS} />
      <Group id="admin" entries={ADMIN} />
      {!anything ? (
        <EmptyState icon="lock" headingLevel={2} title={t('more.none.title')}>{t('more.none.body')}</EmptyState>
      ) : null}

      <section className="moregroup" aria-labelledby="moreg-account">
        <h2 className="moregroup__h" id="moreg-account">{t('more.group.account')}</h2>
        <div className="moreaccount">
          <StaffChip
            className="moreaccount__who"
            name={me.user.display_name}
            role={`${t(`team.role.${me.user.role}`)} · ${me.user.username}`}
          />
          <ul className="moregrid moregrid--account">
            <MoreCard entry={{ id: 'password', href: '/admin/team?self=1', icon: 'key', perm: null }} />
          </ul>
          <div className="moreaccount__out">
            <Button
              variant="outline"
              size="staff"
              icon="lock"
              loading={leaving}
              onClick={async () => {
                setLeaving(true);
                setLeaveError(null);
                try { await logout(); } catch (err) { setLeaveError(errorText(err)); } finally { setLeaving(false); }
              }}
            >
              {t('more.signOut')}
            </Button>
            <p className="mp-meta">{t('more.signOut.d')}</p>
            {leaveError ? <p className="mp-alert" role="alert">{leaveError}</p> : null}
          </div>
        </div>
      </section>
    </MorePageFrame>
  );
}
