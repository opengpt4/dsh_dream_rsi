import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FilePolicyRegistryStore,
  InMemoryPolicyRegistryStore,
  MOCK_ENVIRONMENT_ID,
  PolicyRegistry,
  advanceDeployment,
  createDreamRsiRuntime,
  createEvaluationReport,
  createPolicyArtifact,
  evaluateHoldoutGate,
  hashDreamRsiConfig,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  sealDeployment,
  runEpisodePipeline,
  summarizeCanary,
  summarizeCaseResults,
  verifyDeployment,
  verifyEvaluationReport,
  verifyPolicyArtifact
} from '../dist/index.js';
import { BENIGN_CANDIDATE, MALICIOUS_CANDIDATES } from './fixtures/malicious-candidates.mjs';

const AT = '2026-01-01T00:00:00.000Z';

function policy(overrides = {}) {
  return createPolicyArtifact({
    version: 'v1',
    parentVersion: null,
    source: 'export const decide = () => 1;',
    manifest: { entrypoint: 'src/policy.ts', dependencies: ['typescript'], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: AT,
    ...overrides
  });
}

function report(artifactId, overrides = {}) {
  return createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    policyArtifactId: artifactId,
    split: 'validation',
    configHash: 'c'.repeat(64),
    metrics: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [],
    sampleCount: 1,
    passed: true,
    guardResults: [],
    createdAt: AT,
    ...overrides
  });
}

const APPROVAL = {
  approvalId: 'approval-1',
  operator: 'operator-1',
  decision: 'approved',
  decidedAt: AT
};

const THRESHOLDS = {
  minQuality: 0.5,
  maxErrorRate: 0.1,
  maxLatencyMs: 1_000,
  maxCost: 1,
  maxMissRate: 0.05
};

const CANARY = summarizeCanary(
  { quality: 1, errorRate: 0, latencyMs: 10, cost: 0.1, missRate: 0 },
  THRESHOLDS,
  AT
);

/** A promotion rests on gate evidence covering the exact evaluation it deploys. */
function promotion(evaluationId, overrides = {}) {
  return {
    evaluationId,
    holdoutGate: { passed: true, candidateEvaluationId: evaluationId },
    approval: APPROVAL,
    canary: CANARY,
    ...overrides
  };
}

function registryState(registry) {
  return {
    policies: registry.policyCount(),
    evaluations: registry.evaluationCount(),
    deployments: registry.listDeployments().length,
    current: registry.currentPolicyArtifactId()
  };
}

// ------------------------------------------------------------------- models

test('a policy artifact id covers its content and ignores creation time', () => {
  const first = policy();
  const second = policy({ createdAt: '2030-06-06T06:06:06.000Z' });

  assert.equal(first.artifactId, second.artifactId);
  assert.equal(first.createdAt, AT);
  assert.match(first.artifactId, /^[0-9a-f]{64}$/);
  assert.equal(verifyPolicyArtifact(first), true);

  const other = policy({ version: 'v2', parentVersion: 'v1' });
  assert.notEqual(other.artifactId, first.artifactId);
});

test('a policy artifact whose body was altered no longer matches its id', () => {
  const original = policy();
  assert.equal(verifyPolicyArtifact({ ...original, allowedCapabilities: ['everything'] }), false);
  assert.equal(verifyPolicyArtifact({ ...original, sourceSha256: 'f'.repeat(64) }), false);
  assert.equal(verifyPolicyArtifact({ ...original, parentVersion: 'v0' }), false);
});

test('an evaluation report id covers its metrics and case results', () => {
  const artifact = policy();
  const first = report(artifact.artifactId);
  const same = report(artifact.artifactId, { createdAt: '2031-01-01T00:00:00.000Z' });

  assert.equal(first.evaluationId, same.evaluationId);
  assert.equal(verifyEvaluationReport(first), true);
  assert.equal(verifyEvaluationReport({ ...first, passed: false }), false);
  assert.equal(
    verifyEvaluationReport({ ...first, metrics: { ...first.metrics, quality: 99 } }),
    false
  );
  // The split decides whether a report is holdout evidence at all, and the gate's
  // first check is that it says holdout. Leaving it out of the body would let a
  // train report be relabelled and still verify.
  assert.equal(verifyEvaluationReport({ ...first, split: 'train' }), false);
  assert.equal(verifyEvaluationReport({ ...first, sampleCount: 99 }), false);
  assert.equal(verifyEvaluationReport({ ...first, guardResults: [{ guard: 'x', passed: false }] }), false);
});

test('a report cannot claim another report\'s id', () => {
  const artifact = policy();
  const honest = report(artifact.artifactId);
  // The parameter type omits `evaluationId`, but an untyped caller can pass it.
  const impostor = report(artifact.artifactId, { passed: false, evaluationId: honest.evaluationId });

  assert.notEqual(impostor.evaluationId, honest.evaluationId);
  assert.equal(impostor.evaluationId, report(artifact.artifactId, { passed: false }).evaluationId);
  assert.equal(verifyEvaluationReport(impostor), true);

  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  registry.registerPolicy(artifact);
  registry.registerEvaluation(impostor);
  assert.equal(registry.evaluation(impostor.evaluationId)?.passed, false);
  // A record edited after construction is still refused, because the id no
  // longer covers the content.
  assert.throws(() => registry.registerEvaluation({ ...honest, passed: false }), /does not match its content/);
});

test('policy artifact input is validated before an id is computed', () => {
  assert.throws(() => policy({ version: '  ' }), /version must not be empty/);
  assert.throws(() => policy({ manifest: { entrypoint: '', dependencies: [], schemaVersion: 1 } }), /entrypoint must not be empty/);
  assert.throws(() => policy({ manifest: { entrypoint: 'a.ts', dependencies: [], schemaVersion: 0 } }), /positive integer/);
  assert.throws(() => policy({ version: 'v1', parentVersion: 'v1' }), /parentVersion must differ/);
});

test('a canary names the thresholds it breached', () => {
  const clean = summarizeCanary({ quality: 1, errorRate: 0, latencyMs: 5, cost: 0.1, missRate: 0 }, THRESHOLDS, AT);
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.failures, []);

  const breached = summarizeCanary(
    { quality: 0.1, errorRate: 0.5, latencyMs: 5_000, cost: 9, missRate: 0.9 },
    THRESHOLDS,
    AT
  );
  assert.equal(breached.passed, false);
  assert.deepEqual(breached.failures, ['quality', 'errorRate', 'latencyMs', 'cost', 'missRate']);
});

test('case results are summarised by task family with reasons by frequency', () => {
  const summary = summarizeCaseResults([
    { caseId: 'a1', taskFamily: 'packing', split: 'train', outcome: 'passed' },
    { caseId: 'a2', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: 'timeout' },
    { caseId: 'a3', taskFamily: 'packing', split: 'validation', outcome: 'failed', reason: 'timeout' },
    { caseId: 'a4', taskFamily: 'packing', split: 'validation', outcome: 'error', reason: 'worker crash' },
    { caseId: 'b1', taskFamily: 'navigation', split: 'train', outcome: 'failed' }
  ]);

  assert.deepEqual(
    summary.map((entry) => entry.taskFamily),
    ['navigation', 'packing']
  );
  assert.deepEqual(summary[1], {
    taskFamily: 'packing',
    caseCount: 4,
    passedCount: 1,
    reasons: [
      { reason: 'timeout', count: 2 },
      { reason: 'worker crash', count: 1 }
    ]
  });
  // A failure with no recorded reason is still counted, under an explicit label.
  assert.deepEqual(summary[0].reasons, [{ reason: '(unspecified)', count: 1 }]);
});

test('reason frequency order does not depend on the reason text', () => {
  // Keyed by reason, a plain object would order integer-like keys ascending and
  // put a single '404' ahead of three 'timeout's.
  const summary = summarizeCaseResults([
    { caseId: 'a', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: 'timeout' },
    { caseId: 'b', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: 'timeout' },
    { caseId: 'c', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: 'timeout' },
    { caseId: 'd', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: '404' },
    { caseId: 'e', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: '404' },
    { caseId: 'f', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: 'alpha' },
    { caseId: 'g', taskFamily: 'packing', split: 'train', outcome: 'failed', reason: 'beta' }
  ]);

  assert.deepEqual(summary[0].reasons, [
    { reason: 'timeout', count: 3 },
    { reason: '404', count: 2 },
    // Equal counts fall back to the reason, so the order is total.
    { reason: 'alpha', count: 1 },
    { reason: 'beta', count: 1 }
  ]);
});

// ----------------------------------------------------------------- registry

test('registering the same artifact twice is idempotent', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();

  assert.deepEqual(registry.registerPolicy(artifact), artifact);
  assert.deepEqual(registry.registerPolicy(policy({ createdAt: '2030-01-01T00:00:00.000Z' })), artifact);
  assert.equal(registry.policyCount(), 1);
});

test('the registry refuses an artifact that does not match its own id', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const tampered = { ...policy(), allowedCapabilities: ['everything'] };

  assert.throws(() => registry.registerPolicy(tampered), /does not match its content/);
  assert.equal(registry.policyCount(), 0);
});

test('an evaluation cannot reference an unregistered policy', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());

  assert.throws(() => registry.registerEvaluation(report('f'.repeat(64))), /unregistered policy/);
  assert.equal(registry.evaluationCount(), 0);
});

test('a deployment requires a registered, passing evaluation of that artifact', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);

  assert.throws(
    () => registry.promotePolicy(artifact.artifactId, promotion('nope')),
    /unknown evaluation/
  );

  const failing = report(artifact.artifactId, { passed: false });
  registry.registerEvaluation(failing);
  assert.throws(
    () => registry.promotePolicy(artifact.artifactId, promotion(failing.evaluationId)),
    /did not pass/
  );
});

test('a deployment requires an approval and a passing canary', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);
  const passing = report(artifact.artifactId);
  registry.registerEvaluation(passing);

  assert.throws(
    () =>
      registry.promotePolicy(
        artifact.artifactId,
        promotion(passing.evaluationId, { approval: { ...APPROVAL, decision: 'rejected' } })
      ),
    /was not approved/
  );

  const failedCanary = summarizeCanary({ quality: 0, errorRate: 0, latencyMs: 0, cost: 0, missRate: 0 }, THRESHOLDS, AT);
  assert.throws(
    () =>
      registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { canary: failedCanary })),
    /failed canary: quality/
  );
});

test('a promotion requires a passing holdout gate over the evaluation it deploys', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);
  const passing = report(artifact.artifactId);
  registry.registerEvaluation(passing);

  assert.throws(
    () => registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { holdoutGate: { passed: false, candidateEvaluationId: passing.evaluationId } })),
    /failed the holdout gate/
  );
  // A gate verdict taken over some other evaluation cannot justify this one.
  assert.throws(
    () => registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { holdoutGate: { passed: true, candidateEvaluationId: 'other' } })),
    /does not cover evaluation/
  );
  assert.equal(registry.currentPolicyArtifactId(), null);
});

test('every rejected promotion leaves the registry exactly as it was', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  const other = policy({ version: 'v2', parentVersion: 'v1' });
  registry.registerPolicy(artifact);
  registry.registerPolicy(other);
  const passing = report(artifact.artifactId);
  registry.registerEvaluation(passing);
  const before = registryState(registry);

  const failedCanary = summarizeCanary({ quality: 0, errorRate: 0, latencyMs: 0, cost: 0, missRate: 0 }, THRESHOLDS, AT);
  const attempts = [
    () => registry.promotePolicy('f'.repeat(64), promotion(passing.evaluationId)),
    () => registry.promotePolicy(artifact.artifactId, promotion('missing')),
    () => registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { holdoutGate: { passed: false, candidateEvaluationId: passing.evaluationId } })),
    () => registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { holdoutGate: { passed: true, candidateEvaluationId: 'other-evaluation' } })),
    () => registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { approval: { ...APPROVAL, decision: 'rejected' } })),
    () => registry.promotePolicy(artifact.artifactId, promotion(passing.evaluationId, { canary: failedCanary }))
  ];

  for (const attempt of attempts) {
    assert.throws(attempt);
    assert.deepEqual(registryState(registry), before);
  }
});

test('a successful promotion records a deployment and moves the pointer', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);
  registry.registerEvaluation(report(artifact.artifactId));

  assert.equal(registry.currentPolicyArtifactId(), null);
  const deployment = registry.promotePolicy(
    artifact.artifactId,
    promotion(registry.evaluationsFor(artifact.artifactId)[0].evaluationId)
  );

  assert.equal(deployment.state, 'ACTIVE');
  assert.equal(deployment.rollbackTarget, null);
  assert.equal(deployment.policyArtifactId, artifact.artifactId);
  assert.equal(registry.currentPolicyArtifactId(), artifact.artifactId);
  assert.deepEqual(registry.listDeployments(), [deployment]);
});

test('a second promotion points its rollback target at the version it replaced', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const first = policy();
  const second = policy({ version: 'v2', parentVersion: 'v1' });
  for (const artifact of [first, second]) {
    registry.registerPolicy(artifact);
    registry.registerEvaluation(report(artifact.artifactId));
  }

  registry.promotePolicy(first.artifactId, promotion(registry.evaluationsFor(first.artifactId)[0].evaluationId));
  const second2 = registry.promotePolicy(
    second.artifactId,
    promotion(registry.evaluationsFor(second.artifactId)[0].evaluationId, {
      approval: { ...APPROVAL, approvalId: 'approval-2' }
    })
  );

  assert.equal(second2.rollbackTarget, first.artifactId);
  assert.equal(registry.currentPolicyArtifactId(), second.artifactId);
  assert.equal(registry.latestDeployment().deploymentId, second2.deploymentId);
});

// -------------------------------------------------------------- persistence

test('the registry round-trips through a file, pointer included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-registry-'));
  try {
    const first = new PolicyRegistry(new FilePolicyRegistryStore(dir));
    const artifact = policy();
    first.registerPolicy(artifact);
    first.registerEvaluation(report(artifact.artifactId));
    first.promotePolicy(artifact.artifactId, promotion(first.evaluationsFor(artifact.artifactId)[0].evaluationId));

    const reopened = new PolicyRegistry(new FilePolicyRegistryStore(dir));
    assert.equal(reopened.policyCount(), 1);
    assert.equal(reopened.evaluationCount(), 1);
    assert.equal(reopened.currentPolicyArtifactId(), artifact.artifactId);
    assert.equal(reopened.listDeployments().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered registry record is refused rather than trusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-registry-'));
  try {
    const registry = new PolicyRegistry(new FilePolicyRegistryStore(dir));
    const artifact = policy();
    registry.registerPolicy(artifact);

    const recordPath = join(dir, 'policies', `${artifact.artifactId}.json`);
    const written = JSON.parse(readFileSync(recordPath, 'utf8'));
    written.allowedCapabilities = ['everything'];
    writeFileSync(recordPath, JSON.stringify(written));

    assert.throws(() => new PolicyRegistry(new FilePolicyRegistryStore(dir)), /does not match its content/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A registry holding one promoted policy, and the path to its deployment file. */
function promotedDeploymentOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-registry-'));
  const registry = new PolicyRegistry(new FilePolicyRegistryStore(dir));
  const artifact = policy();
  registry.registerPolicy(artifact);
  registry.registerEvaluation(report(artifact.artifactId));
  const deployment = registry.promotePolicy(
    artifact.artifactId,
    promotion(registry.evaluationsFor(artifact.artifactId)[0].evaluationId)
  );
  return { dir, deployment, recordPath: join(dir, 'deployments', `${deployment.deploymentId}.json`) };
}

test('a deployment record that does not match its content is refused', () => {
  const { dir, recordPath } = promotedDeploymentOnDisk();
  try {
    const written = JSON.parse(readFileSync(recordPath, 'utf8'));
    // The state moves and the history does not follow: a tamper that rewrites
    // what the audit trail says happened without touching any other file.
    written.state = 'ROLLED_BACK';
    writeFileSync(recordPath, JSON.stringify(written));

    assert.throws(
      () => new PolicyRegistry(new FilePolicyRegistryStore(dir)),
      /deployment .* does not match its content/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployment resealed to name a record the registry does not hold is refused', () => {
  const { dir, recordPath } = promotedDeploymentOnDisk();
  try {
    const { recordHash, ...body } = JSON.parse(readFileSync(recordPath, 'utf8'));
    // Sealed, so the hash check passes: only the cross-reference can catch this.
    writeFileSync(recordPath, JSON.stringify(sealDeployment({ ...body, evaluationId: 'f'.repeat(64) })));

    assert.throws(
      () => new PolicyRegistry(new FilePolicyRegistryStore(dir)),
      /names unknown evaluation/
    );

    writeFileSync(recordPath, JSON.stringify(sealDeployment({ ...body, policyArtifactId: 'e'.repeat(64) })));
    assert.throws(
      () => new PolicyRegistry(new FilePolicyRegistryStore(dir)),
      /names unregistered policy/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployment carries a content hash that is restamped on every transition', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);
  registry.registerEvaluation(report(artifact.artifactId));
  const active = registry.promotePolicy(
    artifact.artifactId,
    promotion(registry.evaluationsFor(artifact.artifactId)[0].evaluationId)
  );

  assert.equal(verifyDeployment(active), true);

  const degraded = advanceDeployment(active, 'DEGRADED', { reason: 'latency' }, AT);
  assert.equal(verifyDeployment(degraded), true);
  assert.notEqual(degraded.recordHash, active.recordHash);
  // The record is mutated in place by the hash, not by a field the caller set.
  assert.equal(advanceDeployment(active, 'DEGRADED', { reason: 'latency' }, AT).recordHash, degraded.recordHash);
  assert.equal(verifyDeployment({ ...degraded, reason: 'because' }), false);
});

test('the deployment record hash covers every persisted field', () => {
  // The hash is the record's tamper evidence, and the fields it covers are
  // whatever the body function names. Two of them — `lockOwner` and
  // `rollbackTarget` — could be dropped from it without a single test noticing,
  // so an edit to either went undetected.
  const { dir, recordPath } = promotedDeploymentOnDisk();
  try {
    const body = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(verifyDeployment(body), true);

    const edits = {
      deploymentId: 'deploy-other',
      policyArtifactId: 'a'.repeat(64),
      state: 'DEGRADED',
      history: ['ACTIVE', 'DEGRADED'],
      evaluationId: 'b'.repeat(64),
      approval: null,
      canary: null,
      holdoutGate: null,
      rollbackTarget: 'c'.repeat(64),
      lockOwner: 'someone-else',
      reason: 'added after the fact',
      activatedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z'
    };
    for (const [field, value] of Object.entries(edits)) {
      assert.equal(verifyDeployment({ ...body, [field]: value }), false, `${field} is not covered by the record hash`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edited deployment is refused at the write boundary, not only on load', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);
  registry.registerEvaluation(report(artifact.artifactId));
  const active = registry.promotePolicy(
    artifact.artifactId,
    promotion(registry.evaluationsFor(artifact.artifactId)[0].evaluationId)
  );

  assert.throws(
    () => registry.saveDeployment({ ...active, state: 'ROLLED_BACK' }),
    /does not match its content/
  );
  assert.equal(registry.listDeployments().length, 1);
  assert.equal(registry.latestDeployment().state, 'ACTIVE');
});

test('a tampered evaluation record is refused rather than trusted', () => {
  // The policy tamper test covers the other record kind. A report is the
  // evidence a promotion rests on, so a `passed` flag edited on disk is exactly
  // what the re-verification on load exists to catch — and dropping that check
  // survived every test.
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-registry-'));
  try {
    const registry = new PolicyRegistry(new FilePolicyRegistryStore(dir));
    const artifact = policy();
    registry.registerPolicy(artifact);
    const evaluation = report(artifact.artifactId);
    registry.registerEvaluation(evaluation);

    const recordPath = join(dir, 'evaluations', `${evaluation.evaluationId}.json`);
    const written = JSON.parse(readFileSync(recordPath, 'utf8'));
    written.passed = !written.passed;
    writeFileSync(recordPath, JSON.stringify(written));

    assert.throws(
      () => new PolicyRegistry(new FilePolicyRegistryStore(dir)),
      /evaluation .* does not match its content/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an identity is compared whole, not by prefix', () => {
  // Flipping the last character is enough to show the comparison covers the whole
  // value: a prefix comparison accepts it, while finding a real prefix collision
  // would take 2^32 work. All three verifications passed on an eight-character
  // prefix before this.
  const flipLast = (hex) => hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');

  const artifact = policy();
  assert.equal(verifyPolicyArtifact(artifact), true);
  assert.equal(verifyPolicyArtifact({ ...artifact, artifactId: flipLast(artifact.artifactId) }), false);

  const evaluation = report(artifact.artifactId);
  assert.equal(verifyEvaluationReport(evaluation), true);
  assert.equal(verifyEvaluationReport({ ...evaluation, evaluationId: flipLast(evaluation.evaluationId) }), false);

  const { dir, recordPath } = promotedDeploymentOnDisk();
  try {
    const body = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(verifyDeployment(body), true);
    assert.equal(verifyDeployment({ ...body, recordHash: flipLast(body.recordHash) }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stable version is listed once however many deployments carry it', () => {
  // `stableVersions` answers "which artifacts are stable", so two records of the
  // same artifact are one version. Deduplicating by deployment instead listed it
  // twice, and the existing tests each promote a distinct artifact, so the
  // distinction never came up. Two approvals for one artifact is enough to
  // produce the second deployment.
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = policy();
  registry.registerPolicy(artifact);
  registry.registerEvaluation(report(artifact.artifactId));
  const evaluationId = registry.evaluationsFor(artifact.artifactId)[0].evaluationId;

  registry.promotePolicy(artifact.artifactId, promotion(evaluationId));
  registry.promotePolicy(artifact.artifactId, promotion(evaluationId, { approval: { ...APPROVAL, approvalId: 'approval-2' } }));

  assert.equal(registry.listDeployments().length, 2);
  assert.deepEqual(registry.stableVersions(), [artifact.artifactId]);
});

test('a pointer at an unregistered current policy is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-registry-'));
  try {
    const registry = new PolicyRegistry(new FilePolicyRegistryStore(dir));
    registry.registerPolicy(policy());

    writeFileSync(join(dir, 'current.json'), JSON.stringify({ current: 'f'.repeat(64) }));

    assert.throws(() => new PolicyRegistry(new FilePolicyRegistryStore(dir)), /is not registered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two registries sharing a directory do not drop each other\'s records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-registry-'));
  try {
    // Both load before either writes, which is the clobber case: a single
    // snapshot file would leave only the second writer's records.
    const first = new PolicyRegistry(new FilePolicyRegistryStore(dir));
    const second = new PolicyRegistry(new FilePolicyRegistryStore(dir));

    // Distinct content, so the two artifacts have distinct ids. The helper
    // takes an overrides object, not a version string.
    const a = policy({ version: 'v1' });
    const b = policy({ version: 'v2', parentVersion: 'v1' });
    first.registerPolicy(a);
    second.registerPolicy(b);

    // Nothing is lost: a reader loading afterwards sees both. A live registry
    // holds an in-memory view from its last load or save, so neither writer
    // sees the other's record until it reloads -- the trade for a cached map,
    // and the reason the writer leases exist to keep two writers from racing.
    assert.equal(first.policyCount(), 1);
    assert.equal(second.policyCount(), 1);
    assert.equal(new PolicyRegistry(new FilePolicyRegistryStore(dir)).policyCount(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------- pipeline integration

function pipelineOptions(runtime, registry, artifact, overrides = {}) {
  return {
    task: {
      taskId: 'task-1',
      goal: 'reach x=1',
      environmentId: MOCK_ENVIRONMENT_ID,
      policyVersion: artifact.version,
      budget: { maxSteps: 3, wallClockMs: 30_000 },
      metadata: {}
    },
    episodeId: 'episode-1',
    sessionId: 'session-1',
    adapter: runtime.adapter,
    store: runtime.store,
    policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
    isGoalReached: (observation) => observation.pose.x >= 1,
    settings: pipelineSettings(runtime),
    reporting: {
      registry,
      policyArtifactId: artifact.artifactId,
      evaluatorVersion: '0.1.0',
      sourceHash: artifact.sourceSha256,
      configHash: hashDreamRsiConfig(runtime.config),
      split: 'validation',
      taskFamily: 'mock-room'
    },
    ...overrides
  };
}

test('a completed episode is persisted as an evaluation report', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  try {
    const artifact = policy({ source: BENIGN_CANDIDATE });
    registry.registerPolicy(artifact);

    const result = await runEpisodePipeline(pipelineOptions(runtime, registry, artifact));

    assert.equal(result.outcome.episode.status, 'completed');
    assert.equal(result.report.passed, true);
    assert.equal(result.report.policyArtifactId, artifact.artifactId);
    assert.equal(result.report.snapshotId, result.snapshot.snapshotId);
    assert.equal(result.report.configHash, hashDreamRsiConfig(runtime.config));
    // The holdout evidence, which is what the gate's `minimumHoldoutSamples`
    // floor counts. This one-node episode has no holdout nodes, and the report
    // says so in both places rather than claiming a sample it does not have.
    assert.equal(result.report.sampleCount, result.snapshot.splits.holdout.length);
    assert.equal(result.report.sampleCount, result.gates.holdoutSampleCount);
    assert.equal(result.report.sampleCount, 0);
    assert.match(
      result.report.guardResults.find((guard) => guard.guard === 'holdoutSamples').detail,
      /^0 holdout nodes$/
    );
    assert.deepEqual(result.report.caseResults, [
      {
        caseId: 'episode-1',
        taskFamily: 'mock-room',
        split: 'validation',
        outcome: 'passed',
        // Carried so the report can be gated and summarised per family: a case
        // without per-case metrics cannot support either.
        quality: result.evaluation.quality,
        score: result.evaluation.score,
        cost: result.evaluation.cost,
        latencyMs: result.report.caseResults[0].latencyMs,
        missed: false
      }
    ]);
    assert.ok(result.report.caseResults[0].latencyMs >= 0);
    // The report is registered, so the promotion gate can find it.
    assert.equal(registry.evaluation(result.report.evaluationId).passed, true);
  } finally {
    runtime.dispose();
  }
});

test('a run with sufficient holdout evidence is not rejected for its sample count', async () => {
  // The report's sample count is what the holdout gate's floor counts. Written
  // as the episode's step count instead, a store-backed evaluation resting on
  // many holdout nodes was rejected for having too few samples while the
  // report's own `holdoutSamples` guard said it had enough.
  const runtime = createDreamRsiRuntime(
    resolveDreamRsiConfig({
      storage: { sqlitePath: ':memory:' },
      evaluation: { minimumHoldoutSamples: 3 }
    })
  );
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  try {
    const artifact = policy({ source: BENIGN_CANDIDATE });
    registry.registerPolicy(artifact);

    // Prior work from three tasks, so the snapshot holds holdout evidence the
    // episode itself does not contain.
    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      runtime.store.append({
        nodeId: `seed-${taskId}`,
        taskId,
        parentId: null,
        policyVersion: 'v1',
        environmentVersion: `${MOCK_ENVIRONMENT_ID}@1`,
        stateHash: 'seed-state',
        observationHash: 'seed-observation',
        actionType: 'move_relative',
        actionParams: { dx: 1, dy: 0, dz: 0 },
        result: { actionId: `seed-${taskId}`, status: 'completed' },
        score: 1,
        tokenCost: 0,
        execTimeMs: 1,
        idempotencyKey: `seed-${taskId}`,
        schemaVersion: 1,
        createdAt: AT
      });
    }

    const options = pipelineOptions(runtime, registry, artifact, {
      snapshotSource: 'store',
      splitConfig: { trainRatio: 0, validationRatio: 0, holdoutRatio: 1, seed: 'holdout-only' }
    });
    options.reporting = { ...options.reporting, split: 'holdout' };
    const result = await runEpisodePipeline(options);

    assert.ok(result.snapshot.splits.holdout.length >= 3);
    assert.equal(result.gates.holdoutSufficient, true);
    assert.equal(result.report.sampleCount, result.snapshot.splits.holdout.length);
    // The episode is one step, so a step count here would sit far below the
    // floor while the holdout evidence clears it.
    assert.ok(result.report.sampleCount > result.outcome.nodes.length);

    const candidates = registry.evaluationsFor(artifact.artifactId);
    // The gate thresholds the runtime derives, including the sample floor the
    // pipeline guard above was measured against.
    const gate = evaluateHoldoutGate({
      incumbent: result.report,
      candidate: candidates[0],
      configurationHash: result.report.configHash,
      config: runtime.evaluationSettings.holdoutGate
    });
    assert.ok(
      !gate.reasons.some((reason) => /sample count/.test(reason)),
      `the sample floor should be met by the holdout evidence: ${JSON.stringify(gate.reasons)}`
    );
  } finally {
    runtime.dispose();
  }
});

test('a guard rejection leaves the policy and deployment registries unchanged', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  try {
    const artifact = policy({ source: BENIGN_CANDIDATE });
    registry.registerPolicy(artifact);
    const before = registryState(registry);

    const rejected = MALICIOUS_CANDIDATES[0];
    await assert.rejects(
      runEpisodePipeline(
        pipelineOptions(runtime, registry, artifact, {
          candidateSource: { source: rejected.source, candidateRoot: process.cwd() }
        })
      ),
      /candidate rejected by/
    );

    assert.deepEqual(registryState(registry), before);
    assert.equal(registry.evaluationCount(), 0);
  } finally {
    runtime.dispose();
  }
});
