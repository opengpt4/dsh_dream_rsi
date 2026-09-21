import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  InMemoryPolicyRegistryStore,
  MOCK_ENVIRONMENT_ID,
  PolicyRegistry,
  SQLiteDiscoveryStore,
  createDreamRsiRuntime,
  createPolicyArtifact,
  getDreamRsiStatus,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisode,
  verifyReadiness
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const SESSION = 'session-1';

function runtime(overrides = {}) {
  return createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' }, ...overrides }));
}

function move(dx, sessionId = SESSION) {
  return {
    actionId: `${sessionId}:${dx}`,
    sessionId,
    correlationId: 'correlation-1',
    actionType: 'move_relative',
    parameters: { dx, dy: 0, dz: 0 },
    timeoutMs: 1_000,
    requestedAt: AT
  };
}

// ------------------------------------------------------------- session release

test('releasing sessions returns the environment to its initial state', async () => {
  const instance = runtime();
  try {
    await instance.adapter.execute(move(1));
    assert.equal((await instance.adapter.observe({ sessionId: SESSION, correlationId: 'c', includeObjects: false })).pose.x, 1);

    instance.adapter.releaseAllSessions();

    assert.equal((await instance.adapter.observe({ sessionId: SESSION, correlationId: 'c', includeObjects: false })).pose.x, 0);
  } finally {
    instance.dispose();
  }
});

test('dispose releases environment sessions and guard latches', async () => {
  const instance = runtime();
  await instance.adapter.execute(move(2));
  instance.guard.emergencyStop(SESSION, 'operator pressed stop');

  assert.equal(instance.guard.isStopped(SESSION), true);
  assert.equal((await instance.adapter.observe({ sessionId: SESSION, correlationId: 'c', includeObjects: false })).pose.x, 2);

  instance.dispose();

  // A backend that keeps sessions past unload leaves a real environment holding
  // whatever pose the last episode left it in.
  assert.equal((await instance.adapter.observe({ sessionId: SESSION, correlationId: 'c', includeObjects: false })).pose.x, 0);
  assert.equal(instance.guard.isStopped(SESSION), false);
  assert.deepEqual(instance.guard.list(), []);
});

test('dispose stays idempotent now that it releases sessions', () => {
  const instance = runtime();
  instance.dispose();
  instance.dispose();
  assert.equal(instance.guard.isStopped(SESSION), false);
});

// ---------------------------------------------------------- observation schema

/** Wraps an adapter so it reports a schema version this build does not know. */
function mislabelled(inner, schemaVersion) {
  return {
    observe: async (request) => ({ ...(await inner.observe(request)), schemaVersion }),
    availableActions: () => inner.availableActions(),
    execute: (request, signal) => inner.execute(request, signal),
    emergencyStop: (sessionId) => inner.emergencyStop(sessionId),
    reset: (sessionId) => inner.reset(sessionId),
    releaseAllSessions: () => inner.releaseAllSessions()
  };
}

test('an observation from another schema version fails the episode rather than the replay key', async () => {
  const instance = runtime();
  try {
    const outcome = await runEpisode({
      task: {
        taskId: 'task-1',
        goal: 'never',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'v1',
        budget: { maxSteps: 3, wallClockMs: 30_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: SESSION,
      adapter: mislabelled(instance.adapter, 99),
      store: instance.store,
      policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
      isGoalReached: () => false
    });

    assert.equal(outcome.episode.status, 'failed');
    assert.match(outcome.cause, /schema version 99 is not the expected 1/);
    // Nothing was recorded, so nothing reached a replay key.
    assert.deepEqual(outcome.nodes, []);
  } finally {
    instance.dispose();
  }
});

test('the expected schema version is honoured when it matches', async () => {
  const instance = runtime();
  try {
    const outcome = await runEpisode({
      task: {
        taskId: 'task-1',
        goal: 'reach x=1',
        environmentId: MOCK_ENVIRONMENT_ID,
        policyVersion: 'v1',
        budget: { maxSteps: 2, wallClockMs: 30_000 },
        metadata: {}
      },
      episodeId: 'episode-1',
      sessionId: SESSION,
      adapter: mislabelled(instance.adapter, 1),
      store: instance.store,
      policy: planPolicy([{ actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }]),
      isGoalReached: (observation) => observation.pose.x >= 1
    });

    assert.equal(outcome.episode.status, 'completed');
  } finally {
    instance.dispose();
  }
});

// ------------------------------------------------------------------ readiness

test('readiness reports the capability profile and the evaluator worker', () => {
  const instance = runtime();
  try {
    const report = verifyReadiness({ runtime: instance, now: () => new Date(AT) });

    assert.equal(report.checkedAt, AT);
    assert.equal(report.ready, true);
    assert.deepEqual(report.checks.map((check) => check.name), [
      'storage',
      'capabilityProfile',
      'evaluatorWorker'
    ]);
    assert.equal(report.checks.find((check) => check.name === 'capabilityProfile').state, 'ready');
    assert.equal(report.checks.find((check) => check.name === 'evaluatorWorker').state, 'ready');
  } finally {
    instance.dispose();
  }
});

test('readiness does not open storage unless asked, because opening it creates it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-readiness-'));
  const instance = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: join(dir, 'discovery.db') } }));
  try {
    const unprobed = verifyReadiness({ runtime: instance });
    const storage = unprobed.checks.find((check) => check.name === 'storage');
    assert.equal(storage.state, 'not-probed');
    // A not-probed check must not make the report claim readiness is unknown.
    assert.equal(unprobed.ready, true);

    const probed = verifyReadiness({ runtime: instance, probeStorage: true });
    assert.equal(probed.checks.find((check) => check.name === 'storage').state, 'ready');
  } finally {
    instance.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readiness reports a storage that cannot be opened', () => {
  const instance = runtime();
  try {
    // A closed database cannot answer a read.
    const closed = new SQLiteDiscoveryStore(':memory:');
    closed.close();
    const broken = { ...instance, store: closed };

    const report = verifyReadiness({ runtime: broken, probeStorage: true });
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((check) => check.name === 'storage').state, 'not-ready');
  } finally {
    instance.dispose();
  }
});

test('readiness checks the current policy pointer when a registry is given', () => {
  const instance = runtime();
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  try {
    // No deployment yet is the initial state, not a fault.
    const initial = verifyReadiness({ runtime: instance, registry });
    assert.equal(initial.checks.find((check) => check.name === 'currentPolicy').state, 'ready');
    assert.match(initial.checks.find((check) => check.name === 'currentPolicy').detail, /no policy has been deployed/);

    assert.equal(verifyReadiness({ runtime: instance }).checks.some((c) => c.name === 'currentPolicy'), false);

    const artifact = createPolicyArtifact({
      version: 'v1',
      parentVersion: null,
      source: 'export const decide = () => 1;',
      manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
      allowedCapabilities: ['scheduling'],
      createdBy: 'human',
      createdAt: AT
    });
    registry.registerPolicy(artifact);
    registry.restoreCurrentPolicy(artifact.artifactId);

    const deployed = verifyReadiness({ runtime: instance, registry });
    assert.equal(deployed.checks.find((check) => check.name === 'currentPolicy').state, 'ready');
    // Anchored: a loose /v1/ also matches a doubled `vv1`, which is what the
    // literal prefix produced.
    assert.match(deployed.checks.find((check) => check.name === 'currentPolicy').detail, /^v1 \([0-9a-f]{12}\)$/);
  } finally {
    instance.dispose();
  }
});

test('the status tool surfaces readiness and still opens nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-status-ready-'));
  const config = resolveDreamRsiConfig({ storage: { sqlitePath: join(dir, 'discovery.db') } });
  const instance = createDreamRsiRuntime(config);
  try {
    const withoutRuntime = getDreamRsiStatus(config);
    assert.equal(withoutRuntime.readiness, undefined);

    const status = getDreamRsiStatus(config, instance);
    assert.ok(status.readiness);
    // The current-policy check runs now that the registry view is supplied; it
    // reports ready because no policy has been deployed, which is the initial
    // state rather than a fault.
    assert.deepEqual(status.readiness.checks.map((check) => check.state), [
      'not-probed',
      'ready',
      'ready',
      'ready'
    ]);
    assert.deepEqual(status.readiness.checks.map((check) => check.name), [
      'storage',
      'capabilityProfile',
      'evaluatorWorker',
      'currentPolicy'
    ]);
    // The whole point of `not-probed`: the tool stays side-effect free.
    assert.deepEqual(instance.store.readAll(), []);
  } finally {
    instance.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline settings still carry the configured holdout floor', () => {
  const instance = runtime({ evaluation: { minimumHoldoutSamples: 7 } });
  try {
    assert.equal(pipelineSettings(instance).minimumHoldoutSamples, 7);
  } finally {
    instance.dispose();
  }
});
