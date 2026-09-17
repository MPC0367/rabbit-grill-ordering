// The guest kit and the staff kit are two barrels, not one.
//
// client/src/ui/index.ts used to end with `export * from './admin/index.ts'`.
// It made every staff component reachable from the guest barrel, so in
// development (unbundled ES modules, no tree shaking) opening the guest menu
// downloaded the whole staff kit, and a guest screen could import a staff
// component by accident and only find out from a production bundle.
//
// These checks read the source, not a build, so they fail the moment the
// re-export comes back or a guest module reaches into client/src/ui/admin/.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../../client/src');
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Source with comments blanked out, so prose that names a path is not read as an import. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Relative specifiers this file imports, resolved to absolute paths (the project always writes the extension). */
function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const m of code(file).matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) out.push(resolve(dirname(file), m[1]));
  return out;
}

const STAFF_KIT = join(SRC, 'ui', 'admin');
const isStaffKit = (p: string) => p.startsWith(STAFF_KIT);

describe('the ui barrel does not carry the staff kit', () => {
  test('client/src/ui/index.ts does not re-export client/src/ui/admin', () => {
    const barrel = code(join(SRC, 'ui', 'index.ts'));
    const reExports = [...barrel.matchAll(/^export\s[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(
      reExports.filter((s) => s.includes('admin/')),
      [],
      'client/src/ui/index.ts must not re-export the staff kit: staff screens import client/src/ui/admin/index.ts',
    );
  });

  test('no guest module reaches the staff kit, however deep the import chain', () => {
    // Everything a guest device can load: the guest app and the guest half of the kit.
    const roots = [join(SRC, 'guest', 'GuestApp.tsx'), join(SRC, 'ui', 'index.ts'), join(SRC, 'main.tsx')];
    const seen = new Set<string>();
    const from = new Map<string, string>();
    const stack = [...roots];
    const offenders: string[] = [];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
      seen.add(file);
      // App.tsx owns the guest/staff split; walking into it would walk the whole app.
      if (rel(file) === 'App.tsx') continue;
      for (const next of importsOf(file)) {
        if (isStaffKit(next)) offenders.push(`${rel(next)} <- ${rel(file)}${from.has(file) ? ` <- ${rel(from.get(file)!)}` : ''}`);
        else if (!seen.has(next)) { from.set(next, file); stack.push(next); }
      }
    }
    assert.deepEqual(offenders, [], `guest modules must not import the staff kit:\n  ${offenders.join('\n  ')}`);
  });

  test('no staff screen asks the guest barrel for a staff name', () => {
    const staffNames = new Set<string>();
    for (const m of code(join(SRC, 'ui', 'admin', 'index.ts')).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (name) staffNames.add(name);
      }
    }
    assert.ok(staffNames.size > 50, 'the staff barrel should export the whole staff kit');

    const wrong: string[] = [];
    for (const file of walk(join(SRC, 'admin'))) {
      for (const m of code(file).matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(?:\.\.\/)+ui\/index\.ts';$/gm)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (name && staffNames.has(name)) wrong.push(`${rel(file)}: ${name}`);
        }
      }
    }
    assert.deepEqual(wrong, [], 'staff components must be imported from client/src/ui/admin/index.ts');
  });
});
