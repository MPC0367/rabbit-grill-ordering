// Optional feedback (brief 15, DECISIONS D-21, D-G-01): a rating and/or a
// short comment, one per guest session, never required, never published.
//
// It is offered from the moment the guest asks for the bill, and again on the
// "visit ended" page while the API still accepts it (a short grace period
// after checkout). What the guest has typed is kept per visit in this tab's
// sessionStorage, so a checkout that swaps the bill page for the ended page
// never throws it away. If the API refuses (the grace period is over), the
// form steps aside with a calm note, and says so when words were lost.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Card, Icon, SegmentedControl, TextArea, announce } from '../../ui/index.ts';
import { attemptKey, errorWords, setVisitFlag, settleKey, settleUnlessAmbiguous, visitFlag } from './lib.ts';

const CLOSED = new Set(['visit_closed', 'visit_access_revoked', 'visit_access_required']);
type Rating = '' | '1' | '2' | '3' | '4' | '5';

// ------------------------------------------------------------------ per-visit draft (this tab)
const DRAFT_PREFIX = 'rg.feedback.';
const DRAFT_TTL_MS = 3 * 60 * 60 * 1000;

export interface FeedbackDraft { rating: Rating; comment: string; sent: boolean; at: number }

function draftKey(visitId: string): string {
  return `${DRAFT_PREFIX}${visitId}`;
}

export function readFeedbackDraft(visitId: string): FeedbackDraft | null {
  try {
    const raw = window.sessionStorage.getItem(draftKey(visitId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<FeedbackDraft>;
    if (typeof v?.at !== 'number' || Date.now() - v.at > DRAFT_TTL_MS) return null;
    const rating = (['1', '2', '3', '4', '5'] as const).find((r) => r === v.rating) ?? '';
    return { rating, comment: typeof v.comment === 'string' ? v.comment : '', sent: v.sent === true, at: v.at };
  } catch {
    return null;
  }
}

function writeFeedbackDraft(visitId: string, draft: Omit<FeedbackDraft, 'at'> | null): void {
  try {
    // Drop other visits' leftovers; this tab only ever needs the current one.
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(DRAFT_PREFIX) && k !== draftKey(visitId)) window.sessionStorage.removeItem(k);
    }
    if (draft) window.sessionStorage.setItem(draftKey(visitId), JSON.stringify({ ...draft, at: Date.now() }));
    else window.sessionStorage.removeItem(draftKey(visitId));
  } catch { /* private mode */ }
}

/** Something typed or picked that has not been sent. */
export function hasUnsentFeedback(visitId: string): boolean {
  const d = readFeedbackDraft(visitId);
  return Boolean(d && !d.sent && (d.rating || d.comment.trim()));
}

export function feedbackSent(visitId: string): boolean {
  return visitFlag(visitId, 'feedback') || readFeedbackDraft(visitId)?.sent === true;
}

/** The API can no longer take feedback for this visit: forget the unsendable draft. */
export function dropFeedbackDraft(visitId: string): void {
  const d = readFeedbackDraft(visitId);
  if (d && !d.sent) writeFeedbackDraft(visitId, null);
}

function markSent(visitId: string): void {
  setVisitFlag(visitId, 'feedback');
  writeFeedbackDraft(visitId, { rating: '', comment: '', sent: true });
}

// ------------------------------------------------------------------ form
export function FeedbackForm({ visitId, onClosed }: { visitId: string; onClosed?: (lostDraft: boolean) => void }) {
  const { t, has } = useI18n();
  const [initial] = useState(() => readFeedbackDraft(visitId));
  const [rating, setRating] = useState<Rating>(initial?.rating ?? '');
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'closed'>(() => (feedbackSent(visitId) ? 'sent' : 'idle'));
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  // Keep what the guest has typed for this visit (survives the switch to the ended page).
  useEffect(() => {
    if (state !== 'idle') return;
    if (!rating && !comment) {
      if (readFeedbackDraft(visitId) && !feedbackSent(visitId)) writeFeedbackDraft(visitId, null);
      return;
    }
    writeFeedbackDraft(visitId, { rating, comment, sent: false });
  }, [visitId, rating, comment, state]);

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
        <span className="vnote__body">{t(lost ? 'feedback.closedDraft' : 'feedback.closed')}</span>
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
      markSent(visitId);
      setState('sent');
      announce(t('feedback.thanks'));
    } catch (err) {
      settleUnlessAmbiguous(scope, err);
      if (err instanceof ApiError && CLOSED.has(err.code)) {
        writeFeedbackDraft(visitId, null);
        setLost(true);
        setState('closed');
        onClosed?.(true);
        return;
      }
      if (err instanceof ApiError && (err.code === 'already_done' || err.code === 'conflict')) {
        markSent(visitId);
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
