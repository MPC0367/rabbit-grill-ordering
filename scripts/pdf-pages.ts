// `npm run pdf:pages -- <file.pdf> [--pages 1-3,40,last | all] [--out <dir>] [--scale 1.5] [--text]`
//
// QA tool: renders PDF pages to PNG so a person (or a reviewer agent) can look
// at the printed annual report itself, not only its print-rendered HTML.
// pdf.js (the pdfjs-dist devDependency) runs inside the installed headless
// Edge/Chrome (scripts/browser.ts). A tiny HTTP server on 127.0.0.1 serves the
// page, the PDF and the pdf.js files; nothing else is served and nothing is
// downloaded. With --text it also writes each page's extracted text (pdf.js
// keeps Thai, which pdftotext drops), for checks such as "is this page Thai".
//
// Output: <out>/p001.png (and p001.txt with --text). Default out:
// var/pdf-pages/<pdf name>/. Default pages: 1-3,last. See docs/TESTING.md.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { launchBrowser } from './browser.ts';
import { ROOT } from './env.ts';

const USAGE = 'usage: npm run pdf:pages -- <file.pdf> [--pages 1-3,40,last | all] [--out <dir>] [--scale 1.5] [--text]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pages: { type: 'string', default: '1-3,last' },
    out: { type: 'string' },
    scale: { type: 'string', default: '1.5' },
    text: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const pdfPath = resolve(positionals[0]);
if (!existsSync(pdfPath) || !statSync(pdfPath).isFile()) {
  console.error(`[pdf-pages] no such file: ${pdfPath}`);
  process.exit(2);
}
const scale = Number(values.scale);
if (!Number.isFinite(scale) || scale <= 0 || scale > 6) {
  console.error('[pdf-pages] --scale must be a number between 0 and 6 (1 = 72 dpi, 1.5 is the default).');
  process.exit(2);
}
const outDir = resolve(values.out ?? join(ROOT, 'var', 'pdf-pages', basename(pdfPath, extname(pdfPath))));

/** "1-3,40,last" or "all" -> sorted unique page numbers within 1..count, plus the ones that were out of range. */
function parsePages(spec: string, count: number): { pages: number[]; outside: string[] } {
  const want = new Set<number>();
  const outside: string[] = [];
  const num = (s: string) => (s === 'last' ? count : s === 'first' ? 1 : Number(s));
  for (const raw of spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (raw === 'all') {
      for (let n = 1; n <= count; n++) want.add(n);
      continue;
    }
    const m = /^(\w+)(?:-(\w+))?$/.exec(raw);
    const from = m ? num(m[1]) : NaN;
    const to = m ? (m[2] ? num(m[2]) : from) : NaN;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new Error(`bad page range "${raw}" (use e.g. 1-3,40,last or all)`);
    }
    for (let n = from; n <= to; n++) {
      if (n <= count) want.add(n);
      else outside.push(String(n));
    }
  }
  return { pages: [...want].sort((a, b) => a - b), outside };
}

// pdf.js files, served from node_modules only (build/ for the library and
// worker, plus the data folders it asks for: CMaps, standard fonts, ICC, wasm).
const PDFJS_ROOT = join(ROOT, 'node_modules', 'pdfjs-dist');
const PDFJS_DIRS = ['build', 'cmaps', 'standard_fonts', 'iccs', 'wasm'];
if (!existsSync(join(PDFJS_ROOT, 'build', 'pdf.mjs'))) {
  console.error('[pdf-pages] pdfjs-dist is not installed. Run "npm ci" (it is a devDependency).');
  process.exit(1);
}

const TYPES: Record<string, string> = {
  '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream', '.json': 'application/json',
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>pdf-pages</title></head>
<body style="margin:0;background:#fff"><canvas id="c"></canvas><script type="module">
import * as pdfjs from '/pdfjs/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
try {
  const doc = await pdfjs.getDocument({
    url: '/doc.pdf',
    cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    iccUrl: '/pdfjs/iccs/', wasmUrl: '/pdfjs/wasm/',
  }).promise;
  window.__count = doc.numPages;
  window.renderPage = async (n, scale, withText) => {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale });
    const canvas = document.getElementById('c');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    let text = null;
    if (withText) {
      const content = await page.getTextContent();
      text = content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\\n' : '') : '')).join('');
    }
    page.cleanup();
    return { png: canvas.toDataURL('image/png'), text, width: canvas.width, height: canvas.height };
  };
  window.__ready = true;
} catch (err) {
  window.__error = String(err && err.message || err);
}
</script></body></html>`;

const pdf = readFileSync(pdfPath);
const server = createServer((req, res) => {
  let path = '';
  try { path = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { /* malformed: 404 below */ }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE); return; }
  if (path === '/doc.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length }).end(pdf); return; }
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const m = /^\/pdfjs\/([a-z_]+)\/(.+)$/.exec(path);
  if (m && PDFJS_DIRS.includes(m[1])) {
    const base = join(PDFJS_ROOT, m[1]);
    const file = normalize(join(base, m[2]));
    if (file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404).end();
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;

let failed = false;
const { browser, dispose } = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { failed = true; console.error('[pdf-pages] page error:', (e as Error).message); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__ready === true || typeof window.__error === "string"', { timeout: 120_000 });
  const openError = (await page.evaluate('window.__error')) as string | undefined;
  if (openError) throw new Error(`pdf.js could not open ${pdfPath}: ${openError}`);
  const count = (await page.evaluate('window.__count')) as number;
  const { pages, outside } = parsePages(values.pages ?? '1-3,last', count);
  console.log(`[pdf-pages] ${pdfPath}: ${count} pages; rendering ${pages.length} at scale ${scale} -> ${outDir}`);
  if (outside.length) console.warn(`[pdf-pages] skipped pages past the end (${count}): ${outside.join(', ')}`);
  mkdirSync(outDir, { recursive: true });
  for (const n of pages) {
    const started = Date.now();
    const r = (await page.evaluate(`window.renderPage(${n}, ${scale}, ${values.text ? 'true' : 'false'})`)) as {
      png: string; text: string | null; width: number; height: number;
    };
    const stem = join(outDir, `p${String(n).padStart(3, '0')}`);
    writeFileSync(`${stem}.png`, Buffer.from(r.png.slice(r.png.indexOf(',') + 1), 'base64'));
    if (r.text !== null) writeFileSync(`${stem}.txt`, r.text, 'utf8');
    console.log(`[pdf-pages] page ${n}: ${r.width}x${r.height} (${Date.now() - started} ms) ${stem}.png${r.text !== null ? ' + .txt' : ''}`);
  }
} catch (err) {
  failed = true;
  console.error(`[pdf-pages] ${(err as Error).message}`);
} finally {
  await dispose();
  server.close();
}
process.exit(failed ? 1 : 0);
