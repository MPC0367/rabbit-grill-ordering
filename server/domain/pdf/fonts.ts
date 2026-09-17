// Self-hosted report fonts, embedded as base64 @font-face rules so the PDF
// never depends on the network or on fonts installed on the server. Thai text
// always renders with Noto Sans Thai (its Thai subset carries the baht sign).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

interface Face { family: string; pkg: string; file: string; weight: string; range: string }

// unicode-range values copied from the @fontsource-variable CSS for each subset.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const THAI = 'U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC';

// Oswald and Cormorant are Latin-only faces. Each stack falls back to the
// embedded Noto Sans Thai before the generic family, so Thai text and the
// baht sign inside display-styled elements (KPI labels and values, the cover
// badge, table headers, group rows, tags) never fall through to a font
// installed on the server (Tahoma on Windows, tofu boxes where none exists).
export const FONT = {
  sans: "'RG Sans'",
  display: "'RG Display', 'RG Sans'",
  serif: "'RG Serif', 'RG Sans'",
} as const;

const FACES: Face[] = [
  { family: 'RG Sans', pkg: '@fontsource-variable/noto-sans-thai', file: 'noto-sans-thai-thai-wght-normal.woff2', weight: '100 900', range: THAI },
  { family: 'RG Sans', pkg: '@fontsource-variable/noto-sans-thai', file: 'noto-sans-thai-latin-wght-normal.woff2', weight: '100 900', range: LATIN },
  { family: 'RG Sans', pkg: '@fontsource-variable/noto-sans-thai', file: 'noto-sans-thai-latin-ext-wght-normal.woff2', weight: '100 900', range: LATIN_EXT },
  { family: 'RG Display', pkg: '@fontsource-variable/oswald', file: 'oswald-latin-wght-normal.woff2', weight: '200 700', range: LATIN },
  { family: 'RG Serif', pkg: '@fontsource-variable/cormorant-garamond', file: 'cormorant-garamond-latin-wght-normal.woff2', weight: '300 700', range: LATIN },
];

let cached: string | null = null;
const dataUris = new Map<string, string>();

function fontDataUri(pkg: string, file: string): string {
  const key = `${pkg}/${file}`;
  let uri = dataUris.get(key);
  if (!uri) {
    const dir = dirname(require.resolve(`${pkg}/package.json`));
    uri = `data:font/woff2;base64,${readFileSync(join(dir, 'files', file)).toString('base64')}`;
    dataUris.set(key, uri);
  }
  return uri;
}

/** @font-face rules for the whole report. */
export function fontFaceCss(): string {
  if (cached) return cached;
  cached = FACES.map((f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:block;`
    + `src:url(${fontDataUri(f.pkg, f.file)}) format('woff2');unicode-range:${f.range};}`).join('\n');
  return cached;
}

/** Only the Latin display face, for the page footer template (kept small: it repeats per page). */
export function footerFontCss(): string {
  return `@font-face{font-family:'RG Display';font-weight:200 700;src:url(${fontDataUri('@fontsource-variable/oswald', 'oswald-latin-wght-normal.woff2')}) format('woff2');}`;
}
