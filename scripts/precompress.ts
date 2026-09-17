// `npm run build` step 2: precompress the hashed bundles in dist/assets.
//
// The production server serves `x.js.br` / `x.js.gz` in place of `x.js` when
// the browser accepts that encoding (server/app.ts, serveStatic
// `precompressed`), so phones on restaurant Wi-Fi get maximum-ratio Brotli
// without the server compressing on every request. Without these files the
// server still gzips on the fly (D-S8-09); this step is an optimisation only.
//
// Only text assets above 1 KB are compressed (fonts, images and WebP are
// already compressed), and a sibling is kept only when it is smaller.
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { ROOT } from './env.ts';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const ASSETS = join(ROOT, 'dist', 'assets');
const TEXT = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.txt', '.html']);
const MIN_BYTES = 1024;

let files: string[];
try {
  files = readdirSync(ASSETS, { recursive: true, encoding: 'utf8' }).map((f) => join(ASSETS, f));
} catch {
  console.error('[precompress] dist/assets not found: run "vite build" first.');
  process.exit(1);
}

let raw = 0;
let br = 0;
let gzTotal = 0;
let count = 0;
const started = Date.now();
await Promise.all(files.map(async (file) => {
  if (!TEXT.has(extname(file)) || !statSync(file).isFile()) return;
  const body = readFileSync(file);
  // A stale sibling from an earlier build must never outlive its source's content.
  rmSync(`${file}.br`, { force: true });
  rmSync(`${file}.gz`, { force: true });
  if (body.length < MIN_BYTES) return;
  const [b, g] = await Promise.all([
    brotli(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    }),
    gz(body, { level: 9 }),
  ]);
  count++;
  raw += body.length;
  if (b.length < body.length) { writeFileSync(`${file}.br`, b); br += b.length; } else br += body.length;
  if (g.length < body.length) { writeFileSync(`${file}.gz`, g); gzTotal += g.length; } else gzTotal += body.length;
}));

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(`[precompress] ${count} files, ${kb(raw)} -> brotli ${kb(br)}, gzip ${kb(gzTotal)} (${Date.now() - started} ms)`);
