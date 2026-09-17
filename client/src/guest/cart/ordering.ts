// Can this device send a round right now? One answer for the item sheet, the
// order page, the review step and the desktop panel (brief 25, 30).
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { useGuestSession, type GuestMode } from '../shell/session.tsx';
import { BLOCKING_CODES } from './submit.ts';

export type BlockCode = 'visit_billing' | 'ordering_paused' | 'table_paused' | 'outside_hours' | 'intake_full' | 'table_disabled';

export interface OrderingBlock {
  code: BlockCode;
  title: string;
  body: string;
}

export interface OrderingState {
  mode: GuestMode;
  tableLabel: string | null;
  /** null = the kitchen takes rounds from this device right now. */
  block: OrderingBlock | null;
}

export function isBlock(code: string | null | undefined): code is BlockCode {
  return Boolean(code && (BLOCKING_CODES as readonly string[]).includes(code));
}

export function useBlockCopy(): (code: BlockCode) => OrderingBlock {
  const { t, pick } = useI18n();
  const { config } = useConfig();
  return (code) => {
    if (code === 'ordering_paused') {
      const msg = pick(config?.ordering.paused_message);
      return { code, title: t('cart.block.ordering_paused.title'), body: msg.text || t('error.ordering_paused') };
    }
    return { code, title: t(`cart.block.${code}.title`), body: t(`cart.block.${code}`) };
  };
}

/** From the guest session (refreshed on visit, table and ordering events) and the public config. */
export function useOrderingState(): OrderingState {
  const { mode, session } = useGuestSession();
  const { config } = useConfig();
  const copy = useBlockCopy();
  let code: BlockCode | null = null;
  if (mode === 'joined' && session) {
    if (session.visit.status === 'billing') code = 'visit_billing';
    else if (!session.ordering.allowed && isBlock(session.ordering.reason)) code = session.ordering.reason;
    else if (config && !config.ordering.enabled) code = 'ordering_paused';
    else if (config?.ordering.within_hours === false) code = 'outside_hours';
  }
  return {
    mode,
    tableLabel: session?.visit.table_label ?? null,
    block: code ? copy(code) : null,
  };
}
