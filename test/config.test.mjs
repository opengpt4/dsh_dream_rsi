import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DREAM_RSI_CONFIG,
  resolveDreamRsiConfig,
  validateDreamRsiConfig
} from '../dist/config.js';
import {
  DEFAULT_HOLDOUT_GATE_CONFIG,
  createEvaluationReport,
  evaluateHoldoutGate,
  replayNodes
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const CONFIG_HASH = 'c'.repeat(64);

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

test('the values a disabled configuration skips are refused where they are used', () => {
  // The skip is deliberate, and it is only safe because each consumer validates
  // what it is handed. Nothing asserted that, so dropping `replayNodes`' own
  // check would have moved the failure from load time to a silently unusable
  // replay — or, for the gate's floor, to a sample requirement nothing meets.
  const disabled = resolveDreamRsiConfig({
    enabled: false,
    evaluation: { minimumHoldoutSamples: -1 },
    replay: { maxNodes: 0 }
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.evaluation.minimumHoldoutSamples, -1);
  assert.equal(disabled.replay.maxNodes, 0);

  // The same values are refused when the plugin is enabled.
  assert.throws(
    () => resolveDreamRsiConfig({ evaluation: { minimumHoldoutSamples: -1 } }),
    /evaluation\.minimumHoldoutSamples must be a positive integer/
  );
  assert.throws(
    () => resolveDreamRsiConfig({ replay: { maxNodes: 0 } }),
    /replay\.maxNodes must be a positive integer/
  );

  // And refused at the point of use, which is what carries the skip.
  assert.throws(() => replayNodes([], { replayMaxNodes: disabled.replay.maxNodes }), /replayMaxNodes must be a positive integer/);
  assert.throws(
    () =>
      evaluateHoldoutGate({
        incumbent: holdoutReport('incumbent'),
        candidate: holdoutReport('candidate'),
        configurationHash: CONFIG_HASH,
        config: { ...DEFAULT_HOLDOUT_GATE_CONFIG, minimumHoldoutSamples: disabled.evaluation.minimumHoldoutSamples }
      }),
    /minimumHoldoutSamples must be a non-negative integer/
  );
});

/** A holdout report with one case, enough to reach the gate's config check. */
function holdoutReport(caseId) {
  return createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    policyArtifactId: 'd'.repeat(64),
    split: 'holdout',
    configHash: CONFIG_HASH,
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [{ caseId, taskFamily: 'family', split: 'holdout', outcome: 'passed', quality: 1, score: 1 }],
    sampleCount: 1,
    passed: true,
    guardResults: [],
    createdAt: AT
  });
}