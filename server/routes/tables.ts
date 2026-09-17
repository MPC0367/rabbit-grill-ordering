// Tables, QR cards, visits and guest access (S2).
//
//   /api/public  POST /qr/resolve, POST /qr/join
//   /api/guest   GET /session, POST /leave
//   /api/staff   GET /overview, /tables..., /visits...
//
// No `.use()` middleware here: these modules share their mount points with
// other streams, so every guard is attached to its own route.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { tx } from '../db/index.ts';
import { clearGuestCookie, guestOf, issueGuestCookie, requireGuest, requireStaff, resolveGuest, staffOf, type GuestContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { body, clientIp } from '../lib/http.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import {
  CreateTableBody, IdSchema, OpenVisitBody, RotateQrBody, TransferVisitBody, UpdateTableBody, UpdateVisitBody,
  VersionBody, VersionReasonBody,
} from '../../shared/schemas.ts';
import { getTable } from '../domain/guards.ts';
import { ensureActiveToken, markCardDownloaded, qrSvg, qrUrl } from '../domain/qr.ts';
import { createTable, listTables, overview, rotateTableQr, updateTable } from '../domain/tables.ts';
import {
  guestSessionDTO, joinVisit, leaveVisit, openVisit, qrTarget, resolveQr, revokeGuests, rotatePin, transferVisit,
  updateCovers, visitDetail,
} from '../domain/visits.ts';

const MAX_CARDS = 200;
const PIN_SHAPE = /^\d{4,8}$/;

/** Path id, validated so junk never reaches SQL (unknown ids are simply not found). */
function pathId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? '';
  if (!IdSchema.safeParse(id).success) throw new AppError('not_found', 'Not found');
  return id;
}

/** The JSON body as an object, or {} (a malformed QR request is answered qr_invalid, not 422). */
async function looseJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The guest session this browser already holds, if it is still valid. */
function currentGuest(c: Context<AppEnv>): GuestContext | null {
  const r = resolveGuest(c);
  return 'guest' in r ? r.guest : null;
}

function liveTableOr404(id: string) {
  const t = getTable(id);
  if (!t || t.archived_at) throw new AppError('not_found', 'Table not found');
  return t;
}

/** ASCII-safe attachment name plus the exact UTF-8 name (Thai labels). */
function attachmentName(label: string): string {
  const base = `rabbit-grill-table-${label}-qr.svg`;
  const ascii = base.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

// ------------------------------------------------------------------ public: scan and join
export const tablesPublic = new Hono<AppEnv>()
  .post('/qr/resolve', async (c) => {
    hit(`qr:resolve:${clientIp(c)}`, LIMITS.qrResolve);
    const raw = await looseJson(c);
    const target = qrTarget(raw.token);
    return c.json(resolveQr(target, currentGuest(c)));
  })
  .post('/qr/join', async (c) => {
    hit(`qr:join:${clientIp(c)}`, LIMITS.join);
    const raw = await looseJson(c);
    const target = qrTarget(raw.token);
    hit(`qr:join:table:${target.table.id}`, LIMITS.joinPerTable);
    let pin: string | undefined;
    if (raw.pin !== undefined && raw.pin !== null && raw.pin !== '') {
      // A malformed PIN is a typing problem, not a guess: it is not counted.
      if (typeof raw.pin !== 'string' || !PIN_SHAPE.test(raw.pin)) {
        throw new AppError('validation_failed', 'The PIN must be 4 to 8 digits.', { issues: [{ path: 'pin', message: 'digits' }] });
      }
      pin = raw.pin;
    }
    const outcome = tx(() => joinVisit(target.token.token, pin, currentGuest(c)));
    // Failed attempts are committed (counter / lockout) before the error is returned.
    if (!outcome.ok) throw outcome.error;
    // A cookie for another visit is replaced only now, after a successful join.
    if (outcome.token) issueGuestCookie(c, outcome.token);
    return c.json(guestSessionDTO(outcome), outcome.token ? 201 : 200);
  });

// ------------------------------------------------------------------ guest
export const tablesGuest = new Hono<AppEnv>()
  .get('/session', requireGuest(), (c) => c.json(guestSessionDTO(guestOf(c))))
  .post('/leave', (c) => {
    const current = currentGuest(c);
    if (current) tx(() => leaveVisit(current));
    clearGuestCookie(c);
    return c.json({ ok: true });
  });

// ------------------------------------------------------------------ staff
export const tablesStaff = new Hono<AppEnv>()
  .get('/overview', requireStaff('orders.view'), (c) => c.json(overview(staffOf(c))))

  .get('/tables', requireStaff('tables.view'), (c) => c.json(listTables()))

  .post('/tables', requireStaff('tables.manage'), async (c) => {
    const input = await body(c, CreateTableBody);
    const staff = staffOf(c);
    return c.json(tx(() => createTable(input, staff.actor)), 201);
  })

  // Printable batch: ?ids=a,b (default: every live table). Fetching the batch
  // counts as downloading each card (clears "reprint required").
  .get('/tables/qr-cards', requireStaff('tables.view'), async (c) => {
    const staff = staffOf(c);
    const ids = (c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > MAX_CARDS || ids.some((id) => !IdSchema.safeParse(id).success)) {
      throw new AppError('validation_failed', 'Some table ids are not valid.', { issues: [{ path: 'ids', message: 'invalid' }] });
    }
    const rows = tx(() => {
      const tables = ids.length > 0
        ? [...new Set(ids)].map(liveTableOr404)
        : listTables().tables.map((t) => liveTableOr404(t.id));
      return tables.map((t) => {
        const token = ensureActiveToken(t.id, staff.actor);
        markCardDownloaded(token.id);
        return { table_id: t.id, label: t.label, url: qrUrl(token.token) };
      });
    });
    const cards = await Promise.all(rows.map(async (r) => ({ ...r, svg: await qrSvg(r.url) })));
    return c.json({ cards });
  })

  .patch('/tables/:id', requireStaff(), async (c) => {
    const id = pathId(c);
    const input = await body(c, UpdateTableBody);
    const staff = staffOf(c);
    return c.json(tx(() => updateTable(id, input, staff)));
  })

  .post('/tables/:id/rotate-qr', requireStaff('tables.qr_rotate'), async (c) => {
    const id = pathId(c);
    const input = await body(c, RotateQrBody);
    const staff = staffOf(c);
    return c.json(tx(() => rotateTableQr(id, input, staff.actor)));
  })

  // Raw QR image. `?download=1` serves it as an attachment and marks the card downloaded.
  .get('/tables/:id/qr.svg', requireStaff('tables.view'), async (c) => {
    const id = pathId(c);
    const staff = staffOf(c);
    const download = c.req.query('download') === '1';
    const { label, url } = tx(() => {
      const t = liveTableOr404(id);
      const token = ensureActiveToken(t.id, staff.actor);
      if (download) markCardDownloaded(token.id);
      return { label: t.label, url: qrUrl(token.token) };
    });
    const svg = await qrSvg(url);
    const headers: Record<string, string> = {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    };
    if (download) headers['Content-Disposition'] = attachmentName(label);
    return c.body(svg, 200, headers);
  })

  .post('/tables/:id/visits', requireStaff('visits.open'), async (c) => {
    const id = pathId(c);
    const input = await body(c, OpenVisitBody);
    const staff = staffOf(c);
    const { dto, replayed } = tx(() => {
      const r = openVisit(id, { covers: input.covers, idempotencyKey: input.idempotency_key }, staff);
      return { dto: visitDetail(r.visitId, staff), replayed: r.replayed };
    });
    return c.json(dto, replayed ? 200 : 201);
  })

  .get('/visits/:id', requireStaff('tables.view'), (c) => {
    const id = pathId(c);
    const staff = staffOf(c);
    // One transaction = one consistent snapshot across orders, requests and bill.
    return c.json(tx(() => visitDetail(id, staff)));
  })

  .patch('/visits/:id', requireStaff('visits.covers'), async (c) => {
    const id = pathId(c);
    const input = await body(c, UpdateVisitBody);
    const staff = staffOf(c);
    return c.json(tx(() => {
      updateCovers(id, input, staff);
      return visitDetail(id, staff);
    }));
  })

  .post('/visits/:id/rotate-pin', requireStaff('visits.pin_rotate'), async (c) => {
    const id = pathId(c);
    const input = await body(c, VersionBody);
    const staff = staffOf(c);
    return c.json(tx(() => {
      rotatePin(id, input, staff);
      return visitDetail(id, staff);
    }));
  })

  .post('/visits/:id/revoke-guests', requireStaff('visits.revoke_guests'), async (c) => {
    const id = pathId(c);
    const input = await body(c, VersionReasonBody);
    const staff = staffOf(c);
    return c.json(tx(() => {
      revokeGuests(id, input, staff);
      return visitDetail(id, staff);
    }));
  })

  .post('/visits/:id/transfer', requireStaff('visits.transfer'), async (c) => {
    const id = pathId(c);
    const input = await body(c, TransferVisitBody);
    const staff = staffOf(c);
    return c.json(tx(() => {
      transferVisit(id, input, staff);
      return visitDetail(id, staff);
    }));
  });
