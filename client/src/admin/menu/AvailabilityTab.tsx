// Availability (C6, brief 21 + 25 + 33): the service-friendly list. One tap
// marks a published dish sold out for guests; nothing comes back on sale by
// itself. Managers can also pause ordering for a whole category.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminItemDTO } from '../../../../shared/dto.ts';
import { api } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { setQuery, useRoute } from '../../lib/router.ts';
import {
  Button, CheckButton, Chip, Dialog, EmptyState, FilterChips, Icon, Pill, SelectButton, StaffSearch, Switch, Tag, TextLink,
  useToast, type ChipOption,
} from '../../ui/index.ts';
import {
  itemHref, matchesItem, useCan, useErrorText, useMenuData, type AdminCategory, type GroupKey,
} from './model.tsx';
import { DataNotices, ItemName, ListSkeleton, LoadFailed, Thumb, useNameText, useReasonText } from './parts.tsx';

type GroupFilter = 'all' | GroupKey;

export default function AvailabilityTab() {
  const { t, pick } = useI18n();
  const data = useMenuData();
  const can = useCan();
  const canToggle = can('menu.availability');
  const canPause = can('ordering.pause');
  const canEdit = can('menu.edit');
  const nameText = useNameText();
  const errorText = useErrorText();
  const toast = useToast();
  const { query } = useRoute();

  const group: GroupFilter = query.get('group') === 'food' || query.get('group') === 'drinks' ? (query.get('group') as GroupKey) : 'all';
  const catParam = query.get('cat') ?? 'all';
  const [search, setSearch] = useState('');
  const [soldOnly, setSoldOnly] = useState(false);
  /** itemId -> the sold-out state being saved (shown at once, rolled back on failure). */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const inflight = useRef(new Set<string>());
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [pauseTarget, setPauseTarget] = useState<AdminCategory | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const { catalog } = data;
  const published = useMemo(() => data.items.filter((i) => i.status === 'published'), [data.items]);
  const soldOutOf = (i: AdminItemDTO) => pending[i.id] ?? i.sold_out;

  const groupsInOrder: GroupKey[] = ['food', 'drinks'];
  const categories = useMemo(() => {
    const keys = group === 'all' ? groupsInOrder : [group];
    return keys.flatMap((g) => data.categoriesOf(g)).filter((c) => data.itemsOf(c.id).some((i) => i.status === 'published'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, group]);
  const cat = categories.some((c) => c.id === catParam) ? catParam : 'all';

  const visibleCats = cat === 'all' ? categories : categories.filter((c) => c.id === cat);
  const sections = visibleCats
    .map((c) => ({
      category: c,
      items: data.itemsOf(c.id).filter((i) => i.status === 'published' && matchesItem(i, search) && (!soldOnly || soldOutOf(i))),
    }))
    .filter((s) => s.items.length > 0);
  const shown = sections.reduce((n, s) => n + s.items.length, 0);

  const countIn = (g: GroupFilter) => published.filter((i) => g === 'all' || data.category(i.category_id)?.group === g).length;
  const soldItems = published.filter(soldOutOf);

  const toggle = async (item: AdminItemDTO, next: boolean) => {
    if (inflight.current.has(item.id) || !canToggle) return;
    inflight.current.add(item.id);
    const name = nameText(item.name);
    setPending((p) => ({ ...p, [item.id]: next }));
    setRowError((e) => { const { [item.id]: _, ...rest } = e; return rest; });
    try {
      const res = await api.post<AdminItemDTO>(`/api/staff/menu/items/${encodeURIComponent(item.id)}/availability`, { sold_out: next });
      data.putItem(res);
      const already = res.version === item.version;
      const message = t(next
        ? (already ? 'catalog.avail.alreadySoldOut' : 'catalog.avail.markedSoldOut')
        : (already ? 'catalog.avail.alreadyBack' : 'catalog.avail.markedBack'), { name });
      toast.show({
        message,
        tone: 'ok',
        action: already ? undefined : { label: t('common.undo'), onClick: () => void toggle(res, !next) },
      });
    } catch (err) {
      const reason = errorText(err);
      setRowError((e) => ({ ...e, [item.id]: reason }));
      toast.show({ message: t('catalog.avail.failed', { name, reason }), tone: 'error' });
      void data.resource.refresh();
    } finally {
      inflight.current.delete(item.id);
      setPending((p) => { const { [item.id]: _, ...rest } = p; return rest; });
    }
  };

  const setPaused = async (category: AdminCategory, paused: boolean) => {
    setPauseError(null);
    try {
      const res = await api.patch<NonNullable<typeof catalog>>(`/api/staff/menu/categories/${encodeURIComponent(category.id)}`, {
        ordering_paused: paused,
        version: category.version,
      });
      data.putCatalog(res);
      setPauseTarget(null);
      toast.show({ message: t(paused ? 'catalog.pause.done' : 'catalog.pause.resumed', { name: nameText(category.name) }) });
    } catch (err) {
      setPauseError(errorText(err));
      void data.resource.refresh();
      throw err;
    }
  };

  const groupOptions: ChipOption<GroupFilter>[] = [
    { value: 'all', label: t('common.all'), count: countIn('all') },
    { value: 'food', label: pick(catalog?.groups.find((g) => g.key === 'food')?.name).text || t('catalog.group.food'), count: countIn('food') },
    { value: 'drinks', label: pick(catalog?.groups.find((g) => g.key === 'drinks')?.name).text || t('catalog.group.drinks'), count: countIn('drinks') },
  ];
  const catOptions = [
    { value: 'all', label: t('catalog.filter.allCategories') },
    ...categories.map((c) => ({ value: c.id, label: pick(c.name).text })),
  ];

  return (
    <section className="av" aria-labelledby="av-h">
      <h2 id="av-h" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.tab.availability')}</h2>
      <DataNotices resource={data.resource} />

      <div className="toolbar-cq">
        <div className="toolbar mn-toolbar" role="group" aria-label={t('catalog.filter.label')}>
          <FilterChips
            options={groupOptions}
            value={group}
            label={t('catalog.filter.group')}
            onChange={(v) => setQuery({ group: v === 'all' ? null : v, cat: null })}
          />
          <SelectButton label={t('catalog.filter.category')} value={cat} options={catOptions} onChange={(v) => setQuery({ cat: v === 'all' ? null : v })} icon="filter" />
          <CheckButton label={t('catalog.avail.soldOnly')} checked={soldOnly} onChange={setSoldOnly} count={soldItems.length} />
          <StaffSearch label={t('catalog.filter.searchLabel')} placeholder={t('catalog.filter.search')} value={search} onChange={setSearch} />
        </div>
      </div>

      {!catalog && data.resource.error ? (
        <LoadFailed resource={data.resource} />
      ) : !catalog ? (
        <div className="mn-pad"><ListSkeleton label={t('common.loading')} /></div>
      ) : (
        <div className="mn-pad av__body">
          <SoldOutSummary
            items={soldItems}
            canToggle={canToggle}
            pending={pending}
            onBack={(i) => void toggle(i, false)}
            categoryName={(i) => pick(data.category(i.category_id)?.name).text}
          />

          {!canToggle ? (
            <p className="mn-note"><Icon name="info" size="sm" />{t('catalog.avail.readOnly')}</p>
          ) : null}

          <p className="visually-hidden" role="status">{search ? t('catalog.filter.results', { n: shown }) : ''}</p>

          {sections.length === 0 ? (
            <EmptyState
              icon={search ? 'search' : 'cutlery'}
              title={search ? t('catalog.filter.noMatch', { q: search }) : soldOnly ? t('catalog.avail.noneSold') : t('catalog.avail.empty')}
              action={search || soldOnly ? (
                <Button variant="outline" size="staff" onClick={() => { setSearch(''); setSoldOnly(false); }}>{t('catalog.filter.clear')}</Button>
              ) : undefined}
            />
          ) : sections.map(({ category, items }) => (
            <CategoryBlock
              key={category.id}
              category={category}
              total={data.itemsOf(category.id).filter((i) => i.status === 'published').length}
              soldCount={data.itemsOf(category.id).filter((i) => i.status === 'published' && soldOutOf(i)).length}
              canPause={canPause}
              onPause={() => { setPauseError(null); setPauseTarget(category); }}
            >
              <ul className="av-list">
                {items.map((item) => (
                  <AvailabilityRow
                    key={item.id}
                    item={item}
                    soldOut={soldOutOf(item)}
                    busy={pending[item.id] !== undefined}
                    error={rowError[item.id]}
                    canToggle={canToggle}
                    canEdit={canEdit}
                    onToggle={(next) => void toggle(item, next)}
                  />
                ))}
              </ul>
            </CategoryBlock>
          ))}
        </div>
      )}

      <Dialog
        open={pauseTarget !== null}
        onClose={() => setPauseTarget(null)}
        title={pauseTarget ? t(pauseTarget.ordering_paused ? 'catalog.pause.resumeTitle' : 'catalog.pause.title', { name: nameText(pauseTarget.name) }) : ''}
        confirmLabel={pauseTarget?.ordering_paused ? t('catalog.pause.resumeConfirm') : t('catalog.pause.confirm')}
        tone={pauseTarget?.ordering_paused ? 'default' : 'danger'}
        onConfirm={() => (pauseTarget ? setPaused(pauseTarget, !pauseTarget.ordering_paused) : undefined)}
        error={pauseError}
        density="staff"
      >
        {pauseTarget
          ? t(pauseTarget.ordering_paused ? 'catalog.pause.resumeBody' : 'catalog.pause.body', { n: data.itemsOf(pauseTarget.id).filter((i) => i.status === 'published').length })
          : null}
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------------ sold-out summary
function SoldOutSummary({ items, canToggle, pending, onBack, categoryName }: {
  items: AdminItemDTO[];
  canToggle: boolean;
  pending: Record<string, boolean>;
  onBack: (item: AdminItemDTO) => void;
  categoryName: (item: AdminItemDTO) => string;
}) {
  const { t } = useI18n();
  const nameText = useNameText();
  return (
    <section className={items.length ? 'av-sold' : 'av-sold av-sold--none'} aria-labelledby="av-sold-h">
      <div className="av-sold__head">
        <h3 id="av-sold-h">
          <Icon name={items.length ? 'slash' : 'check-c'} size="sm" />
          {items.length ? t('catalog.avail.soldNow', { n: items.length }) : t('catalog.avail.noneSoldNow')}
        </h3>
        <p>{t('catalog.avail.noReset')}</p>
      </div>
      {items.length ? (
        <ul className="av-sold__list">
          {items.map((item) => (
            <li key={item.id} className="av-sold__item">
              <span className="av-sold__name">
                <ItemName name={item.name} onlyPrimary />
                <span className="av-sold__cat">{categoryName(item)}</span>
              </span>
              {canToggle ? (
                <Button
                  variant="outline"
                  size="staff"
                  icon="check"
                  loading={pending[item.id] !== undefined}
                  aria-label={t('catalog.avail.backNamed', { name: nameText(item.name) })}
                  onClick={() => onBack(item)}
                >
                  {t('catalog.avail.back')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ category block
function CategoryBlock({ category, total, soldCount, canPause, onPause, children }: {
  category: AdminCategory;
  total: number;
  soldCount: number;
  canPause: boolean;
  onPause: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const headId = `av-cat-${category.id}`;
  return (
    <section className={category.ordering_paused ? 'av-cat is-paused' : 'av-cat'} aria-labelledby={headId}>
      <header className="av-cat__head">
        <h3 id={headId} className="av-cat__t"><ItemName name={category.name} /></h3>
        <p className="av-cat__n">
          {t('catalog.avail.catCount', { n: total })}
          {soldCount ? <> · <b>{t('catalog.avail.catSold', { n: soldCount })}</b></> : null}
        </p>
        {category.ordering_paused ? (
          <Pill tone="ink" icon="pause" size="sm">{t('catalog.pause.paused')}</Pill>
        ) : null}
        {canPause ? (
          <Button
            className="av-cat__act"
            variant={category.ordering_paused ? 'outline' : 'ghost'}
            size="staff"
            icon={category.ordering_paused ? undefined : 'pause'}
            opensDialog
            onClick={onPause}
          >
            {category.ordering_paused ? t('catalog.pause.resume') : t('catalog.pause.pause')}
          </Button>
        ) : null}
      </header>
      {category.ordering_paused ? <p className="av-cat__note">{t('catalog.pause.note')}</p> : null}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ row
function AvailabilityRow({ item, soldOut, busy, error, canToggle, canEdit, onToggle }: {
  item: AdminItemDTO;
  soldOut: boolean;
  busy: boolean;
  error?: string;
  canToggle: boolean;
  canEdit: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t, pick } = useI18n();
  const nameText = useNameText();
  const reasonText = useReasonText();
  const nameId = `av-${item.id}`;
  const reason = soldOut ? 'sold_out' : item.sold_out ? null : item.unavailable_reason;
  const variants = item.pricing_type === 'variant' ? item.variants : [];

  return (
    <li className={soldOut ? 'av-row is-sold' : 'av-row'} aria-labelledby={nameId} aria-busy={busy || undefined}>
      <Thumb item={item} />
      <div className="av-row__main">
        <ItemName name={item.name} id={nameId} />
        <div className="av-row__state">
          {soldOut ? (
            <Pill tone="alert" icon="slash" size="sm">{t('common.soldOut')}</Pill>
          ) : reason ? (
            <Pill tone="neutral" icon="info" size="sm">{reasonText(reason)}</Pill>
          ) : (
            <Pill tone="ok" icon="check" size="sm">{t('catalog.reason.orderable')}</Pill>
          )}
          {item.pricing_type === 'measured_weight' ? <Tag tone="neutral" icon="scale">{t('common.priceByWeight')}</Tag> : null}
        </div>
        {variants.length ? (
          <div className="av-row__vars">
            <span className="visually-hidden">{t('catalog.avail.variants')}</span>
            {variants.map((v) => (
              <Chip key={v.id} tone="line" className={v.available ? 'av-var' : 'av-var is-off'}>
                <Icon name={v.available ? 'check' : 'slash'} size="xs" />
                <span lang={pick(v.name).lang}>{pick(v.name).text || v.key}</span>
                <span className="visually-hidden"> {v.available ? t('catalog.avail.variantOn') : t('catalog.avail.variantOff')}</span>
              </Chip>
            ))}
            {canEdit ? (
              <TextLink href={`${itemHref(item.id)}#pricing`} className="av-row__link">{t('catalog.avail.editVariants')}</TextLink>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="av-row__err" role="alert"><Icon name="alert" size="sm" />{t('catalog.avail.notSaved', { reason: error })}</p>
        ) : null}
      </div>
      {canToggle ? (
        <Switch
          className="av-switch"
          density="staff"
          checked={soldOut}
          aria-busy={busy || undefined}
          aria-label={t('catalog.avail.switchLabel', { name: nameText(item.name) })}
          label={t('catalog.avail.soldOutShort')}
          showState={false}
          onChange={onToggle}
        />
      ) : null}
    </li>
  );
}
