// Optional feedback (brief 15, DECISIONS D-21): a rating and/or a short
// comment, one per guest session, never required, never published. The API
// only accepts it while the visit is still open, so after checkout the form
// steps aside with a calm note instead of failing.
import { useId, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Card, Icon, SegmentedControl, TextArea, announce } from '../../ui/index.ts';
import { attemptKey, errorWords, setVisitFlag, settleKey, settleUnlessAmbiguous, visitFlag } from './lib.ts';

const CLOSED = new Set(['visit_closed', 'visit_access_revoked', 'visit_access_required']);
type Rating = '' | '1' | '2' | '3' | '4' | '5';

export function FeedbackForm({ visitId, onClosed }: { visitId: string; onClosed?: () => void }) {
  const { t, has } = useI18n();
  const [rating, setRating] = useState<Rating>('');
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'closed'>(() => (visitFlag(visitId, 'feedback') ? 'sent' : 'idle'));
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  if (state === 'sent') {
    return (
      <Card as="section" className="vfeedback" aria-labelledby={titleId}>
        <div className="vfeedback__done" role="status">
          <Icon name="check-c" />
          <div>
            <strong id={titleId}>{t('feedback.thanks')}</strong>
            <span>{t('feedback.thanksBody')}</span>
          </div>
        </div>
      </Card>
    );
  }
  if (state === 'closed') {
    return (
      <p className="vnote" role="status">
        <Icon name="info" />
        <span className="vnote__body">{t('feedback.closed')}</span>
      </p>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'sending') return;
    const text = comment.trim();
    if (!rating && !text) { setError(t('feedback.needOne')); return; }
    setError(null);
    setState('sending');
    const scope = `feedback.${visitId}`;
    try {
      await api.post('/api/guest/feedback', {
        rating: rating ? Number(rating) : null,
        comment: text || null,
        idempotency_key: attemptKey(scope),
      });
      settleKey(scope);
      setVisitFlag(visitId, 'feedback');
      setState('sent');
      announce(t('feedback.thanks'));
    } catch (err) {
      settleUnlessAmbiguous(scope, err);
      if (err instanceof ApiError && CLOSED.has(err.code)) {
        setState('closed');
        onClosed?.();
        return;
      }
      if (err instanceof ApiError && (err.code === 'already_done' || err.code === 'conflict')) {
        setVisitFlag(visitId, 'feedback');
        setState('sent');
        return;
      }
      setState('idle');
      setError(`${t('feedback.failed')} · ${errorWords(t, has, err)}`);
    }
  };

  return (
    <Card as="section" className="vfeedback" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('feedback.title')}</h2>
      <p className="vfeedback__lead">{t('feedback.lead')}</p>
      <form onSubmit={submit} noValidate className="vfeedback__form">
        <fieldset>
          <legend>{t('feedback.rating')} <small className="meta">{t('common.optional')}</small></legend>
          <SegmentedControl<Rating>
            label={t('feedback.rating')}
            block
            value={rating}
            onChange={(v) => { setRating(v); setError(null); }}
            options={(['1', '2', '3', '4', '5'] as const).map((n) => ({
              value: n, label: n, lang: 'en', ariaLabel: t('feedback.ratingOf', { n }),
            }))}
          />
          <p className="vrating__ends" aria-hidden="true"><span>{t('feedback.low')}</span><span>{t('feedback.high')}</span></p>
        </fieldset>
        <TextArea
          label={t('feedback.comment')}
          optional
          value={comment}
          onChange={(v) => { setComment(v); setError(null); }}
          limit={500}
          rows={3}
        />
        {error ? (
          <p className="field__error" role="alert"><Icon name="alert" /><span>{error}</span></p>
        ) : null}
        <div>
          <Button type="submit" variant="secondary" size="lg" loading={state === 'sending'}>{t('feedback.send')}</Button>
        </div>
      </form>
    </Card>
  );
}
