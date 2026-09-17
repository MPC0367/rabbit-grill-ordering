// ConnectionIndicator (DESIGN §10.27). Reads useLive(); the shape changes
// with the state (dot · dash · diamond), not only the colour.
//  staff: pill in the workspace header
//  guest: nothing while live, a heat chip while reconnecting, the offline Banner when offline
//  track: the Track page pill ("ข้อมูลสด · อัปเดตล่าสุด 19:52" / "ข้อมูลเมื่อ 19:52 · ยังไม่อัปเดต")
import type { ReactNode } from 'react';
import { clock } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useLive, type LiveState } from '../lib/live.tsx';
import { clockSeconds, cx } from './cx.ts';
import { Banner } from './Banner.tsx';
import { Pill } from './Badge.tsx';

export interface ConnectionIndicatorProps {
  variant?: 'staff' | 'guest' | 'track';
  /** Override the live state (previews, tests). */
  state?: LiveState;
  /** Override the last successful sync (ms epoch). */
  lastSyncAt?: number | null;
  /** Connected but the shown data failed to refresh (useResource().stale): show it as stale. */
  stale?: boolean;
  /** Guest offline banner action (e.g. a "เรียกพนักงาน" button). */
  offlineAction?: ReactNode;
  className?: string;
}

export function ConnectionIndicator({ variant = 'staff', state, lastSyncAt, stale, offlineAction, className }: ConnectionIndicatorProps) {
  const { t } = useI18n();
  const live = useLive();
  const s = state ?? live.state;
  const lastRaw = lastSyncAt !== undefined ? lastSyncAt : Math.max(live.lastSyncAt ?? 0, live.lastEventAt ?? 0) || null;
  const last = lastRaw ? new Date(lastRaw).toISOString() : null;

  if (variant === 'staff') {
    const staleLive = s === 'live' && stale;
    const tone = s === 'live' && !stale ? '' : s === 'offline' || s === 'ended' ? 'conn--offline' : 'conn--stale';
    const word = staleLive ? t('conn.stale') : t(`conn.${s}`);
    const detail = s === 'live' && !stale
      ? (last ? t('conn.synced', { time: clockSeconds(last) }) : null)
      : s === 'ended' ? null
        : last ? t('conn.lastSync', { time: clock(last) }) : t('conn.neverSynced');
    // Only the state word is a live region: the synced time changes with every
    // restaurant-wide event and must not be re-announced on each one.
    return (
      <span className={cx('conn', tone, className)} data-state={s}>
        <span className="conn__state" role="status">{word}</span>
        {detail ? <span className="conn__detail">{detail}</span> : null}
      </span>
    );
  }

  if (variant === 'track') {
    const fresh = s === 'live' && !stale;
    // One persistent status element whose words change only with the state;
    // the minute of the last update is plain text beside it.
    return (
      <Pill tone={fresh ? 'ok' : 'heat'} live={fresh} icon={fresh ? undefined : 'clock'} className={className} data-state={s}>
        <span role="status">{fresh ? t('conn.liveGuest') : last ? t('conn.dataAt', { time: clock(last) }) : t('conn.stale')}</span>
        {fresh && last ? <span className="pill__soft"> · {t('conn.lastSync', { time: clock(last) })}</span> : null}
      </Pill>
    );
  }

  // guest
  if (s === 'reconnecting' || s === 'connecting') {
    if (s === 'connecting' && !last) return null; // first connection: stay quiet
    return (
      <div className={cx('connchip', className)} role="status" data-state={s}>
        <Pill tone="heat" icon="refresh" size="sm">{t('conn.reconnecting')}</Pill>
      </div>
    );
  }
  if (s === 'offline') {
    return (
      <Banner variant="offline" title={t('conn.lost')} action={offlineAction} className={className} data-state={s}>
        {t('conn.lostBody')}
      </Banner>
    );
  }
  return null;
}
