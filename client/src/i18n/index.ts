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
import type { Locale } from '../../../shared/settings.ts';
import common from './common.ts';
import errors from './errors.ts';
import guest from './guest.ts';
import cart from './cart.ts';
import visit from './visit.ts';
import admin from './admin.ts';
import orders from './orders.ts';
import tables from './tables.ts';
import catalog from './catalog.ts';
import insights from './insights.ts';
import more from './more.ts';

export type Dict = Record<string, string>;
export interface AreaDict { th: Dict; en: Dict }

const areas: AreaDict[] = [common, errors, guest, cart, visit, admin, orders, tables, catalog, insights, more];

export const dictionaries: Record<Locale, Dict> = {
  th: Object.assign({}, ...areas.map((a) => a.th)),
  en: Object.assign({}, ...areas.map((a) => a.en)),
};
