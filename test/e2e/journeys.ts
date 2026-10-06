// Guest and staff journeys in real browsers against one running instance.
// Each journey returns a Check (soft assertions); test/e2e/run.ts turns a
// failed Check into a failed test. Journeys a-f share one table visit and run
// in order.
//
//   a  staff seats a free table; guest joins by QR + PIN, customises, sends (scenario 1)
//   b  kitchen advances the round; guest Track updates live, no reload (scenario 1)
//   c  weighed cut: request, staff quote, guest confirm, board (brief 44A)
//   d  call staff + request bill; staff acknowledge live
//   e  second phone: own empty draft, same rounds, same bill (scenario 2)
//   f  serve, finalise, cash payment, Complete checkout; guest sees the visit end;
//      the old cookie cannot order; the table is Available (brief 36)
//   g  language switch inside the dish sheet, mid-cart and while tracking (scenario 13)
//   h  owner insights, provisional annual PDF, pause and resume ordering
//   realtime  the board's live channel is cut, a guest orders over HTTP, the
//             board catches up when the channel returns (scenario 12)
//   offline   a guest phone loses the network: offline state, sending blocked,
//             draft kept; sending returns with the network (brief 30)
//   shell     dev gallery, manager review queue, History subtab + Back,
//             320 px masthead, Back closes a sheet and restores focus
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import cartDict from '../../client/src/i18n/cart.ts';
import { lanAddresses } from '../../scripts/env.ts';
import { startCutProxy } from './cutproxy.ts';
import {
  Check, cleanRun, click, confirmTopDialog, env, fetchIn, go, instrumentAudio, open, qrToken, restoreGuest,
  saveGuest, shot, signInAs, sleep, staffApi, textOf, type MenuItem, type Saved, type Sess, type StaffApi,
} from './lib.ts';

export interface State {
  table?: { id: string; label: string };
  visitId?: string;
  token?: string;
  pin?: string | null;
  reference?: string;
  orderId?: string;
  roundNo?: number;
  portionOrderId?: string;
  guestA?: Saved;
  guestG?: Saved;
}
export type Item = (key: string) => MenuItem;

interface Tile { id: string; label: string; state: string; version: number; visit: { id: string; status: string } | null }
interface Line { id: string; status: string; version: number }
interface Order { id: string; reference: string; round_no: number; source: string; lines: Line[]; visit_id: string }

async function tableOrders(api: StaffApi, visitId: string): Promise<Order[]> {
  const r = await api<{ orders: Order[] }>('GET', '/api/staff/orders?scope=active');
  return r.orders.filter((o) => o.visit_id === visitId);
}

async function openDish(page: Page, id: string, query: string) {
  const inputs = await page.$$('input[type="search"]');
  let input = inputs[0];
  for (const h of inputs) if (await h.evaluate((el) => (el as HTMLElement).offsetParent !== null)) { input = h; break; }
  await input.focus();
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await input.type(query, { delay: 10 });
  const sel = `[data-item="${id}"] .dish__open`;
  await page.waitForSelector(sel, { timeout: 10_000 });
  await page.$eval(sel, (el) => (el as HTMLElement).click());
  await page.waitForSelector('dialog.sheet[open]', { timeout: 10_000 });
  await sleep(500);
}

async function clearSearch(page: Page) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('.search button')).find((x) => x.offsetParent !== null);
    b?.click();
  });
  await sleep(300);
}

async function quickAdd(page: Page, id: string) {
  const sel = `[data-item="${id}"] .dish__foot button`;
  await page.waitForSelector(sel, { timeout: 10_000 });
  await page.$eval(sel, (b) => { b.scrollIntoView({ block: 'center' }); (b as HTMLElement).click(); });
}

/**
 * Join from the scan screen. With a code in use, type it (pressing Join when
 * the code length is not known up front). With codes off (D-G-08) the screen
 * is a one-tap confirm card and there is nothing to type.
 */
export async function joinWithPin(page: Page, pin: string | null) {
  await page.waitForSelector('.vjoin__card', { timeout: 15_000 });
  if (!pin || !(await page.$('.vpin__input'))) {
    await page.$eval('.vjoin__card button', (b) => (b as HTMLButtonElement).click());
    await page.waitForFunction(() => location.pathname === '/menu', { timeout: 15_000 });
    return;
  }
  await page.type('.vpin__input', pin, { delay: 50 });
  const moved = await page.waitForFunction(() => location.pathname === '/menu', { timeout: 2000 }).then(() => true).catch(() => false);
  if (!moved) {
    await page.$eval('.vjoin__card button[type="submit"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForFunction(() => location.pathname === '/menu', { timeout: 15_000 });
  }
}

async function guestFrom(name: string, saved: Saved | undefined, opts: { lang?: 'th' | 'en'; w?: number } = {}): Promise<Sess> {
  const s = await open(name, { lang: opts.lang ?? 'th', w: opts.w ?? 390 });
  if (saved) await restoreGuest(s.page, saved);
  return s;
}

async function failed(c: Check, err: unknown, ...sessions: Sess[]) {
  c.ok(false, `threw: ${(err as Error).message}`);
  for (const s of sessions) await shot(s.page, `${c.name}-error-${s.name}`).catch(() => {});
}

// ============================================================ a
export async function journeyA(state: State, item: Item): Promise<Check> {
  const c = new Check('a');
  const staff = await open('floor', { as: 'staff:floor', lang: 'en', w: 1440 });
  const guest = await open('guestA', { lang: 'th', w: 390 });
  try {
    await go(staff.page, '/admin/tables', '.tgrid', 1500);
    const tables = (await fetchIn<{ tables: Tile[] }>(staff.page, 'GET', '/api/staff/tables')).data.tables;
    const t = tables.find((x) => x.label === '05' && x.state === 'available') ?? tables.find((x) => x.state === 'available');
    if (!t) throw new Error('no free table');
    state.table = { id: t.id, label: t.label };
    c.info(`free table ${t.label}`);
    await staff.page.evaluate((id) => {
      const b = document.querySelector<HTMLButtonElement>(`[data-table-id="${id}"] .tcard__act button`);
      b?.scrollIntoView({ block: 'center' });
      b?.click();
    }, t.id);
    await staff.page.waitForSelector('dialog[open] .c5-choice', { timeout: 8000 });
    await click(staff.page, 'dialog[open] .c5-choice', '2', { exact: true });
    await shot(staff.page, 'a01-seat-form-en-1440');
    await confirmTopDialog(staff.page);
    // The seat dialog shows a big code only when this restaurant uses one
    // (D-G-08); with codes off it says so instead, and there is none to read.
    const pin = (await staff.page.$eval('dialog[open] .c5-bigpin', (e) => e.textContent ?? '').catch(() => '')).replace(/\D/g, '');
    if (pin) c.ok(/^\d{4}$/.test(pin), 'staff reads a 4-digit PIN from the seat dialog');
    else c.info('joining needs no code, so the seat dialog shows none');
    state.pin = pin || null;
    await shot(staff.page, 'a02-seat-pin-en-1440');
    await click(staff.page, 'dialog[open]', /^Done$/);
    await sleep(1200);
    const tileText = await textOf(staff.page, `[data-table-id="${t.id}"]`);
    c.ok(/Dining/i.test(tileText), `tile shows Dining (${tileText.split('\n').slice(0, 3).join(' / ')})`);
    const after = (await fetchIn<{ tables: Tile[] }>(staff.page, 'GET', '/api/staff/tables')).data.tables.find((x) => x.id === t.id)!;
    state.visitId = after.visit!.id;
    const cards = await fetchIn<{ cards: Array<{ url: string }> }>(staff.page, 'GET', `/api/staff/tables/qr-cards?ids=${t.id}`);
    const url = cards.data.cards[0].url;
    if (lanAddresses().length) c.ok(!/\/\/(localhost|127\.)/.test(url), `QR card URL is reachable from a phone, not localhost (${new URL(url).host})`);
    else c.info(`no LAN address on this computer, so the QR card URL is ${new URL(url).host}`);
    if (pin) c.ok(!url.includes(pin), 'the printed QR URL does not carry the visit PIN');
    state.token = url.slice(url.lastIndexOf('/q/') + 3);

    // Guest scans the QR. A code screen only when this restaurant uses one.
    await guest.page.goto(`${env.base}/q/${state.token}`, { waitUntil: 'domcontentloaded' });
    await guest.page.waitForSelector('.vjoin__card', { timeout: 15_000 });
    await shot(guest.page, 'a03-join-pin-th-390');
    await joinWithPin(guest.page, pin);
    await sleep(1200);
    const tag = await guest.page.$eval('.tabletag__n', (e) => e.textContent).catch(() => null);
    c.ok(tag === t.label, `menu header shows table ${tag}`);
    const toast = await guest.page.$eval('.toast__msg', (e) => e.textContent).catch(() => null);
    c.ok(Boolean(toast && toast.includes(`โต๊ะ ${t.label}`)), `welcome toast names the table (${toast})`);
    await shot(guest.page, 'a04-menu-joined-th-390');

    // One-tap add of a simple dish.
    const pork = item('grilled-pork');
    await quickAdd(guest.page, pork.id);
    await sleep(300);
    const confirmText = await guest.page.$eval(`[data-item="${pork.id}"] .dish__foot`, (e) => (e as HTMLElement).innerText);
    c.ok(/เพิ่มแล้ว|ในรายการ/.test(confirmText), `quick add confirms in place (${confirmText.replace(/\s+/g, ' ')})`);
    await sleep(1400);

    // A drink whose hot variant is not offered.
    const matcha = item('clear-matcha');
    await openDish(guest.page, matcha.id, 'Clear Matcha');
    const sheetText = await textOf(guest.page, 'dialog.sheet[open]');
    c.ok(sheetText.includes(cartDict.th['item.variant.unavailable']), 'hot matcha is shown as not available');
    await guest.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).click());
    await sleep(800);
    c.ok(!(await guest.page.$('dialog.sheet[open]')), 'matcha added, sheet closed');

    // Coffee with a paid bean choice and a note.
    const latte = item('latte');
    await openDish(guest.page, latte.id, 'Latte');
    await click(guest.page, 'dialog.sheet[open]', 'เย็น');
    await click(guest.page, 'dialog.sheet[open]', 'Balanced Blend');
    await guest.page.type('dialog.sheet[open] textarea', 'หวานน้อย', { delay: 10 });
    await shot(guest.page, 'a05-latte-sheet-th-390');
    const commit = await guest.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).innerText.replace(/\s+/g, ' '));
    c.ok(commit.includes('110'), `latte add button shows the chosen total ฿110 (${commit})`);
    await guest.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).click());
    await sleep(800);
    await clearSearch(guest.page);

    // Order slip -> Your order -> review -> place.
    const slip = await guest.page.$('.dock .slip');
    c.ok(Boolean(slip), 'order slip visible');
    await slip?.click();
    await guest.page.waitForFunction(() => location.pathname === '/menu/cart', { timeout: 10_000 });
    await sleep(1500);
    await shot(guest.page, 'a06-cart-th-390', { full: true });
    c.ok((await textOf(guest.page, '#main')).includes('หวานน้อย'), 'the note stays on the latte line');
    await guest.page.$eval('[data-testid="cart-send"]', (b) => (b as HTMLElement).click());
    await guest.page.waitForFunction(() => location.search.includes('step=review'), { timeout: 10_000 });
    await sleep(1500);
    await shot(guest.page, 'a07-review-th-390', { full: true });
    c.ok((await textOf(guest.page, '#main')).includes(t.label), 'review names the table');
    await guest.page.$eval('[data-testid="submit-place"]', (b) => (b as HTMLElement).click());
    await guest.page.waitForFunction(() => location.pathname === '/menu/orders', { timeout: 20_000 });
    const landed = guest.page.url();
    await sleep(2000);
    const ref = /placed=([^&]+)/.exec(landed)?.[1] ?? null;
    c.ok(Boolean(ref), `lands on Track with the order reference (${ref})`);
    if (ref) {
      state.reference = decodeURIComponent(ref);
      c.ok(Boolean(await guest.page.$('.round.is-highlight')), 'the new round is highlighted');
    }
    await shot(guest.page, 'a08-track-placed-th-390');
    const api = await staffApi('manager');
    const o = (await tableOrders(api, state.visitId)).find((x) => x.reference === state.reference);
    c.ok(o && o.lines.length === 3, `the server holds the round with 3 lines (${o?.lines.length})`);
    if (o) { state.orderId = o.id; state.roundNo = o.round_no; }
    const draftLeft = await guest.page.$('.dock .slip');
    c.ok(!draftLeft, 'the sent lines left the device draft');
    state.guestA = await saveGuest(guest.page);
    cleanRun(c, guest, staff);
  } catch (err) {
    await failed(c, err, guest, staff);
  } finally {
    await staff.dispose();
    await guest.dispose();
  }
  return c;
}

// ============================================================ b
export async function journeyB(state: State): Promise<Check> {
  const c = new Check('b');
  const staff = await open('kitchen', { as: 'staff:kitchen', lang: 'th', w: 1440 });
  await instrumentAudio(staff.page);
  // This tablet shows every station (a per-device choice; kitchen tablets default to Kitchen).
  await staff.page.evaluate(() => localStorage.setItem('rg.orders.station', JSON.stringify('all')));
  const guest = await guestFrom('guestA', state.guestA);
  try {
    if (!state.orderId) throw new Error('journey a did not place an order');
    await go(guest.page, '/menu/orders', '.round', 1500);
    const sel = `article[data-order="${state.orderId}"]`;
    await go(staff.page, '/admin/orders', '.ob', 2000);
    await staff.page.waitForSelector(sel, { timeout: 10_000 });
    const cls = await staff.page.$eval(sel, (e) => e.className);
    c.ok(cls.includes('is-new'), `the new ticket is emphasised (${cls})`);
    await shot(staff.page, 'b01-board-new-th-1440');
    const guestRound = `.round[data-round="${state.roundNo}"]`;
    const steps: Array<[string, string]> = [
      ['รับออร์เดอร์', 'confirmed'],
      ['เริ่มทำ', 'preparing'],
      ['แจ้งใกล้เสร็จ', 'almost_done'],
      ['แจ้งพร้อมเสิร์ฟ', 'ready'],
    ];
    const navs0 = await guest.page.evaluate(() => performance.getEntriesByType('navigation').length);
    for (const [label, want] of steps) {
      await click(staff.page, sel, label);
      try {
        await guest.page.waitForSelector(`${guestRound}[data-status="${want}"]`, { timeout: 12_000 });
        c.ok(true, `guest Track shows ${want} live`);
      } catch {
        const now = await guest.page.$eval(guestRound, (e) => e.getAttribute('data-status')).catch(() => 'missing');
        c.ok(false, `guest Track shows ${want} live (now ${now})`);
      }
      await sleep(600);
      await shot(guest.page, `b02-track-${want}-th-390`);
    }
    await shot(staff.page, 'b03-board-ready-th-1440');
    const navs1 = await guest.page.evaluate(() => performance.getEntriesByType('navigation').length);
    c.ok(navs0 === navs1, 'the guest page never reloaded');
    const tones = await staff.page.evaluate(() => (window as unknown as { __tones: number }).__tones);
    c.ok(tones === 0, `the board stayed silent with sound off (${tones} tones)`);
    state.guestA = await saveGuest(guest.page);
    cleanRun(c, guest, staff);
  } catch (err) {
    await failed(c, err, guest, staff);
  } finally {
    await staff.dispose();
    await guest.dispose();
  }
  return c;
}

// ============================================================ c
export async function journeyC(state: State, item: Item): Promise<Check> {
  const c = new Check('c');
  const staff = await open('floor', { as: 'staff:floor', lang: 'th', w: 1440 });
  const guest = await guestFrom('guestA', state.guestA);
  try {
    if (!state.table || !state.visitId) throw new Error('journey a did not seat a table');
    await go(guest.page, '/menu', '.dish', 1500);
    await openDish(guest.page, item('prime-rib').id, 'Prime Rib');
    const weigh = await guest.page.evaluate(() => {
      const d = document.querySelector('dialog.sheet[open]');
      const b = Array.from(d?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((x) => /ชั่ง/.test(x.textContent ?? ''));
      b?.click();
      return b?.textContent ?? null;
    });
    c.ok(Boolean(weigh), `the weighed cut offers a weigh request, not an Add button (${weigh})`);
    await guest.page.waitForSelector('dialog[open] .vsheet', { timeout: 10_000 });
    await sleep(500);
    const grams = await guest.page.$('dialog[open] input[inputmode="numeric"]');
    if (grams) await grams.type('400');
    await shot(guest.page, 'c01-portion-sheet-th-390');
    await guest.page.click('dialog[open] .sheet__foot .btn--primary');
    await guest.page.waitForSelector('dialog[open] .vsheet__done', { timeout: 10_000 });
    await shot(guest.page, 'c02-portion-sent-th-390');
    await guest.page.click('dialog[open] .sheet__foot .btn--primary');
    await guest.page.waitForFunction(() => location.pathname === '/menu/orders', { timeout: 10_000 });
    await guest.page.waitForSelector('[data-portion][data-state="requested"]', { timeout: 10_000 });
    c.ok(true, 'guest Track shows the cut waiting to be weighed');

    await go(staff.page, '/admin/orders/requests', '.rqpage', 1500);
    await staff.page.waitForSelector('.rq--portion', { timeout: 10_000 });
    const idx = await staff.page.evaluate((label) => Array.from(document.querySelectorAll('.rq--portion')).findIndex((card) => (card.getAttribute('aria-label') ?? '').includes(`โต๊ะ ${label} `) && card.querySelector('.btn--primary')), state.table.label);
    c.ok(idx >= 0, `the Requests tab lists table ${state.table.label}'s cut`);
    await staff.page.evaluate((i: number) => (document.querySelectorAll('.rq--portion')[i].querySelector('.btn--primary') as HTMLElement).click(), idx);
    await staff.page.waitForSelector('dialog[open].qsheet', { timeout: 8000 });
    await sleep(400);
    await staff.page.keyboard.down('Control'); await staff.page.keyboard.press('KeyA'); await staff.page.keyboard.up('Control');
    await staff.page.keyboard.type('420');
    await sleep(300);
    await shot(staff.page, 'c03-quote-sheet-th-1440');
    await click(staff.page, 'dialog[open] .sheet__foot', 'ส่งราคา');
    await sleep(1200);
    await guest.page.waitForSelector('[data-portion][data-state="quoted"] .btn--primary', { timeout: 12_000 });
    c.ok(true, 'the quote reaches guest Track live');
    const quoteText = await textOf(guest.page, '[data-portion][data-state="quoted"]');
    c.ok(quoteText.includes('420'), `the quote shows the weighed 420 g (${quoteText.replace(/\s+/g, ' ').slice(0, 100)})`);
    c.ok(/2,058|2058/.test(quoteText), 'the quote shows the server amount 420 g × ฿490 / 100 g = ฿2,058');
    await guest.page.$eval('[data-portion][data-state="quoted"]', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(guest.page, 'c04-quote-guest-th-390');
    await guest.page.click('[data-portion][data-state="quoted"] .btn--primary');
    await guest.page.waitForFunction(() => !document.querySelector('[data-portion][data-state="quoted"]'), { timeout: 12_000 });
    await sleep(1200);
    await shot(guest.page, 'c05-quote-confirmed-th-390');
    const api = await staffApi('manager');
    const po = (await tableOrders(api, state.visitId)).find((o) => o.source === 'portion_quote');
    c.ok(Boolean(po), `confirming creates a portion round (${po?.reference})`);
    if (po) {
      state.portionOrderId = po.id;
      await go(staff.page, '/admin/orders', '.ob', 1500);
      const onBoard = await staff.page.waitForSelector(`article[data-order="${po.id}"]`, { timeout: 10_000 }).then(() => true).catch(() => false);
      c.ok(onBoard, 'the portion round appears on the board');
      await shot(staff.page, 'c06-board-portion-th-1440');
    }
    state.guestA = await saveGuest(guest.page);
    cleanRun(c, guest, staff);
  } catch (err) {
    await failed(c, err, guest, staff);
  } finally {
    await staff.dispose();
    await guest.dispose();
  }
  return c;
}

// ============================================================ d
export async function journeyD(state: State): Promise<Check> {
  const c = new Check('d');
  const staff = await open('floor', { as: 'staff:floor', lang: 'en', w: 1440 });
  const guest = await guestFrom('guestA', state.guestA);
  try {
    if (!state.table || !state.visitId) throw new Error('journey a did not seat a table');
    const label = state.table.label;
    await go(staff.page, '/admin/orders/requests', '.rqpage', 1500);
    await go(guest.page, '/menu/orders', '.round', 1500);
    const call = await guest.page.$('button[data-service="call_staff"]');
    c.ok(Boolean(call), 'Call staff is on Track');
    await call!.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await call!.click();
    await guest.page.waitForSelector('button[data-service="call_staff"][data-state="sent"]', { timeout: 10_000 });
    c.ok(true, 'Call staff shows Sent');
    await call!.click().catch(() => {});
    await sleep(800);
    const bill = await guest.page.$('button[data-service="bill"]');
    c.ok(Boolean(bill), 'Request bill is on Track');
    await bill!.click();
    await sleep(600);
    const confirm = await guest.page.$('dialog[open] .sheet__foot .btn--primary');
    if (confirm) { await shot(guest.page, 'd01-bill-confirm-th-390'); await confirm.click(); }
    await guest.page.waitForSelector('a[data-service="bill"]', { timeout: 10_000 });
    c.ok(true, 'bill requested; Track links to the bill');
    await guest.page.evaluate(() => window.scrollTo(0, 0));
    await shot(guest.page, 'd02-track-requests-th-390');

    await staff.page.waitForFunction((l: string) => Array.from(document.querySelectorAll('.rq:not(.rq--portion)')).filter((e) => (e.getAttribute('aria-label') ?? '').includes(`table ${l},`)).length >= 2, { timeout: 12_000 }, label);
    const cards = await staff.page.evaluate((l) => Array.from(document.querySelectorAll('.rq:not(.rq--portion)')).filter((e) => (e.getAttribute('aria-label') ?? '').includes(`table ${l},`)).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 80)), label);
    c.ok(cards.length === 2, `staff see exactly two requests for the table, live (a repeated tap made no duplicate): ${cards.join(' || ')}`);
    await shot(staff.page, 'd03-requests-en-1440');
    for (let i = 0; i < 2; i++) {
      await staff.page.evaluate((l) => {
        const card = Array.from(document.querySelectorAll('.rq:not(.rq--portion)')).find((e) => (e.getAttribute('aria-label') ?? '').includes(`table ${l},`) && Array.from(e.querySelectorAll('button')).some((b) => /^Acknowledge/.test((b.textContent ?? '').trim())));
        Array.from(card?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((x) => /^Acknowledge/.test((x.textContent ?? '').trim()))?.click();
      }, label);
      await sleep(1200);
    }
    const api = await staffApi('manager');
    const reqs = (await api<{ requests: Array<{ visit_id: string; type: string; status: string }> }>('GET', '/api/staff/service?scope=active')).requests.filter((r) => r.visit_id === state.visitId);
    c.ok(reqs.length >= 2 && reqs.every((r) => r.status === 'acknowledged'), `requests acknowledged (${reqs.map((r) => `${r.type}:${r.status}`).join(', ')})`);
    await shot(staff.page, 'd04-requests-acked-en-1440');
    await sleep(1500);
    await shot(guest.page, 'd05-track-acked-th-390');
    state.guestA = await saveGuest(guest.page);
    cleanRun(c, guest, staff);
  } catch (err) {
    await failed(c, err, guest, staff);
  } finally {
    await staff.dispose();
    await guest.dispose();
  }
  return c;
}

// ============================================================ e
export async function journeyE(state: State, item: Item): Promise<Check> {
  const c = new Check('e');
  const a = await guestFrom('guestA', state.guestA);
  const b = await open('guestB', { lang: 'en', w: 390 });
  try {
    if (!state.token) throw new Error('journey a did not seat a table');
    await go(a.page, '/menu', '.dish', 1200);
    await clearSearch(a.page);
    await sleep(600);
    await quickAdd(a.page, item('grilled-pork').id);
    await sleep(1500);
    // Phone B joins with the same QR and PIN.
    await b.page.goto(`${env.base}/q/${state.token}`, { waitUntil: 'domcontentloaded' });
    await joinWithPin(b.page, state.pin ?? null);
    await sleep(1200);
    c.ok(!(await b.page.$('.dock .slip')), 'phone B has no order slip: its draft is its own');
    await go(b.page, '/menu/cart', '#main', 1200);
    const cartB = await textOf(b.page, '#main');
    c.ok(!/Grilled Pork/.test(cartB), `phone A's draft dish is not on phone B (${cartB.replace(/\s+/g, ' ').slice(0, 80)})`);
    await shot(b.page, 'e01-cart-empty-en-390');
    await go(b.page, '/menu/orders', '.round', 1500);
    const roundsB = await b.page.$$eval('.round[data-round]', (els) => els.map((e) => e.getAttribute('data-round')));
    await go(a.page, '/menu/orders', '.round', 1500);
    const roundsA = await a.page.$$eval('.round[data-round]', (els) => els.map((e) => e.getAttribute('data-round')));
    c.ok(roundsB.length > 0 && JSON.stringify([...roundsB].sort()) === JSON.stringify([...roundsA].sort()), `both phones show the same table rounds (A ${roundsA.join(',')} / B ${roundsB.join(',')})`);
    const mineB = await b.page.$$eval('.round', (els) => els.filter((e) => /this device|เครื่องนี้/.test(e.textContent ?? '')).length);
    c.ok(mineB === 0, 'phone B marks no round as ordered on this device');
    await shot(b.page, 'e02-track-en-390');
    await go(a.page, '/menu/bill', '#main', 1500);
    await go(b.page, '/menu/bill', '#main', 1500);
    const billA = await fetchIn(a.page, 'GET', '/api/guest/bill');
    const billB = await fetchIn(b.page, 'GET', '/api/guest/bill');
    c.ok(billA.status === 200 && JSON.stringify(billA.data) === JSON.stringify(billB.data), 'both phones get the same table bill');
    const totalA = await a.page.evaluate(() => (document.querySelector('#main')?.textContent ?? '').match(/฿[\d,]+/g)?.slice(-1)[0]);
    const totalB = await b.page.evaluate(() => (document.querySelector('#main')?.textContent ?? '').match(/฿[\d,]+/g)?.slice(-1)[0]);
    c.ok(Boolean(totalA) && totalA === totalB, `the same bill total on both screens (${totalA} / ${totalB})`);
    await shot(a.page, 'e03-bill-th-390', { full: true });
    await shot(b.page, 'e04-bill-en-390', { full: true });
    await go(a.page, '/menu/cart', '#main', 1200);
    c.ok((await textOf(a.page, '#main')).includes('หมูย่าง'), 'phone A keeps its own draft');
    state.guestA = await saveGuest(a.page);
    cleanRun(c, a, b);
  } catch (err) {
    await failed(c, err, a, b);
  } finally {
    await a.dispose();
    await b.dispose();
  }
  return c;
}

// ============================================================ f
export async function journeyF(state: State, item: Item): Promise<Check> {
  const c = new Check('f');
  const staff = await open('staff', { as: 'staff:kitchen', lang: 'en', w: 1440 });
  await staff.page.evaluate(() => localStorage.setItem('rg.orders.station', JSON.stringify('all')));
  const guest = await guestFrom('guestA', state.guestA);
  try {
    if (!state.table || !state.visitId || !state.orderId) throw new Error('journey a did not place an order');
    await go(staff.page, '/admin/orders', '.ob', 1500);
    if (state.portionOrderId) {
      const sel = `article[data-order="${state.portionOrderId}"]`;
      for (const label of ['Accept', 'Start preparing', 'Almost done', 'Mark ready']) {
        if (!(await staff.page.$(sel))) break;
        await click(staff.page, sel, label).catch((e) => c.info(`skip ${label}: ${(e as Error).message}`));
        await sleep(900);
      }
    }
    // The floor serves everything from the board.
    await signInAs(staff.page, 'floor');
    await go(staff.page, '/admin/orders', '.ob', 1500);
    await shot(staff.page, 'f01-board-ready-en-1440');
    for (const id of [state.orderId, state.portionOrderId].filter(Boolean) as string[]) {
      const sel = `article[data-order="${id}"]`;
      if (await staff.page.$(sel)) await click(staff.page, sel, 'Mark served');
      await sleep(1200);
    }
    const api = await staffApi('manager');
    const unserved = (await tableOrders(api, state.visitId)).flatMap((o) => o.lines).filter((l) => !['served', 'rejected', 'cancelled'].includes(l.status));
    c.ok(unserved.length === 0, `every dish is served (${unserved.map((l) => l.status).join(',') || 'none left'})`);
    await go(guest.page, '/menu/orders', '.round', 1500);
    await shot(guest.page, 'f02-track-served-th-390');

    // The cashier settles and completes checkout.
    await signInAs(staff.page, 'cashier');
    await go(staff.page, `/admin/tables/${state.table.id}`, '.drawer, dialog[open]', 2500);
    await shot(staff.page, 'f03-drawer-dining-en-1440');
    const foot = '.drawer__foot, dialog[open] .sheet__foot';
    const confirmDialog = async () => { await confirmTopDialog(staff.page); await sleep(1500); };
    await click(staff.page, foot, 'Start checkout');
    await shot(staff.page, 'f04-start-dialog-en-1440');
    await confirmDialog();
    const blocked = await fetchIn<{ error?: { code: string } }>(guest.page, 'POST', '/api/guest/orders', { lines: [{ item_id: item('grilled-pork').id, quantity: 1, modifiers: [] }], idempotency_key: `e2e_billing_${Date.now()}`, expected_subtotal_minor: 39000 });
    c.ok(blocked.status >= 400 && blocked.status < 500, `ordering is blocked while the bill is prepared (${blocked.status} ${blocked.data?.error?.code})`);
    await click(staff.page, foot, 'Finalise bill');
    await confirmDialog();
    await shot(staff.page, 'f05-finalised-en-1440');
    const bill = await api<{ current_revision: { total_minor: number } | null }>('GET', `/api/staff/visits/${state.visitId}/bill`);
    const total = bill.current_revision?.total_minor ?? 0;
    c.info(`bill total ${total / 100}`);
    await click(staff.page, foot, 'Record payment');
    await sleep(500);
    const received = Math.ceil(total / 100 / 1000) * 1000 + (total % 100000 === 0 ? 500 : 0);
    await staff.page.evaluate(() => {
      const d = [...document.querySelectorAll('dialog[open]')].pop();
      const radios = Array.from(d?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []);
      radios.find((x) => /cash/i.test(x.value) || /Cash/.test(x.closest('label')?.textContent ?? ''))?.click();
    });
    await staff.page.type('dialog[open] input[inputmode="decimal"]', String(received));
    await sleep(500);
    c.ok(/Change/i.test(await textOf(staff.page, 'dialog[open]')), 'the payment dialog shows the change due');
    await shot(staff.page, 'f06-payment-en-1440');
    await confirmDialog();
    await shot(staff.page, 'f07-paid-en-1440');
    await click(staff.page, foot, 'Complete checkout');
    await shot(staff.page, 'f08-complete-dialog-en-1440');
    await confirmDialog();
    await sleep(1500);
    await shot(staff.page, 'f09-after-checkout-en-1440');
    const t = (await api<{ tables: Tile[] }>('GET', '/api/staff/tables')).tables.find((x) => x.id === state.table!.id)!;
    c.ok(t.state === 'available' && !t.visit, `the table is Available again (${t.state})`);
    await go(staff.page, '/admin/tables', '.tgrid', 1500);
    const tile = await textOf(staff.page, `[data-table-id="${t.id}"]`);
    c.ok(/Available|Free/i.test(tile), `the tile shows Available (${tile.split('\n').slice(0, 3).join(' / ')})`);
    await shot(staff.page, 'f10-grid-available-en-1440');

    // The connected guest gets the calm ended screen, live.
    await guest.page.waitForFunction(() => /ขอบคุณ/.test(document.querySelector('#main')?.textContent ?? ''), { timeout: 15_000 }).catch(() => {});
    await sleep(1000);
    const ended = await textOf(guest.page, '#main');
    c.ok(/ขอบคุณ/.test(ended), `the guest sees the visit-ended screen (${ended.replace(/\s+/g, ' ').slice(0, 90)})`);
    await shot(guest.page, 'f11-ended-th-390');
    const drafts = await guest.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('rg.cart.') || k.startsWith('rg.submit.')));
    c.ok(drafts.length === 0, `the closed visit's draft is cleared from the phone (${drafts.join(', ')})`);
    const attempt = await fetchIn<{ error?: { code: string } }>(guest.page, 'POST', '/api/guest/orders', { lines: [{ item_id: item('grilled-pork').id, quantity: 1, modifiers: [] }], idempotency_key: `e2e_after_${Date.now()}`, expected_subtotal_minor: 39000 });
    c.ok(attempt.status === 401 || attempt.status === 410, `the old guest cookie cannot order (${attempt.status} ${attempt.data?.error?.code})`);
    c.ok((await tableOrders(api, state.visitId)).length === 0, 'no active rounds are left for the closed visit');
    // The same printed QR now asks for the next party's PIN (no visit yet).
    await guest.page.goto(`${env.base}/q/${state.token}`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const rescan = await textOf(guest.page, '#main');
    c.ok(!/หมูย่าง|Grilled Pork/.test(rescan), 'rescanning the QR shows nothing from the previous party');
    await shot(guest.page, 'f12-rescan-no-visit-th-390');
    cleanRun(c, guest, staff);
  } catch (err) {
    await failed(c, err, guest, staff);
  } finally {
    await staff.dispose();
    await guest.dispose();
  }
  return c;
}

// ============================================================ g
async function headerSwitch(page: Page, to: 'th' | 'en') {
  await page.evaluate((l) => {
    const b = document.querySelector<HTMLButtonElement>(`.mast .seg--lang button[lang="${l}"]`) ?? document.querySelector<HTMLButtonElement>('.mast .langswitch');
    b?.click();
  }, to);
  await sleep(700);
}

export async function journeyG(state: State, item: Item): Promise<Check> {
  const c = new Check('g');
  const guest = await open('guestG', { as: 'guest:08', lang: 'th', w: 390 });
  try {
    await go(guest.page, '/menu', '.dish', 1500);
    await clearSearch(guest.page);
    await click(guest.page, '.toolrow', 'เครื่องดื่ม');
    await sleep(800);
    const latte = item('latte');
    await guest.page.$eval(`[data-item="${latte.id}"]`, (e) => e.scrollIntoView({ block: 'center' }));
    await sleep(800);
    const y0 = await guest.page.evaluate(() => Math.round(window.scrollY));
    await guest.page.$eval(`[data-item="${latte.id}"] .dish__open`, (e) => (e as HTMLElement).click());
    await guest.page.waitForSelector('dialog.sheet[open]', { timeout: 8000 });
    await sleep(500);
    await click(guest.page, 'dialog.sheet[open]', 'เย็น');
    await click(guest.page, 'dialog.sheet[open]', 'Balanced Blend');
    await guest.page.click('dialog.sheet[open] .sheet__foot .stepper button:last-of-type');
    await guest.page.type('dialog.sheet[open] textarea', 'ไม่ใส่น้ำตาล', { delay: 10 });
    await guest.page.$eval('dialog.sheet[open] .sheet__body', (b) => { b.scrollTop = 0; });
    await shot(guest.page, 'g01-sheet-th-390');
    const before = await guest.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).innerText.replace(/\s+/g, ' '));
    const sw = await guest.page.$('dialog.sheet[open] .langswitch');
    c.ok(Boolean(sw), 'the dish sheet offers a language switch');
    await sw?.click();
    await sleep(900);
    await shot(guest.page, 'g02-sheet-en-390');
    c.ok(Boolean(await guest.page.$('dialog.sheet[open]')), 'the sheet stays open after switching to English');
    const after = await guest.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).innerText.replace(/\s+/g, ' '));
    c.ok(/Add to order/i.test(after) && after.includes('220'), `the add button is English with the same total (${before} -> ${after})`);
    const checked = await guest.page.$$eval('dialog.sheet[open] input[type="radio"]:checked', (els) => els.map((e) => (e.closest('label') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? ''));
    c.ok(checked.some((x) => /Iced/.test(x)) && checked.some((x) => /Balanced/.test(x)), `selected options kept (${checked.join(' | ')})`);
    c.ok((await guest.page.$eval('dialog.sheet[open] textarea', (e) => (e as HTMLTextAreaElement).value)) === 'ไม่ใส่น้ำตาล', 'the note is kept exactly as typed');
    const qty = await guest.page.$eval('dialog.sheet[open] .sheet__foot .stepper', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '));
    c.ok(/2/.test(qty), `quantity kept (${qty})`);
    c.ok(await guest.page.evaluate(() => Boolean(document.activeElement?.closest('dialog[open]'))), 'focus stays inside the sheet');
    await guest.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).click());
    await sleep(900);
    const y1 = await guest.page.evaluate(() => Math.round(window.scrollY));
    c.ok(Math.abs(y1 - y0) < 40, `menu scroll position kept (${y0} -> ${y1})`);
    const group = await guest.page.evaluate(() => document.querySelector('.toolrow .seg button[aria-pressed="true"]')?.textContent);
    c.ok(group === 'Drinks', `the Drinks group is still selected (${group})`);
    await shot(guest.page, 'g03-menu-en-390');

    // Mid-cart.
    await go(guest.page, '/menu/cart', '#main', 1500);
    const totalEn = (await textOf(guest.page, '#main')).match(/฿[\d,]+/g)?.slice(-1)[0];
    await guest.page.evaluate(() => window.scrollTo(0, 200));
    await sleep(300);
    const cy0 = await guest.page.evaluate(() => Math.round(window.scrollY));
    await headerSwitch(guest.page, 'th');
    const cartTh = await textOf(guest.page, '#main');
    const totalTh = cartTh.match(/฿[\d,]+/g)?.slice(-1)[0];
    const cy1 = await guest.page.evaluate(() => Math.round(window.scrollY));
    c.ok(cartTh.includes('ไม่ใส่น้ำตาล') && cartTh.includes('Latte') && Boolean(totalEn) && totalEn === totalTh, `the draft and its total survive the switch (${totalEn} / ${totalTh})`);
    c.ok(Math.abs(cy1 - cy0) < 40, `cart scroll kept (${cy0} -> ${cy1})`);
    c.ok(cartTh.includes(cartDict.th['cart.title'] ?? 'รายการ') || /รายการ/.test(cartTh), 'the order page now reads in Thai');
    await shot(guest.page, 'g04-cart-th-390');

    // Send it, then switch while tracking.
    await guest.page.$eval('[data-testid="cart-send"]', (b) => (b as HTMLElement).click());
    await guest.page.waitForFunction(() => location.search.includes('step=review'), { timeout: 10_000 });
    await sleep(1200);
    await guest.page.$eval('[data-testid="submit-place"]', (b) => (b as HTMLElement).click());
    await guest.page.waitForFunction(() => location.pathname === '/menu/orders', { timeout: 20_000 });
    await sleep(2500);
    await guest.page.evaluate(() => window.scrollTo(0, 500));
    await sleep(400);
    const ty0 = await guest.page.evaluate(() => Math.round(window.scrollY));
    const roundsOf = () => guest.page.$$eval('.round[data-round]', (els) => els.map((e) => `${e.getAttribute('data-round')}:${e.getAttribute('data-status')}`));
    const rounds0 = await roundsOf();
    const session0 = await fetchIn<{ visit?: { id: string } }>(guest.page, 'GET', '/api/guest/session');
    await headerSwitch(guest.page, 'en');
    const ty1 = await guest.page.evaluate(() => Math.round(window.scrollY));
    const rounds1 = await roundsOf();
    const tag1 = await guest.page.$eval('.tabletag__n', (e) => e.textContent);
    c.ok(JSON.stringify(rounds0) === JSON.stringify(rounds1) && rounds1.length > 0, `rounds unchanged by the switch (${rounds1.join(',')})`);
    c.ok(tag1 === '08', 'still table 08');
    c.ok(Math.abs(ty1 - ty0) < 40, `Track scroll kept (${ty0} -> ${ty1})`);
    c.ok(/Round/.test(await textOf(guest.page, '#main')), 'Track reads in English');
    const session1 = await fetchIn<{ visit?: { id: string } }>(guest.page, 'GET', '/api/guest/session');
    c.ok(session1.status === 200 && JSON.stringify(session1.data?.visit) === JSON.stringify(session0.data?.visit), 'the same visit session is still valid');
    await shot(guest.page, 'g05-track-en-390');
    state.guestG = await saveGuest(guest.page);
    cleanRun(c, guest);
  } catch (err) {
    await failed(c, err, guest);
  } finally {
    await guest.dispose();
  }
  return c;
}

// ============================================================ h
/** Poll the public config until guest ordering is (or is not) enabled. */
async function orderingEnabledIs(enabled: boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cfg = (await (await fetch(`${env.base}/api/public/config`)).json()) as { ordering?: { enabled?: boolean } };
    if (cfg.ordering?.enabled === enabled) return true;
    await sleep(400);
  }
  return false;
}

export async function journeyH(state: State, item: Item): Promise<Check> {
  const c = new Check('h');
  const owner = await open('owner', { as: 'staff:owner', lang: 'en', w: 1440 });
  const guest = await guestFrom('guestG', state.guestG);
  let paused = false;
  let api: StaffApi | null = null;
  try {
    api = await staffApi('owner');
    await go(owner.page, '/admin/stats/orders?period=week', 'main', 3500);
    const stats = await textOf(owner.page, 'main');
    c.ok(/week/i.test(stats) && !/went wrong|could not load/i.test(stats), 'Order Stats opens on this week');
    c.ok(Boolean(await owner.page.$('main svg, main [role="img"], main figure')), 'the weekly chart renders');
    await shot(owner.page, 'h01-order-stats-en-1440');
    await go(owner.page, '/admin/stats/menu', 'main', 3500);
    c.ok(/Prime Rib|Striploin|Grilled/.test(await textOf(owner.page, 'main')), 'Menu Stats ranks dishes');
    await shot(owner.page, 'h02-menu-stats-en-1440');
    await go(owner.page, '/admin/stats/engagement', 'main', 3500);
    const en = await textOf(owner.page, 'main');
    c.ok(/active/i.test(en) && !/went wrong/i.test(en), 'Engagement renders');
    await shot(owner.page, 'h03-engagement-en-1440');

    // Annual archive: a provisional PDF for this year.
    await go(owner.page, '/admin/reports', 'main', 2500);
    await shot(owner.page, 'h04-reports-en-1440');
    type Years = { years: Array<{ year: number; jobs?: Array<{ id: string; status: string }> }> };
    const before = await api<Years>('GET', '/api/staff/reports/years');
    const known = new Set(before.years.flatMap((y) => (y.jobs ?? []).map((j) => j.id)));
    const gen = await owner.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll<HTMLButtonElement>('main button')).find((x) => /Generate/i.test(x.textContent ?? '') && /Provisional/i.test(x.textContent ?? '') && !x.disabled);
      b?.scrollIntoView({ block: 'center' });
      b?.click();
      return b?.textContent ?? null;
    });
    c.ok(Boolean(gen), `a Generate provisional report button (${gen})`);
    await sleep(900);
    if (await owner.page.$('dialog[open]')) {
      await shot(owner.page, 'h05-generate-dialog-en-1440');
      await confirmTopDialog(owner.page);
    }
    let job: { id: string; status: string } | undefined;
    for (let i = 0; i < 150; i++) {
      const years = await api<Years>('GET', '/api/staff/reports/years');
      job = years.years.flatMap((y) => y.jobs ?? []).find((j) => !known.has(j.id));
      if (job && !['queued', 'generating', 'running'].includes(job.status)) break;
      await sleep(2000);
    }
    c.ok(job?.status === 'ready', `the PDF job finished (${job?.status})`);
    await sleep(3500);
    const rep = await textOf(owner.page, 'main');
    c.ok(/Provisional/.test(rep) && /Download/i.test(rep), 'the archive lists the provisional file with a download');
    await shot(owner.page, 'h06-reports-done-en-1440');
    if (job?.status === 'ready') {
      const dl = await owner.page.evaluate(async (id) => {
        const r = await fetch(`/api/staff/reports/jobs/${id}/download`);
        const buf = new Uint8Array(await r.arrayBuffer());
        return { status: r.status, type: r.headers.get('content-type'), head: String.fromCharCode(...buf.slice(0, 5)), size: buf.length };
      }, job.id);
      c.ok(dl.status === 200 && dl.head === '%PDF-' && dl.size > 10_000, `the download is a real PDF (${dl.status}, ${dl.type}, ${dl.size} bytes)`);
    }

    // Pause guest ordering from Settings.
    await go(owner.page, '/admin/settings', 'main', 2500);
    await shot(owner.page, 'h07-settings-en-1440');
    await go(guest.page, '/menu/cart', '#main', 1200);
    if (!/หมูย่าง/.test(await textOf(guest.page, '#main'))) {
      await go(guest.page, '/menu', '.dish', 1200);
      await clearSearch(guest.page);
      await click(guest.page, '.toolrow', 'อาหาร');
      await sleep(600);
      await quickAdd(guest.page, item('grilled-pork').id);
      await sleep(1500);
      await go(guest.page, '/menu/cart', '#main', 1200);
    }
    const inOrdering = `(() => {
      const h = Array.from(document.querySelectorAll('main h2, main h3')).find((x) => /^Ordering$/i.test((x.textContent ?? '').trim()));
      return h?.closest('section') ?? null;
    })()`;
    await owner.page.evaluate(`${inOrdering}?.scrollIntoView({ block: 'start' })`);
    await sleep(500);
    await shot(owner.page, 'h08-settings-ordering-en-1440');
    const toggled = await owner.page.evaluate(`(() => { const sw = ${inOrdering}?.querySelector('[role="switch"], input[type="checkbox"]'); sw?.click(); return Boolean(sw); })()`);
    c.ok(toggled === true, 'the Guest ordering switch is turned off');
    await sleep(500);
    await owner.page.evaluate(`Array.from(${inOrdering}?.querySelectorAll('button') ?? []).find((x) => /^Save/i.test((x.textContent ?? '').trim()))?.click()`);
    await owner.page.waitForSelector('dialog[open]', { timeout: 8000 });
    await shot(owner.page, 'h10-pause-confirm-en-1440');
    await confirmTopDialog(owner.page);
    paused = await orderingEnabledIs(false);
    c.ok(paused, 'the public config says ordering is paused');
    await shot(owner.page, 'h11-paused-en-1440');
    const guestBlocked = await guest.page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="cart-send"]') as HTMLButtonElement | null;
      return Boolean(b && (b.disabled || b.getAttribute('aria-disabled') === 'true'));
    }, { timeout: 15_000 }).then(() => true).catch(() => false);
    c.ok(guestBlocked, 'the guest cannot send, without reloading');
    c.ok(/หยุดรับ|พักรับ|พัก/.test(await textOf(guest.page, 'body')), 'the guest sees the pause message');
    c.ok(/หมูย่าง/.test(await textOf(guest.page, '#main')), 'the draft is kept while paused');
    await shot(guest.page, 'h12-guest-paused-th-390');
    const refused = await fetchIn<{ error?: { code: string } }>(guest.page, 'POST', '/api/guest/orders', { lines: [{ item_id: item('grilled-pork').id, quantity: 1, modifiers: [] }], idempotency_key: `e2e_pause_${Date.now()}`, expected_subtotal_minor: 39000 });
    c.ok(refused.data?.error?.code === 'ordering_paused', `the server refuses new orders while paused (${refused.status} ${refused.data?.error?.code})`);

    // Resume from the Overview header.
    await go(owner.page, '/admin', 'main', 2500);
    await shot(owner.page, 'h13-overview-paused-en-1440');
    await click(owner.page, 'body', /^Resume/);
    await owner.page.waitForSelector('dialog[open] .sheet__foot button', { timeout: 8000 });
    await sleep(600);
    await shot(owner.page, 'h14-resume-dialog-en-1440');
    await confirmTopDialog(owner.page);
    const resumed = await orderingEnabledIs(true);
    paused = !resumed;
    c.ok(resumed, 'ordering resumed from the Overview header');
    const guestFree = await guest.page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="cart-send"]') as HTMLButtonElement | null;
      return Boolean(b && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    }, { timeout: 15_000 }).then(() => true).catch(() => false);
    c.ok(guestFree, 'the guest can send again, without reloading');
    await shot(guest.page, 'h15-guest-resumed-th-390');
    cleanRun(c, guest, owner);
  } catch (err) {
    await failed(c, err, guest, owner);
  } finally {
    if (paused) {
      // Never leave the instance paused for the journeys that follow.
      if (api) await api('PATCH', '/api/staff/ordering', { enabled: true, reason: 'e2e cleanup' }).catch((e) => c.info(`resume failed: ${(e as Error).message}`));
    }
    await owner.dispose();
    await guest.dispose();
  }
  return c;
}

// ============================================================ realtime (scenario 12)
export async function journeyRealtime(_state: State, item: Item): Promise<Check> {
  const c = new Check('realtime');
  // The board talks to the app through a proxy that can cut only the live channel.
  const proxy = await startCutProxy(env.base);
  let staff: Sess | null = null;
  let guest: Sess | null = null;
  try {
    staff = await open('board', { as: 'staff:manager', lang: 'en', w: 1440, base: proxy.base });
    guest = await open('guestR', { as: 'guest:11', lang: 'en', w: 390 });
    await go(staff.page, '/admin/orders', '.ob', 1500, proxy.base);
    await staff.page.waitForSelector('.conn[data-state="live"]', { timeout: 15_000 });
    c.ok(true, 'the board is live');

    proxy.cut(true);
    const down = await staff.page.waitForSelector('.conn:not([data-state="live"])', { timeout: 30_000 }).then(() => true).catch(() => false);
    c.ok(down, `the board shows its live channel is down (${await staff.page.$eval('.conn', (e) => e.getAttribute('data-state')).catch(() => '?')})`);
    const ordersOk = await fetchIn(staff.page, 'GET', '/api/staff/orders?scope=active');
    c.ok(ordersOk.status === 200, 'plain HTTP from the board still works');
    // Let the client exhaust its stream retries and fall back to (cut) polling.
    await sleep(15_000);
    await shot(staff.page, 'rt01-board-cut-en-1440');

    // A guest orders over its own working connection.
    await go(guest.page, '/menu', '.dish', 1500);
    const sent = await fetchIn<{ id?: string; order?: { id: string } }>(guest.page, 'POST', '/api/guest/orders', {
      lines: [{ item_id: item('corn-rib').id, quantity: 2, modifiers: [] }],
      idempotency_key: `e2e_rt_${Date.now()}`,
      expected_subtotal_minor: 30000,
    });
    const orderId = sent.data?.order?.id ?? sent.data?.id;
    c.ok((sent.status === 201 || sent.status === 200) && Boolean(orderId), `the guest order is accepted over HTTP (${sent.status})`);
    await sleep(6000);
    const sel = `article[data-order="${orderId}"]`;
    c.ok(!(await staff.page.$(sel)), 'while the channel is cut, the board has not been told about the new round');
    c.ok(await staff.page.$eval('.conn', (e) => e.getAttribute('data-state') !== 'live').catch(() => false), 'the board still says it is not live');

    // Restore the channel: the board must catch up by itself.
    proxy.cut(false);
    const t0 = Date.now();
    const appeared = await staff.page.waitForSelector(sel, { timeout: 30_000 }).then(() => true).catch(() => false);
    c.ok(appeared, `the new round appears once the channel returns (${((Date.now() - t0) / 1000).toFixed(1)} s, polling every 5 s)`);
    const live = await staff.page.waitForSelector('.conn[data-state="live"]', { timeout: 30_000 }).then(() => true).catch(() => false);
    c.ok(live, 'the board says it is live again');
    c.ok((await staff.page.$$(sel)).length === 1, 'the round is shown once');
    await shot(staff.page, 'rt02-board-caught-up-en-1440');
    cleanRun(c, guest, staff);
  } catch (err) {
    await failed(c, err, ...[guest, staff].filter((x): x is Sess => x !== null));
  } finally {
    await staff?.dispose();
    await guest?.dispose();
    await proxy.close();
  }
  return c;
}

// ============================================================ offline guest (brief 30)
export async function journeyOffline(_state: State, item: Item): Promise<Check> {
  const c = new Check('offline');
  const guest = await open('guestO', { as: 'guest:02', lang: 'en', w: 390 });
  try {
    await go(guest.page, '/menu', '.dish', 1500);
    await quickAdd(guest.page, item('french-fries').id);
    await sleep(1200);
    await go(guest.page, '/menu/cart', '#main', 1500);
    const canSend = () => guest.page.$eval('[data-testid="cart-send"]', (b) => !((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true')).catch(() => null);
    c.ok((await canSend()) === true, 'sending is possible while online');
    await guest.page.setOfflineMode(true);
    await sleep(2500);
    const text = await textOf(guest.page, 'body');
    const offlineCopy = [cartDict.en['cart.check.offline'], cartDict.en['cart.hint.offline']];
    c.ok(offlineCopy.some((t) => text.includes(t)), 'the order page explains there is no connection');
    c.ok((await canSend()) === false, 'sending is blocked while offline');
    c.ok(/French Fries/.test(text), 'the draft is kept');
    await shot(guest.page, 'off01-cart-offline-en-390');
    await guest.page.setOfflineMode(false);
    const back = await guest.page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="cart-send"]') as HTMLButtonElement | null;
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    }, { timeout: 30_000 }).then(() => true).catch(() => false);
    c.ok(back, 'sending returns with the connection, and nothing was sent automatically');
    await shot(guest.page, 'off02-cart-online-en-390');
    // Leave the table as we found it: the draft only lives on this phone.
    cleanRun(c, guest);
  } catch (err) {
    await failed(c, err, guest);
  } finally {
    await guest.dispose();
  }
  return c;
}

// ============================================================ shell
export async function journeyShell(opts: { gallery: boolean } = { gallery: true }): Promise<Check> {
  const c = new Check('shell');
  if (opts.gallery) {
    // The /ui-kit gallery exists in development only (D-CI-02).
    const g = await open('gallery', { lang: 'en', w: 1440 });
    try {
      await g.page.goto(`${env.base}/ui-kit`, { waitUntil: 'domcontentloaded' });
      await sleep(4000);
      const txt = await g.page.evaluate(() => document.body.innerText.slice(0, 200));
      c.ok(txt.length > 50, 'the development UI gallery renders');
      cleanRun(c, g);
    } catch (err) {
      await failed(c, err, g);
    } finally { await g.dispose(); }
  }

  const m = await open('manager', { as: 'staff:manager', lang: 'en', w: 1440 });
  try {
    await go(m.page, '/admin/menu/review', 'main', 2500);
    const t = await m.page.evaluate(() => document.querySelector('main')?.textContent ?? '');
    c.ok(!/permission|can.t open/i.test(t.slice(0, 300)) && /Work to review|Imported records/.test(t), 'a manager opens the menu review queue');
    const verify = await m.page.evaluate(() => Array.from(document.querySelectorAll('main button')).filter((b) => /^Verify/.test((b.textContent ?? '').trim())).length);
    c.ok(verify === 0, `a manager sees no Verify actions (${verify})`);
    await shot(m.page, 'sh01-manager-review-en-1440');
    await go(m.page, '/admin/orders', '.ob', 1500);
    const tabs = await m.page.evaluate(() => Array.from(document.querySelectorAll('.subtabs a, .subtabs [role=tab]')).map((a) => a.textContent?.trim()));
    c.ok(tabs.some((x) => x?.startsWith('History')), `Orders has a History subtab (${tabs.join(', ')})`);
    await m.page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('.subtabs a')).find((a) => a.textContent?.startsWith('History'))?.click());
    await sleep(2000);
    const cur = await m.page.evaluate(() => ({ url: location.search, current: document.querySelector('.subtabs [aria-current="page"]')?.textContent }));
    c.ok(cur.url.includes('view=history') && Boolean(cur.current?.startsWith('History')), 'History is the current subtab');
    await m.page.goBack();
    await sleep(1500);
    const back = await m.page.evaluate(() => ({ url: location.pathname + location.search, current: document.querySelector('.subtabs [aria-current="page"]')?.textContent }));
    c.ok(back.url === '/admin/orders' && Boolean(back.current?.startsWith('Board')), `browser Back returns to Board (${back.url})`);
    cleanRun(c, m);
  } catch (err) {
    await failed(c, err, m);
  } finally { await m.dispose(); }

  const p = await open('p320', { as: 'guest:07', lang: 'th', w: 320, h: 640 });
  try {
    await go(p.page, '/menu', '.dish', 2500);
    const btn = await p.page.evaluate(() => { const b = document.querySelector<HTMLElement>('.mast .langswitch'); return b ? { tab: b.tabIndex, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height } : null; });
    c.ok(btn !== null && btn.tab === 0 && btn.h >= 44, `the 320 px masthead has one reachable 44 px language button (${JSON.stringify(btn)})`);
    const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    c.ok(overflow <= 0, `no horizontal scroll at 320 px (${overflow})`);
    await shot(p.page, 'sh02-menu-th-320');
    await p.page.$eval('.dish .dish__open', (e) => { e.scrollIntoView({ block: 'center' }); (e as HTMLElement).focus(); (e as HTMLElement).click(); });
    await p.page.waitForSelector('dialog.sheet[open]');
    const focusIn = await p.page.waitForFunction(() => Boolean(document.activeElement?.closest('dialog[open]')), { timeout: 3000 }).then(() => true).catch(() => false);
    const focused = await p.page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName}.${a.className} ${a.getAttribute('aria-label') ?? ''}` : 'none'; });
    c.ok(focusIn, `the sheet opens with focus inside it (${focused})`);
    await shot(p.page, 'sh03-sheet-th-320');
    await p.page.goBack();
    await sleep(800);
    const closed = !(await p.page.$('dialog.sheet[open]'));
    const path = await p.page.evaluate(() => location.pathname);
    c.ok(closed && path === '/menu', `browser Back closes the sheet and stays on the menu (${path})`);
    const focusBack = await p.page.evaluate(() => document.activeElement?.className ?? '');
    c.ok(/dish__open/.test(focusBack), `focus returns to the dish (${focusBack})`);
    await p.page.keyboard.press('Tab');
    cleanRun(c, p);
  } catch (err) {
    await failed(c, err, p);
  } finally { await p.dispose(); }
  return c;
}

// ============================================================ dev server exposure (D-DT-01)
/**
 * `npm run dev` binds Vite to the network for phone testing. It must serve the
 * browser app and nothing else: no database, report files or server source.
 * Probes real files (a missing file just gets the app's index.html) from
 * localhost and from the first LAN address, as a phone would.
 */
export async function devServerExposure(base: string, lanBase: string | null, root: string, dbFile: string): Promise<Check> {
  const c = new Check('dev-files');
  const fsPath = (p: string) => `/@fs/${p.replace(/\\/g, '/')}`;
  const probe = async (b: string, path: string) => {
    try {
      const r = await fetch(b + path, { signal: AbortSignal.timeout(10_000) });
      const body = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, head: String.fromCharCode(...body.slice(0, 15)) };
    } catch (err) {
      return { status: 0, head: (err as Error).message };
    }
  };
  const secrets: Array<[string, string]> = [
    ['the instance database', fsPath(dbFile)],
    ['the instance database with ?raw', `${fsPath(dbFile)}?raw`],
    ['the instance database with ?import', `${fsPath(dbFile)}?import`],
    ['the database WAL file', fsPath(`${dbFile}-wal`)],
    ['server/config.ts', fsPath(join(root, 'server/config.ts'))],
    ['server/config.ts with ?raw', `${fsPath(join(root, 'server/config.ts'))}?raw`],
    ['scripts/dev.ts', fsPath(join(root, 'scripts/dev.ts'))],
    ['package.json', fsPath(join(root, 'package.json'))],
    ['.env.example', fsPath(join(root, '.env.example'))],
    ['data-src/catalog.json', fsPath(join(root, 'data-src/catalog.json'))],
  ];
  for (const b of [base, lanBase].filter(Boolean) as string[]) {
    for (const [label, path] of secrets) {
      const r = await probe(b, path);
      c.ok(r.status === 403, `${b} refuses ${label} (${r.status})`);
      if (r.head.startsWith('SQLite format')) c.ok(false, `${b} served SQLite bytes for ${label}`);
    }
    const shared = await probe(b, fsPath(join(root, 'shared/money.ts')));
    c.ok(shared.status === 200, `${b} still serves shared/ to the client (${shared.status})`);
    const fonts = await probe(b, fsPath(join(root, 'node_modules/@fontsource-variable/oswald/index.css')));
    c.ok(fonts.status === 200, `${b} still serves the self-hosted fonts (${fonts.status})`);
  }
  if (lanBase) {
    const apiPort = Number(new URL(base).port) + 1;
    const lanApi = await probe(lanBase.replace(/:\d+$/, `:${apiPort}`), '/api/health');
    c.ok(lanApi.status === 0, `the API port ${apiPort} is not reachable from the network (${lanApi.status || 'refused'})`);
  } else {
    c.info('no LAN address on this computer: only localhost was probed');
  }
  return c;
}

// ============================================================ production exposure (D-S8-09)
/** The production build serves the app, but not its source maps or made-up asset paths. */
export async function productionExposure(base: string, root: string): Promise<Check> {
  const c = new Check('prod-files');
  const { readdirSync, readFileSync } = await import('node:fs');
  const { brotliDecompressSync } = await import('node:zlib');
  const { get } = await import('node:http');
  const assets = readdirSync(join(root, 'dist', 'assets'));
  const map = assets.find((f) => f.endsWith('.js.map'));
  const js = assets.find((f) => f.endsWith('.js'));
  const status = async (path: string) => (await fetch(base + path, { signal: AbortSignal.timeout(10_000) })).status;
  // fetch() negotiates and decodes compression itself; node:http shows the bytes on the wire.
  const wire = (path: string, acceptEncoding: string) => new Promise<{ status: number; encoding: string; body: Buffer }>((done, fail) => {
    const req = get(base + path, { headers: { 'Accept-Encoding': acceptEncoding }, timeout: 10_000 }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => done({ status: res.statusCode ?? 0, encoding: String(res.headers['content-encoding'] ?? ''), body: Buffer.concat(parts) }));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${path}`)));
    req.on('error', fail);
  });
  if (js) c.ok((await status(`/assets/${js}`)) === 200, `a built bundle is served (${js})`);
  // npm run build precompresses the bundles (scripts/precompress.ts); the server picks the sibling.
  const packed = assets.find((f) => f.endsWith('.js') && assets.includes(`${f}.br`));
  if (packed) {
    const plain = readFileSync(join(root, 'dist', 'assets', packed));
    const br = await wire(`/assets/${packed}`, 'br, gzip');
    c.ok(br.status === 200 && br.encoding === 'br' && brotliDecompressSync(br.body).equals(plain),
      `a bundle is sent from its precompressed Brotli copy (${packed}: ${plain.length} -> ${br.body.length} bytes)`);
    const identity = await wire(`/assets/${packed}`, 'identity');
    c.ok(identity.status === 200 && identity.encoding === '' && identity.body.equals(plain), 'a browser that accepts no compression gets the plain bundle');
  } else {
    c.info('no precompressed bundles in dist/assets (built without scripts/precompress.ts)');
  }
  if (map) c.ok((await status(`/assets/${map}`)) === 404, `its source map is not served (${map})`);
  else c.info('the build wrote no source maps');
  c.ok((await status(`/assets/${js ? js.replace(/\.js$/, '') : 'x'}-missing.js`)) === 404, 'a missing bundle is a 404, not the app page');
  c.ok((await status('/menu')) === 200, 'the guest menu page is served');
  c.ok((await status('/ui-kit')) !== 500, 'the development gallery route does not break the server');
  return c;
}
