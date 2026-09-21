import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Architectural boundaries, checked against the source rather than asserted in
 * prose.
 *
 * The simulator SDK is meant to sit behind `EnvironmentAdapter`, so that a
 * different simulator can be dropped in without touching policy code. These
 * tests fail the moment an SDK type crosses back into the core.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Every `.ts` file under `src/`, with relative specifiers resolved to
 * src-relative paths. Bare specifiers are kept verbatim so package-level
 * boundaries can be checked too.
 */
function importGraph() {
  const graph = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      const file = relative(SRC, absolute);
      const specifiers = [...readFileSync(absolute, 'utf8').matchAll(/from\s+'([^']+)'/g)]
        .map((match) => match[1])
        .map((specifier) =>
          specifier.startsWith('.')
            ? relative(SRC, join(absolute, '..', specifier)).replace(/\.js$/, '.ts')
            : specifier
        );
      graph.set(file, specifiers);
    }
  };
  walk(SRC);
  return graph;
}

const GRAPH = importGraph();

function importersOf(target) {
  return [...GRAPH.entries()]
    .filter(([, specifiers]) => specifiers.includes(target))
    .map(([file]) => file)
    .sort();
}

test('the mock simulator SDK is reached only through its adapter', () => {
  // Only the adapter may know the SDK. The runtime constructs it behind the
  // adapter, and the package entry re-exports the type for tests.
  assert.deepEqual(importersOf('embodied/backend.ts'), [
    'embodied/mock-adapter.ts',
    'index.ts',
    'runtime.ts'
  ]);
});

test('the environment protocol depends on nothing but the core data model', () => {
  assert.deepEqual(GRAPH.get('embodied/protocol.ts'), ['discovery/models.ts']);
});

test('the embodied tools depend on the adapter contract, not on a simulator', () => {
  for (const tool of ['embodied/perceive.ts', 'embodied/act.ts', 'embodied/query-state.ts']) {
    const specifiers = GRAPH.get(tool);
    assert.ok(specifiers.includes('embodied/protocol.ts'), `${tool} must use the adapter contract`);
    assert.ok(!specifiers.includes('embodied/backend.ts'), `${tool} reaches the mock SDK directly`);
  }
});

test('policy and replay code never depends on the environment layer or a simulator', () => {
  const forbidden = ['embodied/backend.ts', 'embodied/mock-adapter.ts'];
  for (const [file, specifiers] of GRAPH) {
    if (!file.startsWith('evolution/') && !file.startsWith('replay/')) continue;
    for (const specifier of forbidden) {
      assert.ok(!specifiers.includes(specifier), `${file} imports ${specifier}`);
    }
  }
});

test('the registry layer does not depend on the environment layer', () => {
  // A registry that knew about environments would be unusable for tool and
  // policy records, which have nothing to do with an embodied backend.
  for (const [file, specifiers] of GRAPH) {
    if (!file.startsWith('registry/')) continue;
    assert.ok(
      !specifiers.some((specifier) => specifier.startsWith('embodied/')),
      `${file} reaches into the environment layer`
    );
  }
});

test('only the adapter calls the Cordis registration API', () => {
  // Taking a `Context` to emit events is fine and does not couple a module to
  // the loader; calling `ctx.tools.register` or `ctx.effect` is what has to
  // stay in one place, because that is what must be reversible on unload.
  const callers = [...GRAPH.keys()]
    .filter((file) => /ctx\.(?:tools\.register|effect)\s*\(/.test(readFileSync(join(SRC, file), 'utf8')))
    .sort();

  assert.deepEqual(callers, ['adapter/cordis.ts']);
});

test('Cordis types are imported only by modules that take a Context', () => {
  const importers = [...GRAPH.entries()]
    .filter(([, specifiers]) => specifiers.some((specifier) => specifier.startsWith('@deepseek-ai/cordis')))
    .map(([file]) => file)
    .sort();

  // perceive and query-state take only the adapter contract now, so they carry
  // no Cordis type at all.
  assert.deepEqual(importers, ['adapter/cordis.ts', 'embodied/act.ts', 'embodied/query-state.ts']);
});
