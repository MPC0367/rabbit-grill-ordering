// Dictionary registry. Each area owns one file; key prefixes never overlap:
//   common.ts   common.* conn.* status.* track.step.* track.notRecorded table.* service.*
//   errors.ts   error.*
//   guest.ts    menu.* shell.*                                   (C1a guest shell + menu)
//   cart.ts     cart.* item.* submit.*                           (C1b item sheet, cart, submit)
//   visit.ts    join.* track.* bill.* portion.* visit.* feedback.* help.*  (C2 guest visit)
//   admin.ts    admin.* login.* overview.*                       (C4a admin shell)
//   orders.ts   orders.* requests.* assist.* recover.*           (C4b orders board)
//   tables.ts   tables.* billing.* qr.* payments.*               (C5 tables & billing)
//   catalog.ts  catalog.*                                        (C6 admin menu)
//   insights.ts insights.*                                       (C7a insights)
//   more.ts     reports.* team.* settings.* audit.* more.*       (C7b more)
//
// Loading: the entry bundle carries only common + errors. Each interface
// registers its own areas when its chunk loads (guest-bundle.ts from
// GuestApp, admin-bundle.ts from AdminApp), so a guest phone never downloads
// the staff copy. Registration mutates the same objects, so lookups made
// after the chunk has evaluated (every render inside it) see the new keys.
import type { Locale } from '../../../shared/settings.ts';
import common from './common.ts';
import errors from './errors.ts';

export type Dict = Record<string, string>;
export interface AreaDict { th: Dict; en: Dict }

export const dictionaries: Record<Locale, Dict> = { th: {}, en: {} };

export function registerDictionaries(...areas: AreaDict[]): void {
  for (const a of areas) {
    Object.assign(dictionaries.th, a.th);
    Object.assign(dictionaries.en, a.en);
  }
}

registerDictionaries(common, errors);
