// Deterministic TEST fixtures (never used by the app). Written straight into a
// fresh database before the test server starts.
import { insert, run } from '../../server/db/index.ts';
import { hashPassword } from '../../server/lib/auth.ts';
import { ROLES, type Role } from '../../shared/permissions.ts';
import { nowIso, businessDate } from '../../shared/time.ts';

export const PASSWORD = (role: Role) => `test-password-${role}`;

export const T = {
  tables: ['tbl_T01', 'tbl_T02', 'tbl_T03', 'tbl_T04'],
  tokens: {
    tbl_T01: 'qr_test_token_table_01_aaaaaaaaaaaaaaaaaaaa',
    tbl_T02: 'qr_test_token_table_02_bbbbbbbbbbbbbbbbbbbb',
    tbl_T03: 'qr_test_token_table_03_cccccccccccccccccccc',
    tbl_T04: 'qr_test_token_table_04_dddddddddddddddddddd',
  } as Record<string, string>,
  items: {
    steak: 'itm_steak', coffee: 'itm_coffee', soup: 'itm_soup', rib: 'itm_rib', wine: 'itm_wine', draft: 'itm_draft', dessert: 'itm_dessert',
  },
  variants: { hot: 'var_coffee_hot', iced: 'var_coffee_iced', decaf: 'var_coffee_decaf' },
  groups: { doneness: 'mgr_doneness', sides: 'mgr_sides' },
  options: { rare: 'opt_rare', medium: 'opt_medium', fries: 'opt_fries', salad: 'opt_salad', mash: 'opt_mash' },
  categories: { grill: 'cat_grill', coffee: 'cat_coffee', dessert: 'cat_dessert' },
};

export function seedTestFixtures(opts: { mode?: 'live' | 'demo'; pinRequired?: boolean } = {}): void {
  const now = nowIso();
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('operating_mode', :v, :at)`, { v: JSON.stringify(opts.mode ?? 'live'), at: now });
  // Written in BOTH directions on purpose. Leaving it out when PINs are wanted
  // made every join test inherit the product default, so flipping that default
  // broke seven tests that were not about defaults at all.
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('join', :v, :at)`, {
    v: JSON.stringify({ pin_required: opts.pinRequired !== false }), at: now,
  });
  // Tests must not be slowed by the anti-spam cooldown.
  run(`INSERT INTO settings (key, value, updated_at) VALUES ('services', :v, :at)`, {
    v: JSON.stringify({ call_staff: true, bill: true, order_change: true, allergy_help: true, water: true, utensils: false }), at: now,
  });

  for (const role of ROLES) {
    insert('staff_users', {
      id: `stf_${role}`, username: role, display_name: `Test ${role}`, role,
      password_hash: hashPassword(PASSWORD(role)), active: 1, is_fixture: 0, created_at: now, updated_at: now,
    });
  }

  T.tables.forEach((id, i) => {
    insert('dining_tables', { id, label: `T0${i + 1}`, sort: i, enabled: 1, ordering_paused: 0, created_at: now, updated_at: now });
    insert('table_qr_tokens', { id: `qrt_${id}`, table_id: id, token: T.tokens[id], active: 1, created_at: now });
  });

  insert('menu_groups', { id: 'grp_food', key: 'food', name_th: 'อาหาร', name_en: 'Food', sort: 1 });
  insert('menu_groups', { id: 'grp_drinks', key: 'drinks', name_th: 'เครื่องดื่ม', name_en: 'Drinks', sort: 2 });
  const cat = (id: string, key: string, group: string, en: string, th: string, station: string, sort: number, extra: Record<string, unknown> = {}) =>
    insert('menu_categories', { id, key, group_id: group, name_en: en, name_th: th, sort, status: 'published', station, created_at: now, updated_at: now, ...extra });
  cat(T.categories.grill, 'test-grill', 'grp_food', 'Test Grill', 'ย่างทดสอบ', 'kitchen', 1);
  cat(T.categories.dessert, 'dessert', 'grp_food', 'Dessert', 'ของหวาน', 'kitchen', 2);
  cat(T.categories.coffee, 'test-coffee', 'grp_drinks', 'Test Coffee', 'กาแฟทดสอบ', 'bar', 3);

  const item = (id: string, key: string, category: string, en: string, th: string, extra: Record<string, unknown>) =>
    insert('menu_items', {
      id, key, category_id: category, sort: 1, name_en: en, name_th: th, status: 'published', review_status: 'verified',
      demo_orderable: 1, created_at: now, updated_at: now, approved_at: now, reviewer: 'test', published_version: 1, ...extra,
    });
  item(T.items.steak, 'test-steak', T.categories.grill, 'Test Striploin', 'สันนอกทดสอบที่ชื่อยาวมากเพื่อทดสอบการตัดบรรทัดภาษาไทย', { pricing_type: 'fixed', price_minor: 59000, max_qty: 10 });
  item(T.items.soup, 'test-soup', T.categories.grill, 'Test Soup', 'ซุปทดสอบ', { pricing_type: 'fixed', price_minor: 15000 });
  item(T.items.rib, 'test-prime-rib', T.categories.grill, 'Test Prime Rib', 'ไพร์มริบทดสอบ', { pricing_type: 'measured_weight', rate_minor: 49000, rate_basis_grams: 100 });
  item(T.items.coffee, 'test-latte', T.categories.coffee, 'Test Latte', 'ลาเต้ทดสอบ', { pricing_type: 'variant', station: 'bar' });
  item(T.items.wine, 'test-wine', T.categories.coffee, 'Test Wine', null as unknown as string, { pricing_type: 'fixed', price_minor: 25000, alcohol: 1, station: 'bar', requires_staff_confirm: 1 });
  item(T.items.draft, 'test-draft', T.categories.grill, 'Draft Dish', 'จานร่าง', { pricing_type: 'fixed', price_minor: 10000, status: 'draft', review_status: 'unverified', published_version: null });
  item(T.items.dessert, 'test-dessert', T.categories.dessert, 'Test Tiramisu', 'ทีรามิสุทดสอบ', { pricing_type: 'fixed', price_minor: 18000, review_status: 'unverified', demo_orderable: 1 });

  insert('item_variants', { id: T.variants.hot, item_id: T.items.coffee, key: 'hot', name_en: 'Hot', name_th: 'ร้อน', price_minor: 8000, available: 1, sort: 1 });
  insert('item_variants', { id: T.variants.iced, item_id: T.items.coffee, key: 'iced', name_en: 'Iced', name_th: 'เย็น', price_minor: 9000, available: 1, sort: 2 });
  insert('item_variants', { id: T.variants.decaf, item_id: T.items.coffee, key: 'decaf', name_en: 'Decaf', name_th: null, price_minor: null, available: 0, sort: 3 });

  // TEST-ONLY modifier groups (the restaurant has confirmed none of these).
  insert('modifier_groups', { id: T.groups.doneness, key: 'test-doneness', name_en: 'Test doneness', name_th: 'ความสุกทดสอบ', min_select: 1, max_select: 1, included_count: 0, created_at: now, updated_at: now });
  insert('modifier_options', { id: T.options.rare, group_id: T.groups.doneness, key: 'rare', name_en: 'Rare', price_delta_minor: 0, sort: 1 });
  insert('modifier_options', { id: T.options.medium, group_id: T.groups.doneness, key: 'medium', name_en: 'Medium', price_delta_minor: 0, sort: 2 });
  insert('modifier_groups', { id: T.groups.sides, key: 'test-sides', name_en: 'Test sides', min_select: 0, max_select: 2, included_count: 1, created_at: now, updated_at: now });
  insert('modifier_options', { id: T.options.fries, group_id: T.groups.sides, key: 'fries', name_en: 'Fries', price_delta_minor: 9000, upgrade_minor: 0, sort: 1 });
  insert('modifier_options', { id: T.options.salad, group_id: T.groups.sides, key: 'salad', name_en: 'Salad', price_delta_minor: 12000, upgrade_minor: 3000, sort: 2 });
  insert('modifier_options', { id: T.options.mash, group_id: T.groups.sides, key: 'mash', name_en: 'Mash', price_delta_minor: 12000, upgrade_minor: 0, available: 0, sort: 3 });
  insert('item_modifier_groups', { item_id: T.items.steak, group_id: T.groups.doneness, sort: 1 });
  insert('item_modifier_groups', { item_id: T.items.steak, group_id: T.groups.sides, sort: 2 });

  const bd = businessDate(now);
  for (const id of Object.values(T.items)) {
    insert('availability_log', { item_id: id, available: id === T.items.draft ? 0 : 1, reason: 'published', changed_at: `${bd}T00:00:00.000Z`, changed_by: 'test' });
  }
}
