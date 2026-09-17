// Shown when someone without table access tries to order, track or view a
// bill. Explains the only way in (scan the table QR, enter the staff code);
// there is never a table picker or a place to type a table number.
import { useI18n } from '../../lib/i18n.tsx';
import { Card, Icon, LinkButton, cx } from '../../ui/index.ts';
import './visit.css';

export interface NoAccessPanelProps {
  reason: 'public' | 'revoked' | 'required';
  /** Inside a sheet or a small panel: no card frame and no menu link. */
  compact?: boolean;
}

export default function NoAccessPanel({ reason, compact }: NoAccessPanelProps) {
  const { t } = useI18n();
  const titleId = `noaccess-${reason}${compact ? '-c' : ''}`;
  const Heading = compact ? 'h3' : 'h2';
  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      className={cx('vnoaccess', compact ? 'vnoaccess--compact' : 'vnoaccess--page')}
    >
      <div className="vnoaccess__top">
        <span className={cx('vjoin__mark', reason === 'revoked' && 'vjoin__mark--alert')} aria-hidden="true">
          <Icon name={reason === 'revoked' ? 'lock' : 'qr'} />
        </span>
        <div>
          <Heading id={titleId}>{t(`visit.noAccess.${reason}Title`)}</Heading>
          <p className="vnoaccess__lead">{t(`visit.noAccess.${reason}Body`)}</p>
        </div>
      </div>
      <div>
        <p className="vsteps__t">{t('visit.noAccess.steps')}</p>
        <ol className="vsteps">
          <li>{t('visit.noAccess.step1')}</li>
          <li>{t('visit.noAccess.step2')}</li>
          <li>{t('visit.noAccess.step3')}</li>
        </ol>
      </div>
      <p className="handnote"><Icon name="hand" />{t('visit.noAccess.help')}</p>
      {compact ? null : (
        <div>
          <LinkButton href="/menu" variant="outline" icon="book">{t('visit.browse')}</LinkButton>
        </div>
      )}
    </Card>
  );
}
