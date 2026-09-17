// Publish controls (C6, brief 21): Publish / Publish changes / Unpublish to
// draft / Archive, with the publish blockers shown as a checklist. A missing
// photo never blocks. Staff see why before they press anything.
import { useEffect, useState } from 'react';
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import type { ItemStatus } from '../../../../shared/status.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Dialog, Icon, TextLink, useToast } from '../../ui/index.ts';
import { TAB_HREF, useErrorText, useMenuData } from './model.tsx';
import { ItemStatusPill, Marker, ReviewPill, useBlockerLabel, useNameText, useReasonText } from './parts.tsx';

interface Check { code: string; ok: boolean }

function checksFor(item: AdminItemDTO, blockers: string[], live: boolean): Check[] {
  const priceCode = item.pricing_type === 'fixed' ? 'missing_price' : item.pricing_type === 'measured_weight' ? 'missing_rate' : 'no_priced_variant';
  const codes = ['missing_name', priceCode, 'required_choice_unavailable', ...(live ? ['not_verified'] : [])];
  const extra = blockers.filter((b) => !codes.includes(b));
  return [...codes, ...extra].map((code) => ({ code, ok: !blockers.includes(code) }));
}

export default function PublishPanel({ item, canPublish, dirty }: { item: AdminItemDTO; canPublish: boolean; dirty: boolean }) {
  const { t } = useI18n();
  const { config } = useConfig();
  const data = useMenuData();
  const errorText = useErrorText();
  const blockerLabel = useBlockerLabel();
  const reasonText = useReasonText();
  const nameText = useNameText();
  const toast = useToast();
  const [busy, setBusy] = useState<ItemStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ItemStatus | null>(null);
  const live = config?.operating_mode === 'live';
  // A message about an earlier attempt goes once the item has changed.
  useEffect(() => { setFailure(null); }, [item.version, item.publish_blockers.join('|')]);
  const blockers = item.publish_blockers;
  const checks = checksFor(item, blockers, live);
  const blocked = blockers.length > 0;
  const name = nameText(item.name);

  const setStatus = async (status: ItemStatus) => {
    if (busy) return;
    setFailure(null);
    setBusy(status);
    try {
      const res = await api.post<AdminItemDTO>(`/api/staff/menu/items/${encodeURIComponent(item.id)}/status`, { status, version: item.version });
      data.putItem(res);
      setConfirm(null);
      const key = status === 'published' ? (item.status === 'published' ? 'catalog.publish.republished' : 'catalog.publish.published')
        : status === 'archived' ? 'catalog.publish.archived' : 'catalog.publish.unpublished';
      toast.show({ message: t(key, { name }) });
    } catch (err) {
      if (err instanceof ApiError) {
        const d = err.details as { current?: AdminItemDTO; blockers?: string[] } | null;
        if (d?.current) data.putItem(d.current);
        if (err.code === 'publish_blocked' && d?.blockers?.length) {
          setFailure(t('catalog.publish.blockedList', { list: d.blockers.map(blockerLabel).join(', ') }));
        } else {
          setFailure(errorText(err));
        }
      } else {
        setFailure(errorText(err));
      }
      throw err;
    } finally {
      setBusy(null);
    }
  };
  const run = (status: ItemStatus) => { void setStatus(status).catch(() => {}); };

  const isPublished = item.status === 'published';
  const primaryLabel = isPublished ? t('catalog.publish.publishChanges') : t('catalog.publish.publish');
  const showPrimary = !isPublished || item.unpublished_changes;

  return (
    <section className="ed-card ed-publish" aria-labelledby="ed-pub-h">
      <header className="ed-card__head">
        <h3 id="ed-pub-h">{t('catalog.publish.title')}</h3>
        <span className="ed-publish__pills">
          <ItemStatusPill status={item.status} />
          <ReviewPill status={item.review_status} />
        </span>
      </header>

      <p className="ed-publish__guest">
        <Icon name={isPublished && item.orderable ? 'check-c' : 'info'} size="sm" />
        {isPublished
          ? (item.sold_out ? t('catalog.publish.guestsSoldOut') : item.orderable ? t('catalog.publish.guestsOrder') : t('catalog.publish.guestsSee', { reason: reasonText(item.unavailable_reason) }))
          : item.status === 'archived' ? t('catalog.publish.archivedNote') : t('catalog.publish.draftNote')}
      </p>
      {item.unpublished_changes && isPublished ? (
        <Marker icon="refresh" tone="heat">{t('catalog.publish.unpublishedNote')}</Marker>
      ) : null}

      <ul className="ed-checks" id="ed-checks" aria-label={t('catalog.publish.checklist')}>
        {checks.map((c) => (
          <li key={c.code} className={c.ok ? 'is-ok' : 'is-blocked'}>
            <Icon name={c.ok ? 'check' : 'x'} size="sm" />
            <span>{c.ok ? t(`catalog.check.${c.code}`) : blockerLabel(c.code)}</span>
            <span className="visually-hidden">{c.ok ? t('catalog.publish.checkOk') : t('catalog.publish.checkBlocked')}</span>
          </li>
        ))}
        <li className="is-note">
          <Icon name="info" size="sm" />
          <span>{item.image ? t('catalog.check.photo') : t('catalog.check.noPhoto')}</span>
        </li>
      </ul>
      {!live ? <p className="field__help">{t('catalog.publish.demoNote')}</p> : null}

      {failure ? <p className="field__error" role="alert">{failure}</p> : null}
      {dirty && canPublish ? <p className="mn-note"><Icon name="info" size="sm" />{t('catalog.publish.saveFirst')}</p> : null}

      {canPublish ? (
        <div className="ed-publish__acts">
          {showPrimary ? (
            <Button
              variant={dirty || blocked ? 'outline' : 'primary'}
              size="staff"
              block
              icon="book"
              loading={busy === 'published'}
              aria-disabled={dirty || undefined}
              aria-describedby={blocked ? 'ed-checks' : undefined}
              onClick={() => { if (!dirty) run('published'); }}
            >
              {primaryLabel}
            </Button>
          ) : null}
          {item.status !== 'draft' ? (
            <Button variant="outline" size="staff" block opensDialog disabled={Boolean(busy)} onClick={() => setConfirm('draft')}>
              {isPublished ? t('catalog.publish.unpublish') : t('catalog.publish.restore')}
            </Button>
          ) : null}
          {item.status !== 'archived' ? (
            <Button variant="ghost" size="staff" block icon="lock" opensDialog disabled={Boolean(busy)} onClick={() => setConfirm('archived')}>
              {t('catalog.publish.archive')}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mn-note"><Icon name="lock" size="sm" />{t('catalog.publish.noPerm')}</p>
      )}
      {item.sold_out ? <TextLink href={TAB_HREF.availability}>{t('catalog.publish.soldOutLink')}</TextLink> : null}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'archived' ? t('catalog.publish.archiveTitle', { name }) : isPublished ? t('catalog.publish.unpublishTitle', { name }) : t('catalog.publish.restoreTitle', { name })}
        confirmLabel={confirm === 'archived' ? t('catalog.publish.archiveConfirm') : isPublished ? t('catalog.publish.unpublishConfirm') : t('catalog.publish.restoreConfirm')}
        tone={confirm === 'archived' || isPublished ? 'danger' : 'default'}
        onConfirm={() => (confirm ? setStatus(confirm) : undefined)}
        error={failure}
        density="staff"
      >
        {confirm === 'archived' ? t('catalog.publish.archiveBody') : isPublished ? t('catalog.publish.unpublishBody') : t('catalog.publish.restoreBody')}
      </Dialog>
    </section>
  );
}
