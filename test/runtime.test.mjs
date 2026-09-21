import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDreamRsiRuntime,
  DEFAULT_DREAM_RSI_CONFIG,
  resolveDreamRsiConfig
} from '../dist/index.js';

function sampleNode(overrides = {}) {
  return {
    nodeId: 'node-1',
    taskId: 'task-1',
    parentId: null,
    policyVersion: 'policy-1',
    environmentVersion: 'mock-room-v1',
    stateHash: 'state-1',
    observationHash: 'observation-1',
    actionType: 'pick',
    actionParams: { objectId: 'red-mug' },
    result: { success: true },
    score: 0.8,
    tokenCost: 10,
    execTimeMs: 5,
    idempotencyKey: 'task-1:step-1',
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('an in-memory config keeps storage off the filesystem', () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));

  runtime.store.append(sampleNode());

  assert.equal(runtime.store.get('node-1')?.nodeId, 'node-1');
  runtime.dispose();
});

test('a file config creates the database on first store access, not at construction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-rsi-runtime-'));
  const databasePath = join(directory, 'nested', 'discovery.db');
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: databasePath } }));

  assert.equal(existsSync(databasePath), false);

  runtime.store.append(sampleNode());

  assert.equal(existsSync(databasePath), true);
  assert.equal(runtime.store.get('node-1')?.taskId, 'task-1');

  runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

test('invalid config throws before the database directory is created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-rsi-invalid-'));
  const databasePath = join(directory, 'nested', 'discovery.db');
  const invalid = {
    ...DEFAULT_DREAM_RSI_CONFIG,
    storage: { ...DEFAULT_DREAM_RSI_CONFIG.storage, sqlitePath: databasePath },
    evaluation: { ...DEFAULT_DREAM_RSI_CONFIG.evaluation, holdoutRatio: 0.9 }
  };

  assert.throws(() => createDreamRsiRuntime(invalid), /ratios must sum to 1/);
  assert.equal(existsSync(join(directory, 'nested')), false);

  rmSync(directory, { recursive: true, force: true });
});

test('the split config carries the configured ratios', () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({
    storage: { sqlitePath: ':memory:' },
    evaluation: { trainRatio: 0.8, validationRatio: 0.1, holdoutRatio: 0.1 }
  }));

  assert.equal(runtime.splitConfig.trainRatio, 0.8);
  assert.equal(runtime.splitConfig.validationRatio, 0.1);
  assert.equal(runtime.splitConfig.holdoutRatio, 0.1);
  assert.equal(typeof runtime.splitConfig.seed, 'string');

  runtime.dispose();
});

test('locks are constructed from the configured paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-rsi-locks-'));
  const evolutionLock = join(directory, 'locks', 'evolution.lock');
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({
    storage: { sqlitePath: ':memory:' },
    operations: { evolutionLock, deploymentLock: join(directory, 'locks', 'deployment.lock') }
  }));

  runtime.evolutionLock.acquire();
  assert.equal(existsSync(evolutionLock), true);
  runtime.evolutionLock.release();
  assert.equal(existsSync(evolutionLock), false);

  runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

test('dispose is idempotent', () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  runtime.store.append(sampleNode());

  runtime.dispose();

  assert.doesNotThrow(() => runtime.dispose());
});
