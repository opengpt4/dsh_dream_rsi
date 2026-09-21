import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
