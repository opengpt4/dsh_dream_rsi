import assert from 'node:assert/strict';
import test from 'node:test';

import { Config } from '../dist/index.js';
import {
  DEFAULT_DREAM_RSI_CONFIG,
  DreamRsiConfigSchema,
  resolveDreamRsiConfig
} from '../dist/config.js';

test('the exported Config is the host-facing schema and a Standard Schema', () => {
  assert.equal(Config, DreamRsiConfigSchema);
  assert.equal(typeof Config['~standard'], 'object');
  assert.equal(typeof Config['~standard'].validate, 'function');
});

test('defaults are derived from the schema, so both stay in step', () => {
  const fromSchema = DreamRsiConfigSchema({});
  assert.deepEqual(fromSchema, DEFAULT_DREAM_RSI_CONFIG);
});

test('defaults keep evolution, auto-deployment, and embodied execution off', () => {
  const config = resolveDreamRsiConfig();
  assert.equal(config.evolution.enabled, false);
  assert.equal(config.evolution.autoDeploy, false);
  assert.equal(config.embodied.enabled, false);
  assert.equal(config.embodied.requireConfirmation, true);
});

test('a partial nested override keeps its sibling defaults', () => {
  const config = resolveDreamRsiConfig({ runtime: { maxWorkers: 2 } });
  assert.deepEqual(config.runtime, { maxWorkers: 2, taskTimeoutMs: 300_000 });
  const evaluation = resolveDreamRsiConfig({ evaluation: { trainRatio: 0.75, holdoutRatio: 0.1 } }).evaluation;
  assert.equal(evaluation.validationRatio, 0.15);
  assert.equal(evaluation.minimumHoldoutSamples, 20);
});

test('the schema reports field-level issues for a wrong type', () => {
  const result = DreamRsiConfigSchema['~standard'].validate({ runtime: { maxWorkers: 'many' } });
  assert.notEqual(result instanceof Promise, true);
  assert.equal(Array.isArray(result.issues), true);
  assert.match(result.issues[0].message, /maxWorkers expected number/);
});

test('cross-field invariants still run after the schema', () => {
  assert.throws(() => resolveDreamRsiConfig({ evaluation: { holdoutRatio: 0.2 } }), /ratios must sum to 1/);
  assert.throws(() => resolveDreamRsiConfig({ evolution: { autoDeploy: true } }), /requires evolution.enabled/);
});
