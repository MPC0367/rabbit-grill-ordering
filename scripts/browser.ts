// Shared headless-browser launcher (PDF reports, e2e journeys, visual QA).
// Uses an installed Chromium-family browser; nothing is downloaded.
// Each launch gets its own throwaway profile: a shared profile makes Edge hand
// the flags to an already-running instance and exit with code 0.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser(): string | null {
  for (const p of CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

export async function launchBrowser(): Promise<{ browser: Browser; dispose: () => Promise<void> }> {
  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error('No Chromium-family browser found. Set BROWSER_PATH to Chrome, Chromium or Edge.');
  }
  const profile = mkdtempSync(join(tmpdir(), 'rg-browser-'));
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profile,
      // Talk over stdio pipes instead of a debugging port: when the Node
      // process dies (even a hard kill mid-report) the pipes close and the
      // browser exits, instead of lingering as an orphan.
      pipe: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--force-color-profile=srgb'],
      timeout: 60_000,
    });
  } catch (err) {
    // A failed launch must not leave its throwaway profile behind.
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
  return {
    browser,
    dispose: async () => {
      await browser.close().catch(() => {});
      // The browser can hold the profile briefly after close; cleanup is best-effort.
      for (let i = 0; i < 5; i++) {
        try { rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
    },
  };
}
