// Visual QA set (brief 31, 43; DESIGN §14): `npm run shots`.
//
//   npm run shots                                  seeded throwaway instance, every set
//   npm run shots -- guest staff                   only these sets (guest, states, staff, narrow, stats)
//   npm run shots -- --base http://localhost:8344  use a running instance (it gets new orders and visits)
//   npm run shots -- --port 8771 --keep --strict
//
// Writes test/visual/out/<set>/*.png, test/visual/out/index.html (a contact
// sheet to review side by side with design-lab/final/*.png) and
// test/visual/out/report.json.
//
// Every capture is also audited in the page (DESIGN §14): horizontal
// overflow, Thai text with letter-spacing or line-height under 1.5, text
// smaller than 13 px (guest) or 12 px (staff), and visible controls smaller
// than 44 px. Page errors, missing translation keys and horizontal overflow
// fail the run; the other audit findings fail it only with --strict.
// Screenshots are evidence for a person to review, not a pixel diff.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Page } from 'puppeteer-core';
import { startInstance, ROOT, type Instance } from '../e2e/instance.ts';
import { joinWithPin } from '../e2e/journeys.ts';
import { click, configure, env, go, i18nMissing, menuItems, open, qrToken, sleep, staffApi, type Sess, type StaffApi } from '../e2e/lib.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const valueArgs = new Set(['--base', '--port', '--out'].flatMap((n) => { const i = args.indexOf(n); return i > -1 ? [args[i + 1]] : []; }));
const SETS = ['guest', 'states', 'staff', 'narrow', 'stats'] as const;
const wanted = new Set(args.filter((a) => !a.startsWith('--') && !valueArgs.has(a)));
const want = (s: (typeof SETS)[number]) => wanted.size === 0 || wanted.has(s);
const OUT = resolve(ROOT, opt('out') ?? 'test/visual/out');

interface Shot { set: string; name: string; file: string; findings: string[] }
const shots: Shot[] = [];
const hard: string[] = [];

// ------------------------------------------------------------------ audit
async function audit(page: Page, kind: 'guest' | 'staff'): Promise<{ overflow: string | null; findings: string[] }> {
  return page.evaluate((minText: number) => {
    const out: string[] = [];
    const doc = document.documentElement;
    const overflow = doc.scrollWidth > doc.clientWidth + 1 ? `horizontal overflow ${doc.scrollWidth} > ${doc.clientWidth}` : null;
    // Thai letters and marks; the baht sign (U+0E3F) alone does not make a string Thai.
    const THAI = /[ก-ฺเ-๛]/;
    const modal = [...document.querySelectorAll('dialog[open]')].pop() ?? null;
    const describe = (el: Element) => (typeof (el as HTMLElement).className === 'string' && (el as HTMLElement).className) || el.tagName;
    /** Does a click at (x, y) land on el (or inside it)? Hit areas widened by padding or pseudo-elements count. */
    const hits = (el: Element, x: number, y: number) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true; // cannot sample off-screen; give the benefit of the doubt
      const at = document.elementFromPoint(x, y);
      return Boolean(at && (at === el || el.contains(at) || at.contains(el)));
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (modal && !modal.contains(el)) continue; // the page behind a modal is inert
      const rect = el.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue; // collapsed or screen-reader-only
      if (el.closest('.visually-hidden, .sr, .sr-only, [aria-hidden="true"], svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0 || cs.clipPath !== 'none') continue;
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent!.trim()).map((n) => n.textContent!.trim()).join(' ');
      if (own) {
        const size = parseFloat(cs.fontSize);
        // Printed QR cards are sized for paper, not for the screen rules.
        const onPrintCard = Boolean(el.closest('[class*="qrcard"]'));
        if (size < minText - 0.01 && !onPrintCard) out.push(`text ${size}px < ${minText}px: "${own.slice(0, 24)}" (${describe(el)})`);
        if (THAI.test(own)) {
          const lh = cs.lineHeight === 'normal' ? 1.6 : parseFloat(cs.lineHeight) / size;
          if (cs.letterSpacing !== 'normal' && parseFloat(cs.letterSpacing) !== 0) out.push(`Thai letter-spacing: "${own.slice(0, 24)}" (${describe(el)})`);
          if (lh < 1.5) out.push(`Thai line-height ${lh.toFixed(2)}: "${own.slice(0, 24)}" (${describe(el)})`);
        }
      }
      if (el.matches('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"]')) {
        if (rect.bottom <= 0 || rect.top >= innerHeight) continue;
        if (el.matches('input[type="radio"], input[type="checkbox"]')) continue; // their label is the target
        // Links inside running text are exempt (WCAG 2.5.8 inline exception).
        if (el.tagName === 'A' && cs.display === 'inline') continue;
        const box = (el.closest('label') ?? el).getBoundingClientRect();
        if (box.width >= 43.5 && box.height >= 43.5) continue;
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const tallEnough = box.height >= 43.5 || (hits(el, cx, cy - 21) && hits(el, cx, cy + 21));
        const wideEnough = box.width >= 43.5 || (hits(el, cx - 21, cy) && hits(el, cx + 21, cy));
        if (tallEnough && wideEnough) continue;
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 20);
        out.push(`target ${Math.round(box.width)}x${Math.round(box.height)} (hit area checked): "${label}" (${describe(el)})`);
      }
    }
    return { overflow, findings: [...new Set(out)].slice(0, 12) };
  }, kind === 'guest' ? 13 : 12);
}

async function snap(s: Sess, set: string, name: string, kind: 'guest' | 'staff', opts: { full?: boolean } = {}) {
  await s.page.evaluate(() => document.fonts.ready);
  await sleep(300);
  const dir = join(OUT, set);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  await s.page.screenshot({ path: file, fullPage: Boolean(opts.full) });
  const a = await audit(s.page, kind);
  if (a.overflow) hard.push(`${set}/${name}: ${a.overflow}`);
  shots.push({ set, name, file, findings: [...(a.overflow ? [a.overflow] : []), ...a.findings] });
  console.log(`  ${set}/${name}${a.overflow || a.findings.length ? `  (${[a.overflow, ...a.findings].filter(Boolean).length} audit notes)` : ''}`);
}

function closeOut(s: Sess, label: string) {
  const miss = [...new Set(i18nMissing(s))];
  if (miss.length) hard.push(`${label}: missing translation keys ${miss.join('; ')}`);
  if (s.errors.length) hard.push(`${label}: page errors ${s.errors.join(' | ').slice(0, 400)}`);
}

async function clearDraft(page: Page) {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('rg.cart.') || k.startsWith('rg.submit.') || k.startsWith('rg.menu') || k.startsWith('rg.search')) localStorage.removeItem(k);
    sessionStorage.clear();
  });
}

interface Tile { id: string; label: string; state: string }

// ------------------------------------------------------------------ guest
async function guestSet(owner: StaffApi, item: Awaited<ReturnType<typeof menuItems>>, lang: 'th' | 'en', w: number, h: number) {
  const tag = `${lang}-${w}`;
  const set = 'guest';
  const s = await open(`guest-${tag}`, { as: 'guest:07', lang, w, h });
  try {
    await clearDraft(s.page);
    await go(s.page, '/menu', '.dish', 1200);
    await snap(s, set, `menu-toast-${tag}`, 'guest');
    await sleep(2500);
    await s.page.evaluate(() => window.scrollTo(0, 0));
    await snap(s, set, `menu-${tag}`, 'guest');
    if (w <= 400) await snap(s, set, `menu-full-${tag}`, 'guest', { full: true });
    const all = await s.page.$('.catrow__all');
    if (all && await all.evaluate((e) => (e as HTMLElement).offsetParent !== null)) {
      await all.click();
      await s.page.waitForSelector('dialog[open]', { timeout: 6000 }).catch(() => {});
      await sleep(600);
      await snap(s, set, `categories-${tag}`, 'guest');
      await s.page.keyboard.press('Escape');
      await sleep(500);
    }
    await s.page.$eval(`[data-item="${item('australian-striploin').id}"] .dish__open`, (e) => { e.scrollIntoView({ block: 'center' }); (e as HTMLElement).click(); });
    await s.page.waitForSelector('dialog.sheet[open]', { timeout: 8000 });
    await sleep(700);
    await snap(s, set, `item-sheet-${tag}`, 'guest');
    // Required choice missing: try to add without choosing (when the dish asks for one).
    await s.page.$eval('[data-testid="item-commit"]', (b) => (b as HTMLElement).click());
    await sleep(900);
    if (await s.page.$('dialog.sheet[open]')) {
      await snap(s, set, `item-sheet-required-${tag}`, 'guest');
      await s.page.keyboard.press('Escape');
      await sleep(500);
    }
    await s.page.$eval(`[data-item="${item('grilled-pork').id}"] .dish__foot button`, (x) => { x.scrollIntoView({ block: 'center' }); (x as HTMLElement).click(); });
    await sleep(500);
    await snap(s, set, `menu-first-item-${tag}`, 'guest');
    await sleep(1200);
    await go(s.page, '/menu/cart', '#main', 1800);
    await snap(s, set, `cart-${tag}`, 'guest');
    const send = await s.page.$('[data-testid="cart-send"]');
    if (send && await send.evaluate((b) => !(b as HTMLButtonElement).disabled)) {
      await send.click();
      await s.page.waitForFunction(() => location.search.includes('step=review'), { timeout: 10_000 }).catch(() => {});
      await sleep(1500);
      await snap(s, set, `cart-review-${tag}`, 'guest');
    } else {
      hard.push(`guest ${tag}: Send order was not available`);
    }
    await clearDraft(s.page);
    await go(s.page, '/menu/orders', '#main', 2500);
    await snap(s, set, `track-${tag}`, 'guest');
    await snap(s, set, `track-full-${tag}`, 'guest', { full: true });
    await go(s.page, '/menu/bill', '#main', 2500);
    await snap(s, set, `bill-${tag}`, 'guest');
    await click(s.page, w >= 1080 ? '.mast' : 'body', w >= 1080 ? /บริการ|Service/ : /^บริการ$|^Service$/).catch(async () => {
      await s.page.evaluate(() => document.querySelector<HTMLButtonElement>('.svckey')?.click());
    });
    await s.page.waitForSelector('dialog[open]', { timeout: 6000 }).catch(() => {});
    await sleep(700);
    await snap(s, set, `service-${tag}`, 'guest');
    await s.page.keyboard.press('Escape');
    // Offline: the Track page with no network.
    await go(s.page, '/menu/orders', '#main', 1500);
    await s.page.setOfflineMode(true);
    await sleep(2500);
    await snap(s, set, `track-offline-${tag}`, 'guest');
    await s.page.setOfflineMode(false);
    closeOut(s, `guest ${tag}`);
  } finally {
    await s.dispose();
  }
  // First scan: a phone that has not joined yet.
  const j = await open(`join-${tag}`, { lang, w, h });
  try {
    const t07 = (await owner<{ tables: Tile[] }>('GET', '/api/staff/tables')).tables.find((t) => t.label === '07')!;
    await j.page.goto(`${env.base}/q/${await qrToken(owner, t07.id)}`, { waitUntil: 'domcontentloaded' });
    await j.page.waitForSelector('.vpin__input', { timeout: 15_000 });
    await sleep(1200);
    await snap(j, set, `join-${tag}`, 'guest');
    await j.page.type('.vpin__input', '0000', { delay: 40 });
    await j.page.$eval('.vjoin__card button[type="submit"]', (b) => (b as HTMLButtonElement).click()).catch(() => {});
    await sleep(1500);
    await snap(j, set, `join-wrong-pin-${tag}`, 'guest');
    await go(j.page, '/menu', '.dish', 1500);
    await snap(j, set, `browse-only-${tag}`, 'guest');
    closeOut(j, `join ${tag}`);
  } finally {
    await j.dispose();
  }
}

// ------------------------------------------------------------------ guest states
async function statesSet(owner: StaffApi, lang: 'th' | 'en', w: number) {
  const tag = `${lang}-${w}`;
  const set = 'states';
  const free = (await owner<{ tables: Tile[] }>('GET', '/api/staff/tables')).tables.filter((x) => x.state === 'available' && x.label !== '12');
  const t = free[0];
  if (!t) { hard.push('states: no free table'); return; }
  const token = await qrToken(owner, t.id);
  // No open visit at this table.
  const n = await open(`novisit-${tag}`, { lang, w });
  try {
    await n.page.goto(`${env.base}/q/${token}`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await snap(n, set, `no-visit-${tag}`, 'guest');
    await n.page.goto(`${env.base}/q/not-a-real-token-000000000000`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await snap(n, set, `bad-link-${tag}`, 'guest');
    closeOut(n, `states ${tag}`);
  } finally { await n.dispose(); }

  // Join, then staff close the visit (zero bill): the ended screen arrives live.
  const v = await owner<{ id: string }>('POST', `/api/staff/tables/${t.id}/visits`, { covers: 2, idempotency_key: `shots_${t.id}_${Date.now()}` });
  const detail = await owner<{ join_pin: string | null; version: number }>('GET', `/api/staff/visits/${v.id}`);
  const s = await open(`ended-${tag}`, { lang, w });
  try {
    await s.page.goto(`${env.base}/q/${token}`, { waitUntil: 'domcontentloaded' });
    await joinWithPin(s.page, detail.join_pin!);
    await go(s.page, '/menu/cart', '#main', 1500);
    await snap(s, set, `cart-empty-${tag}`, 'guest');
    await go(s.page, '/menu/orders', '#main', 2000);
    await snap(s, set, `track-empty-${tag}`, 'guest');
    await owner('POST', `/api/staff/visits/${v.id}/billing/start`, { version: detail.version });
    await sleep(2000);
    await go(s.page, '/menu/bill', '#main', 2000);
    await snap(s, set, `bill-preparing-${tag}`, 'guest');
    const bill = await owner<{ bill_version: number; running_total_minor?: number; total_minor: number }>('GET', `/api/staff/visits/${v.id}/bill`);
    await owner('POST', `/api/staff/visits/${v.id}/bill/finalize`, { bill_version: bill.bill_version, expected_total_minor: bill.running_total_minor ?? bill.total_minor });
    await owner('POST', `/api/staff/visits/${v.id}/checkout`, { idempotency_key: `shots_co_${Date.now()}` });
    const ended = await s.page.waitForFunction(() => /ขอบคุณ|Thank you/.test(document.querySelector('#main')?.textContent ?? ''), { timeout: 15_000 }).then(() => true).catch(() => false);
    if (!ended) hard.push(`states ${tag}: the ended screen did not appear live`);
    await sleep(1200);
    await snap(s, set, `visit-ended-${tag}`, 'guest');
    closeOut(s, `ended ${tag}`);
  } finally { await s.dispose(); }
}

// ------------------------------------------------------------------ staff
async function staffSet(owner: StaffApi, item: Awaited<ReturnType<typeof menuItems>>) {
  const set = 'staff';
  const login = await open('login', { lang: 'en', w: 1440 });
  try {
    await go(login.page, '/admin/login', 'form', 1500);
    await snap(login, set, 'login-en-1440', 'staff');
    closeOut(login, 'login');
  } finally { await login.dispose(); }

  const s = await open('owner', { as: 'staff:owner', lang: 'en', w: 1440 });
  try {
    const t07 = (await owner<{ tables: Tile[] }>('GET', '/api/staff/tables')).tables.find((t) => t.label === '07')!;
    const pages: Array<[string, string, string, number?]> = [
      ['overview-en-1440', '/admin', 'main'],
      ['orders-board-en-1440', '/admin/orders', '.ob'],
      ['orders-history-en-1440', '/admin/orders?view=history', 'main'],
      ['requests-en-1440', '/admin/orders/requests', '.rqpage'],
      ['tables-en-1440', '/admin/tables', '.tgrid'],
      ['tables-drawer-en-1440', `/admin/tables/${t07.id}`, '.tgrid', 2500],
      ['menu-availability-en-1440', '/admin/menu', 'main', 2500],
      ['item-editor-en-1440', `/admin/menu/items/${item('prime-rib').id}`, 'main', 2500],
      ['menu-catalog-en-1440', '/admin/menu/catalog', 'main', 2500],
      ['review-queue-en-1440', '/admin/menu/review', 'main', 2500],
      ['payments-en-1440', '/admin/payments', 'main', 2500],
      ['reports-en-1440', '/admin/reports', 'main', 2500],
      ['settings-en-1440', '/admin/settings', 'main', 2500],
      ['team-en-1440', '/admin/team', 'main', 2500],
      ['audit-en-1440', '/admin/audit', 'main', 2500],
      ['more-en-1440', '/admin/more', 'main', 1500],
      ['qr-print-en-1440', `/admin/tables/print?ids=${t07.id}`, 'main', 2500],
    ];
    for (const [name, path, ready, wait] of pages) {
      await go(s.page, path, ready, wait ?? 1800);
      await snap(s, set, name, 'staff');
    }
    await s.page.evaluate(() => localStorage.setItem('rg.lang', 'th'));
    for (const [name, path, ready] of [['orders-board-th-1440', '/admin/orders', '.ob'], ['tables-drawer-th-1440', `/admin/tables/${t07.id}`, '.tgrid'], ['settings-th-1440', '/admin/settings', 'main']] as const) {
      await go(s.page, path, ready, 2500);
      await snap(s, set, name, 'staff');
    }
    await s.page.evaluate(() => localStorage.setItem('rg.lang', 'en'));
    closeOut(s, 'staff owner');
  } finally { await s.dispose(); }

  // Role landing pages.
  for (const role of ['kitchen', 'floor', 'cashier'] as const) {
    const r = await open(role, { as: `staff:${role}`, lang: 'th', w: 1024, h: 768 });
    try {
      await go(r.page, '/admin', 'main', 2500);
      await snap(r, set, `landing-${role}-th-1024`, 'staff');
      closeOut(r, `staff ${role}`);
    } finally { await r.dispose(); }
  }
}

async function narrowSet(owner: StaffApi) {
  const set = 'narrow';
  for (const [w, h] of [[1024, 768], [768, 1024], [390, 844]] as const) {
    for (const lang of ['en', 'th'] as const) {
      const s = await open(`manager-${w}`, { as: 'staff:manager', lang, w, h });
      try {
        const t07 = (await owner<{ tables: Tile[] }>('GET', '/api/staff/tables')).tables.find((t) => t.label === '07')!;
        await go(s.page, '/admin/orders', '.ob', 2200);
        await snap(s, set, `orders-board-${lang}-${w}`, 'staff');
        await go(s.page, '/admin/tables', '.tgrid', 2000);
        await snap(s, set, `tables-${lang}-${w}`, 'staff');
        await go(s.page, `/admin/tables/${t07.id}`, '.tgrid', 2500);
        await snap(s, set, `tables-drawer-${lang}-${w}`, 'staff');
        if (lang === 'en') {
          await go(s.page, '/admin/orders/requests', '.rqpage', 2000);
          await snap(s, set, `requests-${lang}-${w}`, 'staff');
          await go(s.page, '/admin', 'main', 2000);
          await snap(s, set, `overview-${lang}-${w}`, 'staff');
          await go(s.page, '/admin/menu', 'main', 2000);
          await snap(s, set, `menu-availability-${lang}-${w}`, 'staff');
        }
        closeOut(s, `manager ${lang}-${w}`);
      } finally { await s.dispose(); }
    }
  }
}

async function statsSet() {
  const set = 'stats';
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    for (const lang of ['en', 'th'] as const) {
      if (w === 390 && lang === 'th') continue;
      const s = await open(`stats-${w}`, { as: 'staff:owner', lang, w, h });
      try {
        for (const [name, path] of [
          ['order-stats', '/admin/stats/orders'],
          ['order-stats-month', '/admin/stats/orders?period=month'],
          ['order-stats-year', '/admin/stats/orders?period=year'],
          ['menu-stats', '/admin/stats/menu'],
          ['menu-stats-least', '/admin/stats/menu?direction=least'],
          ['engagement', '/admin/stats/engagement'],
        ] as const) {
          await go(s.page, path, 'main', 3500);
          await snap(s, set, `${name}-${lang}-${w}`, 'staff', { full: w === 1440 });
        }
        closeOut(s, `stats ${lang}-${w}`);
      } finally { await s.dispose(); }
    }
  }
}

function contactSheet() {
  const bySet = new Map<string, Shot[]>();
  for (const s of shots) bySet.set(s.set, [...(bySet.get(s.set) ?? []), s]);
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const refs = ['guest-menu', 'guest-menu-sheet', 'guest-menu-service', 'guest-menu-categories', 'guest-menu-toast', 'guest-menu-320', 'guest-menu-tablet', 'guest-menu-desktop', 'guest-track', 'guest-track-offline', 'admin-board', 'admin-board-tablet', 'admin-tables', 'admin-stats'];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual QA</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#f3ecdd;color:#17150f}h2{margin:32px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
figure{margin:0;background:#f8f4ea;border:1px solid #d8ceb8;padding:8px}img{width:100%;height:auto;display:block}
figcaption{margin-top:6px;font-size:12px;word-break:break-all}ul{margin:4px 0 0 16px;padding:0;color:#6e1621;font-size:12px}</style></head><body>
<h1>Rabbit Grill ordering: visual QA</h1><p>${esc(env.base)} · ${new Date().toISOString()} · ${shots.length} captures · compare with the reference mocks below.</p>
${[...bySet].map(([set, list]) => `<h2>${esc(set)}</h2><div class="grid">${list.map((s) => `<figure><a href="${esc(relative(OUT, s.file).replace(/\\/g, '/'))}"><img loading="lazy" src="${esc(relative(OUT, s.file).replace(/\\/g, '/'))}" alt=""></a><figcaption>${esc(s.name)}${s.findings.length ? `<ul>${s.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</figcaption></figure>`).join('')}</div>`).join('\n')}
<h2>reference mocks (design-lab/final)</h2><div class="grid">${refs.map((r) => `<figure><img loading="lazy" src="${esc(relative(OUT, resolve(ROOT, 'design-lab/final', `${r}.png`)).replace(/\\/g, '/'))}" alt=""><figcaption>${r}</figcaption></figure>`).join('')}</div>
</body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
}

// ------------------------------------------------------------------ run
let app: Instance | null = null;
let exitCode = 0;
try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (opt('base')) {
    configure({ base: opt('base')!, out: OUT });
  } else {
    console.log('starting a seeded instance (npm run dev path)...');
    app = await startInstance({ name: 'shots', port: opt('port') ? Number(opt('port')) : undefined, keep: flag('keep') });
    configure({ base: app.base, out: OUT });
    console.log(`instance ${app.base}`);
  }
  const owner = await staffApi('owner');
  const item = await menuItems();
  if (want('guest')) {
    for (const [lang, w, h] of [['th', 320, 640], ['th', 390, 844], ['en', 390, 844], ['en', 768, 1024], ['th', 1440, 900], ['en', 1440, 900]] as const) {
      console.log(`guest ${lang}-${w}`);
      await guestSet(owner, item, lang, w, h);
    }
  }
  if (want('states')) { await statesSet(owner, 'th', 390); await statesSet(owner, 'en', 1440); }
  if (want('staff')) await staffSet(owner, item);
  if (want('narrow')) await narrowSet(owner);
  if (want('stats')) await statsSet();
} catch (err) {
  hard.push(`crashed: ${(err as Error).stack ?? err}`);
} finally {
  const soft = shots.flatMap((s) => s.findings.map((f) => `${s.set}/${s.name}: ${f}`));
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ base: env.base, at: new Date().toISOString(), captures: shots.length, failures: hard, audit: shots.map(({ set, name, findings }) => ({ set, name, findings })) }, null, 2));
  contactSheet();
  await app?.stop();
  console.log(`\n${shots.length} captures in ${OUT} (open index.html)`);
  if (soft.length) console.log(`audit notes (${soft.length}):\n  ${soft.slice(0, 60).join('\n  ')}${soft.length > 60 ? '\n  ... see report.json' : ''}`);
  if (hard.length) console.log(`FAILURES (${hard.length}):\n  ${hard.join('\n  ')}`);
  exitCode = hard.length || (flag('strict') && soft.length) ? 1 : 0;
}
process.exit(exitCode);
