// Audit log browsing (audit.view): filters plus keyset pagination by id
// (newest first; pass the returned `next_before` to get the next page).
//
// Audit rows are written by every stream. As a second line of defence the
// viewer masks any before/after field whose name suggests a secret or private
// free text, even if a writer stored one by mistake.
import { z } from 'zod';
import type { AuditEntryDTO } from '../../shared/dto.ts';
import { businessRangeUtc } from '../../shared/time.ts';
import { many } from '../db/index.ts';
import { cutoffHour } from '../lib/settings.ts';

const dateOrInstant = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().datetime({ offset: true })]);
const token = z.string().trim().min(1).max(80);

export const AuditQuery = z.object({
  entity_type: token.optional(),
  entity_id: token.optional(),
  visit_id: token.optional(),
  /** A staff user id, or an actor type: staff | guest | system. */
  actor: token.optional(),
  /** Action prefix, e.g. "report." or "team.role_change". */
  action: token.optional(),
  /** Business date (YYYY-MM-DD, inclusive) or an ISO instant. */
  from: dateOrInstant.optional(),
  to: dateOrInstant.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

const SENSITIVE_KEY = /^(join_pin|pin|new_pin|old_pin|token|token_hash|qr_token|session_token|access_token|password|password_hash|current_password|new_password|secret|api_key|note|notes|guest_note|comment|payment_reference)$/i;

function redact(value: unknown, paymentEntity: boolean, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, paymentEntity, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sensitive = SENSITIVE_KEY.test(k) || (paymentEntity && k === 'reference');
    out[k] = sensitive && v !== null && v !== undefined && typeof v !== 'boolean' ? '[hidden]' : redact(v, paymentEntity, depth + 1);
  }
  return out;
}

function parseJson(text: string | null, entityType: string): unknown {
  if (text === null) return null;
  try { return redact(JSON.parse(text), entityType === 'payment'); } catch { return null; }
}

interface AuditRow {
  id: number; actor_type: 'staff' | 'guest' | 'system'; actor_id: string | null; actor_label: string | null;
  action: string; entity_type: string; entity_id: string | null; visit_id: string | null; reason: string | null;
  before_json: string | null; after_json: string | null; created_at: string;
}

export function listAudit(q: AuditQuery): { entries: AuditEntryDTO[]; next_before: number | null } {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: q.limit };
  if (q.entity_type) { where.push('entity_type = :entity_type'); params.entity_type = q.entity_type; }
  if (q.entity_id) { where.push('entity_id = :entity_id'); params.entity_id = q.entity_id; }
  if (q.visit_id) { where.push('visit_id = :visit_id'); params.visit_id = q.visit_id; }
  if (q.actor) {
    if (q.actor === 'staff' || q.actor === 'guest' || q.actor === 'system') where.push('actor_type = :actor');
    else where.push('actor_id = :actor');
    params.actor = q.actor;
  }
  if (q.action) {
    where.push(`action LIKE :action ESCAPE '\\'`);
    params.action = `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  if (q.from) {
    where.push('created_at >= :from');
    params.from = q.from.length === 10 ? businessRangeUtc(q.from, q.from, cutoffHour()).start : new Date(q.from).toISOString();
  }
  if (q.to) {
    // A date is inclusive (up to the end of that business day); an instant is an exclusive bound.
    where.push('created_at < :to');
    params.to = q.to.length === 10 ? businessRangeUtc(q.to, q.to, cutoffHour()).end : new Date(q.to).toISOString();
  }
  if (q.before) { where.push('id < :before'); params.before = q.before; }
  const rows = many<AuditRow>(
    `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT :limit`, params);
  return {
    entries: rows.map((r) => ({
      id: r.id,
      at: r.created_at,
      actor_type: r.actor_type,
      actor_label: r.actor_label,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      visit_id: r.visit_id,
      reason: r.reason,
      before: parseJson(r.before_json, r.entity_type),
      after: parseJson(r.after_json, r.entity_type),
    })),
    next_before: rows.length === q.limit ? rows[rows.length - 1].id : null,
  };
}
