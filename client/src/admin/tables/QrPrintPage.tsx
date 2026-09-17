// Printable table QR cards (brief 20; DESIGN §10.28): /admin/tables/print?ids=a,b
// A6 portrait cards (four to an A4 sheet, or one per A6 page). Each card
// carries the restaurant identity, a big table label, scan instructions in
// Thai and English, the in-person fallback and the QR with its quiet zone.
// The join PIN is never printed: it changes with every visit.
// Fetching the cards counts as downloading them (clears "reprint needed").
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TablesDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import { storage } from '../../lib/store.ts';
import {
  Banner, Button, EmptyState, LinkButton, PageHeader, SegmentedControl, Skeleton, Wordmark,
} from '../../ui/index.ts';
import { errorText, isApiError, useStaff } from './shared.ts';
import './tables.css';

interface QrCardData { table_id: string; label: string; url: string; svg: string }
type Layout = 'a4' | 'a6';

const LAYOUT_KEY = 'rg.c5.qrLayout';

function QrCard({ card }: { card: QrCardData }) {
  const { t } = useI18n();
  return (
    <article className="c5-qrcard">
      <header className="c5-qrcard__brand">
        <Wordmark label={t('qr.card.restaurant')} />
        <span className="c5-qrcard__rule" aria-hidden="true" />
      </header>
      <p className="c5-qrcard__table">
        <span className="c5-qrcard__k">
          <span lang="th">{t('qr.card.tableTh')}</span>
          <span lang="en">{t('qr.card.tableEn')}</span>
        </span>
        <b lang="en">{card.label}</b>
      </p>
      <div
        className="c5-qrcard__code"
        role="img"
        aria-label={t('qr.card.codeLabel', { table: card.label })}
        // The SVG comes from our own server (qrcode library output, no scripts).
        dangerouslySetInnerHTML={{ __html: card.svg }}
      />
      <div className="c5-qrcard__how">
        <p className="c5-qrcard__scan" lang="th">{t('qr.card.scanTh')}</p>
        <p className="c5-qrcard__scan-en" lang="en">{t('qr.card.scanEn')}</p>
      </div>
      <p className="c5-qrcard__pin">
        <span lang="th">{t('qr.card.pinTh')}</span>
        <span lang="en">{t('qr.card.pinEn')}</span>
      </p>
      <p className="c5-qrcard__fallback">
        <span lang="th">{t('qr.card.fallbackTh')}</span>
        <span lang="en">{t('qr.card.fallbackEn')}</span>
      </p>
      <footer className="c5-qrcard__url" lang="en">{card.url}</footer>
    </article>
  );
}

export default function QrPrintPage() {
  const { t } = useI18n();
  const { can } = useStaff();
  const { query } = useRoute();
  const idsKey = (query.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).join(',');
  const [layout, setLayoutState] = useState<Layout>(() => (storage.get<string>(LAYOUT_KEY, 'a4') === 'a6' ? 'a6' : 'a4'));
  const [cards, setCards] = useState<QrCardData[] | null>(null);
  const [replaced, setReplaced] = useState<string[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const allowed = can('tables.view');

  const setLayout = (l: Layout) => { setLayoutState(l); storage.set(LAYOUT_KEY, l); };

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setCards(null);
    setError(null);
    (async () => {
      try {
        // Read the reprint flags first: fetching the cards clears them.
        const tables = await api.get<TablesDTO>('/api/staff/tables');
        const wanted = idsKey ? new Set(idsKey.split(',')) : null;
        const flagged = tables.tables.filter((x) => x.qr?.reprint_required && (!wanted || wanted.has(x.id))).map((x) => x.label);
        const res = await api.get<{ cards: QrCardData[] }>(`/api/staff/tables/qr-cards${idsKey ? `?ids=${idsKey.split(',').map(encodeURIComponent).join(',')}` : ''}`);
        if (cancelled) return;
        setReplaced(flagged);
        setCards(res.cards);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError('internal', 0, String(err)));
      }
    })();
    return () => { cancelled = true; };
  }, [idsKey, allowed, attempt]);

  const back = { label: t('qr.back'), href: '/admin/tables?view=manage' };
  const count = cards?.length ?? 0;
  const sheets = layout === 'a4' ? Math.ceil(count / 4) : count;

  if (!allowed) {
    return (
      <div className="c5-qrpage">
        <PageHeader title={t('qr.title')} back={back} />
        <EmptyState icon="lock" headingLevel={2} title={t('tables.denied.title')}>{t('tables.denied.body')}</EmptyState>
      </div>
    );
  }

  return (
    <div className="c5-qrpage">
      <PageHeader
        title={t('qr.title')}
        back={back}
        description={t('qr.lede')}
        actions={(
          <>
            <SegmentedControl<Layout>
              size="staff"
              label={t('qr.layout')}
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'a4', label: t('qr.layout.a4') },
                { value: 'a6', label: t('qr.layout.a6') },
              ]}
            />
            <Button variant="primary" size="staff" icon="qr" disabled={!cards || count === 0} onClick={() => window.print()}>
              {t('qr.print', { n: count })}
            </Button>
          </>
        )}
      />

      <div className="c5-qrpage__notes">
        <p className="c5-callout c5-callout--neutral c5-pinnote">{t('qr.pinNote')}</p>
        {replaced.length > 0 ? (
          <Banner variant="warning" staff title={t('qr.replacedTitle')}>
            {t('qr.replacedBody', { tables: replaced.join(', ') })}
          </Banner>
        ) : null}
      </div>

      {error ? (
        <EmptyState
          icon="alert"
          headingLevel={2}
          title={isApiError(error, 'not_found') ? t('qr.notFound') : t('qr.loadFailed')}
          action={isApiError(error, 'not_found')
            ? <LinkButton variant="outline" size="staff" href={back.href}>{t('qr.chooseAgain')}</LinkButton>
            : <Button variant="outline" size="staff" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</Button>}
        >
          {errorText(t, error)}
        </EmptyState>
      ) : !cards ? (
        <div className="c5-sheetprev" role="status" aria-label={t('common.loading')}>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} shape="block" className="c5-qrcard c5-qrcard--skel" />)}
        </div>
      ) : count === 0 ? (
        <EmptyState icon="qr" headingLevel={2} title={t('qr.none')} action={<LinkButton variant="outline" size="staff" href={back.href}>{t('qr.chooseAgain')}</LinkButton>} />
      ) : (
        <>
          <p className="c5-qrpage__count" role="status">
            {layout === 'a4' ? t('qr.countA4', { n: count, sheets }) : t('qr.countA6', { n: count })}
          </p>
          <section className={`c5-sheetprev c5-sheetprev--${layout}`} aria-label={t('qr.previewLabel')}>
            {cards.map((c) => <QrCard key={c.table_id} card={c} />)}
          </section>
          {typeof document !== 'undefined' ? createPortal(
            <div className={`c5-print c5-print--${layout}`} aria-hidden="true">
              <style>{`@page { size: ${layout === 'a4' ? 'A4 portrait' : '105mm 148mm'}; margin: 0; }`}</style>
              {cards.map((c) => <QrCard key={c.table_id} card={c} />)}
            </div>,
            document.body,
          ) : null}
        </>
      )}
    </div>
  );
}
