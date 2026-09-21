import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HOLDOUT_GATE_CONFIG,
  createDreamRsiRuntime,
  resolveDreamRsiConfig,
  createEvaluationReport,
  createPolicyArtifact,
  evaluateCandidate,
  evaluateHoldoutGate
} from '../dist/index.js';

const CONFIG_HASH = 'c'.repeat(64);

/** Build a holdout report whose per-case quality is taken from `qualities`. */
function holdoutReport(qualities, overrides = {}) {
  const caseResults = Object.entries(qualities).map(([caseId, quality], index) => ({
    caseId,
    taskFamily: caseId.split(':')[0],
    split: 'holdout',
    outcome: 'passed',
    quality,
    score: quality,
    ...(index === 0 && overrides.firstReason !== undefined ? { reason: overrides.firstReason } : {})
  }));
  const values = Object.values(qualities);
  return createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    policyArtifactId: 'd'.repeat(64),
    split: overrides.split ?? 'holdout',
    configHash: overrides.configHash ?? CONFIG_HASH,
    metrics: {
      quality: values.length === 0 ? 0 : Math.max(...values),
      cost: overrides.cost ?? 0.1,
      parallelEfficiency: overrides.parallelEfficiency ?? 1,
      missRate: overrides.missRate ?? 0,
      score: values.length === 0 ? 0 : Math.max(...values)
    },
    caseResults,
    sampleCount: overrides.sampleCount ?? values.length,
    passed: true,
    guardResults: overrides.guardResults ?? [],
    createdAt: '2026-01-01T00:00:00.000Z'
  });
}

/** 20 cases across two families, all improving. */
function improving(prefix) {
  const cases = {};
  for (let index = 0; index < 20; index += 1) {
    const family = index < 10 ? 'packing' : 'navigation';
    cases[`${family}:${prefix}-${index}`] = 1;
  }
  return cases;
}

function gateConfig(overrides = {}) {
  return { ...DEFAULT_HOLDOUT_GATE_CONFIG, minimumHoldoutSamples: 1, minimumImprovement: 0, ...overrides };
}

function gate(incumbent, candidate, overrides = {}) {
  return evaluateHoldoutGate({
    incumbent,
    candidate,
    config: gateConfig(overrides.config),
    configurationHash: overrides.configurationHash ?? CONFIG_HASH
  });
}

test('an improving candidate on sufficient holdout evidence passes', () => {
  const incumbent = holdoutReport(improving('base'));
  const candidate = holdoutReport(Object.fromEntries(Object.entries(improving('base')).map(([id, q]) => [id, q + 0.1])));

  const result = gate(incumbent, candidate);

  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.passRatio, 1);
  assert.ok(result.scoreImprovement > 0);
  assert.equal(result.configurationHash, CONFIG_HASH);
  assert.equal(result.candidateEvaluationId, candidate.evaluationId);
  assert.equal(result.incumbentEvaluationId, incumbent.evaluationId);
});

test('the gate result is immutable', () => {
  const incumbent = holdoutReport(improving('base'));
  const result = gate(incumbent, holdoutReport(improving('base')));

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.equal(Object.isFrozen(result.families), true);
  assert.equal(Object.isFrozen(result.families[0].rejectionSummary), true);
});

test('a non-holdout comparison is rejected on both sides', () => {
  const incumbent = holdoutReport(improving('base'));
  const trainCandidate = holdoutReport(improving('base'), { split: 'train' });
  const trainIncumbent = holdoutReport(improving('base'), { split: 'validation' });

  assert.match(gate(incumbent, trainCandidate).reasons.join(' '), /candidate evaluation is on the train split/);
  assert.match(gate(trainIncumbent, incumbent).reasons.join(' '), /incumbent evaluation is on the validation split/);
});

test('reports from a different configuration cannot be compared', () => {
  const incumbent = holdoutReport(improving('base'));
  const other = holdoutReport(improving('base'), { configHash: 'e'.repeat(64) });

  assert.match(gate(incumbent, other).reasons.join(' '), /under the configuration being gated/);
});

test('a quality regression fails regardless of a score gain', () => {
  const incumbent = holdoutReport(improving('base'));
  const regressed = holdoutReport(
    Object.fromEntries(Object.entries(improving('base')).map(([id, q], index) => [id, index < 3 ? q - 0.5 : q + 5]))
  );

  const result = gate(incumbent, regressed);

  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /quality pass ratio is below/);
  assert.equal(result.failedCaseIds.length, 3);
  assert.ok(result.scoreImprovement > 0, 'the score gain does not rescue a quality regression');
});

test('each budget is checked independently', () => {
  const incumbent = holdoutReport(improving('base'));
  const cases = improving('base');

  const overBudget = gate(incumbent, holdoutReport(cases, { cost: 5 }), { config: { maxCost: 1 } });
  assert.match(overBudget.reasons.join(' '), /cost 5 exceeds the maximum of 1/);

  const lowQuality = gate(incumbent, holdoutReport(cases), { config: { minQuality: 2 } });
  assert.match(lowQuality.reasons.join(' '), /quality 1 is below the minimum of 2/);

  const lowParallel = gate(incumbent, holdoutReport(cases, { parallelEfficiency: 0 }), {
    config: { minParallelEfficiency: 0.5 }
  });
  assert.match(lowParallel.reasons.join(' '), /parallel efficiency 0 is below the minimum of 0.5/);

  const tooManyMisses = gate(incumbent, holdoutReport(cases, { missRate: 0.5 }), { config: { maxMissRate: 0.05 } });
  assert.match(tooManyMisses.reasons.join(' '), /miss rate 0.5 exceeds the maximum of 0.05/);

  // A cheap candidate that regresses on every other axis must not pass on cost.
  const cheapButBad = gate(incumbent, holdoutReport(cases, { cost: 0, parallelEfficiency: 0 }), {
    config: { minParallelEfficiency: 1 }
  });
  assert.equal(cheapButBad.passed, false);
});

test('insufficient holdout samples are rejected', () => {
  const incumbent = holdoutReport(improving('base'));
  const candidate = holdoutReport(improving('base'));

  const result = gate(incumbent, candidate, { config: { minimumHoldoutSamples: 50 } });

  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /sample count 20 is below the minimum of 50/);
});

test('a failed guard on the candidate report is rejected', () => {
  const incumbent = holdoutReport(improving('base'));
  const candidate = holdoutReport(improving('base'), {
    guardResults: [
      { guard: 'replayMissRateBudget', passed: true },
      { guard: 'astGuard', passed: false, detail: 'eval' }
    ]
  });

  const result = gate(incumbent, candidate);
  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /failed guard\(s\): astGuard/);
});

test('per-family verdicts are reported and a single family can fail the gate', () => {
  const incumbent = holdoutReport(improving('base'));
  // Navigation improves on every case; packing regresses on half of its ten.
  const candidateCases = Object.fromEntries(
    Object.entries(improving('base')).map(([id, q]) => [id, id.startsWith('packing') && Number(id.split('-').pop()) < 5 ? q - 1 : q + 0.1])
  );

  const result = gate(incumbent, holdoutReport(candidateCases), { config: { minimumPassRatio: 0.95 } });

  assert.equal(result.passed, false);
  assert.deepEqual(result.families.map((family) => family.taskFamily), ['navigation', 'packing']);
  assert.deepEqual(result.families.map((family) => family.passed), [true, false]);
  assert.equal(result.families[1].passedCount, 5);
  assert.equal(result.families[1].passRatio, 0.5);
  assert.match(result.reasons.join(' '), /task family packing pass ratio 0.5 is below 0.95/);
});

test('rejection reasons are summarised per family', () => {
  const incumbent = holdoutReport(improving('base'));
  const candidateCases = {};
  for (const [id, q] of Object.entries(improving('base'))) {
    candidateCases[id] = id.startsWith('packing') ? q - 1 : q;
  }
  const candidate = createEvaluationReport({
    ...holdoutReport(candidateCases),
    caseResults: holdoutReport(candidateCases).caseResults.map((entry) =>
      entry.taskFamily === 'packing'
        ? { ...entry, outcome: 'failed', reason: 'collision' }
        : entry
    )
  });

  const result = gate(incumbent, candidate);
  const packing = result.families.find((family) => family.taskFamily === 'packing');

  assert.equal(packing.passed, false);
  assert.deepEqual(packing.rejectionSummary, [
    { taskFamily: 'packing', caseCount: 10, passedCount: 0, reasons: [{ reason: 'collision', count: 10 }] }
  ]);
});

test('a candidate cannot relabel a regressing family out of the per-family check', () => {
  // Four packing cases regress on every metric while sixteen navigation cases
  // improve enough that the overall ratio clears the threshold. The per-family
  // verdict is the only thing that catches the regression, so the family a case
  // belongs to cannot be the candidate's to choose.
  const cases = (family, quality, score, relabel) =>
    Array.from({ length: family === 'packing' ? 4 : 16 }, (_, index) => ({
      caseId: `${family}:base-${index}`,
      taskFamily: relabel && family === 'packing' ? 'navigation' : family,
      split: 'holdout',
      outcome: quality < 1 ? 'failed' : 'passed',
      quality,
      score
    }));
  const report = (caseResults) => createEvaluationReport({
    evaluatorVersion: '0.1.0', sourceHash: 'a'.repeat(64), snapshotId: 'b'.repeat(64),
    policyArtifactId: 'd'.repeat(64), split: 'holdout', configHash: CONFIG_HASH,
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults, sampleCount: caseResults.length, passed: true, guardResults: [],
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  const incumbent = report([...cases('packing', 1, 1, false), ...cases('navigation', 1, 1, false)]);
  const candidate = (relabel) => report([
    ...cases('packing', 0.5, 0.9, relabel),
    ...cases('navigation', 2, 2, relabel)
  ]);

  const honest = gate(incumbent, candidate(false), { config: { minimumPassRatio: 0.5 } });
  assert.equal(honest.passed, false);
  assert.match(honest.reasons.join(' '), /task family packing pass ratio 0 is below 0.5/);

  // The same numbers, with the packing cases called navigation. Without a
  // cross-check the merged family met the ratio and nothing failed.
  const relabelled = gate(incumbent, candidate(true), { config: { minimumPassRatio: 0.5 } });
  assert.equal(relabelled.passed, false);
  assert.match(relabelled.reasons.join(' '), /4 case\(s\) are in a different task family in each report/);
});

test('the gate reports the configuration it was asked to gate under', () => {
  // The reported hash is the request's, not either report's. On a passing run the
  // three are equal by construction, so only a mismatched request distinguishes
  // them — and on a rejected run the record still has to say what was asked for.
  const incumbent = holdoutReport(improving('base'));
  const candidate = holdoutReport(Object.fromEntries(Object.entries(improving('base')).map(([id, q]) => [id, q + 0.1])));
  const requested = 'f'.repeat(64);

  const result = evaluateHoldoutGate({
    incumbent,
    candidate,
    config: gateConfig(),
    configurationHash: requested
  });

  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /configuration being gated/);
  assert.equal(result.configurationHash, requested);
});

test('a report without per-case metrics cannot be gated', () => {
  const incumbent = holdoutReport(improving('base'));
  const bare = createEvaluationReport({
    ...holdoutReport(improving('base')),
    caseResults: [
      { caseId: 'packing:1', taskFamily: 'packing', split: 'holdout', outcome: 'passed' }
    ]
  });

  const result = gate(incumbent, bare);
  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /missing per-case quality or score/);
});

test('the gate configuration is validated', () => {
  const report = holdoutReport(improving('base'));

  assert.throws(
    () => evaluateHoldoutGate({ incumbent: report, candidate: report, config: gateConfig({ minimumHoldoutSamples: 1.5 }), configurationHash: CONFIG_HASH }),
    /minimumHoldoutSamples must be a non-negative integer/
  );
  assert.throws(
    () => evaluateHoldoutGate({ incumbent: report, candidate: report, config: gateConfig({ maxMissRate: Number.NaN }), configurationHash: CONFIG_HASH }),
    /maxMissRate must be finite/
  );
});

test('candidate evaluation carries a holdout verdict without promoting', async () => {
  const incumbent = holdoutReport(improving('base'));
  const candidateReport = holdoutReport(
    Object.fromEntries(Object.entries(improving('base')).map(([id, q]) => [id, q + 0.2]))
  );

  const result = await evaluateCandidate({
    llm: {
      async invoke(request) {
        return {
          text: JSON.stringify({
            mutationClasses: ['scheduling'],
            rationale: 'reorder',
            source: 'export const decide = () => 1;'
          }),
          model: request.model,
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'stop'
        };
      }
    },
    generation: {
      parent: createPolicyArtifact({
        version: 'v0',
        parentVersion: null,
        source: 'export const decide = () => 0;',
        manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
        allowedCapabilities: ['scheduling'],
        createdBy: 'human'
      }),
      parentSource: 'export const decide = () => 0;',
      trainMetrics: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 },
      validationMetrics: { quality: 1, cost: 0, parallelEfficiency: 1, missRate: 0, score: 1 },
      seed: 'seed-1',
      model: 'deepseek-v4-flash',
      correlationId: 'correlation-1'
    },
    registry: {
      registerPolicy: () => {},
      registerEvaluation: () => {}
    },
    holdoutGate: { incumbent, configurationHash: candidateReport.configHash },
    evaluate: async () => candidateReport
  });

  assert.equal(result.promoted, false);
  assert.equal(result.holdoutGate.passed, true);
  assert.equal(result.holdoutGate.candidateEvaluationId, candidateReport.evaluationId);
  assert.equal(result.staticGate.passed, true);
});

// ------------------------------------------------- config reaching the gate

test('the non-regression ratio comes from config rather than a constant', () => {
  const runtime = createDreamRsiRuntime(
    resolveDreamRsiConfig({ evolution: { enabled: true, minimumPassRatio: 0.6, minimumImprovement: 0.25 } })
  );
  try {
    const gate = runtime.evaluationSettings.holdoutGate;

    assert.equal(gate.minimumPassRatio, 0.6);
    assert.equal(gate.minimumImprovement, 0.25);
    // The sample floor and miss ceiling come from config too, not from defaults.
    assert.equal(gate.minimumHoldoutSamples, runtime.config.evaluation.minimumHoldoutSamples);
    assert.equal(gate.maxMissRate, runtime.config.replay.missRateMax);
    assert.notDeepEqual(gate, DEFAULT_HOLDOUT_GATE_CONFIG);
  } finally {
    runtime.dispose();
  }
});

test('a looser configured ratio changes the verdict the gate reaches', () => {
  const incumbent = holdoutReport(improving('base'));
  // Five of one family's ten cases regress slightly while the rest improve a
  // lot, so the mean rises but the pass ratio does not: the only thing that
  // changes between the two runs is the configured threshold.
  const regressed = Object.fromEntries(
    Object.entries(improving('base')).map(([id, quality]) => [
      id,
      Number(id.split('-').pop()) < 5 ? quality - 0.1 : quality + 1
    ])
  );
  const candidate = holdoutReport(regressed);

  const defaultRuntime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  const looseRuntime = createDreamRsiRuntime(
    resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' }, evolution: { enabled: true, minimumPassRatio: 0.5 } })
  );
  try {
    const strict = evaluateHoldoutGate({
      incumbent,
      candidate,
      config: defaultRuntime.evaluationSettings.holdoutGate,
      configurationHash: CONFIG_HASH
    });
    const loose = evaluateHoldoutGate({
      incumbent,
      candidate,
      config: looseRuntime.evaluationSettings.holdoutGate,
      configurationHash: CONFIG_HASH
    });

    // Before the wiring existed both calls used the same constant, so changing
    // config changed nothing.
    assert.equal(strict.passed, false);
    assert.equal(loose.passed, true);
  } finally {
    defaultRuntime.dispose();
    looseRuntime.dispose();
  }
});

test('an out-of-range non-regression ratio is refused at configuration time', () => {
  assert.throws(() => resolveDreamRsiConfig({ evolution: { minimumPassRatio: 1.5 } }), /must be between 0 and 1/);
  assert.throws(() => resolveDreamRsiConfig({ evolution: { minimumPassRatio: -0.1 } }), /must be between 0 and 1/);
});
