import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MOCK_ENVIRONMENT_ID,
  assertCandidateAccepted,
  checkImports,
  createDreamRsiRuntime,
  evaluateReplayIsolated,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runAstGuard,
  runEpisodePipeline,
  scanCandidate
} from '../dist/index.js';
import { BENIGN_CANDIDATE, MALICIOUS_CANDIDATES } from './fixtures/malicious-candidates.mjs';

const PROBE_WORKER = fileURLToPath(new URL('./fixtures/probe-worker.mjs', import.meta.url));
const CANDIDATE_ROOT = fileURLToPath(new URL('./fixtures', import.meta.url));
const SESSION_ID = 'session-1';

function probe(probeMode, extra = {}) {
  return { visitedNodes: [], boundaryMissCount: 0, totalAttempts: 0, criticalPathMs: 1, probeMode, ...extra };
}

function options(overrides = {}) {
  return { workerPath: PROBE_WORKER, timeoutMs: 5_000, ...overrides };
}

/**
 * The process-group fixture has to spawn a grandchild, which confinement
 * prevents. That test is about the kill path, so it runs unconfined; the
 * default posture is covered separately by the confinement test below.
 */
function unconfinedOptions(overrides = {}) {
  return { ...options(overrides), confinement: false };
}

// ---------------------------------------------------------------- guardrails

test('the import allowlist admits only approved specifiers', () => {
  const accepted = checkImports("import { resolve } from 'node:path';\nexport const join = resolve;", {
    allowedBuiltins: ['path']
  });
  assert.equal(accepted.passed, true);
  assert.deepEqual(accepted.specifiers, ['node:path']);
  assert.deepEqual(accepted.capabilities, []);

  const denied = checkImports("import { readFileSync } from 'fs';\nexport const read = readFileSync;");
  assert.equal(denied.passed, false);
  assert.equal(denied.violations[0].rule, 'capability-filesystem');
  assert.equal(denied.violations[0].capability, 'filesystem');
  assert.deepEqual(denied.capabilities, ['filesystem']);
});

test('a capability-granting built-in cannot be allowlisted, even by name', () => {
  const result = checkImports("import { execSync } from 'node:child_process';\nexport const run = execSync;", {
    allowedBuiltins: ['child_process', 'path']
  });

  assert.equal(result.passed, false);
  assert.equal(result.violations[0].rule, 'capability-process');
});

test('packages are judged against the package allowlist, not the builtin one', () => {
  const source = "import lodash from 'lodash';\nimport { z } from '@scope/tool';\nexport const both = [lodash, z];";

  const denied = checkImports(source, { allowedPackages: ['lodash'] });
  assert.deepEqual(denied.violations.map((v) => v.specifier), ['@scope/tool']);
  assert.equal(denied.violations[0].rule, 'package-not-allowed');

  assert.equal(checkImports(source, { allowedPackages: ['lodash', '@scope/tool'] }).passed, true);
});

test('a relative import resolving outside the candidate root is rejected', () => {
  const inside = checkImports("import { helper } from './helper.js';\nexport const h = helper;", {
    candidateRoot: CANDIDATE_ROOT
  });
  assert.equal(inside.passed, true);

  const outside = checkImports("import { holdout } from '../../holdout.ts';\nexport const h = holdout;", {
    candidateRoot: CANDIDATE_ROOT
  });
  assert.equal(outside.passed, false);
  assert.equal(outside.violations[0].rule, 'relative-escape');
});

test('every malicious candidate fixture is rejected by the guard that should catch it', () => {
  for (const fixture of MALICIOUS_CANDIDATES) {
    const result = scanCandidate({ source: fixture.source, candidateRoot: CANDIDATE_ROOT });
    assert.equal(result.passed, false, `${fixture.name} was accepted`);

    const rules = new Set([
      ...result.ast.violations.map((violation) => violation.rule),
      ...result.imports.violations.map((violation) => violation.rule)
    ]);
    for (const expected of fixture.expectedRules) {
      assert.ok(rules.has(expected), `${fixture.name}: expected rule ${expected}, saw ${[...rules].join(', ')}`);
    }
  }
});

test('a benign candidate passes both guards with no capability use', () => {
  const result = scanCandidate({ source: BENIGN_CANDIDATE, candidateRoot: CANDIDATE_ROOT });

  assert.equal(result.passed, true);
  assert.deepEqual(result.specifiers, []);
  assert.deepEqual(result.capabilities, []);
});

test('a guard rejection reports every rule that fired, not just the first', () => {
  const source = `
    import { readFileSync } from 'node:fs';
    import { execSync } from 'node:child_process';
    export const run = () => execSync(readFileSync(process.env.CONFIG, 'utf8'));
  `;
  const result = scanCandidate({ source, candidateRoot: CANDIDATE_ROOT });

  assert.equal(result.passed, false);
  const rules = new Set(result.imports.violations.map((violation) => violation.rule));
  assert.deepEqual([...rules].sort(), ['capability-filesystem', 'capability-process']);
  assert.throws(
    () => assertCandidateAccepted({ source, candidateRoot: CANDIDATE_ROOT }),
    /candidate rejected by \d+ guard rule\(s\)/
  );
});

test('scanning is deterministic and holds no state between candidates', () => {
  const malicious = "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;";

  // The benign candidate must not inherit the previous verdict.
  assert.equal(runAstGuard(malicious).passed, false);
  assert.equal(runAstGuard(malicious).passed, false);
  assert.equal(scanCandidate({ source: BENIGN_CANDIDATE, candidateRoot: CANDIDATE_ROOT }).passed, true);
});

test('the pipeline refuses a candidate before the evaluator sees it', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const rejected = MALICIOUS_CANDIDATES[0];
    await assert.rejects(
      runEpisodePipeline({
        task: {
          taskId: 'task-1',
          goal: 'reach x=1',
          environmentId: MOCK_ENVIRONMENT_ID,
          policyVersion: 'policy-v1',
          budget: { maxSteps: 2, wallClockMs: 30_000 },
          metadata: {}
        },
        episodeId: 'episode-1',
        sessionId: SESSION_ID,
        adapter: runtime.adapter,
        store: runtime.store,
        policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
        settings: pipelineSettings(runtime),
        candidateSource: { source: rejected.source, candidateRoot: CANDIDATE_ROOT }
      }),
      /candidate rejected by/
    );

    const accepted = await runEpisodePipeline({
      task: {
        taskId: 'task-1',
        goal: 'reach x=1',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'policy-v1',
        budget: { maxSteps: 2, wallClockMs: 30_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: SESSION_ID,
      adapter: runtime.adapter,
      store: runtime.store,
      policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
      isGoalReached: (observation) => observation.pose.x >= 1,
      settings: pipelineSettings(runtime),
      candidateSource: { source: BENIGN_CANDIDATE, candidateRoot: CANDIDATE_ROOT }
    });
    assert.equal(accepted.outcome.episode.status, 'completed');
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------- evaluator isolation

test('the isolated evaluator returns a validated result for an honest worker', async () => {
  const result = await evaluateReplayIsolated(probe('ok'), undefined, options());

  assert.deepEqual(result, { quality: 1, cost: 0, parallelEfficiency: 0, missRate: 0, score: 1 });
});

test('a malformed result is rejected rather than cast', async () => {
  await assert.rejects(
    evaluateReplayIsolated(probe('bad-schema'), undefined, options()),
    /invalid quality/
  );
});

test('captured output is bounded and the worker is killed on overflow', async () => {
  await assert.rejects(
    evaluateReplayIsolated(probe('noisy'), undefined, options({ maxOutputBytes: 1024 })),
    /exceeded maxOutputBytes/
  );
});

test('the child cannot read host secrets from the environment', async () => {
  process.env.DREAM_RSI_TEST_SECRET = 'must-not-leak';
  try {
    const result = await evaluateReplayIsolated(probe('env-probe'), undefined, options());
    // The probe reports 999 if it saw the variable.
    assert.equal(result.quality, 1);
  } finally {
    delete process.env.DREAM_RSI_TEST_SECRET;
  }
});

test('an explicit environment is passed through when the host asks for one', async () => {
  const result = await evaluateReplayIsolated(
    probe('env-probe'),
    undefined,
    options({ env: { PATH: process.env.PATH, DREAM_RSI_TEST_SECRET: 'intentional' } })
  );

  assert.equal(result.quality, 999);
});

test('a confined child cannot write to the filesystem', async () => {
  const target = join(tmpdir(), `dream-rsi-confined-${process.pid}.txt`);
  try {
    const result = await evaluateReplayIsolated(probe('write-probe', { target }), undefined, options());

    assert.equal(result.quality, 1, 'the write should have been denied');
    assert.equal(existsSync(target), false, 'nothing should have been written');
  } finally {
    rmSync(target, { force: true });
  }
});

test('a confined child cannot spawn a process', async () => {
  const result = await evaluateReplayIsolated(probe('spawn-probe'), undefined, options());

  // Confinement is what bounds process count: with no child_process grant there
  // is nothing to fork, before the process-group kill even matters.
  assert.equal(result.quality, 1, 'the spawn should have been denied');
});

test('a host that cannot use the permission flag can disable confinement explicitly', async () => {
  const target = join(tmpdir(), `dream-rsi-unconfined-${process.pid}.txt`);
  try {
    const result = await evaluateReplayIsolated(
      probe('write-probe', { target }),
      undefined,
      options({ confinement: false })
    );

    assert.equal(result.quality, 0, 'the write should have been allowed');
    assert.equal(readFileSync(target, 'utf8'), 'confined write');
  } finally {
    rmSync(target, { force: true });
  }
});

test('cancellation terminates the run', async () => {
  const controller = new AbortController();
  const pending = evaluateReplayIsolated(probe('hang'), undefined, options({ timeoutMs: 30_000, signal: controller.signal }));
  controller.abort();

  await assert.rejects(pending, /cancelled/);
});

test('an already-aborted signal never starts a worker', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    evaluateReplayIsolated(probe('ok'), undefined, options({ signal: controller.signal })),
    /cancelled before start/
  );
});

test('a deadline kills the child and everything it spawned', async () => {
  const pidFile = join(tmpdir(), `dream-rsi-grandchild-${process.pid}-${Date.now()}.pid`);
  try {
    await assert.rejects(
      evaluateReplayIsolated(probe('spawn-child', { pidFile }), undefined, unconfinedOptions({ timeoutMs: 400 })),
      /timed out/
    );

    const grandchildPid = await waitForPid(pidFile);
    assert.ok(grandchildPid > 0, 'the fixture never reported its grandchild');
    // Killing only the direct child would leave this process running.
    assert.equal(await waitForExit(grandchildPid), true, `grandchild ${grandchildPid} outlived the deadline`);
  } finally {
    rmSync(pidFile, { force: true });
  }
});

async function waitForPid(pidFile) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(pidFile)) return Number(readFileSync(pidFile, 'utf8'));
    await delay(20);
  }
  return -1;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isRunning(pid)) return true;
    await delay(20);
  }
  return false;
}
