// /admin/audit (audit.view): filters kept in the URL (so Back and links from
// other screens work), newest-first entries grouped by business day, keyset
// "load older" pagination, before/after diffs (sensitive fields arrive
// already masked) and links to the related table, item, report or settings.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AuditEntryDTO, StaffUserDTO } from '../../../../shared/dto.ts';
import { businessDate, todayBusinessDate } from '../../../../shared/time.ts';
import { api, qs } from '../../lib/api.ts';
import { clock, dateLabel, money, num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import { navigate, setQuery, useRoute } from '../../lib/router.ts';
import { AuditEntry, AuditList, Badge, Button, EmptyState, Icon, Select, Tag, TextField, TextLink, useAnnounce, type AuditChange } from '../../ui/index.ts';
import { useMedia } from '../../lib/store.ts';
import { useStaff } from '../shell/session.tsx';
import { Denied, langOf, MorePageFrame, ResourceGate, StaleBanner, useErrorWords, usePlural } from './shared.tsx';

interface AuditPageDTO { entries: AuditEntryDTO[]; next_before: number | null }

const PAGE = 50;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const FILTER_KEYS = ['entity_type', 'entity_id', 'visit_id', 'actor', 'action', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

const ENTITY_TYPES = [
  'order', 'order_line', 'visit', 'table', 'bill', 'bill_adjustment', 'payment', 'service_request', 'portion_request',
  'guest_session', 'feedback', 'menu_item', 'menu_category', 'modifier_group', 'menu_import', 'settings', 'staff_user', 'report_job',
] as const;

const ACTION_GROUPS = ['order.', 'visit.', 'table.', 'bill.', 'payment.', 'service.', 'portion.', 'menu.', 'ordering.', 'settings.', 'team.', 'report.', 'staff.', 'guest.'] as const;

// ------------------------------------------------------------------ diff
const MASK = '[hidden]';

function isPlain(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function flatten(v: unknown, prefix = '', depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isPlain(v) && depth < 2) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  } else if (prefix) {
    out[prefix] = v;
  }
  return out;
}

function useValueText() {
  const { t, lang } = useI18n();
  return (field: string, v: unknown): ReactNode => {
    if (v === undefined || v === null || v === '') return '';
    if (v === MASK) return <Tag tone="neutral" icon="lock">{t('audit.hidden')}</Tag>;
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (typeof v === 'number') return /(_minor|amount|total)$/.test(field) && Number.isInteger(v) ? money(v) : num(v);
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return `${dateLabel(businessDate(v), lang, { year: true })}, ${clock(v)}`;
      return <span lang={langOf(v)}>{v.length > 160 ? `${v.slice(0, 157)}…` : v}</span>;
    }
    const json = JSON.stringify(v);
    return <code className="audit-json" title={json.length > 200 ? json : undefined}>{json.length > 200 ? `${json.slice(0, 197)}…` : json}</code>;
  };
}

/** Lists of records with ids (charges, payment methods) become objects keyed by id so each field diffs on its own. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v) && v.length > 0 && v.every((x) => isPlain(x) && typeof x.id === 'string')) {
    return Object.fromEntries(v.map((x) => [(x as { id: string }).id, x]));
  }
  if (Array.isArray(v) && v.length === 0) return {};
  return v;
}

function changesOf(e: AuditEntryDTO, text: (field: string, v: unknown) => ReactNode, settingKey: string | null): AuditChange[] {
  const b0 = normalize(e.before);
  const a0 = normalize(e.after);
  const plainish = (v: unknown) => v == null || isPlain(v);
  const label = (f: string) => f.replace(/_minor\b/g, '').replace(/_/g, ' ').replace(/\./g, ' · ');
  if (!plainish(b0) || !plainish(a0)) {
    // Scalars or plain lists: one row with both values.
    return [{ field: settingKey ? label(settingKey) : '·', before: text(settingKey ?? '', e.before), after: text(settingKey ?? '', e.after) }];
  }
  const before = flatten(b0);
  const after = flatten(a0);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out: AuditChange[] = [];
  for (const f of fields) {
    const b = before[f];
    const a = after[f];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out.push({ field: label(f), before: text(f, b), after: text(f, a) });
    if (out.length >= 24) break;
  }
  return out;
}

// ------------------------------------------------------------------ page
export default function AuditPage() {
  const { t, lang, has } = useI18n();
  const { me, can } = useStaff();
  const { query } = useRoute();
  const announce = useAnnounce();
  const { errorText } = useErrorWords();
  const plural = usePlural();
  const allowed = can('audit.view');
  const today = todayBusinessDate(0);

  const applied: Filters = useMemo(() => {
    const f = {} as Filters;
    for (const k of FILTER_KEYS) f[k] = query.get(k) ?? '';
    return f;
  }, [query]);
  const activeCount = FILTER_KEYS.filter((k) => applied[k]).length;
  const filterProblem = (f: Filters) => (
    (f.from && !ISO.test(f.from)) || (f.to && !ISO.test(f.to)) ? t('audit.err.date')
      : f.from && f.to && f.from > f.to ? t('audit.err.order')
      : null
  );

  // A broken date range from a typed URL is shown as an error and left out of the query.
  const query_: Filters = filterProblem(applied) ? { ...applied, from: '', to: '' } : applied;
  const path = allowed ? `/api/staff/audit${qs({ ...query_, limit: PAGE })}` : null;
  const first = useResource<AuditPageDTO>(path);
  const team = useResource<{ users: StaffUserDTO[] }>(allowed && can('team.manage') ? '/api/staff/team' : null);

  // older pages appended below the first page
  const [older, setOlder] = useState<AuditEntryDTO[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const firstKey = `${path}|${first.fetchedAt}`;
  const [seen, setSeen] = useState(firstKey);
  if (seen !== firstKey) {
    setSeen(firstKey);
    setOlder([]);
    setCursor(first.data?.next_before ?? null);
    setMoreError(null);
  }
  const entries = useMemo(() => [...(first.data?.entries ?? []), ...older], [first.data, older]);
  const nextBefore = older.length ? cursor : first.data?.next_before ?? null;

  const loadOlder = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get<AuditPageDTO>(`/api/staff/audit${qs({ ...query_, limit: PAGE, before: nextBefore })}`);
      setOlder((o) => [...o, ...page.entries]);
      setCursor(page.next_before);
      announce(plural('audit.loadedMore', page.entries.length));
      // keep focus in the list: move it to the first new entry
      requestAnimationFrame(() => document.getElementById(`audit-${page.entries[0]?.id}`)?.focus());
    } catch (err) {
      setMoreError(errorText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  // ---- filter form (draft until applied)
  const [draft, setDraft] = useState<Filters>(applied);
  const appliedKey = JSON.stringify(applied);
  const [draftFor, setDraftFor] = useState(appliedKey);
  if (draftFor !== appliedKey) { setDraftFor(appliedKey); setDraft(applied); }
  const draftProblem = filterProblem(draft);
  const apply = (next: Filters) => {
    if (filterProblem(next)) return;
    const patch: Record<string, string | null> = {};
    for (const k of FILTER_KEYS) patch[k] = next[k].trim() || null;
    setQuery(patch, { replace: false });
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); apply(draft); };
  const setAndApply = (k: FilterKey, v: string) => { const next = { ...draft, [k]: v }; setDraft(next); apply(next); };

  const listRef = useRef<HTMLDivElement>(null);
  const phone = useMedia('(max-width: 719px)');
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    if (first.data && activeCount) announce(plural('audit.results', first.data.entries.length, { more: first.data.next_before ? t('audit.resultsMore') : '' }));
    // announce once per applied filter set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.fetchedAt]);

  const valueText = useValueText();

  if (!allowed) {
    return (
      <MorePageFrame title={t('audit.title')}>
        <Denied what={t('audit.title')} />
      </MorePageFrame>
    );
  }

  const actionLabel = (a: string) => (has(`audit.action.${a}`) ? t(`audit.action.${a}`) : a);
  const entityLabel = (type: string) => (has(`audit.entity.${type}`) ? t(`audit.entity.${type}`) : type.replace(/_/g, ' '));
  const shortId = (id: string) => (id.length > 10 ? `…${id.slice(-6)}` : id);

  const target = (e: AuditEntryDTO): ReactNode => {
    const bits: ReactNode[] = [];
    const tag = (e.after as Record<string, unknown> | null)?.table ?? (e.before as Record<string, unknown> | null)?.table;
    bits.push(
      <span key="e">
        {entityLabel(e.entity_type)}
        {e.entity_id ? <> <span className="audit-id" lang="en" title={e.entity_id}>{e.entity_type === 'settings' ? e.entity_id : shortId(e.entity_id)}</span></> : null}
        {typeof tag === 'string' ? <> · {t('audit.table', { label: tag })}</> : null}
      </span>,
    );
    const links: ReactNode[] = [];
    if (e.entity_id) {
      if (e.entity_type === 'table' && can('tables.view')) links.push(<TextLink key="t" href={`/admin/tables/${e.entity_id}`}>{t('audit.link.table')}</TextLink>);
      if (e.entity_type === 'menu_item' && can('menu.view')) links.push(<TextLink key="m" href={`/admin/menu/items/${e.entity_id}`}>{t('audit.link.item')}</TextLink>);
      if (e.entity_type === 'settings' && can('settings.manage')) links.push(<TextLink key="s" href={`/admin/settings#${settingsAnchor(e.entity_id)}`}>{t('audit.link.settings')}</TextLink>);
      if (e.entity_type === 'report_job' && can('reports.view')) links.push(<TextLink key="r" href="/admin/reports">{t('audit.link.reports')}</TextLink>);
      if (e.entity_type === 'staff_user' && can('team.manage')) links.push(<TextLink key="u" href="/admin/team">{t('audit.link.team')}</TextLink>);
      if (applied.entity_id !== e.entity_id) {
        links.push(
          <button key="f" type="button" className="textlink audit-filter" onClick={() => apply({ ...emptyFilters(), entity_type: e.entity_type, entity_id: e.entity_id! })}>
            {t('audit.link.history')}
          </button>,
        );
      }
    }
    if (e.visit_id && applied.visit_id !== e.visit_id) {
      links.push(
        <button key="v" type="button" className="textlink audit-filter" onClick={() => apply({ ...emptyFilters(), visit_id: e.visit_id! })}>
          {t('audit.link.visit')}
        </button>,
      );
    }
    return (
      <>
        {bits}
        {links.length ? <span className="audit-links">{links}</span> : null}
      </>
    );
  };

  // group by Bangkok business date
  const groups: Array<{ date: string; items: AuditEntryDTO[] }> = [];
  for (const e of entries) {
    const d = businessDate(e.at);
    const last = groups[groups.length - 1];
    if (last && last.date === d) last.items.push(e);
    else groups.push({ date: d, items: [e] });
  }

  const actorOptions = [
    { value: '', label: t('audit.actor.any') },
    { value: me.user.id, label: t('audit.actor.me', { name: me.user.display_name }) },
    { value: 'staff', label: t('audit.actor.staff') },
    { value: 'guest', label: t('audit.actor.guest') },
    { value: 'system', label: t('audit.actor.system') },
    ...(team.data?.users ?? []).filter((u) => u.id !== me.user.id).map((u) => ({ value: u.id, label: u.display_name })),
  ];
  if (draft.actor && !actorOptions.some((o) => o.value === draft.actor)) actorOptions.push({ value: draft.actor, label: t('audit.actor.id', { id: shortId(draft.actor) }) });

  return (
    <MorePageFrame title={t('audit.title')} description={t('audit.lede')} wide>
      <form className="auditf" onSubmit={onSubmit} aria-labelledby="auditf-h" noValidate>
        {phone ? (
          <h2 className="auditf__h" id="auditf-h">
            <button type="button" className="auditf__toggle" aria-expanded={filtersOpen} aria-controls="auditf-grid" onClick={() => setFiltersOpen(!filtersOpen)}>
              <Icon name="filter" />
              <span>{t('audit.filters')}</span>
              {activeCount ? <Badge count={activeCount} label={plural('audit.activeFilters', activeCount)} /> : null}
              <Icon name="chev-d" className={filtersOpen ? 'auditf__chev is-open' : 'auditf__chev'} />
            </button>
          </h2>
        ) : (
          <h2 className="sr" id="auditf-h">{t('audit.filters')}</h2>
        )}
        <div className="auditf__grid" id="auditf-grid" hidden={phone && !filtersOpen}>
          <Select density="staff" label={t('audit.f.entity')} value={draft.entity_type} onChange={(e) => setAndApply('entity_type', e.target.value)}>
            <option value="">{t('audit.f.anyEntity')}</option>
            {ENTITY_TYPES.map((x) => <option key={x} value={x}>{entityLabel(x)}</option>)}
            {draft.entity_type && !(ENTITY_TYPES as readonly string[]).includes(draft.entity_type) ? <option value={draft.entity_type}>{draft.entity_type}</option> : null}
          </Select>
          <Select density="staff" label={t('audit.f.action')} value={draft.action} onChange={(e) => setAndApply('action', e.target.value)}>
            <option value="">{t('audit.f.anyAction')}</option>
            {ACTION_GROUPS.map((x) => <option key={x} value={x}>{t(`audit.group.${x.slice(0, -1)}`)}</option>)}
            {draft.action && !(ACTION_GROUPS as readonly string[]).includes(draft.action) ? <option value={draft.action}>{actionLabel(draft.action)}</option> : null}
          </Select>
          <Select density="staff" label={t('audit.f.actor')} value={draft.actor} onChange={(e) => setAndApply('actor', e.target.value)} options={actorOptions} help={can('team.manage') ? undefined : t('audit.f.actorHelp')} />
          <TextField density="staff" type="date" label={t('audit.f.from')} value={draft.from} max={today} onChange={(e) => setAndApply('from', e.target.value)} />
          <TextField density="staff" type="date" label={t('audit.f.to')} value={draft.to} max={today} onChange={(e) => setAndApply('to', e.target.value)} error={draftProblem ?? undefined} />
          <TextField density="staff" label={t('audit.f.entityId')} value={draft.entity_id} lang="en" spellCheck={false} autoComplete="off" placeholder={t('audit.f.idPh')} onChange={(e) => setDraft({ ...draft, entity_id: e.target.value })} />
          <TextField density="staff" label={t('audit.f.visit')} value={draft.visit_id} lang="en" spellCheck={false} autoComplete="off" placeholder={t('audit.f.visitPh')} onChange={(e) => setDraft({ ...draft, visit_id: e.target.value })} />
        </div>
        <div className="auditf__foot">
          <p className="mp-meta" aria-live="polite">
            {activeCount ? plural('audit.activeFilters', activeCount) : t('audit.noFilters')}
          </p>
          <div className="auditf__btns">
            {activeCount ? (
              <Button variant="ghost" size="staff" icon="x" onClick={() => navigate('/admin/audit')}>{t('audit.clear')}</Button>
            ) : null}
            {!phone || filtersOpen ? (
              <Button type="submit" variant="outline" size="staff" icon="filter" disabled={Boolean(draftProblem) || JSON.stringify(draft) === appliedKey}>{t('audit.apply')}</Button>
            ) : null}
            <Button variant="ghost" size="staff" icon="refresh" loading={first.loading && Boolean(first.data)} onClick={() => void first.refresh()}>{t('common.refresh')}</Button>
          </div>
        </div>
      </form>

      <StaleBanner error={first.data ? first.error : null} onRetry={() => void first.refresh()} busy={first.loading} />

      <div ref={listRef} className="auditv" aria-busy={first.loading || undefined}>
        {!first.data ? (
          <ResourceGate error={first.error} loading={first.loading} onRetry={() => void first.refresh()} what={t('audit.title')} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon="track"
            headingLevel={2}
            title={activeCount ? t('audit.empty.filtered') : t('audit.empty.none')}
            action={activeCount ? <Button variant="outline" size="staff" onClick={() => navigate('/admin/audit')}>{t('audit.clear')}</Button> : undefined}
          >
            {activeCount ? t('audit.empty.filteredD') : t('audit.empty.noneD')}
          </EmptyState>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.date} className="auditday" aria-labelledby={`auditday-${g.date}`}>
                <h2 className="auditday__h" id={`auditday-${g.date}`}>
                  {g.date === today ? t('audit.today') : dateLabel(g.date, lang, { weekday: true, year: true })}
                  <span className="auditday__n"> · {plural('audit.count', g.items.length)}</span>
                </h2>
                <AuditList>
                  {g.items.map((e) => (
                    <AuditEntry
                      key={e.id}
                      id={`audit-${e.id}`}
                      tabIndex={-1}
                      time={clock(e.at)}
                      at={e.at}
                      actor={e.actor_type === 'system' ? t(e.actor_label === 'command line' ? 'audit.actor.cli' : 'audit.actor.job') : e.actor_label ?? t(`common.audit.${e.actor_type}`)}
                      actorType={e.actor_type}
                      action={actionLabel(e.action)}
                      target={target(e)}
                      reason={e.reason === 'Applies to orders and visits created from now on' ? t('audit.reason.futureOnly') : e.reason}
                      changes={changesOf(e, valueText, e.entity_type === 'settings' ? e.entity_id : null)}
                    />
                  ))}
                </AuditList>
              </section>
            ))}
            <div className="auditv__more">
              {nextBefore ? (
                <Button variant="outline" size="staff" icon="chev-d" loading={loadingMore} onClick={() => void loadOlder()}>
                  {t('audit.older')}
                </Button>
              ) : (
                <p className="mp-meta">{t('audit.end')}</p>
              )}
              <p className="mp-meta">{plural('audit.shown', entries.length)}</p>
              {moreError ? <p className="mp-alert" role="alert">{moreError}</p> : null}
            </div>
          </>
        )}
      </div>
    </MorePageFrame>
  );
}

function emptyFilters(): Filters {
  return { entity_type: '', entity_id: '', visit_id: '', actor: '', action: '', from: '', to: '' };
}

function settingsAnchor(key: string): string {
  const map: Record<string, string> = {
    restaurant: 'restaurant', default_locale: 'restaurant', operating_mode: 'mode', business_day_cutoff_hour: 'day',
    ordering: 'ordering', services: 'services', service_cooldown_seconds: 'services', charges: 'charges', charges_confirmed: 'charges',
    payment_methods: 'payments', join: 'join', menu: 'menu', portions: 'portions', checkout: 'checkout', alcohol: 'alcohol',
    analytics: 'analytics', retention: 'retention', notifications: 'notifications', role_permissions: 'permissions',
  };
  return map[key] ?? '';
}
