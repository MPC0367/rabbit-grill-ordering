// Review queue (C6, brief 04 + 34 + 44): the import audit as counters, then
// grouped work lists with the printed source text and quick actions. Makes it
// plain that live ordering only offers owner-verified dishes.
import { useMemo, useState } from 'react';
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useConfig } from '../../lib/config.tsx';
import { dateTime, money, num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Dialog, Icon, LinkButton, Tag, useToast } from '../../ui/index.ts';
import { CheckButton, StatCard, StatGrid } from '../../ui/admin/index.ts';
import { wouldDisappearInLive } from './attention.ts';
import { itemHref, useCan, useErrorText, useMenuData } from './model.tsx';
import {
  DataNotices, Disclosure, ItemName, ItemStatusPill, ListSkeleton, LoadFailed, ResolveFlagDialog, ReviewPill, SourceQuote,
  Thumb, useFlagLabel, useNameText,
} from './parts.tsx';

type Flag = AdminItemDTO['flags'][number];

interface WorkList {
  id: string;
  codes: string[];
  open?: boolean;
  lede?: boolean;
}

/** Order of the work lists; codes not listed fall into "other". */
const LISTS: WorkList[] = [
  { id: 'ambiguous', codes: ['ambiguous_price'], open: true, lede: true },
  { id: 'owner', codes: ['needs_owner_explanation'], open: true, lede: true },
  { id: 'duplicates', codes: ['duplicate_name'], open: true, lede: true },
  { id: 'seasonal', codes: ['seasonal_unconfirmed'], open: true, lede: true },
  { id: 'promotion', codes: ['promotion_not_active'], open: true, lede: true },
  { id: 'alcohol', codes: ['alcohol_requires_staff'], lede: true },
  { id: 'rules', codes: ['measured_weight', 'unspecified_variant', 'volume_in_wrong_field', 'demo_modifier_attachment'], lede: true },
  { id: 'thai', codes: ['missing_thai_name', 'thai_is_site_translation'], lede: true },
  { id: 'typos', codes: ['typo_corrected', 'possible_typo'], lede: true },
  { id: 'photos', codes: ['missing_image'], lede: true },
  { id: 'descriptions', codes: ['missing_description'], lede: true },
];
const KNOWN = new Set(LISTS.flatMap((l) => l.codes));

interface Row { item: AdminItemDTO; flag: Flag }

export default function ReviewTab() {
  const { t } = useI18n();
  const data = useMenuData();
  const { config } = useConfig();
  const can = useCan();
  const canReview = can('menu.review');
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState<Row | null>(null);
  const [verifying, setVerifying] = useState<AdminItemDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorText = useErrorText();
  const flagLabel = useFlagLabel();
  const nameText = useNameText();
  const toast = useToast();
  const { catalog } = data;
  const live = config?.operating_mode === 'live';

  const categoryOrder = useMemo(() => {
    const order = new Map<string, number>();
    let n = 0;
    for (const g of ['food', 'drinks'] as const) for (const c of data.categoriesOf(g)) order.set(c.id, n++);
    return order;
  }, [data]);

  const lists = useMemo(() => {
    const byList = new Map<string, Row[]>();
    for (const item of data.items) {
      for (const flag of item.flags) {
        if (flag.resolved_at && !showResolved) continue;
        const list = LISTS.find((l) => l.codes.includes(flag.code))?.id ?? (KNOWN.has(flag.code) ? null : 'other');
        if (!list) continue;
        const rows = byList.get(list);
        if (rows) rows.push({ item, flag }); else byList.set(list, [{ item, flag }]);
      }
    }
    for (const rows of byList.values()) {
      rows.sort((a, b) => (categoryOrder.get(a.item.category_id) ?? 99) - (categoryOrder.get(b.item.category_id) ?? 99)
        || a.item.sort - b.item.sort || (a.item.name.en ?? '').localeCompare(b.item.name.en ?? ''));
    }
    return byList;
  }, [data.items, showResolved, categoryOrder]);

  const orderableNow = data.items.filter((i) => i.status === 'published' && i.orderable);
  const disappear = data.items.filter(wouldDisappearInLive);
  const verifiedLive = data.items.filter((i) => i.status === 'published' && i.review_status === 'verified');

  const resolve = async (row: Row, note: string) => {
    setError(null);
    try {
      const res = await api.post<AdminItemDTO>(`/api/staff/menu/flags/${encodeURIComponent(row.flag.id)}/resolve`, { resolution: note });
      if (res && 'flags' in res) data.putItem(res); else void data.resource.refresh();
      setResolving(null);
      toast.show({ message: t('catalog.flags.resolved', { flag: flagLabel(row.flag.code), name: nameText(row.item.name) }) });
    } catch (err) {
      setError(errorText(err));
      throw err;
    }
  };

  const verify = async (item: AdminItemDTO) => {
    setError(null);
    try {
      const res = await api.post<AdminItemDTO>(`/api/staff/menu/items/${encodeURIComponent(item.id)}/review`, { review_status: 'verified', version: item.version });
      data.putItem(res);
      setVerifying(null);
      toast.show({ message: t('catalog.review.verifiedDone', { name: nameText(res.name) }) });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version') {
        const current = (err.details as { current?: AdminItemDTO } | null)?.current;
        if (current) { data.putItem(current); setVerifying(current); }
      }
      setError(errorText(err));
      throw err;
    }
  };

  const r = catalog?.review;
  const cards: Array<{ key: keyof NonNullable<typeof r>; tone?: 'attention' }> = [
    { key: 'imported' }, { key: 'live_ready' }, { key: 'demo_orderable' }, { key: 'open_flags', tone: 'attention' },
    { key: 'ambiguous_price', tone: 'attention' }, { key: 'pending_portion_rules', tone: 'attention' },
    { key: 'missing_thai' }, { key: 'missing_photo' }, { key: 'missing_description' }, { key: 'seasonal_disabled' },
  ];

  return (
    <section className="rq" aria-labelledby="rq-h">
      <h2 id="rq-h" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.tab.review')}</h2>
      <DataNotices resource={data.resource} />
      {!catalog && data.resource.error ? <LoadFailed resource={data.resource} /> : !catalog || !r ? (
        <div className="mn-pad"><ListSkeleton label={t('common.loading')} /></div>
      ) : (
        <div className="mn-pad rq__body">
          <section className={live ? 'rq-live is-live' : 'rq-live'} aria-labelledby="rq-live-h">
            <h3 id="rq-live-h">
              <Icon name={live ? 'check-c' : 'info'} size="sm" />
              {live ? t('catalog.rq.liveOnTitle') : t('catalog.rq.demoTitle')}
            </h3>
            <p className="rq-live__rule">{t('catalog.rq.rule')}</p>
            {live ? (
              <p className="rq-live__big"><b>{num(verifiedLive.length)}</b> {t('catalog.rq.liveOnBody')}</p>
            ) : (
              <p className="rq-live__big">
                <b>{num(disappear.length)}</b>
                {' '}{t('catalog.rq.disappear', { total: orderableNow.length })}
              </p>
            )}
            {!live && disappear.length ? <p className="rq-live__sub">{t('catalog.rq.disappearHow')}</p> : null}
            {!canReview ? <p className="rq-live__sub"><Icon name="lock" size="sm" />{t('catalog.rq.ownerOnly')}</p> : null}
          </section>

          <StatGrid className="rq-stats">
            {cards.map((c) => {
              // Attention is a heat tag with words (DESIGN §9 keeps the ember mark for "current" only).
              const attention = c.tone === 'attention' && r[c.key] > 0;
              return (
                <StatCard
                  key={c.key}
                  className={attention ? 'rq-stat is-attention' : 'rq-stat'}
                  label={t(`catalog.rq.card.${c.key}`)}
                  value={(
                    <>
                      {num(r[c.key])}
                      {attention ? <Tag tone="heat" icon="alert" className="rq-stat__tag">{t('catalog.rq.card.needsReview')}</Tag> : null}
                    </>
                  )}
                  note={t(`catalog.rq.card.${c.key}Note`, { total: r.imported })}
                  definition={<p>{t(`catalog.rq.card.${c.key}Def`)}</p>}
                />
              );
            })}
          </StatGrid>

          <div className="rq-lists-head">
            <h3>{t('catalog.rq.listsTitle')}</h3>
            <CheckButton label={t('catalog.rq.showResolved')} checked={showResolved} onChange={setShowResolved} />
          </div>

          {[...LISTS, { id: 'other', codes: [], lede: false } as WorkList].map((list) => {
            const rows = lists.get(list.id) ?? [];
            if (!rows.length && list.id === 'other') return null;
            return (
              <Disclosure
                key={list.id}
                id={`rq-${list.id}`}
                title={t(`catalog.rq.list.${list.id}`)}
                count={rows.length}
                countLabel={t('catalog.rq.countLabel', { n: rows.length })}
                defaultOpen={list.open && rows.length > 0}
                lede={list.lede ? t(`catalog.rq.list.${list.id}Lede`) : undefined}
              >
                {rows.length === 0 ? (
                  <p className="mn-note mn-note--ok"><Icon name="check-c" size="sm" />{t('catalog.rq.listDone')}</p>
                ) : (
                  <ul className="rq-list">
                    {rows.map((row) => (
                      <ReviewRow
                        key={row.flag.id}
                        row={row}
                        canReview={canReview}
                        showVerify
                        onResolve={() => { setError(null); setResolving(row); }}
                        onVerify={() => { setError(null); setVerifying(row.item); }}
                      />
                    ))}
                  </ul>
                )}
              </Disclosure>
            );
          })}
        </div>
      )}

      <ResolveFlagDialog
        open={resolving !== null}
        flagLabel={resolving ? `${flagLabel(resolving.flag.code)} · ${nameText(resolving.item.name)}` : ''}
        detail={resolving?.flag.detail ?? ''}
        error={error}
        onClose={() => setResolving(null)}
        onResolve={(note) => (resolving ? resolve(resolving, note) : Promise.resolve())}
      />
      <Dialog
        open={verifying !== null}
        onClose={() => setVerifying(null)}
        title={verifying ? t('catalog.review.verifyTitle', { name: nameText(verifying.name) }) : ''}
        confirmLabel={t('catalog.review.verifyConfirm')}
        onConfirm={() => (verifying ? verify(verifying) : undefined)}
        error={error}
        density="staff"
      >
        {verifying ? <VerifySummary item={verifying} /> : null}
      </Dialog>
    </section>
  );
}

function priceSummary(item: AdminItemDTO, t: (k: string, v?: Record<string, string | number>) => string, pick: (b: AdminItemDTO['name']) => { text: string }): string {
  if (item.pricing_type === 'fixed') return item.price_minor === null ? t('catalog.list.noPrice') : money(item.price_minor);
  if (item.pricing_type === 'measured_weight') return item.rate_minor === null ? t('catalog.list.noPrice') : t('catalog.list.perGrams', { price: money(item.rate_minor), n: item.rate_basis_grams ?? 100 });
  return item.variants.map((v) => `${pick(v.name).text || v.key} ${v.price_minor === null ? '—' : money(v.price_minor)}`).join(' · ') || t('catalog.list.noPrice');
}

function VerifySummary({ item }: { item: AdminItemDTO }) {
  const { t, pick } = useI18n();
  const flagLabel = useFlagLabel();
  const open = item.flags.filter((f) => !f.resolved_at && f.code !== 'missing_description' && f.code !== 'missing_image');
  return (
    <div className="rq-verify">
      <p>{t('catalog.review.verifyBody')}</p>
      <p className="rq-verify__price"><b>{priceSummary(item, t, pick)}</b></p>
      {open.length ? (
        <div className="rq-verify__warn" role="note">
          <p><Icon name="alert" size="sm" />{t('catalog.review.verifyOpenFlags', { n: open.length })}</p>
          <ul>{open.map((f) => <li key={f.id}>{flagLabel(f.code)}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

function ReviewRow({ row, canReview, showVerify, onResolve, onVerify }: {
  row: Row;
  canReview: boolean;
  showVerify: boolean;
  onResolve: () => void;
  onVerify: () => void;
}) {
  const { t, pick, lang } = useI18n();
  const data = useMenuData();
  const nameText = useNameText();
  const flagLabel = useFlagLabel();
  const { item, flag } = row;
  const done = Boolean(flag.resolved_at);
  const name = nameText(item.name);
  return (
    <li className={done ? 'rq-row is-done' : 'rq-row'} data-flag={flag.id}>
      <Thumb item={item} />
      <div className="rq-row__main">
        <div className="rq-row__top">
          <ItemName name={item.name} />
          <span className="rq-row__cat">{pick(data.category(item.category_id)?.name).text}</span>
        </div>
        <div className="rq-row__pills">
          <ItemStatusPill status={item.status} />
          <ReviewPill status={item.review_status} />
          {item.pricing_type === 'variant' || item.pricing_type === 'measured_weight' ? (
            <span className="rq-row__price">{priceSummary(item, t, pick)}</span>
          ) : null}
        </div>
        <p className="rq-row__detail" lang="en">{flag.detail}</p>
        <SourceQuote text={item.source.text} sourceRef={item.source.ref} />
        {done ? (
          <p className="rq-row__done">
            <Icon name="check" size="sm" />
            {t('catalog.flags.resolution', { time: flag.resolved_at ? dateTime(flag.resolved_at, lang) : '—' })}
            {' '}<span>{flag.resolution}</span>
          </p>
        ) : null}
      </div>
      <div className="rq-row__acts">
        <LinkButton href={itemHref(item.id)} variant="outline" size="staff" iconEnd="chev-r" aria-label={t('catalog.item.openNamed', { name })}>
          {t('catalog.rq.openEditor')}
        </LinkButton>
        {canReview && !done ? (
          <Button variant="outline" size="staff" opensDialog onClick={onResolve} aria-label={t('catalog.flags.resolveFor', { flag: flagLabel(flag.code), name })}>
            {t('catalog.flags.resolve')}
          </Button>
        ) : null}
        {canReview && showVerify && item.review_status !== 'verified' ? (
          <Button variant="secondary" size="staff" icon="check" opensDialog onClick={onVerify} aria-label={t('catalog.review.verifyNamed', { name })}>
            {t('catalog.review.verify')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

