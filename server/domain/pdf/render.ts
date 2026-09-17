// HTML -> PDF with the installed Chromium-family browser (D-15).
// The browser does the layout and pagination, so the Node process only waits
// on it. The page is offline: every request except inline data is refused.
import { rm, writeFile } from 'node:fs/promises';
import { AppError } from '../../lib/errors.ts';

export interface RenderResult { bytes: number; pages: number | null }

/**
 * Best-effort page count of a Chromium-printed PDF (its page dictionaries are
 * not compressed). A native byte search: no copy of a many-megabyte file.
 */
export function countPdfPages(pdf: Uint8Array): number | null {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const needle = Buffer.from('/Type /Page');
  let count = 0;
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + needle.length)) {
    const next = buf[i + needle.length];
    if (!((next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a))) count++; // not "/Pages"
  }
  return count || null;
}

/**
 * Load the browser driver ahead of time. The first import compiles puppeteer
 * synchronously (~100 ms); the job runner calls this shortly after start so
 * the first report of the day does not pause live requests.
 */
export async function preloadPdfRenderer(): Promise<void> {
  await import('../../../scripts/browser.ts');
}

export async function renderPdf(html: string, footerTemplate: string, outFile: string, opts: { tagged: boolean }): Promise<RenderResult> {
  // Loaded lazily: the server should not pay for puppeteer until a report runs.
  const { findBrowser, launchBrowser } = await import('../../../scripts/browser.ts');
  if (!findBrowser()) {
    // Permanent until someone installs a browser or sets BROWSER_PATH: no automatic retries.
    throw new AppError('browser_unavailable', 'No Chrome, Chromium or Edge was found to print the PDF. Set BROWSER_PATH.', { permanent: true });
  }
  let session: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    session = await launchBrowser();
  } catch (err) {
    const reason = (err as Error).message.split('TROUBLESHOOTING')[0].replace(/\s+/g, ' ').trim();
    throw new AppError('browser_unavailable', `The browser could not start: ${reason}`.slice(0, 240), { permanent: false });
  }
  try {
    const page = await session.browser.newPage();
    page.setDefaultTimeout(0);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url === 'about:blank') void req.continue();
      else void req.abort();
    });
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'load', timeout: 0 });
    await page.evaluate('document.fonts.ready.then(() => document.fonts.size)');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate,
      margin: { top: '17mm', right: '15mm', bottom: '17mm', left: '15mm' },
      // Tagged output carries the structure tree screen readers use; the
      // outline (bookmarks per heading) requires it.
      tagged: opts.tagged,
      outline: opts.tagged,
      timeout: 0,
    });
    await writeFile(outFile, pdf);
    return { bytes: pdf.length, pages: countPdfPages(pdf) };
  } finally {
    await closeQuietly(session);
  }
}

/**
 * Close the browser and delete its throwaway profile without blocking the
 * event loop (the shared launcher's dispose() removes the profile with a
 * synchronous rmSync, which stalls live requests for ~100 ms).
 */
async function closeQuietly(session: { browser: import('puppeteer-core').Browser; dispose: () => Promise<void> }): Promise<void> {
  const profileArg = session.browser.process()?.spawnargs.find((a) => a.startsWith('--user-data-dir='));
  if (!profileArg) {
    await session.dispose();
    return;
  }
  const profile = profileArg.slice('--user-data-dir='.length);
  await session.browser.close().catch(() => {});
  // The browser can hold files for a moment after exit; cleanup is best-effort.
  for (let i = 0; i < 5; i++) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
