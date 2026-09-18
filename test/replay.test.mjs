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
  idempotencyKey: 'action-1'
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
