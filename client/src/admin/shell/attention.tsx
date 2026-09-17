// One live copy of GET /api/staff/overview for the whole shell: the Orders
// badge, the ordering state in the header and banner, and the Overview page
// all read the same numbers, so they always agree.
import { createContext, useContext, type ReactNode } from 'react';
import type { OverviewDTO } from '../../../../shared/dto.ts';
import type { Resource } from '../../lib/live.tsx';
import { useLiveResource } from './live-resource.ts';

/** Every topic that can change a number on the overview. */
export const OVERVIEW_TOPICS = ['order.', 'line.', 'service.', 'portion.', 'visit.', 'table.', 'ordering.', 'bill.'];

const AttentionContext = createContext<Resource<OverviewDTO> | null>(null);

export function AttentionProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  // The 30 s interval also notices a session the server ended, or a server that
  // stopped answering, while the stream was quiet (the shell's outage banner).
  const overview = useLiveResource<OverviewDTO>(enabled ? '/api/staff/overview' : null, {
    topics: OVERVIEW_TOPICS,
    debounceMs: 250,
    intervalMs: 30_000,
  });
  return <AttentionContext.Provider value={overview}>{children}</AttentionContext.Provider>;
}

export function useAttention(): Resource<OverviewDTO> {
  const ctx = useContext(AttentionContext);
  if (!ctx) throw new Error('useAttention outside AttentionProvider');
  return ctx;
}

/**
 * Cuts waiting for the scale. The server's `portions_to_weigh` counts the
 * requested ones only (a quoted cut waits on the guest); without it, every
 * open portion request is counted, which is what the Requests tab lists.
 */
export function portionsToWeigh(d: OverviewDTO | undefined): number {
  if (!d) return 0;
  const exact = (d as OverviewDTO & { portions_to_weigh?: number }).portions_to_weigh;
  return typeof exact === 'number' ? exact : d.open_portion_requests;
}

/**
 * Food at the pass counted in dishes, like the ticket buttons ("Mark served ·
 * 3"). Older servers only count order lines, which is the same number until a
 * line has a quantity above one.
 */
export function readyDishes(d: OverviewDTO | undefined): number {
  if (!d) return 0;
  return typeof d.ready_dishes === 'number' ? d.ready_dishes : d.ready_lines;
}

/** True while the count above means "waiting to be weighed" rather than "to weigh or confirm". */
export function weighCountIsExact(d: OverviewDTO | undefined): boolean {
  return typeof (d as (OverviewDTO & { portions_to_weigh?: number }) | undefined)?.portions_to_weigh === 'number';
}
