// Catalog (C6, brief 21): groups -> categories -> items with status, review
// and what is still missing; explicit up/down placement (never drag-only);
// new categories, items and reusable choice groups.
import { useEffect, useRef, useState } from 'react';
import type { AdminCatalogDTO, AdminItemDTO } from '../../../../shared/dto.ts';
import type { ItemStatus } from '../../../../shared/status.ts';
import { api } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Link, setQuery, useRoute } from '../../lib/router.ts';
import {
  Button, CheckButton, Chip, EmptyState, FilterChips, Icon, IconButton, Pill, StaffSearch, Tag, useAnnounce, useToast,
  type ChipOption,
} from '../../ui/index.ts';
import { attentionOf } from './attention.ts';
import CategoryEditor from './CategoryEditor.tsx';
import ModifierGroupEditor from './ModifierGroupEditor.tsx';
import NewItemDialog from './NewItemDialog.tsx';
import {
  itemHref, matchesItem, useCan, useErrorText, useMenuData, type AdminCategory, type AdminModifierGroup, type GroupKey,
} from './model.tsx';
import {
  DataNotices, ItemName, ItemStatusPill, ListSkeleton, LoadFailed, Marker, ReviewPill, ruleText, Thumb, useNameText,
} from './parts.tsx';

type StatusFilter = 'all' | ItemStatus;

interface MoveFocus { kind: 'item' | 'category'; id: string; dir: 'up' | 'down' }

export default function CatalogTab() {
  const { t, pick } = useI18n();
  const data = useMenuData();
  const can = useCan();
  const canEdit = can('menu.edit');
  const nameText = useNameText();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const toast = useToast();
  const { query } = useRoute();

  const group: GroupKey = query.get('group') === 'drinks' ? 'drinks' : 'food';
  const statusParam = query.get('status');
  const status: StatusFilter = statusParam === 'draft' || statusParam === 'published' || statusParam === 'archived' ? statusParam : 'all';
  const attentionOnly = query.get('attention') === '1';
  const [search, setSearch] = useState('');
  const [busyMove, setBusyMove] = useState<string | null>(null);
  const [moveFocus, setMoveFocus] = useState<MoveFocus | null>(null);
  const [editCategory, setEditCategory] = useState<AdminCategory | 'new' | null>(null);
  const [editGroup, setEditGroup] = useState<AdminModifierGroup | 'new' | null>(null);
  const [newItem, setNewItem] = useState<{ categoryId?: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const filtering = Boolean(search) || status !== 'all' || attentionOnly;
  const { catalog } = data;

  // Keep keyboard focus on the moved row's control after the list re-renders.
  useEffect(() => {
    if (!moveFocus || busyMove) return;
    const root = bodyRef.current;
    if (!root) return;
    const sel = `[data-move="${moveFocus.kind}:${moveFocus.id}:${moveFocus.dir}"]`;
    const other = `[data-move="${moveFocus.kind}:${moveFocus.id}:${moveFocus.dir === 'up' ? 'down' : 'up'}"]`;
    const btn = root.querySelector<HTMLButtonElement>(sel);
    const target = btn && btn.getAttribute('aria-disabled') !== 'true' ? btn : root.querySelector<HTMLButtonElement>(other);
    target?.focus();
    setMoveFocus(null);
  }, [moveFocus, busyMove, catalog]);

  const move = async (kind: 'item' | 'category', ids: string[], index: number, dir: 'up' | 'down', label: string) => {
    const to = dir === 'up' ? index - 1 : index + 1;
    if (to < 0 || to >= ids.length || busyMove) return;
    const order = [...ids];
    [order[index], order[to]] = [order[to], order[index]];
    const id = ids[index];
    setBusyMove(id);
    try {
      const res = await api.post<AdminCatalogDTO>('/api/staff/menu/reorder', { entity: kind, ids: order });
      data.putCatalog(res);
      announce(t('catalog.list.moved', { name: label, n: to + 1, total: ids.length }));
    } catch (err) {
      toast.show({ message: t('catalog.list.moveFailed', { reason: errorText(err) }), tone: 'error' });
      void data.resource.refresh();
    } finally {
      setBusyMove(null);
      setMoveFocus({ kind, id, dir });
    }
  };

  const categories = data.categoriesOf(group);
  const countFor = (g: GroupKey) => data.categoriesOf(g).reduce((n, c) => n + data.itemsOf(c.id).length, 0);
  const statusCount = (s: StatusFilter) => data.items.filter((i) => (s === 'all' || i.status === s) && data.category(i.category_id)?.group === group).length;

  const groupOptions: ChipOption<GroupKey>[] = [
    { value: 'food', label: pick(catalog?.groups.find((g) => g.key === 'food')?.name).text || t('catalog.group.food'), count: countFor('food') },
    { value: 'drinks', label: pick(catalog?.groups.find((g) => g.key === 'drinks')?.name).text || t('catalog.group.drinks'), count: countFor('drinks') },
  ];
  const statusOptions: ChipOption<StatusFilter>[] = (['all', 'published', 'draft', 'archived'] as const).map((s) => ({
    value: s,
    label: s === 'all' ? t('common.all') : t(`catalog.status.${s}`),
    count: statusCount(s),
  }));

  const filterItem = (i: AdminItemDTO) => (status === 'all' || i.status === status)
    && matchesItem(i, search)
    && (!attentionOnly || attentionOf(i).any);

  const sections = categories.map((c) => ({ category: c, all: data.itemsOf(c.id), items: data.itemsOf(c.id).filter(filterItem) }))
    .filter((s) => !filtering || s.items.length > 0);
  const shown = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <section className="ct" aria-labelledby="ct-h">
      <h2 id="ct-h" className="visually-hidden" data-menu-focus tabIndex={-1}>{t('catalog.tab.catalog')}</h2>
      <DataNotices resource={data.resource} />

      <div className="toolbar-cq">
        <div className="toolbar mn-toolbar" role="group" aria-label={t('catalog.filter.label')}>
          <FilterChips options={groupOptions} value={group} label={t('catalog.filter.group')} onChange={(v) => setQuery({ group: v === 'food' ? null : v })} />
          <FilterChips options={statusOptions} value={status} label={t('catalog.filter.status')} onChange={(v) => setQuery({ status: v === 'all' ? null : v })} />
          <CheckButton label={t('catalog.list.attentionOnly')} checked={attentionOnly} onChange={(v) => setQuery({ attention: v ? '1' : null })} />
          <StaffSearch label={t('catalog.filter.searchLabel')} placeholder={t('catalog.filter.search')} value={search} onChange={setSearch} />
        </div>
      </div>

      {canEdit ? (
        <div className="mn-pad ct-actions">
          <p className="mn-lede">{t('catalog.list.lede')}</p>
          <div className="ct-actions__btns">
            <Button variant="outline" size="staff" icon="plus" iconBold opensDialog onClick={() => setEditCategory('new')}>{t('catalog.category.new')}</Button>
            <Button variant="primary" size="staff" icon="plus" iconBold opensDialog onClick={() => setNewItem({})}>{t('catalog.item.new')}</Button>
          </div>
        </div>
      ) : (
        <p className="mn-pad mn-note"><Icon name="info" size="sm" />{t('catalog.list.readOnly')}</p>
      )}

      {!catalog && data.resource.error ? (
        <LoadFailed resource={data.resource} />
      ) : !catalog ? (
        <div className="mn-pad"><ListSkeleton label={t('common.loading')} /></div>
      ) : (
        <div className="mn-pad ct__body" ref={bodyRef}>
          <p className="visually-hidden" role="status">{filtering ? t('catalog.filter.results', { n: shown }) : ''}</p>
          {filtering && canEdit ? <p className="mn-note"><Icon name="sort" size="sm" />{t('catalog.list.clearToSort')}</p> : null}

          {sections.length === 0 ? (
            <EmptyState
              icon="search"
              title={search ? t('catalog.filter.noMatch', { q: search }) : t('catalog.list.noneMatch')}
              action={<Button variant="outline" size="staff" onClick={() => { setSearch(''); setQuery({ status: null, attention: null }); }}>{t('catalog.filter.clear')}</Button>}
            />
          ) : sections.map(({ category, all, items }, ci) => {
            const catIds = categories.map((c) => c.id);
            const catLabel = nameText(category.name);
            const headId = `ct-cat-${category.id}`;
            return (
              <section key={category.id} className="ct-cat" aria-labelledby={headId}>
                <header className="ct-cat__head">
                  {canEdit && !filtering ? (
                    <MoveButtons
                      kind="category"
                      id={category.id}
                      label={catLabel}
                      first={ci === 0}
                      last={ci === sections.length - 1}
                      busy={busyMove !== null}
                      onMove={(dir) => void move('category', catIds, catIds.indexOf(category.id), dir, catLabel)}
                    />
                  ) : null}
                  <span className="ct-cat__num" aria-hidden="true" lang="en">{String(ci + 1).padStart(2, '0')}</span>
                  <h3 id={headId} className="ct-cat__t"><ItemName name={category.name} /></h3>
                  <span className="ct-cat__tags">
                    <ItemStatusPill status={category.status} />
                    {category.seasonal ? <Tag tone="heat" icon="calendar">{t('catalog.category.seasonal')}</Tag> : null}
                    {category.alcohol ? <Tag tone="neutral" icon="glass">{t('catalog.category.alcohol')}</Tag> : null}
                    {category.ordering_paused ? <Pill tone="ink" icon="pause" size="sm">{t('catalog.pause.paused')}</Pill> : null}
                    <span className="ct-cat__n">{t('catalog.list.count', { n: all.length })}</span>
                  </span>
                  <Button
                    className="ct-cat__edit"
                    variant="ghost"
                    size="staff"
                    icon={canEdit ? 'note' : 'info'}
                    opensDialog
                    aria-label={t(canEdit ? 'catalog.category.editNamed' : 'catalog.category.viewNamed', { name: catLabel })}
                    onClick={() => setEditCategory(category)}
                  >
                    {canEdit ? t('catalog.category.edit') : t('catalog.category.view')}
                  </Button>
                </header>

                {items.length === 0 ? (
                  <p className="ct-empty">
                    {t('catalog.list.emptyCategory')}
                    {canEdit ? (
                      <Button variant="quiet" size="staff" opensDialog aria-label={t('catalog.item.addHereNamed', { name: catLabel })} onClick={() => setNewItem({ categoryId: category.id })}>
                        {t('catalog.item.addHere')}
                      </Button>
                    ) : null}
                  </p>
                ) : (
                  <ol className="ct-items">
                    {items.map((item) => {
                      const ids = all.map((i) => i.id);
                      const idx = ids.indexOf(item.id);
                      return (
                        <CatalogRow
                          key={item.id}
                          item={item}
                          move={canEdit && !filtering ? {
                            first: idx === 0,
                            last: idx === ids.length - 1,
                            busy: busyMove !== null,
                            onMove: (dir) => void move('item', ids, idx, dir, nameText(item.name)),
                          } : null}
                        />
                      );
                    })}
                  </ol>
                )}
              </section>
            );
          })}

          <ChoiceGroups onEdit={setEditGroup} canEdit={canEdit} />
        </div>
      )}

      {editCategory ? (
        <CategoryEditor
          category={editCategory === 'new' ? null : editCategory}
          defaultGroup={group}
          readOnly={!canEdit}
          onClose={() => setEditCategory(null)}
        />
      ) : null}
      {editGroup ? (
        <ModifierGroupEditor group={editGroup === 'new' ? null : editGroup} readOnly={!canEdit} onClose={() => setEditGroup(null)} />
      ) : null}
      {newItem ? (
        <NewItemDialog defaultCategoryId={newItem.categoryId ?? categories[0]?.id} onClose={() => setNewItem(null)} />
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ pieces
function MoveButtons({ kind, id, label, first, last, busy, onMove }: {
  kind: 'item' | 'category';
  id: string;
  label: string;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (dir: 'up' | 'down') => void;
}) {
  const { t } = useI18n();
  return (
    <span className="mn-move" role="group" aria-label={t('catalog.list.order', { name: label })}>
      {(['up', 'down'] as const).map((dir) => {
        const off = dir === 'up' ? first : last;
        return (
          <IconButton
            key={dir}
            icon="chev-d"
            className={dir === 'up' ? 'mn-move__up' : undefined}
            variant="framed"
            size="staff"
            iconSize="sm"
            data-move={`${kind}:${id}:${dir}`}
            label={t(dir === 'up' ? 'catalog.list.moveUp' : 'catalog.list.moveDown', { name: label })}
            aria-disabled={off || busy || undefined}
            onClick={() => { if (!off && !busy) onMove(dir); }}
          />
        );
      })}
    </span>
  );
}

function priceText(item: AdminItemDTO, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (item.pricing_type === 'fixed') return item.price_minor === null ? t('catalog.list.noPrice') : money(item.price_minor);
  if (item.pricing_type === 'measured_weight') {
    return item.rate_minor === null ? t('catalog.list.noPrice') : t('catalog.list.perGrams', { price: money(item.rate_minor), n: item.rate_basis_grams ?? 100 });
  }
  const prices = item.variants.filter((v) => v.price_minor !== null).map((v) => v.price_minor as number);
  if (!prices.length) return t('catalog.list.noPrice');
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? money(min) : `${money(min)}–${money(max)}`;
}

function CatalogRow({ item, move }: {
  item: AdminItemDTO;
  move: null | { first: boolean; last: boolean; busy: boolean; onMove: (dir: 'up' | 'down') => void };
}) {
  const { t } = useI18n();
  const nameText = useNameText();
  const a = attentionOf(item);
  const nameId = `ct-${item.id}`;
  const missing = [
    a.noThai ? t('catalog.mark.partThai') : null,
    a.missingPhoto ? t('catalog.mark.partPhoto') : null,
    a.missingDescription ? t('catalog.mark.partDescription') : null,
  ].filter((x): x is string => Boolean(x));
  return (
    <li className={`ct-row is-${item.status}`}>
      {move ? <MoveButtons kind="item" id={item.id} label={nameText(item.name)} {...move} /> : null}
      <Thumb item={item} />
      <div className="ct-row__main">
        <Link to={itemHref(item.id)} className="ct-row__link" id={nameId} aria-label={t('catalog.item.openNamed', { name: nameText(item.name) })}>
          <ItemName name={item.name} />
        </Link>
        <p className="ct-row__meta">
          <span className="ct-row__price">{priceText(item, t)}</span>
          <span aria-hidden="true">·</span>
          <span>{t(`catalog.pricing.${item.pricing_type}`)}</span>
          {item.sold_out ? <><span aria-hidden="true">·</span><b className="ct-row__sold">{t('common.soldOut')}</b></> : null}
        </p>
        <div className="ct-row__marks">
          {a.unpublished ? <Marker icon="refresh" tone="heat">{t('catalog.mark.unpublished')}</Marker> : null}
          {a.blockers.length && item.status !== 'published' ? <Marker icon="alert" tone="alert">{t('catalog.mark.blockers', { n: a.blockers.length })}</Marker> : null}
          {a.openFlags ? <Marker icon="note" tone="heat">{t('catalog.mark.flags', { n: a.openFlags })}</Marker> : null}
          {missing.length ? <Marker icon="info">{t('catalog.mark.missing', { list: missing.join(', ') })}</Marker> : null}
          {a.thaiUnapproved ? <Marker icon="info">{t('catalog.mark.thaiUnapproved')}</Marker> : null}
        </div>
      </div>
      <div className="ct-row__status">
        <ItemStatusPill status={item.status} />
        <ReviewPill status={item.review_status} />
      </div>
      <span className="ct-row__open" aria-hidden="true">
        <span>{t('catalog.item.open')}</span>
        <Icon name="chev-r" size="sm" />
      </span>
    </li>
  );
}

function ChoiceGroups({ onEdit, canEdit }: { onEdit: (g: AdminModifierGroup | 'new') => void; canEdit: boolean }) {
  const { t, pick } = useI18n();
  const data = useMenuData();
  const groups = data.catalog?.modifier_groups ?? [];
  return (
    <section className="ct-groups" aria-labelledby="ct-groups-h">
      <header className="ct-groups__head">
        <h3 id="ct-groups-h">{t('catalog.groups.title')}</h3>
        <p>{t('catalog.groups.lede')}</p>
        {canEdit ? <Button variant="outline" size="staff" icon="plus" iconBold opensDialog onClick={() => onEdit('new')}>{t('catalog.groups.new')}</Button> : null}
      </header>
      {groups.length === 0 ? (
        <p className="ct-empty">{t('catalog.groups.none')}</p>
      ) : (
        <ul className="ct-glist">
          {groups.map((g) => {
            const name = pick(g.name);
            return (
              <li key={g.id} className="ct-g">
                <div className="ct-g__main">
                  <span className="ct-g__t" lang={name.lang}>{name.text}</span>
                  <span className="ct-g__rule">{ruleText(g, t)}</span>
                  <span className="ct-g__opts">
                    {g.options.map((o) => {
                      const on = pick(o.name);
                      return (
                        <Chip key={o.id} tone="line" className={o.available ? undefined : 'is-off'}>
                          <span lang={on.lang}>{on.text}</span>
                          {o.price_delta_minor ? <span className="x">+{money(o.price_delta_minor)}</span> : null}
                          {!o.available ? <span> · {t('common.optionOut')}</span> : null}
                        </Chip>
                      );
                    })}
                  </span>
                </div>
                <span className="ct-g__used">{t('catalog.groups.usedBy', { n: g.item_ids.length })}</span>
                <Button variant="ghost" size="staff" icon={canEdit ? 'note' : 'info'} opensDialog onClick={() => onEdit(g)} aria-label={t(canEdit ? 'catalog.groups.editNamed' : 'catalog.groups.viewNamed', { name: name.text })}>
                  {canEdit ? t('catalog.groups.edit') : t('catalog.category.view')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
