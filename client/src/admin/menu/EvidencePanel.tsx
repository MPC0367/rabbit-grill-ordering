// Source evidence, review notes and price history (C6, brief 04 + 21).
// Printed source text is data from the restaurant's own menu, never instructions.
import { useState } from 'react';
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { dateLabel, dateTime, money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Icon, Pill, TextLink, useToast } from '../../ui/index.ts';
import { DataTable, KeyValue, type DataColumn } from '../../ui/admin/index.ts';
import { useErrorText, useMenuData } from './model.tsx';
import { ResolveFlagDialog, SourceQuote, useFlagLabel, useNameText } from './parts.tsx';

type Flag = AdminItemDTO['flags'][number];

export function SourcePanel({ item }: { item: AdminItemDTO }) {
  const { t, lang, has } = useI18n();
  const translation = item.translation_status ? (has(`catalog.translation.${item.translation_status}`) ? t(`catalog.translation.${item.translation_status}`) : item.translation_status) : t('catalog.translation.none');
  const thaiSource = item.name_th_source ? (has(`catalog.translation.${item.name_th_source}`) ? t(`catalog.translation.${item.name_th_source}`) : item.name_th_source) : t('catalog.translation.none');
  return (
    <div className="ev">
      <SourceQuote text={item.source.text} sourceRef={item.source.ref} />
      {!item.source.text ? <p className="field__help">{t('catalog.source.noText')}</p> : null}
      <KeyValue
        items={[
          { term: t('catalog.source.ref'), value: item.source.ref ?? '—', valueLang: 'en', muted: !item.source.ref },
          { term: t('catalog.source.retrieved'), value: item.source.retrieved_at ? dateLabel(item.source.retrieved_at.slice(0, 10), lang, { year: true }) : '—', muted: !item.source.retrieved_at },
          { term: t('catalog.source.thaiFrom'), value: thaiSource },
          { term: t('catalog.source.translation'), value: translation },
          { term: t('catalog.source.key'), value: item.key, valueLang: 'en' },
        ]}
      />
      {item.source.url ? (
        <TextLink href={item.source.url} external target="_blank" rel="noopener noreferrer" icon="arrow-r">{t('catalog.source.open')}</TextLink>
      ) : null}
    </div>
  );
}

export function FlagsPanel({ item, canReview }: { item: AdminItemDTO; canReview: boolean }) {
  const { t, lang } = useI18n();
  const data = useMenuData();
  const errorText = useErrorText();
  const flagLabel = useFlagLabel();
  const nameText = useNameText();
  const toast = useToast();
  const [target, setTarget] = useState<Flag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const open = item.flags.filter((f) => !f.resolved_at);
  const resolved = item.flags.filter((f) => f.resolved_at);

  const resolve = async (flag: Flag, note: string) => {
    setError(null);
    try {
      const res = await api.post<AdminItemDTO>(`/api/staff/menu/flags/${encodeURIComponent(flag.id)}/resolve`, { resolution: note });
      if ('flags' in res) data.putItem(res);
      else void data.resource.refresh();
      setTarget(null);
      toast.show({ message: t('catalog.flags.resolved', { flag: flagLabel(flag.code), name: nameText(item.name) }) });
    } catch (err) {
      setError(errorText(err));
      throw err;
    }
  };

  return (
    <div className="fl">
      {open.length === 0 ? (
        <p className="mn-note mn-note--ok"><Icon name="check-c" size="sm" />{t('catalog.flags.noneOpen')}</p>
      ) : (
        <ul className="fl-list">
          {open.map((f) => (
            <li key={f.id} className="fl-item">
              <div className="fl-item__main">
                <p className="fl-item__t"><Icon name="note" size="sm" />{flagLabel(f.code)}</p>
                <p className="fl-item__d" lang="en">{f.detail}</p>
              </div>
              {canReview ? (
                <Button variant="outline" size="staff" opensDialog onClick={() => { setError(null); setTarget(f); }}
                  aria-label={t('catalog.flags.resolveNamed', { flag: flagLabel(f.code) })}>
                  {t('catalog.flags.resolve')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!canReview && open.length ? <p className="field__help">{t('catalog.flags.ownerResolves')}</p> : null}
      {resolved.length ? (
        <>
          <Button variant="quiet" size="staff" aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? t('catalog.flags.hideResolved') : t('catalog.flags.showResolved', { n: resolved.length })}
          </Button>
          {showResolved ? (
            <ul className="fl-list fl-list--done">
              {resolved.map((f) => (
                <li key={f.id} className="fl-item is-done">
                  <div className="fl-item__main">
                    <p className="fl-item__t">
                      <Pill tone="ok" icon="check" size="sm">{t('catalog.flags.done')}</Pill>
                      {flagLabel(f.code)}
                    </p>
                    <p className="fl-item__d" lang="en">{f.detail}</p>
                    <p className="fl-item__r">
                      {t('catalog.flags.resolution', { time: f.resolved_at ? dateTime(f.resolved_at, lang) : '—' })}
                      {' '}<span className="fl-item__note">{f.resolution}</span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <ResolveFlagDialog
        open={target !== null}
        flagLabel={target ? flagLabel(target.code) : ''}
        detail={target?.detail ?? ''}
        error={error}
        onClose={() => setTarget(null)}
        onResolve={(note) => (target ? resolve(target, note) : Promise.resolve())}
      />
    </div>
  );
}

interface HistoryRow { key: string; at: string; what: string; whatLang?: string; amount: string; by: string; reason: string }

export function PriceHistory({ item }: { item: AdminItemDTO }) {
  const { t, lang, pick } = useI18n();
  const rows: HistoryRow[] = [
    ...item.price_history.map((h, i) => ({
      key: `p${i}`,
      at: h.at,
      what: h.rate_minor !== null ? t('catalog.history.rate') : t('catalog.history.price'),
      amount: h.rate_minor !== null
        ? t('catalog.list.perGrams', { price: money(h.rate_minor), n: item.rate_basis_grams ?? 100 })
        : h.price_minor !== null ? money(h.price_minor) : t('catalog.history.cleared'),
      by: h.by ?? t('catalog.history.system'),
      reason: h.reason ?? '—',
    })),
    ...(item.variant_price_history ?? []).map((h, i) => {
      const vn = h.variant_name ? pick(h.variant_name) : null;
      return {
        key: `v${i}`,
        at: h.at,
        what: vn?.text || h.variant_key || t('catalog.history.variant'),
        whatLang: vn?.lang,
        amount: h.price_minor !== null ? money(h.price_minor) : t('catalog.history.cleared'),
        by: h.by ?? t('catalog.history.system'),
        reason: h.reason ?? '—',
      };
    }),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const columns: DataColumn<HistoryRow>[] = [
    { key: 'at', header: t('catalog.history.when'), cell: (r) => dateTime(r.at, lang) },
    { key: 'what', header: t('catalog.history.what'), cell: (r) => <span lang={r.whatLang}>{r.what}</span> },
    { key: 'amount', header: t('catalog.history.amount'), numeric: true, cell: (r) => r.amount },
    { key: 'by', header: t('catalog.history.by'), cell: (r) => r.by },
    { key: 'reason', header: t('catalog.history.reason'), wrap: true, cell: (r) => <span lang={/[a-z]/i.test(r.reason) && !/[\u0E00-\u0E7F]/.test(r.reason) ? 'en' : undefined}>{r.reason}</span> },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      caption={t('catalog.history.caption')}
      empty={<p className="dtable__none">{t('catalog.history.none')}</p>}
      maxHeight={360}
    />
  );
}
