import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateMonotonicGate } from '../dist/evolution/monotonic-gate.js';
import { splitDiscoveryNodes } from '../dist/evolution/split.js';

const node = (taskId, nodeId) => ({
  nodeId,
  taskId,
  parentId: null,
  policyVersion: 'policy-1',
  environmentVersion: 'mock-room-v1',
  stateHash: `state-${nodeId}`,
  observationHash: `observation-${nodeId}`,
  actionType: 'observe',
  actionParams: {},
  result: { success: true },
  score: 0.8,
  tokenCost: 1,
  execTimeMs: 1,
  idempotencyKey: nodeId,
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z'
});

test('evaluation split is deterministic and keeps a task in one partition', () => {
  const nodes = [node('task-a', 'a-1'), node('task-a', 'a-2'), node('task-b', 'b-1'), node('task-c', 'c-1')];
  const first = splitDiscoveryNodes(nodes, { trainRatio: 0.5, validationRatio: 0.25, holdoutRatio: 0.25, seed: 'test' });
  const second = splitDiscoveryNodes(nodes, { trainRatio: 0.5, validationRatio: 0.25, holdoutRatio: 0.25, seed: 'test' });

  assert.deepEqual(first.taskAssignments, second.taskAssignments);
  for (const partition of ['train', 'validation', 'holdout']) {
    for (const item of first[partition]) {
      assert.equal(first.taskAssignments[item.taskId], partition);
    }
  }
  assert.equal(first.train.length + first.validation.length + first.holdout.length, nodes.length);
});

test('monotonic gate rejects quality regression and accepts a better candidate', () => {
  const current = [
    { caseId: 'case-1', quality: 0.8, score: 0.7 },
    { caseId: 'case-2', quality: 0.9, score: 0.8 }
  ];
  const rejected = evaluateMonotonicGate(current, [
    { caseId: 'case-1', quality: 0.7, score: 1.2 },
    { caseId: 'case-2', quality: 0.9, score: 0.8 }
  ], { minimumPassRatio: 1, minimumImprovement: 0 });
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.failedCaseIds, ['case-1']);

  const accepted = evaluateMonotonicGate(current, [
    { caseId: 'case-1', quality: 0.85, score: 0.9 },
    { caseId: 'case-2', quality: 0.9, score: 0.8 }
  ], { minimumPassRatio: 1, minimumImprovement: 0.05 });
  assert.equal(accepted.passed, true);
  assert.equal(accepted.passRatio, 1);
});

test('monotonic gate rejects incomplete candidate case sets', () => {
  const result = evaluateMonotonicGate(
    [{ caseId: 'case-1', quality: 0.8, score: 0.7 }],
    [],
    { minimumPassRatio: 0, minimumImprovement: -1 }
  );

  assert.equal(result.passed, false);
  assert.match(result.reasons.join(' '), /case sets do not match/);
});