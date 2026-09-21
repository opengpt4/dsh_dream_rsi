import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryDiscoveryStore } from '../dist/discovery/models.js';
import { createReplayKey } from '../dist/replay/key.js';
import { ReplaySimulator } from '../dist/replay/simulator.js';

const baseNode = {
  nodeId: 'node-1',
  taskId: 'task-1',
  parentId: null,
  policyVersion: 'policy-1',
  environmentVersion: 'mock-room-v1',
  stateHash: 'state-1',
  observationHash: 'observation-1',
  actionType: 'move_relative',
  actionParams: { dx: 1, dy: 0, dz: 0 },
  result: { success: true },
  score: 0.8,
  tokenCost: 10,
  execTimeMs: 12,
  idempotencyKey: 'action-1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z'
};

test('canonical replay keys are stable across object key order', () => {
  const first = createReplayKey({
    environmentVersion: 'mock-room-v1',
    stateHash: 'state-1',
    actionType: 'move_relative',
    normalizedActionParams: { dx: 1, dy: 0 },
    observationHash: 'observation-1'
  });
  const second = createReplayKey({
    environmentVersion: 'mock-room-v1',
    stateHash: 'state-1',
    actionType: 'move_relative',
    normalizedActionParams: { dy: 0, dx: 1 },
    observationHash: 'observation-1'
  });

  assert.equal(first, second);
});

test('replays a known transition and exposes metrics', () => {
  const simulator = new ReplaySimulator([baseNode]);
  const result = simulator.execute({
    environmentVersion: 'mock-room-v1',
    stateHash: 'state-1',
    actionType: 'move_relative',
    normalizedActionParams: { dx: 1, dy: 0, dz: 0 },
    observationHash: 'observation-1'
  });

  assert.equal(result.kind, 'hit');
  assert.deepEqual(simulator.metrics(), {
    hitCount: 1,
    missCount: 0,
    visitedNodeIds: ['node-1']
  });
});

test('returns a boundary miss with alternative actions for a counterfactual', () => {
  const simulator = new ReplaySimulator([baseNode]);
  const result = simulator.execute({
    environmentVersion: 'mock-room-v1',
    stateHash: 'state-1',
    actionType: 'goto',
    normalizedActionParams: { x: 4, y: 2, z: 0 },
    observationHash: 'observation-1'
  });

  assert.equal(result.kind, 'boundary_miss');
  assert.deepEqual(result.availableActionTypes, ['move_relative']);
});

test('discovery store deduplicates retries by idempotency key', () => {
  const store = new InMemoryDiscoveryStore();
  const first = store.append(baseNode);
  const retry = store.append({ ...baseNode, nodeId: 'different-node-id' });

  assert.equal(retry.nodeId, first.nodeId);
  assert.equal(store.listByTask('task-1').length, 1);
});

test('a replay key covers the environment version', () => {
  // The key is the canonical encoding of five fields, and the environment is one
  // of them: two environments that happen to agree on a state hash are still
  // different states, so the key must not resolve across them. Dropping the
  // field from the key survived every other test.
  const here = { ...baseNode, nodeId: 'here', environmentVersion: 'mock-room-v1' };
  const elsewhere = { ...baseNode, nodeId: 'elsewhere', environmentVersion: 'other-room-v1' };
  const simulator = new ReplaySimulator([here]);

  const keyOf = (node) => createReplayKey({
    environmentVersion: node.environmentVersion,
    stateHash: node.stateHash,
    actionType: node.actionType,
    normalizedActionParams: node.actionParams,
    observationHash: node.observationHash
  });

  assert.notEqual(keyOf(here), keyOf(elsewhere));

  const result = simulator.execute({
    environmentVersion: elsewhere.environmentVersion,
    stateHash: elsewhere.stateHash,
    actionType: elsewhere.actionType,
    normalizedActionParams: elsewhere.actionParams,
    observationHash: elsewhere.observationHash
  });
  assert.equal(result.kind, 'boundary_miss');

  // The counter-check: the same key does resolve, so the miss above is about the
  // environment rather than about a lookup that never works.
  assert.equal(simulator.execute({
    environmentVersion: here.environmentVersion,
    stateHash: here.stateHash,
    actionType: here.actionType,
    normalizedActionParams: here.actionParams,
    observationHash: here.observationHash
  }).kind, 'hit');
});
