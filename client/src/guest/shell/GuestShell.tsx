// The guest frame (DESIGN §8.1, brief 07, 08, 33): sticky masthead with the
// table tag, wordmark and language box (desktop: destinations + labelled
// service button), the reconnecting chip, banners, the page, and the dock
// (order slip on the menu + three destinations + the labelled service key).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { storage } from '../../lib/store.ts';
import {
  BottomNav, CartBar, ConnectionIndicator, Dock, GuestHeader, GuestNav, ServiceKey, useGuestNavItems, useToast,
  type CartBarState,
} from '../../ui/index.ts';
import { useCart, useCartCount } from '../cart/store.ts';
import { GuestBanners } from './Banners.tsx';
import { useGuestConnection, type GuestRouteKey } from './hooks.ts';
import { useOverlays } from './overlays.tsx';
import { useGuestSession } from './session.tsx';
import './shell.css';

const NAV_KEY: Partial<Record<GuestRouteKey, string>> = { menu: 'menu', cart: 'order', track: 'track' };
const WELCOMED = 'rg.welcomed.';

export function GuestShell({ route, children }: { route: GuestRouteKey; children: ReactNode }) {
  const { t } = useI18n();
  const { mode, session } = useGuestSession();
  const { openService } = useOverlays();
  const draftCount = useCartCount();
  const navItems = useGuestNavItems({ draftCount });
  const toast = useToast();
  const joined = mode === 'joined' && session !== null;
  const tableLabel = joined ? session.visit.table_label : null;
  const current = NAV_KEY[route] ?? null;
  const showDock = route !== 'join';

  // "ยินดีต้อนรับสู่ Rabbit Grill · โต๊ะ 07" once per visit on this device.
  const visitId = joined ? session.visit.id : null;
  useEffect(() => {
    if (!visitId || !tableLabel || route === 'join') return;
    const key = `${WELCOMED}${visitId}`;
    if (storage.get<boolean>(key, false)) return;
    for (const old of storage.keys(WELCOMED)) storage.remove(old);
    storage.set(key, true);
    toast.show({ message: t('shell.welcome', { table: tableLabel }), tone: 'ok' });
    // t and toast are stable enough; the welcome is keyed by the visit only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId, tableLabel, route === 'join']);

  // The wrapper becomes the main landmark only when the page did not render its own <main>.
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = page.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    const sync = () => {
      const hasMain = Boolean(el.querySelector('main, [role="main"]:not(#main)'));
      if (hasMain) el.removeAttribute('role');
      else el.setAttribute('role', 'main');
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [route]);

  // Access ended: an offer to undo a draft change no longer applies.
  const ended = mode === 'ended';
  useEffect(() => { if (ended) toast.dismiss(); }, [ended, toast]);

  return (
    <div className="g-app">
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          const target = page.current?.querySelector<HTMLElement>('h1') ?? page.current;
          if (target) {
            if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
            target.focus();
          }
        }}
      >
        {t('common.skipToContent')}
      </a>
      <GuestHeader
        tableLabel={tableLabel}
        nav={<GuestNav items={navItems} current={current} />}
        actions={showDock ? <ServiceKey variant="header" className="g-desk-only" onClick={openService} /> : null}
      />
      <GuestBanners route={route} />
      {route === 'menu' ? null : <ReconnectSlot where="page" />}
      <div id="main" ref={page} tabIndex={-1} className="gshell-page" data-route={route}>
        {children}
      </div>
      {showDock ? (
        <Dock>
          {route === 'menu' && joined ? <MenuSlip /> : null}
          <BottomNav items={navItems} current={current} onService={openService} />
        </Dock>
      ) : null}
    </div>
  );
}

/**
 * "กำลังเชื่อมต่อใหม่…": a zero-height sticky slot, so the chip never pushes
 * content. The menu places its own slot right under the category row.
 */
export function ReconnectSlot({ where }: { where: 'page' | 'menu' }) {
  const { mode, session } = useGuestSession();
  const { reconnecting } = useGuestConnection(mode === 'joined' && session !== null);
  if (!reconnecting) return null;
  return (
    <div className="gshell-conn" data-where={where}>
      <ConnectionIndicator variant="guest" state="reconnecting" />
    </div>
  );
}

/** The order slip: forest, "ยังไม่ได้ส่งเข้าครัว", only while the draft has lines. */
function MenuSlip() {
  const cart = useCart();
  if (cart.count <= 0) return null;
  const state: CartBarState = cart.issues.length > 0 ? 'review' : 'idle';
  return <CartBar count={cart.count} totalMinor={cart.subtotalMinor} href="/menu/cart" state={state} />;
}
