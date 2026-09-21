import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryDiscoveryStore, SQLiteDiscoveryStore } from '../dist/index.js';
import { DEFAULT_EVALUATOR_CONFIG, evaluateReplay } from '../dist/evolution/evaluator.js';

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
  idempotencyKey: 'sqlite-action-1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z'
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

test('SQLite repository round-trips optional episode/session fields', () => {
  const store = new SQLiteDiscoveryStore(':memory:');
  const enriched = {
    ...node,
    nodeId: 'node-sqlite-2',
    idempotencyKey: 'sqlite-action-2',
    criticalPathMs: 8,
    sessionId: 'session-1',
    episodeStep: 3,
    correlationId: 'correlation-1'
  };

  store.append(enriched);

  assert.deepEqual(store.get(enriched.nodeId), enriched);
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

test('a zero denominator is floored rather than dividing by zero', () => {
  // `positive` exists so a zero reference or an instantaneous episode keeps a
  // ratio defined instead of producing Infinity. A sweep mutation made the floor
  // 0 instead of 1 and no test noticed, because the pipeline never passes a zero
  // critical path — but the evaluator is exported and a caller can.
  const result = evaluateReplay(
    { visitedNodes: [node], boundaryMissCount: 0, totalAttempts: 1, criticalPathMs: 0 },
    { ...DEFAULT_EVALUATOR_CONFIG, qualityReference: 0, costBudget: 0, idealParallelEfficiency: 0 }
  );

  for (const [name, value] of Object.entries(result)) {
    assert.ok(Number.isFinite(value), `${name} is ${value}`);
  }
});

test('the stored schema version is read back rather than defaulted', () => {
  // The existing round-trip test uses the current schema version, so a store
  // that returned the constant 1 instead of the stored column passed it. The
  // field exists so a reader can tell which schema wrote a node, which is worth
  // nothing if the answer is always the one this build happens to use.
  const store = new SQLiteDiscoveryStore(':memory:');
  const fromOtherSchema = { ...node, nodeId: 'from-other-schema', schemaVersion: 2 };
  store.append(fromOtherSchema);

  assert.equal(store.get('from-other-schema').schemaVersion, 2);
  assert.equal(store.readAll().find((entry) => entry.nodeId === 'from-other-schema').schemaVersion, 2);
  assert.deepEqual(store.get('from-other-schema'), fromOtherSchema);
  store.close();
});

test('both stores refuse a repeated node id the same way, and keep the first record', () => {
  // The port has two implementations. A node id is unique and an idempotency
  // key is the retry identity: a second append with the same key returns the
  // stored node, while the same *id* under a different key is a collision. The
  // SQLite store used to report that as a primary-key error naming the column,
  // which no caller can match on and which the in-memory store never produced.
  for (const [label, store] of [['in-memory', new InMemoryDiscoveryStore()], ['sqlite', new SQLiteDiscoveryStore(':memory:')]]) {
    store.append(node);
    assert.throws(
      () => store.append({ ...node, idempotencyKey: 'a-different-key', score: 0.1 }),
      new RegExp(`node ${node.nodeId} already exists`),
      `${label} must name the node it refused`
    );
    // Refused, not replaced: the first node is what the store holds.
    assert.equal(store.get(node.nodeId).score, node.score, `${label} must keep the stored node`);
    assert.equal(store.readAll().length, 1, `${label} must not have stored a second node`);
    if (store.close) store.close();
  }
});
