import assert from 'node:assert/strict';
import test from 'node:test';

import { getDreamRsiStatus, createStatusTool } from '../dist/status.js';
import { DEFAULT_DREAM_RSI_CONFIG, createDreamRsiRuntime, resolveDreamRsiConfig } from '../dist/index.js';

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
