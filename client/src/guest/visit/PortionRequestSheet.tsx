// "ขอให้พนักงานชั่ง" (brief 44A, DECISIONS D-08, D-22): a measured-weight cut
// is requested, never added to the draft. The sheet shows the verified rate
// and its basis, explains that staff weigh and the guest confirms before
// anything is grilled, and takes an optional preferred weight (free grams,
// no presets) and a note. Idempotent per attempt.
import { useEffect, useId, useRef, useState } from 'react';
import type { OrderDTO, PortionRequestDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  Button, EmptyState, Icon, Leader, PortionQuote, Price, Sheet, Skeleton, TextArea, TextField, TextLink, announce,
} from '../../ui/index.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { useGuestSession } from '../shell/session.tsx';
import { useAccessFailure, useVisitResource } from './hooks.ts';
import { attemptKey, closeThenNavigate, detailOf, errorWords, settleKey, settleUnlessAmbiguous } from './lib.ts';
import { PREFERRED_GRAMS } from './limits.ts';
import NoAccessPanel from './NoAccessPanel.tsx';
import './visit.css';

const NOTE_MAX = 200;

/** The server's own bounds for a preferred weight (validation only, never a suggestion). */
const BOUNDS = PREFERRED_GRAMS;

/** The restaurant turned preferred weights off (learned from the server this session). */
let preferredDisabled = false;

export default function PortionRequestSheet({ itemId, onClose }: { itemId: string; onClose(): void }) {
  const { t, pick, lang, has } = useI18n();
  const { item, loading: catalogLoading } = useCatalog();
  const { mode, session, endedReason } = useGuestSession();
  const failure = useAccessFailure();
  const visitId = mode === 'joined' && session ? session.visit.id : null;
  const it = item(itemId);
  const table = useVisitResource<{ orders: OrderDTO[]; portions: PortionRequestDTO[] }>(visitId ? '/api/guest/orders' : null, ['portion.']);

  const [gramsText, setGramsText] = useState('');
  const [note, setNote] = useState('');
  const [preferredOff, setPreferredOff] = useState(preferredDisabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gramsError, setGramsError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [sent, setSent] = useState<PortionRequestDTO | null>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => { if (sent) doneRef.current?.focus(); }, [sent]);

  const name = it ? pick(it.name) : null;
  const english = it && lang === 'th' && it.name.en && it.name.en !== name?.text ? it.name.en : null;
  const title = name?.text || t('common.priceByWeight');

  if (!visitId) {
    return (
      <Sheet open onClose={onClose} title={title}>
        <NoAccessPanel reason={mode === 'ended' ? (endedReason === 'visit_access_revoked' ? 'revoked' : 'required') : 'public'} compact />
      </Sheet>
    );
  }

  if (!it) {
    return (
      <Sheet open onClose={onClose} title={t('common.priceByWeight')}>
        {catalogLoading ? (
          <div role="status" aria-live="polite">
            <span className="visually-hidden">{t('portion.loading')}</span>
            <Skeleton lines={4} />
          </div>
        ) : (
          <EmptyState icon="info" compact title={t('portion.notFound')} />
        )}
      </Sheet>
    );
  }

  const rate = it.rate_minor;
  const basis = it.rate_basis_grams ?? 100;
  const measured = it.pricing_type === 'measured_weight';
  const canRequest = measured && rate !== null && it.orderable && !unavailable;
  const open = (table.data?.portions ?? []).filter((p) => p.item_id === itemId && (p.status === 'requested' || p.status === 'quoted'));

  const submit = async () => {
    if (busy || !canRequest) return;
    setError(null);
    setGramsError(null);
    let preferred: number | null = null;
    const raw = gramsText.trim();
    if (raw && !preferredOff) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < BOUNDS.min || n > BOUNDS.max) {
        setGramsError(t('portion.preferredRange', { min: BOUNDS.min.toLocaleString('en-US'), max: BOUNDS.max.toLocaleString('en-US') }));
        return;
      }
      preferred = n;
    }
    const scope = `portion.${visitId}.${itemId}`;
    const body: Record<string, unknown> = { item_id: itemId, idempotency_key: attemptKey(scope) };
    if (preferred !== null) body.preferred_grams = preferred;
    if (note.trim()) body.note = note.trim();
    const post = async (payload: Record<string, unknown>) => {
      const r = await api.post<PortionRequestDTO>('/api/guest/portions', payload);
      settleKey(scope);
      setSent(r);
      announce(t('portion.sentTitle'));
      void table.refresh();
    };
    setBusy(true);
    try {
      await post(body);
    } catch (first) {
      let err: unknown = first;
      settleUnlessAmbiguous(scope, err);
      // The restaurant does not take a preferred weight: send the request without it.
      if (err instanceof ApiError && err.code === 'bad_request' && detailOf<string>(err, 'reason') === 'preferred_weight_disabled') {
        preferredDisabled = true;
        setPreferredOff(true);
        setGramsText('');
        const { preferred_grams: _drop, ...rest } = body;
        try {
          await post({ ...rest, idempotency_key: attemptKey(scope) });
          return;
        } catch (second) {
          settleUnlessAmbiguous(scope, second);
          err = second;
        }
      }
      if (failure(err)) return;
      const reason = detailOf<string>(err, 'reason');
      if (err instanceof ApiError && err.code === 'bad_request' && reason === 'preferred_weight_disabled') {
        setError(t('portion.preferredOff'));
      } else if (err instanceof ApiError && err.code === 'validation_failed') {
        setGramsError(t('portion.preferredRange', { min: BOUNDS.min.toLocaleString('en-US'), max: BOUNDS.max.toLocaleString('en-US') }));
      } else if (err instanceof ApiError && (err.code === 'item_unavailable' || reason === 'not_measured_weight' || err.code === 'not_found')) {
        setUnavailable(true);
        setError(t('portion.notAvailable'));
      } else {
        setError(errorWords(t, has, err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Sheet
        open
        onClose={onClose}
        langSwitch
        title={title}
        footer={(
          <div className="vsheet__foot">
            <Button variant="primary" size="lg" icon="track" onClick={() => closeThenNavigate(onClose, '/menu/orders')}>{t('portion.goTrack')}</Button>
            <Button variant="outline" size="lg" onClick={onClose}>{t('portion.backMenu')}</Button>
          </div>
        )}
      >
        <div className="vsheet">
          <div className="vsheet__done" role="status">
            <span className="vjoin__mark vjoin__mark--ok" aria-hidden="true"><Icon name="check" /></span>
            <h3 ref={doneRef} tabIndex={-1}>{t('portion.sentTitle')}</h3>
            <p>{t('portion.sentBody', { name: name?.text ?? '' })}</p>
          </div>
          <PortionQuote
            state="requested"
            name={name!}
            secondary={english ? { text: english, lang: 'en', fallback: false } : null}
            rateMinor={rate}
            basisGrams={basis}
          >
            {sent.preferred_grams ? (
              <div className="vquote__extra">
                <Leader label={t('portion.preferredShown')} value={`${sent.preferred_grams.toLocaleString('en-US')} ${t('portion.gramsUnit')}`} />
              </div>
            ) : null}
          </PortionQuote>
        </div>
      </Sheet>
    );
  }

  const reasonWords = !measured ? t('portion.notAvailable')
    : rate === null ? t('portion.ratePending')
      : !it.orderable ? (it.sold_out ? t('common.soldOut') : t('portion.notAvailable'))
        : null;

  return (
    <Sheet
      open
      onClose={onClose}
      langSwitch
      title={title}
      describedBy={`${titleId}-steps`}
      footer={canRequest ? (
        <div className="vsheet__foot vsheet__foot--one">
          <Button variant="primary" size="lg" icon="scale" loading={busy} onClick={() => void submit()}>
            {open.length ? t('portion.askAnother') : t('common.askToWeigh')}
          </Button>
        </div>
      ) : undefined}
    >
      <div className="vsheet" data-item={itemId}>
        {english ? <p className="en vsheet__en" lang="en">{english}</p> : null}
        {name?.fallback && lang === 'th' ? <p className="venonly vsheet__en">{t('common.enOnly')}</p> : null}
        <div className="vsheet__rate">
          <p className="quote__k"><Icon name="scale" size="sm" />{t('common.priceByWeight')}</p>
          {rate !== null ? (
            <Leader label={t('common.portion.rate', { n: basis })} value={<Price minor={rate} />} />
          ) : (
            <p className="support">{t('portion.ratePending')}</p>
          )}
        </div>

        {reasonWords ? (
          <p className="vnote vnote--alert" role="status"><Icon name="slash" /><span className="vnote__body">{reasonWords}</span></p>
        ) : null}

        {open.length ? (
          <p className="vnote">
            <Icon name="info" />
            <span className="vnote__body">
              <span>{t('portion.openExisting', { name: name?.text ?? '' })}</span>
              <span className="vnote__link"><TextLink href="/menu/orders" onClick={(e) => { e.preventDefault(); closeThenNavigate(onClose, '/menu/orders'); }}>
                {t('portion.goTrack')}
              </TextLink></span>
            </span>
          </p>
        ) : null}

        <div id={`${titleId}-steps`}>
          <p className="vsteps__t">{t('portion.stepsTitle')}</p>
          <ol className="vsteps">
            <li>{t('portion.step1')}</li>
            <li>{t('portion.step2')}</li>
            <li>{t('portion.step3')}</li>
          </ol>
        </div>

        {canRequest ? (
          <>
            {preferredOff ? (
              <p className="vnote"><Icon name="info" /><span className="vnote__body">{t('portion.preferredOff')}</span></p>
            ) : (
              <TextField
                label={t('portion.preferred')}
                optional
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                value={gramsText}
                onChange={(e) => { setGramsText(e.target.value.replace(/[^\d]/g, '').slice(0, 6)); setGramsError(null); }}
                suffix={t('portion.gramsUnit')}
                help={t('portion.preferredHelp')}
                error={gramsError}
              />
            )}
            <TextArea
              label={t('portion.note')}
              optional
              value={note}
              onChange={setNote}
              limit={NOTE_MAX}
              rows={2}
              help={t('portion.noteHelp')}
            />
          </>
        ) : null}

        {error ? (
          <p className="vnote vnote--alert" role="alert"><Icon name="alert" /><span className="vnote__body">{error}</span></p>
        ) : null}
      </div>
    </Sheet>
  );
}
