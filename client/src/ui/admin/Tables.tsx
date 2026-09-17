// Tables page pieces (DESIGN.md §10.18 large tiles, §10.19 drawer sections).
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';
import type { LineStatus, TableState } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { CheckButton, FilterChips, StaffSearch } from './Controls.tsx';
import { AttnBadge, STATE_SWATCH, type AttnKind } from './Floor.tsx';
import { Pill, StatusPill } from '../Badge.tsx';
import { Button, IconButton } from '../Button.tsx';
import { cx, Ico, safeId, type AdminIconName } from './parts.tsx';

// ------------------------------------------------------------------ large tile

export interface TileAction {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Describes why a disabled action is unavailable. */
  describedBy?: string;
}

export interface TableTileProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  label: string;
  state: TableState;
  /** Word badges with an optional count or time: [{ kind: 'call', detail: '19:50' }]. */
  attention?: Array<{ kind: AttnKind; detail?: string | number }>;
  /** Seated time, shown bold after "Seated" ("48 min"). */
  seated?: string;
  /** Further fact lines (rounds, unresolved items, bill). Available and Disabled have defaults. */
  facts?: ReactNode[];
  action?: TileAction;
  /** The drawer is open for this table: 3px ember outline. */
  selected?: boolean;
  ariaLabel?: string;
}

const TILE_STATE_ICON: Partial<Record<TableState, AdminIconName>> = { checking_out: 'receipt', disabled: 'lock' };

/** Large Tables-grid tile. The forwarded ref is the primary action button, so focus can return to it. */
export const TableTile = forwardRef<HTMLButtonElement, TableTileProps>(function TableTile(
  { label, state, attention = [], seated, facts, action, selected, ariaLabel, className, ...rest },
  ref,
) {
  const { t, lang } = useI18n();
  const stateWord = t(`table.${state}`);
  const icon = TILE_STATE_ICON[state];
  const factLines: ReactNode[] = [];
  if (state === 'dining' && seated) {
    factLines.push(<span key="seated">{t('common.tile.seated')} <b>{seated}</b></span>);
  }
  if (facts) factLines.push(...facts.map((f, i) => <span key={`f${i}`}>{f}</span>));
  if (factLines.length === 0 && state === 'available') factLines.push(<span key="d">{t('common.tile.noVisit')}</span>);
  if (factLines.length === 0 && state === 'disabled') factLines.push(<span key="d">{t('common.tile.noSeating')}</span>);

  const primary = state === 'checking_out';
  const actionLabel = action?.label ?? (
    state === 'available' ? t('common.tile.seat')
      : state === 'dining' ? (selected ? t('common.tile.detailsOpen') : t('common.tile.details'))
      : state === 'checking_out' ? t('common.tile.checkout')
      : t('common.tile.enable')
  );
  const spoken = ariaLabel ?? [
    t('common.table', { label }),
    lang === 'en' ? stateWord.toLowerCase() : stateWord,
    ...attention.map((a) => t(`common.attn.aria.${a.kind}`)),
  ].join(lang === 'th' ? ' ' : ', ');

  return (
    <article {...rest} className={cx('tcard', `tcard--${STATE_SWATCH[state]}`, selected && 'is-open', className)} aria-label={spoken}>
      <div className="tcard__top">
        <span className="tcard__n" aria-hidden="true">{label}</span>
        {attention.length > 0 ? (
          <span className="tcard__badges">
            {attention.map((a) => <AttnBadge key={a.kind} kind={a.kind} detail={a.detail} />)}
          </span>
        ) : null}
      </div>
      <p className="tcard__state">
        {icon ? <Ico name={icon} /> : null}
        {stateWord}
      </p>
      <p className="tcard__facts">{factLines}</p>
      {action ? (
        <div className="tcard__act">
          <Button
            ref={ref}
            variant={primary ? 'primary' : 'outline'}
            icon={state === 'available' ? 'seat' : undefined}
            loading={action.busy}
            aria-disabled={action.disabled || undefined}
            aria-describedby={action.describedBy}
            aria-expanded={state === 'dining' ? Boolean(selected) : undefined}
            opensDialog={state === 'disabled' || state === 'available'}
            onClick={action.onClick}
          >
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </article>
  );
});

// ------------------------------------------------------------------ summary bar

export type TableFilter = 'all' | TableState;

export interface TablesSummaryBarProps {
  counts: Record<TableState, number>;
  filter: TableFilter;
  onFilter: (filter: TableFilter) => void;
  attentionCount: number;
  attentionOnly: boolean;
  onAttentionOnly: (next: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  className?: string;
}

/** State filter whose "All" count is the sum of the four states, so the chips always reconcile. */
export function TablesSummaryBar({ counts, filter, onFilter, attentionCount, attentionOnly, onAttentionOnly, query, onQuery, className }: TablesSummaryBarProps) {
  const { t } = useI18n();
  const total = counts.available + counts.dining + counts.checking_out + counts.disabled;
  const states: TableState[] = ['available', 'dining', 'checking_out', 'disabled'];
  return (
    <div className={cx('tsum', className)} role="group" aria-label={t('common.tile.filter')}>
      <FilterChips<TableFilter>
        label={t('common.tile.state')}
        value={filter}
        onChange={onFilter}
        options={[
          { value: 'all', label: t('common.all'), count: total },
          ...states.map((s) => ({ value: s as TableFilter, label: t(`table.${s}`), count: counts[s], swatch: STATE_SWATCH[s] })),
        ]}
      />
      <CheckButton label={t('common.tile.needsAttention')} checked={attentionOnly} onChange={onAttentionOnly} count={attentionCount} />
      <StaffSearch label={t('common.tile.find')} placeholder={t('common.tile.find')} value={query} onChange={onQuery} />
    </div>
  );
}

// ------------------------------------------------------------------ drawer pieces

export interface TableDrawerHeaderProps {
  label: string;
  state: TableState;
  /** "Seated 19:04 · 48 min · 4 diners recorded by Nok" */
  meta?: ReactNode;
  onClose: () => void;
  titleId?: string;
  className?: string;
}

/** Framed "TABLE 07" box (54×56 on tickets, 64×64 in the drawer head). Decorative: the heading names the table. */
export function TableBox({ label, className }: { label: string; className?: string }) {
  const { t, lang } = useI18n();
  return (
    <div className={cx('tno', className)} aria-hidden="true">
      <span className="tno__k" lang={lang}>{t('common.ticket.table')}</span>
      <span className="tno__n">{label}</span>
    </div>
  );
}

/** Neutral pill with the state swatch and word, for the drawer title. */
export function TableStatePill({ state, className }: { state: TableState; className?: string }) {
  const { t } = useI18n();
  return (
    <Pill tone="neutral" size="sm" className={cx('tstate', className)}>
      <i className={cx('sw', `sw--${STATE_SWATCH[state]}`)} aria-hidden="true" />
      {t(`table.${state}`)}
    </Pill>
  );
}

/** Drawer head for a table, for use outside the kit Drawer (which takes TableBox as `lead` and TableStatePill as `status`). */
export function TableDrawerHeader({ label, state, meta, onClose, titleId, className }: TableDrawerHeaderProps) {
  const { t } = useI18n();
  return (
    <header className={cx('drawer__head', className)}>
      <TableBox label={label} />
      <div className="drawer__title">
        <h2 className="drawer__t" id={titleId}>
          {t('common.table', { label })} <TableStatePill state={state} />
        </h2>
        {meta ? <p className="drawer__s">{meta}</p> : null}
      </div>
      <IconButton icon="x" iconSize="lg" size="staff" label={`${t('common.close')} · ${t('common.table', { label })}`} onClick={onClose} />
    </header>
  );
}

export interface DrawerSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string;
  /** Right side of the head: meta text or a ghost action. */
  aside?: ReactNode;
  children?: ReactNode;
}

/** Oswald caps head + hairline-separated section. */
export function DrawerSection({ title, aside, children, className, ...rest }: DrawerSectionProps) {
  const { lang } = useI18n();
  const id = `ds-${safeId(useId())}`;
  return (
    <section {...rest} className={cx('dsec', className)} aria-labelledby={id}>
      <div className="dsec__h">
        <h3 id={id} lang={lang}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface GuestAccessPanelProps {
  /** Null when this role may not see it or no visit is open. */
  pin: string | null;
  revealed: boolean;
  onReveal: (next: boolean) => void;
  onRotate?: () => void;
  /** Opens the revoke confirmation (reason required). */
  onRevoke?: () => void;
  devices: number;
  /** Clock time until which joining is locked after wrong PINs. */
  lockedUntil?: string | null;
  rotating?: boolean;
  className?: string;
}

/** PIN cells (masked by default), Show PIN, Rotate PIN, Revoke access… */
export function GuestAccessPanel({ pin, revealed, onReveal, onRotate, onRevoke, devices, lockedUntil, rotating, className }: GuestAccessPanelProps) {
  const { t } = useI18n();
  const digits = pin ? Array.from(pin) : [];
  const cells = digits.length > 0 ? digits : ['', '', '', ''];
  return (
    <DrawerSection title={t('common.access.title')} aside={<span className="meta">{(devices === 1 ? t('common.access.device') : t('common.access.devices', { n: devices }))}</span>} className={className}>
      <dl className="kv">
        <dt>{t('common.access.pin')}</dt>
        <dd>
          <span className={cx('pin', revealed && pin && 'is-shown')} aria-hidden="true">
            {cells.map((d, i) => <span key={i}>{revealed ? d : '•'}</span>)}
          </span>
          <span className="sr" aria-live="polite">
            {!pin ? t('common.access.noPin') : revealed ? t('common.access.pinIs', { pin: digits.join(' ') }) : t('common.access.pinHidden')}
          </span>
        </dd>
      </dl>
      {lockedUntil ? (
        <p className="access__lock" role="status">
          <Ico name="lock" size="sm" />
          {t('common.access.locked', { time: lockedUntil })}
        </p>
      ) : null}
      <div className="access__actions">
        {pin ? (
          <Button variant="outline" size="staff" icon="key" onClick={() => onReveal(!revealed)}>
            {revealed ? t('common.access.hide') : t('common.access.show')}
          </Button>
        ) : null}
        {onRotate ? (
          <Button variant="outline" size="staff" icon="refresh" loading={rotating} onClick={onRotate}>
            {t('common.access.rotate')}
          </Button>
        ) : null}
        {onRevoke ? (
          <Button variant="danger" size="staff" opensDialog onClick={onRevoke}>
            {t('common.access.revoke')}
          </Button>
        ) : null}
      </div>
    </DrawerSection>
  );
}

export interface CheckoutBlockersProps {
  items: string[];
  title?: string;
  /** Referenced by the disabled Complete checkout button (aria-describedby). */
  id?: string;
  className?: string;
}

/** Alert-tint list naming exactly what still blocks Complete checkout. */
export function CheckoutBlockers({ items, title, id, className }: CheckoutBlockersProps) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className={cx('blockers', className)} role="status" id={id}>
      <b>
        <Ico name="info" size="sm" />
        {title ?? t('common.checkout.blocked')}
      </b>
      <ul>
        {items.map((b) => <li key={b}>{b}</li>)}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ rounds

/** StatusPill with the staff wording (New, Accepted, Preparing…) and an optional time ("Served 19:49"). */
export function LineStatusPill({ status, time, label, className }: { status: LineStatus; time?: string; label?: string; className?: string }) {
  const { t } = useI18n();
  const word = label ?? t(`common.staff.status.${status}`);
  return <StatusPill kind="line" status={status} size="sm" className={className} label={time ? `${word} ${time}` : word} />;
}

export interface RoundLineData {
  id: string;
  quantity: number;
  name: string;
  nameLang?: string;
  status: LineStatus;
  /** Shown after the status word for served lines ("Served 19:49"). */
  time?: string;
}

export interface RoundData {
  id: string;
  round: number;
  reference: string;
  sentAt?: string;
  lines: RoundLineData[];
  /** Every active line served: the round collapses to one ok pill ("All 3 served 19:31"). */
  allServedAt?: string | null;
}

export interface QuoteWellProps {
  name: string;
  nameLang?: string;
  /** "420 g · ฿2,058" */
  detail: string;
  /** "Awaiting guest · expires 20:05" */
  status: string;
  className?: string;
}

/** A pending portion quote inside the drawer, in a heat well. */
export function QuoteWell({ name, nameLang, detail, status, className }: QuoteWellProps) {
  return (
    <div className={cx('rhead rhead--quote', className)}>
      <b className="rhead__quote">
        <Ico name="scale" size="sm" />
        <span lang={nameLang}>{name}</span>
        <span className="num">· {detail}</span>
      </b>
      <span className="rhead__status">{status}</span>
    </div>
  );
}

export interface RoundListProps {
  rounds: RoundData[];
  /** Pending portion quotes shown after the rounds. */
  quotes?: QuoteWellProps[];
  className?: string;
}

/** Drawer rounds: per round a head (Round 2 · RG-4K7P, sent 19:42) and line rows with a status pill. */
export function RoundList({ rounds, quotes = [], className }: RoundListProps) {
  const { t } = useI18n();
  return (
    <div className={cx('rounds', className)}>
      {rounds.map((r) => {
        const count = r.lines.filter((l) => l.status !== 'cancelled' && l.status !== 'rejected').reduce((n, l) => n + l.quantity, 0);
        return (
          <div key={r.id} className="rround">
            <div className="rhead">
              <b>
                {t('common.ticket.round', { n: r.round })} · <span className="code" lang="en">{r.reference}</span>
              </b>
              {r.allServedAt ? (
                <Pill tone="ok" icon="check" size="sm">
                  {t('common.round.allServed', { n: count, time: r.allServedAt })}
                </Pill>
              ) : r.sentAt ? (
                <span className="meta">{t('common.round.sent', { time: r.sentAt })}</span>
              ) : null}
            </div>
            {r.allServedAt ? null : (
              <ul className="rlines">
                {r.lines.map((l) => (
                  <li key={l.id} className={cx('rline', (l.status === 'cancelled' || l.status === 'rejected') && 'is-void')}>
                    <span className="rline__q">{l.quantity}</span>
                    <span className="rline__th" lang={l.nameLang}>{l.name}</span>
                    <LineStatusPill status={l.status} time={l.status === 'served' ? l.time : undefined} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {quotes.map((q, i) => <QuoteWell key={`q${i}`} {...q} />)}
    </div>
  );
}

// ------------------------------------------------------------------ history

export interface HistoryItem {
  id: string;
  time: string;
  event: string;
  /** " · Prime Rib 420 g · Nok" */
  detail?: string;
}

/** Newest-first event list: Oswald time + bold event + details and actor. */
export function HistoryList({ items, className }: { items: HistoryItem[]; className?: string }) {
  return (
    <ol className={cx('hist', className)}>
      {items.map((h) => (
        <li key={h.id}>
          <time>{h.time}</time>
          <span>
            <b>{h.event}</b>
            {h.detail ? ` · ${h.detail}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
