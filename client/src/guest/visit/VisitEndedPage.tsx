// The visit closed at checkout, or staff revoked this phone's access
// (brief 36, 07; DECISIONS D-13). A calm ending: this device forgets the
// visit's draft, pending submission, keys and analytics session. Feedback is
// offered only while the API can still accept it (it refuses once the table
// is closed), otherwise it steps aside.
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate } from '../../lib/router.ts';
import { endVisit } from '../../lib/tracker.ts';
import { Button, Icon } from '../../ui/index.ts';
import { bindCart, endCartVisit } from '../cart/store.ts';
import { useGuestSession } from '../shell/session.tsx';
import { FeedbackForm } from './FeedbackForm.tsx';
import { clearVisitStorage, rememberedTable, visitFlag } from './lib.ts';
import './visit.css';

type FeedbackAvailability = 'checking' | 'open' | 'sent' | 'closed';

export default function VisitEndedPage() {
  const { t, lang } = useI18n();
  const { endedReason, session } = useGuestSession();
  const revoked = endedReason === 'visit_access_revoked';
  const [label] = useState(() => session?.visit.table_label ?? rememberedTable());
  const visitId = session?.visit.id ?? null;
  const [feedback, setFeedback] = useState<FeedbackAvailability>(() => (visitId && visitFlag(visitId, 'feedback') ? 'sent' : revoked ? 'closed' : 'checking'));
  const [leaving, setLeaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Forget this visit on this device, once.
  useEffect(() => {
    endCartVisit();
    bindCart(null, null);
    endVisit();
    clearVisitStorage(true);
  }, []);

  // Feedback needs a still-valid guest session; after checkout the API refuses it.
  useEffect(() => {
    if (feedback !== 'checking') return;
    let live = true;
    api.get('/api/guest/session')
      .then(() => { if (live) setFeedback(visitId ? 'open' : 'closed'); })
      .catch(() => { if (live) setFeedback('closed'); });
    return () => { live = false; };
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
      <div className="vend" data-ended={revoked ? 'revoked' : 'closed'}>
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

        {feedback === 'open' && visitId ? <FeedbackForm visitId={visitId} onClosed={() => setFeedback('closed')} /> : null}
        {feedback === 'sent' ? (
          <p className="vnote vnote--ok" role="status">
            <Icon name="check-c" />
            <span className="vnote__body"><span className="vnote__t">{t('feedback.thanks')}</span>{t('feedback.thanksBody')}</span>
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
