// Guest feedback in the operational report (brief 15, 26): the ratings and
// comments guests leave from their phone, read-only, for the chosen range.
// Data: GET /api/staff/feedback (reports.view, D-S8-22). Only a permission
// refusal hides the panel; anything else is a failed read the reader can
// retry. Feedback is never pushed on the live stream, so the list is refetched
// when the range changes and when visits change.
import { useState } from 'react';
import type { ApiError } from '../../lib/api.ts';
import { dateTime, num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import type { Resource } from '../../lib/live.tsx';
import { Button, EmptyState, Skeleton } from '../../ui/index.ts';
import type { FeedbackListDTO } from './reportTypes.ts';
import { langOf, useErrorWords } from './shared.tsx';

const FIRST = 6;
const SCORES = [5, 4, 3, 2, 1] as const;

/**
 * The endpoint exists (D-S8-22); only a permission answer hides the panel, so
 * a viewer whose role loses reports.view mid-session sees nothing rather than
 * an error they cannot act on. Anything else is shown as a failed read.
 */
export function feedbackUnavailable(error: ApiError | null): boolean {
  return error?.code === 'forbidden';
}

export function FeedbackPanel({ res }: { res: Resource<FeedbackListDTO> }) {
  const { t, lang } = useI18n();
  const { errorText } = useErrorWords();
  const [all, setAll] = useState(false);
  const fb = res.data;

  if (!fb && feedbackUnavailable(res.error)) return null;

  let body;
  if (!fb) {
    body = res.error && !res.loading ? (
      <EmptyState
        compact
        icon="alert"
        headingLevel={4}
        role="alert"
        title={t('more.loadFailed', { what: t('reports.fb.title') })}
        action={<Button variant="outline" size="staff" icon="refresh" onClick={() => void res.refresh()}>{t('common.retry')}</Button>}
      >
        {errorText(res.error)}
      </EmptyState>
    ) : (
      <div className="fbk__skel" role="status">
        <span className="sr">{t('common.loading')}</span>
        <Skeleton shape="block" height={96} />
      </div>
    );
  } else if (fb.count === 0) {
    body = (
      <EmptyState compact icon="note" headingLevel={4} title={t('reports.fb.none')}>
        {t('reports.fb.noneD')}
      </EmptyState>
    );
  } else {
    const dist = fb.distribution ?? (fb.truncated ? null : SCORES.map((s) => ({ rating: s, count: fb.items.filter((i) => i.rating === s).length })));
    const maxCount = Math.max(1, ...(dist ?? []).map((d) => d.count));
    const shown = all ? fb.items : fb.items.slice(0, FIRST);
    body = (
      <div className="fbk__body">
        <div className="fbk__sum">
          <p className="fbk__avg">
            <span className="fbk__k">{t('reports.fb.average')}</span>
            <span className="fbk__v">
              <b>{fb.average_rating === null ? '—' : fb.average_rating.toFixed(1)}</b>
              {fb.average_rating === null ? null : <small>{t('reports.fb.outOf')}</small>}
            </span>
          </p>
          <p className="mp-meta">{t('reports.fb.summary', { rated: num(fb.rated), comments: num(fb.with_comment) })}</p>
          {dist ? (
            <ul className="fbk__dist" aria-label={t('reports.fb.dist')}>
              {SCORES.map((s) => {
                const n = dist.find((d) => d.rating === s)?.count ?? 0;
                return (
                  <li key={s} aria-label={t('reports.fb.distRow', { score: s, n: num(n) })}>
                    <span className="fbk__score" aria-hidden="true">{s}</span>
                    <span className="fbk__bar" aria-hidden="true"><i style={{ width: `${Math.round((n / maxCount) * 100)}%` }} /></span>
                    <span className="fbk__n" aria-hidden="true">{num(n)}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        <div className="fbk__list">
          <h4 className="fbk__lh">{t('reports.fb.comments')}</h4>
          <ul className="fbk__items">
            {shown.map((i) => (
              <li key={i.id} className="fbk__item">
                <p className="fbk__meta">
                  <span>{dateTime(i.submitted_at, lang)}</span>
                  {i.table_label ? <span>{t('reports.fb.table', { label: i.table_label })}</span> : null}
                  {i.rating === null
                    ? <span>{t('reports.fb.noRating')}</span>
                    : <b className="fbk__rate">{t('reports.fb.rating', { n: i.rating })}</b>}
                </p>
                {i.comment
                  ? <p className="fbk__c" lang={langOf(i.comment)}>{i.comment}</p>
                  : <p className="fbk__c is-muted">{t('reports.fb.noComment')}</p>}
              </li>
            ))}
          </ul>
          {fb.items.length > FIRST ? (
            <Button variant="ghost" size="staff" className="fbk__more" aria-expanded={all} iconEnd={all ? undefined : 'chev-d'} onClick={() => setAll(!all)}>
              {all ? t('reports.fb.showFewer') : t('reports.fb.showAll', { n: num(fb.items.length) })}
            </Button>
          ) : null}
          {fb.truncated ? <p className="mp-meta">{t('reports.fb.truncated', { n: num(fb.items.length) })}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <article className="mp-panel fbk" aria-labelledby="fbk-h" aria-busy={res.loading || undefined}>
      <h3 id="fbk-h" className="mp-panel__h">{t('reports.fb.title')}</h3>
      <p className="mp-meta">{t('reports.fb.lede')}</p>
      {body}
      <p className="mp-meta fbk__priv">{t('reports.fb.privacy')}</p>
    </article>
  );
}
