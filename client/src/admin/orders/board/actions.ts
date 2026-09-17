// Line transitions and Finish order with version checks, stale-conflict
// handling and polite announcements. Nothing is advanced without a tap.
import { useCallback, useRef, useState } from 'react';
import type { OrderLineDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { LineStatus } from '../../../../../shared/status.ts';
import { api } from '../../../lib/api.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import type { Resource } from '../../../lib/live.tsx';
import { useAnnounce, useToast } from '../../../ui/index.ts';
import { errorText, staleCurrent, sumQty, tn, toApiError } from '../support.ts';
import { lastChange, tableOf } from './model.ts';

export interface OrdersResponse { orders: StaffOrderDTO[]; server_time: string }

export type BusyKind = 'primary' | 'secondary' | 'panel';

export interface Resolution { line_id: string; version: number; action: 'served' | 'cancel'; reason?: string | null }

export type ActionOutcome =
  | { ok: true; orders: StaffOrderDTO[] }
  | { ok: false; stale: boolean; message: string; unresolved?: Array<{ id: string; status: LineStatus; quantity: number; version: number }> };

const STEP_WORD: Partial<Record<LineStatus, string>> = {
  accepted: 'orders.done.accepted',
  preparing: 'orders.done.preparing',
  almost_done: 'orders.done.almost_done',
  ready: 'orders.done.ready',
  served: 'orders.done.served',
  rejected: 'orders.done.rejected',
  cancelled: 'orders.done.cancelled',
  submitted: 'orders.done.corrected',
};

export function useBoardActions(res: Resource<OrdersResponse>) {
  const { t, has } = useI18n();
  const toast = useToast();
  const announce = useAnnounce();
  const [conflicts, setConflicts] = useState<Record<string, { by: string; at: string }>>({});
  const [busy, setBusy] = useState<Record<string, BusyKind>>({});
  const inflight = useRef(new Set<string>());

  const merge = useCallback((orders: StaffOrderDTO[]) => {
    if (orders.length === 0) return;
    res.mutate((prev) => {
      if (!prev) return prev as unknown as OrdersResponse;
      const byId = new Map(orders.map((o) => [o.id, o]));
      return { ...prev, orders: prev.orders.map((o) => byId.get(o.id) ?? o) };
    });
  }, [res.mutate]);

  const markStale = useCallback((err: unknown, orderIds: string[]) => {
    const cur = staleCurrent<StaffOrderDTO | StaffOrderDTO[]>(err);
    const list = cur ? (Array.isArray(cur) ? cur : [cur]) : [];
    merge(list);
    const marks: Record<string, { by: string; at: string }> = {};
    for (const id of orderIds) {
      const change = lastChange(list.find((o) => o.id === id) ?? ({ lines: [] } as unknown as StaffOrderDTO));
      marks[id] = { by: change?.by || t('orders.conflict.someone'), at: change?.at ?? new Date().toISOString() };
    }
    setConflicts((c) => ({ ...c, ...marks }));
    toast.show({ message: t('orders.toast.stale'), tone: 'info' });
    void res.refresh();
  }, [merge, res.refresh, t, toast]);

  const review = useCallback((orderId: string) => {
    setConflicts((c) => {
      const next = { ...c };
      delete next[orderId];
      return next;
    });
    void res.refresh();
  }, [res.refresh]);

  const run = useCallback(async (
    order: StaffOrderDTO,
    kind: BusyKind,
    call: () => Promise<StaffOrderDTO[]>,
    words: string,
  ): Promise<ActionOutcome> => {
    if (inflight.current.has(order.id)) return { ok: false, stale: false, message: '' };
    inflight.current.add(order.id);
    setBusy((b) => ({ ...b, [order.id]: kind }));
    try {
      const orders = await call();
      merge(orders);
      announce(words);
      void res.refresh();
      return { ok: true, orders };
    } catch (err) {
      const e = toApiError(err);
      if (e.code === 'stale_version') {
        markStale(err, [order.id]);
        return { ok: false, stale: true, message: t('orders.toast.stale') };
      }
      const message = errorText(t, err);
      if (e.code === 'unresolved_orders') {
        const lines = (e.details as { lines?: Array<{ id: string; status: LineStatus; quantity: number; version: number }> } | null)?.lines ?? [];
        return { ok: false, stale: false, message, unresolved: lines };
      }
      if (e.code === 'invalid_transition' || e.code === 'already_done' || e.code === 'conflict') void res.refresh();
      return { ok: false, stale: false, message };
    } finally {
      inflight.current.delete(order.id);
      setBusy((b) => {
        const next = { ...b };
        delete next[order.id];
        return next;
      });
    }
  }, [announce, markStale, merge, res.refresh, t]);

  /** Move lines to `to`. Board buttons show errors as a toast; the panel shows them inline. */
  const transition = useCallback(async (
    order: StaffOrderDTO, lines: OrderLineDTO[], to: LineStatus,
    opts: { reason?: string; kind?: BusyKind; silent?: boolean } = {},
  ): Promise<ActionOutcome> => {
    if (lines.length === 0) return { ok: false, stale: false, message: '' };
    const n = sumQty(lines);
    const words = tn({ t, has }, STEP_WORD[to] ?? 'orders.done.corrected', n, { table: tableOf(order) });
    const out = await run(order, opts.kind ?? 'primary', async () => {
      const r = await api.post<{ orders: StaffOrderDTO[] }>('/api/staff/orders/transition', {
        lines: lines.map((l) => ({ id: l.id, version: l.version })),
        to,
        reason: opts.reason ?? null,
      });
      return r.orders;
    }, words);
    if (!out.ok && !out.stale && out.message && !opts.silent) toast.show({ message: out.message, tone: 'error' });
    if (out.ok && opts.reason) toast.show({ message: words });
    return out;
  }, [run, t, has, toast]);

  const finish = useCallback(async (order: StaffOrderDTO, resolutions: Resolution[]): Promise<ActionOutcome> => {
    const words = t('orders.done.finished', { ref: order.reference, table: tableOf(order) });
    const out = await run(order, 'panel', async () => {
      const r = await api.post<StaffOrderDTO>(`/api/staff/orders/${order.id}/finish`, { version: order.version, resolutions });
      return [r];
    }, words);
    if (out.ok) toast.show({ message: words });
    return out;
  }, [run, t, toast]);

  return { transition, finish, conflicts, review, busy, merge };
}
