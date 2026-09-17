// Engagement tracker - one accumulating tab per browser.
//
// Several tabs of the same browser may show the menu. Only the tab the guest
// most recently interacted with (and which is visible) may count active time;
// the others stay passive, so one person reading one screen is never counted
// twice. Coordination:
//   - a tab CLAIMS leadership on a direct interaction: it writes a short lease
//     to localStorage and announces the claim on BroadcastChannel('rg-analytics');
//   - a tab that hears a newer claim (message, storage event, or the lease it
//     reads on its 1 s tick) yields at once and closes its current chunk;
//   - leadership is never taken over silently: a passive tab needs its own
//     interaction, so a page that is merely open never becomes "attention".
// Distinct devices never coordinate and remain distinct sessions.
import type { Channel, TrackerEnv, Unlisten } from './tracker-env.ts';
import { KEYS } from './tracker-session.ts';

const LEASE_MS = 5_000;

interface Lease {
  tab: string;
  /** Wall time of the claim (ordering between tabs of one machine). */
  at: number;
  until: number;
}

export type ChannelMessage =
  | { t: 'claim'; tab: string; at: number }
  | { t: 'release'; tab: string }
  | { t: 'optout' }
  | { t: 'optin' }
  | { t: 'ended'; visit: string | null };

export interface Leader {
  readonly tabId: string;
  isLeader(): boolean;
  /** After a direct interaction. Cheap when this tab already holds a fresh lease. */
  claim(): void;
  /** Keep the lease alive while this tab is accumulating. */
  renew(): void;
  /** Page hidden or leaving. */
  release(): void;
  /** Re-read the lease (tick, storage event). */
  check(): void;
  post(msg: ChannelMessage): void;
  dispose(): void;
}

function isLease(x: unknown): x is Lease {
  const l = x as Lease | null;
  return !!l && typeof l.tab === 'string' && typeof l.at === 'number' && typeof l.until === 'number';
}

export function createLeader(
  env: TrackerEnv,
  handlers: { onYield(): void; onMessage(msg: ChannelMessage): void },
): Leader {
  const tabId = env.newId('tab');
  let leaderTab: string | null = null;
  let myClaimAt = -Infinity;
  let myLeaseUntil = -Infinity;

  const readLease = (): Lease | null => {
    const l = env.storage.get<unknown>(KEYS.lease, null);
    return isLease(l) ? l : null;
  };

  function yieldTo(tab: string | null) {
    const was = leaderTab === tabId;
    leaderTab = tab;
    if (was && tab !== tabId) handlers.onYield();
  }

  function newerThanMine(at: number, tab: string): boolean {
    return at > myClaimAt || (at === myClaimAt && tab > tabId);
  }

  function check() {
    const lease = readLease();
    if (!lease || lease.tab === tabId || lease.until < env.wallNow()) return;
    if (leaderTab === tabId && !newerThanMine(lease.at, lease.tab)) return;
    yieldTo(lease.tab);
  }

  const channel: Channel | null = env.openChannel('rg-analytics', (data) => {
    const msg = data as ChannelMessage | null;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'claim') {
      if (msg.tab !== tabId && newerThanMine(msg.at, msg.tab)) yieldTo(msg.tab);
    } else if (msg.t === 'release') {
      if (leaderTab === msg.tab) leaderTab = null;
    } else {
      handlers.onMessage(msg);
    }
  });

  // Fallback for browsers without BroadcastChannel (and missed messages).
  const offStorage: Unlisten = env.onStorageChange((key) => {
    if (key === KEYS.lease || key === null) check();
  });

  function writeLease(wall: number) {
    myLeaseUntil = wall + LEASE_MS;
    env.storage.set(KEYS.lease, { tab: tabId, at: myClaimAt, until: myLeaseUntil } satisfies Lease);
  }

  return {
    tabId,
    isLeader: () => leaderTab === tabId,

    claim() {
      const wall = env.wallNow();
      if (leaderTab === tabId && myLeaseUntil - wall > LEASE_MS / 2) return;
      if (leaderTab !== tabId) {
        myClaimAt = Math.max(wall, myClaimAt + 1);
        leaderTab = tabId;
        writeLease(wall);
        channel?.post({ t: 'claim', tab: tabId, at: myClaimAt } satisfies ChannelMessage);
      } else {
        writeLease(wall);
      }
    },

    renew() {
      if (leaderTab !== tabId) return;
      const wall = env.wallNow();
      if (myLeaseUntil - wall > LEASE_MS / 2) return;
      const lease = readLease();
      if (lease && lease.tab !== tabId && lease.until >= wall && newerThanMine(lease.at, lease.tab)) {
        yieldTo(lease.tab);
        return;
      }
      writeLease(wall);
    },

    release() {
      if (leaderTab !== tabId) return;
      leaderTab = null;
      myLeaseUntil = -Infinity;
      const lease = readLease();
      if (lease && lease.tab === tabId) env.storage.remove(KEYS.lease);
      channel?.post({ t: 'release', tab: tabId } satisfies ChannelMessage);
      handlers.onYield();
    },

    check,
    post: (msg) => channel?.post(msg),

    dispose() {
      offStorage();
      channel?.close();
      if (leaderTab === tabId) {
        const lease = readLease();
        if (lease && lease.tab === tabId) env.storage.remove(KEYS.lease);
      }
      leaderTab = null;
    },
  };
}
