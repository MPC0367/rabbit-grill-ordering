// Staff interface copy. Imported for its side effect by admin/AdminApp.tsx
// (and the development kit gallery). Includes the guest areas: staff screens
// preview guest components and share their vocabulary.
import './guest-bundle.ts';
import { registerDictionaries } from './index.ts';
import admin from './admin.ts';
import orders from './orders.ts';
import tables from './tables.ts';
import catalog from './catalog.ts';
import insights from './insights.ts';
import more from './more.ts';

registerDictionaries(admin, orders, tables, catalog, insights, more);
