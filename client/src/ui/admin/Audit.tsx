// Audit entry: actor, action, time, reason and a before/after diff.
// The original values stay visible (struck), never overwritten.
import type { HTMLAttributes, ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { cx, Ico, useDataText, type DataText } from './parts.tsx';

export interface AuditChange {
  field: string;
  before: ReactNode;
  after: ReactNode;
}

export interface AuditEntryProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** "19:45" */
  time: string;
  /** "17 Sep" */
  date?: string;
  /** Machine timestamp for <time dateTime>. */
  at?: string;
  actor: string;
  actorType?: 'staff' | 'guest' | 'system';
  /** "Line cancelled" */
  action: string;
  /** "Green Salad · RG-4K7P · table 07" */
  target?: ReactNode;
  /** Why it happened, usually typed by staff. Pass the record's `Bilingual` so a Thai reason on an English screen carries `lang`. */
  reason?: DataText | null;
  changes?: AuditChange[];
  as?: 'div' | 'li';
}

export function AuditEntry({ time, date, at, actor, actorType = 'staff', action, target, reason, changes, as = 'li', className, ...rest }: AuditEntryProps) {
  const { t } = useI18n();
  const Tag = as;
  const why = useDataText()(reason);
  return (
    <Tag {...rest} className={cx('audit', className)}>
      <time className="audit__time" dateTime={at}>
        <b>{time}</b>
        {date ? <span>{date}</span> : null}
      </time>
      <div className="audit__body">
        <p className="audit__what">
          <b>{action}</b>
          {target ? <span> · {target}</span> : null}
        </p>
        <p className="audit__who">
          <Ico name={actorType === 'system' ? 'refresh' : 'user'} size="xs" />
          {actor}
          <span className="audit__type"> · {t(`common.audit.${actorType}`)}</span>
        </p>
        {why ? (
          <p className="audit__reason">
            <span className="audit__k">{t('common.audit.reason')}</span>
            <span lang={why.lang}>{why.text}</span>
          </p>
        ) : null}
        {changes && changes.length > 0 ? (
          <table className="audit__diff">
            <caption className="sr">{t('common.audit.change')}</caption>
            <thead>
              <tr>
                <th scope="col"><span className="sr">{t('common.audit.change')}</span></th>
                <th scope="col">{t('common.audit.before')}</th>
                <th scope="col">{t('common.audit.after')}</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.field}>
                  <th scope="row">{c.field}</th>
                  <td><del>{c.before === '' || c.before == null ? <i>{t('common.audit.empty')}</i> : c.before}</del></td>
                  <td><ins>{c.after === '' || c.after == null ? <i>{t('common.audit.empty')}</i> : c.after}</ins></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </Tag>
  );
}

/** Newest-first list wrapper. */
export function AuditList({ className, children, ...rest }: HTMLAttributes<HTMLOListElement>) {
  return <ol {...rest} className={cx('auditlist', className)}>{children}</ol>;
}
