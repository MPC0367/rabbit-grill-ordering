// Permanent table QR tokens (brief 07, 20).
//
// Each physical table has exactly one ACTIVE opaque token (32 random bytes,
// base64url) printed on its card as `<PUBLIC_BASE_URL>/q/<token>`. The token
// identifies the table only: joining the current visit still needs the visit
// PIN, and the token never reveals orders, bills or the PIN.
//
// Rotating revokes the old token (kept for audit, answered with qr_disabled)
// and issues a new one, which means every card printed before is dead.
// Token values are secrets: they are never audited, emitted or logged.
import QRCode from 'qrcode';
import { config } from '../config.ts';
import { insert, many, one, run, tx } from '../db/index.ts';
import { audit, type Actor } from '../lib/audit.ts';
import { newId, newSecret } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';

export interface QrTokenRow {
  id: string;
  table_id: string;
  token: string;
  active: number;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  reason: string | null;
  card_downloaded_at: string | null;
}

/** Shape of a token we issue (newSecret(32) = 43 base64url chars); older/imported tokens may differ in length. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

/** The URL printed in a table's QR code. */
export function qrUrl(token: string): string {
  return `${config.publicBaseUrl}/q/${encodeURIComponent(token)}`;
}

export function findToken(token: string): QrTokenRow | undefined {
  return one<QrTokenRow>('SELECT * FROM table_qr_tokens WHERE token = ?', [token]);
}

export function activeToken(tableId: string): QrTokenRow | undefined {
  return one<QrTokenRow>('SELECT * FROM table_qr_tokens WHERE table_id = ? AND active = 1', [tableId]);
}

/** Issue a fresh active token. The caller must have revoked any previous one. */
function issueToken(tableId: string, actor: Actor, auditIt = true): QrTokenRow {
  const row = {
    id: newId('qrt'),
    table_id: tableId,
    token: newSecret(32),
    active: 1,
    created_at: nowIso(),
    created_by: actor.id,
  };
  insert('table_qr_tokens', row);
  if (auditIt) audit(actor, 'table.qr_issued', { type: 'table', id: tableId }, { after: { token_id: row.id } });
  return activeToken(tableId)!;
}

/** The table's active token, creating one if the table has none yet (seeded or legacy rows). */
export function ensureActiveToken(tableId: string, actor: Actor): QrTokenRow {
  return activeToken(tableId) ?? tx(() => activeToken(tableId) ?? issueToken(tableId, actor));
}

/** Give every live table without an active token one. Returns how many were created. */
export function ensureAllTokens(actor: Actor): number {
  const missing = many<{ id: string }>(
    `SELECT t.id FROM dining_tables t
      WHERE t.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM table_qr_tokens q WHERE q.table_id = t.id AND q.active = 1)`,
  );
  if (missing.length === 0) return 0;
  tx(() => {
    for (const m of missing) if (!activeToken(m.id)) issueToken(m.id, actor);
  });
  return missing.length;
}

/**
 * Revoke the table's active token and issue a new one. Printed cards carrying
 * the old token stop working immediately (they resolve to qr_disabled).
 * Guests already joined to the current visit keep their access: the cookie
 * belongs to the visit, not to the card they scanned.
 */
export function rotateToken(tableId: string, reason: string, actor: Actor): { previousId: string | null; current: QrTokenRow } {
  const previous = activeToken(tableId);
  const now = nowIso();
  if (previous) {
    run(
      `UPDATE table_qr_tokens SET active = 0, revoked_at = :now, revoked_by = :by, reason = :reason
        WHERE id = :id AND active = 1`,
      { id: previous.id, now, by: actor.id, reason },
    );
  }
  const current = issueToken(tableId, actor, false);
  audit(actor, 'table.qr_rotated', { type: 'table', id: tableId }, {
    reason,
    before: previous ? { token_id: previous.id } : null,
    after: { token_id: current.id, printed_cards_invalid: true },
  });
  return { previousId: previous?.id ?? null, current };
}

/** Record that staff fetched the current card (clears "reprint required"). */
export function markCardDownloaded(tokenId: string): void {
  run('UPDATE table_qr_tokens SET card_downloaded_at = :now WHERE id = :id AND card_downloaded_at IS NULL', { id: tokenId, now: nowIso() });
}

/**
 * SVG QR for a URL: error correction M, 4-module quiet zone (the ISO minimum),
 * black on white for the highest scan contrast. Not called inside tx().
 */
export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000ff', light: '#ffffffff' } });
}
