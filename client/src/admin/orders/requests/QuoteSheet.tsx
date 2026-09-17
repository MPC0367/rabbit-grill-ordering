// Weigh and quote a measured-weight cut (brief 44A steps 4 and 8): weighed
// grams in a large keypad field, the approved rate, a live amount from the
// shared money module, optional choices, expiry and a note for the guest.
import { useMemo, useRef, useState } from 'react';
import type { MenuItemDTO, PortionRequestDTO } from '../../../../../shared/dto.ts';
import { allocateGroupPicks, measuredAmount } from '../../../../../shared/money.ts';
import { api } from '../../../lib/api.ts';
import { grams as gramsLabel, money } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import {
  Button, ChoiceGroup, Icon, RadioCard, Sheet, TextArea, TextField, useAnnounce, useToast,
} from '../../../ui/index.ts';
import { errorText, staleCurrent, staffName, toApiError } from '../support.ts';

const MAX_GRAMS = 10_000;

export function QuoteSheet({ req, item, onClose, onDone, onStale }: {
  req: PortionRequestDTO;
  /** Catalog entry (for choices); may be missing when the cut left the public menu. */
  item: MenuItemDTO | undefined;
  onClose: () => void;
  onDone: (next: PortionRequestDTO) => void;
  onStale: (current: PortionRequestDTO | null) => void;
}) {
  const { t, lang, pick } = useI18n();
  const toast = useToast();
  const announce = useAnnounce();
  const active = req.quote && req.quote.status === 'active' ? req.quote : null;
  const previous = req.quote ?? null;
  // Re-quoting a live quote starts from its weight (selected, so a new reading replaces it).
  // After an expired or withdrawn quote the cut is weighed again from an empty field.
  const [gramsText, setGramsText] = useState(active ? String(active.grams) : '');
  const [picks, setPicks] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const g of item?.modifier_groups ?? []) {
      const chosen = previous?.choices.find((c) => (c.group.en ?? c.group.th) === (g.name.en ?? g.name.th));
      init[g.id] = chosen
        ? g.options.filter((o) => chosen.options.some((x) => (x.name.en ?? x.name.th) === (o.name.en ?? o.name.th))).map((o) => o.id)
        : g.options.filter((o) => o.is_default && o.available).map((o) => o.id);
    }
    return init;
  });
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState(previous?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gramsError, setGramsError] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const gramsRef = useRef<HTMLInputElement>(null);

  const rate = req.current_rate ?? null;
  const n = staffName(req.item_name);
  const g = /^\d+$/.test(gramsText.trim()) ? Number(gramsText.trim()) : null;
  const gramsOk = g !== null && g >= 1 && g <= MAX_GRAMS;
  const gramsOut = g !== null && !gramsOk;

  const choicesMinor = useMemo(() => (item?.modifier_groups ?? []).reduce((sum, grp) => (
    sum + allocateGroupPicks(grp.options, picks[grp.id] ?? [], grp.included_count).reduce((s, p) => s + p.charged_minor, 0)
  ), 0), [item, picks]);
  const measured = gramsOk && rate ? measuredAmount(g!, rate.rate_minor, rate.rate_basis_grams) : null;
  const amount = measured !== null ? measured + choicesMinor : null;

  const submit = async () => {
    setError(null);
    if (!rate) { setError(t('requests.quote.noRate')); return; }
    if (!gramsOk) {
      setGramsError(t('requests.quote.gramsInvalid', { max: MAX_GRAMS.toLocaleString('en-US') }));
      gramsRef.current?.focus();
      return;
    }
    for (const grp of item?.modifier_groups ?? []) {
      const count = (picks[grp.id] ?? []).length;
      if (count < grp.min_select || count > grp.max_select) {
        setGroupError(grp.id);
        return;
      }
    }
    const exp = expires.trim() ? Number(expires.trim()) : null;
    if (exp !== null && (!Number.isInteger(exp) || exp < 1 || exp > 120)) { setError(t('requests.quote.expiresInvalid')); return; }
    setBusy(true);
    try {
      const next = await api.post<PortionRequestDTO>(`/api/staff/portions/${req.id}/quote`, {
        grams: g,
        choices: Object.entries(picks).filter(([, ids]) => ids.length > 0).map(([group_id, option_ids]) => ({ group_id, option_ids })),
        note: note.trim() || null,
        expires_minutes: exp,
        version: req.version,
      });
      const words = t('requests.quote.sent', { table: req.table_label, grams: gramsLabel(g!, lang), amount: money(next.quote?.amount_minor ?? amount ?? 0) });
      announce(words);
      toast.show({ message: words });
      onDone(next);
      onClose();
    } catch (err) {
      const e = toApiError(err);
      if (e.code === 'stale_version' || e.code === 'invalid_transition' || e.code === 'already_done') {
        onStale(staleCurrent<PortionRequestDTO>(err));
        toast.show({ message: t('orders.toast.stale'), tone: 'info' });
        onClose();
        return;
      }
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      dismissible={!busy}
      wide
      className="qsheet"
      title={active ? t('requests.quote.reTitle', { table: req.table_label }) : t('requests.quote.title', { table: req.table_label })}
      initialFocus={gramsRef}
      footer={(
        <Button variant="primary" size="staff" icon="scale" loading={busy} onClick={() => void submit()} aria-describedby="qsheet-amount">
          {active ? t('requests.quote.sendNew') : t('requests.quote.send')}
          {amount !== null ? ` · ${money(amount)}` : ''}
        </Button>
      )}
    >
      <div className="qsheet__dish">
        <p className="qsheet__name" lang={n.lang}>{n.text}</p>
        {n.secondary ? <p className="qsheet__en" lang="en">{n.secondary}</p> : null}
        <p className="qsheet__meta">
          {rate
            ? t('requests.quote.rate', { amount: money(rate.rate_minor), n: rate.rate_basis_grams })
            : <span className="is-alert"><Icon name="alert" size="sm" /> {t('requests.quote.noRate')}</span>}
          {req.preferred_grams ? ` · ${t('requests.quote.preferred', { grams: gramsLabel(req.preferred_grams, lang) })}` : ''}
        </p>
        {req.note ? <p className="qsheet__meta">{t('requests.quote.guestNote', { note: req.note })}</p> : null}
        {previous && !active ? (
          <p className="qsheet__meta">{t('requests.quote.lastWeighed', { grams: gramsLabel(previous.grams, lang), rev: previous.revision })}</p>
        ) : null}
        {active ? (
          <p className="qsheet__replace" role="note">
            <Icon name="refresh" size="sm" />
            {t('requests.quote.replaces', { rev: active.revision, grams: gramsLabel(active.grams, lang), amount: money(active.amount_minor) })}
          </p>
        ) : null}
      </div>

      <div className="qsheet__weigh">
        <TextField
          ref={gramsRef}
          className="qsheet__grams"
          density="staff"
          label={t('requests.quote.grams')}
          help={t('requests.quote.gramsHelp')}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          enterKeyHint="done"
          suffix={t('requests.quote.unit')}
          value={gramsText}
          error={gramsError ?? undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => { setGramsText(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 5)); setGramsError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
        <output className="qsheet__amount" id="qsheet-amount">
          <span className="qsheet__amount-k">{t('requests.quote.amount')}</span>
          <b>{amount !== null ? money(amount) : '—'}</b>
          <small>
            {measured !== null && rate
              ? t('requests.quote.math', { grams: gramsLabel(g!, lang), rate: money(rate.rate_minor), n: rate.rate_basis_grams })
              : gramsOut
                ? <span className="is-alert">{t('requests.quote.gramsInvalid', { max: MAX_GRAMS.toLocaleString('en-US') })}</span>
                : t('requests.quote.enterGrams')}
            {choicesMinor > 0 ? ` · ${t('requests.quote.choicesAdd', { amount: money(choicesMinor) })}` : ''}
          </small>
        </output>
      </div>

      {(item?.modifier_groups ?? []).map((grp) => {
        const name = pick(grp.name);
        const chosen = picks[grp.id] ?? [];
        const single = grp.max_select === 1;
        const allocation = allocateGroupPicks(grp.options, chosen, grp.included_count);
        return (
          <ChoiceGroup
            key={grp.id}
            className="sheet__block"
            legend={<span lang={name.lang}>{name.text}</span>}
            required={grp.min_select > 0}
            satisfied={chosen.length >= grp.min_select}
            rule={grp.max_select > 1 ? t('assist.rule.max', { n: grp.max_select }) : t('assist.rule.one')}
            error={groupError === grp.id ? t('assist.rule.error', { min: grp.min_select, max: grp.max_select }) : undefined}
          >
            {grp.options.map((o) => {
              const on = chosen.includes(o.id);
              const on2 = allocation.find((a) => a.id === o.id);
              const label = pick(o.name);
              const aside = !o.available ? undefined
                : on2 ? (on2.charged_minor ? `+${money(on2.charged_minor)}` : t('common.included'))
                : o.price_delta_minor ? `+${money(o.price_delta_minor)}` : t('common.included');
              return (
                <RadioCard
                  key={o.id}
                  type={single ? 'radio' : 'checkbox'}
                  name={`q-${grp.id}`}
                  label={<span lang={label.lang}>{label.text}</span>}
                  aside={aside}
                  checked={on}
                  disabled={!o.available}
                  onChange={() => {
                    setGroupError(null);
                    setPicks((p) => {
                      const cur = p[grp.id] ?? [];
                      const next = single ? [o.id] : on ? cur.filter((x) => x !== o.id) : cur.length >= grp.max_select ? cur : [...cur, o.id];
                      return { ...p, [grp.id]: next };
                    });
                  }}
                />
              );
            })}
          </ChoiceGroup>
        );
      })}

      <div className="qsheet__more">
        <TextField
          density="staff"
          label={t('requests.quote.expires')}
          optional
          help={t('requests.quote.expiresHelp')}
          inputMode="numeric"
          suffix={t('common.ticket.min')}
          value={expires}
          onChange={(e) => setExpires(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 3))}
        />
        <TextArea
          density="staff"
          label={t('requests.quote.note')}
          optional
          help={t('requests.quote.noteHelp')}
          value={note}
          onChange={setNote}
          limit={200}
        />
      </div>
      {error ? <p className="field__error sheet__block" role="alert"><Icon name="alert" /><span>{error}</span></p> : null}
    </Sheet>
  );
}
