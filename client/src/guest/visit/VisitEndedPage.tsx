// The visit closed at checkout, or staff revoked this phone's access
// (brief 36, 07; DECISIONS D-13, D-G-01). A calm ending: this device forgets
// the visit's draft, pending submission, keys and analytics session.
//
// Feedback: after checkout the API keeps accepting it for a short while
// (about 30 minutes) from the session that was at the table. The page asks
// GET /api/guest/feedback/eligibility ({ eligible, submitted, until }) whether
// it may offer the form, says until when, and asks again once that time has
// passed. Anything the guest typed on the bill page is still there. When the
// API no longer takes it, the form steps aside, and says so if words were lost.
import { useEffect, useRef, useState } from 'react';
import type { FeedbackEligibilityDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate } from '../../lib/router.ts';
import { endVisit } from '../../lib/tracker.ts';
import { Button, Icon } from '../../ui/index.ts';
import { bindCart, endCartVisit } from '../cart/store.ts';
import { useGuestSession } from '../shell/session.tsx';
import { FeedbackForm, dropFeedbackDraft, feedbackSent, hasUnsentFeedback, keptFeedbackVisit } from './FeedbackForm.tsx';
import { clearVisitStorage, rememberedTable } from './lib.ts';
import './visit.css';

type FeedbackAvailability = 'checking' | 'open' | 'sent' | 'closed' | 'lost';

interface Availability { state: 'open' | 'sent' | 'closed'; until: string | null }

/** Can this browser still send feedback for the visit that just ended? */
async function feedbackAvailability(): Promise<Availability> {
  try {
    const r = await api.get<FeedbackEligibilityDTO>('/api/guest/feedback/eligibility');
    if (r.submitted) return { state: 'sent', until: null };
    return r.eligible ? { state: 'open', until: r.until ?? null } : { state: 'closed', until: null };
  } catch (err) {
    // Outcome unknown (network, timeout): offer the form and keep the draft.
    // Sending it is what gets the definitive answer.
    if (err instanceof ApiError && err.ambiguous) return { state: 'open', until: null };
    return { state: 'closed', until: null };
  }
}

/** How long to wait before asking again when `until` has passed by this clock but the API still says yes. */
const RECHECK_MIN_MS = 15_000;

export default function VisitEndedPage() {
  const { t, lang } = useI18n();
  const { endedReason, session } = useGuestSession();
  const revoked = endedReason === 'visit_access_revoked';
  const [label] = useState(() => session?.visit.table_label ?? rememberedTable());
  // A reload right after checkout can reach this page with no session left:
  // the draft this tab is keeping then says which visit it belongs to.
  const [visitId] = useState<string | null>(() => session?.visit.id ?? keptFeedbackVisit());
  const [feedback, setFeedback] = useState<FeedbackAvailability>(() => {
    if (!visitId) return 'closed';
    if (feedbackSent(visitId)) return 'sent';
    return revoked ? (hasUnsentFeedback(visitId) ? 'lost' : 'closed') : 'checking';
  });
  const [until, setUntil] = useState<string | null>(null);
  /** When to ask the API again (ms). It is the API, not this clock, that closes the window. */
  const [recheckAt, setRecheckAt] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Forget this visit on this device, once (the feedback draft lives apart and stays).
  useEffect(() => {
    endCartVisit();
    bindCart(null, null);
    endVisit();
    clearVisitStorage(true);
  }, []);

  const apply = (a: Availability, visit: string) => {
    setUntil(a.state === 'open' ? a.until : null);
    const at = a.state === 'open' && a.until ? new Date(a.until).getTime() : NaN;
    setRecheckAt(a.state === 'open' && Number.isFinite(at) ? Math.max(at, Date.now() + RECHECK_MIN_MS) : null);
    if (a.state === 'closed' && hasUnsentFeedback(visit)) setFeedback('lost');
    else setFeedback(a.state);
  };

  useEffect(() => {
    if (feedback !== 'checking' || !visitId) return;
    let live = true;
    void feedbackAvailability().then((a) => { if (live) apply(a, visitId); });
    return () => { live = false; };
  }, [feedback, visitId]);

  // The window closes at `until`: ask the API again then. It decides, not this clock.
  useEffect(() => {
    if (feedback !== 'open' || recheckAt === null || !visitId) return;
    let live = true;
    const timer = setTimeout(() => {
      void feedbackAvailability().then((a) => {
        if (live && !feedbackSent(visitId)) apply(a, visitId);
      });
    }, Math.min(Math.max(recheckAt - Date.now(), 0) + 1_000, 2_147_000_000));
    return () => { live = false; clearTimeout(timer); };
  }, [feedback, recheckAt, visitId]);

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
          <FeedbackForm visitId={visitId} until={until} />
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
