import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryMetrics,
  LlmRecordingError,
  ReplaySimulator,
  canonicalJson,
  createRecordingLlm,
  replayNodes,
  runEpisode,
  createDreamRsiRuntime,
  planPolicy,
  resolveDreamRsiConfig,
  MOCK_ENVIRONMENT_ID
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';

function node(overrides = {}) {
  const nodeId = overrides.nodeId ?? 'n-0';
  return {
    nodeId,
    taskId: 'task-1',
    parentId: null,
    policyVersion: 'v1',
    environmentVersion: 'mock-room-v1@1',
    stateHash: 'state-shared',
    observationHash: 'obs-shared',
    actionType: 'move_relative',
    actionParams: { dx: 1, dy: 0, dz: 0 },
    result: { actionId: nodeId, status: 'completed' },
    score: 1,
    tokenCost: 0,
    execTimeMs: 1,
    idempotencyKey: nodeId,
    schemaVersion: 1,
    createdAt: AT,
    ...overrides
  };
}

// ------------------------------------------------------------- llm recording

function fakeLlm(behaviour) {
  return {
    async invoke(request) {
      return behaviour(request);
    }
  };
}

test('every model call records hashes, usage, latency, and attempts', async () => {
  let clock = 1_000;
  const llm = createRecordingLlm(
    fakeLlm((request) => ({
      text: 'a candidate',
      model: request.model,
      usage: { inputTokens: 120, outputTokens: 45 },
      finishReason: 'stop'
    })),
    { now: () => (clock += 25) }
  );

  await llm.invoke({ model: 'deepseek-v4-flash', prompt: 'evolve this', correlationId: 'correlation-1' });

  const [record] = llm.records();
  assert.equal(record.correlationId, 'correlation-1');
  assert.equal(record.model, 'deepseek-v4-flash');
  assert.equal(record.inputTokens, 120);
  assert.equal(record.outputTokens, 45);
  assert.equal(record.attempts, 1);
  assert.equal(record.errorClass, null);
  assert.match(record.requestHash, /^[0-9a-f]{64}$/);
  assert.match(record.responseHash, /^[0-9a-f]{64}$/);
  assert.ok(record.latencyMs >= 0);
  assert.deepEqual(llm.totals(), { inputTokens: 120, outputTokens: 45, calls: 1 });
});

test('the record holds hashes rather than the prompt or the response', async () => {
  const llm = createRecordingLlm(
    fakeLlm((request) => ({
      text: 'SECRET-RESPONSE-BODY',
      model: request.model,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop'
    }))
  );

  await llm.invoke({ model: 'm', prompt: 'SECRET-PROMPT-BODY', correlationId: 'c' });
  const serialized = JSON.stringify(llm.records());

  // An observability log that keeps the bodies is a second copy of the data it
  // is meant to describe.
  assert.ok(!serialized.includes('SECRET-PROMPT-BODY'));
  assert.ok(!serialized.includes('SECRET-RESPONSE-BODY'));
});

test('retries are bounded, counted, and reported', async () => {
  let calls = 0;
  const flaky = createRecordingLlm(
    fakeLlm((request) => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('provider unavailable');
        error.code = 'ECONNRESET';
        throw error;
      }
      return { text: 'ok', model: request.model, usage: { inputTokens: 5, outputTokens: 5 }, finishReason: 'stop' };
    }),
    { maxAttempts: 3 }
  );

  await flaky.invoke({ model: 'm', prompt: 'p', correlationId: 'c' });
  assert.equal(calls, 3);
  assert.equal(flaky.records()[0].attempts, 3);
  assert.equal(flaky.records()[0].errorClass, null);
});

test('an exhausted call throws with the error class recorded', async () => {
  const failing = createRecordingLlm(
    fakeLlm(() => {
      const error = new Error('provider down');
      error.code = 'ETIMEDOUT';
      throw error;
    }),
    { maxAttempts: 2 }
  );

  await assert.rejects(
    failing.invoke({ model: 'm', prompt: 'p', correlationId: 'c' }),
    (error) => {
      assert.ok(error instanceof LlmRecordingError);
      assert.equal(error.attempts, 2);
      assert.equal(error.errorClass, 'ETIMEDOUT');
      return true;
    }
  );

  const [record] = failing.records();
  assert.equal(record.responseHash, null);
  assert.equal(record.errorClass, 'ETIMEDOUT');
  assert.equal(record.attempts, 2);
});

test('a recording LLM emits the token and latency metrics the design lists', async () => {
  const metrics = new InMemoryMetrics(() => new Date(AT));
  const llm = createRecordingLlm(
    fakeLlm((request) => ({
      text: 'x',
      model: request.model,
      usage: { inputTokens: 10, outputTokens: 4 },
      finishReason: 'stop'
    })),
    { metrics, labels: { taskId: 'task-1' } }
  );

  await llm.invoke({ model: 'm', prompt: 'p', correlationId: 'c' });

  // Per-task token, latency, and cost are exactly what section 8 asks for.
  assert.equal(metrics.total('llm.inputTokens', { taskId: 'task-1', correlationId: 'c', model: 'm' }), 10);
  assert.equal(metrics.total('llm.outputTokens', { taskId: 'task-1', correlationId: 'c', model: 'm' }), 4);
  assert.equal(metrics.total('llm.latencyMs', { taskId: 'task-1', correlationId: 'c', model: 'm' }), 0);
  assert.equal(metrics.total('llm.failure', { taskId: 'task-1', correlationId: 'c', model: 'm' }), 0);
});

test('maxAttempts is validated rather than silently treated as one', () => {
  const llm = fakeLlm(() => ({ text: '', model: 'm', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' }));
  assert.throws(() => createRecordingLlm(llm, { maxAttempts: 0 }), /positive integer/);
  assert.throws(() => createRecordingLlm(llm, { maxAttempts: 1.5 }), /positive integer/);
});

// -------------------------------------------------------------- counterfactual

test('the recorded actions for a state keep their parameters', () => {
  const simulator = new ReplaySimulator([
    node({ nodeId: 'n-0', actionParams: { dx: 1, dy: 0, dz: 0 } }),
    node({ nodeId: 'n-1', actionParams: { dx: 3, dy: 0, dz: 0 } }),
    node({ nodeId: 'n-2', actionType: 'pick', actionParams: { objectId: 'mug' } })
  ]);

  const actions = simulator.recordedActions({ environmentVersion: 'mock-room-v1@1', stateHash: 'state-shared', observationHash: 'obs-shared' });

  // Three alternatives, not two: two move_relative calls with different
  // distances are different alternatives.
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((action) => action.actionType).sort(), ['move_relative', 'move_relative', 'pick']);
});

test('a counterfactual resolves each alternative from history', () => {
  const simulator = new ReplaySimulator([
    node({ nodeId: 'n-0', actionParams: { dx: 1, dy: 0, dz: 0 } }),
    node({ nodeId: 'n-1', actionParams: { dx: 3, dy: 0, dz: 0 } })
  ]);
  const state = { environmentVersion: 'mock-room-v1@1', stateHash: 'state-shared', observationHash: 'obs-shared' };

  const branches = simulator.counterfactual(state, [
    { actionType: 'move_relative', normalizedActionParams: { dx: 1, dy: 0, dz: 0 } },
    { actionType: 'move_relative', normalizedActionParams: { dx: 3, dy: 0, dz: 0 } },
    { actionType: 'goto', normalizedActionParams: { x: 9, y: 0, z: 0 } }
  ]);

  assert.deepEqual(branches.map((branch) => branch.result.kind), ['hit', 'hit', 'boundary_miss']);
  assert.equal(branches[0].result.node.nodeId, 'n-0');
  assert.equal(branches[1].result.node.nodeId, 'n-1');
  // An action never taken from this state is itself the answer.
  assert.deepEqual(branches[2].result.availableActionTypes, ['move_relative']);
});

test('a replay reports the alternatives the tree recorded for each visited state', async () => {
  const nodes = [
    node({ nodeId: 'n-0', actionParams: { dx: 1, dy: 0, dz: 0 }, parentId: null }),
    node({ nodeId: 'n-1', actionParams: { dx: 1, dy: 0, dz: 0 }, parentId: 'n-0' })
  ];
  const withAlternative = [
    ...nodes,
    // Same state as n-0, different action: an alternative the tree recorded.
    node({ nodeId: 'n-2', actionParams: { dx: 5, dy: 0, dz: 0 }, parentId: null })
  ];

  const { report } = replayNodes(withAlternative);

  const forFirst = report.counterfactuals.find((entry) => entry.nodeId === 'n-0');
  assert.ok(forFirst, 'the first node has a recorded alternative');
  assert.deepEqual(forFirst.branches.map((branch) => branch.result.kind), ['hit']);
  assert.equal(forFirst.branches[0].result.node.nodeId, 'n-2');
  // The action the node itself took is not offered as its own alternative.
  assert.ok(!forFirst.branches.some((branch) => canonicalJson(branch.result.node.actionParams) === canonicalJson({ dx: 1, dy: 0, dz: 0 })));
});

test('a state with no alternatives reports no counterfactual entry', () => {
  const { report } = replayNodes([node({ nodeId: 'n-0' })]);
  assert.deepEqual(report.counterfactuals, []);
});

test('counterfactual branches come from a recorded episode', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const outcome = await runEpisode({
      task: {
        taskId: 'task-1',
        goal: 'reach x=2',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'v1',
        budget: { maxSteps: 4, wallClockMs: 30_000 },
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
      isGoalReached: (observation) => observation.pose.x >= 2
    });

    const { report } = replayNodes(outcome.nodes);

    // The two steps ran from different states, so neither offers the other as
    // an alternative — which is the honest answer, not an empty feature.
    assert.equal(outcome.nodes.length, 2);
    assert.deepEqual(report.counterfactuals, []);
    assert.equal(report.hitCount, 2);
  } finally {
    runtime.dispose();
  }
});
