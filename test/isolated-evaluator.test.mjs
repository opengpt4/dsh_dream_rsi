import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReplayIsolated } from '../dist/evolution/isolated-evaluator.js';

test('isolated evaluator returns the same deterministic result as the core evaluator', async () => {
  const result = await evaluateReplayIsolated({
    visitedNodes: [],
    boundaryMissCount: 0,
    totalAttempts: 0,
    criticalPathMs: 1
  });

  assert.deepEqual(result, {
    quality: 0,
    cost: 0,
    parallelEfficiency: 0,
    missRate: 0,
    score: 0
  });
});

test('isolated evaluator rejects invalid timeout configuration', async () => {
  await assert.rejects(
    evaluateReplayIsolated({ visitedNodes: [], boundaryMissCount: 0, totalAttempts: 0, criticalPathMs: 1 }, undefined, { timeoutMs: 0 }),
    /timeoutMs must be positive/
  );
});