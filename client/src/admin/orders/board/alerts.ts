// New-round emphasis and announcements. Rounds present at the first load, or
// caught up after a reconnect, never animate or chime; a round that arrives
// live gets the one-time outline animation and one polite announcement.
import { useEffect, useRef, useState } from 'react';
import type { StaffOrderDTO } from '../../../../../shared/dto.ts';
import { isActive } from '../../../../../shared/status.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import type { LiveState } from '../../../lib/live.tsx';
import { useAnnounce } from '../../../ui/index.ts';
import { tn } from '../support.ts';
import { tableOf } from './model.ts';

const FRESH_MS = 900;
/** After a reconnect, refetched rounds are catch-up, not news. */
const CATCH_UP_MS = 4000;

export function useNewRoundAlerts(orders: StaffOrderDTO[], fetchedAt: number | null, liveState: LiveState, onNew?: (count: number) => void): ReadonlySet<string> {
  const { t, has } = useI18n();
  const announce = useAnnounce();
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const lastLiveAt = useRef<number>(0);
  const prevState = useRef<LiveState>(liveState);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    if (liveState === 'live' && prevState.current !== 'live') lastLiveAt.current = Date.now();
    prevState.current = liveState;
  }, [liveState]);

  useEffect(() => {
    if (fetchedAt === null) return;
    const ids = orders.map((o) => o.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const arrived = orders.filter((o) => !seen.current!.has(o.id));
    for (const id of ids) seen.current.add(id);
    const incoming = arrived.filter((o) => o.lines.some((l) => l.status === 'submitted' && isActive(l.status)));
    if (incoming.length === 0) return;
    const catchingUp = Date.now() - lastLiveAt.current < CATCH_UP_MS || incoming.length > 3;
    if (catchingUp) {
      announce(tn({ t, has }, 'orders.alert.caughtUp', incoming.length));
      return;
    }
    announce(incoming.length === 1
      ? t('orders.alert.newOne', { table: tableOf(incoming[0]), n: incoming[0].round_no })
      : t('orders.alert.newMany', { n: incoming.length }));
    onNewRef.current?.(incoming.length);
    setFresh((f) => new Set([...f, ...incoming.map((o) => o.id)]));
    timers.current.push(setTimeout(() => {
      setFresh((f) => {
        const next = new Set(f);
        for (const o of incoming) next.delete(o.id);
        return next;
      });
    }, FRESH_MS));
  }, [orders, fetchedAt, announce, t, has]);

  useEffect(() => () => { for (const x of timers.current) clearTimeout(x); }, []);

  return fresh;
}
