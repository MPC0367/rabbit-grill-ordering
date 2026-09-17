// Visual QA helper: open the app as a guest at a table or as a staff role,
// then screenshot one or more paths. Run from PowerShell (browser launch).
//
//   node scripts/qa-shoot.ts --base http://localhost:8344 --as guest:07 --paths /menu,/menu/cart --out var/scratch/shots
//   node scripts/qa-shoot.ts --base http://localhost:8344 --as staff:owner --w 1440 --h 900 --paths /admin/orders --full
//   options: --lang th|en  --w 390 --h 844  --full  --wait 1200  --dark  --prefix name
//
// Also importable: openSession({ base, as, lang, width, height }) -> { page, dispose }
// for scripted interactions (click, type, wait) before capturing.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { launchBrowser } from './browser.ts';

export const DEMO_PASSWORD = (role: string) => `rabbit-${role}-demo`;
export const DEMO_USERNAME = (role: string) => `demo-${role}`;

interface ApiSession { cookie: string }

async function apiLogin(base: string, role: string): Promise<ApiSession> {
  const res = await fetch(`${base}/api/staff/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RG-Client': '1' },
    body: JSON.stringify({ username: DEMO_USERNAME(role), password: DEMO_PASSWORD(role) }),
  });
  if (!res.ok) throw new Error(`login ${role} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { cookie };
}

async function api<T>(base: string, s: ApiSession, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { Cookie: s.cookie, 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-RG-Client': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/** Make sure the table has an open visit and return its QR token and PIN (as the demo owner). */
export async function guestAccess(base: string, tableLabel: string): Promise<{ token: string; pin: string | null; visitId: string }> {
  const owner = await apiLogin(base, 'owner');
  const tables = await api<{ tables: Array<{ id: string; label: string; state: string; visit: { id: string } | null }> }>(base, owner, 'GET', '/api/staff/tables');
  const table = tables.tables.find((t) => t.label === tableLabel);
  if (!table) throw new Error(`no table labelled ${tableLabel}`);
  let visitId = table.visit?.id;
  if (!visitId) {
    const v = await api<{ id: string }>(base, owner, 'POST', `/api/staff/tables/${table.id}/visits`, { covers: 2, idempotency_key: `qa_open_${table.id}_${Date.now()}` });
    visitId = v.id;
  }
  const detail = await api<{ join_pin: string | null }>(base, owner, 'GET', `/api/staff/visits/${visitId}`);
  const cards = await api<{ cards: Array<{ table_id: string; url: string }> }>(base, owner, 'GET', `/api/staff/tables/qr-cards?ids=${table.id}`);
  const url = cards.cards[0].url;
  const token = url.slice(url.lastIndexOf('/q/') + 3);
  return { token, pin: detail.join_pin, visitId };
}

export async function openSession(opts: { base: string; as?: string; lang?: 'th' | 'en'; width?: number; height?: number; dark?: boolean }) {
  const { browser, dispose } = await launchBrowser();
  try {
    return await prepareSession(browser, dispose, opts);
  } catch (err) {
    // A failed sign-in or join must not leave the browser running.
    await dispose();
    throw err;
  }
}

async function prepareSession(browser: Browser, dispose: () => Promise<void>, opts: { base: string; as?: string; lang?: 'th' | 'en'; width?: number; height?: number; dark?: boolean }) {
  const page: Page = await browser.newPage();
  const width = opts.width ?? 390;
  const height = opts.height ?? 844;
  await page.setViewport({ width, height, deviceScaleFactor: width < 700 ? 2 : 1, isMobile: width < 700, hasTouch: width < 700 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }]);
  page.on('pageerror', (e) => console.error('[pageerror]', (e as Error).message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  const lang = opts.lang ?? 'th';
  await page.evaluateOnNewDocument((l) => { try { localStorage.setItem('rg.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto(`${opts.base}/menu`, { waitUntil: 'domcontentloaded' });
  if (opts.as?.startsWith('staff:')) {
    const role = opts.as.slice(6);
    const status = await page.evaluate(async (r, pw) => {
      const res = await fetch('/api/staff/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RG-Client': '1' }, body: JSON.stringify({ username: r, password: pw }) });
      return res.status;
    }, DEMO_USERNAME(role), DEMO_PASSWORD(role));
    if (status !== 200) throw new Error(`browser login failed: ${status}`);
  } else if (opts.as?.startsWith('guest:')) {
    const access = await guestAccess(opts.base, opts.as.slice(6));
    const status = await page.evaluate(async (token, pin) => {
      const res = await fetch('/api/public/qr/join', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RG-Client': '1' }, body: JSON.stringify(pin ? { token, pin } : { token }) });
      return res.status;
    }, access.token, access.pin);
    if (status !== 200 && status !== 201) throw new Error(`browser join failed: ${status}`);
  }
  return { page, browser, dispose };
}

export async function capture(page: Page, base: string, path: string, out: string, opts: { full?: boolean; wait?: number } = {}) {
  await page.goto(base + path, { waitUntil: 'networkidle0', timeout: 45_000 }).catch(async () => {
    // SSE keeps a connection open: fall back to DOM ready + a settle delay.
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, opts.wait ?? 1200));
  await page.screenshot({ path: out, fullPage: Boolean(opts.full) });
  console.log('wrote', out);
}

// ------------------------------------------------------------------ CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (n: string, d?: string) => {
    const i = args.indexOf(`--${n}`);
    return i > -1 ? args[i + 1] : d;
  };
  const base = get('base', 'http://localhost:8344')!;
  const out = resolve(get('out', 'var/scratch/shots')!);
  mkdirSync(out, { recursive: true });
  const paths = (get('paths', '/menu') ?? '/menu').split(',');
  const width = Number(get('w', '390'));
  const height = Number(get('h', '844'));
  const prefix = get('prefix', '');
  const s = await openSession({ base, as: get('as'), lang: get('lang', 'th') as 'th' | 'en', width, height, dark: args.includes('--dark') });
  try {
    for (const p of paths) {
      const name = `${prefix}${p.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-') || 'root'}-${width}.png`;
      await capture(s.page, base, p, join(out, name), { full: args.includes('--full'), wait: Number(get('wait', '1200')) });
    }
  } finally {
    await s.dispose();
  }
}
