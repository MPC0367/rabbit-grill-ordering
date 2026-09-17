// Seat guests (brief 20, 36): optional diner count (unknown is a real answer),
// open the visit idempotently, then show the join PIN large for the guests.
import { useEffect, useId, useRef, useState } from 'react';
import type { TableTileDTO, VisitDetailDTO } from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Sheet, TextField, useAnnounce, useToast } from '../../ui/index.ts';
import { errorText, isAmbiguous, isApiError, pendingKey, tn } from './shared.ts';

// ------------------------------------------------------------------ covers picker
interface CoversProps {
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  help?: string;
}

const QUICK = [1, 2, 3, 4, 5, 6, 7, 8];

/** Diner count: "Not counted" or 1-8 in one tap, 9+ typed. */
export function CoversPicker({ value, onChange, label, help }: CoversProps) {
  const { t } = useI18n();
  const [more, setMore] = useState(value !== null && value > QUICK.length);
  const [typed, setTyped] = useState(value !== null && value > QUICK.length ? String(value) : '');
  const labelId = useId();
  const helpId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (more) inputRef.current?.focus(); }, [more]);
  const typedNumber = Number(typed);
  const typedError = more && typed !== '' && (!Number.isInteger(typedNumber) || typedNumber < 1 || typedNumber > 99) ? t('tables.covers.range') : undefined;
  return (
    <div className="c5-covers">
      <p className="field__label" id={labelId}>{label}</p>
      <div className="c5-choice" role="group" aria-labelledby={labelId} aria-describedby={help ? helpId : undefined}>
        <button type="button" className="c5-choice__wide" aria-pressed={value === null && !more} onClick={() => { setMore(false); onChange(null); }}>
          {t('tables.covers.unknown')}
        </button>
        {QUICK.map((n) => (
          <button key={n} type="button" className="num" aria-pressed={!more && value === n} onClick={() => { setMore(false); onChange(n); }}>
            {n}
          </button>
        ))}
        <button type="button" className="c5-choice__wide" aria-pressed={more} onClick={() => { setMore(true); const n = Number(typed); onChange(Number.isInteger(n) && n >= 1 && n <= 99 ? n : null); }}>
          {t('tables.covers.more')}
        </button>
      </div>
      {more ? (
        <TextField
          ref={inputRef}
          className="c5-block--tight"
          density="staff"
          label={t('tables.covers.typed')}
          inputMode="numeric"
          autoComplete="off"
          value={typed}
          error={typedError}
          onChange={(e) => {
            const s = e.target.value.replace(/\D/g, '').slice(0, 2);
            setTyped(s);
            const n = Number(s);
            onChange(s !== '' && n >= 1 && n <= 99 ? n : null);
          }}
        />
      ) : null}
      {help ? <p className="field__help" id={helpId}>{help}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ PIN display
export function BigPin({ pin }: { pin: string }) {
  const { t } = useI18n();
  const digits = Array.from(pin);
  return (
    <p className="c5-bigpin" role="img" aria-label={t('common.access.pinIs', { pin: digits.join(' ') })}>
      {digits.map((d, i) => <span key={i} aria-hidden="true">{d}</span>)}
    </p>
  );
}

// ------------------------------------------------------------------ seat dialog
interface SeatProps {
  tile: TableTileDTO;
  onClose: () => void;
  /** After a successful open (or when another device already seated the table). */
  onChanged: () => void;
  onOpenDetails: (tile: TableTileDTO) => void;
}

export default function SeatDialog({ tile, onClose, onChanged, onOpenDetails }: SeatProps) {
  const { t } = useI18n();
  const toast = useToast();
  const announce = useAnnounce();
  const [covers, setCovers] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [opened, setOpened] = useState<VisitDetailDTO | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const label = tile.label;

  useEffect(() => {
    if (opened) doneRef.current?.focus();
  }, [opened]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    const k = pendingKey(`seat.${tile.id}`, 10 * 60_000);
    setBusy(true);
    try {
      const detail = await api.post<VisitDetailDTO>(`/api/staff/tables/${encodeURIComponent(tile.id)}/visits`, {
        covers,
        idempotency_key: k.key(),
      });
      k.clear();
      setOpened(detail);
      announce(t('tables.seat.openedSpoken', { table: label }));
      onChanged();
    } catch (err) {
      if (isAmbiguous(err)) {
        setError(t('tables.seat.ambiguous'));
      } else {
        k.clear();
        if (isApiError(err, 'conflict')) {
          setTaken(true);
          setError(t('tables.seat.taken', { table: label }));
          onChanged();
        } else {
          setError(errorText(t, err));
          if (isApiError(err, 'table_disabled', 'not_found')) onChanged();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (opened) {
    const pin = opened.join_pin;
    return (
      <Sheet
        open
        onClose={onClose}
        variant="dialog"
        head={(
          <div className="sheet__head c5-seat__head">
            <h2 ref={titleRef} id={`c5-seat-${tile.id}`}>{t('tables.seat.openedTitle', { table: label })}</h2>
          </div>
        )}
        labelledBy={`c5-seat-${tile.id}`}
        footerAlign="end"
        footer={(
          <>
            <Button variant="outline" size="staff" onClick={() => { onClose(); onOpenDetails(tile); }}>{t('tables.seat.details')}</Button>
            <Button ref={doneRef} variant="primary" size="staff" onClick={() => { onClose(); toast.show(t('tables.seat.toast', { table: label })); }}>{t('common.done')}</Button>
          </>
        )}
      >
        {pin ? (
          <div className="c5-seat__pin">
            <p className="c5-cap">{t('common.access.pin')}</p>
            <BigPin pin={pin} />
            <p className="c5-note">{t('tables.seat.pinHelp')}</p>
          </div>
        ) : (
          <p className="c5-callout c5-callout--neutral">{t('tables.seat.noPin')}</p>
        )}
        <p className="c5-kvline c5-block">
          <span>{t('tables.covers.label')}</span>
          <b className={opened.covers === null ? 'c5-muted' : undefined}>{opened.covers === null ? t('tables.covers.notRecorded') : tn(t, 'tables.covers.n', opened.covers)}</b>
        </p>
        <p className="c5-note c5-block--tight">{t('tables.seat.pinLater')}</p>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      variant="dialog"
      title={t('tables.seat.title', { table: label })}
      dismissible={!busy}
      footerAlign="end"
      footer={(
        <>
          <Button variant="outline" size="staff" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {taken ? (
            <Button variant="primary" size="staff" onClick={() => { onClose(); onOpenDetails(tile); }}>{t('tables.seat.details')}</Button>
          ) : (
            <Button variant="primary" size="staff" icon="seat" loading={busy} onClick={() => void submit()}>
              {t('tables.seat.confirm', { table: label })}
            </Button>
          )}
        </>
      )}
    >
      <p className="sheet__lede">{t('tables.seat.lede')}</p>
      <div className="c5-block">
        <CoversPicker value={covers} onChange={setCovers} label={t('tables.covers.question')} help={t('tables.covers.help')} />
      </div>
      {error ? <p className="field__error c5-block" role="alert">{error}</p> : null}
    </Sheet>
  );
}
