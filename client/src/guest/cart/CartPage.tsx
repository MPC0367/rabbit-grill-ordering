// "Your order" (brief 12, 13, 34; DESIGN §8.1, §10.11, §10.25). Stream C1b.
//
//   /menu/cart               the private draft: lines, fixes, subtotal, Send order
//   /menu/cart?step=review   the review step: table, items, notes, total, Place order,
//                            and every submission state (sending, checking, retry, refused)
//
// Never "checkout": that word belongs to ending the visit. An unresolved
// attempt always shows the review step, whatever the URL says, so a guest who
// reloads mid-send sees "checking" instead of a fresh Send button.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ChargeLine } from '../../../../shared/money.ts';
import type { MenuItemDTO } from '../../../../shared/dto.ts';
import { clock } from '../../lib/format.ts';
import { dictionaries } from '../../i18n/index.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate, setQuery, useRoute } from '../../lib/router.ts';
import { useTrackRoute } from '../../lib/tracker.ts';
import {
  Button, Card, EmptyState, Icon, Leader, LinkButton, PageHead, Price, RunningTotal, Skeleton, Tag, TextLink,
  announce, cx, useToast,
} from '../../ui/index.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { useGuestLiveState } from '../shell/hooks.ts';
import { useOverlays } from '../shell/overlays.tsx';
import { useGuestSession } from '../shell/session.tsx';
import NoAccessPanel from '../visit/NoAccessPanel.tsx';
import { DraftLine } from './DraftLine.tsx';
import { useOrderingState } from './ordering.ts';
import {
  noteCatalogVersion, removeLine, requote, restoreLine, updateLine, useCart, type CartView, type LineView,
} from './store.ts';
import {
  BLOCKING_CODES, checkNow, discardAttempt, markOutcomeHandled, placeOrder, resetOutcome, retrySubmission, useSubmission,
  type SubmitState,
} from './submit.ts';
import './cart.css';

type Step = 'list' | 'review';

export default function CartPage() {
  useTrackRoute('cart');
  const { t } = useI18n();
  const { query } = useRoute();
  const session = useGuestSession();
  const cart = useCart();
  const sub = useSubmission();
  const { catalog } = useCatalog();
  const unresolved = sub.phase === 'sending' || sub.phase === 'checking' || sub.phase === 'retry';
  const step: Step = unresolved || (query.get('step') === 'review' && cart.lines.length > 0) ? 'review' : 'list';

  const lastStep = useRef<Step | null>(null);
  const stepChanged = lastStep.current !== null && lastStep.current !== step;
  useEffect(() => { lastStep.current = step; }, [step]);

  useEffect(() => { noteCatalogVersion(catalog?.version); }, [catalog?.version]);

  // A server-confirmed round: announce it and hand over to Track (never from local state).
  useEffect(() => {
    if (sub.phase !== 'received' || !sub.order || sub.handled) return;
    const ref = sub.order.reference;
    markOutcomeHandled();
    announce(t('submit.received', { ref }), 'polite');
    resetOutcome();
    navigate(`/menu/orders?placed=${encodeURIComponent(ref)}`, { replace: true });
  }, [sub.phase, sub.order, sub.handled, t]);

  // A refusal that says ordering is blocked: learn the new state now.
  useEffect(() => {
    if (sub.phase === 'rejected' && sub.error && (BLOCKING_CODES as readonly string[]).includes(sub.error.code)) void session.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.phase, sub.error]);

  if (session.mode === 'loading') {
    return (
      <main className="g-main c1b-page c1b-page--narrow" aria-busy="true">
        <div className="c1b-skel" role="status" aria-label={t('cart.loading')}>
          <Skeleton width="40%" height={16} />
          <Skeleton width="60%" height={34} />
          <Skeleton shape="block" height={120} />
          <Skeleton shape="block" height={120} />
        </div>
      </main>
    );
  }

  if (session.mode !== 'joined') {
    const reason = session.mode === 'ended' ? (session.endedReason === 'visit_access_revoked' ? 'revoked' : 'required') : 'public';
    return (
      <main className="g-main c1b-page c1b-page--narrow">
        <PageHead title={t('cart.title')} />
        <NoAccessPanel reason={reason} />
      </main>
    );
  }

  return step === 'review'
    ? <ReviewStep key="review" cart={cart} sub={sub} focus={stepChanged} />
    : <ListStep key="list" cart={cart} sub={sub} focus={stepChanged} />;
}

// ------------------------------------------------------------------ shared bits
/**
 * Moving between the two steps puts focus on the new heading (the shell does
 * the same for route changes, so a first arrival is left to it).
 */
function useStepFocus<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return;
    const h1 = ref.current?.querySelector<HTMLElement>('h1');
    if (!h1 || document.querySelector('dialog[open]')) return;
    if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/** The English page name beside the Thai title (as on Track); nothing extra in English. */
function useSecondaryTitle(key: string): string | undefined {
  const { lang } = useI18n();
  return lang === 'th' ? dictionaries.en[key] : undefined;
}

function Notice({ tone = 'info', icon, title, children, action, live = 'polite', id }: {
  tone?: 'info' | 'alert' | 'heat' | 'ok';
  icon: Parameters<typeof Icon>[0]['name'];
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  live?: 'polite' | 'assertive' | 'off';
  id?: string;
}) {
  return (
    <div
      id={id}
      tabIndex={-1}
      className={cx('c1b-notice', `c1b-notice--${tone}`)}
      role={live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined}
    >
      <Icon name={icon} />
      <div className="c1b-notice__body">
        {title ? <p className="c1b-notice__t">{title}</p> : null}
        {children ? <p>{children}</p> : null}
        {action ? <div className="c1b-notice__act">{action}</div> : null}
      </div>
    </div>
  );
}

function chargeLabel(c: ChargeLine, lang: string): string {
  return lang === 'th' ? c.label_th || c.label_en : c.label_en || c.label_th;
}

/** Subtotal, configured charges (only when the owner configured any) and the honest note. */
function Totals({ cart, subtotal, count, showCharges, note, className }: {
  cart: CartView;
  subtotal: number;
  count: number;
  showCharges: boolean;
  note: ReactNode;
  className?: string;
}) {
  const { t, lang } = useI18n();
  const charges = showCharges ? cart.quote?.charges_preview ?? [] : [];
  const exclusive = charges.filter((c) => !c.inclusive);
  const estimated = cart.quoteStatus === 'offline' || cart.quoteStatus === 'error' || cart.quoteStatus === 'denied';
  return (
    <div className={cx('c1b-totals', className)}>
      <RunningTotal
        label={(
          <span className="c1b-totals__label">
            {t(count === 1 ? 'cart.subtotalOne' : 'cart.subtotal', { n: count })}
            {estimated ? <Tag tone="heat" className="c1b-totals__est">{t('cart.estimate')}</Tag> : null}
          </span>
        )}
        totalMinor={subtotal}
        size="total"
        note={charges.length ? undefined : note}
      />
      {charges.length ? (
        <dl className="c1b-charges">
          {charges.map((c) => (
            <Leader
              key={c.id}
              definition
              label={c.inclusive ? t('cart.chargeInclusive', { label: chargeLabel(c, lang) }) : chargeLabel(c, lang)}
              value={<Price minor={c.amount_minor} size="sm" />}
            />
          ))}
          {exclusive.length && cart.quote ? (
            <Leader
              definition
              strong
              label={t('cart.estimatedTotal')}
              value={<Price minor={cart.subtotalMinor + exclusive.reduce((s, c) => s + c.amount_minor, 0)} size="total" />}
            />
          ) : null}
        </dl>
      ) : null}
      {charges.length ? <p className="bill__note">{note}</p> : null}
    </div>
  );
}

function QuoteStatusNote({ cart }: { cart: CartView }) {
  const { t } = useI18n();
  const liveState = useGuestLiveState();
  if (cart.quoteStatus === 'offline' || (liveState === 'offline' && cart.lines.length > 0)) {
    return <Notice tone="heat" icon="wifi-off">{t('cart.check.offline')}</Notice>;
  }
  if (cart.quoteStatus === 'denied') {
    return <Notice tone="alert" icon="alert">{t('cart.check.denied')}</Notice>;
  }
  if (cart.quoteStatus === 'error') {
    return (
      <Notice
        tone="heat"
        icon="alert"
        title={t('cart.check.error')}
        action={<Button variant="outline" icon="refresh" onClick={() => void requote()}>{t('cart.check.retry')}</Button>}
      >
        {cart.quoteError ? t(`error.${cart.quoteError.code}`) : null}
      </Notice>
    );
  }
  return null;
}

// ------------------------------------------------------------------ list step
function ListStep({ cart, sub, focus }: { cart: ReturnType<typeof useCart>; sub: SubmitState; focus: boolean }) {
  const { t, both } = useI18n();
  const secondaryTitle = useSecondaryTitle('cart.title');
  const { item } = useCatalog();
  const { openItem, openPortion } = useOverlays();
  const ordering = useOrderingState();
  const toast = useToast();
  const liveState = useGuestLiveState();
  const pageRef = useStepFocus<HTMLElement>(focus);
  const hintId = useId();
  const listId = useId();
  const changedRef = useRef<HTMLDivElement>(null);

  // A refused send because something changed: point at it once.
  const changed = sub.phase === 'rejected' && sub.error?.code === 'cart_changed';
  useEffect(() => {
    if (changed) changedRef.current?.querySelector<HTMLElement>('.c1b-notice')?.focus();
  }, [changed]);

  const nameOf = (v: LineView) => {
    const it = item(v.line.item_id);
    return (it ? both(it.name).primary.text : '') || v.line.name.th || v.line.name.en || '';
  };

  const onQuantity = (uid: string, quantity: number) => {
    if (sub.phase === 'rejected') resetOutcome();
    updateLine(uid, { quantity });
  };
  const onRemove = (uid: string) => {
    const v = cart.viewOf(uid);
    if (!v) return;
    const index = cart.lines.findIndex((l) => l.uid === uid);
    const removed = removeLine(uid);
    if (!removed) return;
    if (sub.phase === 'rejected') resetOutcome();
    toast.show({ message: t('item.removed', { name: nameOf(v) }), action: { label: t('common.undo'), onClick: () => restoreLine(removed, index) } });
    // Keep focus inside the list after the row disappears.
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>(`#${CSS.escape(listId)} .c1b-line`);
      const next = rows[Math.min(index, rows.length - 1)];
      (next?.querySelector<HTMLElement>('button') ?? pageRef.current?.querySelector<HTMLElement>('h1'))?.focus();
    });
  };
  const onEdit = (uid: string, itemId: string) => openItem(itemId, { lineUid: uid });
  const onAcceptPrice = (uid: string, unit: number) => {
    const v = cart.viewOf(uid);
    updateLine(uid, { expected_unit_minor: unit });
    if (sub.phase === 'rejected') resetOutcome();
    if (v) announce(t('cart.accepted', { name: nameOf(v) }), 'polite');
  };

  if (cart.lines.length === 0) {
    return (
      <main ref={pageRef} className="g-main c1b-page c1b-page--narrow">
        <PageHead
          kicker={ordering.tableLabel ? t('cart.kicker', { table: ordering.tableLabel }) : t('cart.kickerNoTable')}
          title={t('cart.title')}
          secondary={secondaryTitle}
          secondaryLang="en"
        />
        <Card className="c1b-empty">
          <EmptyState
            icon="pad"
            headingLevel={2}
            title={t('cart.empty.title')}
            action={<LinkButton href="/menu" variant="secondary" icon="book">{t('cart.empty.action')}</LinkButton>}
          >
            {t('cart.empty.body')}
          </EmptyState>
        </Card>
        <DraftExplainer />
      </main>
    );
  }

  const offline = cart.quoteStatus === 'offline' || liveState === 'offline';
  const pendingElsewhere = sub.pending !== null;
  const canSend = !ordering.block && !cart.reviewNeeded && !offline && !pendingElsewhere && cart.quoteStatus !== 'denied';
  const hint = ordering.block ? `${ordering.block.title} · ${ordering.block.code === 'visit_billing' ? ordering.block.body : t('cart.block.kept')}`
    : cart.reviewNeeded ? t('cart.hint.issues')
      : offline ? t('cart.hint.offline')
        : !cart.ready ? t('cart.hint.checking')
          : '';

  const goReview = () => {
    if (!canSend) {
      const firstIssue = document.querySelector<HTMLElement>(`#${CSS.escape(listId)} .has-issue button, #${CSS.escape(listId)} .has-issue`);
      if (cart.reviewNeeded && firstIssue) firstIssue.focus();
      return;
    }
    resetOutcome();
    setQuery({ step: 'review' }, { replace: false });
  };

  return (
    <main ref={pageRef} className="g-main c1b-page">
      <div className="c1b-page__main">
        <PageHead
          kicker={ordering.tableLabel ? t('cart.kicker', { table: ordering.tableLabel }) : t('cart.kickerNoTable')}
          title={t('cart.title')}
          secondary={secondaryTitle}
          secondaryLang="en"
          support={t('cart.lede')}
        />
        <div className="c1b-stack">
          {changed ? (
            <div ref={changedRef}>
              <Notice tone="alert" icon="alert" title={t('submit.changed.title')} live="assertive">{t('submit.changed.body')}</Notice>
            </div>
          ) : null}
          {sub.phase === 'rejected' && sub.error && !changed && !(BLOCKING_CODES as readonly string[]).includes(sub.error.code) ? (
            <RejectionNotice sub={sub} />
          ) : null}
          <QuoteStatusNote cart={cart} />
        </div>

        <section aria-labelledby={`${listId}-h`} className="c1b-listsec">
          <h2 id={`${listId}-h`} className="visually-hidden">{t('cart.listLabel')}</h2>
          <Card padded className="c1b-card">
            <ul id={listId} className="c1b-lines">
              {cart.views.map((v) => (
                <DraftLine
                  key={v.line.uid}
                  view={v}
                  item={item(v.line.item_id)}
                  mode="edit"
                  example={exampleFor(item(v.line.item_id))}
                  locked={pendingElsewhere}
                  onQuantity={onQuantity}
                  onRemove={onRemove}
                  onEdit={onEdit}
                  onAcceptPrice={onAcceptPrice}
                  onWeigh={openPortion}
                />
              ))}
            </ul>
          </Card>
        </section>
      </div>

      <aside className="c1b-page__side" aria-labelledby={`${listId}-sum`}>
        <Card padded className="c1b-summary">
          <h2 id={`${listId}-sum`} className="c1b-summary__t">{t('submit.roundTotal')}</h2>
          <Totals
            cart={cart}
            subtotal={cart.subtotalMinor}
            count={cart.views.filter((v) => v.issues.length === 0).reduce((n, v) => n + v.line.quantity, 0)}
            showCharges={cart.ready}
            note={t('cart.totalNote')}
          />
          {pendingElsewhere ? (
            <Button variant="primary" size="lg" block icon="clock" className="c1b-send" onClick={() => setQuery({ step: 'review' }, { replace: false })}>
              {t('cart.hint.pendingOpen')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              block
              className="c1b-send"
              priceMinor={cart.subtotalMinor}
              aria-disabled={!canSend || undefined}
              aria-describedby={hint ? hintId : undefined}
              onClick={goReview}
              data-testid="cart-send"
            >
              {t('cart.send')}
            </Button>
          )}
          {pendingElsewhere ? <p className="meta c1b-hint">{t('cart.hint.pending')}</p> : hint ? (
            <p className="meta c1b-hint" id={hintId} role="status" data-block={ordering.block?.code}>
              {ordering.block ? <Icon name={ordering.block.code === 'visit_billing' ? 'receipt' : 'pause'} size="sm" /> : !cart.ready && !cart.reviewNeeded && !offline ? <span className="c1b-spin" aria-hidden="true" /> : <Icon name="info" size="sm" />}
              <span>{hint}</span>
            </p>
          ) : null}
        </Card>
        <DraftExplainer />
      </aside>
    </main>
  );
}

function exampleFor(item: MenuItemDTO | undefined): boolean {
  return Boolean(item?.badges.includes('demo_modifier_attachment'));
}

/** "Your draft" vs "Table orders" (brief 34: shared tables). */
function DraftExplainer() {
  const { t } = useI18n();
  return (
    <dl className="c1b-explain">
      <div>
        <dt><Icon name="pad" size="sm" />{t('cart.draft.title')}</dt>
        <dd>{t('cart.draft.body')}</dd>
      </div>
      <div>
        <dt><Icon name="track" size="sm" />{t('cart.table.title')}</dt>
        <dd>{t('cart.table.body')}</dd>
        <dd className="c1b-explain__link"><TextLink href="/menu/orders">{t('cart.table.link')}</TextLink></dd>
      </div>
    </dl>
  );
}

function RejectionNotice({ sub }: { sub: SubmitState }) {
  const { t } = useI18n();
  const err = sub.error;
  if (!err) return null;
  const code = err.code;
  let body: ReactNode = t(`error.${code}`);
  let action: ReactNode = null;
  if (code === 'rate_limited') {
    const s = (err.details as { retry_after_seconds?: number } | null)?.retry_after_seconds;
    if (s) body = t('submit.rateLimited', { s });
  }
  if (code === 'idempotency_mismatch') {
    action = <LinkButton href="/menu/orders" variant="outline" iconEnd="chev-r">{t('submit.mismatch.action')}</LinkButton>;
  }
  return (
    <Notice tone="alert" icon="alert" title={t('submit.failed.title')} live="assertive" action={action}>
      {body} {t('submit.failed.kept')}
    </Notice>
  );
}

// ------------------------------------------------------------------ review step
function ReviewStep({ cart, sub, focus }: { cart: ReturnType<typeof useCart>; sub: SubmitState; focus: boolean }) {
  const { t, lang } = useI18n();
  const secondaryTitle = useSecondaryTitle('submit.title');
  const { item } = useCatalog();
  const { openService } = useOverlays();
  const ordering = useOrderingState();
  const liveState = useGuestLiveState();
  const pageRef = useStepFocus<HTMLElement>(focus);
  const statusRef = useRef<HTMLDivElement>(null);
  const [localNote, setLocalNote] = useState<'offline' | 'review' | null>(null);

  // Re-validate on arrival: the review must show today's prices.
  useEffect(() => {
    if (!sub.pending) void cart.requote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Announce the phases that matter (never the whole list).
  const lastPhase = useRef(sub.phase);
  useEffect(() => {
    if (lastPhase.current === sub.phase) return;
    lastPhase.current = sub.phase;
    if (sub.phase === 'checking') announce(t('submit.checking.title'), 'polite');
    else if (sub.phase === 'retry') announce(`${t('submit.retry.title')} ${t('submit.retry.body')}`, 'polite');
    else if (sub.phase === 'sending') announce(t('submit.sending.title'), 'polite');
    if (sub.phase === 'checking' || sub.phase === 'retry') statusRef.current?.focus();
  }, [sub.phase, t]);

  // Refused because something changed: back to the list, where each line can be fixed.
  useEffect(() => {
    if (sub.phase === 'rejected' && sub.error?.code === 'cart_changed') setQuery({ step: null }, { replace: true });
  }, [sub.phase, sub.error]);

  const pending = sub.pending;
  const views = pending ? cart.views.filter((v) => pending.uids.includes(v.line.uid)) : cart.views.filter((v) => !v.frozen);
  const count = views.reduce((n, v) => n + v.line.quantity, 0);
  const subtotal = pending ? pending.payload.expected_subtotal_minor : cart.subtotalMinor;
  const hasNotes = views.some((v) => v.line.note);
  const offline = liveState === 'offline' || cart.quoteStatus === 'offline';
  const busy = sub.phase === 'sending';
  const canPlace = !pending && cart.ready && !ordering.block && !offline && cart.quoteStatus === 'fresh';

  const place = async () => {
    if (!canPlace || busy) return;
    setLocalNote(null);
    const r = await placeOrder(lang);
    if (r === 'offline') {
      setLocalNote('offline');
      announce(t('submit.offline'), 'assertive');
    } else if (r === 'review') {
      setLocalNote('review');
      announce(t('submit.review'), 'assertive');
    }
  };

  const backToEdit = () => {
    if (sub.phase === 'retry') discardAttempt();
    resetOutcome();
    setQuery({ step: null }, { replace: false });
  };


  return (
    <main ref={pageRef} className={cx('g-main c1b-page c1b-page--review', (sub.phase === 'checking' || sub.phase === 'retry') && 'is-pending')}>
      <div className="c1b-page__main">
        <PageHead
          kicker={ordering.tableLabel ? t('submit.kicker', { table: ordering.tableLabel }) : undefined}
          title={t('submit.title')}
          secondary={secondaryTitle}
          secondaryLang="en"
        />

        <Card padded className="c1b-card c1b-review">
          <dl className="c1b-review__facts">
            <div className="c1b-review__table">
              <dt>{t('submit.table')}</dt>
              <dd><span className="numeral">{ordering.tableLabel ?? '—'}</span></dd>
            </div>
            <div>
              <dt>{t('submit.items')}</dt>
              <dd>{t(count === 1 ? 'submit.itemsValueOne' : 'submit.itemsValue', { n: count })}</dd>
            </div>
          </dl>
          <ul className="c1b-lines c1b-lines--review" aria-label={pending ? t('submit.pendingLines') : t('cart.listLabel')}>
            {views.map((v) => (
              <DraftLine key={v.line.uid} view={v} item={item(v.line.item_id)} mode="review" example={exampleFor(item(v.line.item_id))} />
            ))}
          </ul>
          <Totals
            cart={cart}
            subtotal={subtotal}
            count={count}
            showCharges={!pending && cart.ready}
            note={sub.phase === 'checking' ? t('submit.checking.title')
              : sub.phase === 'sending' ? t('submit.sending.title')
                : t('cart.totalNote')}
            className="c1b-review__totals"
          />
        </Card>
      </div>

      <aside className="c1b-page__side c1b-submit" aria-label={t('submit.place')}>
        <Card padded className="c1b-summary">
          {!pending ? <p className="c1b-explainer"><Icon name="info" size="sm" /><span>{t('submit.explain')}</span></p> : null}
          {hasNotes && !pending ? <p className="c1b-explainer"><Icon name="note" size="sm" /><span>{t('submit.notes')}</span></p> : null}

          <div className="c1b-submit__status" ref={statusRef} tabIndex={-1}>
            {!pending ? <QuoteStatusNote cart={cart} /> : null}
            {localNote === 'offline' ? <Notice tone="alert" icon="wifi-off" live="off">{t('submit.offline')}</Notice> : null}
            {localNote === 'review' || (!pending && cart.reviewNeeded) ? (
              <Notice tone="alert" icon="alert" live="off" title={t('submit.review')}>{t('cart.hint.issues')}</Notice>
            ) : null}
            {sub.phase === 'rejected' && sub.error && sub.error.code !== 'cart_changed' && !(BLOCKING_CODES as readonly string[]).includes(sub.error.code) ? (
              <RejectionNotice sub={sub} />
            ) : null}
            {sub.phase === 'rejected' && sub.error && (BLOCKING_CODES as readonly string[]).includes(sub.error.code) && !ordering.block ? (
              <Notice tone="heat" icon="pause" live="assertive" title={t('submit.failed.title')}>
                {t(`error.${sub.error.code}`)} {t('submit.failed.kept')}
              </Notice>
            ) : null}
            {sub.phase === 'sending' ? (
              <Notice tone="info" icon="clock" title={t('submit.sending.title')} live="off">{t('submit.sending.body')}</Notice>
            ) : null}
            {sub.phase === 'checking' ? <CheckingPanel sub={sub} onCall={openService} /> : null}
            {sub.phase === 'retry' ? (
              <Notice tone="heat" icon="info" title={t('submit.retry.title')} live="off">{t('submit.retry.body')}</Notice>
            ) : null}
          </div>

          <div className="c1b-submit__acts">
            {sub.phase === 'retry' ? (
              <>
                <Button variant="primary" size="lg" block icon="arrow-r" onClick={() => void retrySubmission()} data-testid="submit-retry">
                  {t('submit.retry.action')}
                </Button>
                <Button variant="outline" size="lg" block onClick={backToEdit}>{t('submit.retry.edit')}</Button>
              </>
            ) : sub.phase === 'checking' ? null : (
              <>
                {!pending && ordering.block ? (
                  <p className="meta c1b-hint c1b-hint--block" role="status" data-block={ordering.block.code}>
                    <Icon name={ordering.block.code === 'visit_billing' ? 'receipt' : 'pause'} size="sm" />
                    <span><b>{ordering.block.title}</b> · {ordering.block.code === 'visit_billing' ? ordering.block.body : t('cart.block.kept')}</span>
                  </p>
                ) : null}
                {!pending && !cart.ready && !cart.reviewNeeded && !offline && !ordering.block ? (
                  <p className="meta c1b-hint" role="status"><span className="c1b-spin" aria-hidden="true" /><span>{t('cart.check.loading')}</span></p>
                ) : null}
                <Button
                  variant="primary"
                  size="lg"
                  block
                  loading={busy}
                  priceMinor={subtotal}
                  aria-disabled={!canPlace && !busy ? true : undefined}
                  onClick={() => void place()}
                  data-testid="submit-place"
                >
                  {t('submit.place')}
                </Button>
                {!busy ? <Button variant="outline" size="lg" block icon="chev-l" onClick={backToEdit}>{t('submit.back')}</Button> : null}
              </>
            )}
          </div>
        </Card>
      </aside>
    </main>
  );
}

function CheckingPanel({ sub, onCall }: { sub: SubmitState; onCall: () => void }) {
  const { t } = useI18n();
  const denied = sub.error && (sub.error.code === 'visit_access_revoked' || sub.error.code === 'visit_access_required');
  return (
    <div className="c1b-notice c1b-notice--checking" data-testid="submit-checking">
      {denied ? <Icon name="alert" /> : <span className="c1b-spin c1b-spin--lg" aria-hidden="true" />}
      <div className="c1b-notice__body">
        <p className="c1b-notice__t">{t('submit.checking.title')}</p>
        <p>{denied ? t('submit.checking.denied') : t('submit.checking.body')}</p>
        {sub.checkFailed && !denied ? <p className="meta">{t('submit.checking.offline')}</p> : null}
        {sub.lastCheckAt ? <p className="meta">{t('submit.checking.last', { time: clock(new Date(sub.lastCheckAt).toISOString()) })}</p> : null}
        <div className="c1b-notice__act">
          {!denied ? <Button variant="outline" icon="refresh" onClick={checkNow}>{t('submit.checking.now')}</Button> : null}
          <Button variant="ghost" icon="bell" opensDialog onClick={onCall}>{t('cart.block.callStaff')}</Button>
        </div>
        <p className="meta">{t('submit.checking.staff')}</p>
      </div>
    </div>
  );
}

