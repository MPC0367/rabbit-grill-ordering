// Audit trail. Call inside the same transaction as the change.
import { insert } from '../db/index.ts';
import { nowIso } from '../../shared/time.ts';

export interface Actor {
  type: 'staff' | 'guest' | 'system';
  id: string | null;
  label: string | null;
}

export const SYSTEM: Actor = { type: 'system', id: null, label: 'system' };

export function audit(actor: Actor, action: string, entity: { type: string; id?: string | null; visit_id?: string | null }, extra: { reason?: string | null; before?: unknown; after?: unknown } = {}): void {
  insert('audit_events', {
    actor_type: actor.type,
    actor_id: actor.id,
    actor_label: actor.label,
    action,
    entity_type: entity.type,
    entity_id: entity.id ?? null,
    visit_id: entity.visit_id ?? null,
    reason: extra.reason ?? null,
    before_json: extra.before === undefined ? null : JSON.stringify(extra.before),
    after_json: extra.after === undefined ? null : JSON.stringify(extra.after),
    created_at: nowIso(),
  });
}
