// Dish and atmosphere photo pipeline.
//   node scripts/assets.ts [--force] [--report <file.json>]
//
// Reads the restaurant's own photographs from ../img and writes
//   public/media/dish/<name>-<w>.webp    4:3 cover crops, w = 240 / 480 / 960 (or the
//                                        largest width the source allows, never upscaled)
//   public/media/place/<name>-<w>.webp   atmosphere, natural ratio, w = 960 / 1600 (same rule)
//   public/media/place/<name>-1600.jpg   JPEG twins for the PDF report cover
//   public/media/manifest.json           { dish|place: { <name>: { sizes, w, h } } }
//
// Framing: one crop box is chosen per dish at source resolution and every width is cut
// from that same box, so a srcset swap never re-frames the plate. The box comes from
// scripts/assets.focus.json when the dish has an entry, otherwise from libvips'
// attention strategy.
//
// Idempotent: outputs whose recipe and source are unchanged are skipped (fingerprints in
// node_modules/.cache), stale files are pruned, the manifest is only rewritten on change.
import sharp from 'sharp';
import type { OutputInfo } from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const SRC = resolve(APP, '..', 'img');
const OUT = join(APP, 'public', 'media');
const FOCUS_FILE = join(HERE, 'assets.focus.json');
const CACHE_FILE = join(APP, 'node_modules', '.cache', 'rabbit-grill-assets.json');

const RECIPE = 4; // bump to force a full rebuild when encoding choices change
const RATIO_W = 4;
const RATIO_H = 3;
const DISH_WIDTHS = [240, 480, 960];
const PLACE_WIDTHS = [960, 1600];
const PLACE = ['hero-plate', 'fire-hearth', 'venue-exterior', 'venue-counter', 'venue-pass', 'primerib-board'];
const PLACE_JPEG: Record<string, number> = { 'hero-plate': 1600, 'venue-counter': 1600 };
const NOT_DISH = [/^venue-/, /^fire-/, /^hero-plate$/, /^prep-raw$/, /^apron-portrait$/, /^primerib-board$/, /^plate-ribs$/, /^favicon$/];
// A "largest that fits" size is only worth a file when it is clearly bigger than the last standard one.
const MIN_EXTRA_STEP = 1.25;
// The dish photos were cut out of the menu artwork and some keep a hairline of page paper on an edge;
// every dish is trimmed this much on all sides first (per-photo "inset" overrides, an explicit extract replaces it).
const DISH_INSET = 16;

// WebP: quality ~78; if a dish file lands over its byte budget, step down a little (never below 68).
const DISH_QUALITY = [78, 75, 72, 70, 68];
const PLACE_QUALITY = 78;
const JPEG_QUALITY = 84;
const KB = 1024;
const budgetFor = (w: number) => (w <= 240 ? 20 * KB : w <= 480 ? 60 * KB : 160 * KB);

const GRAVITY = ['centre', 'center', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'] as const;
const STRATEGY = ['attention', 'entropy'] as const;

type Focus = {
  position?: string;
  /** focal point as a fraction of the (extracted) region, 0..1; overrides position */
  x?: number;
  y?: number;
  /** px trimmed from every edge before cropping (default DISH_INSET); ignored when an extract is given */
  inset?: number;
  /** extract before cropping, in source pixels */
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  /** free text, ignored by the script */
  why?: string;
};
type Box = { left: number; top: number; width: number; height: number };
type Output = { rel: string; w: number; h: number; bytes: number; quality: number; cached: boolean };

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const reportAt = args.indexOf('--report');
const REPORT = reportAt > -1 ? resolve(args[reportAt + 1] ?? '') : null;

const t0 = performance.now();

// ---------------------------------------------------------------------------------------------
// inputs

if (!existsSync(SRC)) fail(`source folder not found: ${SRC}`);
const jpgs = readdirSync(SRC).filter((f) => /\.jpe?g$/i.test(f)).map((f) => f.replace(/\.jpe?g$/i, '')).sort();
const dishNames = jpgs.filter((n) => !NOT_DISH.some((re) => re.test(n)));
for (const p of PLACE) if (!jpgs.includes(p)) fail(`atmosphere source missing: ${p}.jpg`);

const focus = readFocus();
for (const name of Object.keys(focus)) {
  if (!dishNames.includes(name)) fail(`assets.focus.json names "${name}", which is not a dish photo in ${SRC}`);
}

const cache: Record<string, string> = FORCE ? {} : readJson(CACHE_FILE, {});
const nextCache: Record<string, string> = {};
const planned = new Set<string>();

mkdirSync(join(OUT, 'dish'), { recursive: true });
mkdirSync(join(OUT, 'place'), { recursive: true });

// ---------------------------------------------------------------------------------------------
// work

const report: Record<string, unknown> = { dish: {}, place: {} };
const manifest: { dish: Record<string, Entry>; place: Record<string, Entry> } = { dish: {}, place: {} };
type Entry = { sizes: number[]; w: number; h: number; jpeg?: number[] };

await pool(dishNames, 4, async (name) => {
  const file = srcPath(name);
  const { box, how } = await planDishCrop(file, focus[name]);
  const widths = pickWidths(DISH_WIDTHS, box.width);
  const outputs: Output[] = [];
  for (const w of widths) {
    const h = (w * RATIO_H) / RATIO_W;
    outputs.push(await emit(`dish/${name}-${w}.webp`, file, { box, w, h, fmt: 'webp' }));
  }
  const top = outputs[outputs.length - 1];
  manifest.dish[name] = { sizes: widths, w: top.w, h: top.h };
  (report.dish as Record<string, unknown>)[name] = { how, box, outputs };
});

await pool(PLACE, 3, async (name) => {
  const file = srcPath(name);
  const { width: sw, height: sh } = await orientedSize(file);
  const widths = pickWidths(PLACE_WIDTHS, sw);
  const outputs: Output[] = [];
  for (const w of widths) {
    const h = Math.round((w * sh) / sw);
    outputs.push(await emit(`place/${name}-${w}.webp`, file, { w, h, fmt: 'webp' }));
  }
  const entry: Entry = { sizes: widths, w: outputs.at(-1)!.w, h: outputs.at(-1)!.h };
  const jw = PLACE_JPEG[name];
  if (jw) {
    const w = Math.min(jw, sw);
    outputs.push(await emit(`place/${name}-${w}.jpg`, file, { w, h: Math.round((w * sh) / sw), fmt: 'jpeg' }));
    entry.jpeg = [w];
  }
  manifest.place[name] = entry;
  (report.place as Record<string, unknown>)[name] = { outputs };
});

// prune anything this run did not plan (renamed dishes, sizes that no longer apply)
let pruned = 0;
for (const dir of ['dish', 'place']) {
  for (const f of readdirSync(join(OUT, dir))) {
    if (!planned.has(`${dir}/${f}`)) {
      rmSync(join(OUT, dir, f), { force: true });
      pruned++;
    }
  }
}

// one entry per line, sorted: stable and easy to diff
const block = (o: Record<string, Entry>) =>
  Object.entries(o)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n');
const manifestText = `{\n  "dish": {\n${block(manifest.dish)}\n  },\n  "place": {\n${block(manifest.place)}\n  }\n}\n`;
const manifestPath = join(OUT, 'manifest.json');
const manifestChanged = !existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestText;
if (manifestChanged) writeFileSync(manifestPath, manifestText);

mkdirSync(dirname(CACHE_FILE), { recursive: true });
writeFileSync(CACHE_FILE, JSON.stringify(nextCache, null, 1));
if (REPORT) {
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------------------------
// summary

const all = [...Object.values(report.dish as Record<string, { outputs: Output[] }>), ...Object.values(report.place as Record<string, { outputs: Output[] }>)].flatMap((r) => r.outputs);
const written = all.filter((o) => !o.cached).length;
const bytes = all.reduce((s, o) => s + o.bytes, 0);
const dishFiles = Object.values(manifest.dish).reduce((s, e) => s + e.sizes.length, 0);
const placeFiles = Object.values(manifest.place).reduce((s, e) => s + e.sizes.length + (e.jpeg?.length ?? 0), 0);
const over = all.filter((o) => o.rel.startsWith('dish/') && o.bytes > budgetFor(o.w)).map((o) => `${o.rel.slice(5)} ${kb(o.bytes)}`);
const overrides = Object.keys(focus).length;
console.log(
  `assets: ${dishNames.length} dishes (${dishFiles} webp, ${overrides} focus overrides) + ${PLACE.length} places (${placeFiles} files)` +
    ` | wrote ${written}, unchanged ${all.length - written}, pruned ${pruned}${manifestChanged ? ', manifest updated' : ''}` +
    ` | ${(bytes / 1024 / 1024).toFixed(2)} MB` +
    (over.length ? ` | over budget: ${over.join(', ')}` : ' | all dish files within budget') +
    ` | ${((performance.now() - t0) / 1000).toFixed(1)}s`,
);

// ---------------------------------------------------------------------------------------------
// helpers

async function planDishCrop(file: string, f: Focus | undefined): Promise<{ box: Box; how: string }> {
  const { width: sw, height: sh } = await orientedSize(file);
  const inset = Math.max(0, int(f?.inset ?? DISH_INSET));
  const region: Box = { left: inset, top: inset, width: sw - 2 * inset, height: sh - 2 * inset };
  if (f && (f.left !== undefined || f.top !== undefined || f.width !== undefined || f.height !== undefined)) {
    region.left = int(f.left ?? 0);
    region.top = int(f.top ?? 0);
    region.width = int(f.width ?? sw - region.left);
    region.height = int(f.height ?? sh - region.top);
    if (region.left < 0 || region.top < 0 || region.width < 1 || region.height < 1 || region.left + region.width > sw || region.top + region.height > sh) {
      fail(`${file}: extract ${JSON.stringify(region)} falls outside the ${sw}x${sh} source`);
    }
  }

  // largest 4:3 box inside the region, width a multiple of 4 so the height is a whole pixel
  const unit = Math.min(Math.floor(region.width / RATIO_W), Math.floor(region.height / RATIO_H));
  const cw = unit * RATIO_W;
  const ch = unit * RATIO_H;
  if (cw < DISH_WIDTHS[0]) fail(`${file}: the crop region is only ${cw}px wide; dish thumbnails need at least ${DISH_WIDTHS[0]}px`);
  const slackX = region.width - cw;
  const slackY = region.height - ch;

  let dx: number;
  let dy: number;
  let how: string;
  if (f && (f.x !== undefined || f.y !== undefined)) {
    const fx = f.x ?? 0.5;
    const fy = f.y ?? 0.5;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) fail(`${file}: focus x/y must be fractions between 0 and 1`);
    dx = clamp(Math.round(fx * region.width - cw / 2), 0, slackX);
    dy = clamp(Math.round(fy * region.height - ch / 2), 0, slackY);
    how = `focus ${fx},${fy}`;
  } else {
    const position = (f?.position ?? 'attention').toLowerCase();
    if ((STRATEGY as readonly string[]).includes(position)) {
      if (slackX === 0 && slackY === 0) {
        dx = 0;
        dy = 0;
      } else {
        // let libvips pick the window at (almost) source scale, then map its offset back
        const { info } = await sharp(file)
          .rotate()
          .extract(region)
          .resize(cw, ch, { fit: 'cover', position: sharp.strategy[position as (typeof STRATEGY)[number]] })
          .raw()
          .toBuffer({ resolveWithObject: true });
        const scale = Math.max(cw / region.width, ch / region.height);
        const i = info as OutputInfo & { cropOffsetLeft?: number; cropOffsetTop?: number };
        dx = clamp(Math.round(Math.abs(i.cropOffsetLeft ?? 0) / scale), 0, slackX);
        dy = clamp(Math.round(Math.abs(i.cropOffsetTop ?? 0) / scale), 0, slackY);
      }
      how = position;
    } else if ((GRAVITY as readonly string[]).includes(position)) {
      dx = position.includes('west') ? 0 : position.includes('east') ? slackX : Math.round(slackX / 2);
      dy = position.includes('north') ? 0 : position.includes('south') ? slackY : Math.round(slackY / 2);
      how = position;
    } else {
      fail(`${file}: unknown position "${position}" (use ${[...STRATEGY, ...GRAVITY].join(', ')} or x/y)`);
    }
  }
  if (region.width !== sw - 2 * DISH_INSET || region.height !== sh - 2 * DISH_INSET) how = `region ${region.width}x${region.height}@${region.left},${region.top} + ${how}`;
  return { box: { left: region.left + dx, top: region.top + dy, width: cw, height: ch }, how };
}

async function emit(rel: string, file: string, job: { box?: Box; w: number; h: number; fmt: 'webp' | 'jpeg' }): Promise<Output> {
  planned.add(rel);
  const out = join(OUT, rel);
  const st = statSync(file);
  const key = hash({ RECIPE, src: [st.size, Math.round(st.mtimeMs)], ...job });
  const prev = cache[rel];
  if (prev && existsSync(out)) {
    const [k, q] = prev.split(':');
    if (k === key) {
      nextCache[rel] = prev;
      return { rel, w: job.w, h: job.h, bytes: statSync(out).size, quality: Number(q), cached: true };
    }
  }

  const base = () => {
    let p = sharp(file).rotate();
    if (job.box) p = p.extract(job.box);
    // dish: the box is already 4:3, so fill is an exact scale; place: width only, height follows the source
    p = job.box
      ? p.resize(job.w, job.h, { fit: 'fill', kernel: 'lanczos3' })
      : p.resize({ width: job.w, kernel: 'lanczos3', withoutEnlargement: true });
    return p;
  };

  let buf: Buffer;
  let info: OutputInfo;
  let quality: number;
  if (job.fmt === 'jpeg') {
    quality = JPEG_QUALITY;
    ({ data: buf, info } = await base().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
  } else {
    const steps = job.box ? DISH_QUALITY : [PLACE_QUALITY];
    const budget = budgetFor(job.w);
    let res!: { data: Buffer; info: OutputInfo };
    quality = steps[0];
    for (const q of steps) {
      quality = q;
      res = await base().webp({ quality: q, effort: 6, smartSubsample: true, preset: 'photo' }).toBuffer({ resolveWithObject: true });
      if (!job.box || res.data.length <= budget) break;
    }
    ({ data: buf, info } = res);
  }
  writeFileSync(out, buf);
  nextCache[rel] = `${key}:${quality}`;
  return { rel, w: info.width, h: info.height, bytes: buf.length, quality, cached: false };
}

function pickWidths(standard: number[], max: number): number[] {
  const widths = standard.filter((w) => w <= max);
  const last = widths.at(-1) ?? 0;
  if (max < standard.at(-1)! && max >= last * MIN_EXTRA_STEP) widths.push(max);
  if (!widths.length) widths.push(max);
  return widths;
}

async function orientedSize(file: string) {
  const m = await sharp(file).metadata();
  const swap = (m.orientation ?? 1) >= 5;
  return { width: swap ? m.height! : m.width!, height: swap ? m.width! : m.height! };
}

function readFocus(): Record<string, Focus> {
  if (!existsSync(FOCUS_FILE)) return {};
  const raw = readJson<Record<string, unknown>>(FOCUS_FILE, {});
  const allowed = new Set(['position', 'x', 'y', 'inset', 'left', 'top', 'width', 'height', 'why']);
  const out: Record<string, Focus> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (name.startsWith('_')) continue; // "_readme" and friends
    if (!v || typeof v !== 'object') fail(`assets.focus.json: "${name}" must be an object`);
    for (const k of Object.keys(v)) if (!allowed.has(k)) fail(`assets.focus.json: "${name}" has unknown key "${k}"`);
    out[name] = v as Focus;
  }
  return out;
}

function srcPath(name: string) {
  const p = join(SRC, `${name}.jpg`);
  return existsSync(p) ? p : join(SRC, `${name}.jpeg`);
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch (e) {
    if (existsSync(p) && p === FOCUS_FILE) fail(`cannot parse ${p}: ${(e as Error).message}`);
    return fallback;
  }
}

function hash(v: unknown) {
  return createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}
function int(n: number) {
  return Math.round(Number(n));
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function kb(n: number) {
  return `${(n / 1024).toFixed(1)} KB`;
}
function fail(msg: string): never {
  console.error(`assets: ${msg}`);
  process.exit(1);
}
