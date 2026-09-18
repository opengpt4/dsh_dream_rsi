import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DREAM_RSI_CONFIG,
  resolveDreamRsiConfig,
  validateDreamRsiConfig
} from '../dist/config.js';

test('config defaults keep evolution and embodied execution disabled', () => {
  const config = resolveDreamRsiConfig();
  assert.equal(config.evolution.enabled, false);
  assert.equal(config.evolution.autoDeploy, false);
  assert.equal(config.embodied.enabled, false);
  assert.deepEqual(config, DEFAULT_DREAM_RSI_CONFIG);
});

test('config merges nested overrides without changing safety defaults', () => {
  const config = resolveDreamRsiConfig({ runtime: { maxWorkers: 2 } });
  assert.equal(config.runtime.maxWorkers, 2);
  assert.equal(config.evolution.autoDeploy, false);
  assert.equal(config.embodied.requireConfirmation, true);
});

test('config rejects invalid ratios and unsafe auto-deploy setup', () => {
  assert.throws(() => resolveDreamRsiConfig({ evaluation: { holdoutRatio: 0.2 } }), /ratios must sum to 1/);
  assert.throws(() => resolveDreamRsiConfig({ evolution: { autoDeploy: true } }), /requires evolution.enabled/);
});

test('disabled configuration skips enabled-only validation', () => {
  const config = { ...DEFAULT_DREAM_RSI_CONFIG, enabled: false, runtime: { ...DEFAULT_DREAM_RSI_CONFIG.runtime, maxWorkers: 0 } };
  assert.doesNotThrow(() => validateDreamRsiConfig(config));
});