// End-to-end browser journeys (brief 31): `npm run e2e`.
//
//   npm run e2e                                 seeded throwaway instance (the npm run dev path), free ports
//   npm run e2e -- --port 8771                  use web port 8771 and API port 8772
//   npm run e2e -- --base http://localhost:8344 use a running instance instead (its data WILL change)
//   npm run e2e -- --only a,b,g                 run some journeys (a-f build on each other, in order)
//   npm run e2e -- --no-history                 seed without the synthetic year (faster start, smaller report)
//   npm run e2e -- --prod                       build, seed, then `npm start` (the production path) instead of `npm run dev`
//   npm run e2e -- --keep                       keep var/e2e/<run>/ (database and app log)
//
// Output: test/e2e/out/*.png and test/e2e/out/results.json. Run it from a
// normal desktop shell (PowerShell on Windows): it launches the installed Edge
// or Chrome. Exit code 1 when any journey fails.
//
// What this proves is local: two or more real browser sessions against one
// instance and one SQLite database on this computer. It is not a production
// or real-phone check.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { lanAddresses } from '../../scripts/env.ts';
import { startInstance, ROOT, type Instance } from './instance.ts';
import { configure, env, menuItems, type Check } from './lib.ts';
import {
  devServerExposure, productionExposure, journeyA, journeyB, journeyC, journeyD, journeyE, journeyF, journeyG, journeyH,
  journeyOffline, journeyRealtime, journeyShell, type Item, type State,
} from './journeys.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);

const only = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const external = opt('base');
const out = resolve(ROOT, opt('out') ?? 'test/e2e/out');
const prod = flag('prod');

type Journey = (state: State, item: Item) => Promise<Check>;
const JOURNEYS: Array<[string, string, Journey]> = [
  ['a', 'scenario 1: staff seat a table; a guest joins by QR and PIN, customises and sends', journeyA],
  ['b', 'scenario 1: the kitchen advances the round and the guest sees each step live', journeyB],
  ['c', 'brief 44A: a weighed cut is requested, quoted by staff and confirmed by the guest', journeyC],
  ['d', 'brief 15: call staff and request the bill; staff acknowledge live', journeyD],
  ['e', 'scenario 2: a second phone has its own draft and shares rounds and bill', journeyE],
  ['f', 'brief 36: serve, settle and Complete checkout; the visit ends everywhere', journeyF],
  ['g', 'scenario 13: language switch in the dish sheet, mid-cart and while tracking', journeyG],
  ['h', 'brief 37-41, 25: insights, a provisional annual PDF, pause and resume ordering', journeyH],
  ['realtime', 'scenario 12: the board catches up after its live channel returns', journeyRealtime],
  ['offline', 'brief 30: a guest phone without network keeps its draft and cannot send', journeyOffline],
  ['shell', 'brief 17, 33, 42: review queue, History and Back, 320 px, sheet focus', () => journeyShell({ gallery: !prod })],
];

let app: Instance | null = null;
let item: Item;
const state: State = {};
const results: Record<string, { pass: boolean; lines: string[] }> = {};

before(async () => {
  if (external) {
    configure({ base: external, out });
  } else {
    const port = opt('port') ? Number(opt('port')) : undefined;
    console.log(`starting a seeded instance (${prod ? 'build + npm start' : 'npm run dev'} path); this takes about half a minute...`);
    app = await startInstance({ name: prod ? 'e2e-prod' : 'e2e', port, mode: prod ? 'prod' : 'dev', history: !flag('no-history'), keep: flag('keep'), env: { LOG_REQUESTS: '1' } });
    console.log(`instance ${app.base} (log ${app.log})`);
    configure({ base: app.base, out });
  }
  item = await menuItems();
});

after(async () => {
  writeFileSync(join(out, 'results.json'), JSON.stringify({ base: env.base, at: new Date().toISOString(), results }, null, 2));
  await app?.stop();
  // A browser or socket left open by a crashed journey must not hang the run.
  setTimeout(() => process.exit(), 15_000).unref();
});

if (!external && prod) {
  test('production build: source maps and unknown asset paths are not served', { skip: only && !only.includes('files') ? 'not selected' : false }, async () => {
    const c = await productionExposure(app!.base, ROOT);
    results[c.name] = { pass: c.pass, lines: c.lines };
    assert.ok(c.pass, c.failures.join('\n'));
  });
}

if (!external && !prod) {
  test('dev server: the network sees the app, not the database or server files', { skip: only && !only.includes('files') ? 'not selected' : false }, async () => {
    const lan = lanAddresses()[0];
    const c = await devServerExposure(app!.base, lan ? `http://${lan.address}:${app!.port}` : null, ROOT, join(app!.dir, 'app.db'));
    results[c.name] = { pass: c.pass, lines: c.lines };
    assert.ok(c.pass, c.failures.join('\n'));
  });
}

for (const [key, title, fn] of JOURNEYS) {
  test(`${key}: ${title}`, { skip: only && !only.includes(key) ? 'not selected' : false }, async () => {
    const c = await fn(state, item);
    results[key] = { pass: c.pass, lines: c.lines };
    assert.ok(c.pass, `${c.failures.length} check(s) failed:\n  ${c.failures.join('\n  ')}`);
  });
}
