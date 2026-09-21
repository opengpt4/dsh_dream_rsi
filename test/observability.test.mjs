import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregate,
  rate,
  tCritical95,
  DeploymentWriter,
  InMemoryAuditLog,
  InMemoryMetrics,
  InMemoryPolicyRegistryStore,
  MOCK_ENVIRONMENT_ID,
  PolicyRegistry,
  SingleWriterLock,
  buildObservabilityReport,
  createDreamRsiRuntime,
  createEvaluationReport,
  createPolicyArtifact,
  evaluateCandidate,
  hashDreamRsiConfig,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisodePipeline,
  summarizeCanary
} from '../dist/index.js';
import { BENIGN_CANDIDATE } from './fixtures/malicious-candidates.mjs';

const AT = '2026-01-01T00:00:00.000Z';
const CONFIG_HASH = 'c'.repeat(64);
const THRESHOLDS = { minQuality: 0.5, maxErrorRate: 0.1, maxLatencyMs: 1_000, maxCost: 1, maxMissRate: 0.05 };
const CANARY = summarizeCanary({ quality: 1, errorRate: 0, latencyMs: 10, cost: 0.1, missRate: 0 }, THRESHOLDS, AT);
const APPROVAL = { approvalId: 'approval-1', operator: 'operator-1', decision: 'approved', decidedAt: AT };

// -------------------------------------------------------------------- metrics

test('metrics group by canonical labels, so key order does not split a group', () => {
  const metrics = new InMemoryMetrics(() => new Date(AT));
  metrics.record('evaluation.score', 0.5, { taskId: 'task-1', episodeId: 'ep-1' });
  metrics.record('evaluation.score', 1.5, { episodeId: 'ep-1', taskId: 'task-1' });
  metrics.record('evaluation.score', 2, { taskId: 'task-2' });

  const summary = metrics.summary();
  assert.equal(summary.length, 2);
  const first = summary.find((entry) => entry.labels.taskId === 'task-1');
  assert.deepEqual(
    { count: first.count, total: first.total, min: first.min, max: first.max, mean: first.mean },
    { count: 2, total: 2, min: 0.5, max: 1.5, mean: 1 }
  );
  assert.equal(metrics.total('evaluation.score', { taskId: 'task-1', episodeId: 'ep-1' }), 2);
  assert.equal(metrics.total('evaluation.score', { taskId: 'nobody' }), 0);
});

test('a non-finite metric is refused rather than poisoning every aggregate', () => {
  const metrics = new InMemoryMetrics();
  assert.throws(() => metrics.record('evaluation.score', Number.NaN), /must be finite/);
  assert.throws(() => metrics.record('evaluation.score', Number.POSITIVE_INFINITY), /must be finite/);
  assert.deepEqual(metrics.summary(), []);
});

test('undefined labels are dropped so they do not create a phantom group', () => {
  const metrics = new InMemoryMetrics();
  metrics.record('replay.hit', 1, { taskId: 'task-1', episodeId: undefined });
  metrics.record('replay.hit', 1, { taskId: 'task-1' });

  assert.equal(metrics.summary().length, 1);
  assert.equal(metrics.total('replay.hit', { taskId: 'task-1' }), 2);
});

// --------------------------------------------------------- pipeline recording

function harness() {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const metrics = new InMemoryMetrics(() => new Date(AT));
  return { runtime, registry, metrics };
}

function options(runtime, registry, metrics, artifact, overrides = {}) {
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
    metrics,
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

function artifactFor(registry) {
  const artifact = createPolicyArtifact({
    version: 'v1',
    parentVersion: null,
    source: BENIGN_CANDIDATE,
    manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: AT
  });
  registry.registerPolicy(artifact);
  return artifact;
}

test('a run records correlation-tagged samples for every observable it produced', async () => {
  const { runtime, registry, metrics } = harness();
  try {
    const artifact = artifactFor(registry);
    const result = await runEpisodePipeline(options(runtime, registry, metrics, artifact));

    // Every sample is traceable back to the run that produced it.
    for (const sample of metrics.list()) {
      assert.equal(sample.labels.taskId, 'task-1');
      assert.equal(sample.labels.episodeId, 'episode-1');
      assert.equal(sample.labels.policyVersion, 'v1');
      assert.equal(sample.labels.taskFamily, 'mock-room');
      assert.equal(sample.labels.evaluationId, result.report.evaluationId);
    }

    const labels = { taskId: 'task-1', episodeId: 'episode-1', policyVersion: 'v1', taskFamily: 'mock-room', evaluationId: result.report.evaluationId };
    assert.equal(metrics.total('task.outcome', { ...labels, outcome: 'completed' }), 1);
    assert.equal(metrics.total('evaluation.score', labels), result.evaluation.score);
    assert.equal(metrics.total('replay.hit', labels), result.replay.hitCount);
    assert.equal(metrics.total('episode.stepCount', labels), 1);
  } finally {
    runtime.dispose();
  }
});

test('a run without a metrics sink records nothing rather than failing', async () => {
  const { runtime, registry } = harness();
  try {
    const artifact = artifactFor(registry);
    const result = await runEpisodePipeline(options(runtime, registry, undefined, artifact));
    assert.equal(result.outcome.episode.status, 'completed');
  } finally {
    runtime.dispose();
  }
});

// --------------------------------------------------------------------- report

test('the report carries Q/C/P/M/S per evaluation with a per-family breakdown', async () => {
  const { runtime, registry, metrics } = harness();
  try {
    const artifact = artifactFor(registry);
    const result = await runEpisodePipeline(options(runtime, registry, metrics, artifact));

    const report = buildObservabilityReport({ registry, metrics, generatedAt: AT });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.generatedAt, AT);
    assert.equal(report.policyArtifactCount, 1);
    assert.equal(report.currentPolicyArtifactId, null);
    assert.equal(report.evaluations.length, 1);

    const entry = report.evaluations[0];
    // Q, C, P, M, S are all reported, not just the score.
    assert.deepEqual(Object.keys(entry.metrics).sort(), ['cost', 'missRate', 'parallelEfficiency', 'quality', 'score']);
    assert.equal(entry.split, 'validation');
    assert.equal(entry.caseCount, 1);
    assert.equal(entry.passedCaseCount, 1);
    // Per-family Q, C, latency, and miss rate, each with its sample count. One
    // sample has a mean but no interval, which is reported as null rather than
    // as a zero-width claim.
    assert.deepEqual(entry.families, [
      {
        taskFamily: 'mock-room',
        caseCount: 1,
        passedCount: 1,
        quality: { sampleCount: 1, mean: result.evaluation.quality, min: result.evaluation.quality, max: result.evaluation.quality, lower: null, upper: null },
        cost: { sampleCount: 1, mean: result.evaluation.cost, min: result.evaluation.cost, max: result.evaluation.cost, lower: null, upper: null },
        latencyMs: entry.families[0].latencyMs,
        missRate: { sampleCount: 1, mean: 0, min: 0, max: 0, lower: null, upper: null },
        rejectionSummary: []
      }
    ]);
    assert.equal(entry.families[0].latencyMs.sampleCount, 1);
    assert.ok(report.metrics.length > 0);

    // Machine-readable: a consumer can serialize and reparse it unchanged.
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  } finally {
    runtime.dispose();
  }
});

test('the report lists deployment history including the path taken', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = artifactFor(registry);
  const report = createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: artifact.sourceSha256,
    snapshotId: 'b'.repeat(64),
    policyArtifactId: artifact.artifactId,
    split: 'holdout',
    configHash: CONFIG_HASH,
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [{ caseId: 'c1', taskFamily: 'packing', split: 'holdout', outcome: 'passed', quality: 1, score: 1 }],
    sampleCount: 1,
    passed: true,
    guardResults: [],
    createdAt: AT
  });
  registry.registerEvaluation(report);

  const writer = new DeploymentWriter({
    registry,
    lock: new SingleWriterLock('/tmp/dream-rsi-obs.lock', 30_000),
    audit: new InMemoryAuditLog(),
    principal: { principalId: 'operator-1', roles: ['admin'] },
    signatureVerifier: { verify: () => true }
  });
  const proposed = writer.propose({
    policyArtifactId: artifact.artifactId,
    evaluationId: report.evaluationId,
    holdoutGate: { passed: true, candidateEvaluationId: report.evaluationId }
  });
  writer.decide(proposed.deploymentId, APPROVAL);
  writer.startCanary(proposed.deploymentId);
  writer.completeCanary(proposed.deploymentId, { quality: 1, errorRate: 0, latencyMs: 1, cost: 0.1, missRate: 0 }, THRESHOLDS);

  const built = buildObservabilityReport({ registry, generatedAt: AT });
  assert.equal(built.currentPolicyArtifactId, artifact.artifactId);
  assert.deepEqual(built.deployments[0].history, ['PROPOSED', 'APPROVED', 'CANARY', 'ACTIVE']);
});

// ------------------------------------------------------- emergency stop audit

test('an operator stop is written to the audit trail', () => {
  const audit = new InMemoryAuditLog();
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }), { audit });
  try {
    runtime.guard.emergencyStop('session-1', 'operator pressed stop');

    const [event] = audit.list();
    assert.equal(event.type, 'action.emergency-stop');
    assert.equal(event.subject, 'session');
    assert.equal(event.subjectId, 'session-1');
    assert.equal(event.reason, 'operator pressed stop');
    assert.match(event.eventId, /^[0-9a-f]{64}$/);
    assert.equal(runtime.audit, audit);
  } finally {
    runtime.dispose();
  }
});

// ------------------------------------------------ online survives offline failure

test('online task execution continues when offline evolution fails', async () => {
  const { runtime, registry, metrics } = harness();
  try {
    const artifact = artifactFor(registry);

    const first = await runEpisodePipeline(options(runtime, registry, metrics, artifact));
    assert.equal(first.outcome.episode.status, 'completed');

    // The provider goes away mid-generation.
    const outage = await evaluateCandidate({
      llm: {
        async invoke() {
          throw new Error('provider outage: connection reset');
        }
      },
      generation: {
        parent: artifact,
        parentSource: BENIGN_CANDIDATE,
        trainMetrics: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 },
        validationMetrics: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 },
        seed: 'seed-1',
        model: 'deepseek-v4-flash',
        correlationId: 'correlation-1'
      },
      registry,
      evaluate: async () => {
        throw new Error('should not be reached');
      }
    }).then(
      () => 'resolved',
      (error) => error.message
    );
    assert.match(outage, /provider outage/);

    // Online execution is unaffected by the offline failure.
    const second = await runEpisodePipeline(
      options(runtime, registry, metrics, artifact, { episodeId: 'episode-2', sessionId: 'session-2' })
    );
    assert.equal(second.outcome.episode.status, 'completed');

    // The outage left no trace in the registry beyond the policy already there.
    assert.equal(registry.policyCount(), 1);
    assert.equal(registry.currentPolicyArtifactId(), null);
    assert.equal(registry.evaluationCount(), 2);
  } finally {
    runtime.dispose();
  }
});

// -------------------------------------------------------------- statistics

test('a single sample reports a mean but no confidence interval', () => {
  const one = aggregate([0.8]);
  assert.deepEqual(one, { sampleCount: 1, mean: 0.8, min: 0.8, max: 0.8, lower: null, upper: null });

  // Claiming a zero-width interval would assert a precision one sample cannot support.
  assert.equal(aggregate([]).sampleCount, 0);
  assert.equal(aggregate([]).lower, null);
});

test('a multi-sample aggregate carries a confidence interval around the mean', () => {
  const result = aggregate([0.8, 0.9, 1, 0.7, 0.6]);

  assert.equal(result.sampleCount, 5);
  assert.equal(result.mean, 0.8);
  assert.equal(result.min, 0.6);
  assert.equal(result.max, 1);
  assert.ok(result.lower < 0.8 && result.upper > 0.8);
  // A wider spread must widen the interval, or it is not measuring uncertainty.
  const tight = aggregate([0.8, 0.8, 0.8, 0.8, 0.8]);
  assert.equal(tight.upper - tight.lower, 0);
});

test('small samples use a t critical value rather than 1.96', () => {
  assert.equal(tCritical95(1), 12.706);
  assert.equal(tCritical95(4), 2.776);
  assert.equal(tCritical95(30), 2.042);
  assert.equal(tCritical95(100), 1.96);
  assert.throws(() => tCritical95(0), /positive integer/);

  // How much wider the t interval is than the z interval at the same sample
  // size — the sqrt(n) factors cancel, so this is t/1.96. These are the
  // magnitudes statistics.ts and the design spec quote, so a change to the
  // table has to change the prose with it.
  const ratio = (sampleCount) => Number((tCritical95(sampleCount - 1) / 1.96).toFixed(1));
  assert.equal(ratio(3), 2.2);
  assert.equal(ratio(5), 1.4);
  // Past the table the fallback is within 4%, which is why it costs nothing.
  assert.ok(Math.abs(tCritical95(31) / 1.96 - 1) < 0.04);
});

test('a miss flag a case never recorded is absent from the family miss rate', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = artifactFor(registry);
  const report = createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: artifact.sourceSha256,
    snapshotId: 'b'.repeat(64),
    policyArtifactId: artifact.artifactId,
    split: 'holdout',
    configHash: CONFIG_HASH,
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [
      { caseId: 'recorded', taskFamily: 'packing', split: 'holdout', outcome: 'passed', quality: 1, score: 1, missed: true },
      // No `missed`: scoring it as a clean replay would report a rate these
      // cases never supported.
      { caseId: 'unrecorded', taskFamily: 'packing', split: 'holdout', outcome: 'passed', quality: 1, score: 1 }
    ],
    sampleCount: 2,
    passed: true,
    guardResults: [],
    createdAt: AT
  });
  registry.registerEvaluation(report);

  const family = buildObservabilityReport({ registry, generatedAt: AT }).evaluations[0].families[0];

  assert.equal(family.caseCount, 2);
  assert.equal(family.missRate.sampleCount, 1);
  assert.equal(family.missRate.mean, 1);
  // The quantity's own sample count is what says how much it rests on.
  assert.equal(family.quality.sampleCount, 2);
});

test('a family that never recorded a miss flag reports no miss rate', () => {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const artifact = artifactFor(registry);
  registry.registerEvaluation(
    createEvaluationReport({
      evaluatorVersion: '0.1.0',
      sourceHash: artifact.sourceSha256,
      snapshotId: 'b'.repeat(64),
      policyArtifactId: artifact.artifactId,
      split: 'holdout',
      configHash: CONFIG_HASH,
      metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
      caseResults: [{ caseId: 'c1', taskFamily: 'navigation', split: 'holdout', outcome: 'passed', quality: 1, score: 1 }],
      sampleCount: 1,
      passed: true,
      guardResults: [],
      createdAt: AT
    })
  );

  const family = buildObservabilityReport({ registry, generatedAt: AT }).evaluations[0].families[0];

  // No samples, so no rate and no interval — not a clean zero.
  assert.deepEqual(family.missRate, { sampleCount: 0, mean: 0, min: 0, max: 0, lower: null, upper: null });
});

test('a non-finite sample is refused rather than widening every interval silently', () => {
  assert.throws(() => aggregate([1, Number.NaN]), /non-finite/);
  assert.throws(() => aggregate([Number.POSITIVE_INFINITY]), /non-finite/);
});

test('a rate is the mean of a boolean series', () => {
  const result = rate([true, false, false, false]);
  assert.equal(result.mean, 0.25);
  assert.equal(result.sampleCount, 4);
});
