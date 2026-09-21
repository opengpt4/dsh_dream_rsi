import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  InMemoryDiscoveryStore,
  MockEmbodiedBackend,
  MockEnvironmentAdapter,
  MOCK_ENVIRONMENT_ID,
  MOCK_ENVIRONMENT_VERSION,
  SQLiteDiscoveryStore,
  createDreamRsiRuntime,
  createEvaluationSnapshot,
  createIsolatedEvaluation,
  hashEnvironmentState,
  hashObservation,
  pipelineSettings,
  planPolicy,
  replayNodes,
  resolveDreamRsiConfig,
  runEpisode,
  runEpisodePipeline
} from '../dist/index.js';

/** Matches the host path: normalize through the schema, then build the runtime. */
function makeRuntime(input = {}) {
  return createDreamRsiRuntime(resolveDreamRsiConfig(input));
}

const SESSION_ID = 'session-1';
const TASK_ID = 'task-reach-x2';
const EPISODE_ID = 'episode-1';
const TARGET_X = 2;

function makeTask(overrides = {}) {
  return {
    taskId: TASK_ID,
    goal: `move to x=${TARGET_X}`,
    environmentId: MOCK_ENVIRONMENT_ID,
    policyVersion: 'policy-v1',
    budget: { maxSteps: 5, wallClockMs: 60_000 },
    metadata: { suite: 'end-to-end' },
    ...overrides
  };
}

/** Higher is closer to the target; always positive so evaluator quality is defined. */
function goalProximity(observation) {
  return 1 / (1 + Math.abs(TARGET_X - observation.pose.x));
}

const reachTarget = (count = TARGET_X) =>
  Array.from({ length: count }, () => ({
    actionType: 'move_relative',
    parameters: { dx: 1, dy: 0, dz: 0 },
    tokenCost: 0
  }));

function makeAdapter(latencyMs = 0) {
  return new MockEnvironmentAdapter(new MockEmbodiedBackend(latencyMs));
}

async function run(options = {}) {
  return runEpisode({
    task: makeTask(),
    episodeId: EPISODE_ID,
    sessionId: SESSION_ID,
    adapter: makeAdapter(),
    store: new InMemoryDiscoveryStore(),
    policy: planPolicy(reachTarget()),
    scoreStep: (observation) => goalProximity(observation),
    isGoalReached: (observation) => observation.pose.x >= TARGET_X,
    ...options
  });
}

test('a successful episode traces perceive -> action -> result -> Discovery node', async () => {
  const { episode, nodes, cause } = await run();

  assert.equal(cause, undefined);
  assert.equal(episode.status, 'completed');
  assert.equal(episode.step, TARGET_X);
  assert.equal(nodes.length, TARGET_X);
  assert.equal(episode.endedAt !== undefined, true);

  assert.deepEqual(
    nodes.map((node) => node.actionType),
    ['move_relative', 'move_relative']
  );
  assert.deepEqual(
    nodes.map((node) => node.result.status),
    ['completed', 'completed']
  );
  // The environment state advanced as the recorded actions claim it did.
  assert.deepEqual(
    nodes.map((node) => node.actionParams.dx),
    [1, 1]
  );

  assert.equal(nodes[0].parentId, null);
  assert.equal(nodes[1].parentId, nodes[0].nodeId);
  // The state advanced, so the pre-action state hashes differ.
  assert.notEqual(nodes[0].stateHash, nodes[1].stateHash);
  assert.equal(nodes[0].stateHash, hashEnvironmentState({ pose: { x: 0, y: 0, z: 0, yaw: 0 }, gripper: 'open' }));
  assert.equal(nodes[1].stateHash, hashEnvironmentState({ pose: { x: 1, y: 0, z: 0, yaw: 0 }, gripper: 'open' }));
});

test('replay hashes ignore the fields that differ on every run', () => {
  const base = {
    sessionId: SESSION_ID,
    environmentId: MOCK_ENVIRONMENT_ID,
    environmentVersion: MOCK_ENVIRONMENT_VERSION,
    frameId: 'mock-room-v1/world',
    step: 0,
    pose: { x: 1, y: 0, z: 0, yaw: 0 },
    gripper: 'open',
    objects: [{ id: 'red-mug', label: 'red mug', position: [1, 0, 0] }],
    schemaVersion: 1,
    timestamp: '2026-01-01T00:00:00.000Z'
  };

  // Timestamp and step change on every observation; including either would make
  // every replay lookup a miss.
  assert.equal(hashObservation(base), hashObservation({ ...base, step: 9, timestamp: '2030-06-06T06:06:06.000Z' }));
  assert.notEqual(hashObservation(base), hashObservation({ ...base, pose: { ...base.pose, x: 2 } }));
  // State covers pose and gripper only, so a later step at the same pose matches.
  assert.equal(hashEnvironmentState(base), hashEnvironmentState({ ...base, step: 9, timestamp: '2030-06-06T06:06:06.000Z' }));
  assert.notEqual(hashEnvironmentState(base), hashEnvironmentState({ ...base, gripper: 'closed' }));
});

test('every node links task, episode, session, policy, correlation, and action id', async () => {
  const { episode, nodes } = await run();

  for (const [index, node] of nodes.entries()) {
    assert.equal(node.taskId, TASK_ID);
    assert.equal(node.episodeId, EPISODE_ID);
    assert.equal(node.sessionId, SESSION_ID);
    assert.equal(node.policyVersion, 'policy-v1');
    assert.equal(node.correlationId, EPISODE_ID);
    assert.equal(node.environmentVersion, MOCK_ENVIRONMENT_VERSION);
    assert.equal(node.episodeStep, index);
    assert.equal(node.nodeId, `${EPISODE_ID}:${index}`);
    assert.equal(node.idempotencyKey, node.nodeId);
    assert.equal(node.result.actionId, node.nodeId);
    assert.equal(node.schemaVersion, 1);
    assert.equal(node.sessionId, episode.sessionId);
    assert.equal(node.policyVersion, episode.policyVersion);
    assert.equal(node.correlationId, episode.correlationId);
  }
});

test('the adapter reports its capability profile and refuses an action outside it', async () => {
  const adapter = makeAdapter();

  assert.deepEqual(await adapter.availableActions(), ['move_relative', 'goto', 'pick', 'place', 'open']);

  const refused = await adapter.execute({
    actionId: 'unknown-action',
    sessionId: SESSION_ID,
    taskId: TASK_ID,
    episodeId: EPISODE_ID,
    correlationId: EPISODE_ID,
    actionType: 'teleport',
    parameters: {},
    timeoutMs: 1_000,
    requestedAt: new Date().toISOString()
  });

  assert.equal(refused.actionId, 'unknown-action');
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /not in the capability profile/);
});

test('replaying an episode reproduces every recorded decision', async () => {
  const { nodes } = await run();
  const { report } = replayNodes(nodes);

  assert.equal(report.missCount, 0);
  assert.equal(report.hitCount, nodes.length);
  assert.deepEqual(report.visitedNodeIds, nodes.map((node) => node.nodeId));
  assert.deepEqual(report.deferredNodeIds, []);
});

test('a decision the episode never recorded is reported as a boundary miss', async () => {
  const { nodes } = await run();
  const { simulator } = replayNodes(nodes);
  const first = nodes[0];

  const result = simulator.execute({
    environmentVersion: first.environmentVersion,
    stateHash: first.stateHash,
    observationHash: first.observationHash,
    actionType: 'pick',
    normalizedActionParams: {}
  });

  assert.equal(result.kind, 'boundary_miss');
  assert.deepEqual(result.availableActionTypes, ['move_relative']);
});

test('replayMaxNodes defers the overflow instead of dropping it silently', async () => {
  const { nodes } = await run();
  const { report } = replayNodes(nodes, { replayMaxNodes: 1 });

  assert.deepEqual(report.replayedNodeIds, [nodes[0].nodeId]);
  assert.deepEqual(report.deferredNodeIds, [nodes[1].nodeId]);
  assert.equal(report.hitCount, 1);
  assert.equal(report.missCount, 0);
});

test('the pipeline runs one episode through snapshot, replay, and evaluator', async () => {
  const runtime = makeRuntime({ storage: { sqlitePath: ':memory:' } });
  try {
    const result = await runEpisodePipeline({
      task: makeTask(),
      episodeId: EPISODE_ID,
      sessionId: SESSION_ID,
      adapter: runtime.adapter,
      store: runtime.store,
      policy: planPolicy(reachTarget()),
      scoreStep: (observation) => goalProximity(observation),
      isGoalReached: (observation) => observation.pose.x >= TARGET_X,
      settings: pipelineSettings(runtime)
    });

    assert.equal(result.outcome.episode.status, 'completed');
    assert.equal(result.replay.missCount, 0);
    assert.equal(result.gates.missRate, 0);
    assert.equal(result.gates.missRateWithinBudget, true);

    // Snapshot partitions the episode's nodes exactly once, keyed by task.
    const split = result.snapshot.splits;
    assert.equal(split.train.length + split.validation.length + split.holdout.length, 2);
    assert.ok(['train', 'validation', 'holdout'].includes(split.taskAssignments[TASK_ID]));
    assert.match(result.snapshot.snapshotId, /^[0-9a-f]{64}$/);

    assert.equal(result.evaluation.quality, Math.max(...result.outcome.nodes.map((node) => node.score)));
    assert.ok(Number.isFinite(result.evaluation.score));
    assert.equal(result.evaluation.missRate, 0);
    assert.equal(result.evaluationInput.boundaryMissCount, 0);
    assert.equal(result.evaluationInput.totalAttempts, 2);
    assert.ok(result.evaluationInput.criticalPathMs >= 1);
  } finally {
    runtime.dispose();
  }
});

test('the isolated evaluator agrees with the in-process one and honours the configured timeout', async () => {
  const runtime = makeRuntime({
    storage: { sqlitePath: ':memory:' },
    evaluation: { timeoutMs: 20_000 }
  });
  try {
    const base = {
      task: makeTask(),
      episodeId: EPISODE_ID,
      sessionId: SESSION_ID,
      adapter: runtime.adapter,
      store: runtime.store,
      policy: planPolicy(reachTarget()),
      settings: pipelineSettings(runtime)
    };
    const inline = await runEpisodePipeline(base);
    const isolated = await runEpisodePipeline({ ...base, isolated: true });

    assert.equal(typeof createIsolatedEvaluation(20_000), 'function');
    assert.deepEqual(isolated.evaluation, inline.evaluation);
    assert.equal(base.settings.evaluatorTimeoutMs, 20_000);
  } finally {
    runtime.dispose();
  }
});

test('the configured evaluator timeout reaches the isolated evaluator', async () => {
  const runtime = makeRuntime({ storage: { sqlitePath: ':memory:' }, evaluation: { timeoutMs: 1 } });
  try {
    await assert.rejects(
      runEpisodePipeline({
        task: makeTask(),
        episodeId: EPISODE_ID,
        sessionId: SESSION_ID,
        adapter: runtime.adapter,
        store: runtime.store,
        policy: planPolicy(reachTarget()),
        settings: pipelineSettings(runtime),
        isolated: true
      }),
      /isolated evaluator timed out after 1ms/
    );
  } finally {
    runtime.dispose();
  }
});

test('a failing action records a node and fails the episode', async () => {
  const { episode, nodes, cause } = await run({
    policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 'not-a-number', dy: 0, dz: 0 } }])
  });

  assert.equal(episode.status, 'failed');
  assert.match(cause, /dx must be a finite number/);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].result.status, 'failed');
  assert.match(nodes[0].result.error, /dx must be a finite number/);
});

test('an action exceeding its deadline times out and is recorded as such', async () => {
  const { episode, nodes, cause } = await run({
    adapter: makeAdapter(300),
    policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 }, timeoutMs: 20 }])
  });

  assert.equal(episode.status, 'timeout');
  assert.equal(cause, 'deadline 20ms exceeded');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].result.status, 'timeout');
});

test('cancelling in flight records the attempt and cancels the episode', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);

  try {
    const { episode, nodes, cause } = await run({
      adapter: makeAdapter(300),
      signal: controller.signal
    });

    assert.equal(episode.status, 'cancelled');
    assert.equal(cause, 'action cancelled');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].result.status, 'cancelled');
  } finally {
    clearTimeout(timer);
  }
});

test('cancellation before the first action records nothing', async () => {
  const controller = new AbortController();
  controller.abort();

  const { episode, nodes } = await run({ signal: controller.signal });

  assert.equal(episode.status, 'cancelled');
  assert.deepEqual(nodes, []);
});

test('an operator stop ends the episode and latches the session against further actions', async () => {
  const stop = new AbortController();
  const adapter = makeAdapter();
  const policy = ({ step }) => {
    if (step === 1) stop.abort();
    return reachTarget(3)[step] ?? null;
  };

  const { episode, nodes, cause } = await run({
    adapter,
    policy,
    isGoalReached: () => false,
    emergencyStop: stop.signal
  });

  assert.equal(episode.status, 'emergency_stop');
  assert.equal(cause, 'emergency stop requested');
  // The stop was raised during step 1's decision, so only step 0 executed.
  assert.equal(nodes.length, 1);

  // Latch: a later attempt in the same session is refused without executing.
  const refused = await adapter.execute({
    actionId: 'post-stop',
    sessionId: SESSION_ID,
    taskId: TASK_ID,
    episodeId: EPISODE_ID,
    correlationId: EPISODE_ID,
    actionType: 'move_relative',
    parameters: { dx: 1, dy: 0, dz: 0 },
    timeoutMs: 1_000,
    requestedAt: new Date().toISOString()
  });

  assert.equal(refused.status, 'emergency_stop');
});

test('a task bound to another environment fails before any action runs', async () => {
  const { episode, nodes, cause } = await run({
    task: makeTask({ environmentId: 'some-other-room' })
  });

  assert.equal(episode.status, 'failed');
  assert.match(cause, /bound to some-other-room/);
  assert.deepEqual(nodes, []);
});

test('the step budget stops the episode once it is exhausted', async () => {
  const { episode, nodes, cause } = await run({
    task: makeTask({ budget: { maxSteps: 1, wallClockMs: 60_000 } }),
    isGoalReached: () => false,
    policy: planPolicy(reachTarget(3))
  });

  assert.equal(episode.status, 'failed');
  assert.equal(cause, 'step budget exhausted');
  assert.equal(nodes.length, 1);
});

test('exhausting the plan short of the goal fails the episode', async () => {
  const { episode, nodes, cause } = await run({
    policy: planPolicy(reachTarget(1)),
    isGoalReached: () => false
  });

  assert.equal(episode.status, 'failed');
  assert.equal(cause, 'policy exhausted its plan without reaching the goal');
  assert.equal(nodes.length, 1);
});

test('appending a node twice under one action id is idempotent', async () => {
  const store = new InMemoryDiscoveryStore();
  const first = await run({ store });
  const second = await run({ store });

  // A re-run of the same episode re-appends the same action ids.
  assert.deepEqual(
    second.nodes.map((node) => node.nodeId),
    first.nodes.map((node) => node.nodeId)
  );
  assert.equal(store.listByTask(TASK_ID).length, first.nodes.length);
});

test('the SQLite store round-trips the episode link and survives reopen', async () => {
  const databasePath = fileURLToPath(new URL('./.tmp-episode.db', import.meta.url));
  const { nodes } = await run();

  try {
    const writer = new SQLiteDiscoveryStore(databasePath);
    for (const node of nodes) writer.append(node);
    writer.close();

    const reader = new SQLiteDiscoveryStore(databasePath);
    const restored = reader.listByTask(TASK_ID);
    reader.close();

    assert.equal(restored.length, nodes.length);
    for (const [index, node] of restored.entries()) {
      assert.equal(node.episodeId, EPISODE_ID);
      assert.equal(node.episodeStep, index);
      assert.equal(node.correlationId, EPISODE_ID);
      assert.equal(node.sessionId, SESSION_ID);
    }
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        unlinkSync(`${databasePath}${suffix}`);
      } catch {
        // Not every journal mode creates every sidecar.
      }
    }
  }
});

test('the snapshot is immutable and hashes its splits', async () => {
  const { nodes } = await run();
  const snapshot = createEvaluationSnapshot(nodes);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.splits), true);

  // The id is a content address: the same tree yields the same id whatever the
  // wall clock said, so two evaluations can be told apart from the same one.
  assert.equal(snapshot.snapshotId, createEvaluationSnapshot(nodes).snapshotId);
  assert.equal(
    snapshot.snapshotId,
    createEvaluationSnapshot(nodes, undefined, '2020-01-01T00:00:00.000Z').snapshotId
  );
  // Creation time is still recorded and still differs between calls; it is just
  // no longer part of the identity.
  const earlier = createEvaluationSnapshot(nodes, undefined, '2020-01-01T00:00:00.000Z');
  assert.equal(earlier.createdAt, '2020-01-01T00:00:00.000Z');
  assert.notEqual(earlier.createdAt, snapshot.createdAt);
  assert.equal(earlier.snapshotId, snapshot.snapshotId);

  // Different content is a different snapshot.
  assert.notEqual(snapshot.snapshotId, createEvaluationSnapshot(nodes.slice(1)).snapshotId);
});
