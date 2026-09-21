import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getDreamRsiStatus, createStatusTool } from '../dist/status.js';
import {
  DEFAULT_DREAM_RSI_CONFIG,
  createDreamRsiRuntime,
  resolveDreamRsiConfig,
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
      'evaluatorWorker'
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
