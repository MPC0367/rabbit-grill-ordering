// The guest sheet host (docs/CLIENT.md): one sheet at a time, integrated
// with browser Back (the kit Sheet pushes one history entry per open sheet
// and closes on Back), focus returns to the trigger, page scroll is kept.
//
//   const { openItem, openService, openPortion, close } = useOverlays();
//
// Opening a sheet while another is open replaces it (never stacks). Public
// and ended visitors who try to use a table service or ask for a portion get
// the NoAccessPanel instead. This host also reports dish-detail engagement
// (useDetailTracking) so the sheets themselves must not.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import { useDetailTracking } from '../../lib/tracker.ts';
import { Button, EmptyState, Sheet, useToast } from '../../ui/index.ts';
import ItemSheet from '../cart/ItemSheet.tsx';
import ServiceSheet from '../visit/ServiceSheet.tsx';
import PortionRequestSheet from '../visit/PortionRequestSheet.tsx';
import NoAccessPanel from '../visit/NoAccessPanel.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useCatalog } from './catalog.tsx';
import { useGuestSession } from './session.tsx';

export type NoAccessReason = 'public' | 'revoked' | 'required';

export interface OverlaysApi {
  openItem: (itemId: string, opts?: { lineUid?: string; source?: number }) => void;
  openService: () => void;
  openPortion: (itemId: string) => void;
  close: () => void;
  /** Internal (shell and menu): explain why this browser cannot order. */
  openNoAccess: (reason?: NoAccessReason) => void;
  /** What is open now (null = nothing). */
  current: OverlayKind | null;
}

export type OverlayKind = 'item' | 'service' | 'portion' | 'noAccess';

type OverlayState =
  | { kind: 'item'; key: number; itemId: string; lineUid?: string; source?: number }
  | { kind: 'service'; key: number }
  | { kind: 'portion'; key: number; itemId: string }
  | { kind: 'noAccess'; key: number; reason: NoAccessReason };

const OverlayContext = createContext<OverlaysApi>({
  openItem: () => {},
  openService: () => {},
  openPortion: () => {},
  close: () => {},
  openNoAccess: () => {},
  current: null,
});

let overlaySeq = 0;

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OverlayState | null>(null);
  const { mode, endedReason, error } = useGuestSession();
  const toast = useToast();
  const { item } = useCatalog();
  const { t } = useI18n();
  const { path } = useRoute();
  const modeRef = useRef({ mode, endedReason, error });
  modeRef.current = { mode, endedReason, error };

  const noAccessReason = useCallback((): NoAccessReason => {
    const m = modeRef.current;
    if (m.mode === 'ended') return m.endedReason === 'visit_access_revoked' ? 'revoked' : 'required';
    return 'public';
  }, []);

  const close = useCallback(() => setState(null), []);

  const openNoAccess = useCallback((reason?: NoAccessReason) => {
    setState({ kind: 'noAccess', key: ++overlaySeq, reason: reason ?? noAccessReason() });
  }, [noAccessReason]);

  const openItem = useCallback((itemId: string, opts: { lineUid?: string; source?: number } = {}) => {
    setState({ kind: 'item', key: ++overlaySeq, itemId, lineUid: opts.lineUid, source: opts.source });
  }, []);

  // A tap while the session is still loading is kept and answered once it is known.
  const stillConnecting = useCallback(() => {
    const e = modeRef.current.error;
    if (e) toast.show({ tone: 'error', message: t(`error.${e.code}`) });
  }, [toast, t]);
  const waiting = useRef<{ kind: 'service' } | { kind: 'portion'; itemId: string } | null>(null);

  const openService = useCallback(() => {
    const m = modeRef.current.mode;
    if (m === 'loading') { waiting.current = { kind: 'service' }; stillConnecting(); return; }
    if (m !== 'joined') { openNoAccess(); return; }
    setState({ kind: 'service', key: ++overlaySeq });
  }, [openNoAccess, stillConnecting]);

  const openPortion = useCallback((itemId: string) => {
    const m = modeRef.current.mode;
    if (m === 'loading') { waiting.current = { kind: 'portion', itemId }; stillConnecting(); return; }
    if (m !== 'joined') { openNoAccess(); return; }
    setState({ kind: 'portion', key: ++overlaySeq, itemId });
  }, [openNoAccess, stillConnecting]);

  useEffect(() => {
    if (mode === 'loading' || !waiting.current) return;
    const w = waiting.current;
    waiting.current = null;
    if (w.kind === 'service') openService();
    else openPortion(w.itemId);
  }, [mode, openService, openPortion]);

  // A route change (link inside a sheet, browser navigation) closes the sheet.
  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    setState(null);
  }, [path]);

  // Access ended while a service or portion sheet was open: swap in the explanation.
  useEffect(() => {
    if (mode === 'joined' || mode === 'loading') return;
    setState((s) => (s && (s.kind === 'service' || s.kind === 'portion') ? { kind: 'noAccess', key: ++overlaySeq, reason: noAccessReason() } : s));
  }, [mode, noAccessReason]);

  // Dish engagement: an opening from the menu counts; editing a draft line does not.
  const tracked = state?.kind === 'item' && !state.lineUid ? state : null;
  useDetailTracking(tracked ? tracked.itemId : null, {
    source: tracked?.source ?? null,
    categoryId: tracked ? item(tracked.itemId)?.category_id ?? null : null,
  });

  const api = useMemo<OverlaysApi>(() => ({
    openItem, openService, openPortion, close, openNoAccess, current: state?.kind ?? null,
  }), [openItem, openService, openPortion, close, openNoAccess, state?.kind]);

  let sheet: ReactNode = null;
  if (state?.kind === 'item') {
    sheet = <ItemSheet key={state.key} itemId={state.itemId} lineUid={state.lineUid} onClose={close} />;
  } else if (state?.kind === 'service') {
    sheet = <ServiceSheet key={state.key} onClose={close} />;
  } else if (state?.kind === 'portion') {
    sheet = <PortionRequestSheet key={state.key} itemId={state.itemId} onClose={close} />;
  } else if (state?.kind === 'noAccess') {
    sheet = (
      <Sheet key={state.key} open onClose={close} title={t('shell.noAccess.title')}>
        <NoAccessPanel reason={state.reason} compact />
      </Sheet>
    );
  }

  return (
    <OverlayContext.Provider value={api}>
      {children}
      {sheet ? (
        <ErrorBoundary
          resetKey={state?.key}
          fallback={() => (
            <Sheet open onClose={close} label={t('shell.sheetError.title')}>
              <EmptyState
                icon="alert"
                title={t('shell.sheetError.title')}
                action={<Button variant="outline" onClick={close}>{t('common.close')}</Button>}
              >
                {t('shell.sheetError.body')}
              </EmptyState>
            </Sheet>
          )}
        >
          {sheet}
        </ErrorBoundary>
      ) : null}
    </OverlayContext.Provider>
  );
}

export function useOverlays(): OverlaysApi {
  return useContext(OverlayContext);
}
