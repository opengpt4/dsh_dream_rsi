import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { tCritical95 } from '../dist/index.js';

/**
 * Guards against the documentation understating what is built.
 *
 * The README listed candidate generation, canary deployment, and tool synthesis
 * as planned work long after all three were implemented and tested. A reader
 * would have concluded the plugin does far less than it does. These checks tie
 * a capability claim to the module that evidences it, and fail when the docs
 * still call an implemented capability planned.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CAPABILITIES = [
  { name: 'candidate generation', planned: /candidate generation/i, evidence: 'src/evolution/candidate-generator.ts' },
  { name: 'canary deployment', planned: /canary deployment/i, evidence: 'src/registry/deployment-writer.ts' },
  { name: 'tool synthesis', planned: /tool synthesis/i, evidence: 'src/tools/synthesized-tool.ts' },
  { name: 'ablation study', planned: /ablation/i, evidence: 'src/evolution/ablation.ts' },
  { name: 'access control', planned: /access control/i, evidence: 'src/governance/access-control.ts' },
  { name: 'secret redaction', planned: /redaction/i, evidence: 'src/governance/redaction.ts' }
];

/**
 * The sentences in a document that describe what is still planned.
 *
 * Sentence-level rather than line-level: a line can mention an implemented
 * capability in one sentence and a genuinely planned one in the next, and a
 * line-level scan would read the first as a claim about the second.
 */
function plannedWorkLines(relativePath) {
  return readFileSync(`${ROOT}${relativePath}`, 'utf8')
    .replace(/\s+/g, ' ')
    .split(/(?<=\.)\s+/)
    .filter((sentence) => /planned work|remain(s)? (planned|to be)/i.test(sentence))
    .join('\n');
}

test('no implemented capability is still documented as planned work', () => {
  const documents = ['README.md', 'TECHNICAL_PAPER.md'];

  for (const capability of CAPABILITIES) {
    // Only assert where there is something on disk to point at.
    if (!existsSync(`${ROOT}${capability.evidence}`)) continue;

    for (const document of documents) {
      const planned = plannedWorkLines(document);
      assert.ok(
        !capability.planned.test(planned),
        `${document} still calls "${capability.name}" planned work, but ${capability.evidence} exists`
      );
    }
  }
});

test('the planned work that is named really is absent', () => {
  const planned = plannedWorkLines('README.md');

  // The counter-check: a capability named as planned must not have a module.
  for (const absent of [
    { name: 'sandboxing', marker: /sandboxing/i, evidence: 'src/operations/os-sandbox.ts' },
    { name: 'simulator adapter', marker: /simulator adapter/i, evidence: 'src/embodied/real-simulator-adapter.ts' }
  ]) {
    if (!absent.marker.test(planned)) continue;
    assert.ok(!existsSync(`${ROOT}${absent.evidence}`), `${absent.name} is named as planned but has a module`);
  }
});

test('the design spec does not deny a capability the code provides', () => {
  const spec = readFileSync(`${ROOT}DETAILED_DESIGN_SPEC.md`, 'utf8');

  // These sentences were true when written and became false as the code landed.
  assert.ok(
    !/`sourceRef` is not implemented/.test(spec),
    'the spec still says sourceRef is unimplemented'
  );
  assert.ok(
    !/createdAt.*part of (the )?(content hash|snapshot identity)/i.test(spec),
    'the spec still says the snapshot id covers creation time'
  );  assert.ok(
    !/CPU, memory, filesystem, and network limits require OS-level confinement and are not yet implemented/.test(spec),
    'the spec still says no filesystem limit exists'
  );
});

test('the design spec quotes the interval widening the t table produces', () => {
  const spec = readFileSync(`${ROOT}DETAILED_DESIGN_SPEC.md`, 'utf8');

  // The prose named four samples for the 1.4x figure, which is the widening at
  // five samples, and the module doc claimed a factor of two at five samples,
  // which is the widening at three. Tied to the table so a change to either
  // side fails here rather than leaving a number nobody recomputes.
  const widening = (sampleCount) => (tCritical95(sampleCount - 1) / 1.96).toFixed(1);
  assert.ok(spec.includes(`${widening(5)}x wider`), `the spec must quote ${widening(5)}x at five samples`);
  assert.ok(spec.includes(`${widening(3)}x`), `the spec must quote ${widening(3)}x at three samples`);
  assert.ok(
    !/at four samples the interval is roughly/i.test(spec),
    'the spec still attributes the widening to four samples'
  );
});

test('every stated test count is the count the suite has', () => {
  // Five documents stated the suite size as 24, 38, or 359 tests while it had
  // 433, so a reader assessing the evidence was misled by up to a factor of
  // eighteen. Per-file counts in the TODO had drifted too. Counted from the
  // definitions rather than asserted as a constant, so the next stale number
  // fails here instead of shipping.
  const testDir = `${ROOT}test/`;
  const files = readdirSync(testDir).filter((name) => name.endsWith('.test.mjs'));
  const counted = (name) => (readFileSync(`${testDir}${name}`, 'utf8').match(/^test\(/gm) ?? []).length;
  const suiteTotal = files.reduce((total, name) => total + counted(name), 0);
  assert.ok(suiteTotal > 0, 'no tests were counted, so this check is not measuring anything');

  const documents = readdirSync(ROOT).filter((name) => name.endsWith('.md'));
  const suiteClaims = [];
  const fileClaims = [];
  for (const document of documents) {
    const text = readFileSync(`${ROOT}${document}`, 'utf8');
    for (const [, claimed] of text.matchAll(/(\d+)\s+(?:passing\s+(?:automated\s+)?tests|tests\s+passing)/g)) {
      suiteClaims.push({ document, claimed: Number(claimed) });
    }
    for (const [, file, claimed] of text.matchAll(/test\/([\w-]+)\.test\.mjs`?,\s*(\d+)\s+tests?/g)) {
      fileClaims.push({ document, file, claimed: Number(claimed) });
    }
  }

  assert.ok(suiteClaims.length >= 5, `expected the suite size to be stated in several documents, found ${suiteClaims.length}`);

  // Every mismatch at once: a stale count is a one-line fix, and reporting them
  // one run at a time makes maintaining five documents needlessly slow.
  const mismatches = [
    ...suiteClaims
      .filter(({ claimed }) => claimed !== suiteTotal)
      .map(({ document, claimed }) => `${document} claims ${claimed} passing tests; the suite defines ${suiteTotal}`),
    ...fileClaims
      .filter(({ file, claimed }) => claimed !== counted(`${file}.test.mjs`))
      .map(({ document, file, claimed }) => `${document} claims ${claimed} tests in ${file}.test.mjs; it defines ${counted(`${file}.test.mjs`)}`)
  ];
  assert.deepEqual(mismatches, [], `stale test counts:\n  ${mismatches.join('\n  ')}`);
});
