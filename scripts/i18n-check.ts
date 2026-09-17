// Translation key audit: every t('literal') key used under client/src must
// exist in BOTH the Thai and English dictionaries, and the two languages must
// carry the same keys and placeholders.
//
//   node scripts/i18n-check.ts            # exit 1 when a key is missing
//   node scripts/i18n-check.ts --verbose  # also list key-like literals and Thai style warnings
//
// Also checks the bundle split: guest code (client/src/guest, lib, ui) may only
// use keys from the guest dictionaries (common, errors, guest, cart, visit),
// because the admin dictionaries are loaded with the admin interface.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AreaDict } from '../client/src/i18n/index.ts';
import { PERMISSIONS } from '../shared/permissions.ts';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'client/src');
const verbose = process.argv.includes('--verbose');

const AREA_FILES = ['common', 'errors', 'guest', 'cart', 'visit', 'admin', 'orders', 'tables', 'catalog', 'insights', 'more'] as const;
const GUEST_AREAS = new Set(['common', 'errors', 'guest', 'cart', 'visit']);

const areas: Record<string, AreaDict> = {};
for (const name of AREA_FILES) {
  areas[name] = (await import(`../client/src/i18n/${name}.ts`)).default as AreaDict;
}

const th = new Map<string, string>();
const en = new Map<string, string>();
const areaOf = new Map<string, string>();
const problems: string[] = [];
const warnings: string[] = [];

for (const [name, dict] of Object.entries(areas)) {
  for (const [k, v] of Object.entries(dict.th)) {
    if (th.has(k)) warnings.push(`duplicate th key ${k} in ${name} (also in ${areaOf.get(k)})`);
    th.set(k, v);
    areaOf.set(k, name);
  }
  for (const [k, v] of Object.entries(dict.en)) {
    if (en.has(k) && areaOf.get(k) !== name) warnings.push(`duplicate en key ${k} in ${name}`);
    en.set(k, v);
    if (!areaOf.has(k)) areaOf.set(k, name);
  }
}

// Parity and placeholders.
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of th.keys()) if (!en.has(k)) problems.push(`en missing ${k} (${areaOf.get(k)}.ts)`);
for (const k of en.keys()) if (!th.has(k)) problems.push(`th missing ${k} (${areaOf.get(k)}.ts)`);
for (const [k, v] of th) {
  const e = en.get(k);
  // A singular English form may drop {n} ("one dish"); anything else must match.
  const singular = /(\.one|One)$/.test(k) && vars(e ?? '').split(',').filter(Boolean).every((x) => vars(v).split(',').includes(x));
  if (e !== undefined && vars(v) !== vars(e) && !singular) problems.push(`placeholder mismatch ${k}: th {${vars(v)}} en {${vars(e)}}`);
  if (/—/.test(v)) warnings.push(`Thai em dash in ${k}: ${v}`);
  if (/;/.test(v)) warnings.push(`Thai semicolon in ${k}: ${v}`);
  if (/ถูก(?!ต้อง|ใจ|กว่า|ที่|ๆ|$)/.test(v)) warnings.push(`Thai ถูก (check for a passive) in ${k}: ${v}`);
}

// Walk the sources.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'i18n') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const PREFIXES = [...new Set([...th.keys()].map((k) => k.split('.')[0]))];
const prefixRe = new RegExp(`^(${PREFIXES.join('|')})\\.[A-Za-z0-9_.-]*[A-Za-z0-9_]$`);
// Live topics and other non-key literals that happen to share a prefix.
const NOT_KEYS = /^(order|line|service|portion|bill|payment|visit|table|menu|ordering|report|settings)\.(created|updated|opened|closed|recorded|paused|resumed)$/;

const PERMISSION_SET = new Set<string>(PERMISSIONS);

let literalCount = 0;
const used = new Set<string>();
const templates: Array<{ file: string; tpl: string }> = [];

for (const file of walk(src)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  // Drop comment lines so documentation examples are not counted.
  const text = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const isGuestSide = /^client\/src\/(guest|lib|ui)\//.test(rel) && !/Gallery/.test(rel);
  // t('key') / t("key") / t(`key`) and wrappers named t, tt, tr.
  for (const m of text.matchAll(/\b(?:t|tt|tr)\(\s*(['"`])([A-Za-z][\w.-]*)\1\s*[,)]/g)) {
    literalCount++;
    const key = m[2];
    used.add(key);
    if (!th.has(key) && !en.has(key)) problems.push(`${rel}: t('${key}') is in neither dictionary`);
    else if (!th.has(key)) problems.push(`${rel}: t('${key}') has no Thai`);
    else if (!en.has(key)) problems.push(`${rel}: t('${key}') has no English`);
    const area = areaOf.get(key);
    if (area && isGuestSide && !GUEST_AREAS.has(area)) problems.push(`${rel}: guest code uses admin-area key ${key} (${area}.ts), which is not loaded for guests`);
  }
  for (const m of text.matchAll(/\b(?:t|tt|tr)\(\s*`([^`]*\$\{[^`]*)`/g)) templates.push({ file: rel, tpl: m[1] });
  // Key-like string literals passed around (labelKey: 'x.y').
  for (const m of text.matchAll(/(['"])([a-z][A-Za-z0-9]*\.[A-Za-z0-9_.-]+)\1/g)) {
    const key = m[2];
    if (!prefixRe.test(key) || NOT_KEYS.test(key) || used.has(key) || PERMISSION_SET.has(key)) continue;
    if (/\.(ts|tsx|css|svg|png|jpg|webp|json|csv|pdf|zip)$/.test(key)) continue;
    if (th.has(key) && en.has(key)) {
      used.add(key);
      const area = areaOf.get(key)!;
      if (isGuestSide && !GUEST_AREAS.has(area)) problems.push(`${rel}: guest code references admin-area key ${key} (${area}.ts)`);
      continue;
    }
    if (verbose) warnings.push(`${rel}: key-like literal '${key}' is not a dictionary key (check it is not passed to t())`);
  }
}

// Template keys: at least one key must start with the static prefix.
for (const { file, tpl } of templates) {
  const prefix = tpl.slice(0, tpl.indexOf('${'));
  if (!prefix) continue;
  const matches = [...th.keys()].filter((k) => k.startsWith(prefix));
  if (matches.length === 0) problems.push(`${file}: t(\`${tpl}\`) matches no key starting with '${prefix}'`);
  for (const k of matches) used.add(k);
}

console.log(`dictionary keys: th ${th.size}, en ${en.size}`);
console.log(`literal t() calls: ${literalCount}, distinct keys used: ${used.size}, template keys: ${templates.length}`);
if (verbose || warnings.length < 40) for (const w of warnings) console.log(`warn  ${w}`);
else console.log(`${warnings.length} warnings (run with --verbose to list)`);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'no missing keys');
process.exit(problems.length ? 1 : 0);
