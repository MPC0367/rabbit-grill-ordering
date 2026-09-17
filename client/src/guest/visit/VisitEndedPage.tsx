// The visit closed at checkout, or staff revoked this phone's access
// (brief 36, 07; DECISIONS D-13, D-G-01). A calm ending: this device forgets
// the visit's draft, pending submission, keys and analytics session.
//
// Feedback: after checkout the API keeps accepting it for a short while from
// the session that was at the table. The page asks the eligibility endpoint
// (GET /api/guest/feedback/eligibility) whether it may offer the form; a
// server without that endpoint (404) falls back to the old session probe.
// Anything the guest typed on the bill page is still there. When the API no
// longer takes it, the form steps aside, and says so if words were lost.
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate } from '../../lib/router.ts';
import { endVisit } from '../../lib/tracker.ts';
import { Button, Icon } from '../../ui/index.ts';
import { bindCart, endCartVisit } from '../cart/store.ts';
import { useGuestSession } from '../shell/session.tsx';
import { FeedbackForm, dropFeedbackDraft, feedbackSent, hasUnsentFeedback } from './FeedbackForm.tsx';
import { clearVisitStorage, rememberedTable } from './lib.ts';
import './visit.css';

type FeedbackAvailability = 'checking' | 'open' | 'sent' | 'closed' | 'lost';

interface Eligibility { eligible?: boolean; allowed?: boolean; open?: boolean; submitted?: boolean; sent?: boolean }

/** Can this browser still send feedback for the visit that just ended? */
async function feedbackAvailability(): Promise<'open' | 'sent' | 'closed'> {
  try {
    const r = await api.get<Eligibility>('/api/guest/feedback/eligibility');
    if (r.submitted || r.sent) return 'sent';
    return r.eligible || r.allowed || r.open ? 'open' : 'closed';
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'not_found') return 'closed';
  }
  // Older server: feedback only while the guest session itself still works.
  try {
    await api.get('/api/guest/session');
    return 'open';
  } catch {
    return 'closed';
  }
}

export default function VisitEndedPage() {
  const { t, lang } = useI18n();
  const { endedReason, session } = useGuestSession();
  const revoked = endedReason === 'visit_access_revoked';
  const [label] = useState(() => session?.visit.table_label ?? rememberedTable());
  const visitId = session?.visit.id ?? null;
  const [feedback, setFeedback] = useState<FeedbackAvailability>(() => {
    if (!visitId) return 'closed';
    if (feedbackSent(visitId)) return 'sent';
    return revoked ? (hasUnsentFeedback(visitId) ? 'lost' : 'closed') : 'checking';
  });
  const [leaving, setLeaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Forget this visit on this device, once (the feedback draft lives apart and stays).
  useEffect(() => {
    endCartVisit();
    bindCart(null, null);
    endVisit();
    clearVisitStorage(true);
  }, []);

  useEffect(() => {
    if (feedback !== 'checking' || !visitId) return;
    let live = true;
    void feedbackAvailability().then((a) => {
      if (!live) return;
      if (a === 'closed' && hasUnsentFeedback(visitId)) setFeedback('lost');
      else setFeedback(a);
    });
    return () => { live = false; };
  }, [feedback, visitId]);

  // An unsendable draft is forgotten once the guest has been told.
  useEffect(() => {
    if ((feedback === 'lost' || feedback === 'closed') && visitId) dropFeedbackDraft(visitId);
  }, [feedback, visitId]);

  useEffect(() => {
    // Arriving here replaces the page the guest was on: say where they are.
    requestAnimationFrame(() => {
      if (!document.querySelector('dialog[open]')) headingRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const browse = async () => {
    if (leaving) return;
    setLeaving(true);
    try { await api.post('/api/guest/leave', {}); } catch { /* the cookie may already be gone */ }
    navigate('/menu');
  };

  const kicker = revoked
    ? t('visit.revokedKicker')
    : label ? t('visit.endedKicker', { label }) : t('visit.endedKickerNoTable');

  return (
    <main className="g-main">
      <div className="vend" data-ended={revoked ? 'revoked' : 'closed'} data-feedback={feedback}>
        <header className="vend__hero">
          <p className="meta">{kicker}</p>
          <span className={revoked ? 'vend__mark vend__mark--muted' : 'vend__mark'} aria-hidden="true">
            <Icon name={revoked ? 'lock' : 'check-c'} />
          </span>
          <h1 ref={headingRef} tabIndex={-1}>{t(revoked ? 'visit.revokedTitle' : 'visit.endedTitle')}</h1>
          {!revoked && lang === 'th' ? <p className="vend__en" lang="en">{t('visit.endedTitleEn')}</p> : null}
          <p>{t(revoked ? 'visit.revokedBody' : 'visit.endedBody')}</p>
          <p>{t(revoked ? 'visit.revokedNext' : 'visit.endedNext')}</p>
        </header>

        {feedback === 'open' && visitId ? (
          <FeedbackForm visitId={visitId} />
        ) : null}
        {feedback === 'sent' ? (
          <p className="vnote vnote--ok" role="status">
            <Icon name="check-c" />
            <span className="vnote__body"><span className="vnote__t">{t('feedback.thanks')}</span>{t('feedback.thanksBody')}</span>
          </p>
        ) : null}
        {feedback === 'lost' ? (
          <p className="vnote" role="status">
            <Icon name="info" />
            <span className="vnote__body">{t(revoked ? 'feedback.revokedDraft' : 'feedback.closedDraft')}</span>
          </p>
        ) : null}

        <div className="vend__actions">
          <Button variant="outline" size="lg" icon="book" loading={leaving} onClick={() => void browse()}>
            {t('visit.browse')}
          </Button>
        </div>
      </div>
    </main>
  );
}
