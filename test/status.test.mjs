import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getDreamRsiStatus, createStatusTool } from '../dist/status.js';
import {
  DEFAULT_DREAM_RSI_CONFIG,
  DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  DEFAULT_MAX_OUTPUT_BYTES,
  FilePolicyRegistryStore,
  PolicyRegistry,
  createDreamRsiRuntime,
  createEvaluationReport,
  createPolicyArtifact,
  resolveDreamRsiConfig,
  signPolicyArtifact,
  verifyReadiness
} from '../dist/index.js';

test('getDreamRsiStatus projects safety-relevant config without mutation risk', () => {
  const status = getDreamRsiStatus(DEFAULT_DREAM_RSI_CONFIG);

  assert.equal(status.enabled, true);
  assert.equal(status.evolutionEnabled, false);
  assert.equal(status.autoDeployEnabled, false);
  assert.equal(status.embodiedEnabled, false);
  assert.equal(status.storage.sqlitePath, DEFAULT_DREAM_RSI_CONFIG.storage.sqlitePath);
});

test('dream_status tool reports current config with no side effects', async () => {
  const tool = createStatusTool(DEFAULT_DREAM_RSI_CONFIG);
  const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });

  assert.equal(result.enabled, true);
  assert.equal(result.evolution_enabled, false);
  assert.equal(result.auto_deploy_enabled, false);
  assert.equal(result.embodied_enabled, false);
  assert.equal(result.storage.sqlite_path, DEFAULT_DREAM_RSI_CONFIG.storage.sqlitePath);
  assert.equal(result.evaluation.train_ratio, DEFAULT_DREAM_RSI_CONFIG.evaluation.trainRatio);
});

test('the status carries the controls that decide what an action may do', async () => {
  // The enabled flags say a capability is on, not what it permits: whether a
  // high-risk action needs confirmation, which actions are admitted, how often,
  // and how good a candidate must be to replace the live policy all live in the
  // safety controls, so the projection has to carry them.
  const config = resolveDreamRsiConfig({
    embodied: { enabled: true, allowActions: ['pick'], requireConfirmation: false, maxActionsPerMinute: 7 },
    evolution: { minimumPassRatio: 0.8, minimumImprovement: 0.25 }
  });
  const status = getDreamRsiStatus(config);

  assert.deepEqual(status.safetyControls, {
    requireConfirmation: false,
    allowedActions: ['pick'],
    actionLeaseMs: config.embodied.actionLeaseMs,
    maxActionsPerMinute: 7,
    minimumPassRatio: 0.8,
    minimumImprovement: 0.25
  });

  const tool = createStatusTool(config);
  const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });

  assert.deepEqual(result.safety_controls, {
    require_confirmation: false,
    allowed_actions: ['pick'],
    action_lease_ms: config.embodied.actionLeaseMs,
    max_actions_per_minute: 7,
    minimum_pass_ratio: 0.8,
    minimum_improvement: 0.25
  });
});

test('the projected action list is a copy', () => {
  // The projection must not hand out the config's array: a caller that sorted or
  // emptied it would be editing the running configuration.
  const config = resolveDreamRsiConfig({ embodied: { enabled: true, allowActions: ['pick'] } });
  const status = getDreamRsiStatus(config);

  status.safetyControls.allowedActions.push('place');
  assert.deepEqual(config.embodied.allowActions, ['pick']);
});

test('the tool reports readiness when it is given a runtime', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const tool = createStatusTool(runtime.config, runtime);
    const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });

    // The tool is what a model reads, so it has to carry readiness itself. It
    // previously accepted a runtime and dropped it, which left the field on the
    // function and not in the output.
    assert.ok(result.readiness, 'the tool must report readiness');
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.readiness.checks.map((check) => check.name), [
      'storage',
      'capabilityProfile',
      'evaluatorWorker',
      'currentPolicy'
    ]);
    assert.match(result.readiness.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    runtime.dispose();
  }
});

test('the tool omits readiness rather than inventing it when given no runtime', async () => {
  const tool = createStatusTool(DEFAULT_DREAM_RSI_CONFIG);
  const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });

  assert.equal(result.readiness, undefined);
  assert.equal('readiness' in result, false);
});

test('the status tool does not create the storage it reports on', async () => {
  // The tool advertises "no side effects", and opening the store is what creates
  // the database file and its directory. Readiness reports `not-probed` rather
  // than opening it, which is what keeps a read-only surface read-only.
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-status-'));
  const sqlitePath = join(dir, 'nested', 'discovery.sqlite');
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath } }));
  try {
    const tool = createStatusTool(runtime.config, runtime);
    const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });

    assert.equal(existsSync(sqlitePath), false, 'the status tool created the database');
    assert.equal(
      result.readiness.checks.find((check) => check.name === 'storage').state,
      'not-probed',
      'readiness opened the store'
    );

    // The counter-check. Without it the assertion above would also pass if the
    // path were simply wrong or nothing ever opened it.
    verifyReadiness({ runtime, probeStorage: true });
    assert.equal(existsSync(sqlitePath), true, 'probing is what opens the store');
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- the registry the status reads

function artifact(overrides = {}) {
  return createPolicyArtifact({
    version: 'v1',
    parentVersion: null,
    source: 'export const decide = () => 1;',
    manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  });
}

function reportFor(artifactId, overrides = {}) {
  return createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    policyArtifactId: artifactId,
    split: 'holdout',
    configHash: 'c'.repeat(64),
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [],
    sampleCount: 4,
    passed: true,
    guardResults: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  });
}

test('the status reports what the registry holds without creating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-status-registry-'));
  const registryDir = join(dir, 'registry');
  try {
    // An absent registry is the state before anything was registered, not a
    // fault: the probe must read it and leave it absent.
    const missing = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:', registryDir } }));
    try {
      const probe = getDreamRsiStatus(missing.config, missing).registry;
      assert.equal(probe.state, 'read');
      assert.equal(probe.policyCount, 0);
      assert.equal(probe.currentPolicy, null);
      assert.equal(probe.latestEvaluation, null);
      assert.equal(existsSync(registryDir), false, 'the status call must not create the registry');
    } finally {
      missing.dispose();
    }

    const written = new PolicyRegistry(new FilePolicyRegistryStore(registryDir));
    const first = artifact();
    written.registerPolicy(first);
    const signed = signPolicyArtifact(artifact({ version: 'v2', parentVersion: 'v1' }), {
      privateKeyPem: generateKeyPairSync('ed25519').privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      keyId: 'rotate-2026'
    });
    written.registerPolicy(signed);
    written.registerEvaluation(reportFor(first.artifactId));
    written.registerEvaluation(
      reportFor(first.artifactId, { createdAt: '2026-03-01T00:00:00.000Z', sampleCount: 9 })
    );
    written.restoreCurrentPolicy(signed.artifactId);

    const instance = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:', registryDir } }));
    try {
      const probe = getDreamRsiStatus(instance.config, instance).registry;
      assert.equal(probe.state, 'read');
      assert.equal(probe.policyCount, 2);
      assert.equal(probe.evaluationCount, 2);
      assert.equal(probe.deploymentCount, 0);
      // The projection says whether a signature is present, and leaves whether
      // it verifies to the gate that has the key ring.
      assert.deepEqual(probe.currentPolicy, { artifactId: signed.artifactId, version: 'v2', signed: true });
      assert.equal(probe.latestEvaluation.sampleCount, 9);
      assert.equal(probe.latestEvaluation.passed, true);
      assert.equal(probe.latestEvaluation.signed, false);

      // The current-policy readiness check now has a registry to ask.
      const status = getDreamRsiStatus(instance.config, instance);
      assert.deepEqual(status.readiness.checks.find((check) => check.name === 'currentPolicy').state, 'ready');
    } finally {
      instance.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt registry is reported rather than thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-status-corrupt-'));
  const registryDir = join(dir, 'registry');
  try {
    writeFileSync(join(dir, 'placeholder'), '');
    mkdirSync(join(registryDir, 'policies'), { recursive: true });
    writeFileSync(join(registryDir, 'policies', 'not-a-hash.json'), JSON.stringify({ artifactId: 'nope' }));

    const instance = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:', registryDir } }));
    try {
      const probe = getDreamRsiStatus(instance.config, instance).registry;
      assert.equal(probe.state, 'unreadable');
      // A record that cannot even be verified names the corruption and the id;
      // a property access error from inside the verifier tells an operator
      // nothing about which file to look at.
      assert.match(probe.detail, /registry is corrupt: policy nope could not be verified/);
    } finally {
      instance.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable pointer is reported as corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-status-pointer-'));
  const registryDir = join(dir, 'registry');
  try {
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, 'current.json'), '{ this is not json');

    const instance = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:', registryDir } }));
    try {
      const probe = getDreamRsiStatus(instance.config, instance).registry;
      assert.equal(probe.state, 'unreadable');
      assert.match(probe.detail, /current\.json is unreadable/);
    } finally {
      instance.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the status reports the limits the evaluator enforces', async () => {
  const config = resolveDreamRsiConfig({ evaluation: { timeoutMs: 12_345 } });
  const status = getDreamRsiStatus(config);

  // Read from the constants the child is launched with, so the report cannot
  // drift from the enforcement.
  assert.deepEqual(status.resources, {
    heapCapMb: DEFAULT_MAX_OLD_SPACE_SIZE_MB,
    wallClockMs: 12_345,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES
  });

  const tool = createStatusTool(config);
  const result = await tool.execute({}, { callId: 'call-1', signal: new AbortController().signal });
  assert.deepEqual(result.resources, {
    heap_cap_mb: DEFAULT_MAX_OLD_SPACE_SIZE_MB,
    wall_clock_ms: 12_345,
    max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES
  });
  // No runtime means no registry to read, so the tool omits it rather than
  // reporting an empty one.
  assert.equal('registry' in result, false);
});
