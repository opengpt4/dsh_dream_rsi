import assert from 'node:assert/strict';
import test from 'node:test';

import { SQLiteDiscoveryStore } from '../dist/discovery/sqlite-store.js';
import { evaluateReplay } from '../dist/evolution/evaluator.js';

const node = {
  nodeId: 'node-sqlite-1',
  taskId: 'task-sqlite',
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
  idempotencyKey: 'sqlite-action-1'
};

test('SQLite repository persists and deduplicates discovery nodes', () => {
  const store = new SQLiteDiscoveryStore(':memory:');
  store.append(node);
  const retry = store.append({ ...node, nodeId: 'retry-node' });

  assert.equal(retry.nodeId, node.nodeId);
  assert.deepEqual(store.get(node.nodeId), node);
  assert.deepEqual(store.listByTask(node.taskId), [node]);
  store.close();
});

test('evaluator returns deterministic normalized Q/C/P/M metrics', () => {
  const result = evaluateReplay({
    visitedNodes: [node],
    boundaryMissCount: 1,
    totalAttempts: 4,
    criticalPathMs: 6
  }, {
    qualityReference: 1,
    costBudget: 100,
    idealParallelEfficiency: 1,
    gamma: 0.1,
    qualityWeight: 1,
    costWeight: 0.3,
    parallelWeight: 0.1,
    boundaryPenalty: 10
  });

  assert.equal(result.quality, 0.8);
  assert.equal(Number(result.cost.toFixed(6)), 0.112);
  assert.equal(result.parallelEfficiency, 2);
  assert.equal(result.missRate, 0.25);
  assert.equal(Number(result.score.toFixed(6)), -1.5336);
});