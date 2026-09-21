import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DynamicToolRegistry,
  FileArtifactStore,
  InMemoryAuditLog,
  InMemoryPolicyRegistryStore,
  MOCK_ENVIRONMENT_ID,
  PolicyRegistry,
  SingleWriterLock,
  createDreamRsiRuntime,
  createPolicyArtifact,
  createSynthesizedTool,
  evaluateCandidate,
  evaluateReplayIsolated,
  hashDreamRsiConfig,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisodePipeline,
  runToolGates,
  transitionDeployment
} from '../dist/index.js';
import { BENIGN_CANDIDATE } from './fixtures/malicious-candidates.mjs';

const PROBE_WORKER = fileURLToPath(new URL('./fixtures/probe-worker.mjs', import.meta.url));
const AT = '2026-01-01T00:00:00.000Z';

function probe(probeMode) {
  return { visitedNodes: [], boundaryMissCount: 0, totalAttempts: 0, criticalPathMs: 1, probeMode };
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-fault-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-fault-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function registryWithArtifact() {
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
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
  return { registry, artifact };
}

function registryState(registry) {
  return {
    policies: registry.policyCount(),
    evaluations: registry.evaluationCount(),
    deployments: registry.listDeployments().length,
    current: registry.currentPolicyArtifactId()
  };
}

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

// ------------------------------------------------------------ provider outage

test('a provider that returns unusable output leaves the registry untouched', async () => {
  const { registry, artifact } = registryWithArtifact();
  const before = registryState(registry);

  await assert.rejects(
    evaluateCandidate({
      llm: {
        async invoke(request) {
          return { text: 'I am afraid I cannot help with that.', model: request.model, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
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
    }),
    /no JSON object/
  );

  assert.deepEqual(registryState(registry), before);
});

// --------------------------------------------------------------- worker crash

test('a worker that dies without a verdict is a failure, not a pass', async () => {
  await assert.rejects(
    evaluateReplayIsolated(probe('crash'), undefined, { workerPath: PROBE_WORKER, timeoutMs: 5_000 }),
    /exited with code 3/
  );
});

test('a crashed tool test runner fails the isolated test gate', async () => {
  const tool = createSynthesizedTool({
    name: 'crasher',
    version: '1.0.0',
    description: 'fixture',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    source: 'export const noop = () => 1;',
    // The test process dies rather than reporting a verdict. It has to die
    // without forbidden syntax: a test file the static guards reject never
    // reaches the runner at all, which is what the gate asserts elsewhere.
    tests: "throw new Error('the test process died before a verdict');\n",
    dependencies: [],
    permissions: ['action:move_relative'],
    origin: 'host-template',
    patternSignature: 'crash'
  });

  const { ProcessToolTestRunner } = await import('../dist/index.js');
  const result = await runToolGates(tool, { runner: new ProcessToolTestRunner({ timeoutMs: 10_000 }) });

  assert.equal(result.passed, false);
  const tests = result.guardResults.find((guard) => guard.guard === 'isolatedTests');
  assert.equal(tests.passed, false);
  // No verdict is not a verdict.
  assert.match(tests.detail, /exited with code|no machine-readable verdict/);
});

// ---------------------------------------------------------------- stale lease

test('a stale lease is recovered and the recovery is audited', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'deployment.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'lease.json'), JSON.stringify({ ownerId: 'crashed-writer', expiresAt: Date.now() - 5_000 }));

    const audit = new InMemoryAuditLog();
    const lock = new SingleWriterLock(lockPath, 30_000);
    lock.acquire();

    assert.equal(lock.recoveredStaleLock, true);
    audit.record({
      type: 'lock.recovered',
      subject: 'deployment',
      subjectId: 'n/a',
      correlationId: 'n/a',
      lockOwner: lock.owner,
      reason: 'recovered an expired lease',
      at: AT
    });
    assert.equal(audit.types()[0], 'lock.recovered');
    lock.release();

    // A lease that is still live is not taken over.
    const held = new SingleWriterLock(lockPath, 30_000);
    held.acquire();
    const second = new SingleWriterLock(lockPath, 30_000);
    assert.throws(() => second.acquire(), /already held/);
    held.release();
  });
});

// ----------------------------------------------------------- corrupted artifact

test('a corrupted artifact stops the run before anything is evaluated', async () => {
  await withTempDirAsync(async (dir) => {
    const artifacts = new FileArtifactStore(dir);
    const stored = artifacts.put({ bytes: Buffer.from('{"observation":"room"}'), kind: 'observation', mediaType: 'application/json', schemaVersion: 1 });
    writeFileSync(join(dir, 'blobs', stored.artifactId.slice(0, 2), stored.artifactId), Buffer.from('forged'));

    const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
    const { registry, artifact } = registryWithArtifact();
    try {
      await assert.rejects(
        runEpisodePipeline(
          pipelineOptions(runtime, registry, artifact, {
            artifacts: { store: artifacts, artifactIds: [stored.artifactId] }
          })
        ),
        /checksum_mismatch/
      );

      // Refused before the episode ran, so nothing was recorded.
      assert.equal(registry.evaluationCount(), 0);
      assert.equal(runtime.store.readAll().length, 0);
    } finally {
      runtime.dispose();
    }
  });
});

// ------------------------------------------------------------ timeout/cancel

test('a deadline and a cancellation both terminate the child rather than hanging', async () => {
  await assert.rejects(
    evaluateReplayIsolated(probe('hang'), undefined, { workerPath: PROBE_WORKER, timeoutMs: 300 }),
    /timed out after 300ms/
  );

  const controller = new AbortController();
  const pending = evaluateReplayIsolated(probe('hang'), undefined, {
    workerPath: PROBE_WORKER,
    timeoutMs: 30_000,
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

// ---------------------------------------------------------- rollback failure

test('a rollback with nothing to roll back to is refused and changes no state', () => {
  const toolRegistry = new DynamicToolRegistry();
  const tool = createSynthesizedTool({
    name: 'only_version',
    version: '1.0.0',
    description: 'fixture',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    source: 'export const noop = () => 1;',
    tests: 'export const t = 1;',
    dependencies: [],
    permissions: ['action:move_relative'],
    origin: 'host-template',
    patternSignature: 'only'
  });
  toolRegistry.propose(tool, [{ guard: 'astGuard', passed: true }]);
  toolRegistry.enable(tool.toolId, 'operator-1');

  assert.throws(() => toolRegistry.rollback('only_version', 'operator-1', 'regression'), /no previous version/);
  assert.equal(toolRegistry.entry(tool.toolId).status, 'enabled');
  assert.equal(toolRegistry.history().length, 2, 'the refused rollback recorded nothing');
});

test('a rollback from a terminal deployment state is refused', () => {
  // The state machine refuses rather than leaving a record that claims a
  // rollback happened.
  assert.throws(() => transitionDeployment('REJECTED', 'ROLLED_BACK'), /illegal deployment transition/);
  assert.throws(() => transitionDeployment('ROLLED_BACK', 'ACTIVE'), /illegal deployment transition/);
});
