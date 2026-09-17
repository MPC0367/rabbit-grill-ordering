// Catalog HTTP routes (S1).
//   catalogPublic -> /api/public : menu (ETag) and public configuration
//   catalogStaff  -> /api/staff  : menu editor, review, CSV import/export, ordering state
// Handlers only parse, authorize and run the domain function inside tx().
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import {
  AvailabilityBody, CategoryInput, CreateItemBody, IdSchema, ImportPreviewBody, ItemStatusBody, ModifierGroupInput,
  OrderingStateBody, ReorderBody, ResolveFlagBody, ReviewBody, UpdateCategoryBody, UpdateItemBody,
} from '../../shared/schemas.ts';
import { todayBusinessDate } from '../../shared/time.ts';
import { tx } from '../db/index.ts';
import { requireStaff, staffOf } from '../lib/auth.ts';
import { csvResponseHeaders } from '../lib/csv.ts';
import { AppError } from '../lib/errors.ts';
import { body } from '../lib/http.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { cutoffHour, invalidateSettings } from '../lib/settings.ts';
import { adminCatalog, publicCatalog, publicConfig } from '../domain/catalog.ts';
import {
  createCategory, createItem, createModifierGroup, reorder, resolveFlag, reviewItem, setAvailability, setItemStatus,
  staffOrderingState, updateCategory, updateItem, updateModifierGroup, updateOrderingState,
} from '../domain/catalog-edit.ts';
import { applyImport, exportCatalogCsv, importTemplateCsv, previewImport } from '../domain/importer.ts';
import { catalogVersion } from '../domain/pricing.ts';

// safeExtend keeps ModifierGroupInput's max >= min refinement.
const ModifierGroupUpdateBody = ModifierGroupInput.safeExtend({ version: z.number().int() });

/** Route id parameter; anything that is not a well-formed id cannot exist. */
function idParam(c: Context<AppEnv>): string {
  const value = c.req.param('id') ?? '';
  if (!IdSchema.safeParse(value).success) throw new AppError('not_found', 'Not found');
  return value;
}

/** Staff mutation: signed-in member, per-user rate limit. */
function mutator(c: Context<AppEnv>) {
  const staff = staffOf(c);
  hit(`staff-mutation:${staff.user.id}`, LIMITS.staffMutation);
  return staff;
}

// ------------------------------------------------------------------ public
export const catalogPublic = new Hono<AppEnv>()
  .get('/config', (c) => c.json(publicConfig()))
  // Guests revalidate with If-None-Match; the version changes with anything guest-visible.
  .get('/menu', (c) => {
    c.header('Cache-Control', 'no-cache');
    const etag = `"${catalogVersion()}"`;
    const inm = c.req.header('if-none-match');
    if (inm && inm.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*')) {
      c.header('ETag', etag);
      return c.body(null, 304);
    }
    const menu = publicCatalog();
    c.header('ETag', `"${menu.version}"`);
    return c.json(menu);
  });

// ------------------------------------------------------------------ staff
export const catalogStaff = new Hono<AppEnv>()
  .get('/menu', requireStaff('menu.view'), (c) => c.json(adminCatalog()))

  .get('/menu/export.csv', requireStaff('menu.view'), (c) =>
    c.body(exportCatalogCsv(), 200, csvResponseHeaders(`rabbit-grill-menu-${todayBusinessDate(cutoffHour())}.csv`)))

  .get('/menu/import-template.csv', requireStaff('menu.import'), (c) =>
    c.body(importTemplateCsv(), 200, csvResponseHeaders('rabbit-grill-menu-import-template.csv')))

  // items
  .post('/menu/items', requireStaff('menu.edit'), async (c) => {
    const staff = mutator(c);
    const input = await body(c, CreateItemBody);
    return c.json(tx(() => createItem(input, staff)), 201);
  })
  .patch('/menu/items/:id', requireStaff('menu.edit'), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, UpdateItemBody);
    return c.json(tx(() => updateItem(id, input, staff)));
  })
  .post('/menu/items/:id/availability', requireStaff('menu.availability'), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, AvailabilityBody);
    return c.json(tx(() => setAvailability(id, input, staff)));
  })
  .post('/menu/items/:id/status', requireStaff('menu.publish'), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, ItemStatusBody);
    return c.json(tx(() => setItemStatus(id, input, staff)));
  })
  .post('/menu/items/:id/review', requireStaff('menu.review'), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, ReviewBody);
    return c.json(tx(() => reviewItem(id, input, staff)));
  })

  // categories (a pause-only change needs ordering.pause; the domain checks per field)
  .post('/menu/categories', requireStaff('menu.edit'), async (c) => {
    const staff = mutator(c);
    const input = await body(c, CategoryInput);
    return c.json(tx(() => createCategory(input, staff)), 201);
  })
  .patch('/menu/categories/:id', requireStaff(), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, UpdateCategoryBody);
    return c.json(tx(() => updateCategory(id, input, staff)));
  })

  // reusable choice groups
  .post('/menu/modifier-groups', requireStaff('menu.edit'), async (c) => {
    const staff = mutator(c);
    const input = await body(c, ModifierGroupInput);
    return c.json(tx(() => createModifierGroup(input, staff)), 201);
  })
  .patch('/menu/modifier-groups/:id', requireStaff('menu.edit'), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, ModifierGroupUpdateBody);
    return c.json(tx(() => updateModifierGroup(id, input, staff)));
  })

  .post('/menu/reorder', requireStaff('menu.edit'), async (c) => {
    const staff = mutator(c);
    const input = await body(c, ReorderBody);
    return c.json(tx(() => reorder(input, staff)));
  })
  .post('/menu/flags/:id/resolve', requireStaff('menu.review'), async (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    const input = await body(c, ResolveFlagBody);
    return c.json(tx(() => resolveFlag(id, input, staff)));
  })

  // CSV import: preview stores a batch, apply turns it into drafts
  .post('/menu/import/preview', requireStaff('menu.import'), async (c) => {
    const staff = mutator(c);
    const input = await body(c, ImportPreviewBody);
    return c.json(tx(() => previewImport(input.filename, input.csv, staff)));
  })
  .post('/menu/import/:id/apply', requireStaff('menu.import'), (c) => {
    const staff = mutator(c);
    const id = idParam(c);
    return c.json(tx(() => applyImport(id, staff)));
  })

  // restaurant-wide ordering state
  .get('/ordering', requireStaff('orders.view'), (c) => c.json(staffOrderingState()))
  .patch('/ordering', requireStaff('ordering.pause'), async (c) => {
    const staff = mutator(c);
    const input = await body(c, OrderingStateBody);
    try {
      return c.json(tx(() => updateOrderingState(input, staff)));
    } catch (err) {
      // putSetting() refreshed the settings cache inside the rolled-back transaction.
      invalidateSettings();
      throw err;
    }
  });
