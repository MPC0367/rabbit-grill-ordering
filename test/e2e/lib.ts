// Browser helpers shared by the end-to-end journeys and the visual set.
// Sessions come from scripts/qa-shoot.ts (installed Edge/Chrome, a throwaway
// profile per session). Run from a normal desktop shell: the browser has to be
// able to start.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { openSession } from '../../scripts/qa-shoot.ts';

export const env = { base: 'http://localhost:8344', out: 'test/e2e/out' };

export function configure(opts: { base: string; out: string }) {
  env.base = opts.base.replace(/\/+$/, '');
  env.out = opts.out;
  mkdirSync(env.out, { recursive: true });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ soft checks
/**
 * Collects every check in a journey, so one failure still reports the rest.
 * run.ts fails the test with the list in `failures`.
 */
export class Check {
  readonly name: string;
  readonly lines: string[] = [];
  readonly failures: string[] = [];
  constructor(name: string) { this.name = name; }
  ok(cond: unknown, msg: string): boolean {
    const line = `${cond ? 'ok  ' : 'FAIL'} ${msg}`;
    this.lines.push(line);
    console.log(`  [${this.name}] ${line}`);
    if (!cond) this.failures.push(msg);
    return Boolean(cond);
  }
  info(msg: string) {
    this.lines.push(`..   ${msg}`);
    console.log(`  [${this.name}] ..   ${msg}`);
  }
  get pass() { return this.failures.length === 0; }
}

// ------------------------------------------------------------------ sessions
export interface Sess { page: Page; dispose: () => Promise<void>; errors: string[]; warnings: string[]; name: string }

export async function open(name: string, opts: { as?: string; lang?: 'th' | 'en'; w?: number; h?: number; dark?: boolean; base?: string } = {}): Promise<Sess> {
  const s = await openSession({ base: opts.base ?? env.base, as: opts.as, lang: opts.lang ?? 'th', width: opts.w ?? 390, height: opts.h ?? (opts.w && opts.w > 700 ? 900 : 844), dark: opts.dark });
  const errors: string[] = [];
  const warnings: string[] = [];
  s.page.on('pageerror', (e) => errors.push((e as Error).message));
  s.page.on('console', (m) => {
    const text = m.text();
    // Refused requests (401/403/409...) are expected in several journeys.
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_|status of 4\d\d/.test(text)) errors.push(text.slice(0, 300));
    if (m.type() === 'warn') warnings.push(text.slice(0, 300));
  });
  return { page: s.page, dispose: s.dispose, errors, warnings, name };
}

export function i18nMissing(...sessions: Sess[]): string[] {
  return sessions.flatMap((s) => s.warnings.filter((w) => w.includes('[i18n] missing key')));
}

/** The two checks every journey ends with. */
export function cleanRun(c: Check, ...sessions: Sess[]) {
  const missing = i18nMissing(...sessions);
  c.ok(missing.length === 0, `no missing translation keys${missing.length ? ` (${[...new Set(missing)].join('; ').slice(0, 300)})` : ''}`);
  const errors = sessions.flatMap((s) => s.errors.map((e) => `${s.name}: ${e}`));
  c.ok(errors.length === 0, `no page errors${errors.length ? ` (${errors.join(' | ').slice(0, 400)})` : ''}`);
}

export interface Saved { cookies: Array<{ name: string; value: string; domain: string; path: string }>; storage: Record<string, string> }

export async function saveGuest(page: Page): Promise<Saved> {
  const cookies = (await page.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  const storage = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(localStorage)) out[k] = localStorage.getItem(k) ?? '';
    for (const k of Object.keys(sessionStorage)) out[`__session__${k}`] = sessionStorage.getItem(k) ?? '';
    return out;
  });
  return { cookies, storage };
}

/** Put a saved guest (cookies + storage) into a fresh browser, as the same phone. */
export async function restoreGuest(page: Page, saved: Saved) {
  await page.setCookie(...saved.cookies);
  await page.evaluate((st) => {
    for (const [k, v] of Object.entries(st)) {
      if (k.startsWith('__session__')) sessionStorage.setItem(k.slice(11), v);
      else localStorage.setItem(k, v);
    }
  }, saved.storage);
}

// ------------------------------------------------------------------ navigation
export async function go(page: Page, path: string, ready = '#main', wait = 900, base = env.base) {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ready, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(wait);
}

export async function shot(page: Page, name: string, opts: { full?: boolean; dir?: string } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(300);
  const dir = opts.dir ?? env.out;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: Boolean(opts.full) });
  return file;
}

/** Click the first visible button/link/label whose text or aria-label matches. */
export async function click(page: Page, scope: string, text: string | RegExp, opts: { nth?: number; exact?: boolean } = {}) {
  const res = await page.evaluate((sel: string, pat: string, isRe: boolean, nth: number, exact: boolean) => {
    const re = isRe ? new RegExp(pat) : null;
    const hits: HTMLElement[] = [];
    for (const r of Array.from(document.querySelectorAll(sel))) {
      for (const b of Array.from(r.querySelectorAll<HTMLElement>('button, a, [role=button], [role=menuitem], [role=menuitemradio], label, summary'))) {
        if (b.offsetParent === null && getComputedStyle(b).position !== 'fixed') continue;
        const txt = (b.textContent ?? '').replace(/\s+/g, ' ').trim();
        const name = b.getAttribute('aria-label') ?? '';
        const m = re ? (re.test(txt) || re.test(name)) : exact ? (txt === pat || name === pat) : (txt.includes(pat) || name.includes(pat));
        if (m) hits.push(b);
      }
    }
    const el = hits[nth];
    if (!el) return `none of ${hits.length}`;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'ok';
  }, scope, typeof text === 'string' ? text : text.source, typeof text !== 'string', opts.nth ?? 0, Boolean(opts.exact));
  if (res !== 'ok') throw new Error(`click "${text}" in ${scope}: ${res}`);
  await sleep(400);
}

/** Press the last (primary) footer button of the top-most open dialog. */
export async function confirmTopDialog(page: Page) {
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('dialog[open]')].pop();
    const btns = d?.querySelectorAll<HTMLButtonElement>('.sheet__foot button');
    btns?.[btns.length - 1]?.click();
  });
}

export async function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => Array.from(document.querySelectorAll(s)).map((e) => (e as HTMLElement).innerText).join('\n'), sel);
}

export async function fetchIn<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  return page.evaluate(async (m, p, b) => {
    const res = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', ...(m !== 'GET' ? { 'X-RG-Client': '1' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }, method, path, body as never) as Promise<{ status: number; data: T }>;
}

export type StaffApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** A node-side client signed in as a demo role. */
export async function staffApi(role: string): Promise<StaffApi> {
  const res = await fetch(`${env.base}/api/staff/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RG-Client': '1' },
    body: JSON.stringify({ username: `demo-${role}`, password: `rabbit-${role}-demo` }),
  });
  if (!res.ok) throw new Error(`login ${role}: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(env.base + path, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-RG-Client': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

/** Switch a staff browser to another demo role. */
export async function signInAs(page: Page, role: string) {
  await fetchIn(page, 'POST', '/api/staff/auth/logout');
  const r = await fetchIn(page, 'POST', '/api/staff/auth/login', { username: `demo-${role}`, password: `rabbit-${role}-demo` });
  if (r.status !== 200) throw new Error(`sign in ${role}: ${r.status}`);
}

/** Count Web Audio oscillators so "the board stayed silent" can be asserted. */
export async function instrumentAudio(page: Page) {
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as { __tones: number; AudioContext: typeof AudioContext };
    w.__tones = 0;
    const Orig = w.AudioContext;
    if (!Orig) return;
    w.AudioContext = class extends Orig {
      override createOscillator() { w.__tones++; return super.createOscillator(); }
    } as typeof AudioContext;
  });
}

// ------------------------------------------------------------------ menu data
export interface MenuItem { id: string; key: string }
export async function menuItems(): Promise<(key: string) => MenuItem> {
  const menu = (await (await fetch(`${env.base}/api/public/menu`)).json()) as { items: MenuItem[] };
  return (key: string) => {
    const it = menu.items.find((i) => i.key === key);
    if (!it) throw new Error(`no menu item ${key}`);
    return it;
  };
}

export async function qrToken(api: StaffApi, tableId: string): Promise<string> {
  const cards = await api<{ cards: Array<{ url: string }> }>('GET', `/api/staff/tables/qr-cards?ids=${tableId}`);
  const url = cards.cards[0].url;
  return url.slice(url.lastIndexOf('/q/') + 3);
}
