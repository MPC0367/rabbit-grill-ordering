// Screenshot any URL or local HTML file.
//   node scripts/shot.ts <url|file> <out.png> [--w 390] [--h 844] [--full] [--dark] [--wait 800] [--scroll 0]
// Run from PowerShell (the sandboxed Bash tool cannot start the browser).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.ts';

const args = process.argv.slice(2);
const target = args[0];
const out = args[1];
if (!target || !out) {
  console.error('usage: node scripts/shot.ts <url|file> <out.png> [--w 390] [--h 844] [--full] [--dark] [--wait ms] [--scroll px]');
  process.exit(2);
}
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? Number(args[i + 1]) : dflt;
};
const flag = (name: string) => args.includes(`--${name}`);

const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(resolve(target)).href;
const width = opt('w', 390);
const height = opt('h', 844);

const { browser, dispose } = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: opt('dpr', width < 700 ? 2 : 1), isMobile: width < 700, hasTouch: width < 700 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: flag('dark') ? 'dark' : 'light' }]);
  if (flag('reduced')) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', (e) => console.error('[pageerror]', (e as Error).message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready);
  const scroll = opt('scroll', 0);
  if (scroll) await page.evaluate((y) => window.scrollTo(0, y), scroll);
  await new Promise((r) => setTimeout(r, opt('wait', 600)));
  await page.screenshot({ path: resolve(out), fullPage: flag('full') });
  console.log('wrote', resolve(out));
} finally {
  await dispose();
}
