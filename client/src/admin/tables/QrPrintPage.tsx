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
  Banner, Button, EmptyState, Icon, LinkButton, PageHeader, SegmentedControl, Skeleton, Wordmark,
} from '../../ui/index.ts';
import { errorText, isApiError, qrDownloadHref, useStaff } from './shared.ts';
import './tables.css';

interface QrCardData { table_id: string; label: string; url: string; svg: string }
/**
 * The batch also says what the QR links point at. `qr_base_is_local` means
 * PUBLIC_BASE_URL is this computer (localhost / 127.0.0.1), so a printed card
 * would open nothing on a guest's phone: printing is blocked until it is set
 * to the address the restaurant's Wi-Fi reaches (D-S8-09).
 */
interface QrBatch { cards: QrCardData[]; qr_base_url?: string; qr_base_is_local?: boolean; pin_required?: boolean }
type Layout = 'a4' | 'a6';

const LAYOUT_KEY = 'rg.c5.qrLayout';

/**
 * The short table token id printed for staff matching (DESIGN §10.28): never
 * the URL. The full link lives only inside the QR.
 */
function shortTokenId(url: string): string {
  const token = url.slice(url.lastIndexOf('/q/') + 3).replace(/[?#].*$/, '');
  return token.slice(0, 6);
}

function QrCard({ card, pin }: { card: QrCardData; pin: boolean }) {
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
      {/* Only when the restaurant asks for a table code (D-S8-07 / join settings). */}
      {pin ? (
        <p className="c5-qrcard__pin">
          <span lang="th">{t('qr.card.pinTh')}</span>
          <span lang="en">{t('qr.card.pinEn')}</span>
        </p>
      ) : null}
      <p className="c5-qrcard__fallback">
        <span lang="th">{t('qr.card.fallbackTh')}</span>
        <span lang="en">{t('qr.card.fallbackEn')}</span>
      </p>
      <footer className="c5-qrcard__url" lang="en">{`${card.label} · ${shortTokenId(card.url)}`}</footer>
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
  const [batch, setBatch] = useState<{ baseUrl: string | null; local: boolean; pin: boolean }>({ baseUrl: null, local: false, pin: true });
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
        const res = await api.get<QrBatch>(`/api/staff/tables/qr-cards${idsKey ? `?ids=${idsKey.split(',').map(encodeURIComponent).join(',')}` : ''}`);
        if (cancelled) return;
        setReplaced(flagged);
        setBatch({
          baseUrl: res.qr_base_url ?? null,
          local: res.qr_base_is_local === true,
          // Until the server says otherwise, the card keeps its "ask staff for the code" line.
          pin: res.pin_required !== false,
        });
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
            <Button
              variant="primary"
              size="staff"
              icon="qr"
              disabled={!cards || count === 0 || batch.local}
              aria-describedby={batch.local ? 'c5-qrlocal' : undefined}
              onClick={() => window.print()}
            >
              {t('qr.print', { n: count })}
            </Button>
          </>
        )}
      />

      <div className="c5-qrpage__notes">
        {/* Cards made from a localhost address open nothing on a phone: printing waits. */}
        {batch.local ? (
          <Banner variant="offline" staff id="c5-qrlocal" title={t('qr.local.title')}>
            {t('qr.local.body', { url: batch.baseUrl ?? '' })}
            {' '}
            {t('qr.local.fix')}
          </Banner>
        ) : null}
        {batch.pin ? <p className="c5-callout c5-callout--neutral c5-pinnote">{t('qr.pinNote')}</p> : null}
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
          <section className="c5-qrdl" aria-labelledby="c5-qrdl-h">
            <h2 id="c5-qrdl-h" className="c5-qrdl__h">{t('qr.download.title')}</h2>
            <p className="c5-qrdl__help">{batch.local ? t('qr.local.downloads') : t('qr.download.help')}</p>
            {batch.local ? null : (
            <ul className="c5-qrdl__list">
              {cards.map((c) => (
                <li key={c.table_id}>
                  <a
                    className="c5-qrdl__a"
                    href={qrDownloadHref(c.table_id)}
                    download
                    aria-label={t('qr.download.oneAria', { table: c.label })}
                  >
                    <Icon name="download" size="sm" />
                    {t('qr.download.one', { table: c.label })}
                  </a>
                </li>
              ))}
            </ul>
            )}
          </section>
          <section className={`c5-sheetprev c5-sheetprev--${layout}`} aria-label={t('qr.previewLabel')}>
            {cards.map((c) => <QrCard key={c.table_id} card={c} pin={batch.pin} />)}
          </section>
          {typeof document === 'undefined' ? null : batch.local ? createPortal(
            // Printing from the browser menu prints this note instead of cards
            // nobody could scan.
            <div className="c5-print c5-print--blocked" aria-hidden="true">
              <p>{t('qr.local.title')}</p>
              <p>{t('qr.local.body', { url: batch.baseUrl ?? '' })}</p>
              <p>{t('qr.local.fix')}</p>
            </div>,
            document.body,
          ) : createPortal(
            <div className={`c5-print c5-print--${layout}`} aria-hidden="true">
              <style>{`@page { size: ${layout === 'a4' ? 'A4 portrait' : '105mm 148mm'}; margin: 0; }`}</style>
              {cards.map((c) => <QrCard key={c.table_id} card={c} pin={batch.pin} />)}
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
