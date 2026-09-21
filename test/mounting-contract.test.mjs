import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The mounting contract.
 *
 * A profile resolves a bundle through `package.json` -> `dsh.bundle.patch`, and
 * the loader reads the patch it points at. Every one of those names has to
 * agree with the plugin's own name and the package name, and until now nothing
 * read the patch file at all: renaming either one would have broken mounting
 * with no test failing.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));

function readPluginName() {
  const source = readFileSync(`${ROOT}src/index.ts`, 'utf8');
  const match = source.match(/export const name = '([^']+)'/);
  assert.ok(match, 'src/index.ts must export the plugin name');
  return match[1];
}

function patchEntries(path) {
  const parsed = parse(readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(parsed), `${path} must be a top-level array of patch entries`);
  return parsed.flatMap((entry) => entry?.insert ?? []);
}

test('the manifest points at a patch file that exists', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(existsSync(`${ROOT}cordis.patch.yml`), 'the patch the manifest points at must exist');
});

test('the patch is valid YAML and inserts exactly one row', () => {
  const rows = patchEntries(`${ROOT}cordis.patch.yml`);

  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'name']);
});

test('the patch row agrees with the plugin name and the package name', () => {
  const [row] = patchEntries(`${ROOT}cordis.patch.yml`);

  // The row id is the plugin's configured name, which is what a later layer
  // addresses the row by.
  assert.equal(row.id, readPluginName());
  // The row name is the package the loader imports.
  assert.equal(row.name, manifest.name);
});

test('the package publishes what a profile needs to read', () => {
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch must be published');
  assert.ok(manifest.exports['./cordis.patch.yml'], 'the patch must be an exported subpath');
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml');
});

test('the override example addresses the row the bundle actually inserts', () => {
  // The example is a user patch layer that overrides configuration by row id.
  // If the plugin is renamed and the example is not, the override silently
  // stops applying rather than failing.
  const example = parse(readFileSync(`${ROOT}examples/cordis.patch.yml`, 'utf8'));

  assert.ok(Array.isArray(example));
  assert.equal(example.length, 1);
  assert.equal(example[0].id, readPluginName());
  assert.ok(example[0].config, 'the example must override config to be worth showing');

  // And the id it addresses is the one the bundle patch inserts.
  const [row] = patchEntries(`${ROOT}cordis.patch.yml`);
  assert.equal(example[0].id, row.id);
});

test('the example config is schema-valid, since the loader validates it', async () => {
  const example = parse(readFileSync(`${ROOT}examples/cordis.patch.yml`, 'utf8'));
  const { resolveDreamRsiConfig } = await import('../dist/index.js');

  // A partial block is safe because absent keys take schema defaults; the
  // example must not be one the loader would reject.
  assert.doesNotThrow(() => resolveDreamRsiConfig(example[0].config));
});
