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
  { name: 'secret redaction', planned: /redaction/i, evidence: 'src/governance/redaction.ts' },
  { name: 'artifact signing', planned: /signing/i, evidence: 'src/registry/signing.ts' }
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

test('no capability status table calls an implemented capability planned', () => {
  // The sentence-scoped check above misses tables, which is where the drift
  // actually was: the user guide's capability table still listed profile/patch
  // integration, candidate generation, tool synthesis, canary deployment, and
  // the guard pipeline as "Planned" long after each shipped, and a reader
  // planning adoption reads that table rather than the prose.
  const rows = readFileSync(`${ROOT}USER_GUIDE_AND_FEATURES.md`, 'utf8')
    .split('\n')
    .filter((line) => /^\|\s*[^|]+\|/.test(line));
  // The table is what is measured, so a missing or reformatted table must fail
  // here. Requiring a *planned* row would have been the wrong anti-vacuity check:
  // the honest state is that nothing is left marked planned, and the check has to
  // pass then without going blind to a table that is no longer being parsed.
  assert.ok(rows.length >= 8, `expected the capability table, parsed ${rows.length} rows`);
  const table = rows
    .filter((line) => /^\|\s*[^|]+\|\s*(Planned|Not implemented|Not available)\s*\|/i.test(line))
    .join('\n');
  for (const capability of CAPABILITIES) {
    if (!existsSync(`${ROOT}${capability.evidence}`)) continue;
    assert.ok(
      !capability.planned.test(table),
      `the capability table still calls "${capability.name}" planned, but ${capability.evidence} exists`
    );
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
  );
  assert.ok(
    !/CPU, memory, filesystem, and network limits require OS-level confinement and are not yet implemented/.test(spec),
    'the spec still says no filesystem limit exists'
  );
});

test('the decision brief accounts for every open item exactly once', () => {
  // `DECISIONS.md` referred to items by their line number in `TODO.md`, so
  // inserting one line above them silently repointed every reference at a
  // different item — which is what happened. References are now
  // `TODO: <leading text>`, and the brief must account for the whole open set:
  // every `[!]` item behind a numbered section, every other open item either
  // behind a section or named as not waiting on one.
  const items = readFileSync(`${ROOT}TODO.md`, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^- \[([ x])\] (.*)$/.exec(line);
      if (match === null) return [];
      return [{ text: match[2].replace(/`/g, ''), open: match[1] === ' ', bang: /\[!\]/.test(match[2]) }];
    });
  const open = items.filter((item) => item.open);
  assert.ok(open.length > 0, 'no open items were parsed, so this check is not measuring anything');

  const brief = readFileSync(`${ROOT}DECISIONS.md`, 'utf8');
  const sections = brief
    .split(/^## /m)
    .slice(1)
    .map((body) => ({ heading: body.split('\n')[0].trim(), body }));
  const inTree = sections.filter(({ heading }) => /do not wait on these/i.test(heading));
  assert.equal(inTree.length, 1, 'the brief needs exactly one section for open items that wait on no decision');
  const inTreeHeadings = new Set(inTree.map(({ heading }) => heading));

  const referencesIn = (body) => [...body.matchAll(/`TODO: ([^`]+)`/g)].map(([, reference]) => reference.trim());
  // Leading text, not an exact quote: the item is free to grow after the anchor.
  const resolve = (reference) => open.filter(({ text }) => text.startsWith(reference));
  const gating = sections.filter(({ heading }) => /^\d+\./.test(heading) && !inTreeHeadings.has(heading));

  const claims = new Set();
  for (const section of sections) {
    for (const reference of referencesIn(section.body)) {
      const matches = resolve(reference);
      assert.equal(matches.length, 1, `"${reference}" resolves to ${matches.length} open items`);
      const [item] = matches;
      assert.ok(
        !item.bang || !inTreeHeadings.has(section.heading),
        `"${reference}" is a [!] item but waits in the in-tree section`
      );
      claims.add(item);
    }
  }

  const gatingClaims = new Set(
    gating.flatMap((section) => referencesIn(section.body).flatMap((reference) => resolve(reference)))
  );
  const inTreeClaims = new Set(inTree.flatMap((section) => referencesIn(section.body).flatMap((r) => resolve(r))));

  const unclaimed = open.filter((item) => !claims.has(item)).map((item) => item.text.slice(0, 60));
  assert.deepEqual(unclaimed, [], `open items no section of DECISIONS.md names:\n  ${unclaimed.join('\n  ')}`);
  const gated = open.filter((item) => item.bang);
  const ungated = gated.filter((item) => !gatingClaims.has(item));
  assert.deepEqual(
    ungated.map((item) => item.text.slice(0, 60)),
    [],
    'a [!] item is not behind any numbered section'
  );

  const bangClaim = /(\d+) items in `TODO.md` are marked/.exec(brief);
  const splitClaim = /Of the (\d+) open items, (\d+) wait on one of these \w+; the remaining (\d+)|All (\d+) open items wait on one of these \w+/.exec(brief);
  assert.ok(bangClaim !== null && splitClaim !== null, 'the brief must state how many items it accounts for');
  assert.equal(Number(bangClaim[1]), gated.length, 'the brief miscounts the [!] items');
  // Either shape: a stated split, or "all N wait" when nothing is in-tree.
  const statedOpen = splitClaim[1] ?? splitClaim[4];
  const statedGating = splitClaim[2] ?? splitClaim[4];
  const statedInTree = splitClaim[3] ?? 0;
  assert.equal(Number(statedOpen), open.length, 'the brief miscounts the open items');
  assert.equal(Number(statedGating), gatingClaims.size, 'the brief miscounts the items waiting on a decision');
  assert.equal(Number(statedInTree), inTreeClaims.size, 'the brief miscounts the items that wait on no decision');
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
