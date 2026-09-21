import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EVALUATOR_CONFIG,
  DEFAULT_SPLIT_CONFIG,
  MOCK_ENVIRONMENT_ID,
  ablateEvaluator,
  ablateSplit,
  bucketFor,
  buildAblationStudy,
  createDreamRsiRuntime,
  createPolicyArtifact,
  evaluatorAblations,
  hashDreamRsiConfig,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisodePipeline,
  splitDiscoveryNodes
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';

const NODES = [
  { score: 1, tokenCost: 100, execTimeMs: 10 },
  { score: 0.8, tokenCost: 100, execTimeMs: 10 },
  { score: 0.6, tokenCost: 100, execTimeMs: 10 }
].map((partial, index) => ({
  nodeId: `n-${index}`,
  taskId: 'task-1',
  parentId: index === 0 ? null : `n-${index - 1}`,
  policyVersion: 'v1',
  environmentVersion: 'mock-room-v1@1',
  stateHash: `state-${index}`,
  observationHash: `obs-${index}`,
  actionType: 'move_relative',
  actionParams: { dx: 1, dy: 0, dz: 0 },
  result: { actionId: `n-${index}`, status: 'completed' },
  ...partial,
  idempotencyKey: `n-${index}`,
  schemaVersion: 1,
  createdAt: AT
}));

const EVALUATION_INPUT = {
  visitedNodes: NODES,
  boundaryMissCount: 2,
  totalAttempts: 5,
  criticalPathMs: 30
};

// ------------------------------------------------------------ evaluator terms

test('every evaluator term has exactly one ablated variant', () => {
  const variants = evaluatorAblations();

  assert.equal(variants[0].name, 'baseline');
  assert.deepEqual(
    variants.map((variant) => variant.name),
    ['baseline', 'no-boundary-penalty', 'no-cost-term', 'no-parallel-term', 'quality-only']
  );
  // The baseline variant must be the configured evaluator, not a copy that drifted.
  assert.deepEqual(variants[0].evaluator, DEFAULT_EVALUATOR_CONFIG);
  assert.equal(variants[1].evaluator.boundaryPenalty, 0);
  assert.equal(variants[2].evaluator.costWeight, 0);
  assert.equal(variants[3].evaluator.parallelWeight, 0);
});

test('removing a term moves the score by exactly that term', () => {
  const runs = ablateEvaluator(EVALUATION_INPUT);
  const byName = new Map(runs.map((run) => [run.name, run]));

  assert.equal(byName.get('baseline').scoreDelta, 0);

  // These nodes carry cost and the replay missed twice, so both penalties bite.
  assert.ok(byName.get('no-boundary-penalty').scoreDelta > 0);
  assert.ok(byName.get('no-cost-term').scoreDelta > 0);
  assert.ok(byName.get('quality-only').scoreDelta > byName.get('no-cost-term').scoreDelta);

  // The boundary term is the penalty times the miss rate, which is exactly the gain.
  const expectedBoundaryGain = DEFAULT_EVALUATOR_CONFIG.boundaryPenalty * (2 / 5);
  assert.equal(byName.get('no-boundary-penalty').scoreDelta, expectedBoundaryGain);
});

test('zero tokens still costs work, because the cost term carries a time component', () => {
  const noTokens = { ...EVALUATION_INPUT, boundaryMissCount: 0, visitedNodes: NODES.map((node) => ({ ...node, tokenCost: 0 })) };
  const byName = new Map(ablateEvaluator(noTokens).map((run) => [run.name, run]));

  // workCost sums tokenCost + gamma * execTimeMs, so zeroing tokens alone does
  // not zero the cost term. Three nodes at 10ms with gamma 0.1 is 3 units,
  // scored as costWeight * 3 / costBudget.
  assert.equal(byName.get('no-boundary-penalty').scoreDelta, 0);
  // The delta is rounded to 9 decimals, so compare with a tolerance rather than
  // against the raw float product.
  const expectedCostGain = (DEFAULT_EVALUATOR_CONFIG.costWeight * 3) / 1000;
  assert.ok(Math.abs(byName.get('no-cost-term').scoreDelta - expectedCostGain) < 1e-9);
});

test('a term with nothing to penalise shows no delta', () => {
  const clean = {
    ...EVALUATION_INPUT,
    boundaryMissCount: 0,
    visitedNodes: NODES.map((node) => ({ ...node, tokenCost: 0, execTimeMs: 0 }))
  };
  const byName = new Map(ablateEvaluator(clean).map((run) => [run.name, run]));

  assert.equal(byName.get('no-boundary-penalty').scoreDelta, 0);
  assert.equal(byName.get('no-cost-term').scoreDelta, 0);
});

// --------------------------------------------------------------- split strategy

function nodesFor(taskId, count) {
  return Array.from({ length: count }, (_, index) => ({
    ...NODES[0],
    nodeId: `${taskId}-${index}`,
    taskId,
    idempotencyKey: `${taskId}-${index}`
  }));
}

test('the task-level split never puts one task in two partitions', () => {
  const nodes = [...nodesFor('task-a', 20), ...nodesFor('task-b', 20)];
  const [taskLevel] = ablateSplit(nodes, DEFAULT_SPLIT_CONFIG);

  assert.equal(taskLevel.strategy, 'task-level');
  assert.deepEqual(taskLevel.tasksInMultiplePartitions, []);
  assert.equal(taskLevel.leaks, false);
  assert.equal(taskLevel.partitions.train + taskLevel.partitions.validation + taskLevel.partitions.holdout, 40);
});

test('a node-level split leaks tasks across partitions, which is the point of comparing', () => {
  const nodes = [...nodesFor('task-a', 30), ...nodesFor('task-b', 30)];
  const [, nodeLevel] = ablateSplit(nodes, DEFAULT_SPLIT_CONFIG);

  assert.equal(nodeLevel.strategy, 'node-level');
  assert.equal(nodeLevel.leaks, true);
  // With thirty nodes in one task, landing them all in one partition is not
  // something a test should rely on happening by chance.
  assert.ok(nodeLevel.tasksInMultiplePartitions.length > 0);
});

test('the ablation buckets exactly as the real split does', () => {
  const nodes = [...nodesFor('task-a', 10), ...nodesFor('task-b', 10), ...nodesFor('task-c', 10)];
  const split = splitDiscoveryNodes(nodes, DEFAULT_SPLIT_CONFIG);

  // If these disagreed, the ablation would be measuring its own bug.
  for (const [taskId, partition] of Object.entries(split.taskAssignments)) {
    assert.equal(bucketFor(taskId, DEFAULT_SPLIT_CONFIG), partition, taskId);
  }
});

// ------------------------------------------------------------- on recorded data

test('an ablation study over a recorded episode reports its own decomposition', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const artifact = createPolicyArtifact({
      version: 'v1',
      parentVersion: null,
      source: 'export const decide = () => 1;',
      manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
      allowedCapabilities: ['scheduling'],
      createdBy: 'human',
      createdAt: AT
    });
    runtime.store.append(NODES[0]);

    const result = await runEpisodePipeline({
      task: {
        taskId: 'task-1',
        goal: 'reach x=2',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'v1',
        budget: { maxSteps: 5, wallClockMs: 30_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: 'session-1',
      adapter: runtime.adapter,
      store: runtime.store,
      policy: planPolicy([
        { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } },
        { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }
      ]),
      isGoalReached: (observation) => observation.pose.x >= 2,
      settings: pipelineSettings(runtime)
    });

    const study = buildAblationStudy({
      nodes: result.outcome.nodes,
      evaluation: result.evaluationInput,
      splitConfig: DEFAULT_SPLIT_CONFIG
    });

    assert.equal(study.schemaVersion, 1);
    assert.equal(study.nodeCount, 2);
    assert.equal(study.taskCount, 1);
    assert.equal(study.baselineScore, result.evaluation.score);
    assert.equal(study.evaluator.length, 5);
    assert.equal(study.split.length, 2);
    // A clean replay: the boundary term contributes nothing.
    assert.equal(study.evaluator.find((run) => run.name === 'no-boundary-penalty').scoreDelta, 0);
    // One task cannot demonstrate task-level leakage either way.
    assert.deepEqual(study.split.map((entry) => entry.leaks), [false, false]);
  } finally {
    runtime.dispose();
  }
});
