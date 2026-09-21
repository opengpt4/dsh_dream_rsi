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
      const source = readFileSync(absolute, 'utf8');
      // Both forms: `import x from` and the side-effect `import '...'`, so a
      // module pulled in only for its type augmentation is not called an orphan.
      const specifiers = [...source.matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)]
        .map((match) => match[1] ?? match[2])
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

test('the environment protocol depends on nothing but the core data model and its own layer', () => {
  // The capability profile is an environment declaration, not a safety concept,
  // so the protocol may name it; a backend declares a profile and the safety
  // layer enforces it. Depending on `safety/` instead would invert that.
  assert.deepEqual(GRAPH.get('embodied/protocol.ts'), ['discovery/models.ts', 'embodied/capability.ts']);
});

test('the capability declaration does not depend on the layer that enforces it', () => {
  const specifiers = GRAPH.get('embodied/capability.ts');
  assert.ok(
    !specifiers.some((specifier) => specifier.startsWith('safety/')),
    'the environment layer must not reach into safety'
  );
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

  // query-state takes only the adapter contract now, so only act still needs a
  // Context — and only to emit its events.
  assert.deepEqual(importers, ['adapter/cordis.ts', 'embodied/act.ts']);
});

/**
 * Modules the entry does not import but the build still needs.
 *
 * `evaluator-worker.ts` is spawned by path, so nothing imports it; the bundler
 * and TypeScript still treat it as an entry point.
 */
const NON_IMPORTED_ENTRY_POINTS = ['evolution/evaluator-worker.ts', 'index.ts'];

test('every source module is reachable from the entry or a declared entry point', () => {
  const reachable = new Set();
  const stack = ['index.ts'];
  while (stack.length > 0) {
    const file = stack.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const specifier of GRAPH.get(file) ?? []) {
      if (specifier.endsWith('.ts')) stack.push(specifier);
    }
  }

  const orphans = [...GRAPH.keys()]
    .filter((file) => !reachable.has(file))
    .filter((file) => !NON_IMPORTED_ENTRY_POINTS.includes(file))
    .sort();

  // A module nothing imports is either an entry point or a file that was
  // written and never wired up.
  assert.deepEqual(orphans, []);
});

test('the declared non-imported entry points are the only ones', () => {
  const imported = new Set([...GRAPH.values()].flat());
  const unimported = [...GRAPH.keys()].filter((file) => !imported.has(file)).sort();

  assert.deepEqual(unimported, NON_IMPORTED_ENTRY_POINTS);
});

/**
 * Core Context members, which live on the prototype rather than in the service
 * store, so reading them needs no `inject` declaration. Anything else reached
 * as `ctx.<name>` is a service.
 */
const CORE_CONTEXT_MEMBERS = new Set([
  'effect', 'emit', 'on', 'once', 'off', 'parallel', 'waterfall', 'bail',
  'start', 'stop', 'provide', 'command', 'worker', 'plugin', 'registry',
  'inject', 'reflect', 'scope', 'isolate', 'extend', 'mixin'
]);

test('every Cordis service the adapter uses is declared in inject', () => {
  const adapter = readFileSync(join(SRC, 'adapter/cordis.ts'), 'utf8');
  const entry = readFileSync(join(SRC, 'index.ts'), 'utf8');

  const used = new Set(
    [...adapter.matchAll(/ctx\.([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((name) => !CORE_CONTEXT_MEMBERS.has(name))
  );

  const declared = [...(entry.match(/export const inject: string\[\] = \[([^\]]*)\]/) ?? [, ''])[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);

  // A service read without a declaration is an activation race: Cordis throws
  // "cannot get property X without inject" when the provider has not run yet.
  assert.deepEqual([...used].sort(), [...declared].sort());
  assert.deepEqual(declared, ['tools']);
});

test('the configuration fields nothing consumes are exactly the documented ones', () => {
  // `autoDeploy` was the first of these, and it was not the only one: three
  // runtime/evolution fields and the artifact directory were accepted, validated
  // and reported while no code path read them, so each implied a capability that
  // does not exist. This derives the set from the source and requires it to match
  // PRODUCTION_POLICY.md, so wiring one forces the document to change with it and
  // a newly unread field has to be documented rather than implied.
  const config = readFileSync(join(SRC, 'config.ts'), 'utf8');
  const declaration = config.slice(config.indexOf('export interface DreamRsiConfig {'));
  // Leaf fields only: a block declaration is followed by `{`.
  const body = declaration.slice(0, declaration.indexOf('\n}\n'));
  const fields = [...new Set([...body.matchAll(/readonly ([A-Za-z][A-Za-z0-9]*): (?!\{)/g)].map((match) => match[1]))];
  assert.ok(fields.length >= 20, `expected the whole config surface, found ${fields.length} fields`);

  const others = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      // config.ts declares them and status.ts reports them; neither consumes one.
      if (!entry.name.endsWith('.ts') || ['config.ts', 'status.ts'].includes(entry.name)) continue;
      others.push(readFileSync(absolute, 'utf8'));
    }
  };
  walk(SRC);

  const inert = fields.filter((field) => !others.some((text) => new RegExp(`\\b${field}\\b`).test(text)));

  const policy = readFileSync(fileURLToPath(new URL('../PRODUCTION_POLICY.md', import.meta.url)), 'utf8');
  const documented = [...policy.matchAll(/^- `(?:[a-zA-Z]+\.)?([A-Za-z][A-Za-z0-9]*)` —/gm)].map((match) => match[1]);

  assert.deepEqual(inert.sort(), documented.sort(), 'PRODUCTION_POLICY.md and the source disagree about which configuration fields nothing consumes');
});
