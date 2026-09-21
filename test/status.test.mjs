import assert from 'node:assert/strict';
import test from 'node:test';

import { getDreamRsiStatus, createStatusTool } from '../dist/status.js';
import { DEFAULT_DREAM_RSI_CONFIG } from '../dist/config.js';

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
